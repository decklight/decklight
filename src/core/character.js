// Animated lip-synced character — SPEC §8. An overlay in a stage corner
// whose mouth follows the narration. Two render modes behind one controller:
//
//   viseme — a layered 2D character ([data-mouth] groups, character-art.js by
//            default). Timelines come from the lipsync bridge (`decklight
//            lipsync` → Rhubarb) per SENTENCE in live mode, or from
//            slide-NN.visemes.json (tools/lipsync.mjs) in recorded mode. A
//            30 Hz sync loop maps narrAudio.currentTime → the active cue, so
//            pause (P) and voice speed (< >) need no extra wiring. (An
//            interval, not rAF: cues are ~100 ms apart so 30 Hz is visually
//            identical, and it keeps ticking in hidden tabs and under
//            headless virtual time, where rAF stalls.)
//   video  — a muted talking-head <video> (Wav2Lip/SadTalker behind the same
//            bridge; slide-NN.mp4 in recorded mode). Audio ALWAYS comes from
//            narrAudio — muted video is immune to autoplay policy — and the
//            loop nudges video.currentTime whenever it drifts past 150 ms.
//
// Live-mode prefetch rides the engine's existing 10-sentence lookahead: the
// buffer worker calls prefetchSentence() with the sentence's audio promise,
// so lip-sync data is warmed by the same window/workers/cancellation as the
// audio itself. Caches hold PROMISES keyed like liveCache (failures
// self-evict), so play and prefetch share one request.
//
// Degradation: if the bridge is down or a timeline hasn't landed when the
// sentence starts, fall back per config — 'amplitude' (default) drives a
// coarse 4-shape mouth from a WebAudio analyser, 'hide' shows the idle face.
// Audio playback NEVER waits on lip-sync.

import { DEFAULT_CHARACTER_SVG, VISEMES } from './character-art.js';

// ── pure core (unit-tested; no DOM) ─────────────────────────────────────────

// The mouth shape at time t: the last cue with cue.t <= t. Outside the
// timeline (before the first cue, past duration) the mouth rests at X.
export function cueAt(timeline, t) {
  const cues = timeline?.cues;
  if (!cues?.length || !(t >= 0)) return 'X';
  if (timeline.duration && t >= timeline.duration) return 'X';
  let lo = 0, hi = cues.length - 1, hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].t <= t) { hit = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (hit < 0) return 'X';
  const v = cues[hit].v;
  return VISEMES.includes(v) ? v : 'X';
}

// Concatenate per-sentence timelines into one slide timeline — the viseme
// counterpart of the ⇧V WAV stitcher, using the SAME gap values so the JSON
// lines up with the stitched audio sample-for-sample. parts:
// [{ timeline, gap }] with gap = silence seconds BEFORE the part.
export function concatTimelines(parts) {
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const cues = [];
  const push = (t, v) => {
    if (cues.length && cues[cues.length - 1].v === v) return;
    cues.push({ t: r3(t), v });
  };
  let t = 0;
  for (const { timeline, gap = 0 } of parts) {
    if (gap > 0) { push(t, 'X'); t += gap; }
    for (const c of timeline?.cues ?? []) push(t + c.t, c.v);
    t += timeline?.duration ?? 0;
  }
  return { v: 1, kind: 'visemes', duration: r3(t), source: 'stitch', cues };
}

// ── controller ──────────────────────────────────────────────────────────────

export function createCharacter({ root, config, debugLog, toast }) {
  const cfg = config.narration?.character ?? {};
  const BRIDGE = cfg.bridgeUrl ?? 'http://127.0.0.1:8789';
  const FALLBACK = cfg.fallback ?? 'amplitude';
  const storeKey = 'decklight-character:' + location.pathname;

  let mode = cfg.mode ?? 'off';           // 'off' | 'viseme' | 'video'
  let engine = cfg.engine ?? 'wav2lip';   // video-mode synth engine
  let portrait = cfg.portrait ?? 'default';
  try {
    const s = JSON.parse(localStorage.getItem(storeKey));
    if (s?.mode) { mode = s.mode; engine = s.engine ?? engine; portrait = s.portrait ?? portrait; }
  } catch { /* ignore */ }

  let el = null, videoEl = null, artMode = null;
  let audioEl = null;
  let timeline = null;    // active viseme timeline for the playing clip
  let currentKey = null;  // guards late async results against navigation
  let lastV = null, timer = 0, warned = false;
  let bridgeInfo;         // last /ping result (undefined = never probed)

  // promise caches, one entry per sentence — same self-evicting idiom as the
  // engine's liveCache so prefetch and playback share a single request
  const visemeCache = new Map();
  const videoCache = new Map();
  const videoKey = (key) => `${key}|${engine}|${portrait}`;

  function persist() {
    try { localStorage.setItem(storeKey, JSON.stringify({ mode, engine, portrait })); } catch { /* ignore */ }
  }
  function warnOnce() {
    if (warned) return;
    warned = true;
    toast('lipsync bridge unreachable — run: decklight lipsync');
    debugLog('lipsync', 'bridge unreachable — amplitude fallback');
  }

  // ── overlay DOM ──────────────────────────────────────────────────────────
  function mount() {
    if (!el) {
      el = document.createElement('div');
      el.className = 'decklight-character pos-' + (cfg.position ?? 'br');
      el.setAttribute('aria-hidden', 'true');
      if (cfg.size) el.style.setProperty('--character-size', cfg.size + 'px');
      root.appendChild(el);
    }
    if (artMode === mode) return;
    artMode = mode;
    el.classList.toggle('mode-video', mode === 'video');
    videoEl = null;
    if (mode === 'video') {
      el.innerHTML = '';
      videoEl = document.createElement('video');
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.preload = 'auto';
      el.appendChild(videoEl);
    } else if (cfg.sprites) {
      el.innerHTML = '';
      for (const v of VISEMES) {
        if (!cfg.sprites[v]) continue;
        const img = document.createElement('img');
        img.src = cfg.sprites[v];
        img.setAttribute('data-mouth', v);
        img.alt = '';
        el.appendChild(img);
      }
    } else if (typeof cfg.svg === 'string' && cfg.svg.startsWith('#')) {
      el.innerHTML = '';
      const src = document.querySelector(cfg.svg);
      if (src) el.appendChild(src.cloneNode(true));
    } else if (typeof cfg.svg === 'string' && /^\s*</.test(cfg.svg)) {
      el.innerHTML = cfg.svg;
    } else if (cfg.svg) {
      el.innerHTML = DEFAULT_CHARACTER_SVG; // placeholder while the URL loads
      fetch(cfg.svg).then((r) => r.text()).then((t) => { if (el && artMode === 'viseme') el.innerHTML = t; }).catch(() => { /* keep default */ });
    } else {
      el.innerHTML = DEFAULT_CHARACTER_SVG;
    }
  }
  function show() {
    mount();
    el.classList.add('show');
    if (!timer) timer = setInterval(tick, 33);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = 0; }
    el?.classList.remove('show');
    videoEl?.pause();
    timeline = null;
    currentKey = null;
    setViseme('X');
  }
  function setViseme(v) {
    if (v === lastV || !el) return;
    lastV = v;
    el.setAttribute('data-viseme', v);
  }

  // ── amplitude fallback (bridge down / timeline late) ─────────────────────
  // A MediaElementSourceNode permanently reroutes the element through the
  // AudioContext, so it is created at most once and always reconnected to
  // the destination. On some file:// setups the analyser reads zeros (CORS
  // taint) — then the mouth just rests, which is the fallback's fallback.
  let audioCtx = null, analyser = null, tapped = null, ampBuf = null;
  function ensureAnalyser() {
    if (FALLBACK !== 'amplitude' || !audioEl) return false;
    if (tapped === audioEl) return !!analyser;
    tapped = audioEl;
    try {
      audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaElementSource(audioEl);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      analyser.connect(audioCtx.destination);
      ampBuf = new Uint8Array(analyser.fftSize);
    } catch { analyser = null; }
    return !!analyser;
  }
  function amplitudeViseme() {
    analyser.getByteTimeDomainData(ampBuf);
    let sum = 0;
    for (let i = 0; i < ampBuf.length; i++) { const d = (ampBuf[i] - 128) / 128; sum += d * d; }
    const rms = Math.sqrt(sum / ampBuf.length);
    return rms < 0.02 ? 'X' : rms < 0.06 ? 'B' : rms < 0.12 ? 'C' : 'D';
  }

  // ── sync loop ────────────────────────────────────────────────────────────
  function tick() {
    if (!el?.classList.contains('show')) return;
    if (mode === 'video') {
      if (videoEl && audioEl && videoEl.readyState >= 2 && !audioEl.paused
          && Math.abs(videoEl.currentTime - audioEl.currentTime) > 0.15) {
        videoEl.currentTime = audioEl.currentTime;
      }
      return;
    }
    if (!audioEl || audioEl.paused || audioEl.ended) { setViseme('X'); return; }
    if (timeline) setViseme(cueAt(timeline, audioEl.currentTime));
    else if (FALLBACK === 'hide') setViseme('X');
    else if (ensureAnalyser()) setViseme(amplitudeViseme());
    else setViseme('X');
  }

  // ── data fetch (bridge) ──────────────────────────────────────────────────
  function ensureTimeline(key, clipPromise, text) {
    if (!visemeCache.has(key)) {
      const p = (async () => {
        const clip = await clipPromise;
        if (!clip) return null;
        const t0 = Date.now();
        const res = await fetch(`${BRIDGE}/viseme?text=${encodeURIComponent(text ?? '')}`, {
          method: 'POST',
          headers: { 'content-type': 'audio/wav' },
          body: clip.blob,
        });
        if (!res.ok) throw new Error(String(res.status));
        const tl = await res.json();
        debugLog('lipsync', `visemes ${key} · ${tl.cues?.length ?? 0} cues → ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return tl;
      })();
      p.catch(() => { if (visemeCache.get(key) === p) visemeCache.delete(key); });
      visemeCache.set(key, p);
    }
    return visemeCache.get(key);
  }
  function ensureVideo(key, clipPromise) {
    const k = videoKey(key);
    if (!videoCache.has(k)) {
      const p = (async () => {
        const clip = await clipPromise;
        if (!clip) return null;
        const t0 = Date.now();
        const res = await fetch(`${BRIDGE}/video?engine=${engine}&portrait=${encodeURIComponent(portrait)}`, {
          method: 'POST',
          headers: { 'content-type': 'audio/wav' },
          body: clip.blob,
        });
        if (!res.ok) throw new Error(String(res.status));
        const blob = await res.blob();
        const cached = res.headers?.get?.('x-lipsync-cached') === '1';
        debugLog('lipsync', `video ${key} · ${engine} → ${((Date.now() - t0) / 1000).toFixed(1)}s${cached ? ' (cached)' : ''}`);
        return URL.createObjectURL(blob);
      })();
      p.catch(() => { if (videoCache.get(k) === p) videoCache.delete(k); });
      videoCache.set(k, p);
    }
    return videoCache.get(k);
  }

  // ── engine hooks ─────────────────────────────────────────────────────────
  // Lookahead: called by the engine's buffer worker for each sentence it has
  // synthesized — warms the matching lip-sync data through the same window.
  function prefetchSentence(key, clipPromise, text) {
    if (mode === 'viseme') ensureTimeline(key, clipPromise, text).catch(() => { /* play falls back */ });
    else if (mode === 'video') ensureVideo(key, clipPromise).catch(() => { /* play falls back */ });
  }
  // A live sentence is about to play. NEVER awaited by the caller: if the
  // data isn't here yet it lands mid-sentence (viseme) or snaps into sync via
  // drift correction (video); meanwhile the fallback animates.
  function beginSentence(key, clip, text) {
    if (mode === 'off') return;
    show();
    currentKey = key;
    if (mode === 'viseme') {
      timeline = null;
      ensureTimeline(key, Promise.resolve(clip), text)
        .then((tl) => { if (currentKey === key) timeline = tl; })
        .catch(() => warnOnce());
    } else {
      ensureVideo(key, Promise.resolve(clip))
        .then((url) => {
          if (currentKey !== key || !url || !videoEl) return;
          videoEl.src = url;
          videoEl.playbackRate = audioEl?.playbackRate ?? 1;
          if (audioEl && !audioEl.paused) {
            videoEl.currentTime = audioEl.currentTime;
            videoEl.play().catch(() => { /* muted video — should not happen */ });
          }
        })
        .catch(() => warnOnce());
    }
  }
  // A recorded per-slide file started (playSlideFile). Sidecar data comes
  // from tools/lipsync.mjs: slide-NN.visemes.json / slide-NN.mp4 in the same
  // dir. Viseme JSON prefers an inline <script data-decklight-visemes>
  // block (written by `decklight bundle`) — fetch() is blocked on file://.
  function beginSlide(set, slideNo) {
    if (mode === 'off' || !set || set.live) return;
    show();
    const nn = String(slideNo).padStart(2, '0');
    const key = `file|${set.dir}|${nn}`;
    currentKey = key;
    if (mode === 'viseme') {
      timeline = null;
      (async () => {
        const inline = document.querySelector(`script[data-decklight-visemes="slide-${nn}"]`);
        if (inline) return JSON.parse(inline.textContent);
        const res = await fetch(`${set.dir}/slide-${nn}.visemes.json`);
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })()
        .then((tl) => { if (currentKey === key) timeline = tl; })
        .catch(() => { /* no sidecar for this slide — fallback animates */ });
    } else if (videoEl) {
      videoEl.src = `${set.dir}/slide-${nn}.mp4`;
      videoEl.playbackRate = audioEl?.playbackRate ?? 1;
      videoEl.play().catch(() => { /* no file — poster frame stays */ });
    }
  }
  // Wire the (single) narration Audio element: video mirrors its transport.
  function attachAudio(a) {
    if (!a || audioEl === a) return;
    audioEl = a;
    a.addEventListener('pause', () => { if (mode === 'video') videoEl?.pause(); });
    a.addEventListener('play', () => {
      if (mode === 'video' && videoEl?.src) videoEl.play().catch(() => { /* muted */ });
    });
    a.addEventListener('ratechange', () => { if (videoEl) videoEl.playbackRate = a.playbackRate; });
  }
  async function probe() {
    try {
      const r = await fetch(BRIDGE + '/ping');
      bridgeInfo = r.ok ? await r.json() : null;
    } catch { bridgeInfo = null; }
    return bridgeInfo;
  }
  function setMode(m, opts = {}) {
    mode = m;
    if (opts.engine) engine = opts.engine;
    if (opts.portrait) portrait = opts.portrait;
    persist();
    if (mode === 'off') stop();
    else { warned = false; mount(); }
    debugLog('lipsync', mode === 'off' ? 'character off'
      : `character ${mode}${mode === 'video' ? ` · ${engine} · ${portrait}` : ''}`);
  }

  return {
    get mode() { return mode; },
    get engine() { return engine; },
    get portrait() { return portrait; },
    get bridgeInfo() { return bridgeInfo; },
    setMode, prefetchSentence, beginSentence, beginSlide,
    attachAudio, stop, probe, ensureTimeline,
  };
}
