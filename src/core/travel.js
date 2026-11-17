// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A token that travels along a wire (SPEC BUILD_ENTRANCES, `travel`).
 *
 * `<g data-build="travel" data-along-wire="orders-agent">` in a diagram is one
 * build step: when it plays, a dot (a chip with `data-label`) leaves the start
 * of the wire its svg names `data-wire="orders-agent"`, follows the wire's
 * route as it runs now (straight, elbow or curve, a node moved since), and
 * arrives at its end: `data-arrive="fade"` (the default) fades it there,
 * `stay` leaves it there, `pulse` fades it and gives the node the wire goes
 * to one emphasis pulse. `data-travel-repeat` sends it again and again while
 * its step is the current one; `data-travel-ms` is its pace, else four times
 * the deck's `--build-duration`.
 *
 * The step's element is the author's and stays empty: the token is the
 * engine's, a `<g class="travel-token">` put right after the wire (and what
 * the engine drew for it), in the wire's own coordinates, so it rides above
 * the wire and below the labels written after it. Never in the file: every
 * list of the engine's nodes names it.
 *
 * END STATE FIRST. `syncTravel` (called by applyBuildState for every travel
 * step) puts the token where the step's state leaves it, synchronously: a
 * step not yet played, or played with an arrival that goes, shows nothing; a
 * step played with `stay` shows the token at the wire's end. That is what
 * print, the overview, a deep link, a step back and instant application
 * show. Only a step that has just become the current one, on a page that
 * moves (not reduced motion, not `decklight-no-anim`, not print), then plays
 * the trip, by a clock whose frames are requestAnimationFrame or, where no
 * frame is ever painted (a headless render), a timer. The trip is cosmetic:
 * stopping it anywhere puts the token back at the end state.
 */

import { wirePoints, pointAlong, svgOf, outsideDrawing, nodeNamed } from './connectors.js';
import { conceptFill } from './svg.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** How a token arrives: the attribute's values, the default first. */
export const ARRIVALS = ['fade', 'stay', 'pulse'];
/** The pace an author may set, in ms. */
export const TRAVEL_MS = Object.freeze({ min: 100, max: 20000 });
/** How long the target's pulse lasts (the CSS animation's own length). */
const PULSE_MS = 700;
/** A repeating token's pause at the end before it leaves again, beyond its fade. */
const REPEAT_GAP = 0.25;

const cfg = {
  concepts: () => ({}),
  reduced: () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true,
  now: () => (globalThis.performance?.now?.() ?? Date.now()),
};
/** The deck's concepts (init's `concepts`), the reduced-motion test and the clock: the engine's, a test's. */
export function configureTravel(opts = {}) {
  for (const k of ['concepts', 'reduced', 'now']) if (typeof opts[k] === 'function') cfg[k] = opts[k];
}

/** How a step's token arrives (`data-arrive`, `fade` when it says nothing else). */
export const arrivalOf = (el) => (ARRIVALS.includes(el?.getAttribute?.('data-arrive')) ? el.getAttribute('data-arrive') : 'fade');
/** A step's own pace (`data-travel-ms`), or null for the deck's. */
export function travelMsOf(el) {
  const v = parseFloat(el?.getAttribute?.('data-travel-ms'));
  return Number.isFinite(v) && v > 0 ? Math.min(TRAVEL_MS.max, Math.max(TRAVEL_MS.min, v)) : null;
}

/** The wire a travel step names: a line, path or polyline of its svg with that `data-wire`, or null. */
export function wireOfTravel(el) {
  const name = el?.getAttribute?.('data-along-wire');
  const svg = name ? svgOf(el) : null;
  if (!svg) return null;
  for (const w of svg.querySelectorAll('[data-wire]')) {
    if (w.getAttribute('data-wire') === name && /^(line|path|polyline)$/i.test(w.tagName) && !outsideDrawing(w) && svgOf(w) === svg) return w;
  }
  return null;
}

/** The ends a travel step's wire joins, `{ from, to }` (node names, null where an end is free). */
export function travelEnds(el) {
  const w = wireOfTravel(el);
  return { from: w?.getAttribute('data-from') ?? null, to: w?.getAttribute('data-to') ?? null, wire: el?.getAttribute?.('data-along-wire') ?? null };
}

/**
 * A travel step in words, as the Builds tab and the speaker view name it:
 * `orders → agent` (the nodes its wire joins), the wire's name where an end
 * is free, `no wire "x"` when its svg has none by that name.
 */
export function travelLabel(el) {
  const { from, to, wire } = travelEnds(el);
  if (!wireOfTravel(el)) return wire ? `no wire "${wire}"` : 'no wire';
  return from && to ? `${from} → ${to}` : wire;
}

/** CSS `ease-in-out`, solved for progress `t`. */
function ease(t) {
  const bx = (u) => 3 * 0.42 * u * (1 - u) * (1 - u) + 3 * 0.58 * u * u * (1 - u) + u * u * u;
  const by = (u) => 3 * u * u * (1 - u) + u * u * u;
  let lo = 0; let hi = 1;
  for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (bx(m) < t) lo = m; else hi = m; }
  return by((lo + hi) / 2);
}

const ms = (v) => { const s = String(v ?? '').trim(); const n = parseFloat(s); return Number.isFinite(n) ? (s.endsWith('ms') ? n : n * 1000) : 0; };

// step element → its token: { token, wire, key, shape, text?, est }
const tokens = new WeakMap();
// step element → the trip under way: { rec, t0, dur, fade, repeat, arrive, pulsed, pulse }
const running = new Map();
let frameHandle = null;

/** What a token is drawn from: rebuilt when any of it changes. */
const keyOf = (el) => `${el.getAttribute('data-label') ?? ''}\u0000${el.getAttribute('data-concept') ?? ''}`;

/** The size labels are written at in this diagram, in its units: its first label's, else 14. */
function labelSize(svg) {
  for (const t of svg.querySelectorAll('text')) {
    if (t.closest('.travel-token') || outsideDrawing(t)) continue;
    const a = parseFloat(t.getAttribute('font-size'));
    if (a > 0) return a;
    const c = parseFloat(getComputedStyle(t).fontSize);
    if (c > 0) return c;
  }
  return 14;
}

/** The token of step `el`, made (or made again) for its wire as it is now; null when it names no wire. */
function tokenFor(el) {
  const wire = wireOfTravel(el);
  let rec = tokens.get(el);
  if (!wire) {
    rec?.token.remove();
    tokens.delete(el);
    return null;
  }
  const key = keyOf(el);
  if (rec && rec.wire === wire && rec.key === key && rec.token.parentNode === wire.parentNode) return rec;
  rec?.token.remove();
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'travel-token');
  g.setAttribute('aria-hidden', 'true');
  const label = (el.getAttribute('data-label') ?? '').replace(/\s+/g, ' ').trim();
  let shape; let text = null;
  if (label) {
    shape = document.createElementNS(SVG_NS, 'rect');
    text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('class', 'travel-chip-text');
    text.textContent = label;
    g.append(shape, text);
  } else {
    shape = document.createElementNS(SVG_NS, 'circle');
    g.append(shape);
  }
  // above the wire and what the engine drew for it (a riding head, a dash's mask), below the labels after it
  let after = wire;
  while (after.nextElementSibling?.matches?.('.draw-head, .draw-mask, .travel-token')) after = after.nextElementSibling;
  after.after(g);
  rec = { token: g, wire, key, shape, text, est: true };
  tokens.set(el, rec);
  return rec;
}

/** The token painted and sized for its wire as it is now: its colour, a dot's radius, a chip's box round its words. */
function paint(el, rec) {
  const { token, wire, shape, text } = rec;
  token.setAttribute('data-arrive', arrivalOf(el));
  const cs = getComputedStyle(wire);
  const sw = parseFloat(cs.strokeWidth) || 2;
  const concept = el.getAttribute('data-concept');
  const stroke = cs.stroke && cs.stroke !== 'none' ? cs.stroke : 'var(--d-stroke)';
  const fill = concept ? conceptFill(concept, cfg.concepts() ?? {}) : stroke;
  shape.style.fill = fill;
  if (!text) {
    const r = Math.max(6.5, sw * 3.4);
    shape.setAttribute('r', String(Math.round(r * 10) / 10));
    shape.style.stroke = 'var(--bg)';
    shape.style.strokeWidth = String(Math.max(1.5, r * 0.32));
    rec.ext = r;
    return;
  }
  // ink on the chip: the slide's background or the diagram's text, whichever reads better on its fill
  text.style.fill = inkOn(shape, text);
  if (!rec.est) return;
  const fs = labelSize(svgOf(wire) ?? wire);
  const size = Math.round(fs * 0.86 * 10) / 10;
  text.style.fontSize = `${size}px`;
  let w = 0;
  try { w = text.getComputedTextLength(); } catch { w = 0; }
  rec.est = !(w > 0);
  if (!(w > 0)) w = text.textContent.length * size * 0.56;
  const h = size * 1.7;
  const pad = size * 0.75;
  const fw = w + pad * 2;
  shape.setAttribute('x', String(Math.round(-fw / 2 * 10) / 10));
  shape.setAttribute('y', String(Math.round(-h / 2 * 10) / 10));
  shape.setAttribute('width', String(Math.round(fw * 10) / 10));
  shape.setAttribute('height', String(Math.round(h * 10) / 10));
  shape.setAttribute('rx', String(Math.round(h / 2 * 10) / 10));
  shape.style.stroke = 'var(--bg)';
  shape.style.strokeWidth = String(Math.max(1, size * 0.12));
  rec.ext = fw / 2;
}

/** A computed colour as `[r, g, b]` (0 to 255): `rgb()`, `rgba()` or `color(srgb …)`; null for anything else. */
function rgbOf(c) {
  const s = String(c ?? '').trim();
  const n = (s.match(/-?[\d.]+/g) ?? []).map(Number);
  if (/^rgba?\(/.test(s) && n.length >= 3) return n.slice(0, 3);
  if (/^color\(srgb\b/.test(s) && n.length >= 3) return n.slice(0, 3).map((v) => v * 255);
  return null;
}
function luminance([r, g, b]) {
  const ch = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** Which of the slide's background and the diagram's text reads better on the chip's fill, as each computes. */
function inkOn(shape, text) {
  const fill = rgbOf(getComputedStyle(shape).fill);
  const read = (v) => { text.style.fill = v; return rgbOf(getComputedStyle(text).fill); };
  const bg = read('var(--bg)');
  const ink = read('var(--d-text)');
  if (!fill || !bg || !ink) return 'var(--bg)';
  return contrast(fill, ink) > contrast(fill, bg) ? 'var(--d-text)' : 'var(--bg)';
}

/**
 * The token put `t` (0 to 1) of the way along its wire, as the wire runs now:
 * its own half-width in from each end, so it leaves the node it starts at and
 * stops against the one it reaches, rather than over either one's words.
 */
function place(rec, t) {
  const pts = wirePoints(rec.wire);
  const total = pts.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]), 0);
  const inset = rec.ext ?? 0;
  const f = total > inset * 2 + 1 ? (inset + t * (total - inset * 2)) / total : 0.5;
  const p = pointAlong(pts, f);
  const own = rec.wire.getAttribute('transform');
  rec.token.setAttribute('transform', `${own ? `${own} ` : ''}translate(${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100})`);
}
function show(rec, on, opacity = null) {
  rec.token.classList.toggle('travel-on', on);
  if (opacity === null) rec.token.style.removeProperty('opacity');
  else rec.token.style.opacity = String(Math.round(opacity * 1000) / 1000);
}

/** The token where state `state` leaves it: at the end with `stay` once played, else not shown. */
function rest(el, rec, state) {
  paint(el, rec);
  place(rec, 1);
  show(rec, state !== 'pending' && arrivalOf(el) === 'stay');
}

/** The node the wire goes to: what a `pulse` arrival pulses. */
function targetOf(rec) {
  return nodeNamed(svgOf(rec.wire), rec.wire.getAttribute('data-to'));
}
function unpulse(r) {
  if (!r.pulse) return;
  r.pulse.node.classList.remove('travel-pulse');
  clearTimeout(r.pulse.timer);
  r.pulse = null;
}
function pulse(r) {
  const node = targetOf(r.rec);
  if (!node) return;
  unpulse(r);
  node.classList.remove('travel-pulse');
  void node.getBoundingClientRect?.();   // a pulse begun again starts from its first frame
  node.classList.add('travel-pulse');
  r.pulse = { node, timer: setTimeout(() => { node.classList.remove('travel-pulse'); if (r.pulse?.node === node) r.pulse = null; }, PULSE_MS) };
}

/** Stop step `el`'s trip, if one is under way (its token is put back by the caller). */
function stop(el) {
  const r = running.get(el);
  if (!r) return;
  running.delete(el);
  unpulse(r);
}

/** May a trip play for `el` now: a live, moving page, its slide on screen? */
function moving(el) {
  if (el.closest('.decklight-no-anim, .decklight-print, .decklight-capture, .decklight-overview')) return false;
  if (cfg.reduced()) return false;
  const sec = el.closest('section');
  return !sec || sec.classList.contains('active');
}

/** The deck's pace, read off the token (four build durations, `--build-duration` the theme's). */
const deckPace = (rec) => ms(getComputedStyle(rec.token).animationDuration);
const deckFade = (rec) => ms(getComputedStyle(rec.token).transitionDuration);

function start(el, rec) {
  const dur = travelMsOf(el) ?? deckPace(rec);
  if (!(dur > 0)) return;
  const r = { rec, t0: cfg.now(), dur, fade: deckFade(rec), repeat: el.hasAttribute('data-travel-repeat'), arrive: arrivalOf(el), pulsed: false, pulse: null };
  running.set(el, r);
  place(rec, 0);
  show(rec, true, 1);
  schedule();
}

/**
 * Step `el`'s token for state `state` (`pending`, `current`, `done`): its end
 * state at once, then the trip when it has just become the current step on
 * a page that moves. Idempotent: the same state again leaves a trip running.
 */
export function syncTravel(el, state) {
  const prev = el._travelState ?? 'pending';
  el._travelState = state;
  const rec = tokenFor(el);
  if (!rec) { stop(el); return; }
  const can = moving(el);
  if (prev === state && running.has(el) && can) return;
  stop(el);
  rest(el, rec, state);
  if (state !== 'current' || !can) return;
  // played forwards; or the current step again from a later one, when it keeps flowing
  if (prev === 'pending' || (prev === 'done' && el.hasAttribute('data-travel-repeat'))) start(el, rec);
}

/** Paint every trip at time `t`: what a frame does, and what a test calls. */
export function tick(t = cfg.now()) {
  for (const [el, r] of [...running]) {
    const { rec } = r;
    if (!el.isConnected || !rec.token.isConnected || !moving(el) || el._travelState !== 'current') {
      stop(el);
      if (rec.token.isConnected) rest(el, rec, el._travelState ?? 'pending');
      continue;
    }
    const e = t - r.t0;
    if (e < r.dur) { place(rec, ease(Math.max(0, e / r.dur))); show(rec, true, 1); continue; }
    place(rec, 1);
    if (!r.pulsed) { r.pulsed = true; if (r.arrive === 'pulse') pulse(r); }
    const after = e - r.dur;
    const hold = r.arrive === 'stay' ? 0 : r.fade;
    if (r.arrive !== 'stay') show(rec, after < hold, hold ? Math.max(0, 1 - after / hold) : 0);
    if (!r.repeat) {
      if (after >= hold) { running.delete(el); rest(el, rec, el._travelState); }
      continue;
    }
    // flowing: once gone (or a beat at the end, staying), it leaves again
    if (after >= hold + r.dur * REPEAT_GAP) { r.t0 = t; r.pulsed = false; place(rec, 0); show(rec, true, 1); }
  }
  if (running.size) schedule();
}

/**
 * The next frame: requestAnimationFrame where the browser paints, a timer
 * where it never does (a headless render under a virtual-time budget), the
 * first to fire running the tick.
 */
function schedule() {
  if (frameHandle) return;
  const h = { done: false, raf: 0, timer: 0 };
  const once = () => { if (h.done) return; h.done = true; frameHandle = null; if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h.raf); clearTimeout(h.timer); tick(); };
  h.raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(once) : 0;
  h.timer = setTimeout(once, 40);
  frameHandle = h;
}

/** Every trip stopped, every token at its end state (the overview opens, a still is taken). */
export function finishTravel() {
  for (const [el, r] of [...running]) {
    stop(el);
    if (r.rec.token.isConnected) rest(el, r.rec, el._travelState ?? 'pending');
  }
}

/** The trips under way, for a test: `[{ el, token, t0, dur }]`. */
export const travelling = () => [...running].map(([el, r]) => ({ el, token: r.rec.token, t0: r.t0, dur: r.dur, fade: r.fade }));
/** Step `el`'s token, or null (a test, the Builds tab). */
export const tokenOf = (el) => tokens.get(el)?.token ?? null;
/** A travel step's token taken off the page (its step removed). */
export function dropToken(el) {
  stop(el);
  tokens.get(el)?.token.remove();
  tokens.delete(el);
}
