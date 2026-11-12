// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A diagram's canvas, in write mode (SPEC SVG_DIAGRAMS): the room the drawing
 * has, given more or taken away, and the drawing trimmed to it.
 *
 * A diagram selected whole (its canvas, not a shape in it) wears two sets of
 * handles. Its corners are the picture's (pictures.js, resize-handles.js):
 * they make the whole diagram bigger or smaller on the slide. Its four EDGES
 * are these: a drag gives the drawing more room on that side, or takes empty
 * room away, without moving or scaling what is drawn. Room is the `viewBox`;
 * so that more room does not draw everything smaller, the svg's `width` grows
 * with it, until the slide's width caps it (and its `height`, when it says
 * one). An edge never passes a shape: it stops where the drawing begins. A
 * slide that fits when the drag starts is kept fitting.
 *
 * Shape ▸ "Fit the canvas to the drawing" trims the room around the drawing
 * to an even margin. Each is one write, `POST /deck/edit/element/canvas`.
 */

import { sizedOf } from './pictures.js';
import { pathFrom } from './colorpicker.js';
import { createEditCommit } from './edit-commit.js';
import { contentWidth, overflows } from './resize-handles.js';

const SIDES = ['n', 'e', 's', 'w'];
const SAID = { n: 'top', e: 'right', s: 'bottom', w: 'left' };
/** What a diagram holds that draws nothing on the canvas. */
const NOT_DRAWN = new Set(['defs', 'title', 'desc', 'style', 'metadata', 'script', 'marker', 'mask', 'clippath', 'pattern', 'symbol', 'lineargradient', 'radialgradient', 'filter']);
const r1 = (n) => { const r = Math.round(n * 10) / 10; return Object.is(r, -0) ? 0 : r; };

/** A canvas: the `viewBox` as `{ x, y, w, h }`, or null. */
export function viewOf(svg) {
  const v = String(svg?.getAttribute?.('viewBox') ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  return v.length === 4 && v.every(Number.isFinite) && v[2] > 0 && v[3] > 0 ? { x: v[0], y: v[1], w: v[2], h: v[3] } : null;
}

/**
 * The canvas an edge drag makes, pure: from `vb` (the canvas when it began),
 * the pointer's travel in the svg's units (`dx`, `dy`), which `side` is
 * dragged, and the drawing's box `art` (null when nothing is drawn): an edge
 * goes out freely and in no further than the drawing, and never below 1.
 */
export function edgeCanvas(vb, side, dx, dy, art = null) {
  let { x, y, w, h } = vb;
  if (side === 'e') w = Math.max(vb.w + dx, art ? art.x + art.w - vb.x : 1, 1);
  if (side === 'w') { x = Math.min(vb.x + dx, art ? art.x : vb.x + vb.w - 1, vb.x + vb.w - 1); w = vb.x + vb.w - x; }
  if (side === 's') h = Math.max(vb.h + dy, art ? art.y + art.h - vb.y : 1, 1);
  if (side === 'n') { y = Math.min(vb.y + dy, art ? art.y : vb.y + vb.h - 1, vb.y + vb.h - 1); h = vb.y + vb.h - y; }
  return { x: r1(x), y: r1(y), w: r1(w), h: r1(h) };
}

/** The canvas that holds `art` with an even margin round it: a twentieth of its longer side, 8 units at least. */
export function fitCanvas(art) {
  const m = Math.max(8, Math.round(Math.max(art.w, art.h) / 20));
  return { x: r1(art.x - m), y: r1(art.y - m), w: r1(art.w + 2 * m), h: r1(art.h + 2 * m) };
}

/** The width an svg drawn at `w0` for a canvas `vb0` wide is drawn at for one `w` wide, so nothing drawn changes size; capped at `max`. */
export const keptWidth = (w0, vb0w, w, max = Infinity) => Math.round(Math.min(w0 * (w / vb0w), max));

export function createCanvas({ root, instance, editmode, editbar, toast, debugLog = () => {} }) {
  const commit = createEditCommit(editmode);
  let svg = null;
  let handles = [];
  let drag = null;

  /** The drawing's box in the svg's units: what an edge may not pass. Null when it draws nothing. */
  function artOf(s) {
    const m = s.getScreenCTM?.()?.inverse();
    if (!m) return null;
    let box = null;
    const walk = (el) => {
      for (const k of el.children) {
        const tag = k.tagName.toLowerCase();
        if (NOT_DRAWN.has(tag) || k.matches('.draw-head, .draw-mask, [data-ds-injected]')) continue;
        const r = k.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const pts = [[r.left, r.top], [r.right, r.bottom]].map(([cx, cy]) => ({ x: m.a * cx + m.c * cy + m.e, y: m.b * cx + m.d * cy + m.f }));
        const b = { x: Math.min(pts[0].x, pts[1].x), y: Math.min(pts[0].y, pts[1].y), x2: Math.max(pts[0].x, pts[1].x), y2: Math.max(pts[0].y, pts[1].y) };
        box = box ? { x: Math.min(box.x, b.x), y: Math.min(box.y, b.y), x2: Math.max(box.x2, b.x2), y2: Math.max(box.y2, b.y2) } : b;
      }
    };
    walk(s);
    return box && { x: box.x, y: box.y, w: box.x2 - box.x, h: box.y2 - box.y };
  }
  /** Where the svg is in the FILE. */
  function addressOf(s) {
    const t = editmode.elementTargetOf?.(s);
    if (!t?.top || t.index === null || t.index < 0) return null;
    const path = t.top === s ? [] : pathFrom(t.top, s);
    return path ? { slide: t.slide, index: t.index, path } : null;
  }
  /** The svg's width on the slide, in deck units: its attribute, else as it is drawn. */
  function widthOf(s) {
    const a = parseFloat(s.getAttribute('width'));
    if (Number.isFinite(a) && a > 0 && !/%/.test(s.getAttribute('width'))) return a;
    return s.getBoundingClientRect().width / (instance._scale || 1);
  }
  const heightAttr = (s) => { const a = parseFloat(s.getAttribute('height')); return Number.isFinite(a) && a > 0 && !/%/.test(s.getAttribute('height')) ? a : null; };

  // ── the edge handles ──────────────────────────────────────────────────────
  function place() {
    if (!svg?.isConnected) { unmount(); return; }
    const r = svg.getBoundingClientRect();
    const b = root.getBoundingClientRect();
    const at = { n: [(r.left + r.right) / 2, r.top - 4], s: [(r.left + r.right) / 2, r.bottom + 4], e: [r.right + 4, (r.top + r.bottom) / 2], w: [r.left - 4, (r.top + r.bottom) / 2] };
    for (const h of handles) {
      const [x, y] = at[h.dataset.side];
      h.style.left = `${x - b.left}px`;
      h.style.top = `${y - b.top}px`;
    }
  }
  function mount(s) {
    unmount();
    if (!s || !editmode.available?.() || !viewOf(s)) return;
    svg = s;
    handles = SIDES.map((side) => {
      const h = document.createElement('button');
      h.type = 'button';
      h.className = `dl-canvas-handle dl-canvas-${side}`;
      h.dataset.side = side;
      h.title = 'drag: more room for the drawing, or less (nothing drawn moves)';
      h.setAttribute('aria-label', `the diagram's room on its ${SAID[side]}`);
      h.addEventListener('mousedown', (e) => e.preventDefault());
      h.addEventListener('click', (e) => e.stopPropagation());
      h.addEventListener('pointerdown', (e) => start(e, side));
      root.appendChild(h);
      return h;
    });
    place();
  }
  function unmount() {
    for (const h of handles) h.remove();
    handles = [];
    svg = null;
  }
  /** The canvas itself selected (not a shape in it): what pictures.js scales by its corners, a diagram. */
  const canvasOf = (t) => { const s = sizedOf(t); return s && s.tagName.toLowerCase() === 'svg' && (t.node ?? t.top) === s ? s : null; };
  editbar.onSelect?.((t) => { if (!drag) mount(t ? canvasOf(t) : null); });
  editmode.onElementEditChange?.(() => { if (!editmode.elementEditOn?.()) unmount(); });
  instance.on?.('slide', () => unmount());

  /** What the svg says now, to put back. */
  const snapshot = (s) => ({ viewBox: s.getAttribute('viewBox'), width: s.getAttribute('width'), height: s.getAttribute('height') });
  function putBack(s, was) {
    for (const [a, v] of Object.entries(was)) { if (v === null) s.removeAttribute(a); else s.setAttribute(a, v); }
  }
  /** The svg drawn with canvas `vb`, its size on the slide following so nothing drawn changes size: what will be written. */
  function apply(s, base, vb) {
    const out = { viewBox: vb };
    s.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    out.width = keptWidth(base.width, base.vb.w, vb.w, base.maxW);
    s.setAttribute('width', String(out.width));
    if (base.height !== null) { out.height = Math.round(base.height * (vb.h / base.vb.h)); s.setAttribute('height', String(out.height)); }
    return out;
  }
  function baseOf(s) {
    const sec = s.closest('section');
    return { vb: viewOf(s), width: widthOf(s), height: heightAttr(s), maxW: contentWidth(s.parentElement), sec, over: overflows(sec), was: snapshot(s) };
  }

  function start(e, side) {
    if (e.button !== 0 || !svg) return;
    e.preventDefault(); e.stopPropagation();
    if (!editmode.available?.()) { toast(editmode.cannot?.('resizing the canvas') ?? 'this page cannot write the deck', 3200); return; }
    const ctm = svg.getScreenCTM?.();
    if (!ctm) return;
    drag = { side, s: svg, x0: e.clientX, y0: e.clientY, ux: ctm.a, uy: ctm.d, art: artOf(svg), base: baseOf(svg), last: null, id: e.pointerId };
    root.classList.add('dl-shape-dragging');
  }
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const vb = edgeCanvas(drag.base.vb, drag.side, (e.clientX - drag.x0) / drag.ux, (e.clientY - drag.y0) / drag.uy, drag.art);
    const prev = snapshot(drag.s);
    const out = apply(drag.s, drag.base, vb);
    // a slide that fit is kept fitting: the last canvas that did
    if (!drag.base.over && overflows(drag.base.sec)) { putBack(drag.s, prev); place(); return; }
    drag.last = out;
    place();
  });
  window.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.id) end(); });
  window.addEventListener('pointercancel', () => { if (drag) { putBack(drag.s, drag.base.was); drag = null; root.classList.remove('dl-shape-dragging'); place(); } });
  async function end() {
    const d = drag;
    drag = null;
    root.classList.remove('dl-shape-dragging');
    if (!d.last) return;
    await save(d.s, d.last, d.base.was, `the canvas, ${SAID[d.side]}`);
    place();
  }

  async function save(s, out, was, what) {
    const at = addressOf(s);
    if (!at) { putBack(s, was); toast('that diagram is the engine’s, not the file’s', 2600); return false; }
    try {
      await commit.post('/deck/edit/element/canvas', { slide: at.slide, index: at.index, path: at.path, tag: 'svg', ...out });
      debugLog('edit', `canvas: slide ${at.slide} element #${at.index} → ${out.viewBox.x} ${out.viewBox.y} ${out.viewBox.w} ${out.viewBox.h}${out.width ? ` · ${out.width} wide` : ''}`);
      return true;
    } catch (e) {
      putBack(s, was);
      toast(commit.notSaved(what, e), 6000);
      return false;
    }
  }

  /** Shape ▸ "Fit the canvas to the drawing": the room round it trimmed to an even margin. */
  async function fit(s) {
    if (!s || !viewOf(s)) return false;
    const art = artOf(s);
    if (!art) { toast('nothing is drawn here yet: there is nothing to fit the canvas to', 2600); return false; }
    const base = baseOf(s);
    const out = apply(s, base, fitCanvas(art));
    const ok = await save(s, out, base.was, 'the canvas');
    if (ok) toast('canvas fitted to the drawing', 1400);
    place();
    return ok;
  }

  return {
    fit,
    /** Is this a diagram whose canvas can be fitted? */
    fits: (s) => !!s && !!viewOf(s) && !s.closest('[data-chart]'),
    /** The edge handles on screen, for the harnesses: `[{ el, side }]`. */
    handles: () => handles.map((el) => ({ el, side: el.dataset.side })),
    place,
  };
}
