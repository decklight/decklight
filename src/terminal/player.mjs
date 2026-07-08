/**
 * Decklight terminal player (SPEC §7.3).
 *
 * <div class="terminal" data-cast="casts/demo.cast.json"
 *      data-mode="step|play" data-type-speed="1" data-max-step="2.5"
 *      data-title="Terminal" data-rows="24"></div>
 *
 * step mode (default): registers a Build Provider — each advance types the
 * next command (jittered keystrokes) then streams its recorded output with
 * pacing compressed to ≤ data-max-step seconds. apply(i) is idempotent for
 * any i (deep links, reverse navigation, print).
 *
 * play mode: timeline playback with play/pause, speed cycling, restart.
 */

import { AnsiScreen, spansToHtml, escapeHtml } from './ansi.mjs';

const DEFAULT_VISIBLE_ROWS = 24;

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
    this.typeSpeed = parseFloat(el.dataset.typeSpeed || '1') || 1;
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

  // ------------------------------------------------------------- step mode

  mountStepMode(Decklight) {
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
    const speedFactor = this.typeSpeed * (step.typeSpeed || 1);
    // Base: everything before this step, no trailing cursor/prompt.
    const parts = [];
    for (let s = 0; s < stepIdx; s++) parts.push(this._stepHtml(this.playable[s]));
    const base = parts.length ? parts.join('\n') + '\n' : '';

    // 1) type the command (imported raw streams carry their own echo)
    const cmd = step.cmd || '';
    if (!step.raw) {
      for (let c = 1; c <= cmd.length; c++) {
        if (this.epoch !== epoch) return;
        this.linesEl.innerHTML = base + this._promptHtml() +
          `<span class="terminal-cmd">${escapeHtml(cmd.slice(0, c))}</span><span class="terminal-cursor"></span>`;
        this._scrollToEnd();
        await sleep((30 + Math.random() * 40) / speedFactor);
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
          screen.write(ch);
          paint();
          await sleep(35 / speedFactor);
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
      const speedFactor = this.speed * (step.typeSpeed || 1);
      // type (imported raw streams carry their own echo)
      const cmd = step.cmd || '';
      if (!step.raw) {
        for (let c = 1; c <= cmd.length; c++) {
          if (this.epoch !== epoch) { this._playedUpTo = s; return; }
          this.linesEl.innerHTML = base + this._promptHtml() +
            `<span class="terminal-cmd">${escapeHtml(cmd.slice(0, c))}</span><span class="terminal-cursor"></span>`;
          this._scrollToEnd();
          await sleep(40 / speedFactor);
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
          for (const ch of ev.d) { screen.write(ch); paint(); await sleep(35 / speedFactor); }
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
