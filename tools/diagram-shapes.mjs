// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The shapes and line styles the diagram editor writes (SPEC SVG_DIAGRAMS),
 * pure, and here so the page (src/core/shapes.js) and the server
 * (cli/edit.mjs) agree on every value: cli/ never imports src/, and src/ may
 * import a tool.
 */

/**
 * Line ▸ (solid, dashed, dotted): the `stroke-dasharray` each one writes,
 * inline on the stroke. A dot is a round cap on a dash of nothing, so dotted
 * also writes `stroke-linecap: round`. Solid writes no dashes at all.
 */
export const LINE_DASHES = Object.freeze({ dashed: '6 4', dotted: '0 4' });
export const LINES = Object.freeze(['solid', 'dashed', 'dotted']);

/** What a `stroke-dasharray` draws as: 'dotted' when its dashes are dots, 'dashed', or 'solid'. */
export function lineOf(dashes) {
  const nums = String(dashes ?? '').match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
  if (!nums.some((n) => n > 0)) return 'solid';
  return nums[0] < 1 ? 'dotted' : 'dashed';
}

/** Corners ▸ on a box: square (no `rx`), rounded, or a pill (`rx` half its short side, kept so on a resize). */
export const CORNERS = Object.freeze(['square', 'rounded', 'pill']);

/** The corners a box's attributes `{ width, height, rx, ry }` give it. */
export function cornersOf(b) {
  const r = b.rx ?? b.ry ?? 0;
  if (!(r > 0)) return 'square';
  const short = Math.min(b.width ?? Infinity, b.height ?? Infinity);
  return Number.isFinite(short) && 2 * r >= short - 0.5 ? 'pill' : 'rounded';
}

/** The `rx` (and `ry`) a box of `w` × `h` gets for `corners`: none, a modest curve, or half its short side. */
export function cornerRadius(corners, w, h) {
  const short = Math.min(w, h);
  if (corners === 'pill') { const r = Math.round(short * 5) / 10; return Object.is(r, -0) ? 0 : r; }
  if (corners === 'rounded') return Math.max(2, Math.min(12, Math.round(short / 6)));
  return null;
}

// ── more shapes than a box and an ellipse ──────────────────────────────────

/**
 * The shapes Add a shape offers besides a box, an ellipse, a label and a line
 * (SVG_DIAGRAMS). Each is ONE element marked `data-shape` with its kind, so a
 * resize writes its geometry again for the new box and a wire stops at its
 * outline: a `<polygon>` (diamond, hexagon) or a `<path>` in absolute
 * M, L, C and Z (cylinder, document, note, cloud; the server's path data
 * takes no arcs). Every number of the geometry lies inside its box and some
 * number reaches each edge, so the box is read back from the numbers alone.
 */
export const SHAPES = Object.freeze({
  diamond: 'polygon', hexagon: 'polygon',
  cylinder: 'path', document: 'path', note: 'path', cloud: 'path',
});
/** What a new one says until it is typed into. */
export const SHAPE_LABELS = Object.freeze({
  diamond: 'Decision', hexagon: 'Step', cylinder: 'Store', document: 'Document', note: 'Note', cloud: 'Cloud',
});

/** A number as the file gets it: one decimal at most, never -0 (the server's formatCoord). */
const fmt = (n) => { const r = Math.round(n * 10) / 10; return String(Object.is(r, -0) ? 0 : r); };
/** A quarter ellipse's control-point factor. */
const K = 0.5523;

/**
 * The geometry of a shape of `kind` filling box `{ x, y, w, h }`:
 * `{ tag, attr, value }`, `points` on a polygon and `d` on a path, in the
 * spelling the server writes back (`x,y x,y`; `M 1 2 L 3 4`), so the file
 * and the page agree byte for byte. Null for a kind it does not know.
 */
export function shapeGeometry(kind, box) {
  const tag = SHAPES[kind];
  if (!tag) return null;
  const x = Number(fmt(box.x)); const y = Number(fmt(box.y));
  const w = Math.max(0, Number(fmt(box.w))); const h = Math.max(0, Number(fmt(box.h)));
  const r = x + w; const b = y + h; const cx = x + w / 2; const cy = y + h / 2;
  const P = (pts) => pts.map(([px, py]) => `${fmt(px)},${fmt(py)}`).join(' ');
  const D = (cmds) => cmds.map(([c, ...n]) => [c, ...n.map(fmt)].join(' ')).join(' ');
  switch (kind) {
    case 'diamond': return { tag, attr: 'points', value: P([[cx, y], [r, cy], [cx, b], [x, cy]]) };
    case 'hexagon': {
      const i = Math.min(w * 0.25, h * 0.5);
      return { tag, attr: 'points', value: P([[x + i, y], [r - i, y], [r, cy], [r - i, b], [x + i, b], [x, cy]]) };
    }
    case 'cylinder': {
      // the body and the back of the top rim, then the front of the rim on its own
      const e = Math.min(h * 0.15, w * 0.25); const hx = w / 2;
      const top = (yy) => [['C', x, yy - e * K, cx - hx * K, yy - e, cx, yy - e], ['C', cx + hx * K, yy - e, r, yy - e * K, r, yy]];
      return { tag, attr: 'd', value: D([
        ['M', x, y + e], ...top(y + e), ['L', r, b - e],
        ['C', r, b - e + e * K, cx + hx * K, b, cx, b], ['C', cx - hx * K, b, x, b - e + e * K, x, b - e], ['Z'],
        ['M', x, y + e], ['C', x, y + e + e * K, cx - hx * K, y + 2 * e, cx, y + 2 * e], ['C', cx + hx * K, y + 2 * e, r, y + e + e * K, r, y + e],
      ]) };
    }
    case 'document': {
      // a page whose foot is a wave
      const d = h * 0.12;
      return { tag, attr: 'd', value: D([['M', x, y], ['L', r, y], ['L', r, b - d], ['C', x + w * 0.7, b - 3 * d, x + w * 0.3, b, x, b - d], ['Z']]) };
    }
    case 'note': {
      // a sheet with its top right corner folded down, and the fold
      const f = Math.min(w, h) * 0.22;
      return { tag, attr: 'd', value: D([['M', x, y], ['L', r - f, y], ['L', r, y + f], ['L', r, b], ['L', x, b], ['Z'], ['M', r - f, y], ['L', r - f, y + f], ['L', r, y + f]]) };
    }
    case 'cloud': {
      // eight bumps between points on an inner ellipse, each bulging out to the box
      const n = 8; const ix = w * 0.36; const iy = h * 0.34;
      const at = (k) => { const a = (k / n) * 2 * Math.PI - Math.PI / 2; return [cx + ix * Math.cos(a), cy + iy * Math.sin(a)]; };
      const clampX = (v) => Math.min(r, Math.max(x, v)); const clampY = (v) => Math.min(b, Math.max(y, v));
      const out = (p, a) => [clampX(cx + (p[0] - cx) * a), clampY(cy + (p[1] - cy) * a)];
      const cmds = [['M', ...at(0)]];
      for (let k = 0; k < n; k++) {
        const p = at(k); const q = at(k + 1);
        cmds.push(['C', ...out(p, 1.9), ...out(q, 1.9), ...q]);
      }
      cmds.push(['Z']);
      return { tag, attr: 'd', value: D(cmds) };
    }
    default: return null;
  }
}

/** The numbers of a polygon's `points` or a path's `d`, as `[x, y]` pairs (absolute commands only: H and V read with the pen). */
function pairsOf(attr, value) {
  const src = String(value ?? '');
  if (attr === 'points') {
    const n = src.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    const out = [];
    for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
    return out;
  }
  return flatten(src, { curves: false }).flat();
}

/**
 * The box a shape's geometry fills, `{ x, y, w, h }`, read from its numbers
 * (shapeGeometry keeps every one inside and reaches each edge): what a resize
 * starts from. Null when there are none.
 */
export function shapeBox(attr, value) {
  const pts = pairsOf(attr, value).filter(([a, c]) => Number.isFinite(a) && Number.isFinite(c));
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Path data in absolute M, L, H, V, C, Q and Z as its subpaths, each a list
 * of `[x, y]`: a curve sampled into `steps` points when `curves`, else its
 * control points and its end as they are (the numbers, for shapeBox).
 */
function flatten(d, { curves = true, steps = 10 } = {}) {
  const tokens = String(d ?? '').match(/[MLHVCQZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const subs = []; let cur = null; let pen = [0, 0]; let start = [0, 0]; let cmd = null; let args = [];
  const need = { M: 2, L: 2, H: 1, V: 1, C: 6, Q: 4, Z: 0 };
  const run = () => {
    const c = cmd?.toUpperCase();
    if (!c) return;
    if (c === 'Z') { if (cur) cur.push([...start]); pen = [...start]; return; }
    for (let i = 0; i + need[c] <= args.length && need[c]; i += need[c]) {
      const a = args.slice(i, i + need[c]);
      if (c === 'M' && i === 0) { cur = [[a[0], a[1]]]; subs.push(cur); pen = [a[0], a[1]]; start = [...pen]; continue; }
      cur ??= (subs.push([[...pen]]), subs.at(-1));
      if (c === 'M' || c === 'L') pen = [a[0], a[1]];
      else if (c === 'H') pen = [a[0], pen[1]];
      else if (c === 'V') pen = [pen[0], a[0]];
      if (c === 'M' || c === 'L' || c === 'H' || c === 'V') { cur.push([...pen]); continue; }
      const p0 = pen;
      const ctl = c === 'C' ? [[a[0], a[1]], [a[2], a[3]]] : [[a[0], a[1]]];
      const end = c === 'C' ? [a[4], a[5]] : [a[2], a[3]];
      if (!curves) cur.push(...ctl, end);
      else {
        for (let s = 1; s <= steps; s++) {
          const t = s / steps; const u = 1 - t;
          cur.push(c === 'C'
            ? [u ** 3 * p0[0] + 3 * u * u * t * ctl[0][0] + 3 * u * t * t * ctl[1][0] + t ** 3 * end[0], u ** 3 * p0[1] + 3 * u * u * t * ctl[0][1] + 3 * u * t * t * ctl[1][1] + t ** 3 * end[1]]
            : [u * u * p0[0] + 2 * u * t * ctl[0][0] + t * t * end[0], u * u * p0[1] + 2 * u * t * ctl[0][1] + t * t * end[1]]);
        }
      }
      pen = end;
    }
  };
  for (const tk of tokens) {
    if (/^[MLHVCQZ]$/i.test(tk)) { run(); cmd = tk; args = []; } else args.push(Number(tk));
  }
  run();
  return subs;
}

/** A shape's outline as one closed list of points: its polygon, or the first subpath of its path, curves sampled. */
export function outlineOf(attr, value) {
  if (attr === 'points') return pairsOf('points', value);
  return flatten(value)[0] ?? [];
}

/**
 * Where a ray from `c` toward `p` first leaves `outline` (points, closed):
 * what a wire stops at on a shape that is not a box. Null when the ray
 * meets no edge (c outside it, or an outline of no size).
 */
export function outlineToward(outline, c, p) {
  const dx = p.x - c.x; const dy = p.y - c.y;
  if ((!dx && !dy) || outline.length < 2) return null;
  let best = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const [ax, ay] = outline[i]; const [bx, by] = outline[(i + 1) % outline.length];
    const ex = bx - ax; const ey = by - ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - c.x) * ey - (ay - c.y) * ex) / den;
    const s = ((ax - c.x) * dy - (ay - c.y) * dx) / den;
    if (t > 1e-9 && s >= -1e-9 && s <= 1 + 1e-9 && t < best) best = t;
  }
  return Number.isFinite(best) ? { x: c.x + dx * best, y: c.y + dy * best } : null;
}
