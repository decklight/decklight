// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The deck's voice, and everything that hangs off it: the two narration
// sources (recorded files, live synthesis through the local bridge), the
// sentence pipeline and its lookahead buffer, pause and speed, the captions
// that are the same words in text, the lip-synced character, the N picker
// (tracks → voices → tones → character) with its audition clips, and the
// ⇧V pass that records the whole deck offline.
//
// It is one subject even though it is several dialogs: every one of them
// reads or writes the same playback state, and the caption bar is literally
// the sentence the voice is speaking. Splitting them further would mean
// exporting that state, which is how it came to be tangled through
// engine.js in the first place.

import { createCharacter, concatTimelines } from './character.js';
import { closeOnBackdrop, selectInList } from './overlay.js';
import {
  manifestSlideUrl, expiryState, timeLeft, stampOf, resignCommand, trackKey,
} from './voicetrack.js';

/**
 * Should the "this deck has a voice-over" pill show on this load?
 *
 * Pure, and exported, because it is a six-way "never here" rule and every one
 * of those cases is a place the pill would be wrong rather than merely
 * unnecessary: it must not print, must not appear in the theme picker's and
 * slide finder's embedded previews, must not tell you to press V under
 * `?voiceover` (which starts on the first gesture anyway), must not land on
 * top of the captions bar — same corner — and must never nag a viewer who has
 * already used the voice on this deck. Testing that as a function beats
 * booting six headless decks to watch nothing happen five times.
 */
export function hintApplies({
  hasTracks, used, printMode, embedded, voiceover, captionsOn, narrating,
} = {}) {
  return !!hasTracks && !used && !printMode && !embedded && !voiceover
    && !captionsOn && !narrating;
}

/**
 * Wire narration to a deck.
 *
 * `ctx` carries the engine's furniture (`root`, `stage`, `config`, `params`,
 * `printMode`, `toast`, `logOnly`, `debugLog`, `overlays`, `instance`) plus two
 * callbacks into chrome the engine owns and narration invalidates:
 * `syncSoundBtn` (the mute button in the controls) and `updateDebugState` (the
 * D panel's status line). `downloadFromUrl` is the engine's download helper,
 * shared with the transcript.
 */
export function createNarration({
  root, stage, config, params, printMode, toast, logOnly, debugLog, overlays, instance,
  syncSoundBtn, updateDebugState, downloadFromUrl,
}) {
  // estimated $ across live-bridge calls (the x-tts-cost response header);
  // the D panel reads it back through status()
  let ttsSpend = 0;
  // ── narration (V) + picker (N) — SPEC PRESENTING ────────────────────────────────
  // Two sources, one V toggle. RECORDED: pre-rendered per-slide audio
  // (tools/voiceover.mjs, or ⇧V below; config.narration.files = '<dir>' or
  // [{ label, dir, ext }, …] — ext defaults to 'm4a', ⇧V recordings are
  // 'wav'). LIVE: synthesized on the fly per slide through the local bridge
  // (`decklight tts`) — pick a Gemini voice and a delivery tone in the
  // picker; responses are cached per (slide, voice, style) and the next
  // slide is prefetched while the current one plays. N opens the picker
  // (tracks → voices → tones → custom-tone input); choice persists per deck.
  // ⇧V, live voice only: downloads every slide's narration as slide-NN.wav
  // STITCHED FROM THE SENTENCE CACHE (already-heard clips are free; only
  // unheard sentences synthesize), so the deck can later run RECORDED with
  // that set instead of depending on the bridge.
  const narrKey = 'decklight-narration:' + location.pathname;
  const LIVE_URL = config.narration?.liveUrl ?? 'http://127.0.0.1:8787/tts';
  // keep in sync with tools/gemini-tts.mjs GEMINI_VOICES
  const GEMINI_VOICES = [
    ['Zephyr', 'bright'], ['Puck', 'upbeat'], ['Charon', 'informative'],
    ['Kore', 'firm'], ['Fenrir', 'excitable'], ['Leda', 'youthful'],
    ['Orus', 'firm'], ['Aoede', 'breezy'], ['Callirrhoe', 'easy-going'],
    ['Autonoe', 'bright'], ['Enceladus', 'breathy'], ['Iapetus', 'clear'],
    ['Umbriel', 'easy-going'], ['Algieba', 'smooth'], ['Despina', 'smooth'],
    ['Erinome', 'clear'], ['Algenib', 'gravelly'], ['Rasalgethi', 'informative'],
    ['Laomedeia', 'upbeat'], ['Achernar', 'soft'], ['Alnilam', 'firm'],
    ['Schedar', 'even'], ['Gacrux', 'mature'], ['Pulcherrima', 'forward'],
    ['Achird', 'friendly'], ['Zubenelgenubi', 'casual'], ['Vindemiatrix', 'gentle'],
    ['Sadachbia', 'lively'], ['Sadaltager', 'knowledgeable'], ['Sulafat', 'warm'],
  ];
  // What the bridge can ACTUALLY speak. We ship the Gemini roster because it is
  // also Chirp's, but the bridge may be running piper — one local model, not
  // thirty star names — and a picker offering 29 voices that silently do nothing
  // is a lie. /ping tells us; until it answers, the built-in roster stands.
  const PING_URL = LIVE_URL.replace(/\/tts\/?$/, '/ping');
  let liveVoices = GEMINI_VOICES;
  let liveStylable = true;  // only gemini takes a delivery instruction
  let liveEngine = null;
  let livePing = null;
  function probeLive() {
    livePing ??= fetch(PING_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (!p) return null;
        liveEngine = p.engine ?? null;
        if (Array.isArray(p.voices) && p.voices.length) liveVoices = p.voices;
        liveStylable = p.stylable !== false;
        debugLog('tts', `bridge: ${p.engine} · ${p.model} · ${liveVoices.length} voice(s)`
          + (liveStylable ? '' : ' · no style'));
        // A saved voice the LIVE bridge cannot speak is stale, not a choice: it
        // was picked for a different engine (the Gemini roster is the default,
        // and an ElevenLabs key knows none of those names). Sending it anyway
        // makes the first V a failure for a setting nobody remembers making, so
        // the roster wins and the first voice — for ElevenLabs, one of YOURS —
        // takes over. Said out loud, because a voice changing on its own is
        // exactly the kind of thing that should never be silent.
        if (liveVoices.length && !liveVoices.some(([n]) => n === liveCfg.voice)) {
          const was = liveCfg.voice;
          liveCfg = { ...liveCfg, voice: liveVoices[0][0] };
          persistNarr();
          debugLog('tts', `voice ${was} is not on this bridge — using ${liveCfg.voice}`);
          if (narrSet?.live) toast(`voice ${was} → ${liveCfg.voice} (this bridge speaks its own roster)`, 2600);
        }
        return p;
      })
      .catch(() => null); // no bridge — the picker still works, V just warns
    return livePing;
  }
  const TONES = [
    // single directive clauses: instruction-shaped text steers; persona
    // sentences ("You're a…") can stochastically be read aloud
    ['Warm senior engineer', 'Read in a warm, welcoming tone, like a friendly battle-hardened senior engineer who is still curious about new technology.'],
    ['Professional', 'Read in a clear, professional tone — measured, confident, and articulate.'],
    ['Too serious', 'Read in an extremely grave, deadly serious tone, as if announcing news of the utmost importance.'],
    ['Joyful', 'Read in a joyful, light-hearted tone, smiling through every sentence.'],
    ['Super excited', 'Read in a super-excited, high-energy tone, barely containing your enthusiasm.'],
    ['Sad', 'Read in a somber, melancholic tone, on the verge of a sigh.'],
  ];
  const narrSets = (() => {
    const f = config.narration?.files;
    if (!f) return [];
    return Array.isArray(f) ? f : [{ label: 'Narration', dir: f }];
  })();
  const LIVE_TRACK = { live: true };
  let liveCfg = { voice: 'Alnilam', tone: TONES[0][0], style: TONES[0][1] };
  let narrSet = narrSets[0] ?? null;
  try {
    const saved = JSON.parse(localStorage.getItem(narrKey));
    if (saved?.live?.voice) { liveCfg = saved.live; narrSet = LIVE_TRACK; }
    else {
      // `track` is the key a manifest track can also be named by; `dir` is what
      // every deck saved before manifests existed and still reads back
      const want = saved?.track ?? saved?.dir;
      const hit = narrSets.find((t) => trackKey(t) === want);
      if (hit) narrSet = hit;
    }
  } catch { /* ignore */ }
  let narrating = false, narrAudio = null;
  // voice speed — YouTube's ⇧< / ⇧> in 0.25× steps, clamped 0.25–2×,
  // persisted per deck; applies to live and recorded narration alike
  const narrRateKey = 'decklight-narr-rate:' + location.pathname;
  let narrRate = 1;
  try {
    const v = parseFloat(localStorage.getItem(narrRateKey) ?? '');
    if (v >= 0.25 && v <= 2) narrRate = v;
  } catch { /* ignore */ }
  function changeNarrRate(delta) {
    narrRate = Math.round(Math.min(2, Math.max(0.25, narrRate + delta)) * 100) / 100;
    try { localStorage.setItem(narrRateKey, String(narrRate)); } catch { /* ignore */ }
    if (narrAudio) narrAudio.playbackRate = narrRate;
    toast(`voice speed ${narrRate}×`);
    debugLog('narr', `rate ${narrRate}×`);
    updateDebugState();
  }
  // Animated lip-synced character (SPEC PRESENTING): an overlay whose mouth follows
  // the narration. Live mode rides the sentence pipeline below (prefetch in
  // the lookahead worker, beginSentence per clip); recorded mode loads
  // slide-NN sidecar files. Configured in the N picker ("Character…").
  const character = createCharacter({ root, config, debugLog, toast });
  // slide|voice|style → PROMISE of a blob URL. Caching the promise (not the
  // resolved URL) dedups concurrent misses: the prefetch and a play (or a
  // ⇧V recording pass) for the same slide share one POST instead of racing
  // two and leaking the loser's blob URL. Failures evict themselves so a
  // bridge hiccup isn't cached forever.
  const liveCache = new Map();
  function notesText(sl) {
    const t = instance._sections?.[sl - 1]?.querySelector('aside.notes')?.textContent ?? '';
    return t.replace(/⟨CLICK⟩/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Build-synced narration: the ⟨CLICK⟩ markers that already segment the
  // notes for the speaker view segment the AUDIO too — segment k narrates
  // build step k (0 = arrival, before any build), exactly like a presenter
  // reading the notes and clicking between segments.
  function notesSegs(sl) {
    const t = instance._sections?.[sl - 1]?.querySelector('aside.notes')?.textContent ?? '';
    return t.split('⟨CLICK⟩').map((s) => s.replace(/\s+/g, ' ').trim());
  }
  // resolves { url, blob }: playback needs the object URL, the ⇧V stitcher
  // needs the raw bytes — one cache serves both
  function synthLive(text, key, label) {
    if (!text) return Promise.resolve(null);
    if (!liveCache.has(key)) {
      const p = (async () => {
        const t0 = Date.now();
        try {
          const res = await fetch(LIVE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text, voice: liveCfg.voice, style: liveCfg.style }),
          });
          if (!res.ok) throw new Error(String(res.status));
          const blob = await res.blob();
          const cost = parseFloat(res.headers?.get?.('x-tts-cost') ?? '') || 0;
          if (cost) ttsSpend += cost;
          debugLog('tts', `${label} · ${liveCfg.voice} · ${text.length} chars → ${((Date.now() - t0) / 1000).toFixed(1)}s`
            + (cost ? ` · ~$${cost.toFixed(4)}` : ''));
          return { url: URL.createObjectURL(blob), blob };
        } catch (e) {
          debugLog('tts', `${label} · ${liveCfg.voice} FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s (${String(e.message || e)})`);
          throw e;
        }
      })();
      p.catch(() => { if (liveCache.get(key) === p) liveCache.delete(key); });
      liveCache.set(key, p);
    }
    return liveCache.get(key);
  }
  // The live player's unit is a SENTENCE: each ⟨CLICK⟩ segment splits into
  // sentences and every sentence is its own TTS call and cache entry — so
  // the first audio of a beat arrives after one short synthesis, not after
  // the whole paragraph renders.
  function splitSentences(text) {
    return ((text ?? '').match(/[^.!?…]+[.!?…]+[”’"')\]]*|[^.!?…]+$/g) ?? [])
      .map((s) => s.trim()).filter(Boolean);
  }
  const sentenceKey = (sl, step, i) => `${sl}|s${step}|n${i}|${liveCfg.voice}|${liveCfg.style}`;
  function fetchLiveSentence(sl, step, i) {
    const sentence = splitSentences(notesSegs(sl)[step])[i] ?? '';
    return synthLive(sentence, sentenceKey(sl, step, i), `slide ${sl} seg ${step} #${i + 1}`);
  }
  // data-narration="hold": an interactive slide (quiz, exercise, live
  // demo) — narration plays whatever notes it has and builds still sync,
  // but the deck NEVER auto-advances off it; the presenter moves on
  // manually and narration resumes on the next slide.
  const narrationHolds = (sl) => instance._sections[sl - 1]?.dataset.narration === 'hold';
  // ── lookahead buffer ──────────────────────────────────────────────────
  // While live narration is ON, keep the next LIVE_LOOKAHEAD segments
  // synthesized in the background. Low priority by construction: ONE
  // buffer request in flight at a time (plus a small yield between calls),
  // so a foreground play never waits behind a burst — and since buffer and
  // playback share the promise cache, reaching a segment mid-synthesis
  // just awaits the same promise. The loop re-derives its window from the
  // CURRENT position each iteration, so navigation, voice/tone changes
  // (new cache keys) and toggling V off all just work; results land in the
  // (voice, tone) cache and the loop moves on to the next hole.
  const LIVE_LOOKAHEAD = 10; // sentences ahead of the playhead
  const BUFFER_WORKERS = 3;  // parallel low-priority synths
  let bufferGen = 0;
  // the next `count` sentences from the current position, inclusive of the
  // current segment (its unspoken sentences matter), across slide boundaries
  function upcomingSentences(count) {
    const out = [];
    let sl = instance.state.slide;
    let step = instance.state.step;
    while (out.length < count && sl <= instance.state.totalSlides) {
      const segs = notesSegs(sl);
      const max = instance._records[sl - 1] ? instance._records[sl - 1].groups.length : 0;
      for (; step <= max && out.length < count; step++) {
        const n = splitSentences(segs[step]).length;
        for (let i = 0; i < n && out.length < count; i++) out.push([sl, step, i]);
      }
      sl += 1;
      step = 0;
    }
    return out;
  }
  async function fillLiveBuffer() {
    const gen = ++bufferGen; // newest fill wins; stale workers exit
    const worker = async () => {
      while (gen === bufferGen && narrating && narrSet?.live) {
        // find+start is synchronous within a worker's turn, and synthLive
        // registers the promise before awaiting — workers never double-fetch
        const hole = upcomingSentences(LIVE_LOOKAHEAD)
          .find(([sl, step, i]) => !liveCache.has(sentenceKey(sl, step, i)));
        if (!hole) return; // window full — the next slide/build event re-arms
        try {
          await fetchLiveSentence(hole[0], hole[1], hole[2]);
          // the character's lip-sync data prefetches through the SAME
          // window: hand the sentence's audio promise to the controller so
          // visemes/video for the next 10 sentences warm alongside the voice
          if (character.mode !== 'off') {
            const [sl, step, i] = hole;
            character.prefetchSentence(sentenceKey(sl, step, i),
              liveCache.get(sentenceKey(sl, step, i)),
              splitSentences(notesSegs(sl)[step])[i] ?? '');
          }
        } catch {
          return; // bridge unreachable — stop; the next event retries
        }
        await new Promise((r) => setTimeout(r, 30)); // yield to foreground
      }
    };
    await Promise.all(Array.from({ length: BUFFER_WORKERS }, worker));
  }

  // When a segment finishes, reveal the next build; after the last step,
  // move to the next slide. Guarded on (slide, step) so any manual
  // navigation mid-clip silently wins over the pending advance.
  let liveSegGen = 0; // cancels pending silent-beat timers and stale onended
  let narrPaused = false;     // P — freezes audio, captions and auto-advance
  let liveChainActive = false; // a sentence chain is running for liveChainGen
  let liveChainGen = 0;
  function toggleNarrPause() {
    if (!narrating) { toast('narration is off — V starts it'); return; }
    narrPaused = !narrPaused;
    if (narrPaused) {
      narrAudio?.pause();
    } else if (narrAudio?.src && narrAudio.paused && !narrAudio.ended && narrAudio.currentTime > 0) {
      narrAudio.play().catch(() => { /* autoplay policy */ }); // resume mid-sentence
    } else if (!liveChainActive) {
      playLive(); // nothing parked (e.g. paused on a silent beat) — re-arm
    } // else: the parked chain's pause-gate resumes on its own
    toast(narrPaused ? '⏸ narration paused — P resumes' : '▶ narration resumed');
    debugLog('narr', narrPaused ? 'paused' : 'resumed');
    updateDebugState();
  }
  function advanceFrom(sl, step) {
    if (!narrating || narrPaused || !narrSet?.live) return;
    if (instance.state.slide !== sl || instance.state.step !== step) return;
    const rec = instance._records[sl - 1];
    if (step < (rec ? rec.groups.length : 0)) instance.next();
    else if (!narrationHolds(sl) && sl < instance.state.totalSlides) instance.goto(sl + 1, 0);
  }
  async function playLive() {
    const sl = instance.state.slide, step = instance.state.step;
    const gen = ++liveSegGen;
    fillLiveBuffer(); // (re-)arm the lookahead from the new position
    if (!notesText(sl)) {
      if (narrationHolds(sl)) { debugLog('narr', `hold on slide ${sl} — manual advance`); return; }
      // nothing to say on this slide at all — skip it after a short beat
      setTimeout(() => {
        if (gen !== liveSegGen || !narrating || !narrSet?.live) return;
        if (instance.state.slide === sl && sl < instance.state.totalSlides) instance.goto(sl + 1, 0);
      }, 400);
      return;
    }
    const segs = notesSegs(sl);
    if (!segs[step]) {
      // a build beat with no words — reveal the next step after a pause
      setTimeout(() => { if (gen === liveSegGen) advanceFrom(sl, step); }, 600);
      return;
    }
    // speak the segment SENTENCE BY SENTENCE: each sentence is one cached
    // clip (short time-to-first-audio), the caption follows the spoken
    // sentence, and the build advances only after the segment's last one
    const sentences = splitSentences(segs[step]);
    const stale = () => gen !== liveSegGen || !narrating || instance.state.slide !== sl || instance.state.step !== step;
    liveChainGen = gen;
    liveChainActive = true;
    let spoke = 0;
    try {
      for (let i = 0; i < sentences.length; i++) {
        while (narrPaused) { // P holds the chain between sentences too
          if (stale()) return;
          await new Promise((r) => setTimeout(r, 150));
        }
        if (stale()) return;
        let clip;
        try {
          clip = await fetchLiveSentence(sl, step, i);
        } catch (err) {
          // The VOICE IS THE CLOCK. If it cannot speak, the deck must not keep
          // moving: auto-advancing in silence would walk the talk past slides
          // nobody has heard, and the presenter — watching the slides, not the
          // console — would have no idea why. Stop, and say what happened.
          debugLog('narr', `sentence failed (slide ${sl} seg ${step} #${i + 1}) — narration stopped`);
          stopNarration(liveFailure(err));
          return;
        }
        if (stale()) return;
        if (!clip) continue;
        setCaption(sentences[i]); // captions follow the voice, not the notes
        narrAudio ??= new Audio();
        // character is strictly opt-in: with mode 'off' narration runs with
        // zero lip-sync footprint. When on, begin* is fire-and-forget —
        // audio never waits on lip-sync; a late timeline lands mid-sentence
        // and the fallback animates until it does.
        if (character.mode !== 'off') {
          character.attachAudio(narrAudio);
          character.beginSentence(sentenceKey(sl, step, i), clip, sentences[i]);
        }
        narrAudio.src = clip.url;
        narrAudio.playbackRate = narrRate;
        let blocked = false;
        await new Promise((done) => {
          narrAudio.onended = done;
          narrAudio.play().catch(() => { blocked = true; done(); });
        });
        if (blocked) {
          // the browser refused to play unprompted — the audio exists, so this
          // is one click away, and the deck waits rather than running on mute
          stopNarration('🔇 the browser blocked audio — click the deck once, then V — the slides wait for the voice');
          return;
        }
        spoke++;
      }
      if (stale()) return;
      // Nothing spoken, but words to speak: the audio never played, so the deck
      // must not move on. (A segment with no words at all is a legitimate silent
      // beat and still advances.)
      if (!spoke && sentences.length) {
        stopNarration('🔇 the voice did not play — auto-advance stopped · press the key left of 1 for messages');
        return;
      }
      advanceFrom(sl, step);
    } finally {
      if (liveChainGen === gen) liveChainActive = false;
    }
  }
  // What went wrong, in the presenter's words — and what to do about it. The
  // bridge throws the HTTP status; a dead bridge throws a TypeError from fetch.
  function liveFailure(err) {
    const s = String(err?.message ?? err);
    if (s.startsWith('429')) {
      return '🔇 voice quota exceeded (429) — auto-advance stopped · a free engine: decklight author --tts-engine chirp';
    }
    if (/^\d{3}/.test(s)) {
      return `🔇 voice bridge error ${s.slice(0, 3)} — auto-advance stopped · press the key left of 1 for messages`;
    }
    return '🔇 voice bridge unreachable — auto-advance stopped · start it with: decklight tts';
  }
  // ── manifest tracks — SPEC PRESENTING ────────────────────────────────────────────
  // A track can NAME its files instead of living in a directory. That is the
  // whole of what presigned hosting needs: the signature rides in each file's
  // query string, which a `dir` prefix has nowhere to put. See voicetrack.js.
  const manifests = new Map();           // url -> promise of the parsed manifest
  const resolvedManifests = new Map();   // url -> data, for callers that cannot await
  const badManifests = new Set();        // asked once, failed; not re-asked on every re-render
  let loaded = null;                     // { track, data } for the selected manifest track

  /** A manifest `decklight bundle` inlined, because fetch is dead on file://. */
  function bundledManifest(url) {
    for (const el of document.querySelectorAll('script[type="application/json"][data-decklight-voices]')) {
      if (el.getAttribute('data-decklight-voices') !== url) continue;
      try { return JSON.parse(el.textContent); } catch { return null; }
    }
    return null;
  }
  function loadManifest(url) {
    if (!manifests.has(url)) {
      const inline = bundledManifest(url);
      manifests.set(url, inline ? Promise.resolve(inline)
        : fetch(url)
          .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
          // a bucket hiccup must not be cached forever — evict, so V retries
          .catch((e) => { manifests.delete(url); throw e; }));
      manifests.get(url).then((d) => resolvedManifests.set(url, d)).catch(() => { /* reported at use */ });
    }
    return manifests.get(url);
  }
  /**
   * The ☁ row's small print: where the audio lives, and for how long.
   *
   * The picker is the natural place to learn a track has days left rather than
   * hours — so opening it fetches what it needs and re-renders when the answer
   * lands, the same shape as the character view probing its bridge.
   */
  function manifestFlavor(t) {
    const data = resolvedManifests.get(t.manifest);
    if (!data) {
      if (badManifests.has(t.manifest)) return 'hosted — the voice list did not load';
      loadManifest(t.manifest)
        .catch(() => badManifests.add(t.manifest))
        .then(() => { if (narrEl && narrView === 'tracks') renderNarr('tracks'); });
      return 'hosted — checking…';
    }
    const exp = expiryState(data);
    if (!exp.at) return 'hosted · no expiry';
    return exp.expired
      ? `EXPIRED ${stampOf(exp.at)} — re-sign to play`
      : `signed · ${timeLeft(exp.msLeft)}`;
  }
  /**
   * Fetch the selected track's manifest and check its signatures BEFORE the
   * first clip, the same posture as probing the live bridge: finding out from
   * a failed slide is finding out too late. Returns false having already said
   * why, so the caller just stops.
   */
  async function ensureTrack() {
    if (!narrSet || narrSet.live || !narrSet.manifest) { loaded = null; return true; }
    if (loaded?.track !== narrSet) {
      try {
        loaded = { track: narrSet, data: await loadManifest(narrSet.manifest) };
      } catch (e) {
        loaded = null;
        stopNarration(`🔇 could not load the voice list for “${narrSet.label}”`
          + ` (${narrSet.manifest} — ${e.message}) — auto-advance stopped`);
        return false;
      }
    }
    const exp = expiryState(loaded.data);
    if (exp.expired) {
      stopNarration(`🔇 the signed voices for “${narrSet.label}” expired ${stampOf(exp.at)}`
        + ` — auto-advance stopped · re-sign: ${resignCommand(loaded.data)}`);
      return false;
    }
    return true;
  }
  /** Where slide n plays from, for either kind of track — null for silence. */
  function slideFileUrl(n) {
    if (narrSet.manifest) return manifestSlideUrl(loaded?.data, narrSet.manifest, n);
    // state.slide and the files are BOTH 1-based (slide-01 = first section).
    // ext defaults to the pre-render tool's .m4a; ⇧V-recorded sets are .wav.
    return `${narrSet.dir}/slide-${String(n).padStart(2, '0')}.${narrSet.ext ?? 'm4a'}`;
  }
  function playSlideFile() {
    if (!narrSet) return;
    if (narrSet.live) return playLive();
    // A slide with nothing to say has no file, and that is NOT a failure: the
    // pre-render tool only emits audio for slides that have notes (the showcase
    // is 30 slides and 20 clips). Warning here would fire ten times on a deck
    // that is behaving perfectly — so only a slide that SHOULD speak can complain.
    if (!notesText(instance.state.slide)) { narrAudio?.pause(); return; }
    const file = slideFileUrl(instance.state.slide);
    // a manifest is the authority on what exists: no entry, nothing to play
    if (!file) { narrAudio?.pause(); return; }
    narrAudio ??= new Audio();
    narrAudio.src = file;
    narrAudio.playbackRate = narrRate;
    if (character.mode !== 'off') {
      character.attachAudio(narrAudio);
      character.beginSlide(narrSet, instance.state.slide);
    }
    // a track with no file for this slide used to fail in total silence — with
    // nothing on screen, an unnarrated slide is indistinguishable from a broken one
    narrAudio.onerror = () => {
      debugLog('narr', `no audio: ${file}`);
      const exp = narrSet.manifest ? expiryState(loaded?.data) : null;
      if (exp?.at) {
        // A SIGNED file that will not load is the clock running out — a 403 for
        // a lapsed or revoked signature. A media element never reports the
        // status, so the deck cannot prove it; what it CAN do is stop (the
        // voice is the clock) and name the one command that fixes the only
        // cause worth naming.
        debugLog('narr', 'signed url failed — a media element cannot report the status');
        stopNarration(`🔇 slide ${instance.state.slide} of “${narrSet.label}” would not load`
          + ` (signed until ${stampOf(exp.at)}) — auto-advance stopped`
          + ` · re-sign: ${resignCommand(loaded?.data)}`);
        return;
      }
      toast(`🔇 no narration for slide ${instance.state.slide} (${file}) · press the key left of 1 for messages`);
    };
    narrAudio.play().catch(() => {
      toast('🔇 the browser blocked audio — click the deck once, then V');
    });
  }
  // the one teardown: V, and the bridge giving up, must leave the same state
  function stopNarration(msg = 'narration off') {
    narrating = false;
    liveSegGen++; // cancel any pending silent-beat advance
    bufferGen++;  // stop the lookahead loop
    narrPaused = false;
    narrAudio?.pause();
    character.stop();
    toast(msg);
    debugLog('narr', msg);
    syncSoundBtn();
  }
  async function toggleNarration() {
    if (!narrSet) { openNarrPicker(narrSets.length ? 'tracks' : 'voices'); return; }
    if (narrating) return stopNarration();
    // However the voice was started — V, the touch sound button, the pill, the
    // ?voiceover gesture — this viewer now knows the deck talks. The hint has
    // done its job here, for good.
    narrationUsedHere();
    // Ask the bridge who it is BEFORE speaking, not just when the picker opens:
    // the saved voice may belong to another engine entirely, and finding that
    // out from a failed sentence is finding out too late. One request, ever —
    // probeLive caches the promise — and a bridge that does not answer just
    // leaves the built-in roster in place, exactly as before.
    if (narrSet.live) await probeLive();
    // and the recorded equivalent: a manifest track's file list and its
    // signatures are settled before the first clip, not discovered by it
    if (!await ensureTrack()) return;
    narrating = true;
    const what = narrSet.live ? `⚡ ${liveCfg.voice} · ${liveCfg.tone}` : narrSet.label;
    toast(`🔊 ${what} — V stops · N picks`);
    debugLog('narr', `on — ${what}`);
    playSlideFile();
    syncSoundBtn();
  }
  instance.on('slide', () => { if (narrating) playSlideFile(); });
  // builds re-sync the live voice too — whether the advance came from the
  // narration itself or from the presenter pressing → mid-sentence
  instance.on('build', () => { if (narrating && narrSet?.live) playLive(); });

  // ── closed captions (C) — SPEC PRESENTING ────────────────────────────────────────
  // YouTube-style captions: the CURRENT notes segment (the same text the
  // live voice speaks) in a bar at the bottom, synced to slide/step. Works
  // with narration on or off — it's the deck's transcript. Persists per deck.
  const captionsKey = 'decklight-captions:' + location.pathname;
  let captionsOn = false;
  try { captionsOn = localStorage.getItem(captionsKey) === '1'; } catch { /* ignore */ }
  let captionEl = null;
  function setCaption(text) {
    if (!captionEl) return;
    captionEl.textContent = text;
    captionEl.classList.toggle('show', !!text);
  }
  function updateCaption() {
    if (!captionEl) return;
    // while the live voice speaks, the sentence chain owns the caption —
    // never flash the whole segment; the next spoken sentence fills it
    if (narrating && narrSet?.live) { setCaption(''); return; }
    setCaption(notesSegs(instance.state.slide)[instance.state.step] ?? '');
  }
  function showCaptions() {
    captionEl = document.createElement('div');
    captionEl.className = 'decklight-captions';
    captionEl.setAttribute('aria-live', 'polite');
    root.appendChild(captionEl);
    updateCaption();
  }
  function toggleCaptions() {
    captionsOn = !captionsOn;
    try { localStorage.setItem(captionsKey, captionsOn ? '1' : '0'); } catch { /* ignore */ }
    if (captionsOn) { showCaptions(); dismissHint(); }  // same corner — one of them goes
    else { captionEl?.remove(); captionEl = null; }
    toast(`captions ${captionsOn ? 'on' : 'off'}`);
    debugLog('narr', `captions ${captionsOn ? 'on' : 'off'}`);
  }
  instance.on('slide', updateCaption);
  instance.on('build', updateCaption);
  if (captionsOn && !printMode) showCaptions();

  // ── the voice-over hint — SPEC PRESENTING ────────────────────────────────────────
  // A deck with a recorded track tells you so, once. Until now the only
  // proactive surface was the touch sound button, which CSS shows on
  // `pointer: coarse` alone — so a viewer on a laptop could only discover the
  // voice by pressing a key nobody had mentioned, or by the author writing the
  // hint into a slide by hand (demo/intro.html does exactly that). The pill
  // fades in bottom-center, fades out on its own, and never comes back once
  // the voice has been used here — per deck path, the same shape as every
  // other narration preference.
  const HINT_TEXT = '🔊 this deck has a voice-over — V plays it';
  const HINT_AFTER = 900;    // let the slide land first; the pill is an aside
  const HINT_FOR = 12000;    // read it twice over, then it leaves
  const narrUsedKey = 'decklight-narr-used:' + location.pathname;
  let narrUsed = false;
  try { narrUsed = localStorage.getItem(narrUsedKey) === '1'; } catch { /* ignore */ }
  let hintEl = null;
  function dismissHint() {
    if (!hintEl) return;
    const el = hintEl;
    hintEl = null;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 260);   // after the fade
  }
  /** The voice has been heard on this deck: retire the hint, now and later. */
  function narrationUsedHere() {
    dismissHint();
    if (narrUsed) return;
    narrUsed = true;
    try { localStorage.setItem(narrUsedKey, '1'); } catch { /* ignore */ }
  }
  function showHint() {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'decklight-narr-hint';
    // the text carries a bare "V"; the accessible name spells out what it does
    el.setAttribute('aria-label', 'Play this deck’s voice-over');
    const kbd = document.createElement('kbd');
    kbd.textContent = 'V';
    el.append('🔊 this deck has a voice-over — ', kbd, ' plays it');
    // clicking is itself the user gesture, so the audio that follows is not
    // subject to the autoplay policy the ?voiceover arm exists to satisfy
    el.addEventListener('click', () => { dismissHint(); toggleNarration(); });
    hintEl = el;
    root.appendChild(el);
    // Reading a layout property flushes the pending style with opacity:0, which
    // is what gives the transition something to start FROM. The toasts nearby
    // do this with requestAnimationFrame, but a frame is not owed to us — in a
    // background tab, or a headless render, rAF may never run and the pill
    // would sit at opacity 0 forever: mounted, correct, and invisible.
    void el.offsetWidth;
    el.classList.add('show');
    // no toast: the pill is already on screen saying this. The log keeps it so
    // a viewer who looked away can still find out (I).
    logOnly?.(HINT_TEXT);
    debugLog('narr', 'voice-over hint shown');
    setTimeout(dismissHint, HINT_FOR);
  }
  if (hintApplies({
    hasTracks: narrSets.length > 0,
    used: narrUsed,
    printMode,
    embedded: !!params?.has('embedded'),
    voiceover: !!params?.has('voiceover'),
    captionsOn,
  })) {
    // the deck may have started speaking on its own in the meantime
    setTimeout(() => { if (!narrating) showHint(); }, HINT_AFTER);
  }

  // N: narration picker — tracks → live voices → tones → custom tone
  let narrEl = null, narrSel = 0, narrView = 'tracks', narrRows = [], liveDraft = null;
  function persistNarr() {
    try {
      localStorage.setItem(narrKey, JSON.stringify(narrSet?.live
        ? { live: liveCfg }
        // dir stays in the payload so a deck rolled back to an older runtime
        // still finds its track; `track` is the one that also names a manifest
        : { track: trackKey(narrSet), dir: narrSet?.dir }));
    } catch { /* ignore */ }
  }
  function applyLive(toneLabel, styleText) {
    liveCfg = { voice: liveDraft ?? liveCfg.voice, tone: toneLabel, style: styleText };
    narrSet = LIVE_TRACK;
    persistNarr();
    closeNarrPicker();
    if (!narrating) narrating = true;
    toast(`⚡ live voice: ${liveCfg.voice} · ${liveCfg.tone} — V stops`);
    debugLog('narr', `live config — ${liveCfg.voice} · ${liveCfg.tone}`);
    playSlideFile();
  }
  function selectNarrRow(i) {
    if (!narrRows.length) return;
    narrSel = selectInList(narrEl.querySelectorAll('.narr-row'), i, 'narr-sel', { scroll: false });
  }
  function commitNarrRow() { narrRows[narrSel]?.commit(); }
  function narrBack() {
    if (narrView === 'custom') renderNarr('tones');
    else if (narrView === 'tones') renderNarr('voices');
    else if (narrView === 'charvideo') renderNarr('character');
    else if ((narrView === 'voices' || narrView === 'character') && narrSets.length) renderNarr('tracks');
    else closeNarrPicker();
  }
  let charProbed = false; // one bridge probe per picker open
  function applyCharacter(m, opts) {
    character.setMode(m, opts);
    closeNarrPicker();
    toast(m === 'off' ? 'character off'
      : m === 'viseme' ? `🎭 character on — lips follow the narration${narrating ? '' : ' · V starts it'}`
        : `🎥 character video — ${character.engine} · ${character.portrait}${narrating ? '' : ' · V starts narration'}`);
  }
  // solo: the narrator centre stage, the slide out of the way (SPEC PRESENTING)
  function applySolo(v) {
    if (character.mode === 'off') {
      toast('turn the character on first — N · Character…');
      return;
    }
    character.setSolo(v);
    closeNarrPicker();
    toast(v ? '🎭 solo — the narrator has the stage · N brings the slides back'
      : 'solo off — the slides are back');
  }
  // ▶ voice preview: speaks a short test sentence through the live bridge
  // in the row's voice (neutral tone), so voices can be auditioned before
  // committing. TWO caches (voice → promise of a blob URL): the DEFAULT
  // sentence's cache is permanent — once an entry resolves it is never
  // invalidated — while the custom cache holds exactly one sentence and is
  // swapped out (old blobs freed) when the user's text changes. After any
  // preview plays, the remaining 29 voices prefetch sequentially in the
  // background, so auditioning the roster becomes instant.
  const PREVIEW_DEFAULT = 'Hey, this is Decklight';
  let previewText = PREVIEW_DEFAULT;
  let previewAudio = null;
  const previewDefaultCache = new Map();
  let previewCustomCache = new Map();
  let previewCustomText = null;
  const previewPrefetching = new Set(); // texts with a prefetch loop running
  function previewCacheFor(text) {
    if (text === PREVIEW_DEFAULT) return previewDefaultCache;
    if (text !== previewCustomText) {
      // new custom sentence: retire the old bucket and free its audio
      for (const p of previewCustomCache.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
      previewCustomCache = new Map();
      previewCustomText = text;
    }
    return previewCustomCache;
  }
  const previewKey = (voice, style) => `${voice}|${style || ''}`;
  function ensurePreviewIn(cache, voice, text, style = '') {
    const key = previewKey(voice, style);
    if (!cache.has(key)) {
      const p = (async () => {
        const t0 = Date.now();
        const res = await fetch(LIVE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, voice, style }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const cost = parseFloat(res.headers?.get?.('x-tts-cost') ?? '') || 0;
        if (cost) ttsSpend += cost;
        debugLog('tts', `preview ${voice}${style ? ' (styled)' : ''} · ${((Date.now() - t0) / 1000).toFixed(1)}s`
          + (cost ? ` · ~$${cost.toFixed(4)}` : ''));
        return URL.createObjectURL(blob);
      })();
      // failures self-evict so a retry can succeed; resolved entries stay
      p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
      cache.set(key, p);
    }
    return cache.get(key);
  }
  async function prefetchPreviews(text, list, tag) {
    const runKey = `${tag}|${text}`;
    if (previewPrefetching.has(runKey)) return;
    previewPrefetching.add(runKey);
    const isDefault = text === PREVIEW_DEFAULT;
    const cache = isDefault ? previewDefaultCache : previewCustomCache;
    try {
      debugLog('narr', `preview prefetch ${tag} (${isDefault ? 'default' : 'custom'} sentence)`);
      // sequential on purpose: the bridge synthesizes serially and a burst
      // of parallel POSTs would just queue-jump the presenter's own clicks
      for (const { voice, style } of list) {
        if (!isDefault && previewCustomText !== text) return; // superseded
        if (cache.has(previewKey(voice, style))) continue;
        await ensurePreviewIn(cache, voice, text, style).catch(() => { /* background — no toast */ });
      }
      debugLog('narr', `preview prefetch ${tag} complete`);
    } finally {
      previewPrefetching.delete(runKey);
    }
  }
  // spec: { voice, style, prefetch } — voice rows preview neutral delivery
  // and warm the whole roster; tone rows preview the drafted voice in that
  // delivery style and warm the other tones for the same voice.
  function previewClip({ voice, style = '', prefetch }, btn) {
    const text = previewText.trim();
    if (!text) return;
    const cache = previewCacheFor(text);
    if (btn) btn.textContent = '…';
    ensurePreviewIn(cache, voice, text, style).then((url) => {
      if (btn?.isConnected) btn.textContent = '▶';
      previewAudio ??= new Audio();
      previewAudio.src = url;
      previewAudio.play().catch(() => { /* autoplay policy */ });
      debugLog('narr', `preview ${voice}${style ? ' · styled' : ''}`);
      if (prefetch === 'voices') {
        prefetchPreviews(text, GEMINI_VOICES.map(([n]) => ({ voice: n, style: '' })), 'voices');
      } else if (prefetch === 'tones') {
        prefetchPreviews(text, TONES.map(([, s]) => ({ voice, style: s })), `tones:${voice}`);
      }
    }).catch(() => {
      if (btn?.isConnected) btn.textContent = '▶';
      toast('live voice bridge unreachable — run: decklight tts');
      debugLog('narr', `preview ${voice} failed`);
    });
  }
  function renderNarr(view) {
    narrView = view;
    const card = narrEl.querySelector('.narr-card');
    card.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'narr-head';
    card.appendChild(head);
    narrRows = [];
    if (view === 'tracks') {
      head.textContent = 'narration';
      narrSets.forEach((t) => narrRows.push({
        text: t.manifest
          // ☁ says the audio is not in this deck's folder; the countdown says
          // how long that will keep being true. Both come from the manifest
          // only once it has been loaded — before that, the row is honest
          // about knowing only where to look.
          ? `☁ ${t.label} <span class="narr-flavor">${manifestFlavor(t)}</span>`
          : `🔊 ${t.label} (${t.dir}/)`,
        html: !!t.manifest,
        cur: t === narrSet,
        commit: () => {
          narrSet = t; persistNarr(); closeNarrPicker(); toast(`🔊 track: ${t.label}`);
          // switching tracks mid-narration: the new one may need its manifest
          if (narrating) ensureTrack().then((ok) => { if (ok) playSlideFile(); });
        },
      }));
      narrRows.push({
        text: '⚡ Live voice — synthesize on the fly…',
        cur: narrSet?.live,
        commit: () => renderNarr('voices'),
      });
      narrRows.push({
        text: '🧑 Character — animated narrator…',
        cur: character.mode !== 'off',
        commit: () => renderNarr('character'),
      });
    } else if (view === 'character') {
      head.textContent = 'character — an animated narrator lip-syncs the voice';
      // availability comes from the lipsync bridge; probe once per picker
      // open and re-render when the answer lands
      if (!charProbed) {
        charProbed = true;
        character.probe().then(() => { if (narrEl && narrView === 'character') renderNarr('character'); });
      }
      const bi = character.bridgeInfo;
      const vids = bi?.engines?.video ?? [];
      narrRows.push({ text: 'Off', cur: character.mode === 'off', commit: () => applyCharacter('off') });
      narrRows.push({
        text: `🎭 2D character — offline visemes${bi?.engines?.viseme ? '' : ' <span class="narr-flavor">bridge offline — amplitude fallback</span>'}`,
        html: true,
        cur: character.mode === 'viseme',
        commit: () => applyCharacter('viseme'),
      });
      narrRows.push({
        text: `🎥 Neural video — local GPU${vids.length ? '…' : ' <span class="narr-flavor">needs the bridge — run: decklight lipsync</span>'}`,
        html: true,
        cur: character.mode === 'video',
        commit: () => {
          if (vids.length) renderNarr('charvideo');
          else toast('video needs wav2lip/sadtalker on the bridge — run: decklight lipsync');
        },
      });
      // a toggle, not a mode: solo works with either look above
      if (character.mode !== 'off') {
        narrRows.push({
          text: `${character.solo ? '◉' : '○'} Solo — the narrator takes the stage <span class="narr-flavor">slide content steps aside</span>`,
          html: true,
          cur: character.solo,
          commit: () => applySolo(!character.solo),
        });
      }
    } else if (view === 'charvideo') {
      head.textContent = 'neural video — pick engine · portrait';
      const bi = character.bridgeInfo;
      for (const eng of bi?.engines?.video ?? []) {
        for (const p of (bi?.portraits?.length ? bi.portraits : ['default'])) {
          narrRows.push({
            text: `🎥 ${eng} · ${p}`,
            cur: character.mode === 'video' && character.engine === eng && character.portrait === p,
            commit: () => applyCharacter('video', { engine: eng, portrait: p }),
          });
        }
      }
    } else if (view === 'voices') {
      head.textContent = 'live voice — pick a voice · ▶ previews';
      const wrap = document.createElement('div');
      wrap.className = 'narr-preview-row';
      const test = document.createElement('input');
      test.className = 'narr-input narr-preview-text';
      test.value = previewText;
      test.placeholder = 'Preview sentence';
      test.setAttribute('aria-label', 'Preview sentence');
      test.addEventListener('input', () => { previewText = test.value; });
      // onKey ignores inputs; only Escape needs wiring (back out of the view)
      test.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { narrBack(); e.preventDefault(); }
        e.stopPropagation();
      });
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'narr-prev-btn narr-reset-btn';
      reset.textContent = '↺';
      reset.title = 'restore the default sentence';
      reset.setAttribute('aria-label', 'restore the default preview sentence');
      reset.addEventListener('click', (e) => {
        e.stopPropagation();
        previewText = PREVIEW_DEFAULT;
        test.value = PREVIEW_DEFAULT;
      });
      wrap.append(test, reset);
      card.appendChild(wrap);
      liveVoices.forEach(([name, flavor]) => narrRows.push({
        text: `${name} <span class="narr-flavor">${flavor}</span>`,
        html: true,
        preview: { voice: name, style: '', prefetch: 'voices' },
        cur: narrSet?.live && liveCfg.voice === name,
        // chirp and piper have no delivery-instruction channel, so there is no
        // tone to pick — committing the voice IS the whole choice
        commit: () => {
          liveDraft = name;
          if (liveStylable) return renderNarr('tones');
          applyLive(liveEngine ?? 'plain', '');
        },
      }));
    } else if (view === 'tones') {
      head.textContent = `live voice · ${liveDraft ?? liveCfg.voice} — pick a tone · ▶ previews`;
      TONES.forEach(([label, styleText]) => narrRows.push({
        text: label,
        preview: { voice: liveDraft ?? liveCfg.voice, style: styleText, prefetch: 'tones' },
        cur: narrSet?.live && liveCfg.tone === label,
        commit: () => applyLive(label, styleText),
      }));
      narrRows.push({ text: 'Custom…', cur: narrSet?.live && liveCfg.tone === 'Custom', commit: () => renderNarr('custom') });
    } else { // custom tone input
      head.textContent = `live voice · ${liveDraft ?? liveCfg.voice} — type the delivery instruction · ▶ previews`;
      const wrap = document.createElement('div');
      wrap.className = 'narr-preview-row';
      const input = document.createElement('input');
      input.className = 'narr-input';
      input.value = liveCfg.style;
      input.placeholder = 'Read in a …';
      // onKey ignores events targeting inputs — commit/back live on the field
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { commitCustomTone(); e.preventDefault(); }
        else if (e.key === 'Escape') { narrBack(); e.preventDefault(); }
        e.stopPropagation();
      });
      // audition the typed instruction before committing it with Enter
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'narr-prev-btn narr-reset-btn';
      prev.textContent = '▶';
      prev.title = 'preview this delivery instruction';
      prev.setAttribute('aria-label', 'preview this delivery instruction');
      prev.addEventListener('click', (e) => {
        e.stopPropagation();
        const style = input.value.trim();
        if (style) previewClip({ voice: liveDraft ?? liveCfg.voice, style }, prev);
      });
      wrap.append(input, prev);
      card.appendChild(wrap);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      narrRows = [];
      narrSel = 0;
      return;
    }
    narrRows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'narr-row' + (row.cur ? ' narr-cur' : '');
      const label = document.createElement('span');
      label.className = 'narr-row-label';
      if (row.html) label.innerHTML = row.text; else label.textContent = row.text;
      el.appendChild(label);
      if (row.preview) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'narr-prev-btn';
        btn.textContent = '▶';
        btn.title = `preview ${row.preview.voice}`;
        btn.setAttribute('aria-label', `preview ${row.preview.voice}`);
        btn.addEventListener('click', (e) => { e.stopPropagation(); previewClip(row.preview, btn); });
        el.appendChild(btn);
      }
      el.addEventListener('mouseenter', () => selectNarrRow(i));
      el.addEventListener('click', () => { selectNarrRow(i); commitNarrRow(); });
      card.appendChild(el);
    });
    const cur = narrRows.findIndex((r) => r.cur);
    selectNarrRow(Math.max(0, cur));
    narrEl.querySelector('.narr-sel')?.scrollIntoView({ block: 'nearest' });
  }
  function commitCustomTone() {
    const v = narrEl?.querySelector('.narr-input')?.value.trim();
    if (v) applyLive('Custom', v);
  }
  function openNarrPicker(view) {
    if (narrEl && view === undefined) return closeNarrPicker(); // N toggles
    if (!narrEl) {
      narrEl = document.createElement('div');
      narrEl.className = 'decklight-narr';
      narrEl.innerHTML = '<div class="narr-card" role="listbox" aria-label="Narration"></div>';
      closeOnBackdrop(narrEl, closeNarrPicker);
      root.appendChild(narrEl);
    }
    renderNarr(view ?? (narrSets.length ? 'tracks' : 'voices'));
    // ask the bridge what it can speak, and repaint if the answer changes the
    // list under the user — but only while they are still looking at it
    probeLive().then((p) => { if (p && narrEl && narrView === 'voices') renderNarr('voices'); });
  }
  function closeNarrPicker() {
    narrEl?.remove();
    narrEl = null;
    charProbed = false; // next open re-probes the lipsync bridge
  }

  // ⇧V: batch-record the whole deck offline with the current live voice/tone.
  // Reuses fetchLive/liveCache (so the recorded slides also warm live
  // playback) and drives each blob straight into a browser download —
  // no server-side write, no zip dependency. The progress card's ETA is a
  // running average: elapsed ÷ slides-done × slides-left.
  // recRun is a generation counter, not a boolean: closing the dialog bumps
  // it, and a loop only acts while its own run is still current — a cancel
  // followed by an immediate re-record can't resurrect the old loop.
  let recEl = null, recView = 'confirm', recRun = 0;
  function slidesWithNotes() {
    const out = [];
    for (let sl = 1; sl <= instance.state.totalSlides; sl++) if (notesText(sl)) out.push(sl);
    return out;
  }
  function fmtTime(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
  }
  function renderRecordCard(view, data = {}) {
    recView = view;
    const card = recEl.querySelector('.narr-card');
    if (view === 'confirm') {
      const n = data.total;
      card.innerHTML = `<div class="narr-head">record offline narration</div>
        <div class="rec-line">⚡ ${liveCfg.voice} · ${liveCfg.tone}</div>
        <div class="rec-line">${n} slide${n === 1 ? '' : 's'} stitched from the sentence cache — only unheard sentences synthesize</div>
        <div class="narr-row narr-sel">Start recording</div>
        <div class="rec-hint">Enter to start · Esc to cancel</div>`;
      card.querySelector('.narr-row').addEventListener('click', startRecording);
    } else if (view === 'progress') {
      const { done, total, elapsedMs } = data;
      const pct = total ? Math.round((done / total) * 100) : 0;
      const eta = done ? fmtTime((elapsedMs / done) * (total - done)) : '…';
      card.innerHTML = `<div class="narr-head">recording…</div>
        <div class="rec-bar"><div class="rec-bar-fill" style="width:${pct}%"></div></div>
        <div class="rec-line">${done} / ${total} slides · ${fmtTime(elapsedMs)} elapsed · ~${eta} left</div>
        <div class="rec-hint">Esc to cancel</div>`;
    } else {
      const { saved, total, cancelled } = data;
      card.innerHTML = `<div class="narr-head">${cancelled ? 'recording cancelled' : 'recording done'}</div>
        <div class="rec-line">${saved} / ${total} slide${total === 1 ? '' : 's'} saved as slide-NN.wav to your downloads</div>
        <div class="rec-line">Point <code>narration.files</code> at that folder with <code>ext: 'wav'</code> to play them back without the bridge.</div>
        <div class="rec-hint">Enter or Esc to close</div>`;
    }
  }
  // Slide files are STITCHED FROM THE SENTENCE CACHE: every clip already
  // played (or warmed by the lookahead buffer) is reused as-is — only the
  // sentences never spoken get synthesized. Clips are joined with short
  // silences (breath between sentences, a longer beat between builds).
  const SENT_GAP_S = 0.15;
  const SEG_GAP_S = 0.35;
  function stitchWav(chunks, rate) {
    const dataLen = chunks.reduce((n, c) => n + c.length, 0);
    const h = new DataView(new ArrayBuffer(44));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); h.setUint32(4, 36 + dataLen, true); w(8, 'WAVE');
    w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
    w(36, 'data'); h.setUint32(40, dataLen, true);
    return new Blob([h.buffer, ...chunks], { type: 'audio/wav' });
  }
  const silencePcm = (rate, seconds) => new Uint8Array(2 * Math.round(rate * seconds));
  async function stitchSlideWav(sl, run) {
    const rec = instance._records[sl - 1];
    const max = rec ? rec.groups.length : 0;
    const segs = notesSegs(sl);
    const chunks = [];
    let rate = 24000;
    for (let step = 0; step <= max; step++) {
      const sentences = splitSentences(segs[step]);
      for (let i = 0; i < sentences.length; i++) {
        const clip = await fetchLiveSentence(sl, step, i); // cache-first
        if (run !== recRun) return null;
        if (!clip) continue;
        const buf = await clip.blob.arrayBuffer();
        if (chunks.length === 0) rate = new DataView(buf).getUint32(24, true) || 24000;
        else chunks.push(silencePcm(rate, i === 0 ? SEG_GAP_S : SENT_GAP_S));
        chunks.push(new Uint8Array(buf.slice(44)));
      }
    }
    return chunks.length ? stitchWav(chunks, rate) : null;
  }
  // Viseme counterpart of stitchSlideWav: the SAME sentences, the SAME
  // silence gaps, so the merged timeline lines up with the stitched WAV.
  // Cache-first through the character's own promise cache — sentences whose
  // visemes the lookahead already fetched are free. Any failure (bridge
  // down) just skips the sidecar; the WAV still records.
  async function stitchSlideVisemes(sl, run) {
    if (character.mode !== 'viseme') return null;
    const rec = instance._records[sl - 1];
    const max = rec ? rec.groups.length : 0;
    const segs = notesSegs(sl);
    const parts = [];
    try {
      for (let step = 0; step <= max; step++) {
        const sentences = splitSentences(segs[step]);
        for (let i = 0; i < sentences.length; i++) {
          const tl = await character.ensureTimeline(
            sentenceKey(sl, step, i), fetchLiveSentence(sl, step, i), sentences[i]);
          if (run !== recRun) return null;
          if (!tl) continue;
          parts.push({ timeline: tl, gap: parts.length ? (i === 0 ? SEG_GAP_S : SENT_GAP_S) : 0 });
        }
      }
    } catch {
      debugLog('lipsync', `slide ${sl}: viseme sidecar skipped (bridge unreachable)`);
      return null;
    }
    return parts.length ? concatTimelines(parts) : null;
  }
  async function startRecording() {
    const list = slidesWithNotes();
    const run = ++recRun;
    const t0 = Date.now();
    let done = 0, saved = 0;
    renderRecordCard('progress', { done, total: list.length, elapsedMs: 0 });
    for (const sl of list) {
      if (run !== recRun) return;
      try {
        const wav = await stitchSlideWav(sl, run);
        if (run !== recRun) return; // cancelled mid-synthesis — don't download
        if (wav) {
          const url = URL.createObjectURL(wav);
          downloadFromUrl(url, `slide-${String(sl).padStart(2, '0')}.wav`);
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          saved++;
          // character on: the matching viseme sidecar downloads too, so the
          // recorded set plays back lip-synced without the bridge
          const tl = await stitchSlideVisemes(sl, run);
          if (run !== recRun) return;
          if (tl) {
            const jurl = URL.createObjectURL(new Blob([JSON.stringify(tl)], { type: 'application/json' }));
            downloadFromUrl(jurl, `slide-${String(sl).padStart(2, '0')}.visemes.json`);
            setTimeout(() => URL.revokeObjectURL(jurl), 5000);
          }
        }
      } catch {
        toast(`slide ${sl}: recording failed`);
      }
      done++;
      if (run === recRun) renderRecordCard('progress', { done, total: list.length, elapsedMs: Date.now() - t0 });
    }
    if (run === recRun) renderRecordCard('done', { saved, total: list.length });
  }
  function openRecordDialog() {
    if (!narrSet?.live) { toast('live voice only — pick a voice with N first'); return; }
    if (recEl) return;
    recEl = document.createElement('div');
    recEl.className = 'decklight-narr decklight-record';
    recEl.innerHTML = '<div class="narr-card" role="dialog" aria-label="Record offline narration"></div>';
    closeOnBackdrop(recEl, closeRecordDialog);
    root.appendChild(recEl);
    renderRecordCard('confirm', { total: slidesWithNotes().length });
  }
  function closeRecordDialog() {
    recRun++; // invalidate any in-flight recording loop
    recEl?.remove();
    recEl = null;
  }

  // Both dialogs take the keyboard while they are up. The recorder registers
  // first because it can be opened from the picker, and the dialog that opened
  // last is the one you are looking at.
  overlays.register({
    isOpen: () => !!recEl,
    close: closeRecordDialog,
    keydown(e) {
      if (e.key === 'Escape') closeRecordDialog();
      else if (e.key === 'Enter') {
        if (recView === 'confirm') startRecording();
        else if (recView !== 'progress') closeRecordDialog();
      } else return false;
      return true;
    },
  });
  overlays.register({
    isOpen: () => !!narrEl,
    close: closeNarrPicker,
    keydown(e) {
      if (narrView === 'custom') {
        // everything else types into the input
        if (e.key === 'Enter') { commitCustomTone(); return true; }
        if (e.key === 'Escape') { narrBack(); return true; }
        return false;
      }
      switch (e.key) {
        case 'ArrowDown': selectNarrRow(narrSel + 1); break;
        case 'ArrowUp': selectNarrRow(narrSel - 1); break;
        case 'Enter': commitNarrRow(); break;
        case 'Escape': narrBack(); break;
        case 'n': case 'N': closeNarrPicker(); break;
        default: return false;
      }
      return true;
    },
  });

  return {
    character,
    toggleNarration,
    toggleNarrPause,
    changeNarrRate,
    toggleCaptions,
    openPicker: openNarrPicker,
    openRecordDialog,
    applySolo,
    notesSegs,
    /** Everything the engine's chrome, palette and debug panel read back. */
    status: () => ({
      narrating,
      paused: narrPaused,
      rate: narrRate,
      captionsOn,
      track: narrSet,
      live: !!narrSet?.live,
      voice: liveCfg.voice,
      tone: liveCfg.tone,
      hasTracks: narrSets.length > 0,
      spend: ttsSpend,
    }),
  };
}
