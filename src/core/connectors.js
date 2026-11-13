// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Connectors: a diagram's wires that stay attached to what they join
 * (SPEC SVG_DIAGRAMS).
 *
 * THE FILE CONTRACT. A shape, or a group that is a box, names itself
 * `data-node="<name>"` (never an `id`: ids are namespaced at init, and a
 * reference to one would need rewriting with it). A wire, a `<line>`, a
 * `<path>` or a `<polyline>`, says `data-from="<name>" data-to="<name>"`
 * within the same `<svg>`, and optionally `data-route="straight|elbow|curve"`
 * (straight without one). The wire keeps real coordinates in the file, so a
 * deck read without the runtime, a print, an export and an agent all see a
 * wire drawn where it goes. One end may be named and the other not: the free
 * end stays where the file puts it.
 *
 * THE ENGINE ROUTES AT LOAD, before a draw build measures the stroke
 * (builds.js scanSlide), so a connector that draws still draws, its
 * arrowhead riding the tip. Each node's box is read in the WIRE's coordinate
 * space: the shape's own geometry from its attributes (a slide is prepared
 * while it is hidden, where the browser measures nothing; only a label or a
 * path asks the browser, and is estimated when it cannot answer), carried
 * through every `transform` attribute between the two. A build's CSS
 * transform is not an attribute and is not read, so a box waiting at
 * `scale(0)` is joined where it will land. A group's box is the union of the
 * shapes in it, its labels left out unless it has nothing else. A wire whose
 * node is missing is left as the file has it.
 *
 *   straight  from edge to edge along the line between the two centres: a
 *             box's edge, an ellipse's or a circle's boundary
 *   elbow     an orthogonal path between the nearest sides: two segments
 *             when the boxes are apart on both axes, else three
 *   curve     one cubic between those sides, leaving and arriving square
 *
 * A `<line>` can only be straight (the editor turns it into a `<path>` when
 * it is routed otherwise), and a `<polyline>` cannot curve.
 *
 * Everything here reads elements through `tagName`, `getAttribute`,
 * `parentElement` and `children` alone (and `getBBox` where it can), so the
 * geometry is unit-tested without a browser.
 */

import { outlineOf, outlineToward, flatten } from '../../tools/diagram-shapes.mjs';

// ── matrices ─────────────────────────────────────────────────────────────────

export const IDENTITY = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

/** `m · n`: `n` applied first, then `m`. */
export function multiply(m, n) {
  return {
    a: m.a * n.a + m.c * n.b, b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d, d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e, f: m.b * n.e + m.d * n.f + m.f,
  };
}
export function invert(m) {
  const det = m.a * m.d - m.b * m.c;
  if (!det || !Number.isFinite(det)) return null;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, e: (m.c * m.f - m.d * m.e) / det, f: (m.b * m.e - m.a * m.f) / det };
}
export const applyTo = (m, p) => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });

/** A `transform` attribute as one matrix: `matrix`, `translate`, `scale`, `rotate` (about a point too), `skewX`, `skewY`. */
export function parseTransform(text) {
  let m = IDENTITY;
  for (const [, fn, args] of String(text ?? '').matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi)) {
    const v = args.split(/[\s,]+/).filter(Boolean).map(Number);
    if (v.some((n) => !Number.isFinite(n))) continue;
    let t = null;
    switch (fn.toLowerCase()) {
      case 'matrix': if (v.length === 6) t = { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] }; break;
      case 'translate': t = { ...IDENTITY, e: v[0] ?? 0, f: v[1] ?? 0 }; break;
      case 'scale': t = { ...IDENTITY, a: v[0] ?? 1, d: v[1] ?? v[0] ?? 1 }; break;
      case 'rotate': {
        const r = ((v[0] ?? 0) * Math.PI) / 180;
        t = { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: 0, f: 0 };
        if (v.length >= 3) t = multiply(multiply({ ...IDENTITY, e: v[1], f: v[2] }, t), { ...IDENTITY, e: -v[1], f: -v[2] });
        break;
      }
      case 'skewx': t = { ...IDENTITY, c: Math.tan(((v[0] ?? 0) * Math.PI) / 180) }; break;
      case 'skewy': t = { ...IDENTITY, b: Math.tan(((v[0] ?? 0) * Math.PI) / 180) }; break;
      default: break;
    }
    if (t) m = multiply(m, t);
  }
  return m;
}

const axisAligned = (m) => Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9;

/** A box `{ x, y, w, h, round }` carried through `m`: the box around its four corners (round only while nothing turns it). */
export function boxThrough(m, box) {
  const pts = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x, y]) => applyTo(m, { x, y }));
  const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, round: !!box.round && axisAligned(m) };
}
/** The box around several. */
export function union(boxes) {
  const x = Math.min(...boxes.map((b) => b.x)); const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y, round: false };
}

// ── routes, pure ─────────────────────────────────────────────────────────────

export const ROUTES = ['straight', 'elbow', 'curve'];
export const centreOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/**
 * Where a ray from the middle of `b` toward `p` leaves it: a box's edge, or
 * an ellipse's boundary when `b.round`. A box of no size is a point, and is
 * its own answer.
 */
export function edgeToward(b, p) {
  const c = centreOf(b);
  const dx = p.x - c.x; const dy = p.y - c.y;
  if (!(b.w > 0 || b.h > 0) || (!dx && !dy)) return c;
  // a shape that is neither a box nor an ellipse (a diamond, a cylinder): its own outline
  const hit = b.outline ? outlineToward(b.outline, c, p) : null;
  if (hit) return hit;
  let t;
  if (b.round && b.w > 0 && b.h > 0) t = 1 / Math.hypot(dx / (b.w / 2), dy / (b.h / 2));
  else t = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** The two ends of a straight connector: each box's edge on the line between the centres. */
export function routeStraight(a, b) {
  return [edgeToward(a, centreOf(b)), edgeToward(b, centreOf(a))];
}

/** How far apart two boxes are on each axis (negative: they overlap on it). */
const gapsOf = (a, b) => ({
  x: Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)),
  y: Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)),
});
/** The sides of two boxes that face each other: a's and b's x on the vertical sides, y on the horizontal ones. */
function facing(a, b) {
  const ca = centreOf(a); const cb = centreOf(b);
  const right = cb.x >= ca.x; const down = cb.y >= ca.y;
  return { ca, cb, ax: right ? a.x + a.w : a.x, bx: right ? b.x : b.x + b.w, ay: down ? a.y + a.h : a.y, by: down ? b.y : b.y + b.h };
}
/** Points with the repeats and the stops in the middle of a straight run taken out. */
function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const last = out.at(-1);
    if (last && Math.abs(last.x - p.x) < 0.05 && Math.abs(last.y - p.y) < 0.05) continue;
    const prev = out.at(-2);
    if (prev && last && Math.abs((last.x - prev.x) * (p.y - last.y) - (last.y - prev.y) * (p.x - last.x)) < 0.01) out.pop();
    out.push(p);
  }
  return out;
}

/**
 * An orthogonal route between the nearest sides: apart on both axes, two
 * segments (out of a's side toward b, then square into b's); apart on one,
 * three (out, across halfway, in). Boxes that overlap on both are joined
 * straight.
 */
export function routeElbow(a, b) {
  const g = gapsOf(a, b);
  const { ca, cb, ax, bx, ay, by } = facing(a, b);
  let pts;
  if (g.x > 0 && g.y > 0) {
    pts = g.x >= g.y
      ? [{ x: ax, y: ca.y }, { x: cb.x, y: ca.y }, { x: cb.x, y: by }]
      : [{ x: ca.x, y: ay }, { x: ca.x, y: cb.y }, { x: bx, y: cb.y }];
  } else if (g.x > 0) {
    const mx = (ax + bx) / 2;
    pts = [{ x: ax, y: ca.y }, { x: mx, y: ca.y }, { x: mx, y: cb.y }, { x: bx, y: cb.y }];
  } else if (g.y > 0) {
    const my = (ay + by) / 2;
    pts = [{ x: ca.x, y: ay }, { x: ca.x, y: my }, { x: cb.x, y: my }, { x: cb.x, y: by }];
  } else return routeStraight(a, b);
  return simplify(pts);
}

/**
 * One cubic between the sides an elbow would use, leaving a square to its
 * side and arriving square to b's: `{ from, c1, c2, to }`.
 */
export function routeCurve(a, b) {
  const g = gapsOf(a, b);
  const { ca, cb, ax, bx, ay, by } = facing(a, b);
  const across = g.x > 0 || g.y > 0 ? g.x >= g.y : Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y);
  if (across) {
    const from = { x: ax, y: ca.y }; const to = { x: bx, y: cb.y };
    const k = Math.max(Math.abs(to.x - from.x) / 2, 12) * (cb.x >= ca.x ? 1 : -1);
    return { from, c1: { x: from.x + k, y: from.y }, c2: { x: to.x - k, y: to.y }, to };
  }
  const from = { x: ca.x, y: ay }; const to = { x: cb.x, y: by };
  const k = Math.max(Math.abs(to.y - from.y) / 2, 12) * (cb.y >= ca.y ? 1 : -1);
  return { from, c1: { x: from.x, y: from.y + k }, c2: { x: to.x, y: to.y - k }, to };
}

/** A coordinate as the file gets it: one decimal at most, never -0 (the server's formatCoord). */
export const fmt = (n) => { const r = Math.round(n * 10) / 10; return String(Object.is(r, -0) ? 0 : r); };
/** Points as a path's data, absolute: `M x y L x y …`. */
export const pathOfPoints = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'} ${fmt(p.x)} ${fmt(p.y)}`).join(' ');
/** A cubic as a path's data: `M x y C x y x y x y`. */
export const pathOfCurve = ({ from, c1, c2, to }) => `M ${fmt(from.x)} ${fmt(from.y)} C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(to.x)} ${fmt(to.y)}`;
/** Points as a polyline's `points`: `x,y x,y`. */
export const pointsOf = (pts) => pts.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ');

/** The tag a wire is once routed `route`: a line that bends becomes a path, and so does a polyline that curves. */
export const tagForRoute = (tag, route) => ((tag === 'line' && route !== 'straight') || (tag === 'polyline' && route === 'curve') ? 'path' : tag);

/**
 * The attributes a wire of `tag` gets for a `route` from box `a` to box `b`
 * (each `{ x, y, w, h, round }` in the wire's space; a point is a box of no
 * size): `{ x1, y1, x2, y2 }` on a line, `{ points }` on a polyline, `{ d }`
 * on a path. A line is straight whatever it is asked, a polyline never curves.
 */
export function geometryFor(tag, route, a, b) {
  const r = tag === 'line' ? 'straight' : tag === 'polyline' && route === 'curve' ? 'elbow' : route;
  if (r === 'curve') return { d: pathOfCurve(routeCurve(a, b)) };
  const pts = r === 'elbow' ? routeElbow(a, b) : routeStraight(a, b);
  if (tag === 'line') return { x1: fmt(pts[0].x), y1: fmt(pts[0].y), x2: fmt(pts.at(-1).x), y2: fmt(pts.at(-1).y) };
  if (tag === 'polyline') return { points: pointsOf(pts) };
  return { d: pathOfPoints(pts) };
}

/**
 * Where a wire starts and ends, `{ start, end }`, read from its geometry:
 * a line's ends, a polyline's first and last points, a path's first moveto
 * and the point its last command leaves the pen at (relative commands and
 * arcs followed). `get(name)` reads an attribute. Null when it says nothing.
 */
export function endsOf(tag, get) {
  const n = (a) => { const v = parseFloat(get(a)); return Number.isFinite(v) ? v : 0; };
  if (tag === 'line') return { start: { x: n('x1'), y: n('y1') }, end: { x: n('x2'), y: n('y2') } };
  if (tag === 'polyline' || tag === 'polygon') {
    const v = String(get('points') ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (v.length < 4 || v.some((x) => !Number.isFinite(x))) return null;
    return { start: { x: v[0], y: v[1] }, end: { x: v.at(-2), y: v.at(-1) } };
  }
  if (tag !== 'path') return null;
  const ARGS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  const tokens = String(get('d') ?? '').match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let cmd = null; let start = null; let x = 0; let y = 0; let sub = { x: 0, y: 0 }; let args = [];
  const step = () => {
    const c = cmd.toLowerCase(); const rel = cmd !== cmd.toUpperCase();
    const ox = rel ? x : 0; const oy = rel ? y : 0;
    if (c === 'h') x = ox + args[0];
    else if (c === 'v') y = oy + args[0];
    else { x = ox + args.at(-2); y = oy + args.at(-1); }
    if (c === 'm') { sub = { x, y }; start ??= { x, y }; cmd = rel ? 'l' : 'L'; }
    args = [];
  };
  for (const t of tokens) {
    if (/^[a-zA-Z]$/.test(t)) {
      cmd = t;
      if (!(t.toLowerCase() in ARGS)) return null;
      if (t.toLowerCase() === 'z') { x = sub.x; y = sub.y; }
      continue;
    }
    if (!cmd || cmd.toLowerCase() === 'z') return null;
    args.push(Number(t));
    if (args.length === ARGS[cmd.toLowerCase()]) step();
  }
  return start ? { start, end: { x, y } } : null;
}

// ── the elements ─────────────────────────────────────────────────────────────

const tagOf = (el) => String(el?.tagName ?? '').toLowerCase();
export const WIRE_TAGS = new Set(['line', 'path', 'polyline']);
const NOT_DRAWN = new Set(['defs', 'marker', 'mask', 'clippath', 'pattern', 'symbol', 'lineargradient', 'radialgradient', 'filter', 'style', 'title', 'desc', 'metadata']);
const SHAPES = new Set(['rect', 'circle', 'ellipse', 'image', 'use', 'foreignobject', 'line', 'polyline', 'polygon', 'path']);
/** Nodes the engine made beside the author's: a riding head, a dash's mask. */
const ENGINE_CLASS = /(?:^|\s)(?:draw-head|draw-mask)(?:\s|$)/;

/** Is `el` (or something it sits in, below its svg) not the author's drawing: a marker, a mask, an engine copy? */
export function outsideDrawing(el) {
  for (let n = el; n && tagOf(n) !== 'svg'; n = n.parentElement) {
    if (NOT_DRAWN.has(tagOf(n)) || ENGINE_CLASS.test(n.getAttribute?.('class') ?? '')) return true;
  }
  return false;
}
/** The svg an element is drawn in. */
export function svgOf(el) {
  for (let n = el?.parentElement; n; n = n.parentElement) if (tagOf(n) === 'svg') return n;
  return null;
}
function* below(el) {
  for (const c of el.children ?? []) { yield c; yield* below(c); }
}
/** Is `el` a connector: a wire that names a node at one end or both? */
export const isConnector = (el) => WIRE_TAGS.has(tagOf(el)) && (el.hasAttribute?.('data-from') || el.hasAttribute?.('data-to')) && !outsideDrawing(el);
/** Every connector in `scope` (an svg, a slide, a stage). */
export function connectorsIn(scope) {
  if (!scope) return [];
  return [...(tagOf(scope) === 'svg' || WIRE_TAGS.has(tagOf(scope)) ? [scope] : []), ...below(scope)].filter(isConnector);
}
/** The node of `svg` named `name`, or null. */
export function nodeNamed(svg, name) {
  if (!svg || !name) return null;
  for (const n of below(svg)) if (n.getAttribute?.('data-node') === name && !outsideDrawing(n) && svgOf(n) === svg) return n;
  return null;
}
/** The connectors of `svg` with an end on `node` or on a node inside it. */
export function connectorsOf(svg, node) {
  const names = new Set([node, ...below(node)].map((n) => n.getAttribute?.('data-node')).filter(Boolean));
  return connectorsIn(svg).filter((w) => names.has(w.getAttribute('data-from')) || names.has(w.getAttribute('data-to')));
}

/** Every transform from `svg` down to `el`, `el`'s own included, as one matrix. */
export function toRoot(el, svg = svgOf(el)) {
  const chain = [];
  for (let n = el; n && n !== svg; n = n.parentElement) chain.unshift(n);
  return chain.reduce((m, n) => multiply(m, parseTransform(n.getAttribute?.('transform'))), IDENTITY);
}

const numAttr = (el, a, dflt = 0) => { const v = parseFloat(el.getAttribute(a)); return Number.isFinite(v) ? v : dflt; };
/** What the browser measures, when it can: nothing on a hidden slide. */
function measured(el) {
  try {
    const b = el.getBBox?.();
    if (b && (b.width > 0 || b.height > 0)) return { x: b.x, y: b.y, w: b.width, h: b.height };
  } catch { /* not rendered */ }
  return null;
}
/** A label's box without a browser: its font size, its length, its anchor and its baseline. */
function textBox(el) {
  const cs = typeof getComputedStyle === 'function' && el.nodeType === 1 ? getComputedStyle(el) : null;
  const fs = numAttr(el, 'font-size', parseFloat(cs?.fontSize) || 16);
  const w = 0.55 * fs * String(el.textContent ?? '').trim().length;
  const anchor = el.getAttribute('text-anchor') ?? cs?.textAnchor ?? 'start';
  const base = el.getAttribute('dominant-baseline') ?? cs?.dominantBaseline ?? 'auto';
  const x = numAttr(el, 'x'); const y = numAttr(el, 'y');
  const top = /central|middle/.test(base) ? y - fs / 2 : /hanging|text-before-edge/.test(base) ? y : y - 0.8 * fs;
  return { x: anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x, y: top, w, h: fs };
}
/** The points a polyline or a polygon passes, or the ones a path's data names. */
function pointsBox(nums) {
  if (nums.length < 2) return null;
  const xs = nums.filter((_, i) => i % 2 === 0); const ys = nums.filter((_, i) => i % 2 === 1);
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** A shape's box in its own coordinates, `{ x, y, w, h, round }`, from its attributes where they say it. */
export function localBox(el) {
  const n = (a) => numAttr(el, a);
  switch (tagOf(el)) {
    case 'rect': case 'image': case 'use': case 'foreignobject': {
      const w = n('width'); const h = n('height');
      if (w > 0 || h > 0) return { x: n('x'), y: n('y'), w, h, round: false };
      return measured(el);
    }
    case 'circle': return { x: n('cx') - n('r'), y: n('cy') - n('r'), w: 2 * n('r'), h: 2 * n('r'), round: true };
    case 'ellipse': return { x: n('cx') - n('rx'), y: n('cy') - n('ry'), w: 2 * n('rx'), h: 2 * n('ry'), round: true };
    case 'line': return pointsBox([n('x1'), n('y1'), n('x2'), n('y2')]);
    case 'polyline': case 'polygon': return pointsBox(String(el.getAttribute('points') ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite));
    case 'path': {
      const m = measured(el);
      if (m) return m;
      // a hidden path: the box of the numbers it names, a fair outline for a shape drawn in absolute coordinates
      const nums = (String(el.getAttribute('d') ?? '').match(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
      return pointsBox(nums);
    }
    case 'text': return measured(el) ?? textBox(el);
    default: return null;
  }
}

/**
 * A node's box in the space `space` (the inverse of the wire's own matrix,
 * toRoot): a shape's own box through every transform between, a group's the
 * union of the shapes in it (its labels only when it holds nothing else, and
 * never a connector), round when it is one ellipse or circle.
 */
export function nodeBox(node, space, svg = svgOf(node)) {
  const kids = SHAPES.has(tagOf(node)) || tagOf(node) === 'text' ? [node]
    : [...below(node)].filter((k) => (SHAPES.has(tagOf(k)) || tagOf(k) === 'text') && !outsideDrawing(k) && !isConnector(k));
  const shapes = kids.filter((k) => tagOf(k) !== 'text');
  const boxes = (shapes.length ? shapes : kids).map((k) => {
    const b = localBox(k);
    if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
    const m = multiply(space, toRoot(k, svg));
    const out = boxThrough(m, b);
    // a shape marked with its kind (a diamond, a cylinder…): a wire stops at its outline, not at its box
    const geom = k.hasAttribute?.('data-shape') ? (tagOf(k) === 'polygon' ? 'points' : tagOf(k) === 'path' ? 'd' : null) : null;
    if (geom) {
      const line = outlineOf(geom, k.getAttribute(geom)).map(([x, y]) => applyTo(m, { x, y })).map((q) => [q.x, q.y]);
      if (line.length > 2) out.outline = line;
    }
    return out;
  }).filter(Boolean);
  if (!boxes.length) return null;
  return boxes.length === 1 ? boxes[0] : union(boxes);
}

/** The route a wire asks for. */
export const routeOf = (wire) => (ROUTES.includes(wire.getAttribute('data-route')) ? wire.getAttribute('data-route') : 'straight');

/**
 * The geometry a wire should have, `{ x1, y1, x2, y2 }`, `{ points }` or
 * `{ d }`, or null when it cannot be known (a node it names is missing: the
 * file's coordinates stand). Each end is the node the wire names, or, free,
 * the point its geometry has there; `from` and `to` stand in for an end (a
 * node element, or a point `{ x, y }` in the wire's space: a drag), `route`
 * for its route and `tag` for the element it is to be.
 */
export function wireGeometry(wire, { from, to, route, tag } = {}) {
  const svg = svgOf(wire);
  if (!svg) return null;
  const space = invert(toRoot(wire, svg));
  if (!space) return null;
  const own = endsOf(tagOf(wire), (a) => wire.getAttribute(a));
  const box = (attr, override, ownPoint) => {
    if (override && typeof override.getAttribute === 'function') return nodeBox(override, space, svg);
    if (override && Number.isFinite(override.x)) return { x: override.x, y: override.y, w: 0, h: 0, round: false };
    const name = wire.getAttribute(attr);
    if (name) { const n = nodeNamed(svg, name); return n ? nodeBox(n, space, svg) : null; }
    return ownPoint ? { ...ownPoint, w: 0, h: 0, round: false } : null;
  };
  const a = box('data-from', from, own?.start);
  const b = box('data-to', to, own?.end);
  if (!a || !b) return null;
  return geometryFor(tag ?? tagOf(wire), route ?? routeOf(wire), a, b);
}

/** Put `geom` on the wire; true when anything changed. */
export function setGeometry(wire, geom) {
  let changed = false;
  for (const [k, v] of Object.entries(geom ?? {})) {
    if (wire.getAttribute(k) === v) continue;
    wire.setAttribute(k, v);
    changed = true;
  }
  return changed;
}

/** Route one connector where it stands; true when its geometry changed. */
export function routeWire(wire, opts) {
  const g = wireGeometry(wire, opts);
  const changed = !!g && setGeometry(wire, g);
  placeWireLabels(wire);
  return changed;
}

// ── a label on a wire (SVG_DIAGRAMS) ─────────────────────────────────────────

/** A wire as the points it runs through, in its own coordinates: a line's ends, a polyline's points, a path's, its curves followed. */
export function wirePoints(wire) {
  const tag = tagOf(wire);
  const n = (a) => { const v = parseFloat(wire.getAttribute(a)); return Number.isFinite(v) ? v : 0; };
  if (tag === 'line') return [[n('x1'), n('y1')], [n('x2'), n('y2')]];
  if (tag === 'polyline') {
    const v = String(wire.getAttribute('points') ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
    const out = [];
    for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i], v[i + 1]]);
    return out;
  }
  return flatten(wire.getAttribute('d') ?? '', { steps: 16 })[0] ?? [];
}
/** The point a fraction `t` (0 to 1) of the way along `pts`, by length. */
export function pointAlong(pts, t) {
  if (!pts.length) return { x: 0, y: 0 };
  const seg = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  const total = seg.reduce((a, b) => a + b, 0);
  let left = Math.min(1, Math.max(0, t)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (left <= seg[i] || i === seg.length - 1) {
      const f = seg[i] ? Math.min(1, left / seg[i]) : 0;
      return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f };
    }
    left -= seg[i];
  }
  return { x: pts[0][0], y: pts[0][1] };
}
/** The fraction along `pts` (0 to 1, by length) of the point on it nearest `p`. */
export function nearestAlong(pts, p) {
  const seg = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]));
  const total = seg.reduce((a, b) => a + b, 0);
  if (!total) return 0.5;
  let best = Infinity; let at = 0; let run = 0;
  for (let i = 0; i < seg.length; i++) {
    const [ax, ay] = pts[i]; const [bx, by] = pts[i + 1];
    const L = seg[i] ** 2;
    const f = L ? Math.min(1, Math.max(0, ((p.x - ax) * (bx - ax) + (p.y - ay) * (by - ay)) / L)) : 0;
    const d = Math.hypot(ax + (bx - ax) * f - p.x, ay + (by - ay) * f - p.y);
    if (d < best) { best = d; at = (run + seg[i] * f) / total; }
    run += seg[i];
  }
  return at;
}
/** How far along its wire a label sits: its `data-along`, else halfway. */
export const alongOf = (label) => { const v = parseFloat(label.getAttribute('data-along')); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5; };
/** The labels on a wire (texts of its svg whose `data-on-wire` is its `data-wire`). */
export function wireLabels(wire) {
  const name = wire.getAttribute?.('data-wire');
  const svg = name ? svgOf(wire) : null;
  return svg ? [...below(svg)].filter((n) => tagOf(n) === 'text' && n.getAttribute('data-on-wire') === name && !outsideDrawing(n)) : [];
}
/**
 * Each label on `wire` put where it says it sits along it, in the label's own
 * coordinates (it may be in another group), its lines' `x` with it: what keeps
 * a label on its wire when the wire's ends move or its route changes. True
 * when one moved.
 */
export function placeWireLabels(wire) {
  const labels = wireLabels(wire);
  if (!labels.length) return false;
  const svg = svgOf(wire);
  const pts = wirePoints(wire);
  let moved = false;
  for (const l of labels) {
    const into = invert(toRoot(l, svg));
    if (!into) continue;
    const q = applyTo(multiply(into, toRoot(wire, svg)), pointAlong(pts, alongOf(l)));
    const x = fmt(q.x); const y = fmt(q.y);
    if (l.getAttribute('x') !== x || l.getAttribute('y') !== y) moved = true;
    l.setAttribute('x', x); l.setAttribute('y', y);
    for (const t of l.children ?? []) if (tagOf(t) === 'tspan' && t.hasAttribute('x')) t.setAttribute('x', x);
  }
  return moved;
}

/** Route every connector in `scope`: the ones whose geometry changed. */
export function routeConnectors(scope) {
  return connectorsIn(scope).filter((w) => routeWire(w));
}
