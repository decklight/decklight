/**
 * Decklight terminal player (SPEC §7.3).
 *
 * <div class="terminal" data-cast="casts/demo.cast.json"
 *      data-mode="step|play" data-type-speed="5" data-max-step="2.5"
 *      data-title="Terminal" data-rows="24"></div>
 *
 * step mode (default): registers a Build Provider — each advance types the
 * next command (jittered keystrokes) then streams its recorded output with
 * pacing compressed to ≤ data-max-step seconds. apply(i) is idempotent for
 * any i (deep links, reverse navigation, print).
 *
 * data-type-speed picks the typing speed on a 1 (slow) … 10 (fast) scale;
 * 5 is the default pace. The ⌨ titlebar button cycles it live, persisted
 * per deck (the presenter's choice wins over the authored attribute).
 *
 * The A titlebar button cycles the terminal's font size (75% … 160% of the
 * inherited size), persisted per page — present in both modes.
 *
 * play mode: timeline playback with play/pause, speed cycling, restart.
 */

import { AnsiScreen, spansToHtml, escapeHtml } from './ansi.mjs';

const DEFAULT_VISIBLE_ROWS = 24;

// typing-speed scale → rate multiplier: 1 → ⅓×, 5 → 1× (classic), 10 → 4×
const TYPE_SPEED_KEY = 'decklight-term-typespeed:' + location.pathname;
const clampScale = (n) => Math.max(1, Math.min(10, n));
const typeRate = (s) => 2 ** ((s - 5) / 2.5);

// font-size steps for the A titlebar button, in em so they scale whatever
// base size the page gives the terminal; 1 is "as authored"
const TERM_FONT_KEY = 'decklight-term-fontsize:' + location.pathname;
const FONT_STEPS = [0.75, 0.9, 1, 1.15, 1.35, 1.6];

// Subtle synthesized key sounds while commands type — no audio asset. The
// anatomy comes from dissecting a reference recording strike by strike
// (106 transients): every keystroke is a short bright contact CLICK
// (bandpass+lowpass noise burst, dead within ~10ms) over a quiet low case
// THUMP that blooms a few ms later and rings ~40ms at about a quarter of
// the strike's peak, with a spectral hollow between them (120Hz-1.2kHz).
// A lighter, brighter click follows 35-80ms later: the key RELEASE, which
// real typing always has. Amplitude spreads ~4x strike to strike (soft
// graze vs firm bottom-out); the spacebar is deeper and reliably louder.
// The shared AudioContext resumes on the first (gesture-driven) advance;
// data-type-sound="off" opts a terminal out.
// The three voicings differ in click band and click:thump balance:
// thocky = dark click, biggest thump, longest ring (wooden);
// creamy = mid-bright click, felted thump, tight damping (the reference);
// clacky = high thin snap, minimal thump, fastest decay.
const KEY_PROFILES = {
  thocky: { click: 0.22, clickF: [800, 1500], clickQ: 0.9, lp: 2400, clickDecay: [0.009, 0.014], thump: 0.011, thumpF: [55, 95], ring: [0.075, 0.110] },
  creamy: { click: 0.30, clickF: [1400, 2850], clickQ: 0.95, lp: 3800, clickDecay: [0.007, 0.011], thump: 0.0056, thumpF: [60, 110], ring: [0.065, 0.095] },
  clacky: { click: 0.34, clickF: [2300, 3900], clickQ: 1.1, lp: 6800, clickDecay: [0.005, 0.008], thump: 0.003, thumpF: [90, 140], ring: [0.035, 0.055] },
};

let keyCtx = null;
let keyNoise = null;
function keyClick(ch = '', profile = 'creamy') {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    keyCtx ??= new AC();
    if (keyCtx.state === 'suspended') keyCtx.resume();
    if (!keyNoise) {
      const len = Math.floor(keyCtx.sampleRate * 0.06);
      keyNoise = keyCtx.createBuffer(1, len, keyCtx.sampleRate);
      const d = keyNoise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const P = KEY_PROFILES[profile] ?? KEY_PROFILES.creamy;
    const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
    const t = keyCtx.currentTime;
    const space = ch === ' ';
    const amp = rnd(0.45, 1.3) * (space ? 1.25 : 1);
    const fc = rnd(...P.clickF) * (space ? 0.8 : 1);
    const click = (at, gain, f, decay) => {
      const src = keyCtx.createBufferSource();
      src.buffer = keyNoise;
      const bp = keyCtx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = P.clickQ;
      const lo = keyCtx.createBiquadFilter();
      lo.type = 'lowpass'; lo.frequency.value = P.lp;
      const g = keyCtx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(gain, at + 0.0007);
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      src.connect(bp); bp.connect(lo); lo.connect(g); g.connect(keyCtx.destination);
      src.start(at); src.stop(at + decay + 0.01);
    };
    const thump = (at, gain, f0, ring) => {
      const osc = keyCtx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0, at);
      osc.frequency.exponentialRampToValueAtTime(f0 * 0.6, at + ring * 0.6);
      const g = keyCtx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(gain, at + rnd(0.003, 0.011));  // blooms after the click
      g.gain.exponentialRampToValueAtTime(gain * 0.25, at + ring);        // resonant ring…
      g.gain.exponentialRampToValueAtTime(0.0001, at + ring * 2);         // …then gone
      osc.connect(g); g.connect(keyCtx.destination);
      osc.start(at); osc.stop(at + ring * 2 + 0.01);
    };
    // key-down…
    click(t, P.click * amp, fc, rnd(...P.clickDecay) * (space ? 1.15 : 1));
    thump(t, P.thump * amp * (space ? 1.6 : 1), rnd(...P.thumpF) * (space ? 0.85 : 1), rnd(...P.ring));
    // …and key-up: lighter, brighter, no finger mass behind it
    const up = t + rnd(0.035, 0.08);
    click(up, P.click * amp * rnd(0.35, 0.55), fc * 1.15, rnd(...P.clickDecay) * 0.8);
    thump(up, P.thump * amp * 0.25, rnd(...P.thumpF), rnd(...P.ring) * 0.6);
  } catch { /* no audio in this environment */ }
}

/**
 * Scan `root` for terminal elements, load their casts, build DOM, and (in
 * step mode) register build providers on `Decklight`. Returns a Promise that
 * resolves when every cast is loaded and registered — the core engine awaits
 * this during init so provider counts are known before the first layout.
 */
export function registerTerminals(Decklight, root = document) {
  const els = [...root.querySelectorAll('.terminal[data-cast], .terminal[data-cast-inline]')];
  return Promise.all(els.map(el => setupTerminal(el, Decklight).catch(err => {
    renderError(el, err);
  })));
}

async function setupTerminal(el, Decklight) {
  if (el.dataset.decklightTerminal) return; // already initialized (sync() re-scan)
  el.dataset.decklightTerminal = '1';
  // data-cast-inline="#id" reads the cast from an embedded JSON <script> —
  // the only path that works on file://, where fetch() of local files is
  // blocked. data-cast fetches a URL (needs http, or a served deck).
  let text, src;
  const inlineSel = el.dataset.castInline;
  if (inlineSel) {
    src = inlineSel;
    let node = document.querySelector(inlineSel);
    if (!node && document.readyState === 'loading') {
      // Init scripts run mid-parse; a cast block authored below them isn't in
      // the DOM yet. Wait for the parser to finish, then look again.
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
      node = document.querySelector(inlineSel);
    }
    if (!node) throw new Error(`inline cast not found: ${inlineSel}`);
    text = node.textContent;
  } else {
    src = el.dataset.cast;
    const res = await fetch(src);
    if (!res.ok) throw new Error(`failed to load cast: ${src} (${res.status})`);
    text = await res.text();
  }
  const cast = parseCast(text, src);
  const controller = new TerminalController(el, cast);
  let mode = el.dataset.mode || 'step';
  // An imported asciicast without markers has no step structure — only the
  // timeline is playable.
  if (cast.imported && mode === 'step' && !cast.hasMarkers) mode = 'play';
  if (mode === 'play') controller.mountPlayMode();
  else controller.mountStepMode(Decklight);
}

/** Accepts a decklight cast (one JSON document) or an asciicast v2 file
 *  (NDJSON: header line + event lines) — detected by shape, not extension. */
function parseCast(text, src) {
  let doc = null;
  try { doc = JSON.parse(text); } catch { /* possibly NDJSON */ }
  if (doc) {
    if (doc.decklightCast === 1 && Array.isArray(doc.steps)) return doc;
    throw new Error(`not a decklight cast (v1): ${src}`);
  }
  return importAsciicast(text, src);
}

/**
 * asciicast v2 → internal cast. Marker events split the stream into steps
 * (marker label = step label); without markers the whole file is one step.
 * Imported steps are `raw`: the stream already contains prompts and echoed
 * input, so the player must not inject its own prompt or type commands.
 */
function importAsciicast(text, src) {
  const lines = text.split('\n').filter(l => l.trim());
  let header;
  try { header = JSON.parse(lines[0]); } catch { header = null; }
  if (!header || header.version !== 2) throw new Error(`not a decklight cast or asciicast v2: ${src}`);
  const steps = [];
  let cur = { cmd: '', raw: true, output: [] };
  let curStart = 0;
  let sawMarker = false;
  for (const line of lines.slice(1)) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!Array.isArray(ev) || ev.length < 3) continue;
    const [t, kind, data] = ev;
    if (kind === 'm') {
      sawMarker = true;
      if (cur.output.length) steps.push(cur);
      cur = { cmd: String(data || ''), raw: true, output: [] };
      curStart = t;
    } else if (kind === 'o') {
      cur.output.push([Math.max(0, round3(t - curStart)), data]);
    }
  }
  if (cur.output.length) steps.push(cur);
  if (!steps.length) throw new Error(`asciicast has no output events: ${src}`);
  return {
    decklightCast: 1,
    imported: true,
    hasMarkers: sawMarker,
    meta: { cols: header.width || 100, rows: header.height || 28, prompt: '' },
    steps,
  };
}

function round3(n) { return Math.round(n * 1000) / 1000; }

function renderError(el, err) {
  el.innerHTML =
    `<div class="terminal-window terminal-broken"><div class="terminal-titlebar">` +
    `<span class="terminal-dot"></span><span class="terminal-dot"></span><span class="terminal-dot"></span>` +
    `<span class="terminal-title">terminal</span></div>` +
    `<div class="terminal-screen"><pre class="terminal-lines">⚠ ${escapeHtml(String(err.message || err))}</pre></div></div>`;
}

class TerminalController {
  constructor(el, cast) {
    this.el = el;
    this.cast = cast;
    this.prompt = cast.meta.prompt ?? '$ ';
    // authored scale (1 slow … 10 fast, 5 default); a per-deck presenter
    // override from the ⌨ button takes precedence
    this.typeScale = clampScale(parseInt(el.dataset.typeSpeed ?? '5', 10) || 5);
    try {
      const saved = parseInt(localStorage.getItem(TYPE_SPEED_KEY) ?? '', 10);
      if (saved >= 1 && saved <= 10) this.typeScale = saved;
    } catch { /* private mode */ }
    el.dataset.typeScale = String(this.typeScale);
    this.fontIdx = FONT_STEPS.indexOf(1);
    try {
      const saved = parseInt(localStorage.getItem(TERM_FONT_KEY) ?? '', 10);
      if (saved >= 0 && saved < FONT_STEPS.length) this.fontIdx = saved;
    } catch { /* private mode */ }
    this._applyFont();
    const snd = (el.dataset.typeSound || 'creamy').toLowerCase();
    this.typeSound = snd === 'off' ? null : (KEY_PROFILES[snd] ? snd : 'creamy');
    this.maxStep = (parseFloat(el.dataset.maxStep || '2.5') || 2.5) * 1000;
    this.visibleRows = parseInt(el.dataset.rows || '', 10) || Math.min(cast.meta.rows || DEFAULT_VISIBLE_ROWS, DEFAULT_VISIBLE_ROWS);
    this.epoch = 0;        // bumped to cancel in-flight animations
    this.applied = 0;      // last fully applied step count
    // hidden steps never play; sleep steps pace play mode but are not builds
    this.playable = cast.steps.filter(s => !s.hidden && s.sleep == null);
    this._mountChrome();
  }

  _mountChrome() {
    const title = this.el.dataset.title || 'Terminal';
    this.el.innerHTML =
      `<div class="terminal-window"><div class="terminal-titlebar">` +
      `<span class="terminal-dot"></span><span class="terminal-dot"></span><span class="terminal-dot"></span>` +
      `<span class="terminal-title">${escapeHtml(title)}</span>` +
      `<span class="terminal-controls"></span></div>` +
      `<div class="terminal-screen"><pre class="terminal-lines"></pre></div></div>`;
    this.linesEl = this.el.querySelector('.terminal-lines');
    this.screenEl = this.el.querySelector('.terminal-screen');
    this.controlsEl = this.el.querySelector('.terminal-controls');
    this.screenEl.style.maxHeight = `calc(${this.visibleRows} * var(--term-line-height, 1.45em))`;
  }

  // ------------------------------------------------------------- rendering

  /** Full instant render of the first `n` playable steps (idempotent ground truth). */
  _renderComplete(n, { withCursor = true } = {}) {
    const parts = [];
    for (let s = 0; s < n; s++) parts.push(this._stepHtml(this.playable[s]));
    if (withCursor && !this.cast.imported) parts.push(this._promptHtml() + `<span class="terminal-cursor"></span>`);
    this.linesEl.innerHTML = parts.join('\n');
    this._scrollToEnd();
  }

  /** Output + interactive-input events of a step, merged on the shared clock. */
  _stepEvents(step) {
    return [
      ...(step.output || []).map(([t, d]) => ({ t, kind: 'o', d })),
      ...(step.input || []).map(([t, d]) => ({ t, kind: 'i', d: d.replace(/\r?\n$/, '') })),
    ].sort((a, b) => a.t - b.t);
  }

  _stepHtml(step) {
    const screen = new AnsiScreen();
    for (const ev of this._stepEvents(step)) screen.write(ev.d);
    const body = screen.toHtml();
    if (step.raw) return body; // imported stream already contains prompts/echo
    return this._promptHtml() + `<span class="terminal-cmd">${escapeHtml(step.cmd)}</span>` + (body ? '\n' + body : '');
  }

  _promptHtml() {
    return `<span class="terminal-prompt">${escapeHtml(this.prompt)}</span>`;
  }

  _scrollToEnd() { this.screenEl.scrollTop = this.screenEl.scrollHeight; }

  _applyFont() {
    const scale = FONT_STEPS[this.fontIdx];
    this.el.style.fontSize = scale === 1 ? '' : `${scale}em`;
  }

  // A n% — font-size chooser; click cycles 75% → 160% and wraps. Appended
  // after each mode sets controlsEl.innerHTML, so both modes get it.
  _mountFontButton() {
    const btn = document.createElement('button');
    btn.className = 'terminal-btn terminal-fontsize';
    btn.title = 'font size — click cycles 75% to 160%';
    btn.setAttribute('aria-label', 'font size');
    const label = () => { btn.textContent = `A ${Math.round(FONT_STEPS[this.fontIdx] * 100)}%`; };
    label();
    btn.addEventListener('click', () => {
      this.fontIdx = (this.fontIdx + 1) % FONT_STEPS.length;
      this._applyFont();
      try { localStorage.setItem(TERM_FONT_KEY, String(this.fontIdx)); } catch { /* private mode */ }
      label();
    });
    this.controlsEl.appendChild(btn);
  }

  // ------------------------------------------------------------- step mode

  mountStepMode(Decklight) {
    // ⌨ n — presenter's typing-speed chooser; click cycles 1 → 10 and wraps.
    // Persisted per deck so every terminal (and the next session) follows.
    this.controlsEl.innerHTML =
      `<button class="terminal-btn terminal-typespeed" title="typing speed — click cycles 1 (slow) to 10 (fast)" aria-label="typing speed">⌨ ${this.typeScale}</button>`;
    this.controlsEl.querySelector('.terminal-typespeed').addEventListener('click', (e) => {
      this.typeScale = this.typeScale % 10 + 1;
      this.el.dataset.typeScale = String(this.typeScale);
      try { localStorage.setItem(TYPE_SPEED_KEY, String(this.typeScale)); } catch { /* private mode */ }
      e.target.textContent = `⌨ ${this.typeScale}`;
    });
    this._mountFontButton();
    const steps = this.playable;
    // Poster steps arrive pre-rendered and are excluded from the build
    // sequence: provider count = playable - poster, apply(i) shows poster+i.
    const poster = Math.min(Math.max(parseInt(this.el.dataset.poster || '0', 10) || 0, 0), steps.length);
    this.poster = poster;
    this.applied = poster;
    this._renderComplete(poster);
    if (!Decklight || typeof Decklight.registerBuildProvider !== 'function') {
      // Standalone (no engine, e.g. print or docs page): show everything.
      this._renderComplete(steps.length, { withCursor: false });
      return;
    }
    Decklight.registerBuildProvider(this.el, {
      count: steps.length - poster,
      label: i => steps[poster + i] ? `${this.prompt}${steps[poster + i].cmd || '▶ recording'}` : '',
      apply: i => this.applyStep(poster + Math.max(0, Math.min(i, steps.length - poster))),
    });
  }

  /** Idempotent: render state for "first i steps done". Animates only a
   *  single forward advance (i === applied+1); everything else is instant. */
  applyStep(i) {
    this.epoch += 1;
    const animate = i === this.applied + 1;
    this.applied = i;
    if (!animate) { this._renderComplete(i); return; }
    this._animateStep(i - 1, this.epoch);
  }

  async _animateStep(stepIdx, epoch) {
    const step = this.playable[stepIdx];
    const speedFactor = typeRate(this.typeScale) * (step.typeSpeed || 1);
    // Base: everything before this step, no trailing cursor/prompt.
    const parts = [];
    for (let s = 0; s < stepIdx; s++) parts.push(this._stepHtml(this.playable[s]));
    const base = parts.length ? parts.join('\n') + '\n' : '';

    // 1) type the command (imported raw streams carry their own echo)
    const cmd = step.cmd || '';
    if (!step.raw) {
      for (let c = 1; c <= cmd.length; c++) {
        if (this.epoch !== epoch) return;
        if (this.typeSound) keyClick(cmd[c - 1], this.typeSound);
        this.linesEl.innerHTML = base + this._promptHtml() +
          `<span class="terminal-cmd">${escapeHtml(cmd.slice(0, c))}</span><span class="terminal-cursor"></span>`;
        this._scrollToEnd();
        await sleep((80 + Math.random() * 55) / speedFactor);
      }
      await sleep(120 / speedFactor);
    }

    // 2) stream output + interactive input with recorded pacing, ≤ maxStep
    const events = this._stepEvents(step);
    const total = events.length ? events[events.length - 1].t * 1000 : 0;
    const scale = total > this.maxStep ? this.maxStep / total : 1;
    const screen = new AnsiScreen();
    const paint = () => {
      const body = screen.toHtml();
      this.linesEl.innerHTML = step.raw
        ? base + body
        : base + this._promptHtml() +
          `<span class="terminal-cmd">${escapeHtml(cmd)}</span>` + (body ? '\n' + body : '');
      this._scrollToEnd();
    };
    let prevT = 0;
    for (const ev of events) {
      const gap = Math.min((ev.t - prevT) * 1000 * scale, 400);
      prevT = ev.t;
      if (gap > 8) await sleep(gap);
      if (this.epoch !== epoch) return;
      if (ev.kind === 'i') {
        // an interactive answer gets typed, character by character
        for (const ch of ev.d) {
          if (this.epoch !== epoch) return;
          if (this.typeSound) keyClick(ch, this.typeSound);
          screen.write(ch);
          paint();
          await sleep(60 / speedFactor);
        }
      } else {
        screen.write(ev.d);
        paint();
      }
    }
    if (this.epoch !== epoch) return;
    this._renderComplete(stepIdx + 1); // settle into canonical complete state
  }

  // ------------------------------------------------------------- play mode

  mountPlayMode() {
    this.speed = 1;
    this.playing = false;
    this.controlsEl.innerHTML =
      `<button class="terminal-btn terminal-play" aria-label="play">▶</button>` +
      `<button class="terminal-btn terminal-speed" aria-label="speed">1×</button>` +
      `<button class="terminal-btn terminal-restart" aria-label="restart">↺</button>`;
    this._mountFontButton();
    const playBtn = this.controlsEl.querySelector('.terminal-play');
    const speedBtn = this.controlsEl.querySelector('.terminal-speed');
    this.controlsEl.querySelector('.terminal-restart').addEventListener('click', () => this._restart(playBtn));
    speedBtn.addEventListener('click', () => {
      this.speed = this.speed >= 4 ? 1 : this.speed * 2;
      speedBtn.textContent = `${this.speed}×`;
    });
    playBtn.addEventListener('click', () => {
      if (this.playing) { this.playing = false; this.epoch += 1; playBtn.textContent = '▶'; }
      else { playBtn.textContent = '⏸'; this._playAll(playBtn); }
    });
    this._renderComplete(0);
  }

  _restart(playBtn) {
    this.epoch += 1;
    this.playing = false;
    playBtn.textContent = '▶';
    this._playedUpTo = 0;
    this._renderComplete(0);
  }

  async _playAll(playBtn) {
    this.playing = true;
    const epoch = ++this.epoch;
    const from = this._playedUpTo || 0;
    for (let s = from; s < this.cast.steps.length; s++) {
      const step = this.cast.steps[s];
      if (step.hidden) { this._playedUpTo = s + 1; continue; }
      if (step.sleep != null) {                       // pure pause marker
        await sleep(step.sleep * 1000 / this.speed);
        if (this.epoch !== epoch) { this._playedUpTo = s; return; }
        this._playedUpTo = s + 1;
        continue;
      }
      const shown = this.cast.steps.slice(0, s).filter(x => !x.hidden && x.sleep == null);
      const parts = shown.map(x => this._stepHtml(x));
      const base = parts.length ? parts.join('\n') + '\n' : '';
      const speedFactor = this.speed * (step.typeSpeed || 1) * typeRate(this.typeScale);
      // type (imported raw streams carry their own echo)
      const cmd = step.cmd || '';
      if (!step.raw) {
        for (let c = 1; c <= cmd.length; c++) {
          if (this.epoch !== epoch) { this._playedUpTo = s; return; }
          if (this.typeSound) keyClick(cmd[c - 1], this.typeSound);
          this.linesEl.innerHTML = base + this._promptHtml() +
            `<span class="terminal-cmd">${escapeHtml(cmd.slice(0, c))}</span><span class="terminal-cursor"></span>`;
          this._scrollToEnd();
          await sleep(75 / speedFactor);
        }
      }
      // stream at original pacing / speed
      const screen = new AnsiScreen();
      const paint = () => {
        const body = screen.toHtml();
        this.linesEl.innerHTML = step.raw
          ? base + body
          : base + this._promptHtml() +
            `<span class="terminal-cmd">${escapeHtml(cmd)}</span>` + (body ? '\n' + body : '');
        this._scrollToEnd();
      };
      let prevT = 0;
      for (const ev of this._stepEvents(step)) {
        const gap = (ev.t - prevT) * 1000 / this.speed;
        prevT = ev.t;
        if (gap > 4) await sleep(gap);
        if (this.epoch !== epoch) { this._playedUpTo = s; return; }
        if (ev.kind === 'i') {
          for (const ch of ev.d) {
            if (this.typeSound) keyClick(ch, this.typeSound);
            screen.write(ch); paint(); await sleep(60 / speedFactor);
          }
        } else { screen.write(ev.d); paint(); }
      }
      await sleep(350 / this.speed);
      this._playedUpTo = s + 1;
    }
    this.playing = false;
    playBtn.textContent = '▶';
    this._playedUpTo = 0;
    this._renderComplete(this.playable.length, { withCursor: true });
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
