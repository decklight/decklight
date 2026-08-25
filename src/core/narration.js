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
import { escapeHtml } from './escape.js';
import { closeOnBackdrop, selectInList } from './overlay.js';
import {
  manifestSegmentUrl, manifestSlideUrl, expiryState, timeLeft, stampOf, resignCommand, trackKey,
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
 * Seconds a slide holds after its narration, from `data-narration-pause="2"`.
 *
 * The finite sibling of `data-narration="hold"` (PRESENTING): hold is a pause
 * with no end, this one has a number on it. Anything that is not a
 * non-negative finite number — absent, empty, negative, a typo — reads as no
 * pause, silently. A deck that mistypes it gets the behaviour it had before
 * the attribute existed, which is the only failure mode worth having for a
 * timing hint: nothing about the deck breaks, it simply does not breathe.
 *
 * Pure and exported so the parse rule is unit-testable without booting a deck.
 */
export function pauseSeconds(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
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
 *
 * `authorBase` is a THUNK, not a string: the author server's URL is only known
 * after editmode's probe answers, and editmode is built after this. It returns
 * the prefix to post to — **`''` for a same-origin server, which is the common
 * case and is not the same as absent** — or `null` when the deck is not being
 * authored, which is what sends ⇧V's recordings back down the download path.
 */
/**
 * `config.narration` as a list of TRACKS.
 *
 * A string is one track; an array is passed through as authored. The string
 * form used to drop everything beside the directory — so
 * `narration: { files: 'voiceover', ext: 'wav' }` produced `{label, dir}` with
 * no `ext`, and the deck went looking for `slide-01.m4a`. That line is not a
 * hypothetical: it is what the ⇧V recorder prints on its own done card and what
 * SPEC tells authors to write, so the documented way to play back a recording
 * resolved the wrong extension and failed as a missing file.
 *
 * `ext` and `segments` are read off the TRACK (`narrSet.ext`), which is why they
 * have to be copied onto the one this form builds rather than left on the
 * config object nothing consults.
 */
/**
 * Which FILE each runtime segment was written as. The tool↔runtime contract.
 *
 * These two split the same notes differently, and the difference is silent:
 * `notesSegs` (the runtime) keeps every part of the ⟨CLICK⟩ split, empties
 * included, because segment k must line up with build step k. `notesSegments`
 * (tools/voiceover.mjs, tools/deck-html.mjs) drops empties and gives up below
 * two, because it is naming files. So for `⟨CLICK⟩ A ⟨CLICK⟩ B` the runtime sees
 * three segments and the disk holds two files — and mapping step k to file k+1
 * plays the wrong beat over the wrong build with nothing to notice it by.
 *
 * Returns an array parallel to `segs` whose entry k is the 1-BASED file number
 * for that segment, or null where the segment produced no file. Returns null
 * when the tool would have produced no files at all, which is the signal to use
 * the whole-slide recording instead.
 *
 * Pure, and the single place either side may compute this.
 */
export function segmentFileIndex(segs) {
  const parts = (segs ?? []).map((t) => String(t ?? '').replace(/\s+/g, ' ').trim());
  // the tool's own `parts.length > 1 ? parts : null` — one segment is not a
  // segmented slide, it is a slide
  if (parts.filter(Boolean).length < 2) return null;
  let file = 0;
  return parts.map((t) => (t ? ++file : null));
}

/**
 * The beats to capture for one slide, in order — the recording plan.
 *
 * The mic recorder's unit is a ⟨CLICK⟩ SEGMENT, not a build step, because the
 * files are per segment: a slide with three beats over one build writes three
 * files, and recording per step would write two and leave the third missing.
 * The step each beat is filmed at is `min(k, steps)`, which is where playback
 * puts it — surplus beats sit on the last step with nothing left to reveal.
 *
 * `file` is the 1-based file number from `segmentFileIndex`, or **null** for a
 * slide the tool would not have segmented at all (fewer than two beats with
 * words in them). That slide is one take, `slide-NN.wav`, exactly as ⇧V and
 * tools/voiceover.mjs write it — a single-beat slide is not a segmented slide.
 *
 * Empty segments are dropped: `⟨CLICK⟩ A` is a beat before any words, and there
 * is nothing to read aloud for it.
 *
 * Pure, and the one place the recorder decides what it is recording.
 */
export function recordPlan(segs, steps = 0) {
  const parts = (segs ?? []).map((t) => String(t ?? '').replace(/\s+/g, ' ').trim());
  const index = segmentFileIndex(parts);
  if (!index) {
    const text = parts.filter(Boolean).join(' ');
    return text ? [{ seg: 0, step: 0, file: null, text }] : [];
  }
  return parts
    .map((text, k) => (text ? { seg: k, step: Math.min(k, steps), file: index[k], text } : null))
    .filter(Boolean);
}

/**
 * One buffer of mic audio as the 16-bit little-endian PCM every other part of
 * this toolchain speaks: `stitchWav` frames it, tools/lipsync.mjs reads it,
 * tools/video.mjs muxes it, and every TTS engine already returns it.
 *
 * Clamped before scaling, because a Web Audio sample is nominally -1..1 and
 * genuinely is not: a hot input overshoots, and a bare `s * 32768` wraps at the
 * Int16 boundary — the loudest moment of a take turning into a burst of noise
 * exactly where it is most audible.
 */
export function floatToPcm16(samples) {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(s * (s < 0 ? 32768 : 32767)), true);
  }
  return out;
}

/**
 * Where a recording should go, and what to call it in the picker.
 *
 * A TRACK IS A FOLDER. A deck carries as many as you have voices — four cloned
 * ones, the system voice, two takes of your own — and `N` is the switcher. So
 * the one thing a recorder must not do is write them all into the same place,
 * which is what a single `voiceover` default guaranteed: record a second voice
 * and the first was gone, with nothing said.
 *
 * The voice names the folder because it is the only thing that distinguishes
 * one take from another to the person doing it. `taken` is the folders that
 * already hold audio (the author server can see them; the deck cannot), and a
 * collision takes the next free suffix rather than overwriting or refusing —
 * the proposal is editable on the card, so a wrong guess costs a keystroke.
 */
export function proposeTrack({ engine, voice, mine = false } = {}, taken = []) {
  const slug = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40);
  const base = mine ? 'voices/me' : `voices/${slug(voice) || slug(engine) || 'take'}`;
  const used = new Set(taken);
  let dir = base;
  for (let n = 2; used.has(dir); n++) dir = `${base}-${n}`;
  const nth = dir === base ? '' : `, take ${dir.slice(base.length + 1)}`;
  const label = mine
    ? `My voice${nth}`
    : `${voice || 'Narration'}${engine ? ` · ${engine}` : ''}${nth}`;
  return { dir, label };
}

export function narrationTracks(narration) {
  const f = narration?.files;
  if (!f) return [];
  if (Array.isArray(f)) return f;
  const track = { label: 'Narration', dir: f };
  // Only when authored: `undefined` here would still be `undefined` on the
  // track, but writing the keys unconditionally makes every track object look
  // like it opted in to something it never mentioned.
  if (narration.ext !== undefined) track.ext = narration.ext;
  if (narration.segments !== undefined) track.segments = narration.segments;
  return [track];
}

export function createNarration({
  root, stage, config, params, printMode, toast, logOnly, debugLog, overlays, instance,
  syncSoundBtn, updateDebugState, downloadFromUrl, authorBase = () => null,
  authorReady = () => Promise.resolve(),
}) {
  // estimated $ across live-bridge calls (the x-tts-cost response header);
  // the D panel reads it back through status()
  let ttsSpend = 0;
  // ── narration (V) + picker (N) — SPEC PRESENTING ────────────────────────────────
  // Two sources, one V toggle. RECORDED: pre-rendered per-slide audio
  // (tools/voiceover.mjs, or ⇧V below; config.narration.files = '<dir>' or
  // [{ label, dir, ext }, …] — ext defaults to 'm4a', ⇧V recordings are
  // 'wav'). LIVE: synthesized on the fly per slide through the local bridge
  // (`decklight tts`) — pick a voice and, on an engine that can be told HOW
  // to say it (gemini, always; elevenlabs only with --tts-model eleven_v3),
  // a delivery tone in the picker; responses are cached per (slide, voice,
  // style) and the next slide is prefetched while the current one plays. N
  // opens the picker (tracks → voices → tones → custom-tone input); choice
  // persists per deck.
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
  // The bridge speaks with ONE engine, but it can be told to speak with another
  // (SPEC `NARRATION`) — so which one is a choice the deck can make, not just a
  // fact it reads. These two are the same route in its read and write forms.
  const ENGINES_URL = LIVE_URL.replace(/\/tts\/?$/, '/engines');
  const ENGINE_URL = LIVE_URL.replace(/\/tts\/?$/, '/engine');
  let liveVoices = GEMINI_VOICES;
  let liveStylable = true;  // only gemini takes a delivery instruction
  let liveEngine = null;
  let livePing = null;
  // The menu, and whether we have asked for it. Not cached across picker opens
  // like the roster is: a presenter who exported a key and restarted the bridge
  // must see that on the next open, not the answer from before they fixed it.
  let liveMenu = null;
  function probeLive() {
    livePing ??= fetch(PING_URL)
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => {
        if (!p) return null;
        // A saved voice the LIVE bridge cannot speak is stale, not a choice: it
        // was picked for a different engine (the Gemini roster is the default,
        // and an ElevenLabs key knows none of those names). Sending it anyway
        // makes the first V a failure for a setting nobody remembers making, so
        // the roster wins and the first voice — for ElevenLabs, one of YOURS —
        // takes over. Said out loud, because a voice changing on its own is
        // exactly the kind of thing that should never be silent. adoptBridge
        // holds that rule, because a mid-session engine swap needs it too.
        adoptBridge(p);
        debugLog('tts', `bridge: ${p.engine} · ${p.model} · ${liveVoices.length} voice(s)`
          + (liveStylable ? '' : ' · no style'));
        return p;
      })
      .catch(() => null); // no bridge — the picker still works, V just warns
    return livePing;
  }
  /**
   * Take on what the bridge just told us about itself.
   *
   * Shared by the /ping probe and by a swap, because a swap raises exactly the
   * same question a first probe does — is the voice we hold still speakable? —
   * and only more often. piper answers one voice, ElevenLabs answers yours, and
   * a name kept from the previous engine would fail on the next sentence.
   */
  function adoptBridge(p) {
    if (!p) return null;
    liveEngine = p.engine ?? null;
    if (Array.isArray(p.voices) && p.voices.length) liveVoices = p.voices;
    liveStylable = p.stylable !== false;
    if (liveVoices.length && !liveVoices.some(([n]) => n === liveCfg.voice)) {
      const was = liveCfg.voice;
      liveCfg = { ...liveCfg, voice: liveVoices[0][0] };
      persistNarr();
      debugLog('tts', `voice ${was} is not on this bridge — using ${liveCfg.voice}`);
      if (narrSet?.live) toast(`voice ${was} → ${liveCfg.voice} (this bridge speaks its own roster)`, 2600);
    }
    return p;
  }

  // Third element is the SAME tone as a short ElevenLabs v3 audio-tag cue —
  // v3 wants a bracketed word or two of direction, not a Gemini-shaped prose
  // instruction, so each preset carries both and toneStyle() below picks the
  // one the live engine can actually act on.
  const TONES = [
    // single directive clauses: instruction-shaped text steers; persona
    // sentences ("You're a…") can stochastically be read aloud
    ['Warm senior engineer', 'Read in a warm, welcoming tone, like a friendly battle-hardened senior engineer who is still curious about new technology.', 'warmly'],
    ['Professional', 'Read in a clear, professional tone — measured, confident, and articulate.', 'professionally'],
    ['Too serious', 'Read in an extremely grave, deadly serious tone, as if announcing news of the utmost importance.', 'serious'],
    ['Joyful', 'Read in a joyful, light-hearted tone, smiling through every sentence.', 'joyfully'],
    ['Super excited', 'Read in a super-excited, high-energy tone, barely containing your enthusiasm.', 'excited'],
    ['Sad', 'Read in a somber, melancholic tone, on the verge of a sigh.', 'sad'],
  ];
  // Gemini reads the full instruction as a prompt prefix; ElevenLabs v3 reads
  // a short bracketed cue instead (tools/elevenlabs-tts.mjs wraps it in
  // brackets) — never the long Gemini-shaped sentence, which would still work
  // as v3 input but is not the short cue the ticket asks for.
  const toneStyle = ([, geminiText, tag]) => (liveEngine === 'elevenlabs' ? tag : geminiText);
  const narrSets = narrationTracks(config.narration);
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
  /** Build steps this slide has: 0 = arrival, then one per `data-build` group. */
  const buildSteps = (sl) => (instance._records?.[sl - 1]?.groups.length ?? 0);

  /**
   * What step `step` of slide `sl` actually SPEAKS.
   *
   * Normally one segment — segment k narrates build step k. But a slide can
   * carry more ⟨CLICK⟩ markers than it has builds (#350), and the commonest
   * case is a slide with no `data-build` at all: one step, and every segment
   * after the first used to be dead text. Never synthesized, never spoken,
   * never mentioned — while the speaker view went on displaying it, so the
   * presenter read a cue the deck would never say.
   *
   * The surplus rides on the LAST step instead. There is nothing left to
   * reveal, so the marker becomes a beat rather than a build trigger — which is
   * the same call `tools/video.mjs` makes for a count that does not line up:
   * render the slide the old way rather than bake in a wrong sync. Speaking it
   * is what preserves the author's words; the warning below is what tells them
   * the two counts disagree.
   *
   * `segStarts` marks which sentences begin a folded segment, so the ⇧V
   * stitcher can put a segment-sized silence there rather than a sentence one —
   * a recorded take breathes exactly where the live one does.
   */
  function stepAudio(sl, step) {
    const segs = notesSegs(sl);
    const texts = step < buildSteps(sl) ? [segs[step]] : segs.slice(step);
    const sentences = [];
    const segStarts = new Set();
    for (const t of texts) {
      const part = splitSentences(t);
      if (part.length) segStarts.add(sentences.length);
      sentences.push(...part);
    }
    return { sentences, segStarts };
  }
  const stepSentences = (sl, step) => stepAudio(sl, step).sentences;

  /**
   * Say once, per slide, that its notes ask for more beats than it has builds.
   *
   * The words are now spoken rather than dropped, so this is no longer a
   * report of lost content — but the two counts still disagree, and that is
   * nearly always an authoring slip worth seeing. It goes to the message log
   * (`I`) and the debug log, never a toast: it is a note about the deck, not
   * something the presenter must act on mid-sentence.
   */
  const warnedSegs = new Set();
  function warnSegOverflow(sl) {
    if (warnedSegs.has(sl)) return;
    const segs = notesSegs(sl).length;
    const steps = buildSteps(sl) + 1;
    if (segs <= steps) return;
    warnedSegs.add(sl);
    const msg = `slide ${sl}: ${segs} ⟨CLICK⟩ segments but ${steps} build step${steps === 1 ? '' : 's'}`
      + ` — the last ${segs - steps} ${segs - steps === 1 ? 'is' : 'are'} spoken on the final step`;
    logOnly?.(msg);
    debugLog('narr', msg);
  }

  const sentenceKey = (sl, step, i) => `${sl}|s${step}|n${i}|${liveCfg.voice}|${liveCfg.style}`;
  function fetchLiveSentence(sl, step, i) {
    const sentence = stepSentences(sl, step)[i] ?? '';
    return synthLive(sentence, sentenceKey(sl, step, i), `slide ${sl} seg ${step} #${i + 1}`);
  }
  // data-narration="hold": an interactive slide (quiz, exercise, live
  // demo) — narration plays whatever notes it has and builds still sync,
  // but the deck NEVER auto-advances off it; the presenter moves on
  // manually and narration resumes on the next slide.
  const narrationHolds = (sl) => instance._sections[sl - 1]?.dataset.narration === 'hold';
  // data-narration-pause="2": the same idea with an end to it — the slide
  // holds that many seconds after its last sentence before the deck moves on.
  // A diagram the room has to actually look at, a punchline, the beat before a
  // new section. `hold` wins on a slide carrying both: infinite beats finite.
  const narrationPause = (sl) => pauseSeconds(instance._sections[sl - 1]?.dataset.narrationPause);
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
      const max = buildSteps(sl);
      for (; step <= max && out.length < count; step++) {
        // stepSentences, not `segs[step]`: the last step may carry more than
        // its own segment, and a lookahead that under-counted would leave the
        // folded sentences to synthesize one at a time as they are reached.
        const n = stepSentences(sl, step).length;
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
  // ONE generation counter for every audio chain, live or recorded. The modes
  // are mutually exclusive at any instant, and sharing the counter is what
  // makes a track switch cancel whatever was in flight — two counters would
  // leave each mode blind to the other's cancellation, which is exactly the
  // bug that appears when the N picker swaps live→recorded mid-sentence.
  let segGen = 0; // cancels pending silent-beat timers and stale onended
  let narrPaused = false;     // P — freezes audio, captions and auto-advance
  let chainActive = false; // a chain (sentences or segment files) is running for chainGen
  let chainGen = 0;
  function toggleNarrPause() {
    if (!narrating) { toast('narration is off — V starts it'); return; }
    narrPaused = !narrPaused;
    if (narrPaused) {
      narrAudio?.pause();
    } else if (narrAudio?.src && narrAudio.paused && !narrAudio.ended && narrAudio.currentTime > 0) {
      narrAudio.play().catch(() => { /* autoplay policy */ }); // resume mid-sentence
    } else if (!chainActive) {
      playLive(); // nothing parked (e.g. paused on a silent beat) — re-arm
    } // else: the parked chain's pause-gate resumes on its own
    toast(narrPaused ? '⏸ narration paused — P resumes' : '▶ narration resumed');
    debugLog('narr', narrPaused ? 'paused' : 'resumed');
    updateDebugState();
  }
  /** Which kind of chain is entitled to advance the deck right now. */
  const modeNow = () => (narrSet?.live ? 'live' : narrSet ? 'file' : null);

  /**
   * The audio finished — move the deck the way a presenter would.
   *
   * `mode` is the chain declaring WHICH playback armed this advance, and the
   * staleness guard compares it against the mode that holds the deck NOW. That
   * replaces the old `!narrSet?.live` clause, which did double duty: it made
   * this function inert for recorded tracks (gone on purpose — recorded chains
   * may drive builds now) and it killed a live chain whose pending advance
   * survived a switch to a recorded track (kept, as the mode comparison — a
   * chain from the mode you switched away from must not move the deck the mode
   * you switched to is standing on). The shared segGen bump does the same job;
   * both stay, because the guard states the invariant where a counter three
   * functions away merely implies it.
   *
   * `endOfSlide` says the audio that just finished was the WHOLE slide, not one
   * step's segment — the recorded track's case for a slide with builds but no
   * ⟨CLICK⟩ in its notes. Stepping into the builds there would replay nothing
   * (there are no more files), so the advance skips to the next slide, the same
   * call tools/video.mjs makes when it renders such a slide at LAST_STEP.
   */
  async function advanceFrom(sl, step, { mode = 'live', endOfSlide = false } = {}) {
    const gen = segGen;
    const stale = () => gen !== segGen || !narrating || modeNow() !== mode
      || instance.state.slide !== sl || instance.state.step !== step;
    if (narrPaused || stale()) return;
    const rec = instance._records[sl - 1];
    if (!endOfSlide && step < (rec ? rec.groups.length : 0)) { instance.next(); return; }
    if (narrationHolds(sl) || sl >= instance.state.totalSlides) return;
    // The beat this slide asked for. Waited rather than slept through: P must
    // HOLD it, not eat it — a bare timer firing while paused would come back
    // to the narrPaused guard and drop the advance on the floor, leaving the
    // deck parked when the presenter resumes. Same shape as the sentence
    // chain's pause gate, and the same segGen guard as the silent beats,
    // so manual navigation mid-pause still wins.
    const pause = narrationPause(sl);
    if (pause > 0) {
      debugLog('narr', `slide ${sl} — holding ${pause}s before the next slide`);
      // Paused time is not spent time: the beat stops with the deck and picks
      // up where it left off, rather than quietly running out behind a ⏸.
      for (let left = pause * 1000; left > 0;) {
        if (stale()) return;
        const t0 = Date.now();
        await new Promise((r) => setTimeout(r, Math.min(150, left)));
        if (!narrPaused) left -= Date.now() - t0;
      }
      if (narrPaused || stale()) return;
    }
    instance.goto(sl + 1, 0);
  }
  async function playLive() {
    const sl = instance.state.slide, step = instance.state.step;
    const gen = ++segGen;
    fillLiveBuffer(); // (re-)arm the lookahead from the new position
    if (!notesText(sl)) {
      if (narrationHolds(sl)) { debugLog('narr', `hold on slide ${sl} — manual advance`); return; }
      // nothing to say on this slide at all — skip it after a short beat
      setTimeout(() => {
        if (gen !== segGen || !narrating || !narrSet?.live) return;
        if (instance.state.slide === sl && sl < instance.state.totalSlides) instance.goto(sl + 1, 0);
      }, 400);
      return;
    }
    warnSegOverflow(sl);
    const sentences = stepSentences(sl, step);
    if (!sentences.length) {
      // a build beat with no words — reveal the next step after a pause
      setTimeout(() => { if (gen === segGen) advanceFrom(sl, step); }, 600);
      return;
    }
    // speak the segment SENTENCE BY SENTENCE: each sentence is one cached
    // clip (short time-to-first-audio), the caption follows the spoken
    // sentence, and the build advances only after the segment's last one
    const stale = () => gen !== segGen || !narrating || instance.state.slide !== sl || instance.state.step !== step;
    chainGen = gen;
    chainActive = true;
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
        // Both handlers cleared BEFORE the src moves: narrAudio is one shared
        // element across live and recorded playback, and a handler left behind
        // by the other mode fires against this mode's audio. The recorded
        // path's onerror surviving into a live sentence would report a bridge
        // clip as a missing file; a stale onended is a promise resolved by an
        // ending it was never waiting for.
        narrAudio.onended = null;
        narrAudio.onerror = null;
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
      // awaited, so chainActive stays true across the slide's pause — P
      // during the beat then parks THIS chain (which resumes on its own)
      // instead of looking like nothing is running and re-speaking the slide.
      await advanceFrom(sl, step);
    } finally {
      if (chainGen === gen) chainActive = false;
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
    if (!narrSet || narrSet.live || !narrSet.manifest) {
      loaded = null;
      drivesBuilds = resolveDrivesBuilds();
      return true;
    }
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
    drivesBuilds = resolveDrivesBuilds();
    return true;
  }

  /**
   * Does THIS track carry per-segment audio — the files that let a recording
   * pace the builds instead of the presenter?
   *
   * Answered ONCE per track, here, and never by probing per slide. A HEAD
   * request would be wrong in exactly the deployments this must not break:
   * `fetch` is dead on `file://` (which is why bundledManifest exists at all),
   * and a `dir` pointing at a public bucket works today *precisely because*
   * <audio> does no CORS preflight — a probe against that bucket fails without
   * CORS headers and would report "no segments" for a track that has them. And
   * a media element cannot report an HTTP status, so a 404 is indistinguishable
   * from silence anyway.
   *
   * The ladder, in order:
   *   1. `segments: false` — never. The escape hatch for a folder holding stale
   *      slide-NN-KK files from an earlier recording.
   *   2. a manifest that declares them. Already written by tools/voiceover.mjs,
   *      already inlined by `decklight bundle`, already read by tools/video.mjs
   *      — no new config and no new I/O.
   *   3. a directory track that opted in with `segments: true`. Opt-in because
   *      the runtime cannot see the folder and must not guess — and because a
   *      ⇧V track must NOT become self-driving by accident: stitchSlideWav
   *      bakes `data-narration-pause` into the WAV, and advanceFrom honours the
   *      same pause again, so every beat would play twice.
   *   4. otherwise no — today's behaviour, byte for byte.
   */
  function resolveDrivesBuilds() {
    segFallback.clear();
    if (!narrSet || narrSet.live) return false;
    if (narrSet.segments === false) return false;
    if (narrSet.manifest) {
      const data = loaded?.data;
      const slides = data?.slides ?? [];
      const signed = Boolean(expiryState(data).at);
      // A SIGNED manifest that advertises segments is advertising audio
      // tools/publish-voices.mjs never uploaded — it walks slides[i].file only
      // and spreads the rest of the entry through untouched. Those segments
      // would 403 on every beat, so they are only believed when each carries
      // its own signed url.
      return slides.some((e) => Array.isArray(e?.segments) && e.segments.length
        && (!signed || e.segments.every((sg) => sg?.url)));
    }
    return narrSet.segments === true;
  }
  // Per-slide, cleared with the track: a slide whose FIRST segment could not be
  // played falls back to its whole-slide file and stays there, rather than
  // re-failing on every step.
  const segFallback = new Set();
  let drivesBuilds = false;

  /**
   * The audio files step `step` of slide `sl` plays, in order — or null when
   * this slide has none and the whole-slide file should play instead.
   *
   * The recorded twin of `stepAudio`, fold and all: on the LAST step it returns
   * every remaining segment rather than one, so the surplus a slide carries
   * beyond its build count is chained back to back (#350). That is why this
   * needs no `segments.length === builds + 1` equality guard where
   * tools/video.mjs has one — video cannot chain within a single still, and the
   * player can.
   *
   * An empty array is a legitimate silent beat, exactly as in playLive.
   */
  function stepFiles(sl, step) {
    if (!drivesBuilds || segFallback.has(sl)) return null;
    const segs = notesSegs(sl);
    const index = segmentFileIndex(segs);
    if (!index) return null;
    const last = step >= buildSteps(sl);
    const from = Math.min(step, index.length);
    const files = (last ? index.slice(from) : index.slice(from, from + 1))
      .filter((n) => n !== null)
      // The NUMBER travels with the url, not just the url: the character's
      // viseme sidecar is named after it (slide-NN-KK.visemes.json), and
      // deriving it back out of a signed url is not possible at all.
      .map((n) => ({
        file: n,
        url: narrSet.manifest
          ? manifestSegmentUrl(loaded?.data, narrSet.manifest, sl, n)
          : `${narrSet.dir}/slide-${String(sl).padStart(2, '0')}-${String(n).padStart(2, '0')}.${narrSet.ext ?? 'm4a'}`,
      }));
    // A manifest that ran out of segments is the authority saying this slide
    // was recorded whole — not an error, just a different shape.
    return files.every((f) => f.url) ? files : null;
  }
  /** Where slide n plays from, for either kind of track — null for silence. */
  function slideFileUrl(n) {
    if (narrSet.manifest) return manifestSlideUrl(loaded?.data, narrSet.manifest, n);
    // state.slide and the files are BOTH 1-based (slide-01 = first section).
    // ext defaults to the pre-render tool's .m4a; ⇧V-recorded sets are .wav.
    return `${narrSet.dir}/slide-${String(n).padStart(2, '0')}.${narrSet.ext ?? 'm4a'}`;
  }
  /**
   * The router. Three shapes of track, one entry point — every caller
   * (`slide`, `build`, V, the picker) goes through here and none of them needs
   * to know which shape is selected.
   */
  function playSlideFile() {
    if (!narrSet) return;
    if (narrSet.live) return playLive();
    if (drivesBuilds) return playRecorded();
    return playWholeSlide();
  }

  /**
   * One file for the whole slide — the recorded track decklight has always
   * played, unchanged.
   *
   * `selfDriving` is the one addition: a track whose segments pace the deck
   * still meets slides that were recorded whole (no ⟨CLICK⟩ in the notes, or a
   * manifest that lists no segments for them). Those must not park the deck at
   * the end of their file — they advance the SLIDE when it ends, which is the
   * `endOfSlide` call tools/video.mjs makes for the same shape.
   */
  function playWholeSlide({ selfDriving = false, gen = segGen } = {}) {
    const sl = instance.state.slide, step = instance.state.step;
    // A slide with nothing to say has no file, and that is NOT a failure: the
    // pre-render tool only emits audio for slides that have notes (the showcase
    // is 30 slides and 20 clips). Warning here would fire ten times on a deck
    // that is behaving perfectly — so only a slide that SHOULD speak can complain.
    if (!notesText(sl)) { narrAudio?.pause(); return; }
    const file = slideFileUrl(sl);
    // a manifest is the authority on what exists: no entry, nothing to play
    if (!file) { narrAudio?.pause(); return; }
    narrAudio ??= new Audio();
    // same hygiene as the live chain: the element is shared, and a live
    // sentence's onended must not be resolved by a recorded slide finishing
    narrAudio.onended = null;
    narrAudio.onerror = null;
    narrAudio.src = file;
    narrAudio.playbackRate = narrRate;
    if (character.mode !== 'off') {
      character.attachAudio(narrAudio);
      character.beginSlide(narrSet, sl);
    }
    if (selfDriving) {
      // The generation the CALLER was on, not the one this reads when the file
      // ends: navigation during playback bumps segGen, and an advance armed
      // before it must not fire after it.
      narrAudio.onended = () => { if (gen === segGen) advanceFrom(sl, step, { mode: 'file', endOfSlide: true }); };
    }
    // The same split playRecorded makes: NotAllowedError is autoplay policy
    // and a click fixes it; any other rejection is the SOURCE failing, and
    // telling somebody to click the deck at a missing file sends them to fix
    // the wrong thing. onerror usually reports source failures first — the
    // dedupe keeps one failure from toasting twice.
    let saidFailed = false;
    narrAudio.onerror = () => { saidFailed = true; fileFailed(sl, file); };
    narrAudio.play().catch((e) => {
      if (e?.name === 'NotAllowedError') toast('🔇 the browser blocked audio — click the deck once, then V');
      else if (!saidFailed) fileFailed(sl, file);
    });
  }

  /**
   * A recorded file that would not load — the one place it is reported, so the
   * whole-slide path and the segment chain say the same thing about it.
   *
   * A track with no file for this slide used to fail in total silence: with
   * nothing on screen, an unnarrated slide is indistinguishable from a broken
   * one. `fatal` is the difference between the two callers: a whole-slide file
   * missing costs this slide's audio and the deck plays on, while a segment
   * missing mid-slide stops the deck, because on a self-pacing track the voice
   * is the clock and the next build is waiting on a beat that will never come.
   */
  function fileFailed(sl, file, { fatal = false } = {}) {
    debugLog('narr', `no audio: ${file}`);
    const exp = narrSet?.manifest ? expiryState(loaded?.data) : null;
    if (exp?.at) {
      // A SIGNED file that will not load is the clock running out — a 403 for
      // a lapsed or revoked signature. A media element never reports the
      // status, so the deck cannot prove it; what it CAN do is stop (the
      // voice is the clock) and name the one command that fixes the only
      // cause worth naming.
      debugLog('narr', 'signed url failed — a media element cannot report the status');
      stopNarration(`🔇 slide ${sl} of “${narrSet.label}” would not load`
        + ` (signed until ${stampOf(exp.at)}) — auto-advance stopped`
        + ` · re-sign: ${resignCommand(loaded?.data)}`);
      return;
    }
    if (fatal) {
      stopNarration(`🔇 no audio for slide ${sl} (${file}) — auto-advance stopped`
        + ' · press the key left of 1 for messages');
      return;
    }
    toast(`🔇 no narration for slide ${sl} (${file}) · press the key left of 1 for messages`);
  }

  /**
   * The recorded voice pacing the deck: the segments belonging to THIS step,
   * played back to back, and then the same advanceFrom the live chain awaits.
   *
   * Structurally playLive with the fetch removed — same silent-slide skip, same
   * pause gate between clips, same staleness guard, same `finally`. Kept
   * parallel deliberately: these two are the only things that move the deck on
   * their own, and a divergence between them is a bug that only shows up in one
   * of the two modes.
   */
  async function playRecorded() {
    const sl = instance.state.slide, step = instance.state.step;
    const gen = ++segGen;
    if (!notesText(sl)) {
      if (narrationHolds(sl)) { debugLog('narr', `hold on slide ${sl} — manual advance`); return; }
      // nothing to say on this slide at all — skip it after a short beat
      setTimeout(() => {
        if (gen !== segGen || !narrating || modeNow() !== 'file') return;
        if (instance.state.slide === sl && sl < instance.state.totalSlides) instance.goto(sl + 1, 0);
      }, 400);
      return;
    }
    warnSegOverflow(sl);
    const files = stepFiles(sl, step);
    // recorded whole — one file, then the next slide
    if (!files) { playWholeSlide({ selfDriving: true, gen }); return; }
    if (!files.length) {
      // a build beat with no words — reveal the next step after a pause
      setTimeout(() => { if (gen === segGen) advanceFrom(sl, step, { mode: 'file' }); }, 600);
      return;
    }
    const stale = () => gen !== segGen || !narrating || modeNow() !== 'file'
      || instance.state.slide !== sl || instance.state.step !== step;
    chainGen = gen;
    chainActive = true;
    try {
      for (let i = 0; i < files.length; i++) {
        while (narrPaused) { // P holds the chain between segments too
          if (stale()) return;
          await new Promise((r) => setTimeout(r, 150));
        }
        if (stale()) return;
        narrAudio ??= new Audio();
        if (character.mode !== 'off') {
          character.attachAudio(narrAudio);
          // Per BEAT: the sidecar is cut to the same audio this element is
          // about to play, so the mouth cannot drift across a ⟨CLICK⟩ the way
          // one slide-long timeline replayed per beat inevitably did.
          character.beginSlide(narrSet, sl, files[i].file);
        }
        // both cleared before the src moves — see playLive
        narrAudio.onended = null;
        narrAudio.onerror = null;
        narrAudio.src = files[i].url;
        narrAudio.playbackRate = narrRate;
        const how = await new Promise((done) => {
          narrAudio.onended = () => done('ended');
          // `error` is the ONLY 404 signal a media element gives — it cannot
          // report an HTTP status — and it is raced against play() because a
          // resolved play() does not mean anything was heard.
          narrAudio.onerror = () => done('error');
          // A rejected play() is two different failures wearing one shape:
          // NotAllowedError is autoplay policy (fixable with a click), and
          // anything else is the source itself, which is the missing-file path.
          narrAudio.play().catch((e) => done(e?.name === 'NotAllowedError' ? 'blocked' : 'error'));
        });
        if (stale()) return;
        if (how === 'blocked') {
          stopNarration('🔇 the browser blocked audio — click the deck once, then V — the slides wait for the voice');
          return;
        }
        if (how === 'error') {
          // The FIRST segment of a slide missing means this slide was probably
          // recorded whole while its neighbours were not — a mixed folder is
          // the normal state of a deck being re-recorded slide by slide. Take
          // the whole-slide file and stay there for this slide.
          if (step === 0 && i === 0) {
            debugLog('narr', `no segments for slide ${sl} — falling back to the whole-slide file`);
            segFallback.add(sl);
            playWholeSlide({ selfDriving: true, gen });
            return;
          }
          // Past the first beat there is nothing to fall back TO: the segments
          // already spoke, and replaying the whole slide would repeat them. The
          // voice is the clock, so the deck stops rather than walking on in
          // silence — and names the file, because that is the fix.
          fileFailed(sl, files[i].url, { fatal: true });
          return;
        }
      }
      if (stale()) return;
      // awaited, so chainActive stays true across the slide's pause — see playLive
      await advanceFrom(sl, step, { mode: 'file' });
    } finally {
      if (chainGen === gen) chainActive = false;
    }
  }
  // the one teardown: V, and the bridge giving up, must leave the same state
  function stopNarration(msg = 'narration off') {
    narrating = false;
    segGen++; // cancel any pending silent-beat advance
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
  // Builds re-sync the voice — whether the advance came from the narration
  // itself or from the presenter pressing → mid-sentence. Conditional on the
  // track pacing itself: an unconditional call would make a PLAIN recorded
  // track restart its whole-slide file on every →.
  instance.on('build', () => {
    if (!narrating) return;
    if (narrSet?.live) playLive();
    else if (drivesBuilds) playRecorded();
  });

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
    // stepSentences, not the raw segment: on the last step this is every
    // segment the slide has no build for, and a caption that showed only the
    // first would go quiet exactly where the voice does not (#350).
    setCaption(stepSentences(instance.state.slide, instance.state.step).join(' '));
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
  /**
   * Move the selection, and scroll to it only when the KEYBOARD moved it.
   *
   * The card scrolls (`max-height: 70vh`) and the voices view is long — 30
   * names on the cloud engines, 184 on a Mac's own — so ↓ used to walk the
   * highlight straight off the bottom of a list that never moved: past row ~15
   * you were choosing blind.
   *
   * But the rows also select on HOVER, and scrolling there would be a list that
   * jerks under the cursor — a row half off the edge would pull itself into
   * view and drag the row under the mouse out from under it. So the two callers
   * ask for different things, which is why this is a parameter and not simply
   * `selectInList`'s default.
   */
  function selectNarrRow(i, { scroll = false } = {}) {
    if (!narrRows.length) return;
    narrSel = selectInList(narrEl.querySelectorAll('.narr-row'), i, 'narr-sel', { scroll });
  }
  function commitNarrRow() { narrRows[narrSel]?.commit(); }
  function narrBack() {
    if (narrView === 'custom') renderNarr('tones');
    else if (narrView === 'tones') renderNarr('voices');
    else if (narrView === 'engines') renderNarr('voices');
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
        // liveVoices, not GEMINI_VOICES (#348): the built-in roster is the
        // fallback that stands only until /ping answers, and prefetching it on
        // an engine that never had those voices means 30 synthesis calls for
        // names it cannot say — free but pointless on piper or a system voice,
        // and metered against your plan on ElevenLabs.
        prefetchPreviews(text, liveVoices.map(([n]) => ({ voice: n, style: '' })), 'voices');
      } else if (prefetch === 'tones') {
        prefetchPreviews(text, TONES.map((t) => ({ voice, style: toneStyle(t) })), `tones:${voice}`);
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
        // ☁ says the audio is not in this deck's folder; the countdown says
        // how long that will keep being true. Both come from the manifest
        // only once it has been loaded — before that, the row is honest
        // about knowing only where to look.
        text: t.manifest ? `☁ ${t.label}` : `🔊 ${t.label} (${t.dir}/)`,
        flavor: t.manifest ? manifestFlavor(t) : '',
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
        text: '🎭 2D character — offline visemes',
        flavor: bi?.engines?.viseme ? '' : 'bridge offline — amplitude fallback',
        cur: character.mode === 'viseme',
        commit: () => applyCharacter('viseme'),
      });
      narrRows.push({
        text: `🎥 Neural video — local GPU${vids.length ? '…' : ''}`,
        flavor: vids.length ? '' : 'needs the bridge — run: decklight lipsync',
        cur: character.mode === 'video',
        commit: () => {
          if (vids.length) renderNarr('charvideo');
          else toast('video needs wav2lip/sadtalker on the bridge — run: decklight lipsync');
        },
      });
      // a toggle, not a mode: solo works with either look above
      if (character.mode !== 'off') {
        narrRows.push({
          text: `${character.solo ? '◉' : '○'} Solo — the narrator takes the stage`,
          flavor: 'slide content steps aside',
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
    } else if (view === 'engines') {
      head.textContent = 'live voice — which engine speaks';
      // Asked fresh on every open. A presenter who just exported a key and
      // restarted the bridge must see that, not the answer from before they
      // fixed it — and the whole list is four probes on the Node side.
      if (!liveMenu) {
        // A bridge that ANSWERS 404 is a different problem from one that does
        // not answer at all: it is running, it is older than this deck, and
        // telling its owner to start the thing they already started would send
        // them looking in the wrong place entirely.
        fetch(ENGINES_URL)
          .then((r) => (r.ok ? r.json() : { stale: true }))
          .then((j) => { liveMenu = j?.stale ? 'stale' : (j?.engines ?? []); })
          .catch(() => { liveMenu = []; })
          .then(() => { if (narrEl && narrView === 'engines') renderNarr('engines'); });
      }
      if (!liveMenu) narrRows.push({ text: 'asking the bridge…', cur: false, commit: () => {} });
      else if (liveMenu === 'stale') {
        narrRows.push({
          text: `⚡ ${liveEngine ?? 'the bridge'} — and it cannot be changed from here`,
          flavor: 'this voice bridge predates the engine picker',
          blocked: 'restart it: decklight author',
          cur: true,
          commit: () => {},
        });
      } else if (!liveMenu.length) {
        narrRows.push({
          text: 'no voice bridge is answering',
          flavor: 'the engine list comes from it',
          blocked: 'decklight author',
          cur: false,
          commit: () => {},
        });
      }
      (Array.isArray(liveMenu) ? liveMenu : []).forEach((e) => narrRows.push({
        // No glyph: every row here is the same kind of thing, and the card's
        // own ✓ already marks the live one — a ⚡ beside it would say it twice.
        text: e.name,
        // Ready: the price note, which is the thing that actually decides this
        // for most people. Not ready: what is missing — never a price for
        // something that cannot speak.
        flavor: e.ready ? (e.cost ?? '') : (e.why ?? 'unavailable'),
        blocked: e.ready ? null : (e.fix ?? null),
        cur: !!e.current,
        commit: () => switchEngine(e),
      }));
    } else if (view === 'voices') {
      head.textContent = 'live voice — pick a voice · ▶ previews';
      // The engine sits ABOVE the voice and decides the whole roster, so it
      // belongs here rather than a level up: this is the screen where you
      // notice the names are not the ones you wanted. Never in the way — it is
      // one row, and picking a voice does not pass through it.
      narrRows.push({
        text: `⚙ engine: ${liveEngine ?? 'the bridge'}…`,
        flavor: 'changes which voices exist',
        cur: false,
        commit: () => renderNarr('engines'),
      });
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
        text: name,
        flavor,
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
      TONES.forEach((t) => {
        const [label] = t;
        const styleText = toneStyle(t);
        narrRows.push({
          text: label,
          preview: { voice: liveDraft ?? liveCfg.voice, style: styleText, prefetch: 'tones' },
          cur: narrSet?.live && liveCfg.tone === label,
          commit: () => applyLive(label, styleText),
        });
      });
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
      el.className = 'narr-row' + (row.cur ? ' narr-cur' : '')
        + (row.blocked || row.blocked === '' ? ' narr-blocked' : '');
      const label = document.createElement('span');
      label.className = 'narr-row-label';
      // Built as nodes, not innerHTML: a bridge's voice names and flavors are
      // somebody else's text (an ElevenLabs roster is named by whoever shared
      // the voices) — textContent escapes them by construction.
      label.textContent = row.text;
      if (row.flavor) {
        const flavor = document.createElement('span');
        flavor.className = 'narr-flavor';
        flavor.textContent = row.flavor;
        label.appendChild(flavor);
      }
      el.appendChild(label);
      // The fix gets its own line rather than joining the flavor: it is a
      // command to type, and a command wrapped into a sentence is a command
      // somebody mis-copies.
      if (row.blocked) {
        const fix = document.createElement('div');
        fix.className = 'narr-fix';
        fix.textContent = row.blocked;
        el.appendChild(fix);
      }
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
    // Opening on the current row means opening SCROLLED to it — a saved voice
    // 90 rows down is otherwise a picker that looks like it forgot.
    const cur = narrRows.findIndex((r) => r.cur);
    selectNarrRow(Math.max(0, cur), { scroll: true });
  }
  /**
   * Ask the bridge to speak with a different engine, for this session only.
   *
   * NOT PERSISTED, deliberately. `~/.config/decklight/tts.json` is what the CLI
   * and the setup wizard write, and it decides what the NEXT `decklight author`
   * starts with; an experiment two minutes before a talk must not quietly
   * become tomorrow's default. The bridge itself keeps the choice until it is
   * restarted, so it survives a reload of the deck.
   *
   * A blocked engine is a dead end here on purpose (SPEC `NARRATION`): the row
   * says what is missing and where to fix it, and the fix is always something
   * you do in a terminal. A key or a project id typed into a deck — even one on
   * loopback — is a different thing from one exported in a shell, and a deck
   * under `--remote` is reachable from a phone.
   */
  async function switchEngine(e) {
    if (!e?.name) return;
    if (!e.ready) {
      return toast(e.fix ? `${e.name}: ${e.why} — ${e.fix}` : `${e.name}: ${e.why ?? 'unavailable'}`, 5000);
    }
    if (e.current) return renderNarr('voices');
    try {
      const r = await fetch(ENGINE_URL, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ engine: e.name }),
      });
      const j = await r.json();
      if (!j.ok) return toast(`${e.name}: ${j.why ?? j.error}${j.fix ? ` — ${j.fix}` : ''}`, 5000);
      // The roster just changed under us, so the cached /ping must not be
      // replayed — and adoptBridge re-picks the voice if the one we held is
      // not on the new engine.
      livePing = Promise.resolve(adoptBridge(j));
      liveMenu = null;
      debugLog('tts', `engine → ${j.engine} · ${j.model} · ${liveVoices.length} voice(s)`);
      toast(`⚡ engine: ${j.engine}${j.cost ? ` · ${j.cost}` : ''} — this session only`, 3200);
      if (j.caveat) toast(j.caveat, 6000);
      renderNarr('voices');
    } catch { toast(`${e.name}: the voice bridge did not answer`, 3000); }
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
  let recEl = null, recView = 'confirm', recRun = 0, recTarget = null;
  /**
   * The slides a recorder walks: every one that has something to say, narrowed
   * by `?slides=a-b` when `decklight record --slides` asked for a range.
   *
   * The range exists because recording starts at slide 1 and there is no way
   * to skip: fluff slide 30 of a 40-slide deck and you would read 29 slides of
   * beats to reach it again. Esc already lets you keep a PREFIX; this is what
   * lets you redo a middle. Files outside the range are left exactly as they
   * are, which is the whole point — a re-record is meant to be surgical.
   */
  function slidesWithNotes() {
    const out = [];
    for (let sl = 1; sl <= instance.state.totalSlides; sl++) if (notesText(sl)) out.push(sl);
    const m = /^(\d+)(?:-(\d+))?$/.exec(params?.get?.('slides') ?? '');
    if (!m) return out;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    return out.filter((sl) => sl >= from && sl <= to);
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
        ${folderRow(data.target)}
        <div class="narr-row narr-sel">Start recording</div>
        <div class="rec-hint">Enter to start · Esc to cancel</div>`;
      wireFolderRow(card, (t) => { recTarget = t; });
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
      const { saved, total, cancelled, dir } = data;
      // Where they landed is the whole point of the line: "your downloads" was
      // true and useless — the next command you run reads the deck's folder.
      const names = data.segmented ? 'slide-NN.wav + one slide-NN-KK.wav per ⟨CLICK⟩' : 'slide-NN.wav';
      const where = dir
        ? `saved as ${names} in <code>${escapeHtml(dir)}/</code>, next to the deck`
        : `saved as ${names} to your downloads — ${noServerReason()}`;
      const seg = data.segmented ? ', segments: true' : '';
      const next = dir
        ? `Set <code>narration: { files: '${escapeHtml(dir)}', ext: 'wav'${seg} }</code> to play them back without the bridge — <code>decklight bundle</code> picks the folder up from there.`
          + (data.segmented ? ' <strong>segments</strong> is what makes them step the builds.' : '')
        : `Move them next to the deck and point <code>narration.files</code> at that folder with <code>ext: 'wav'${seg}</code> to play them back without the bridge.`;
      card.innerHTML = `<div class="narr-head">${cancelled ? 'recording cancelled' : 'recording done'}</div>
        <div class="rec-line">${saved} / ${total} slide${total === 1 ? '' : 's'} ${where}</div>
        <div class="rec-line">${next}</div>
        ${useTrackRow(dir)}
        ${doneHint(dir)}`;
      wireUseTrack(card, dir, { ext: 'wav', label: data.label, ...(data.segmented ? { segments: true } : {}) });
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
  /**
   * Which ⟨CLICK⟩ segment each run of a step's sentences came from.
   *
   * `stepAudio` flattens a step's segments into one sentence list, and on the
   * LAST step that list is every remaining segment (#350) — so the flattening
   * has to be undone to write one file per segment. `segStarts` marks where the
   * runs begin but not WHICH segment each is; this pairs them up.
   *
   * Empty segments contribute no sentences and so no run, which is exactly how
   * `segmentFileIndex` numbers them: skipped, never numbered.
   */
  function stepSegmentRuns(sl, step) {
    const segs = notesSegs(sl);
    const texts = step < buildSteps(sl)
      ? [[step, segs[step]]]
      : segs.slice(step).map((t, i) => [step + i, t]);
    const runs = [];
    let at = 0;
    for (const [k, t] of texts) {
      const part = splitSentences(t ?? '');
      if (part.length) runs.push({ seg: k, from: at, count: part.length });
      at += part.length;
    }
    return runs;
  }

  /**
   * Stitch one slide, and every beat within it.
   *
   * Returns BOTH shapes, because they are read by different things and always
   * have been: `wav` is `slide-NN.wav`, which tools/lipsync.mjs, tools/video.mjs
   * and any deck that never opted in all understand, and `segments` is one
   * `slide-NN-KK.wav` per ⟨CLICK⟩ beat, which is what lets the recording pace
   * the builds (PRESENTING). ⇧R already wrote both; this is ⇧V catching up, so
   * that the layout on disk says nothing about which recorder made it.
   *
   * The beat files deliberately differ from their slice of the whole-slide file
   * in two ways. They carry no SEGMENT gap — that silence separates beats, and
   * a beat that begins with it would have the breath before the build rather
   * than after it — and no trailing `data-narration-pause`, which `advanceFrom`
   * honours itself and would otherwise be held twice.
   */
  async function stitchSlideWav(sl, run) {
    const max = buildSteps(sl);
    const index = segmentFileIndex(notesSegs(sl));
    const chunks = [];
    const beats = new Map();   // file number → its own chunk list
    let rate = 24000;
    for (let step = 0; step <= max; step++) {
      const { sentences, segStarts } = stepAudio(sl, step);
      const runs = stepSegmentRuns(sl, step);
      for (let i = 0; i < sentences.length; i++) {
        const clip = await fetchLiveSentence(sl, step, i); // cache-first
        if (run !== recRun) return null;
        if (!clip) continue;
        const buf = await clip.blob.arrayBuffer();
        if (chunks.length === 0) rate = new DataView(buf).getUint32(24, true) || 24000;
        // a folded segment still gets a SEGMENT-sized breath, not a sentence one
        else chunks.push(silencePcm(rate, i === 0 || segStarts.has(i) ? SEG_GAP_S : SENT_GAP_S));
        const pcm = new Uint8Array(buf.slice(44));
        chunks.push(pcm);
        // …and the same audio again, into the beat it belongs to
        const run_ = runs.find((r) => i >= r.from && i < r.from + r.count);
        const file = run_ && index ? index[run_.seg] : null;
        if (file == null) continue;
        let list = beats.get(file);
        if (!list) beats.set(file, list = []);
        if (list.length) list.push(silencePcm(rate, SENT_GAP_S));
        list.push(pcm);
      }
    }
    // …and the slide's own beat, if it asked for one, so a recorded track
    // breathes exactly where the live take it was stitched from does.
    const pause = narrationPause(sl);
    if (chunks.length && pause > 0) chunks.push(silencePcm(rate, pause));
    return {
      wav: chunks.length ? stitchWav(chunks, rate) : null,
      segments: [...beats].map(([file, list]) => ({ file, wav: stitchWav(list, rate) })),
    };
  }
  // Viseme counterpart of stitchSlideWav: the SAME sentences, the SAME
  // silence gaps, so the merged timeline lines up with the stitched WAV.
  // Cache-first through the character's own promise cache — sentences whose
  // visemes the lookahead already fetched are free. Any failure (bridge
  // down) just skips the sidecar; the WAV still records.
  async function stitchSlideVisemes(sl, run) {
    if (character.mode !== 'viseme') return null;
    const max = buildSteps(sl);
    const index = segmentFileIndex(notesSegs(sl));
    const parts = [];
    const beats = new Map();   // file number → its own parts, cut like its WAV
    try {
      for (let step = 0; step <= max; step++) {
        const { sentences, segStarts } = stepAudio(sl, step);
        const runs = stepSegmentRuns(sl, step);
        for (let i = 0; i < sentences.length; i++) {
          const tl = await character.ensureTimeline(
            sentenceKey(sl, step, i), fetchLiveSentence(sl, step, i), sentences[i]);
          if (run !== recRun) return null;
          if (!tl) continue;
          parts.push({ timeline: tl, gap: parts.length ? (i === 0 || segStarts.has(i) ? SEG_GAP_S : SENT_GAP_S) : 0 });
          // …and into the beat's own timeline, gapped exactly as its WAV is:
          // sentence gaps inside a beat, and never the segment gap that
          // separates beats. A sidecar cut differently from the audio it is
          // played against is a sidecar that drifts.
          const own = runs.find((r) => i >= r.from && i < r.from + r.count);
          const file = own && index ? index[own.seg] : null;
          if (file == null) continue;
          let list = beats.get(file);
          if (!list) beats.set(file, list = []);
          list.push({ timeline: tl, gap: list.length ? SENT_GAP_S : 0 });
        }
      }
    } catch {
      debugLog('lipsync', `slide ${sl}: viseme sidecar skipped (bridge unreachable)`);
      return null;
    }
    // the trailing beat too — an empty timeline behind a gap, which
    // concatTimelines renders as a closed mouth for exactly that long. The WAV
    // and the sidecar must agree on every silence or the lip-sync drifts.
    // (Only on the whole-slide timeline: the beat files carry no trailing
    // pause either, for the same reason.)
    const pause = narrationPause(sl);
    if (parts.length && pause > 0) parts.push({ timeline: { cues: [], duration: 0 }, gap: pause });
    return {
      slide: parts.length ? concatTimelines(parts) : null,
      segments: [...beats].map(([file, list]) => ({ file, timeline: concatTimelines(list) })),
    };
  }
  // WHERE A RECORDING LANDS. A finished set of slide-NN.wav is only useful
  // next to the deck: that is the one place `narration.files` can name and the
  // one place `decklight bundle` looks. The browser's download folder is
  // neither, so it is the FALLBACK — for a deck opened from a file:// or served
  // read-only by `decklight present`, where nothing on this machine is allowed
  // to write. In author mode the server that owns the deck file writes them.
  //
  // The folder is the deck's own `narration.files` when that names a plain
  // relative directory, so re-recording refreshes the track already configured
  // rather than seeding a second one; otherwise `voiceover`, the same default
  // tools/voiceover.mjs writes to.
  /**
   * The folders next to the deck that already hold audio.
   *
   * The runtime cannot see the filesystem — that is why `segments: true` is
   * opt-in at all — so it cannot know `voices/rachel` is taken before
   * proposing it. The author server can, and answers once per recorder open.
   */
  async function knownTracks() {
    const base = authorBase();
    if (base == null) return [];
    try {
      const r = await fetch(`${base}/edit/tracks`);
      const j = await r.json();
      return Array.isArray(j?.tracks) ? j.tracks : [];
    } catch { return []; }
  }
  /**
   * What this recorder is about to write, and what the picker will call it.
   *
   * Four rules, in order, and the order is the whole design:
   *
   *  1. `--dir` / `?dir=` — asked for out loud, and nothing outranks that.
   *  2. A folder already recorded with THIS engine and voice. Re-recording a
   *     voice should REFRESH its take, not accumulate `-2`, `-3`, `-4` — and
   *     tools/voiceover.mjs writes engine and voice into each folder's
   *     manifest.json, so the question is answerable rather than guessed.
   *  3. The deck's own single configured folder. A deck that names one place
   *     is a deck that has decided; seeding a second one beside it would be
   *     answering a question nobody asked.
   *  4. `voices/<voice>`, suffixed past anything already there — a NEW voice
   *     gets a new folder, which is what makes four cloned voices, two system
   *     ones and two takes of your own into eight pickable tracks instead of
   *     one folder overwritten eight times.
   */
  function targetFor({ mine }, tracks) {
    const engine = mine ? null : liveEngine;   // adoptBridge keeps this current
    const voice = mine ? null : liveCfg?.voice;
    const who = mine ? { mine: true } : { engine, voice };
    const proposed = proposeTrack(who, tracks.map((t) => t.dir));
    // The "take 2" in a proposed label belongs to a NEW folder that had to step
    // around an existing one. Refreshing that same folder, or writing to one
    // that was asked for by name, is not a second take of anything — so those
    // take the plain label, or the picker grows a row reading "take 2" for the
    // recording that replaced take 1.
    const plain = proposeTrack(who, []).label;
    const at = (dir, why) => ({
      dir,
      label: why === 'new' ? proposed.label : plain,
      why,
      clash: tracks.find((t) => t.dir === dir) ?? null,
    });

    const asked = plainFolder(params?.get?.('dir'));
    if (asked) return at(asked, 'asked');
    if (!mine && voice) {
      const same = tracks.find((t) => t.voice && t.voice === voice && (!t.engine || !engine || t.engine === engine));
      if (same) return at(same.dir, 'refresh');
    }
    const configured = plainFolder(recordDir({ configOnly: true }));
    if (configured) return at(configured, 'configured');
    return at(proposed.dir, 'new');
  }

  const RECORD_DIR = 'voiceover';
  const plainFolder = (d) => (typeof d === 'string' && d
    && !/^[a-z][a-z0-9+.-]*:/i.test(d) && !/^[/\\]/.test(d) && !d.split(/[/\\]/).includes('..')
    ? d : null);
  function recordDir({ configOnly = false } = {}) {
    // `decklight record --dir NAME` opens the deck with ?dir=NAME, which wins:
    // it is the one thing the person recording asked for out loud. Validated
    // here as well as in the command, because a URL is typed by hand too — and
    // the server refuses the same three shapes a third time, which is where it
    // actually matters.
    const asked = plainFolder(params?.get?.('dir'));
    if (asked) return asked;
    const f = config.narration?.files;
    const first = typeof f === 'string' ? f
      : Array.isArray(f) ? f.find((t) => typeof t?.dir === 'string')?.dir : null;
    // a bucket URL and an absolute path are both somewhere the author server
    // will refuse to write, and rightly — fall back rather than fail per slide
    const ok = plainFolder(first);
    // configOnly: "what has this deck DECIDED", with no default standing in
    // for an answer — targetFor needs to tell "no configured folder" from
    // "the fallback one".
    return ok ?? (configOnly ? null : RECORD_DIR);
  }
  /** Write one recorded file, through the author server when there is one.
   *  Resolves true when it landed on disk, false when the browser took it.
   *
   *  `seg` is the 1-based SEGMENT file number (`slide-NN-KK.wav`), null for the
   *  whole-slide file. It is computed here, through `recordPlan`, rather than
   *  by the server: the runtime is the only side that has the notes, and the
   *  server stays what it is — a writer that is told a folder and a number and
   *  builds the name itself, so no request can choose one. */
  async function saveRecording(slide, kind, blob, dir, seg = null) {
    if (dir) {
      try {
        const r = await fetch(`${dir.base}/edit/record?slide=${slide}&kind=${kind}`
          + (seg == null ? '' : `&seg=${seg}`)
          + `&dir=${encodeURIComponent(dir.name)}`, { method: 'POST', body: blob });
        if ((await r.json())?.ok) return true;
      } catch { /* server gone mid-recording — the browser still gets the file */ }
    }
    const name = `slide-${String(slide).padStart(2, '0')}`
      + (seg == null ? '' : `-${String(seg).padStart(2, '0')}`)
      + `.${kind === 'wav' ? 'wav' : 'visemes.json'}`;
    const url = URL.createObjectURL(blob);
    downloadFromUrl(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return false;
  }
  /**
   * The folder this recording goes into — shown, and editable, BEFORE it runs.
   *
   * A track is a folder, so the folder is the only thing distinguishing four
   * cloned voices, two system ones and two takes of your own. It is proposed
   * from the voice rather than typed, because the voice is what tells them
   * apart to the person recording — but it is an input and not a label,
   * because a proposal that cannot be corrected is just a decision made
   * somewhere else.
   */
  function folderRow(target) {
    if (!target) return '';
    // A refresh is not a collision: re-recording the same voice into its own
    // folder is the thing you meant. Only a folder holding SOMEBODY ELSE gets
    // a warning.
    const clash = target.clash && target.why !== 'refresh'
      ? `<div class="rec-line rec-warn">${target.clash.files} file(s) are already in`
        + ` <code>${escapeHtml(target.dir)}/</code>${target.clash.voice ? ` (${escapeHtml(target.clash.voice)})` : ''}`
        + ' and will be replaced.</div>'
      : '';
    return `<div class="rec-line rec-folder"><label>folder
      <input class="rec-dir" value="${escapeHtml(target.dir)}" spellcheck="false"
             aria-label="folder to record into"></label></div>${clash}`;
  }
  function wireFolderRow(card, keep) {
    const input = card?.querySelector('.rec-dir');
    if (!input) return;
    const read = () => {
      const dir = plainFolder(input.value.trim());
      input.classList.toggle('rec-bad', !dir);
      return dir;
    };
    input.addEventListener('input', () => {
      const dir = read();
      if (dir) keep({ dir, label: input.dataset.label || dir, clash: null });
    });
    // Enter in the field starts the recording rather than doing nothing, which
    // is what a single-field card should do
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.stopPropagation(); });
  }

  /**
   * Point the deck's own config at the track just recorded.
   *
   * The recorder writes the files and then used to ask you to paste a line
   * into the deck by hand — the one manual step in a flow that is otherwise a
   * key and an arrow. The author server already owns this file, so it can
   * write this too; Z undoes it like any other edit.
   *
   * A BUTTON, never automatic. Editing someone's deck the moment a recording
   * ends is the wrong default even with undo behind it, and the button is
   * absent exactly where it could not work anyway — no author server means no
   * write, and the card falls back to printing the line.
   */
  async function useRecordedTrack(btn, dir, cfg) {
    const base = authorBase();
    if (base == null) return;
    btn.textContent = 'saving…';
    try {
      const r = await fetch(`${base}/edit/narration`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: dir, ...cfg }),
      });
      const out = await r.json();
      if (!out?.ok) throw new Error(out?.error || `HTTP ${r.status}`);
      btn.textContent = '✓ the deck now plays this track — Z undoes it';
      btn.classList.add('rec-done');
      debugLog('narr', `narration config → ${dir}`);
    } catch (e) {
      // The one case that cannot work is a config built outside the init call.
      // The server says which; repeating it here beats "could not save".
      btn.classList.add('rec-failed');
      btn.textContent = `couldn't write it — ${String(e.message || e)}`;
    }
  }
  /** The done card's offer, when there is a server able to take it. */
  function useTrackRow(dir) {
    return authorBase() == null || !dir ? ''
      : '<div class="narr-row narr-sel rec-use" role="button" tabindex="0">Use this track in the deck</div>';
  }
  /**
   * The card's not-yet-accepted "Use this track" row, or null.
   *
   * Enter on a done card goes HERE first, and only closes when there is
   * nothing left to accept. The old binding closed unconditionally — with a
   * hint that said so — which walked every keyboard user straight past the
   * offer, stranding a finished recording the deck never learns about: N
   * lists only configured tracks, so there is no later door.
   */
  function pendingUseTrack(el) {
    const btn = el?.querySelector('.rec-use');
    return btn && !btn.classList.contains('rec-done') && !btn.classList.contains('rec-failed')
      ? btn : null;
  }
  /** The done-card hint, honest about what Enter does on THIS card. */
  function doneHint(dir) {
    return authorBase() == null || !dir
      ? '<div class="rec-hint">Enter or Esc to close</div>'
      : '<div class="rec-hint">⏎ uses this track in the deck · Esc closes</div>';
  }
  function wireUseTrack(card, dir, cfg) {
    const btn = card?.querySelector('.rec-use');
    if (!btn) return;
    const go = () => useRecordedTrack(btn, dir, cfg);
    btn.addEventListener('click', go);
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  }

  /**
   * Why the files went to the download folder — the half the card never said.
   *
   * "Saved to your downloads" is where, and where is not something you can act
   * on. There is exactly one cause (no author server owns this deck file) and
   * three ways to arrive at it, and which one you are in decides what to do
   * next. The `?record` case is the loud one: that parameter means `decklight
   * record` opened this deck, so a server WAS started — finding none means it
   * is serving a different deck, and the fix is to stop that one.
   */
  function noServerReason() {
    if (params?.has?.('record')) {
      return 'no author server answered, though <code>decklight record</code> started one'
        + ' — something else is holding the port for another deck. Stop it and record again;'
        + ' press D for the log.';
    }
    if (location.protocol === 'file:') {
      return 'this deck was opened from a file, so nothing may write beside it.'
        + ' <code>decklight record deck.html</code> serves it and writes them for you.';
    }
    return 'no author server owns this deck file — <code>decklight record deck.html</code>'
      + ' writes them next to the deck instead.';
  }

  async function startRecording() {
    const list = slidesWithNotes();
    const run = ++recRun;
    const t0 = Date.now();
    let done = 0, saved = 0, toDisk = 0, segmented = false;
    // Awaited, not sampled: authorBase() is null both for "no server" and for
    // "the probe has not answered yet", and reading it early is how a whole
    // take ends up in the download folder for no reason at all.
    await authorReady();
    if (run !== recRun) return;
    // `== null`, never falsy: the author server's prefix is '' when it is the
    // origin serving this deck, which is most of the time.
    const base = authorBase();
    const target = recTarget ?? targetFor({ mine: false }, await knownTracks());
    if (run !== recRun) return;
    const dir = base == null ? null : { base, name: target.dir };
    renderRecordCard('progress', { done, total: list.length, elapsedMs: 0 });
    for (const sl of list) {
      if (run !== recRun) return;
      try {
        const take = await stitchSlideWav(sl, run);
        if (run !== recRun) return; // cancelled mid-synthesis — don't save
        if (take?.wav) {
          if (await saveRecording(sl, 'wav', take.wav, dir)) toDisk++;
          if (run !== recRun) return;
          saved++;
          // …and one file per ⟨CLICK⟩ beat, so a synthesized track paces the
          // builds exactly as a track recorded with ⇧R does. Same layout from
          // both recorders — the files on disk say nothing about which one
          // made them (PRESENTING).
          for (const beat of take.segments) {
            await saveRecording(sl, 'wav', beat.wav, dir, beat.file);
            if (run !== recRun) return;
            segmented = true;
          }
          // character on: the matching viseme sidecar is written too, so the
          // recorded set plays back lip-synced without the bridge
          const tl = await stitchSlideVisemes(sl, run);
          if (run !== recRun) return;
          if (tl?.slide) {
            await saveRecording(sl, 'visemes',
              new Blob([JSON.stringify(tl.slide)], { type: 'application/json' }), dir);
            if (run !== recRun) return;
          }
          // one sidecar per beat, beside the beat's own WAV
          for (const beat of tl?.segments ?? []) {
            await saveRecording(sl, 'visemes',
              new Blob([JSON.stringify(beat.timeline)], { type: 'application/json' }), dir, beat.file);
            if (run !== recRun) return;
          }
        }
      } catch {
        toast(`slide ${sl}: recording failed`);
      }
      done++;
      if (run === recRun) renderRecordCard('progress', { done, total: list.length, elapsedMs: Date.now() - t0 });
    }
    if (run === recRun) {
      renderRecordCard('done', { saved, total: list.length, dir: toDisk ? dir.name : null, segmented, label: target.label });
    }
  }
  function openRecordDialog() {
    if (!narrSet?.live) { toast('live voice only — pick a voice with N first'); return; }
    if (recEl) return;
    recEl = document.createElement('div');
    recEl.className = 'decklight-narr decklight-record';
    recEl.innerHTML = '<div class="narr-card" role="dialog" aria-label="Record offline narration"></div>';
    closeOnBackdrop(recEl, closeRecordDialog);
    root.appendChild(recEl);
    recTarget = null;
    renderRecordCard('confirm', { total: slidesWithNotes().length });
    authorReady()
      .then(() => knownTracks())
      .then((tracks) => {
        if (!recEl || recView !== 'confirm') return;
        recTarget = targetFor({ mine: false }, tracks);
        renderRecordCard('confirm', { total: slidesWithNotes().length, target: recTarget });
      });
  }
  function closeRecordDialog() {
    recRun++; // invalidate any in-flight recording loop
    recEl?.remove();
    recEl = null;
  }


  // ── ⇧R: record YOUR OWN voice, one ⟨CLICK⟩ beat at a time — SPEC PRESENTING ──
  //
  // ⇧V records the deck in a synthesized voice. This records it in yours, and
  // the difference that matters is not the timbre — it is that a human take has
  // no natural boundaries. A TTS run knows where a segment ends because it
  // synthesized it; a person talking does not, and asking them afterwards to
  // split a ten-minute WAV into forty files by ear is how a feature nobody uses
  // gets built.
  //
  // So the deck is the teleprompter and → is the boundary. You read the beat on
  // screen, press → when you finish it, and that keystroke is both the end of
  // one file and the reveal of the next build — the same gesture you will make
  // when you present it, which is exactly why the timing comes out right.
  //
  // Capture is WebAudio → Int16 PCM → the same `stitchWav` ⇧V uses. Not
  // MediaRecorder (webm/opus is a format nothing else in this toolchain reads),
  // and not an AudioWorklet: a worklet's module has to be fetched from a URL,
  // which on a zero-dependency single-file runtime means a blob: URL, and
  // `decklight present` serves `script-src 'self' 'unsafe-inline'` with no
  // blob:. A ScriptProcessorNode is deprecated and universally shipped, and
  // works under that policy today.
  let micEl = null, micView = 'intro', micRun = 0, micTarget = null;
  let micCtx = null, micStream = null, micNode = null, micSource = null;
  let micChunks = null;      // the beat being captured, or null between beats
  let micTake = null;        // the beat just finished
  let micPeak = 0, micMeter = null;
  let micEnd = null;         // resolves the beat: 'next' | 'retake' | 'stop'

  /** Why this browser cannot record, in the words of the thing to do about it. */
  function micUnavailable() {
    if (navigator.mediaDevices?.getUserMedia) return null;
    // The one confusing case, so it gets a sentence rather than a failure: a
    // deck opened straight off disk is not a secure context anywhere that
    // matters, and no amount of clicking Allow will change that. `decklight
    // record` exists to put the same file on http://127.0.0.1, which is one.
    if (location.protocol === 'file:') {
      return 'a browser will not open a microphone for a page loaded from a file.'
        + ' Serve the deck instead — <code>decklight record ' + escapeHtml(deckFileName()) + '</code>'
        + ' — and this works: 127.0.0.1 is a secure context, file:// is not.';
    }
    return 'this browser exposes no microphone (getUserMedia needs a secure context —'
      + ' http://127.0.0.1 or https://)';
  }
  const deckFileName = () => decodeURIComponent(location.pathname.split('/').pop() || 'deck.html');

  /** What went wrong when the browser refused, in the presenter's words. */
  function micWhy(e) {
    const n = e?.name ?? '';
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return 'the microphone was blocked. Allow it for this page (the ⚙ or 🎤 in the address bar), then press ⇧R again.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') {
      return 'no microphone was found. Plug one in, or pick one as the system input, then press ⇧R again.';
    }
    if (n === 'NotReadableError') {
      return 'the microphone is busy — another app (a call, a recorder) is holding it. Close it and press ⇧R again.';
    }
    return `the microphone could not be opened (${escapeHtml(String(e?.message || n || e))}).`;
  }

  // 24 kHz mono, matching every engine's output — a WAV lipsync.mjs and
  // video.mjs already read, at ~2.8 MB a minute rather than 5.8. Asked of the
  // AudioContext rather than decimated by hand: the browser resamples properly,
  // and naive decimation aliases everything above 12 kHz down into the voice.
  const MIC_RATE = 24000;
  async function openMic() {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    // A browser that will not give the rate asked for gives its own; the WAV
    // header records whatever came back, so both cases are correct files.
    try { micCtx = new Ctx({ sampleRate: MIC_RATE }); } catch { micCtx = new Ctx(); }
    micSource = micCtx.createMediaStreamSource(micStream);
    micNode = micCtx.createScriptProcessor(4096, 1, 1);
    micNode.onaudioprocess = (e) => {
      const buf = e.inputBuffer.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
      micPeak = Math.max(micPeak, peak);
      if (micChunks) micChunks.push(floatToPcm16(buf));
    };
    // A ScriptProcessorNode is only pulled when it reaches the destination —
    // and reaching it directly would put the microphone into the speakers,
    // which is a feedback loop and a ruined take. Zero gain: connected, silent.
    const mute = micCtx.createGain();
    mute.gain.value = 0;
    micSource.connect(micNode);
    micNode.connect(mute);
    mute.connect(micCtx.destination);
    if (micCtx.state === 'suspended') await micCtx.resume();
    debugLog('narr', `mic open at ${micCtx.sampleRate} Hz`);
  }
  function closeMic() {
    try { micNode?.disconnect(); micSource?.disconnect(); } catch { /* already gone */ }
    if (micNode) micNode.onaudioprocess = null;
    micStream?.getTracks().forEach((t) => t.stop());
    micCtx?.close?.();
    micCtx = micStream = micNode = micSource = null;
    micChunks = null;
    clearInterval(micMeter);
    micMeter = null;
  }

  /** Capture until the presenter says the beat is over. */
  function captureBeat() {
    micChunks = [];
    micPeak = 0;
    return new Promise((done) => { micEnd = done; });
  }
  /** The keys that end a beat, called from the overlay handler below. */
  function endBeat(how) {
    if (!micEnd) return;
    micTake = micChunks ?? [];
    micChunks = null;
    const done = micEnd;
    micEnd = null;
    done(how);
  }

  function micBar(level) {
    const pct = Math.min(100, Math.round(level * 140));   // headroom, not a VU
    const hot = level > 0.95;
    return `<div class="rec-level${hot ? ' hot' : ''}"><div class="rec-level-fill" style="width:${pct}%"></div></div>`;
  }
  function renderMicCard(view, data = {}) {
    micView = view;
    const card = micEl?.querySelector('.narr-card');
    if (!card) return;
    if (view === 'intro') {
      const { slides, beats, why } = data;
      if (why) {
        card.innerHTML = `<div class="narr-head">record your voice</div>
          <div class="rec-line">${why}</div>
          <div class="rec-hint">Esc to close</div>`;
        return;
      }
      const { range, warn } = data;
      card.innerHTML = `<div class="narr-head">record your voice</div>
        <div class="rec-line">${slides} slide${slides === 1 ? '' : 's'} · ${beats} beat${beats === 1 ? '' : 's'} — the deck reads you the notes, one ⟨CLICK⟩ at a time${
  range ? ` <strong>(slides ${escapeHtml(range)} only — everything else is left alone)</strong>` : ''}</div>
        ${beats === 0
    ? `<div class="rec-line rec-warn">Nothing to record${range ? ` in slides ${escapeHtml(range)}` : ''} — no slide there has notes to read.</div>`
    : '<div class="rec-line">Press <kbd>→</kbd> when you finish a beat: it ends the file <em>and</em> reveals the next build, so your voice paces the deck exactly as it will on the night.</div>'}
        ${folderRow(data.target)}
        ${warn ? `<div class="rec-line rec-warn">${warn}</div>` : ''}
        ${beats === 0 ? '' : '<div class="narr-row narr-sel">Start recording</div>'}
        <div class="rec-hint">${beats === 0 ? 'Esc to close' : 'Enter to start · Esc to cancel'}</div>`;
      wireFolderRow(card, (t) => { micTarget = t; });
      card.querySelector('.narr-row')?.addEventListener('click', () => startMicRecording());
      return;
    }
    if (view === 'capture') {
      const { sl, nth, slides, beat, i, of, note } = data;
      card.innerHTML = `<div class="narr-head">recording · slide ${nth} of ${slides}</div>
        <div class="rec-line rec-where">slide ${sl} · beat ${i + 1} of ${of}</div>
        <div class="rec-read">${escapeHtml(beat.text)}</div>
        ${note ? `<div class="rec-line rec-note">${note}</div>` : ''}
        ${micBar(0)}
        <div class="rec-hint"><kbd>→</kbd> next beat · <kbd>⌫</kbd> retake this one · <kbd>Esc</kbd> stop</div>`;
      return;
    }
    if (view === 'saving') {
      card.innerHTML = `<div class="narr-head">saving slide ${data.sl}…</div>
        <div class="rec-line">${data.files} file${data.files === 1 ? '' : 's'}</div>`;
      return;
    }
    const { slides, files, dir, segmented, stopped } = data;
    const where = dir
      ? `saved to <code>${escapeHtml(dir)}/</code>, next to the deck`
      : `saved to your downloads — ${noServerReason()}`;
    const cfg = `narration: { files: '${escapeHtml(dir ?? 'voiceover')}', ext: 'wav'${segmented ? ', segments: true' : ''} }`;
    card.innerHTML = `<div class="narr-head">${stopped ? 'recording stopped' : 'recording done'}</div>
      <div class="rec-line">${slides} slide${slides === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'} ${where}</div>
      <div class="rec-line">Play it back with <code>${cfg}</code>${segmented
        ? ' — <strong>segments</strong> is what makes your voice step the builds.'
        : '.'}</div>
      ${useTrackRow(dir)}
      ${doneHint(dir)}`;
    wireUseTrack(card, dir, { ext: 'wav', label: data.label, ...(segmented ? { segments: true } : {}) });
  }

  async function startMicRecording() {
    const run = ++micRun;
    const list = slidesWithNotes();
    await authorReady();          // see startRecording — never sampled early
    if (run !== micRun) return;
    const base = authorBase();
    const target = micTarget ?? targetFor({ mine: true }, await knownTracks());
    if (run !== micRun) return;
    const dir = base == null ? null : { base, name: target.dir };
    let slidesDone = 0, files = 0, toDisk = 0, segmented = false, stopped = false;
    // The recorded track must not play over the take, and P must not be
    // holding a chain that resumes into the middle of one.
    if (narrating) toggleNarration();
    try {
      await openMic();
    } catch (e) {
      renderMicCard('intro', { why: micWhy(e) });
      return;
    }
    // The meter is the answer to "is it even hearing me" BEFORE twenty slides
    // are recorded silent. Decays on its own so a peak reads as a peak.
    micMeter = setInterval(() => {
      const fill = micEl?.querySelector('.rec-level-fill');
      const box = micEl?.querySelector('.rec-level');
      if (!fill) return;
      fill.style.width = `${Math.min(100, Math.round(micPeak * 140))}%`;
      box.classList.toggle('hot', micPeak > 0.95);
      micPeak *= 0.7;
    }, 100);

    outer: for (const sl of list) {
      if (run !== micRun) return;
      const plan = recordPlan(notesSegs(sl), buildSteps(sl));
      if (!plan.length) continue;
      // Said HERE, where it can still be acted on: a slide with builds and no
      // ⟨CLICK⟩ in its notes is recorded as one take, so its builds will not be
      // paced by anything. That is an authoring gap, and the moment you are
      // reading the slide's notes aloud is the moment to learn about it.
      const note = plan.length === 1 && buildSteps(sl) > 0
        ? `this slide has ${buildSteps(sl)} build${buildSteps(sl) === 1 ? '' : 's'} but no ⟨CLICK⟩ in its notes`
          + ' — one take for the whole slide; add ⟨CLICK⟩ between the beats to pace them'
        : null;
      const takes = [];
      for (let i = 0; i < plan.length; i++) {
        const beat = plan[i];
        instance.goto(sl, beat.step);
        renderMicCard('capture', { sl, nth: slidesDone + 1, slides: list.length, beat, i, of: plan.length, note });
        const how = await captureBeat();
        if (run !== micRun) return;
        if (how === 'stop') { stopped = true; break outer; }
        if (how === 'retake') { i--; continue; }   // the for's i++ returns to the same beat
        takes.push({ file: beat.file, pcm: micTake });
      }
      if (!takes.length) continue;
      renderMicCard('saving', { sl, files: takes.length + 1 });
      const rate = micCtx?.sampleRate ?? MIC_RATE;
      // The whole-slide file, for every reader that predates segments:
      // tools/lipsync.mjs, tools/video.mjs, and a deck that never opts in.
      //
      // The takes are joined BACK TO BACK, with none of stitchSlideWav's
      // synthetic gaps — a synthesized clip stops the instant the sentence
      // does and needs a breath added, while a human take already contains
      // every pause the person took. Adding 0.35s to each would only make the
      // whole-slide file drag exactly where the segmented one does not.
      const chunks = takes.flatMap((t) => t.pcm);
      const pause = narrationPause(sl);
      if (chunks.length && pause > 0) chunks.push(silencePcm(rate, pause));
      if (await saveRecording(sl, 'wav', stitchWav(chunks, rate), dir)) toDisk++;
      files++;
      if (run !== micRun) return;
      // …and one file per beat, which is what lets the recording step the
      // builds. Never carrying the slide's trailing pause: `advanceFrom`
      // honours `data-narration-pause` itself, and a beat baked into the audio
      // as well would be held twice.
      for (const t of takes) {
        if (t.file == null) continue;
        await saveRecording(sl, 'wav', stitchWav(t.pcm, rate), dir, t.file);
        if (run !== micRun) return;
        files++;
        segmented = true;
      }
      slidesDone++;
    }
    closeMic();
    if (run !== micRun) return;
    renderMicCard('done', { slides: slidesDone, files, dir: toDisk ? dir.name : null, segmented, stopped, label: target.label });
  }

  function openMicRecorder() {
    if (micEl) return;
    micEl = document.createElement('div');
    micEl.className = 'decklight-narr decklight-record decklight-mic';
    micEl.innerHTML = '<div class="narr-card" role="dialog" aria-label="Record your voice"></div>';
    closeOnBackdrop(micEl, closeMicRecorder);
    root.appendChild(micEl);
    const why = micUnavailable();
    const list = slidesWithNotes();
    const beats = list.reduce((n, sl) => n + recordPlan(notesSegs(sl), buildSteps(sl)).length, 0);
    const range = params?.get?.('slides');
    micTarget = null;
    renderMicCard('intro', why ? { why } : { slides: list.length, beats, range });
    if (why) return;
    // ONE deferred render, not two: the target and the no-server warning both
    // arrive after the probe, and two independent re-renders meant whichever
    // landed second erased the other.
    authorReady()
      .then(() => knownTracks())
      .then((tracks) => {
        if (!micEl || micView !== 'intro') return;
        micTarget = authorBase() == null ? null : targetFor({ mine: true }, tracks);
        renderMicCard('intro', {
          slides: list.length,
          beats,
          range,
          target: micTarget,
          warn: authorBase() == null ? noServerReason() : null,
        });
      });
    // Where the files will land, said BEFORE the first beat rather than after
    // the last. A take that was going somewhere unexpected is worth eight
    // seconds of warning and is not worth eight beats of reading.

  }
  function closeMicRecorder() {
    micRun++;                  // invalidate any loop in flight
    endBeat('stop');           // …and unblock it, so its finally runs
    closeMic();
    micEl?.remove();
    micEl = null;
  }
  overlays.register({
    isOpen: () => !!micEl,
    close: closeMicRecorder,
    keydown(e) {
      if (micView === 'capture') {
        // → / Enter / ⎵ all end the beat. Space is the universal advance key
        // in a presentation, and binding it to "discard that take" is a trap
        // you spring once and remember forever — retake is ⌫, which reads as
        // taking it back.
        if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ' || e.key === 'PageDown') endBeat('next');
        else if (e.key === 'Backspace') endBeat('retake');
        else if (e.key === 'Escape') closeMicRecorder();
        else return false;
        return true;
      }
      if (e.key === 'Escape') closeMicRecorder();
      else if (e.key === 'Enter') {
        if (micView === 'intro' && !micUnavailable() && micEl?.querySelector('.narr-row')) startMicRecording();
        else if (pendingUseTrack(micEl)) pendingUseTrack(micEl).click();
        else if (micView !== 'saving') closeMicRecorder();
      } else return false;
      return true;
    },
  });

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
        else if (pendingUseTrack(recEl)) pendingUseTrack(recEl).click();
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
        case 'ArrowDown': selectNarrRow(narrSel + 1, { scroll: true }); break;
        case 'ArrowUp': selectNarrRow(narrSel - 1, { scroll: true }); break;
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
    openMicRecorder,
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
