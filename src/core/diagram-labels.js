// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A diagram label that wraps to fit the shape it is on (SPEC SVG_DIAGRAMS).
 *
 * SVG text does not wrap, and only a page can measure text: so the page
 * breaks a label's words into lines that fit its shape, and the file keeps
 * the lines it was given, as positioned `<tspan>`s (each at the text's `x`,
 * a `dy` in `em`, the block centred on the text's `y`), so the diagram
 * renders the same with no runtime (cli/edit.mjs setElementLines writes the
 * same markup the page puts up here). A `<tspan>` with no position is a run
 * inside one line, not a line: a label holding one is left to be edited as
 * it is.
 *
 * What fits is the shape's box narrowed to the part a label can use (a
 * diamond's middle, an ellipse's), less a margin. A label whose words do
 * not fit even wrapped (one word wider than the room, or more lines than
 * the height holds) is OVERFLOWING: write mode marks its shape, and Check
 * deck… lists it.
 */

import { shapeBox } from '../../tools/diagram-shapes.mjs';

/** A label's line height, in em: the server's LINE_HEIGHT_EM. */
export const LINE_EM = 1.2;

/** How much of a shape's box a label may use, across and down, by what the shape is. */
const ROOM = {
  rect: [0.88, 0.86], image: [0.88, 0.86], ellipse: [0.72, 0.7], circle: [0.72, 0.7],
  diamond: [0.56, 0.56], hexagon: [0.7, 0.8], cylinder: [0.88, 0.62], document: [0.88, 0.74],
  note: [0.82, 0.8], cloud: [0.64, 0.6], polygon: [0.7, 0.7], path: [0.8, 0.8],
};
const tagOf = (el) => String(el?.tagName ?? '').toLowerCase();
/** The room a label has on a shape of `kind` (a tag, or a `data-shape`) whose box is `w` × `h`. */
export function roomOf(kind, w, h) {
  const [a, b] = ROOM[kind] ?? ROOM.rect;
  return { w: w * a, h: h * b };
}

/**
 * `text` broken into lines no wider than `max`, by `measure(words) → width`:
 * a line break the author typed stays one, words go on a line while they
 * fit, and a word wider than the room is a line of its own (it overflows).
 * Spaces are collapsed. Returns `{ lines, overflow }`.
 */
export function wrapWords(text, max, measure) {
  const lines = []; let overflow = false;
  for (const hard of String(text ?? '').split(/\r?\n/)) {
    const words = hard.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let cur = words[0];
    if (measure(cur) > max) overflow = true;
    for (const w of words.slice(1)) {
      const next = `${cur} ${w}`;
      if (measure(next) <= max) { cur = next; continue; }
      lines.push(cur);
      cur = w;
      if (measure(w) > max) overflow = true;
    }
    lines.push(cur);
  }
  return { lines, overflow };
}

/** The `dy` of each line of an `n`-line label, in em: the block centred on the text's `y` (the server's spelling). */
export function lineOffsets(n) {
  const first = Math.round((-((n - 1) * LINE_EM) / 2) * 10) / 10;
  return Array.from({ length: n }, (_, i) => (i ? LINE_EM : (Object.is(first, -0) ? 0 : first)));
}

// ── on the page ──────────────────────────────────────────────────────────────

/** A positioned `<tspan>`: a line of a label, not a run inside one. */
const isLine = (t) => tagOf(t) === 'tspan' && (t.hasAttribute('x') || t.hasAttribute('y') || t.hasAttribute('dy'));

/**
 * A `<text>`'s lines as the page has them: its words as one line, or each
 * positioned `<tspan>`'s when that is all it holds. Null when it holds a run
 * or another element (#986's inline runs are edited their own way).
 */
export function linesOf(text) {
  if (tagOf(text) !== 'text') return null;
  const kids = [...text.children];
  if (!kids.length) return [text.textContent.replace(/\s+/g, ' ').trim()];
  if (!kids.every(isLine)) return null;
  // words between the lines would be lost: not lines
  for (const n of text.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return null;
  return kids.map((t) => t.textContent.replace(/\s+/g, ' ').trim());
}

/** The `<text>` a click on a label means: a line's text when the label is lines, else what was clicked. */
export function labelOf(el) {
  const t = tagOf(el) === 'tspan' && tagOf(el.parentElement) === 'text' ? el.parentElement : el;
  return tagOf(t) === 'text' && linesOf(t) ? t : el;
}

/** Put `lines` on `text` as the file has them: words for one line, positioned tspans for more. */
export function setLines(text, lines) {
  const ns = text.namespaceURI;
  text.textContent = '';
  if (lines.length === 1) { text.textContent = lines[0]; return; }
  const x = text.getAttribute('x');
  lineOffsets(lines.length).forEach((dy, i) => {
    const t = document.createElementNS(ns, 'tspan');
    if (x !== null) t.setAttribute('x', x);
    t.setAttribute('dy', `${dy}em`);
    t.textContent = lines[i];
    text.appendChild(t);
  });
}

/** A width measure for `text`'s font, in its own units: a hidden copy, measured. */
function measurer(text) {
  const probe = text.cloneNode(false);
  probe.removeAttribute('id');
  probe.setAttribute('visibility', 'hidden');
  probe.setAttribute('aria-hidden', 'true');
  text.parentNode.insertBefore(probe, text);
  const cache = new Map();
  const measure = (s) => {
    if (!cache.has(s)) { probe.textContent = s; cache.set(s, probe.getComputedTextLength?.() ?? 0); }
    return cache.get(s);
  };
  return { measure, done: () => probe.remove() };
}

/** The kind a shape is for its room: its `data-shape`, else its tag. */
const kindOf = (shape) => shape.getAttribute('data-shape') || tagOf(shape);

/**
 * How `words` fit on `shape` (its box `box`, in the text's own units, which
 * a label in the shape's group shares): `{ lines, overflow }`.
 */
export function fitLabel(text, words, shape, box) {
  const room = roomOf(kindOf(shape), box.w, box.h);
  const m = measurer(text);
  try {
    const { lines, overflow } = wrapWords(words, room.w, m.measure);
    const px = parseFloat(getComputedStyle(text).fontSize) || 16;
    // the font size is in the text's units when the font is in px of the svg's user space
    const tall = lines.length * px * LINE_EM > room.h + 0.5;
    return { lines, overflow: overflow || tall };
  } finally { m.done(); }
}

/** Does `text`'s current line set overflow its shape? (each line measured as it is) */
export function overflows(text, shape, box) {
  const lines = linesOf(text);
  if (!lines) return false;
  const room = roomOf(kindOf(shape), box.w, box.h);
  const m = measurer(text);
  try {
    const px = parseFloat(getComputedStyle(text).fontSize) || 16;
    return lines.some((l) => m.measure(l) > room.w + 0.5) || lines.length * px * LINE_EM > room.h + 0.5;
  } finally { m.done(); }
}

// ── which shape a label is on ────────────────────────────────────────────────

/** The shapes a label can be on, and what the engine adds that never is one. */
const SHAPE_SEL = 'rect, ellipse, circle, polygon, path[data-shape], image';
const NOT_A_SHAPE = '.draw-head, .draw-mask, defs, marker, mask, clipPath, pattern, symbol, [data-ds-injected]';

/** A shape's box in its own coordinates, from the attributes that say it (a marked shape's from its numbers). */
export function ownBox(shape) {
  const n = (a) => { const v = parseFloat(shape.getAttribute(a)); return Number.isFinite(v) ? v : 0; };
  const kind = shape.getAttribute('data-shape');
  if (kind) { const a = tagOf(shape) === 'path' ? 'd' : 'points'; return shapeBox(a, shape.getAttribute(a)); }
  switch (tagOf(shape)) {
    case 'ellipse': return { x: n('cx') - n('rx'), y: n('cy') - n('ry'), w: 2 * n('rx'), h: 2 * n('ry') };
    case 'circle': return { x: n('cx') - n('r'), y: n('cy') - n('r'), w: 2 * n('r'), h: 2 * n('r') };
    case 'rect': case 'image': return { x: n('x'), y: n('y'), w: n('width'), h: n('height') };
    default: { try { const b = shape.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; } catch { return null; } }
  }
}

/** `shape`'s box in `text`'s own units (through whatever transforms stand between them). */
export function boxIn(shape, text) {
  const b = ownBox(shape);
  if (!b) return null;
  const a = shape.getCTM?.(); const t = text.getCTM?.();
  if (!a || !t) return b;
  const m = t.inverse().multiply(a);
  const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
  const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/**
 * The shape a label is on: the shape of the box group it is in, else the
 * smallest shape of its diagram its middle falls inside (a loose label, the
 * way colours find it). Null for a label on the canvas.
 */
export function shapeOfLabel(text) {
  const svg = text.ownerSVGElement;
  if (!svg) return null;
  const g = text.parentElement;
  if (g && g !== svg && tagOf(g) === 'g') {
    const own = [...g.children].filter((c) => c.matches(SHAPE_SEL) && !c.matches(NOT_A_SHAPE));
    if (own.length === 1) return own[0];
  }
  const r = text.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
  let best = null; let area = Infinity;
  for (const s of svg.querySelectorAll(SHAPE_SEL)) {
    if (s.closest(NOT_A_SHAPE)) continue;
    const b = s.getBoundingClientRect();
    if (cx < b.left || cx > b.right || cy < b.top || cy > b.bottom) continue;
    const a = b.width * b.height;
    if (a > 0 && a < area) { area = a; best = s; }
  }
  return best;
}

/** How `words` fit the shape `text` is on: `{ lines, overflow }`, or null for a label on no shape. */
export function fitOnShape(text, words) {
  const shape = shapeOfLabel(text);
  const box = shape && boxIn(shape, text);
  return box && box.w > 0 ? fitLabel(text, words, shape, box) : null;
}

/** The labels in `scope` that do not fit their shape, even wrapped: `[{ text, shape }]`. Measure a shown slide. */
export function overflowingLabels(scope) {
  const out = [];
  for (const text of scope.querySelectorAll('svg text')) {
    if (text.closest(`${NOT_A_SHAPE}, [data-chart], .terminal, aside`)) continue;
    const shape = shapeOfLabel(text);
    const box = shape && boxIn(shape, text);
    if (box && box.w > 0 && overflows(text, shape, box)) out.push({ text, shape });
  }
  return out;
}
