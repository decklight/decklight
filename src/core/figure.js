// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A figure (SPEC DECK_ANATOMY, Figures): one oversized value with its label,
// `<div class="figure"><p data-figure>94%</p><p>…</p></div>`, sized by the
// theme's `--figure-size` and clamped to its column. Two things are the
// runtime's, and both live here:
//
//   THE CLAMP. A value is never wider than its column. CSS knows the column
//   (the figure is a size container) but not how long the value is, so each
//   value carries its length as `--figure-chars`, and the stylesheet sets it
//   at the smaller of the theme's size and the size at which that many
//   characters fit. Set synchronously, at boot and whenever a slide is
//   scanned again (an edit in place), so a headless render is already right.
//
//   THE COUNT. `data-count` on the value counts it up from 0 (or
//   `data-count-from`) to the number as written when its step arrives, the
//   prefix, suffix, decimals and separators kept (`$1.2M`, `94%`, `1,500`).
//   The animation is cosmetic: the DOM holds the authored text whenever no
//   frame of it is being painted, frames only ever write the in-between
//   values, and a timer puts the authored text back whether or not a frame
//   ever came (a headless render never paints one). A page that only shows
//   (print, a capture, an embedded preview), reduced motion, a deep link, a
//   step backwards and the overview all show the final value.

/** How long a count takes, in ms. */
export const COUNT_MS = 1400;

// the number inside the value: digits, with the separators between them
const NUMBER = /\d(?:[\d,.  ' ]*\d)?/;

/**
 * The number in a figure's text, as written: what comes before and after it,
 * its value, how many decimals it shows, and its decimal point and grouping
 * separator (null when it has none). `1,500` groups by a comma; `1,5` and
 * `1.5` have one decimal; `1.500,25` groups by a point and has a decimal
 * comma. Null when the text holds no digit.
 */
export function parseFigure(text) {
  const src = String(text ?? '');
  const m = NUMBER.exec(src);
  if (!m) return null;
  const run = m[0];
  let before = src.slice(0, m.index);
  const after = src.slice(m.index + run.length);
  let negative = false;
  if (/[-−]$/.test(before)) { negative = true; before = before.slice(0, -1); }
  const seps = [...run.matchAll(/[^\d]/g)].map((s) => ({ c: s[0], i: s.index }));
  let point = null; let group = null;
  if (seps.length) {
    const last = seps[seps.length - 1];
    const kinds = new Set(seps.map((s) => s.c));
    const tail = run.length - last.i - 1;
    if (kinds.size > 1) {
      // two kinds: the last one is the decimal point, the other groups
      if (last.c === ',' || last.c === '.') point = last.c;
      group = seps.find((s) => s.c !== point)?.c ?? null;
    } else if (seps.length === 1 && (last.c === '.' || (last.c === ',' && tail !== 3))) {
      point = last.c;   // one point, or one comma not followed by a group of three
    } else group = last.c;
  }
  const digits = point ? run.slice(0, run.lastIndexOf(point)) : run;
  const frac = point ? run.slice(run.lastIndexOf(point) + 1) : '';
  const whole = digits.replace(/[^\d]/g, '');
  const value = Number(`${whole}${frac ? `.${frac}` : ''}`) * (negative ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  return { before, after, value, decimals: frac.length, point, group, sign: negative ? src[m.index - 1] : '' };
}

/** `v` written the way `fig` writes its number, its decimals, point and grouping kept. */
export function formatFigure(fig, v) {
  const neg = v < 0 && Math.abs(v) >= 0.5 * 10 ** -fig.decimals;
  const fixed = Math.abs(v).toFixed(fig.decimals);
  const [whole, frac] = fixed.split('.');
  const grouped = fig.group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, fig.group) : whole;
  const sign = neg ? (fig.sign || '-') : '';
  return `${fig.before}${sign}${grouped}${frac ? `${fig.point ?? '.'}${frac}` : ''}${fig.after}`;
}

/** Where a count starts: `data-count-from`, a plain number (`50`, `1.5`, `-3`), else 0. */
export function countFrom(attr) {
  const n = Number(String(attr ?? '').trim().replace(/[\s,_]/g, ''));
  return String(attr ?? '').trim() && Number.isFinite(n) ? n : 0;
}

/** How many characters a value shows, for the clamp: what a reader sees, spaces trimmed. */
export const figureChars = (text) => Math.max(1, [...String(text ?? '').replace(/\s+/g, ' ').trim()].length);

const easeOut = (t) => 1 - (1 - t) ** 3;

/** The text node a value's number is in: the first one holding a digit. */
function numberNode(el) {
  const walk = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) if (/\d/.test(t.data)) return t;
  return null;
}

/**
 * The figures of a deck. `sections()` its slides, `current()` the one on
 * screen, `live` false for a page that only shows (print, capture,
 * embedded), `reduced()` whether motion is to be left out. `frame` and
 * `timer` are the clock, injectable for a test.
 */
export function createFigures({
  sections, current, live,
  reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true,
  frame = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : 0),
  timer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  now = () => (globalThis.performance?.now?.() ?? Date.now()),
}) {
  // value element → { node, text, fig, from, t0, timer }
  const running = new Map();

  /**
   * Every value in `scope` given its length, for the clamp. The values of
   * one row (`.figures`) take the longest one's, so they are set at one size
   * and their labels share a line.
   */
  function adopt(scope = null) {
    const roots = scope ? [scope] : sections();
    for (const r of roots) {
      for (const el of r?.querySelectorAll?.('[data-figure]') ?? []) {
        if (running.has(el)) continue;   // mid-count: its authored length is already set
        const row = el.closest('.figures');
        const peers = row ? [...row.querySelectorAll('[data-figure]')] : [el];
        const n = Math.max(...peers.map((p) => figureChars(running.has(p) ? p.getAttribute('aria-label') : p.textContent)));
        el.style.setProperty('--figure-chars', String(n));
      }
    }
  }

  /** Stop a count, the authored text back. */
  function stop(el) {
    const r = running.get(el);
    if (!r) return;
    running.delete(el);
    clearTimer(r.timer);
    if (r.node.isConnected || r.node.parentNode) r.node.data = r.text;
    el.classList.remove('figure-counting');
    if (r.label === null) el.removeAttribute('aria-label'); else el.setAttribute('aria-label', r.label);
  }
  /** Every count stopped, every value at its authored text (the overview opens, the slide changes). */
  function finish() { for (const el of [...running.keys()]) stop(el); }

  /** Paint the counts at time `t`: what a frame does, and what a test calls. */
  function tick(t = now()) {
    for (const [el, r] of [...running]) {
      const p = Math.min(1, Math.max(0, (t - r.t0) / COUNT_MS));
      if (p >= 1) { stop(el); continue; }
      r.node.data = formatFigure(r.fig, r.from + (r.fig.value - r.from) * easeOut(p));
    }
    if (running.size) frame(tick);
  }

  /** Start counting value `el`, when it asks to and the page is a live talk. */
  function start(el) {
    if (!live || reduced() || !el.hasAttribute('data-count') || running.has(el)) return;
    const node = numberNode(el);
    const fig = node && parseFigure(node.data);
    if (!fig) return;
    const from = countFrom(el.getAttribute('data-count-from'));
    if (from === fig.value) return;
    const label = el.getAttribute('aria-label');
    // a screen reader hears the value, never a number on its way there
    el.setAttribute('aria-label', el.textContent.replace(/\s+/g, ' ').trim());
    el.classList.add('figure-counting');
    const was = running.size;
    running.set(el, { node, text: node.data, fig, from, t0: now(), label, timer: timer(() => stop(el), COUNT_MS + 120) });
    // no frame is painted here: until one is, the value reads as written
    if (!was) frame(tick);
  }

  const counted = (sec) => [...(sec?.querySelectorAll?.('[data-figure][data-count]') ?? [])];
  /** The step a value arrives with: the build step it is (in), or null when it is there with the slide. */
  const stepOf = (el) => el.closest('.build-step');

  /** A slide came on screen: forwards at its first step, the values there from the start count. */
  function arrive({ direction } = {}, step = 0) {
    finish();
    adopt(current());
    if (direction !== 'fwd' || step !== 0) return;
    for (const el of counted(current())) if (!stepOf(el)) start(el);
  }
  /** A build step: forwards, the values that arrived with it count; backwards, every value is final. */
  function built({ direction } = {}) {
    const sec = current();
    if (direction !== 'fwd') { for (const el of counted(sec)) stop(el); return; }
    for (const el of counted(sec)) {
      const s = stepOf(el);
      if (s && s.getAttribute('data-build-state') === 'current') start(el);
    }
  }

  return { adopt, arrive, built, finish, tick, start, stop, running: () => [...running.keys()] };
}
