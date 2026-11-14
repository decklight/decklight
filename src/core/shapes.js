// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A diagram's shapes, moved, resized, added and duplicated in write mode
 * (SPEC SVG_DIAGRAMS, PRESENTING_EDITING).
 *
 * Write mode could select a box, a wire or a label inside an authored
 * `<svg>` (pick.js), recolour it, retype it and delete it, but not put it
 * somewhere else: every nudge was a trip to the HTML. Now:
 *
 *   MOVE. A selected node drags (a plain click still selects: the drag only
 *   starts a few pixels out). It moves live, and the release is ONE write,
 *   in the geometry the node already uses: `x`/`y` on a rect, a label, an
 *   image, a `<use>`; `cx`/`cy` on a circle or an ellipse; both ends of a
 *   line; a translate merged into the `transform` of a group, a path or a
 *   polygon. A box's labels go with it: a group that is one shape and its
 *   labels moves whole, and a shape whose labels sit loose beside it takes
 *   the ones on it along. The pointer goes through the inverse screen
 *   matrix, so a scaled stage and a viewBox both come out right, and ⇧
 *   holds the move to one axis. Nothing leaves the canvas: an svg draws
 *   nothing past its viewBox, so a move, a resize handle and a wire's end
 *   all stop at its edge (clampStep, clampPoint).
 *
 *   RESIZE. A selected rect, ellipse, circle or image (or a box group's
 *   shape) wears handles; a line wears one at each end. A label centred on a
 *   box stays centred on it.
 *
 *   ADD and DUPLICATE, from the element menu: the server writes the markup
 *   (cli/edit.mjs) and hands it back, and this page puts the very same node
 *   on the slide, selected, a new box or label straight into its words.
 *
 * Every write is quiet (the page already shows it) and other pages are told.
 * What the engine drew from a moved shape (a riding arrowhead, a dashed
 * line's mask, a nested fill's tone) is drawn again for it. A build step owns
 * its transform (the build's CSS sets it), so a step that could only move by
 * a translate is not moved: a group that is a step moves what it holds.
 *
 *   CONNECT (connectors.js has the file contract and the routing). A
 *   selected box or shape shows a dot on each side; a drag from one draws a
 *   wire after the pointer, the node under it lit, and a drop on one writes
 *   a connector (`POST /deck/edit/element/connector`, the server naming the
 *   two nodes and owning the markup). A move, a resize or a Duplicate routes
 *   the connectors again live, and their geometry goes in the SAME write as
 *   the move. A selected wire's ends drag: onto a node it is (re)attached,
 *   onto the canvas an attached end lets go where it is dropped, and a
 *   hand-drawn line becomes a connector the same way. The element menu's
 *   Wire ▸ (Route, Arrows, Reverse) is here too.
 *
 *   GUIDES. While a shape is dragged or resized, a thin accent line shows
 *   where its edges or its middle line up with another shape's in the same
 *   svg, and it snaps to them within a few units (⌘/Ctrl held: no snap).
 */

import { pathFrom } from './colorpicker.js';
import { injectedIn, isDrawn, isGroup, nodeForClick } from './pick.js';
import { createEditCommit } from './edit-commit.js';
import { clearBuildMarks } from './builds.js';
import { orderGroups } from './buildlist.js';
import { addressOf } from './build-edit.js';
import { linesOf, setLines, fitOnShape, overflowingLabels } from './diagram-labels.js';
import { LINE_DASHES, LINES, lineOf, CORNERS, cornersOf, cornerRadius, SHAPES, shapeGeometry, shapeBox } from '../../tools/diagram-shapes.mjs';
import {
  IDENTITY, WIRE_TAGS, connectorsIn, isConnector, nodeNamed, nodeBox, endsOf, geometryFor, wireGeometry, setGeometry,
  routeOf, tagForRoute, svgOf, invert, toRoot, union, applyTo, boxThrough,
  wirePoints, pointAlong, nearestAlong, wireLabels, placeWireLabels,
} from './connectors.js';

/** Nodes in the page that are not in the file: the engine's and a template's. */
const ENGINE_NODES = '.draw-head, .draw-mask, [data-ds-injected]';
/** A shape a label can sit on. */
const BOX_SHAPES = new Set(['rect', 'circle', 'ellipse', 'image', 'polygon', 'path']);
const NUMERIC = /^\s*-?\d+(?:\.\d+)?\s*$/;
/** How far the pointer goes before a press becomes a drag, in screen px. */
const DRAG_AFTER = 4;
/** How near, in screen px, a line has to come to another to snap to it (GUIDES). */
const SNAP_PX = 6;
/** A wire's own geometry, by the element it is, and the two that are text, not a number. */
const WIRE_GEOMETRY = ['x1', 'y1', 'x2', 'y2', 'd', 'points'];
const SHAPE_DATA = new Set(['d', 'points']);
/** A node's four connection dots, and how far off its sides they stand, in screen px. */
const SIDES = ['top', 'right', 'bottom', 'left'];
const DOT_OFF = 16;
/** How near its edge, in screen px, a wire's end has to come to join a panel (a node holding others). */
const PANEL_EDGE = 10;
/** The smallest a resize leaves a shape, in its own units. */
const MIN_SIZE = 4;

// ── the arithmetic, pure ─────────────────────────────────────────────────────

/** A coordinate as the file gets it: one decimal at most, never -0. */
export const round1 = (n) => { const r = Math.round(n * 10) / 10; return Object.is(r, -0) ? 0 : r; };
/** A moved coordinate in the grain of the one it was: an integer stays an integer. */
export const keepGrain = (orig, n) => (Number.isInteger(orig) ? (Object.is(Math.round(n), -0) ? 0 : Math.round(n)) : round1(n));

const LEADING_TRANSLATE = /^\s*translate\(\s*([^)]*)\)\s*/i;
/** The leading `translate()` of a `transform`, `{ x, y }`. */
export function leadingTranslate(transform) {
  const m = LEADING_TRANSLATE.exec(String(transform ?? ''));
  if (!m) return { x: 0, y: 0 };
  const [a = 0, b = 0] = m[1].split(/[\s,]+/).filter(Boolean).map(Number);
  return { x: Number.isFinite(a) ? a : 0, y: Number.isFinite(b) ? b : 0 };
}
/** `transform` with its leading translate made (x, y), the rest kept — what the server writes (withTranslate). */
export function setTranslate(transform, x, y) {
  const t = String(transform ?? '');
  const m = LEADING_TRANSLATE.exec(t);
  const rest = (m ? t.slice(m[0].length) : t).trim();
  const sep = m && m[1].includes(',') ? ', ' : ' ';
  const tr = x === 0 && y === 0 ? '' : `translate(${round1(x)}${sep}${round1(y)})`;
  return [tr, rest].filter(Boolean).join(' ');
}

/** A screen-space step as a step in the space `inv` (an inverse screen matrix) maps to: its linear part only. */
export const localStep = (inv, dx, dy) => ({ x: inv.a * dx + inv.c * dy, y: inv.b * dx + inv.d * dy });

/** A diagram's canvas: the `viewBox` of its svg as a box `{ x, y, w, h }`, or null when it has none. */
export function viewOf(svg) {
  const v = String(svg?.getAttribute?.('viewBox') ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  return v.length === 4 && v.every(Number.isFinite) && v[2] > 0 && v[3] > 0 ? { x: v[0], y: v[1], w: v[2], h: v[3] } : null;
}
/** `p` held inside `view`: past an edge, the nearest point on it. Itself where there is no view. */
export function clampPoint(p, view) {
  if (!view) return p;
  return { x: Math.min(Math.max(p.x, view.x), view.x + view.w), y: Math.min(Math.max(p.y, view.y), view.y + view.h) };
}
/**
 * The step `d` (`{ x, y }`) a `box` may take and stay inside `view`. A box
 * that already pokes out of an edge (an old deck's) is not pulled in: it
 * just goes no further out on that side.
 */
export function clampStep(box, d, view) {
  if (!view || !box) return d;
  const lim = (v, lo, hi) => Math.min(Math.max(v, Math.min(lo, 0)), Math.max(hi, 0));
  return { x: lim(d.x, view.x - box.x, view.x + view.w - (box.x + box.w)), y: lim(d.y, view.y - box.y, view.y + view.h - (box.y + box.h)) };
}

/**
 * A box `{ x, y, w, h }` after the handle at (`hx`, `hy`) (each -1, 0 or 1:
 * left or top, middle, right or bottom) is dragged to `p`: the opposite
 * edges stay, nothing goes below `min`, and `aspect` keeps the proportions
 * when a corner is dragged.
 */
export function resizeBox(box, hx, hy, p, { aspect = false, min = MIN_SIZE } = {}) {
  let x0 = box.x; let x1 = box.x + box.w; let y0 = box.y; let y1 = box.y + box.h;
  if (hx < 0) x0 = Math.min(p.x, x1 - min);
  if (hx > 0) x1 = Math.max(p.x, x0 + min);
  if (hy < 0) y0 = Math.min(p.y, y1 - min);
  if (hy > 0) y1 = Math.max(p.y, y0 + min);
  if (aspect && hx && hy && box.w > 0 && box.h > 0) {
    const ratio = box.w / box.h;
    let w = x1 - x0; let h = y1 - y0;
    if (w / h > ratio) w = h * ratio; else h = w / ratio;
    if (hx < 0) x0 = x1 - w; else x1 = x0 + w;
    if (hy < 0) y0 = y1 - h; else y1 = y0 + h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Where a label on a box goes when the box goes from `was` to `now`: one
 * centred on it (its anchor in the middle, near the box's middle) stays
 * centred; one written from an edge keeps its distance to that edge.
 */
export function followLabel({ x, y, anchor = 'start' }, was, now) {
  const cx0 = was.x + was.w / 2; const cy0 = was.y + was.h / 2;
  const cx1 = now.x + now.w / 2; const cy1 = now.y + now.h / 2;
  let nx;
  if (anchor === 'middle' && Math.abs(x - cx0) <= was.w * 0.15) nx = x + (cx1 - cx0);
  else if (anchor === 'end') nx = x + (now.x + now.w - (was.x + was.w));
  else nx = x + (now.x - was.x);
  let ny;
  if (Math.abs(y - cy0) <= was.h * 0.3) ny = y + (cy1 - cy0);
  else if (y > cy0) ny = y + (now.y + now.h - (was.y + was.h));
  else ny = y + (now.y - was.y);
  return { x: nx, y: ny };
}

// ── several shapes: Arrange ▸ (SVG_DIAGRAMS) ─────────────────────────────────
export const ARRANGE = ['left', 'center', 'right', 'top', 'middle', 'bottom', 'across', 'down', 'width', 'height'];
/**
 * What Arrange ▸ `how` does to each of `boxes` (`{ x, y, w, h }`, one
 * space; the first is the primary): `{ dx, dy }` to move it and, for the same
 * width or height, `{ w }` or `{ h }`. Aligning lines them up on the edge or
 * the middle of the box round them all; spacing evenly keeps the outermost
 * two where they are and makes the gaps between all of them equal; the same
 * width or height is the primary's.
 */
export function arrangeBoxes(boxes, how) {
  const out = boxes.map(() => ({ dx: 0, dy: 0 }));
  if (boxes.length < 2) return out;
  const x0 = Math.min(...boxes.map((b) => b.x)); const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y0 = Math.min(...boxes.map((b) => b.y)); const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  boxes.forEach((b, i) => {
    if (how === 'left') out[i].dx = x0 - b.x;
    if (how === 'right') out[i].dx = x1 - (b.x + b.w);
    if (how === 'center') out[i].dx = (x0 + x1) / 2 - (b.x + b.w / 2);
    if (how === 'top') out[i].dy = y0 - b.y;
    if (how === 'bottom') out[i].dy = y1 - (b.y + b.h);
    if (how === 'middle') out[i].dy = (y0 + y1) / 2 - (b.y + b.h / 2);
    if (how === 'width' && i) out[i].w = boxes[0].w;
    if (how === 'height' && i) out[i].h = boxes[0].h;
  });
  if ((how === 'across' || how === 'down') && boxes.length > 2) {
    const [p, s] = how === 'across' ? ['x', 'w'] : ['y', 'h'];
    const order = boxes.map((b, i) => i).sort((a, b) => (boxes[a][p] + boxes[a][s] / 2) - (boxes[b][p] + boxes[b][s] / 2));
    const first = boxes[order[0]]; const last = boxes[order.at(-1)];
    const gap = (last[p] + last[s] - first[p] - order.reduce((t, i) => t + boxes[i][s], 0)) / (order.length - 1);
    let at = first[p] + first[s] + gap;
    for (const i of order.slice(1, -1)) {
      out[i][how === 'across' ? 'dx' : 'dy'] = at - boxes[i][p];
      at += boxes[i][s] + gap;
    }
  }
  return out;
}

/** Where along a box its three lines are, on one axis: its start, its middle, its end. */
const FEATURES = [0, 0.5, 1];
/**
 * Alignment guides (GUIDES): `box` (`{ x, y, w, h }`) is being dragged among
 * `others`, all in one space. Its lines that move (`xs`, `ys`: fractions of
 * the box, 0 its left or top, 0.5 its middle, 1 its right or bottom; all
 * three for a move, one edge for a resize) are matched against every line
 * of every other box. Returns `{ dx, dy, lines }`: the nudge that snaps the
 * nearest match within `within` on each axis (0 when there is none), and the
 * guides to draw once it has, `{ axis, at, from, to }` (axis 'x': a vertical
 * line at x = at, from y = from to y = to, spanning both boxes).
 */
export function alignGuides(box, others, { within = 4, xs = FEATURES, ys = FEATURES } = {}) {
  const best = { x: null, y: null };
  const look = (axis, fracs) => {
    const pos = axis === 'x' ? (b, f) => b.x + f * b.w : (b, f) => b.y + f * b.h;
    for (const o of others) {
      for (const g of FEATURES) {
        for (const f of fracs) {
          const d = pos(o, g) - pos(box, f);
          if (Math.abs(d) <= within && (!best[axis] || Math.abs(d) < Math.abs(best[axis]))) best[axis] = d === 0 ? 0 : d;
        }
      }
    }
  };
  look('x', xs); look('y', ys);
  const dx = best.x ?? 0; const dy = best.y ?? 0;
  const moved = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  const lines = [];
  const add = (axis, at, from, to) => {
    const same = lines.find((l) => l.axis === axis && Math.abs(l.at - at) < 0.01);
    if (same) { same.from = Math.min(same.from, from); same.to = Math.max(same.to, to); } else lines.push({ axis, at, from, to });
  };
  for (const o of others) {
    if (best.x !== null) {
      for (const g of FEATURES) for (const f of xs) {
        const at = o.x + g * o.w;
        if (Math.abs(at - (moved.x + f * moved.w)) < 0.01) add('x', at, Math.min(o.y, moved.y), Math.max(o.y + o.h, moved.y + moved.h));
      }
    }
    if (best.y !== null) {
      for (const g of FEATURES) for (const f of ys) {
        const at = o.y + g * o.h;
        if (Math.abs(at - (moved.y + f * moved.h)) < 0.01) add('y', at, Math.min(o.x, moved.x), Math.max(o.x + o.w, moved.x + moved.w));
      }
    }
  }
  return { dx, dy, lines };
}

// ── the page ─────────────────────────────────────────────────────────────────

const tagOf = (el) => el?.tagName?.toLowerCase() ?? '';
const num = (el, a) => { const v = parseFloat(el.getAttribute(a)); return Number.isFinite(v) ? v : 0; };
/** The kind a shape is marked as (a diamond, a cylinder…) and the attribute its geometry is in, or null: SVG_DIAGRAMS, `data-shape`. */
function markedShape(el) {
  const kind = el?.getAttribute?.('data-shape');
  const tag = tagOf(el);
  if (!kind || SHAPES[kind] !== tag) return null;
  const attr = tag === 'path' ? 'd' : 'points';
  return shapeBox(attr, el.getAttribute(attr)) ? { kind, attr } : null;
}
const numericAttr = (el, a) => !el.hasAttribute(a) || NUMERIC.test(el.getAttribute(a));
const isStep = (el) => !!el?.classList?.contains('build-step');
const authoredKids = (el) => [...el.children].filter((c) => !c.matches(ENGINE_NODES));

/** The live node a FILE path names below `top`, skipping the nodes the engine added. */
export function liveAt(top, path) {
  let cur = top;
  for (const i of path ?? []) {
    cur = cur ? authoredKids(cur)[i] : null;
    if (!cur) return null;
  }
  return cur;
}

/** The svg a target is in, when shapes may be added to it: an authored diagram, not a chart, a terminal or a template's. */
function diagramOf(target) {
  const svg = target?.clicked?.closest?.('svg') ?? (tagOf(target?.node) === 'svg' ? target.node : null);
  if (!svg || !target.top?.contains(svg)) return null;
  if (svg.closest('[data-chart], .terminal, .chart-svg') || svg.classList.contains('chart-svg')) return null;
  // a template's svg is not the author's (a slot container above it does not count: it holds the author's diagram)
  if (svg.hasAttribute('data-ds-injected')) return null;
  if (target.node && target.node !== svg && injectedIn(target.node, svg)) return null;
  return svg;
}

/** The labels on a shape: the texts beside it whose middle falls inside it. */
function labelsOn(shape) {
  const parent = shape.parentElement;
  if (!parent) return [];
  const b = shape.getBoundingClientRect();
  return authoredKids(parent).filter((c) => {
    if (tagOf(c) !== 'text') return false;
    const r = c.getBoundingClientRect();
    const x = r.left + r.width / 2; const y = r.top + r.height / 2;
    return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
  });
}

/** The group a shape is the box of: a `<g>` holding that shape and its labels and nothing else. */
function boxGroupOf(shape, labels = labelsOn(shape)) {
  const g = shape.parentElement;
  if (tagOf(g) !== 'g' || !BOX_SHAPES.has(tagOf(shape)) || g.matches(ENGINE_NODES)) return null;
  const kids = authoredKids(g).filter((k) => !/^(title|desc)$/.test(tagOf(k)));
  return kids.every((k) => k === shape || labels.includes(k)) ? g : null;
}

/** What one move of `node` moves: its box group, or it and the labels on it, or a step-group's children. */
function membersOf(node) {
  const tag = tagOf(node);
  if (tag === 'g') return isStep(node) ? authoredKids(node).filter((k) => isDrawn(k) && !/^(title|desc|defs)$/.test(tagOf(k))) : [node];
  if (BOX_SHAPES.has(tag)) {
    const labels = labelsOn(node);
    const g = boxGroupOf(node, labels);
    if (g && !isStep(g)) return [g];
    return [node, ...labels];
  }
  return [node];
}

const MOVE_PAIRS = { rect: [['x', 'y']], image: [['x', 'y']], use: [['x', 'y']], foreignobject: [['x', 'y']], text: [['x', 'y']], circle: [['cx', 'cy']], ellipse: [['cx', 'cy']], line: [['x1', 'y1'], ['x2', 'y2']] };

/**
 * How `el` moves: `{ attrs: [[node, xAttr, yAttr]…] }` in its own
 * coordinates, `{ translate: true }` by its transform, or null when it
 * cannot (a build step that would need a transform: its build owns it).
 */
function moveSpec(el) {
  const pairs = MOVE_PAIRS[tagOf(el)];
  if (pairs && pairs.flat().every((a) => numericAttr(el, a))) {
    const lines = tagOf(el) === 'text' ? [...el.querySelectorAll('tspan')].filter((t) => t.hasAttribute('x') || t.hasAttribute('y')) : [];
    if (lines.every((t) => numericAttr(t, 'x') && numericAttr(t, 'y'))) {
      return { attrs: [...pairs.map(([x, y]) => [el, x, y]), ...lines.map((t) => [t, t.hasAttribute('x') ? 'x' : null, t.hasAttribute('y') ? 'y' : null])] };
    }
  }
  if (isStep(el)) return null;
  return { translate: true };
}

export function createShapes({ root, instance, editmode, editbar, authoring, toast, debugLog = () => {} }) {
  const active = () => editmode.elementEditOn?.() && editmode.available?.() && editbar.isOpen?.() && !authoring.editing?.();

  // ── writes ────────────────────────────────────────────────────────────────
  // each one quiet and tracked; a page that cannot show the answer reloads (edit-commit.js)
  const commit = createEditCommit(editmode);
  const post = commit.post;
  const reloadFor = (what, e) => {
    debugLog('edit', `${what} (${String(e.message || e)}) — reloading`);
    commit.reload(what);
  };

  /** Every edit a set of live nodes needs to say what `before` became, addressed by the file's path. */
  function editsFor(top, before) {
    const edits = [];
    for (const [el, attrs] of before) {
      const path = pathFrom(top, el);
      if (!path) return null;
      for (const [attr, was] of Object.entries(attrs)) {
        const now = el.getAttribute(attr);
        if (now === was) continue;
        if (attr === 'transform') {
          const t = leadingTranslate(now);
          edits.push({ path, tag: tagOf(el), attr, value: `translate(${round1(t.x)} ${round1(t.y)})` });
        } else edits.push({ path, tag: tagOf(el), attr, value: now === null ? null : SHAPE_DATA.has(attr) ? now : Number(now) });
      }
    }
    return edits;
  }
  /**
   * The connectors of `svg`, their geometry remembered in `before`, so a
   * gesture that routes them again writes them with the rest of it (one
   * undo) and an Esc or a refusal puts them back.
   */
  function keepWires(svg, before) {
    const wires = connectorsIn(svg);
    for (const w of wires) {
      const rec = before.get(w) ?? {};
      for (const a of WIRE_GEOMETRY) if (w.hasAttribute(a) && !(a in rec)) rec[a] = w.getAttribute(a);
      before.set(w, rec);
      // its label rides on it (a label on a wire): its place, and its lines' x, go in the same write
      for (const l of wireLabels(w)) {
        keepAttrs(before, l, ['x', 'y']);
        for (const t of l.children) if (tagOf(t) === 'tspan' && t.hasAttribute('x')) keepAttrs(before, t, ['x']);
      }
    }
    return wires;
  }
  /** `attrs` of `el` remembered in `before` as they are now, unless they already are. */
  function keepAttrs(before, el, attrs) {
    const rec = before.get(el) ?? {};
    for (const a of attrs) if (!(a in rec)) rec[a] = el.getAttribute(a);
    before.set(el, rec);
  }
  /** Put the attributes `before` remembers back (a refused write, an Esc mid-drag). */
  function restore(before) {
    for (const [el, attrs] of before) for (const [a, v] of Object.entries(attrs)) { if (v === null) el.removeAttribute(a); else el.setAttribute(a, v); }
  }
  /**
   * What the engine drew from these nodes, drawn again for where they are now
   * (engine.js refreshSlide): `wires` routed to their nodes first, then each
   * drawn stroke fitted, and the diagram's concepts and nesting painted again.
   */
  const refit = (nodes, svg, wires = []) => instance.refreshSlide?.(svg?.closest('section'), {
    connectors: wires, strokes: nodes, paint: svg?.parentElement, scan: false, relayout: false,
  });
  async function save(target, before, what, extra = []) {
    const found = editsFor(target.top, before);
    if (!found) { restore(before); toast('that node is the engine’s, not the file’s — nothing to move', 2600); return false; }
    // a label's lines go last: they rewrite what is inside the text, after its own x and y
    const edits = [...found, ...extra];
    if (!edits.length) return true;
    try {
      await post('/deck/edit/element/geometry', { slide: target.slide, index: target.index, edits });
      debugLog('edit', `${what}: slide ${target.slide} element #${target.index} · ${edits.length} attribute${edits.length === 1 ? '' : 's'}`);
      return true;
    } catch (e) {
      restore(before);
      refit([...before.keys()], target.node?.ownerSVGElement);
      toast(commit.notSaved(what, e), 6000);
      return false;
    }
  }

  // ── move ──────────────────────────────────────────────────────────────────
  let press = null;   // { id, x, y, node, target } until the pointer has gone far enough
  let drag = null;    // the move in progress
  let swallowClick = false;

  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || drag || resizing || !e.target.closest?.('svg') || !active()) return;
    if (root.classList.contains('dl-picking')) return;   // the inspector's picker takes the click
    const sel = editbar.selected();
    let node = null; let target = null;
    const hits = (n) => n === e.target || n.contains(e.target) || membersOf(n).some((m) => m === e.target || m.contains(e.target));
    const many = editbar.selectedShapes?.();
    const inMany = many?.find((t) => hits(t.node));
    if (inMany) { node = inMany.node; target = inMany; }
    else if (sel?.node && isDrawn(sel.node) && hits(sel.node)) {
      node = sel.node; target = sel;
    } else {
      const t = editmode.elementTargetOf(e.target);
      // what a click here would select: inside a selected group, the level below it (pick.js)
      if (t?.top) t.node = nodeForClick(t.top, e.target, sel);
      if (t?.node && isDrawn(t.node) && diagramOf(t)) { node = t.node; target = t; }
    }
    if (!node || !diagramOf(target) || tagOf(node) === 'tspan') return;
    // a connector goes where its nodes are: its ends drag (its handles), its body does not
    if (isConnector(node)) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, node, target, many: inMany ? many : null };
  }, true);

  function beginMove(e) {
    const { node } = press;
    let { target } = press;
    // several shapes selected: a drag on one moves them all, their wires with them (SVG_DIAGRAMS)
    if (press.many) return moveState(target, press.many.map((t) => t.node), press.x, press.y);
    if (editbar.selected()?.node !== node) {
      editbar.selectNode(node, { exact: true });
      target = editbar.selected() ?? target;
    }
    // a label on a wire slides along it: where it sits is a fraction of the wire's length
    const wire = wireOfLabel(node);
    if (wire) {
      const before = new Map();
      keepAttrs(before, node, ['x', 'y', 'data-along']);
      for (const t of node.children) if (tagOf(t) === 'tspan' && t.hasAttribute('x')) keepAttrs(before, t, ['x']);
      root.classList.add('dl-shape-dragging');
      return { target, node, members: [node], before, svg: node.ownerSVGElement, wires: [], along: wire, x: press.x, y: press.y, moved: false };
    }
    return moveState(target, [node], press.x, press.y);
  }
  /**
   * What moving `nodes` (one, or several shapes of one diagram) takes: each
   * one's members (its box group, its labels) and how each moves, their
   * attributes remembered in `before` (shared, when several moves make one
   * write), the connectors they drag along. Null when one cannot move.
   */
  function moveState(target, nodes, x, y, before = new Map()) {
    const node = nodes[0];
    const members = [...new Set(nodes.flatMap((n) => membersOf(n)))].filter((m, i, all) => !all.some((o) => o !== m && o.contains(m)));
    const specs = members.map(moveSpec);
    if (specs.some((s) => !s)) {
      toast('this one is a build step, and its build owns where it is: move what it holds, or the group it is in', 3600);
      return null;
    }
    const parts = members.map((m, i) => {
      const s = specs[i];
      if (s.translate) {
        if (!('transform' in (before.get(m) ?? {}))) before.set(m, { ...(before.get(m) ?? {}), transform: m.getAttribute('transform') });
        const inv = m.parentNode.getScreenCTM?.()?.inverse();
        return { m, translate: true, inv, t0: m.getAttribute('transform'), at: leadingTranslate(m.getAttribute('transform')) };
      }
      const inv = m.getScreenCTM?.()?.inverse();
      const pairs = s.attrs.map(([el, ax, ay]) => {
        const rec = before.get(el) ?? {};
        if (ax && !(ax in rec)) rec[ax] = el.getAttribute(ax);
        if (ay && !(ay in rec)) rec[ay] = el.getAttribute(ay);
        before.set(el, rec);
        return { el, ax, ay, x0: ax ? num(el, ax) : 0, y0: ay ? num(el, ay) : 0 };
      });
      return { m, inv, pairs };
    });
    if (parts.some((p) => !p.inv)) return null;
    const svg = node.ownerSVGElement;
    // the connectors it drags along, written with it
    const wires = keepWires(svg, before);
    root.classList.add('dl-shape-dragging');
    window.getSelection?.()?.removeAllRanges();
    return { target, node, members, parts, before, svg, wires, guide: guideFor(svg, members), hold: holdFor(svg, members), x, y, moved: false };
  }

  function applyMove(e) {
    if (drag.along) {
      const m = drag.along.getScreenCTM?.()?.inverse();
      if (!m) return;
      const p = { x: m.a * e.clientX + m.c * e.clientY + m.e, y: m.b * e.clientX + m.d * e.clientY + m.f };
      drag.node.setAttribute('data-along', String(Math.round(nearestAlong(wirePoints(drag.along), p) * 1000) / 1000));
      placeWireLabels(drag.along);
      drag.moved = true;
      return;
    }
    let dx = e.clientX - drag.x; let dy = e.clientY - drag.y;
    const lock = e.shiftKey ? (Math.abs(dx) >= Math.abs(dy) ? 'y' : 'x') : null;   // ⇧: the axis held still
    if (lock === 'y') dy = 0; else if (lock === 'x') dx = 0;
    const snap = snapMove(drag.guide, dx, dy, lock, !(e.metaKey || e.ctrlKey));
    dx += snap.x; dy += snap.y;
    // nothing leaves the canvas: the svg draws nothing past its viewBox
    if (drag.hold) {
      const s = localStep(drag.hold.inv, dx, dy);
      const c = clampStep(drag.hold.box, s, drag.hold.view);
      if (c.x !== s.x || c.y !== s.y) ({ x: dx, y: dy } = localStep(drag.hold.ctm, c.x, c.y));
    }
    for (const p of drag.parts) {
      const d = localStep(p.inv, dx, dy);
      if (p.translate) {
        const t = setTranslate(p.t0, keepGrain(p.at.x, p.at.x + d.x), keepGrain(p.at.y, p.at.y + d.y));
        if (t) p.m.setAttribute('transform', t); else p.m.removeAttribute('transform');
        continue;
      }
      for (const q of p.pairs) {
        if (q.ax) q.el.setAttribute(q.ax, String(keepGrain(q.x0, q.x0 + d.x)));
        if (q.ay) q.el.setAttribute(q.ay, String(keepGrain(q.y0, q.y0 + d.y)));
      }
    }
    drag.moved = true;
    refit(drag.members, drag.svg, drag.wires);
  }

  // ── guides (GUIDES) ───────────────────────────────────────────────────────
  /** The other shapes of `svg` a drag lines up with: their boxes in the svg's space. */
  function guideBoxes(svg, skip, space = IDENTITY) {
    const out = [];
    for (const el of svg.querySelectorAll('rect, circle, ellipse, image, use, polygon, path[data-shape], foreignObject')) {
      if (el.closest(`${ENGINE_NODES}, defs, marker, mask, clipPath, pattern, symbol`) || injectedIn(el, svg)) continue;
      if (skip.some((s) => s === el || s.contains?.(el))) continue;
      const b = nodeBox(el, space, svg);
      if (b && b.w > 0 && b.h > 0) out.push(b);
    }
    return out;
  }
  /** What a move of `members` lines up against: its box and the others', in the svg's space, and how near snaps. */
  function guideFor(svg, members) {
    const ctm = svg.getScreenCTM?.();
    const inv = ctm?.inverse();
    const boxes = members.filter((m) => !WIRE_TAGS.has(tagOf(m)) || tagOf(m) === 'path').map((m) => nodeBox(m, IDENTITY, svg)).filter(Boolean);
    if (!ctm || !inv || !boxes.length) return null;
    return { ctm, inv, box: boxes.length === 1 ? boxes[0] : union(boxes), others: guideBoxes(svg, members), within: SNAP_PX * Math.hypot(inv.a, inv.b) };
  }
  /** What keeps a move of `members` on the canvas: their box and the viewBox, in the svg's space. Null when the svg has no viewBox. */
  function holdFor(svg, members) {
    const view = viewOf(svg);
    const ctm = svg.getScreenCTM?.();
    const inv = ctm?.inverse();
    const boxes = members.map((m) => nodeBox(m, IDENTITY, svg)).filter(Boolean);
    if (!view || !ctm || !inv || !boxes.length) return null;
    return { view, ctm, inv, box: union(boxes) };
  }
  /** The screen step that snaps a move of (dx, dy) to the nearest guide, the guides shown; nothing with `on` false. */
  function snapMove(g, dx, dy, lock, on) {
    if (!on || !g) { hideGuides(); return { x: 0, y: 0 }; }
    const r = localStep(g.inv, dx, dy);
    const a = alignGuides({ x: g.box.x + r.x, y: g.box.y + r.y, w: g.box.w, h: g.box.h }, g.others,
      { within: g.within, xs: lock === 'x' ? [] : undefined, ys: lock === 'y' ? [] : undefined });
    showGuides(a.lines, g.ctm);
    return localStep(g.ctm, a.dx, a.dy);
  }
  let guideEls = [];
  /** Thin accent lines over the stage where the guides are, `m` the screen matrix of the space they are in. */
  function showGuides(lines, m) {
    hideGuides();
    const at = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
    for (const l of lines) {
      const p = l.axis === 'x' ? at(l.at, l.from) : at(l.from, l.at);
      const q = l.axis === 'x' ? at(l.at, l.to) : at(l.to, l.at);
      const el = Object.assign(document.createElement('div'), { className: `dl-guide dl-guide-${l.axis}` });
      el.setAttribute('aria-hidden', 'true');
      Object.assign(el.style, l.axis === 'x'
        ? { left: `${p.x}px`, top: `${Math.min(p.y, q.y)}px`, height: `${Math.abs(q.y - p.y)}px` }
        : { left: `${Math.min(p.x, q.x)}px`, top: `${p.y}px`, width: `${Math.abs(q.x - p.x)}px` });
      root.appendChild(el);
      guideEls.push(el);
    }
  }
  function hideGuides() {
    for (const el of guideEls) el.remove();
    guideEls = [];
  }

  window.addEventListener('pointermove', (e) => {
    if (wiring) { wiringMove(e); return; }
    if (resizing) { resizeMove(e); return; }
    if (drag) { if (e.pointerId === drag.id) applyMove(e); return; }
    if (!press || e.pointerId !== press.id) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_AFTER) return;
    const started = beginMove(e);
    if (!started) { press = null; return; }
    drag = { ...started, id: press.id };
    press = null;
    applyMove(e);
  });
  async function endMove(e, { cancel = false } = {}) {
    const d = drag;
    drag = null;
    root.classList.remove('dl-shape-dragging');
    hideGuides();
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 350);
    if (cancel) { restore(d.before); refit([...d.members, ...d.wires], d.svg); return; }
    if (!d.moved) return;
    await save(d.target, d.before, 'move');
  }
  window.addEventListener('pointerup', (e) => {
    if (wiring) { wiringEnd(e); return; }
    if (resizing) { resizeEnd(e); return; }
    if (drag && e.pointerId === drag.id) endMove(e);
    press = null;
  });
  window.addEventListener('pointercancel', () => {
    if (wiring) wiringEnd(null, { cancel: true });
    if (drag) endMove(null, { cancel: true });
    if (resizing) resizeEnd(null, { cancel: true });
    press = null;
  });
  // the click a drag ends in selects nothing: the drag was the gesture
  root.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !(drag || resizing || wiring)) return;
    e.stopPropagation(); e.preventDefault();
    if (wiring) wiringEnd(null, { cancel: true });
    if (drag) endMove(null, { cancel: true });
    if (resizing) resizeEnd(null, { cancel: true });
  }, true);

  // ── resize ────────────────────────────────────────────────────────────────
  let handles = [];    // { el, kind, hx, hy, end }
  let dots = [];       // { el, side }: where a wire starts from (CONNECT)
  let handled = null;  // { target, shape, kind, unit }
  let placing = 0;
  let resizing = null;

  /** What a selection resizes: `{ shape, kind }` (box or line: a line, or a connector drawn as a path or a polyline, by its ends), or null. */
  function resizable(target) {
    let node = target?.node;
    if (!node || !isDrawn(node) || !diagramOf(target) || pathFrom(target.top, node) === null) return null;
    if (tagOf(node) === 'g') {
      const shape = authoredKids(node).find((k) => BOX_SHAPES.has(tagOf(k)));
      if (!shape || boxGroupOf(shape) !== node) return null;
      node = shape;
    }
    const tag = tagOf(node);
    if (tag !== 'line' && isConnector(node)) return endsOf(tag, (a) => node.getAttribute(a)) ? { shape: node, kind: 'line' } : null;
    // a marked shape resizes by its box, its geometry written again for the new one
    if (markedShape(node)) return { shape: node, kind: 'box' };
    const need = { rect: ['x', 'y', 'width', 'height'], image: ['x', 'y', 'width', 'height'], ellipse: ['cx', 'cy', 'rx', 'ry'], circle: ['cx', 'cy', 'r'], line: ['x1', 'y1', 'x2', 'y2'] }[tag];
    if (!need || !need.every((a) => numericAttr(node, a))) return null;
    return { shape: node, kind: tag === 'line' ? 'line' : 'box' };
  }
  /** Where a wire's end `k` (1 its start, 2 its end) is, in its own coordinates. */
  const endPoint = (wire, k) => {
    const e = endsOf(tagOf(wire), (a) => wire.getAttribute(a));
    return e ? (k === 1 ? e.start : e.end) : { x: 0, y: 0 };
  };
  /** A box shape's box in its own coordinates. */
  function boxOf(shape) {
    const marked = markedShape(shape);
    if (marked) return shapeBox(marked.attr, shape.getAttribute(marked.attr));
    switch (tagOf(shape)) {
      case 'ellipse': return { x: num(shape, 'cx') - num(shape, 'rx'), y: num(shape, 'cy') - num(shape, 'ry'), w: 2 * num(shape, 'rx'), h: 2 * num(shape, 'ry') };
      case 'circle': return { x: num(shape, 'cx') - num(shape, 'r'), y: num(shape, 'cy') - num(shape, 'r'), w: 2 * num(shape, 'r'), h: 2 * num(shape, 'r') };
      default: return { x: num(shape, 'x'), y: num(shape, 'y'), w: num(shape, 'width'), h: num(shape, 'height') };
    }
  }
  /** Write box `b` on `shape` in the attributes it uses, in the grain each had. */
  function setBox(shape, b, was) {
    const g = (a, v) => shape.setAttribute(a, String(keepGrain(was[a] ?? 0, v)));
    const marked = markedShape(shape);
    if (marked) { const geom = shapeGeometry(marked.kind, b); shape.setAttribute(geom.attr, geom.value); return; }
    switch (tagOf(shape)) {
      case 'ellipse': g('cx', b.x + b.w / 2); g('cy', b.y + b.h / 2); g('rx', b.w / 2); g('ry', b.h / 2); break;
      case 'circle': g('cx', b.x + b.w / 2); g('cy', b.y + b.h / 2); g('r', Math.max(b.w, b.h) / 2); break;
      default:
        g('x', b.x); g('y', b.y); g('width', b.w); g('height', b.h);
        // a pill stays a pill: its corners are half its short side, whatever size it is made
        if (tagOf(shape) === 'rect' && cornersOf(was) === 'pill') for (const a of ['rx', 'ry']) if (a in was || a === 'rx') g(a, Math.min(b.w, b.h) / 2);
    }
  }
  const BOX_HANDLES = [[-1, -1, 'nwse'], [0, -1, 'ns'], [1, -1, 'nesw'], [1, 0, 'ew'], [1, 1, 'nwse'], [0, 1, 'ns'], [-1, 1, 'nesw'], [-1, 0, 'ew']];
  function showHandles(target) {
    hideHandles();
    if (!active()) return;
    const r = resizable(target);
    // a box or a shape a wire may start from: a dot on each side
    const unit = r?.kind === 'line' ? null : connectable(target);
    if (!r && !unit) return;
    handled = { target, shape: r?.shape ?? null, kind: r?.kind ?? null, unit };
    for (const side of unit ? SIDES : []) {
      const el = Object.assign(document.createElement('div'), { className: 'dl-wire-dot', title: 'drag to a shape to connect' });
      el.setAttribute('aria-hidden', 'true');
      el.addEventListener('pointerdown', (e) => wiringStart(e, side));
      el.addEventListener('mousedown', (e) => e.preventDefault());
      root.appendChild(el);
      dots.push({ el, side });
    }
    const make = (cls, cursor, data) => {
      const el = Object.assign(document.createElement('div'), { className: `dl-shape-handle ${cls}` });
      el.style.cursor = `${cursor}-resize`;
      el.setAttribute('aria-hidden', 'true');
      el.addEventListener('pointerdown', (e) => resizeStart(e, data));
      el.addEventListener('mousedown', (e) => e.preventDefault());
      root.appendChild(el);
      handles.push({ el, ...data });
    };
    if (r?.kind === 'line') { make('dl-shape-end', 'move', { end: 1 }); make('dl-shape-end', 'move', { end: 2 }); } else if (r) for (const [hx, hy, cursor] of BOX_HANDLES) make('', cursor, { hx, hy });
    // the ⋯ menu handle steps aside for the corner handle it would sit on
    root.classList.add('dl-shape-handles');
    const tick = () => { placeHandles(); placing = requestAnimationFrame(tick); };
    placing = requestAnimationFrame(tick);
    placeHandles();
  }
  function hideHandles() {
    cancelAnimationFrame(placing);
    for (const h of [...handles, ...dots]) h.el.remove();
    handles = []; dots = []; handled = null;
    root.classList.remove('dl-shape-handles');
  }
  function placeHandles() {
    if (!handled) return;
    const { shape, unit } = handled;
    if (!(shape ?? unit).isConnected) { hideHandles(); return; }
    const m = shape?.getScreenCTM?.();
    const at = (x, y) => ({ left: m.a * x + m.c * y + m.e, top: m.b * x + m.d * y + m.f });
    if (m) {
      for (const h of handles) {
        let p;
        if (h.end) { const q = endPoint(shape, h.end); p = at(q.x, q.y); } else { const b = boxOf(shape); p = at(b.x + (h.hx + 1) / 2 * b.w, b.y + (h.hy + 1) / 2 * b.h); }
        h.el.style.left = `${p.left}px`; h.el.style.top = `${p.top}px`;
      }
    }
    if (!unit || !dots.length) return;
    // the dots stand a little off each side of the node's box, clear of the resize handles
    const s = screenBox(unit);
    if (!s) return;
    const off = DOT_OFF;
    const place = { top: [s.x + s.w / 2, s.y - off], right: [s.x + s.w + off, s.y + s.h / 2], bottom: [s.x + s.w / 2, s.y + s.h + off], left: [s.x - off, s.y + s.h / 2] };
    for (const d of dots) { d.el.style.left = `${place[d.side][0]}px`; d.el.style.top = `${place[d.side][1]}px`; }
  }
  /** A node's box on the screen, as a wire sees it (its shapes, not its labels). */
  function screenBox(unit) {
    const svg = svgOf(unit);
    const m = svg?.getScreenCTM?.();
    const b = m && nodeBox(unit, IDENTITY, svg);
    if (!b) return null;
    const corners = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }));
    const x = Math.min(...corners.map((c) => c.x)); const y = Math.min(...corners.map((c) => c.y));
    return { x, y, w: Math.max(...corners.map((c) => c.x)) - x, h: Math.max(...corners.map((c) => c.y)) - y };
  }

  function resizeStart(e, data) {
    if (e.button !== 0 || !handled || !active()) return;
    e.preventDefault(); e.stopPropagation();
    const { shape, target } = handled;
    const inv = shape.getScreenCTM?.()?.inverse();
    if (!inv) return;
    const before = new Map();
    const keep = (el, attrs) => before.set(el, { ...(before.get(el) ?? {}), ...Object.fromEntries(attrs.map((a) => [a, el.getAttribute(a)])) });
    const was = {};
    for (const a of ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2']) if (shape.hasAttribute(a)) was[a] = num(shape, a);
    keep(shape, Object.keys(was));
    // a marked shape's geometry is its points or its path data, written again whole
    const marked = !data.end && markedShape(shape);
    if (marked) keep(shape, [marked.attr]);
    // the labels on a box come along, by what they are to it; a line has none
    const labels = data.end || shape.hasAttribute('transform') ? [] : labelsOn(shape).filter((t) => !t.hasAttribute('transform') && numericAttr(t, 'x') && numericAttr(t, 'y'))
      .map((t) => {
        keep(t, ['x', 'y']);
        const anchor = t.getAttribute('text-anchor') ?? getComputedStyle(t).textAnchor ?? 'start';
        // a label of several lines: each line's x goes with the text's (they used to stay behind)
        const rows = linesOf(t) && t.children.length ? [...t.children].filter((k) => numericAttr(k, 'x') && k.hasAttribute('x')) : [];
        for (const k of rows) keep(k, ['x']);
        return { t, x: num(t, 'x'), y: num(t, 'y'), anchor, rows: rows.map((k) => ({ k, x: num(k, 'x') })), html: t.innerHTML };
      });
    const svg = shape.ownerSVGElement;
    // a wire's end: its own geometry kept (a path's data, a polyline's points), and whether that end is attached
    if (data.end) keep(shape, ['d', 'points'].filter((a) => shape.hasAttribute(a)));
    const attached = { from: shape.hasAttribute('data-from'), to: shape.hasAttribute('data-to') };
    // a box: the connectors it drags along, and the lines of the others it may snap to, in its own space
    const wires = data.end ? [] : keepWires(svg, before);
    const group = boxGroupOf(shape);
    const toSvg = toRoot(shape, svg);
    const space = invert(toSvg);
    // the canvas a handle stays on (the viewBox, and for a box whatever of it already pokes out), in the svg's space
    const view = space ? viewOf(svg) : null;
    const held = view && !data.end ? union([view, boxThrough(toSvg, boxOf(shape))]) : view;
    const guide = data.end || tagOf(shape) === 'circle' || !space ? null
      : { others: guideBoxes(svg, [shape, ...labels.map((l) => l.t), ...(group ? [group] : [])], space), within: SNAP_PX * Math.hypot(inv.a, inv.b) };
    resizing = { id: e.pointerId, data, shape, target, inv, was, box: data.end ? null : boxOf(shape), labels, before, svg, wires, guide,
      toSvg, space, view: held, attached, ends: data.end ? endsOf(tagOf(shape), (a) => shape.getAttribute(a)) : null, hover: null, moved: false };
    root.classList.add('dl-shape-dragging');
  }
  function resizeMove(e) {
    const R = resizing;
    if (!R || e.pointerId !== R.id) return;
    const m = R.inv;
    // the pointer in the shape's space, held on the canvas: the svg draws nothing past its viewBox
    const onCanvas = (q) => {
      if (!R.view) return q;
      const s = applyTo(R.toSvg, q);
      const c = clampPoint(s, R.view);
      return c.x === s.x && c.y === s.y ? q : applyTo(R.space, c);
    };
    const p = onCanvas({ x: m.a * e.clientX + m.c * e.clientY + m.e, y: m.b * e.clientX + m.d * e.clientY + m.f });
    const free = e.metaKey || e.ctrlKey;   // ⌘/Ctrl: no snapping, no attaching
    if (R.data.end) {
      const k = R.data.end;
      const which = k === 1 ? 'from' : 'to';
      // the node under the pointer, lit: the end attaches to it on release (never the node the other end is on)
      const other = R.shape.getAttribute(which === 'from' ? 'data-to' : 'data-from');
      const hit = free ? null : joinableAt(e.clientX, e.clientY, R.svg, other ? [nodeNamed(R.svg, other)].filter(Boolean) : []);
      R.hover = hit;
      setHover(hit);
      let { x, y } = p;
      const o = k === 1 ? R.ends?.end : R.ends?.start;
      if (!hit && e.shiftKey && o) { if (Math.abs(x - o.x) >= Math.abs(y - o.y)) y = o.y; else x = o.x; }
      ({ x, y } = onCanvas({ x, y }));
      if (!hit && tagOf(R.shape) === 'line' && !isConnector(R.shape)) {
        R.shape.setAttribute(`x${k}`, String(keepGrain(R.was[`x${k}`], x)));
        R.shape.setAttribute(`y${k}`, String(keepGrain(R.was[`y${k}`], y)));
      } else {
        // routed: to the node's edge, or to the pointer where nothing is under it
        const g = wireGeometry(R.shape, { [which]: hit ?? { x, y } });
        if (g) setGeometry(R.shape, g);
      }
    } else {
      const { hx, hy } = R.data;
      let b;
      if (tagOf(R.shape) === 'circle') {
        // a circle keeps its centre: the handle sets the radius
        const cx = R.was.cx; const cy = R.was.cy;
        let r = Math.max(MIN_SIZE / 2, hx && hy ? Math.max(Math.abs(p.x - cx), Math.abs(p.y - cy)) : hx ? Math.abs(p.x - cx) : Math.abs(p.y - cy));
        // it grows on every side: no further than its nearest edge of the canvas (never smaller than it was)
        if (R.view) {
          const c = applyTo(R.toSvg, { x: cx, y: cy });
          const room = Math.min(c.x - R.view.x, R.view.x + R.view.w - c.x, c.y - R.view.y, R.view.y + R.view.h - c.y) / (Math.hypot(R.toSvg.a, R.toSvg.b) || 1);
          r = Math.min(r, Math.max(room, R.was.r));
        }
        b = { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
      } else {
        const aspect = e.shiftKey && hx && hy;
        b = resizeBox(R.box, hx, hy, p, { aspect: e.shiftKey });
        // the edges the handle moves snap to the others' lines (GUIDES); a kept proportion is not bent to them
        if (R.guide && !free && !aspect) {
          const a = alignGuides(b, R.guide.others, { within: R.guide.within, xs: hx < 0 ? [0] : hx > 0 ? [1] : [], ys: hy < 0 ? [0] : hy > 0 ? [1] : [] });
          if (a.dx || a.dy) b = resizeBox(R.box, hx, hy, { x: p.x + a.dx, y: p.y + a.dy });
          showGuides(a.lines, R.shape.getScreenCTM());
        } else hideGuides();
      }
      setBox(R.shape, b, R.was);
      const now = boxOf(R.shape);
      for (const l of R.labels) {
        const q = followLabel(l, R.box, now);
        const nx = keepGrain(l.x, q.x);
        l.t.setAttribute('x', String(nx));
        l.t.setAttribute('y', String(keepGrain(l.y, q.y)));
        for (const r of l.rows) r.k.setAttribute('x', String(keepGrain(r.x, r.x + (nx - l.x))));
      }
    }
    R.moved = true;
    refit([R.shape], R.svg, R.wires);
    placeHandles();
  }
  async function resizeEnd(e, { cancel = false } = {}) {
    const R = resizing;
    if (!R || (e && e.pointerId !== R.id)) return;
    resizing = null;
    root.classList.remove('dl-shape-dragging');
    setHover(null);
    hideGuides();
    if (cancel) { restore(R.before); refit([R.shape, ...R.wires], R.svg); placeHandles(); return; }
    if (!R.moved) return;
    // the click a handle's drag ends in selects nothing: the drag was the gesture
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 350);
    if (R.data.end) {
      const end = R.data.end === 1 ? 'from' : 'to';
      // dropped on a node: attached to it (a hand-drawn line becomes a connector); on the canvas: an attached end lets go
      if (R.hover) {
        await wireOp(R.target, R.shape, 'reconnect', { end, node: nodeRef(R.target.top, R.hover) }, { before: R.before, node: R.hover });
        return;
      }
      if (R.attached[end]) { await wireOp(R.target, R.shape, 'detach', { end }, { before: R.before }); return; }
    }
    // its labels wrapped again for the new size, in the same write (SVG_DIAGRAMS, labels that wrap)
    const relined = R.data.end ? [] : rewrap(R.labels, R.before, R.target.top);
    const ok = await save(R.target, R.before, R.data.end ? 'line end' : 'resize', relined.map((x) => x.edit));
    if (!ok) for (const x of relined) x.t.innerHTML = x.html;
    markOverflow(R.svg);
    placeHandles();
  }

  // ── labels that wrap ──────────────────────────────────────────────────────
  /**
   * The labels a resize carried, broken again to fit the shape's new size:
   * each one whose lines change is put up as its new lines, its old lines
   * taken out of `before` (they are no longer on the page; the lines edit
   * rewrites them), and handed back with the edit that writes it. The words
   * are joined first, so a line break typed by hand becomes an ordinary one.
   */
  function rewrap(labels, before, top) {
    const out = [];
    for (const l of labels) {
      const was = linesOf(l.t);
      if (!was) continue;
      const fit = fitOnShape(l.t, was.join(' '));
      if (!fit || fit.lines.join('\n') === was.join('\n')) continue;
      const path = pathFrom(top, l.t);
      if (!path) continue;
      for (const r of l.rows) before.delete(r.k);
      setLines(l.t, fit.lines);
      out.push({ t: l.t, html: l.html, edit: { path, tag: 'text', was: was.join('\n'), lines: fit.lines } });
    }
    return out;
  }
  /** Mark the shapes of `svg` whose label does not fit even wrapped (write mode only); the rest unmarked. */
  function markOverflow(svg) {
    if (!svg) return;
    for (const s of svg.querySelectorAll('.dl-label-overflow')) s.classList.remove('dl-label-overflow');
    if (!editmode.elementEditOn?.()) return;
    for (const { shape } of overflowingLabels(svg)) shape.classList.add('dl-label-overflow');
  }
  const markSlide = () => {
    const sec = root.querySelector('section.active');
    for (const svg of sec?.querySelectorAll('svg') ?? []) markOverflow(svg);
  };
  authoring.setLabelHooks?.({
    fit: (text, words) => fitOnShape(text, words),
    saved: (text) => markOverflow(text.ownerSVGElement),
  });
  instance.on?.('slide', () => markSlide());
  editmode.onElementEditChange?.(() => markSlide());

  // ── connect (CONNECT) ─────────────────────────────────────────────────────
  /**
   * The node a wire joins for a drawn element of `svg`: one already named
   * (the shape, or the box group it is the box of), else that box group,
   * else the shape. Null for what is no node: a wire, a label loose on the
   * canvas, the canvas.
   */
  function joinUnit(el, svg) {
    const tag = tagOf(el);
    if (!el || !svg || el === svg || !svg.contains(el) || isConnector(el) || tag === 'line' || tag === 'polyline') return null;
    if (tag === 'tspan') return joinUnit(el.closest('text'), svg);
    const boxOfGroup = (g) => { const s = authoredKids(g).find((k) => BOX_SHAPES.has(tagOf(k))); return s && boxGroupOf(s) === g ? s : null; };
    if (tag === 'text') {
      if (el.hasAttribute('data-node')) return el;
      const g = el.parentElement;
      return tagOf(g) === 'g' && boxOfGroup(g) ? joinUnit(g, svg) : null;
    }
    if (tag === 'g') return el.hasAttribute('data-node') || boxOfGroup(el) ? el : null;
    if (!BOX_SHAPES.has(tag)) return null;
    if (el.hasAttribute('data-node')) return el;
    const g = boxGroupOf(el);
    return g && !g.matches(ENGINE_NODES) ? g : el;
  }
  /** The node a selection starts a wire from, or null. */
  function connectable(target) {
    const n = target?.node;
    if (!n || !isDrawn(n) || !diagramOf(target)) return null;
    const u = joinUnit(n, n.ownerSVGElement);
    return u && pathFrom(target.top, u) ? u : null;
  }
  /** Does `unit`'s box hold another shape of the diagram: is it a panel? */
  function holdsOthers(unit, svg) {
    const b = nodeBox(unit, IDENTITY, svg);
    return !!b && guideBoxes(svg, [unit]).some((o) => o.x >= b.x && o.y >= b.y && o.x + o.w <= b.x + b.w && o.y + o.h <= b.y + b.h && (o.w < b.w || o.h < b.h));
  }
  /**
   * The node under the screen point a wire may join in `svg` (not one of
   * `except`), or null. A panel (a node holding others) joins only near its
   * edge: a wire's end dragged about inside one is not caught by it.
   */
  function joinableAt(x, y, svg, except = []) {
    for (const el of document.elementsFromPoint?.(x, y) ?? []) {
      if (el === svg) return null;   // the canvas: nothing of the diagram is above it here
      if (!(el instanceof SVGElement) || !svg.contains(el) || el.closest(`${ENGINE_NODES}, defs, marker, mask`) || injectedIn(el, svg)) continue;
      const u = joinUnit(el, svg);
      if (!u || except.includes(u)) continue;
      if (holdsOthers(u, svg)) {
        const s = screenBox(u);
        if (s && Math.min(x - s.x, s.x + s.w - x, y - s.y, s.y + s.h - y) > PANEL_EDGE) continue;
      }
      return u;
    }
    return null;
  }
  /** How the server is told about a node: its path, its tag, and the words beside it (a name is made from them). */
  function nodeRef(top, unit) {
    const words = tagOf(unit) === 'g' ? unit.querySelector('text')?.textContent
      : tagOf(unit) === 'text' ? unit.textContent : labelsOn(unit)[0]?.textContent;
    return { path: pathFrom(top, unit), tag: tagOf(unit), label: String(words ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) };
  }

  // the node under the pointer while a wire is drawn or an end dragged: lit, and boxed
  let lit = null; let litBox = null;
  function setHover(unit) {
    if (lit !== unit) {
      lit?.classList.remove('dl-wire-lit');
      lit = unit;
      lit?.classList.add('dl-wire-lit');
    }
    if (!unit) { litBox?.remove(); litBox = null; return; }
    litBox ??= Object.assign(document.createElement('div'), { className: 'dl-wire-target' });
    litBox.setAttribute('aria-hidden', 'true');
    if (!litBox.isConnected) root.appendChild(litBox);
    const s = screenBox(unit) ?? unit.getBoundingClientRect();
    const pad = 4;
    Object.assign(litBox.style, { left: `${(s.x ?? s.left) - pad}px`, top: `${(s.y ?? s.top) - pad}px`, width: `${(s.w ?? s.width) + 2 * pad}px`, height: `${(s.h ?? s.height) + 2 * pad}px` });
  }

  // a wire drawn from a dot: a dashed line after the pointer, over the stage
  let wiring = null;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function wiringStart(e, side) {
    if (e.button !== 0 || !handled?.unit || !active()) return;
    e.preventDefault(); e.stopPropagation();
    const { unit, target } = handled;
    const s = screenBox(unit);
    if (!s) return;
    const from = { top: { x: s.x + s.w / 2, y: s.y }, right: { x: s.x + s.w, y: s.y + s.h / 2 }, bottom: { x: s.x + s.w / 2, y: s.y + s.h }, left: { x: s.x, y: s.y + s.h / 2 } }[side];
    const ghost = document.createElementNS(SVG_NS, 'svg');
    ghost.setAttribute('class', 'dl-wire-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    const line = document.createElementNS(SVG_NS, 'line');
    const tip = document.createElementNS(SVG_NS, 'circle');
    tip.setAttribute('r', '4');
    ghost.append(line, tip);
    root.appendChild(ghost);
    wiring = { id: e.pointerId, unit, target, svg: svgOf(unit), from, ghost, line, tip, hover: null };
    root.classList.add('dl-wiring');
    window.getSelection?.()?.removeAllRanges();
    wiringMove(e);
  }
  function wiringMove(e) {
    const W = wiring;
    if (!W || e.pointerId !== W.id) return;
    const hit = e.metaKey || e.ctrlKey ? null : joinableAt(e.clientX, e.clientY, W.svg, [W.unit]);
    W.hover = hit;
    setHover(hit);
    const to = { x: e.clientX, y: e.clientY };
    for (const [a, v] of [['x1', W.from.x], ['y1', W.from.y], ['x2', to.x], ['y2', to.y]]) W.line.setAttribute(a, String(v));
    W.tip.setAttribute('cx', String(to.x)); W.tip.setAttribute('cy', String(to.y));
  }
  async function wiringEnd(e, { cancel = false } = {}) {
    const W = wiring;
    if (!W || (e && e.pointerId !== W.id)) return;
    wiring = null;
    W.ghost.remove();
    setHover(null);
    root.classList.remove('dl-wiring');
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 350);
    // dropped on the canvas, or given up: nothing is made
    if (cancel || !W.hover) return;
    await connect(W.target, W.unit, W.hover);
  }

  /** Arrowhead definitions the server added, put where it put them: a new `<defs>`, or a marker in the one there. */
  function putDefs(top, svg, defs) {
    for (const d of [].concat(defs ?? [])) {
      const n = liveNode(d.html, svg, { ids: true });
      if (d.replaced) liveAt(top, d.path)?.replaceWith(n);
      else insertAt(top, d.path, n);
    }
  }

  /** A connector from node `from` to node `to`, written by the server and put on the slide, selected. */
  async function connect(target, from, to) {
    if (!editmode.available?.()) { toast(editmode.cannot?.('connecting shapes') ?? 'this page cannot write the deck', 3200); return null; }
    const svg = svgOf(from);
    const path = svg && pathFrom(target.top, svg);
    const a = svg && nodeBox(from, IDENTITY, svg); const b = svg && nodeBox(to, IDENTITY, svg);
    const ends = { from: nodeRef(target.top, from), to: nodeRef(target.top, to) };
    if (!path || !ends.from.path || !ends.to.path || !a || !b) { toast('those are the engine’s, not the file’s — nothing to connect', 2600); return null; }
    let j;
    try {
      // as a line, last in the svg: its space is the svg's own
      j = await post('/deck/edit/element/connector', { slide: target.slide, index: target.index, op: 'add', path, tag: 'svg', nodes: ends, geometry: geometryFor('line', 'straight', a, b) });
    } catch (e) { toast(`not connected: ${commit.why(e)}`, 6000); return null; }
    let wire;
    try {
      putDefs(target.top, svg, j.defs);
      if (j.named?.from) from.setAttribute('data-node', j.named.from);
      if (j.named?.to) to.setAttribute('data-node', j.named.to);
      wire = liveNode(j.added.html, svg);
      insertAt(target.top, j.added.path, wire);
    } catch (e) {
      reloadFor('a new connector could not be put on the page', e);
      return null;
    }
    refit([], svg, [wire]);
    editbar.selectNode(wire, { exact: true });
    toast('connected — move either shape and the wire follows', 2000);
    debugLog('edit', `connector ${j.named?.from} → ${j.named?.to} on slide ${target.slide} element #${target.index}`);
    return wire;
  }

  /** A wire's geometry as the server is sent it: a line's ends, a path's data, a polyline's points. */
  function geometryOf(wire) {
    const tag = tagOf(wire);
    const names = tag === 'line' ? ['x1', 'y1', 'x2', 'y2'] : tag === 'path' ? ['d'] : ['points'];
    return Object.fromEntries(names.map((a) => [a, wire.getAttribute(a)]));
  }
  /** What a connector edit changes on a wire: the rest of its attributes are the file's or the engine's, untouched. */
  const WIRE_OWN = ['data-from', 'data-to', 'data-route', 'marker-end', 'marker-start', ...WIRE_GEOMETRY];
  const MARKER_STASH = { 'marker-end': 'drawMarkerEnd', 'marker-start': 'drawMarkerStart' };
  /**
   * The live wire made what the file now says (`html`, the server's): the
   * attributes a connector edit writes, set where it stands, so the
   * selection and a build's hold on it stay. A wire that became another
   * element (a line that bends is a path), or a drawn one whose arrowheads
   * changed (they ride as heads the draw made), is replaced and its slide's
   * builds scanned again.
   */
  function syncWire(live, html, svg) {
    const fresh = liveNode(html, svg);
    const drawn = live.classList.contains('draw-stroke');
    const headsChange = drawn && Object.entries(MARKER_STASH).some(([a, k]) => (fresh.getAttribute(a) ?? undefined) !== live.dataset[k]);
    if (tagOf(fresh) === tagOf(live) && !headsChange) {
      for (const a of WIRE_OWN) {
        if (drawn && a in MARKER_STASH) continue;
        if (fresh.hasAttribute(a)) live.setAttribute(a, fresh.getAttribute(a)); else live.removeAttribute(a);
      }
      return live;
    }
    return replaceDrawn(live, fresh, svg);
  }
  /** `live` replaced by `fresh`, what the engine drew for it (a riding head, a dashed line's mask) gone, and its slide's builds scanned again. */
  function replaceDrawn(live, fresh, svg) {
    const drawn = live.classList.contains('draw-stroke');
    for (const h of Object.values(live._drawHeads ?? {})) h.el?.remove();
    const mask = /url\(\s*["']?#([^"')\s]+)/.exec(live.getAttribute('mask') ?? '')?.[1];
    if (mask) svg.querySelector(`[id="${CSS.escape(mask)}"].draw-mask`)?.remove();
    const step = live.closest('.build-step');
    live.replaceWith(fresh);
    if (drawn || step) instance._rescanFor?.(fresh);
    return fresh;
  }

  /**
   * One connector edit (`op`: reconnect, detach, route, arrows, reverse) on
   * the live `wire`, sent with the geometry it has now unless `extra` says
   * one; the answer put on the page. A refusal puts back what `before`
   * remembers.
   */
  async function wireOp(target, wire, op, extra = {}, { before = null, node = null } = {}) {
    const svg = svgOf(wire);
    const path = pathFrom(target.top, wire);
    const undo = () => { if (before) { restore(before); refit([wire], svg); placeHandles(); } };
    if (!path) { undo(); toast('that wire is the engine’s, not the file’s', 2600); return null; }
    const body = { slide: target.slide, index: target.index, op, wire: { path, tag: tagOf(wire) }, ...extra };
    if (op !== 'arrows' && !extra.geometry) body.geometry = geometryOf(wire);
    let j;
    try { j = await post('/deck/edit/element/connector', body); } catch (e) { undo(); toast(commit.notSaved('connector', e), 6000); return null; }
    let live;
    try {
      putDefs(target.top, svg, j.defs);
      if (node && j.named) for (const name of Object.values(j.named)) node.setAttribute('data-node', name);
      live = syncWire(wire, j.wire.html, svg);
    } catch (e) {
      reloadFor('a connector could not be redrawn', e);
      return null;
    }
    refit([live], svg, [live]);
    if (editbar.selected()?.node !== live) editbar.selectNode(live, { exact: true });
    else showHandles(editbar.selected());
    debugLog('edit', `connector ${op}: slide ${target.slide} element #${target.index} › ${j.wire.path.join('.')}`);
    return live;
  }

  // the element menu's Wire ▸ on a wire (editmode.js): its route, its arrows, Reverse
  /** The wire a target is, when the menu offers its rows: a connector, or a line drawn by hand. */
  function wireOf(target) {
    const n = target?.node;
    return n && isDrawn(n) && diagramOf(target) && pathFrom(target.top, n) && (isConnector(n) || tagOf(n) === 'line') ? n : null;
  }
  /** `{ route, arrows }` of the wire a target is: the ticks of the menu's rows. */
  function wireState(target) {
    const w = wireOf(target);
    if (!w) return null;
    const end = w.getAttribute('marker-end') ?? w.dataset.drawMarkerEnd ?? null;
    const start = w.getAttribute('marker-start') ?? w.dataset.drawMarkerStart ?? null;
    return { route: routeOf(w), arrows: end && start ? 'both' : end ? 'end' : start ? 'start' : 'none' };
  }
  async function setRoute(target, route) {
    const w = wireOf(target);
    if (!w) return null;
    const geometry = wireGeometry(w, { route, tag: tagForRoute(tagOf(w), route) });
    if (!geometry) { toast('a node this wire names is not in the diagram: reconnect its end first', 3200); return null; }
    return wireOp(target, w, 'route', { route, geometry });
  }
  async function setArrows(target, arrows) {
    const w = wireOf(target);
    return w ? wireOp(target, w, 'arrows', { arrows }) : null;
  }
  async function reverse(target) {
    const w = wireOf(target);
    if (!w) return null;
    const svg = svgOf(w);
    const ends = endsOf(tagOf(w), (a) => w.getAttribute(a));
    const named = (a) => (w.getAttribute(a) ? nodeNamed(svg, w.getAttribute(a)) : null);
    const geometry = ends && wireGeometry(w, { from: named('data-to') ?? ends.end, to: named('data-from') ?? ends.start });
    if (!geometry) return null;
    return wireOp(target, w, 'reverse', { geometry });
  }

  // Line ▸ and Corners ▸ (SVG_DIAGRAMS): a stroke solid, dashed or dotted,
  // a box's corners square, rounded or a pill
  /** The stroke a target is, for Line ▸: a wire, a line, a polyline, or a path that is only a stroke. */
  function strokeOf(target) {
    const n = target?.node;
    if (!n || !isDrawn(n) || !diagramOf(target) || !pathFrom(target.top, n)) return null;
    const tag = tagOf(n);
    if (wireOf(target) || tag === 'line' || tag === 'polyline') return n;
    return tag === 'path' && getComputedStyle(n).fill === 'none' ? n : null;
  }
  /** The dashes the file gives a live stroke: a drawn one keeps them inline when they dash (builds.js), else they are stashed. */
  function authoredDashes(n) {
    if (n.hasAttribute('data-draw-masked')) return n.style.strokeDasharray;
    if (n.classList.contains('draw-stroke')) return n.dataset.drawOrig ?? '';
    return n.style.strokeDasharray || n.getAttribute('stroke-dasharray') || '';
  }
  /** 'solid', 'dashed' or 'dotted': what the stroke the target is draws as. */
  function lineState(target) {
    const n = strokeOf(target);
    return n ? lineOf(authoredDashes(n)) : null;
  }
  /** Line ▸: the stroke made solid, dashed or dotted, in one write; a drawn one rebuilt as the file now has it. */
  async function setLine(target, line) {
    const n = strokeOf(target);
    if (!n || !LINES.includes(line)) return null;
    const was = lineState(target);
    const path = pathFrom(target.top, n);
    const edits = [{ path, tag: tagOf(n), prop: 'stroke-dasharray', value: LINE_DASHES[line] ?? null }];
    // a dot is a round cap on a dash of nothing; leaving the dots takes the cap they had off
    if (line === 'dotted' || was === 'dotted') edits.push({ path, tag: tagOf(n), prop: 'stroke-linecap', value: line === 'dotted' ? 'round' : null });
    let j;
    try { j = await post('/deck/edit/element/style', { slide: target.slide, index: target.index, edits, echo: true }); }
    catch (e) { toast(commit.notSaved('line', e), 6000); return null; }
    const svg = svgOf(n);
    let live = n;
    try {
      const fresh = liveNode(j.nodes?.[0]?.html ?? '', svg);
      if (n.classList.contains('draw-stroke') || n.closest('.build-step')) live = replaceDrawn(n, fresh, svg);
      else for (const a of ['style', 'stroke-dasharray', 'stroke-linecap']) { if (fresh.hasAttribute(a)) n.setAttribute(a, fresh.getAttribute(a)); else n.removeAttribute(a); }
    } catch (e) {
      reloadFor('a restyled line could not be redrawn', e);
      return null;
    }
    refit([live], svg, isConnector(live) ? [live] : []);
    if (editbar.selected()?.node !== live) editbar.selectNode(live, { exact: true });
    debugLog('edit', `line ${line}: slide ${target.slide} element #${target.index} › ${path.join('.')}`);
    return live;
  }
  /** The box a target's corners are: a rect, or the rect of the box group it is. */
  function cornerBox(target) {
    const r = resizable(target);
    return r?.kind === 'box' && tagOf(r.shape) === 'rect' ? r.shape : null;
  }
  /** 'square', 'rounded' or 'pill': the corners of the box the target is. */
  function cornerState(target) {
    const b = cornerBox(target);
    return b ? cornersOf(Object.fromEntries(['width', 'height', 'rx', 'ry'].filter((a) => b.hasAttribute(a)).map((a) => [a, num(b, a)]))) : null;
  }
  /** Corners ▸: the box's `rx` and `ry`, one geometry write; a pill's follow its size when it is resized. */
  async function setCorners(target, corners) {
    const b = cornerBox(target);
    if (!b || !CORNERS.includes(corners)) return null;
    const before = new Map([[b, { rx: b.getAttribute('rx'), ry: b.getAttribute('ry') }]]);
    const r = cornerRadius(corners, num(b, 'width'), num(b, 'height'));
    for (const a of ['rx', 'ry']) { if (r === null) b.removeAttribute(a); else b.setAttribute(a, String(r)); }
    refit([b], svgOf(b));
    const ok = await save(target, before, 'corners');
    placeHandles();
    return ok ? b : null;
  }

  // ── front and back (SVG_DIAGRAMS): Shape ▸ Order ▸, and Move up / down on a shape ──
  /** What is not drawn in a diagram: never moved past, never counted. */
  const NOT_PAINTED = new Set(['defs', 'title', 'desc', 'style', 'metadata', 'script']);
  /** What front and back moves for a selection: its box group when it is the shape of one, else the node. */
  const orderUnit = (target) => {
    const n = target?.node;
    if (!n || !isDrawn(n) || tagOf(n) === 'tspan' || !diagramOf(target) || n === diagramOf(target)) return null;
    const u = duplicateUnit(n);
    return pathFrom(target.top, u)?.length ? u : null;
  };
  /** Its drawn siblings and where it stands among them. */
  function paintOrder(unit) {
    const drawn = authoredKids(unit.parentElement).filter((k) => !NOT_PAINTED.has(tagOf(k)));
    return { drawn, here: drawn.indexOf(unit) };
  }
  /** Can the selection go `to` ('front', 'forward', 'backward', 'back')? Not when it is already there. */
  function canOrder(target, to) {
    const u = orderUnit(target);
    if (!u) return false;
    const { drawn, here } = paintOrder(u);
    return to === 'front' || to === 'forward' ? here < drawn.length - 1 : here > 0;
  }
  const ORDER_SAID = { front: 'brought to the front', forward: 'brought forward', backward: 'sent backward', back: 'sent to the back' };
  /**
   * The selection to the front, forward, backward or to the back. When the
   * diagram builds, the slide's clicks as they play now go with it, so the
   * server freezes them (a key on every step) before the node moves: the
   * builds and the notes' beats stay as they were. The page then makes the
   * same move, the engine's nodes riding with it, and counts the steps again.
   */
  /**
   * The slide's play order as the server freezes it (setSlideBuildOrder with
   * `freeze`) before a change that moves what plays in document order: front
   * and back, Group, Ungroup. `{ sec, slideAt, step, built, flat, groups }`:
   * `groups` null when nothing of the diagram builds; null (said) when a
   * step is the engine's and cannot be named.
   */
  function playOrder(svg) {
    const sec = svg.closest('section');
    const slideAt = instance._sections?.indexOf(sec) ?? -1;
    const rec = instance._records?.[slideAt];
    const step = instance.state?.slide === slideAt + 1 ? instance.state.step : 0;
    // the diagram builds: freeze the slide's play order (build-edit.js's shape of it)
    const built = !!rec?.steps?.some((st) => st.el && (st.el === svg || svg.contains(st.el)));
    if (!built) return { sec, slideAt, step, built, flat: [], groups: null };
    const g = orderGroups(rec.groups, rec.steps.map((st) => ({ node: st.el, count: st.kind === 'provider' ? st.provider?.count ?? 1 : 1 })));
    const flat = g.flat();
    const addrs = flat.map(({ node }) => addressOf(instance, node));
    if (addrs.some((a) => !a)) { toast('a step on this slide is the engine’s, not the file’s: its order cannot be frozen', 3200); return null; }
    let k = 0;
    const groups = g.map((grp) => grp.map(({ count }) => { const a = addrs[k++]; return { index: a.index, ...(a.path.length ? { path: a.path } : {}), tag: a.tag, ...(count > 1 ? { count } : {}) }; }));
    return { sec, slideAt, step, built, flat, groups };
  }
  /** Each step's key as the server stamped it, on the page. */
  function stampOrders(flat, orders) {
    (orders ?? []).forEach((o, i) => {
      const node = flat[i]?.node;
      if (node) { if (o.order === null) node.removeAttribute('data-build-order'); else node.setAttribute('data-build-order', o.order); }
    });
  }
  /** The slide's steps counted again after such a change, the slide left on the click it was on. */
  function rescan({ sec, slideAt, step, built }) {
    if (!built) return;
    clearBuildMarks(sec);
    instance.refreshSlide?.(sec, { scan: true, relayout: false });
    if (instance.state?.slide === slideAt + 1 && instance.state.step !== step) instance.goto(slideAt + 1, step);
  }

  async function order(target, to) {
    if (!editmode.available?.()) { toast(editmode.cannot?.('changing what covers what') ?? 'this page cannot write the deck', 3200); return null; }
    const unit = orderUnit(target);
    if (!unit || !canOrder(target, to)) { toast(unit ? `it is already ${to === 'front' || to === 'forward' ? 'at the front' : 'at the back'}` : 'select a shape in a diagram to change what covers it', 2400); return null; }
    const svg = diagramOf(target);
    const play = playOrder(svg);
    if (!play) return null;
    const { sec, slideAt, built, flat, groups } = play;
    const path = pathFrom(target.top, unit);
    let j;
    try {
      j = await post('/deck/edit/element/order', { slide: target.slide, index: target.index, path, tag: tagOf(unit), to, ...(groups ? { groups } : {}) });
    } catch (e) { toast(commit.notSaved('the order', e), 6000); return null; }
    try {
      stampOrders(flat, j.orders);
      // the node and what the engine drew for it (a riding head, a dashed line's mask) move together
      const riders = [];
      for (let n = unit.nextElementSibling; n?.matches(ENGINE_NODES); n = n.nextElementSibling) riders.push(n);
      unit.remove(); for (const r of riders) r.remove();
      insertAt(target.top, j.path, unit);
      unit.after(...riders);
    } catch (e) {
      reloadFor('a shape could not be put where the file now has it', e);
      return null;
    }
    rescan(play);
    // a nested shape's tone is by what it sits on (data-nest): painted again
    refit([], svg);
    editbar.selectNode(target.node.isConnected ? target.node : unit, { exact: true });
    toast(ORDER_SAID[to], 1400);
    debugLog('edit', `order ${to}: slide ${target.slide} element #${target.index} › ${path.join('.')} → ${j.path.join('.')}`);
    return unit;
  }

  // ── several shapes of one diagram (SVG_DIAGRAMS) ──────────────────────────
  // Selected together (⇧-click, a marquee: editbar.js and below), they move
  // together, nudge together, are arranged, removed, duplicated, recoloured
  // and given a concept together: each ONE write, one undo.
  /** Are these targets shapes of one diagram? */
  const areShapes = (targets) => targets?.length > 1 && targets.every((t) => t.node && t.node !== t.top && isDrawn(t.node) && t.top === targets[0].top
    && t.node.ownerSVGElement && t.node.ownerSVGElement === targets[0].node.ownerSVGElement);
  /** The nodes these targets move as: each one's box group or itself, none inside another. */
  function unitsOf(targets) {
    const units = [...new Set(targets.map((t) => duplicateUnit(t.node)))];
    return units.filter((u) => !units.some((o) => o !== u && o.contains(u)));
  }
  /** Each of `units` moved by its own step (`moves[i]`: `{ dx, dy }` in the svg's units), into one `before`. */
  function moveUnits(target, units, moves, before) {
    const svg = units[0].ownerSVGElement;
    const ctm = svg.getScreenCTM?.();
    if (!ctm) return [];
    const states = [];
    units.forEach((u, i) => {
      const m = moves[i];
      if (!m || (!m.dx && !m.dy)) return;
      const st = moveState(target, [u], 0, 0, before);
      if (!st) return;
      const sx = ctm.a * m.dx + ctm.c * m.dy; const sy = ctm.b * m.dx + ctm.d * m.dy;
      for (const p of st.parts) {
        const d = localStep(p.inv, sx, sy);
        if (p.translate) {
          const t = setTranslate(p.t0, keepGrain(p.at.x, p.at.x + d.x), keepGrain(p.at.y, p.at.y + d.y));
          if (t) p.m.setAttribute('transform', t); else p.m.removeAttribute('transform');
          continue;
        }
        for (const q of p.pairs) {
          if (q.ax) q.el.setAttribute(q.ax, String(keepGrain(q.x0, q.x0 + d.x)));
          if (q.ay) q.el.setAttribute(q.ay, String(keepGrain(q.y0, q.y0 + d.y)));
        }
      }
      refit(st.members, st.svg, st.wires);
      states.push(st);
    });
    root.classList.remove('dl-shape-dragging');
    return states;
  }
  /** ←↑→↓ with several shapes selected: all of them a unit (⇧: ten), one write. */
  async function nudge(targets, dx, dy) {
    if (!areShapes(targets) || !editmode.available?.()) return false;
    const units = unitsOf(targets);
    const before = new Map();
    moveUnits(targets[0], units, units.map(() => ({ dx, dy })), before);
    return save(targets[0], before, 'nudge');
  }
  /** Arrange ▸ `how` (ARRANGE) on several shapes: one write, its wires and labels with it. */
  async function arrange(targets, how) {
    if (!areShapes(targets)) { toast('Arrange is for several shapes of one diagram', 2400); return false; }
    if (!editmode.available?.()) { toast(editmode.cannot?.('arranging shapes') ?? 'this page cannot write the deck', 3200); return false; }
    if ((how === 'across' || how === 'down') && targets.length < 3) { toast('spacing evenly needs three shapes or more', 2400); return false; }
    const units = unitsOf(targets);
    const svg = units[0].ownerSVGElement;
    const boxes = units.map((u) => nodeBox(u, IDENTITY, svg));
    if (boxes.some((b) => !b)) return false;
    const plan = arrangeBoxes(boxes, how);
    const before = new Map();
    const extra = [];
    if (how === 'width' || how === 'height') {
      // the same size as the primary: each shape's box made so, its labels following and wrapped again
      units.forEach((u, i) => {
        const want = plan[i];
        if (!('w' in want) && !('h' in want)) return;
        const r = resizable({ node: u, top: targets[0].top, clicked: u });
        if (r?.kind !== 'box') return;
        const shape = r.shape;
        const was = {};
        for (const a of ['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry']) if (shape.hasAttribute(a)) was[a] = num(shape, a);
        keepAttrs(before, shape, Object.keys(was));
        const marked = markedShape(shape);
        if (marked) keepAttrs(before, shape, [marked.attr]);
        const old = boxOf(shape);
        const m = toRoot(shape, svg);
        const nb = { ...old, ...('w' in want ? { w: want.w / (Math.hypot(m.a, m.b) || 1) } : {}), ...('h' in want ? { h: want.h / (Math.hypot(m.c, m.d) || 1) } : {}) };
        const labels = labelsOn(shape).filter((t) => !t.hasAttribute('transform') && numericAttr(t, 'x') && numericAttr(t, 'y')).map((t) => {
          keepAttrs(before, t, ['x', 'y']);
          const rows = linesOf(t) && t.children.length ? [...t.children].filter((k) => k.hasAttribute('x')) : [];
          for (const k of rows) keepAttrs(before, k, ['x']);
          return { t, x: num(t, 'x'), y: num(t, 'y'), anchor: t.getAttribute('text-anchor') ?? getComputedStyle(t).textAnchor ?? 'start', rows: rows.map((k) => ({ k, x: num(k, 'x') })), html: t.innerHTML };
        });
        setBox(shape, nb, was);
        const now = boxOf(shape);
        for (const l of labels) {
          const q = followLabel(l, old, now);
          const nx = keepGrain(l.x, q.x);
          l.t.setAttribute('x', String(nx));
          l.t.setAttribute('y', String(keepGrain(l.y, q.y)));
          for (const row of l.rows) row.k.setAttribute('x', String(keepGrain(row.x, row.x + (nx - l.x))));
        }
        keepWires(svg, before);
        refit([shape], svg, connectorsIn(svg));
        extra.push(...rewrap(labels, before, targets[0].top).map((x) => x.edit));
      });
    } else moveUnits(targets[0], units, plan, before);
    const ok = await save(targets[0], before, 'arrange', extra);
    markOverflow(svg);
    if (ok) toast(ARRANGE_SAID[how], 1400);
    return ok;
  }
  const ARRANGE_SAID = {
    left: 'aligned left', center: 'centred', right: 'aligned right', top: 'aligned top', middle: 'aligned in the middle',
    bottom: 'aligned bottom', across: 'spaced evenly across', down: 'spaced evenly down', width: 'made the same width', height: 'made the same height',
  };
  /** Remove several shapes: one write, their connectors with them. */
  async function removeMany(targets) {
    if (!areShapes(targets) || !editmode.available?.()) return false;
    const t0 = targets[0];
    const svg = t0.node.ownerSVGElement;
    const units = unitsOf(targets);
    const paths = units.map((u) => ({ path: pathFrom(t0.top, u), tag: tagOf(u) }));
    if (paths.some((p) => !p.path)) { toast('one of them is the engine’s, not the file’s', 2600); return false; }
    try { await post('/deck/edit/element/remove', { slide: t0.slide, index: t0.index, paths }); }
    catch (e) { toast(commit.notSaved(`${units.length} shapes`, e), 6000); return false; }
    // the page as the file now is: the shapes, and the wires their names held
    const names = new Set(units.flatMap((u) => [u, ...u.querySelectorAll('[data-node]')].map((n) => n.getAttribute('data-node')).filter(Boolean)));
    for (const w of connectorsIn(svg)) {
      if (!names.has(w.getAttribute('data-from')) && !names.has(w.getAttribute('data-to'))) continue;
      // a wire's label goes with it, as the file's does (a label on a wire)
      for (const l of wireLabels(w)) l.remove();
      for (const h of Object.values(w._drawHeads ?? {})) h.el?.remove();
      w.remove();
    }
    for (const u of units) u.remove();
    refit([], svg);
    hideHandles();
    toast(`${units.length} shapes removed · ${editmode.undoChord?.() ?? 'undo'} takes them back`, 2400);
    return true;
  }
  /** Duplicate several shapes: one write, the copies selected. */
  async function duplicateMany(targets) {
    if (!areShapes(targets) || !editmode.available?.()) return false;
    const t0 = targets[0];
    const svg = t0.node.ownerSVGElement;
    const units = unitsOf(targets);
    const paths = units.map((u) => ({ path: pathFrom(t0.top, u), tag: tagOf(u) }));
    if (paths.some((p) => !p.path)) return false;
    let j;
    try { j = await post('/deck/edit/element/shape', { slide: t0.slide, index: t0.index, op: 'duplicate', paths }); }
    catch (e) { toast(`not duplicated: ${commit.why(e)}`, 6000); return false; }
    let copies;
    try {
      // where the file put each, the lowest first, so each path is right as it lands
      const order = j.added.map((a, i) => ({ a, i })).sort((x, y) => x.a.path.at(-1) - y.a.path.at(-1));
      copies = [];
      for (const { a, i } of order) { const c = liveNode(a.html, svg); insertAt(t0.top, a.path, c); copies[i] = c; }
    } catch (e) { reloadFor('the copies could not be put on the page', e); return false; }
    refit([], svg, copies.flatMap((c) => connectorsIn(c)));
    editbar.selectShapes?.(copies.map((c, i) => {
      const u = units[i]; const n = targets.find((t) => duplicateUnit(t.node) === u)?.node ?? u;
      const rel = u === n ? [] : pathFrom(u, n);
      return (rel && liveAt(c, rel)) || c;
    }));
    toast(`${copies.length} shapes duplicated`, 1600);
    return true;
  }
  /** Style edits (`[{ prop, value }]`) on each of several shapes: shown at once, one write. */
  async function styleMany(targets, edits) {
    if (!areShapes(targets) || !editmode.available?.()) return false;
    const t0 = targets[0];
    const shapesOf = targets.map((t) => (BOX_SHAPES.has(tagOf(t.node)) || WIRE_TAGS.has(tagOf(t.node)) ? t.node : null)).filter(Boolean);
    const was = shapesOf.map((n) => [n, n.getAttribute('style'), n.dataset.nestFill]);
    for (const n of shapesOf) {
      for (const ed of edits) {
        if (ed.value === null) n.style.removeProperty(ed.prop); else n.style.setProperty(ed.prop, ed.value);
        // the nesting pass paints a shape from the fill it was authored with (svg.js): this is that fill now
        if (ed.prop === 'fill') { if (ed.value === null) delete n.dataset.nestFill; else n.dataset.nestFill = ed.value; }
      }
    }
    try {
      await post('/deck/edit/element/style', { slide: t0.slide, index: t0.index, edits: shapesOf.flatMap((n) => edits.map((ed) => ({ path: pathFrom(t0.top, n), tag: tagOf(n), prop: ed.prop, value: ed.value }))) });
    } catch (e) {
      for (const [n, v, nest] of was) { if (v === null) n.removeAttribute('style'); else n.setAttribute('style', v); if (nest === undefined) delete n.dataset.nestFill; else n.dataset.nestFill = nest; }
      toast(commit.notSaved('the colour', e), 6000);
      return false;
    }
    // a nested shape takes its panel's tone of the new colour: the nesting painted again
    refit([], targets[0].node.ownerSVGElement);
    return true;
  }

  // the marquee: a drag on a diagram's empty canvas selects every shape it covers
  let marquee = null;
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || drag || resizing || !active()) return;
    const svg = e.target?.tagName?.toLowerCase?.() === 'svg' ? e.target : null;
    if (!svg || svg.parentElement?.closest('svg') || svg.closest('[data-chart]') || !editmode.elementTargetOf(svg)?.top) return;
    marquee = { svg, x0: e.clientX, y0: e.clientY, id: e.pointerId, el: null };
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (!marquee || e.pointerId !== marquee.id) return;
    if (!marquee.el) {
      if (Math.hypot(e.clientX - marquee.x0, e.clientY - marquee.y0) < DRAG_AFTER) return;
      marquee.el = Object.assign(document.createElement('div'), { className: 'dl-marquee' });
      root.appendChild(marquee.el);
    }
    const x = Math.min(e.clientX, marquee.x0); const y = Math.min(e.clientY, marquee.y0);
    Object.assign(marquee.el.style, { left: `${x}px`, top: `${y}px`, width: `${Math.abs(e.clientX - marquee.x0)}px`, height: `${Math.abs(e.clientY - marquee.y0)}px` });
  });
  window.addEventListener('pointerup', (e) => {
    const m = marquee;
    if (!m || e.pointerId !== m.id) return;
    marquee = null;
    if (!m.el) return;
    const box = m.el.getBoundingClientRect();
    m.el.remove();
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 350);
    // what it covers whole: each drawn thing of the canvas, a box group by its shape, never a wire
    const inside = (r) => r.width + r.height > 0 && r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom;
    const picked = authoredKids(m.svg).filter((k) => isDrawn(k) && !isConnector(k) && !/^(defs|title|desc|style|metadata)$/.test(tagOf(k)) && inside(k.getBoundingClientRect()))
      .map((k) => (tagOf(k) === 'g' ? authoredKids(k).find((c) => BOX_SHAPES.has(tagOf(c)) && boxGroupOf(c) === k) ?? k : k));
    editbar.selectShapes?.(picked);
    debugLog('edit', `marquee: ${picked.length} shape${picked.length === 1 ? '' : 's'}`);
  });

  // ── a label on a wire (SVG_DIAGRAMS): Wire ▸ Label… ────────────────────────
  /** The wire a label rides on, or null: a text of the diagram naming a wire it has. */
  function wireOfLabel(el) {
    const name = tagOf(el) === 'text' ? el.getAttribute('data-on-wire') : null;
    const svg = name && el.ownerSVGElement;
    return svg ? connectorsIn(svg).find((w) => w.getAttribute('data-wire') === name) ?? null : null;
  }
  /** The label the wire a target is has, or null. */
  const labelOfWire = (target) => { const w = wireOf(target); return w ? wireLabels(w)[0] ?? null : null; };
  /**
   * Wire ▸ Label…: a wire's label put at its middle and typed into straight
   * away (the server names the wire and writes the label: `op: 'label'`), or
   * its label, when it has one, typed into.
   */
  async function labelWire(target) {
    const w = wireOf(target);
    if (!w) return null;
    const had = wireLabels(w)[0];
    if (had) { editbar.selectNode(had, { exact: true }); authoring.editInline(had); return had; }
    if (!isConnector(w)) { toast('a label rides on a wire that joins two shapes: attach this line first', 3200); return null; }
    const svg = svgOf(w);
    const mid = applyTo(toRoot(w, svg), pointAlong(wirePoints(w), 0.5));
    const path = pathFrom(target.top, w);
    let j;
    try {
      j = await post('/deck/edit/element/connector', { slide: target.slide, index: target.index, op: 'label', wire: { path, tag: tagOf(w) }, text: 'Label', at: { x: Math.round(mid.x * 10) / 10, y: Math.round(mid.y * 10) / 10 } });
    } catch (e) { toast(`the label was not added: ${commit.why(e)}`, 6000); return null; }
    let label;
    try {
      if (j.named?.wire) w.setAttribute('data-wire', j.named.wire);
      label = liveNode(j.added.html, svg);
      insertAt(target.top, j.added.path, label);
    } catch (e) {
      reloadFor('a wire\'s label could not be put on the page', e);
      return null;
    }
    placeWireLabels(w);
    editbar.selectNode(label, { exact: true });
    authoring.editInline(label);
    debugLog('edit', `wire label added: slide ${target.slide} element #${target.index} › ${j.added.path.join('.')}`);
    return label;
  }

  // ── groups (SVG_DIAGRAMS): Group, Ungroup, and a <g> the author wrote ────
  // A group is a `<g data-group>`: picked whole by a first click, a level
  // down by the next (pick.js), and moved, duplicated, copied, removed and
  // sent to the front or the back as one node, which those already do for a
  // `<g>`. A plain `<g>` (a box group, a step unit) keeps its clicks; the
  // menu offers to select it whole, or to make it a group.
  const NOT_PAINTED_TAGS = /^(defs|title|desc|style|metadata|script)$/;
  /** The drawn things a `<g>` holds, as the file has them. */
  const drawnKids = (g) => authoredKids(g).filter((k) => isDrawn(k) && !NOT_PAINTED_TAGS.test(tagOf(k)));
  /** What a member of a group is selected as: a box group by its shape, anything else itself. */
  const pickableOf = (m) => (tagOf(m) === 'g' ? authoredKids(m).find((c) => BOX_SHAPES.has(tagOf(c)) && boxGroupOf(c) === m) ?? m : m);
  /** A plain `<g>` of the diagram (not a group, not the engine's) holding two drawn things or more, or null. */
  const plainGroup = (g, svg) => (g && g !== svg && tagOf(g) === 'g' && !isGroup(g) && !g.matches(ENGINE_NODES) && svg?.contains(g) && drawnKids(g).length >= 2 ? g : null);
  /** The plain `<g>` a selection stands in (its box group's parent, else its own): "Select the whole group" selects it. */
  function wholeOf(target) {
    const n = target?.node; const svg = diagramOf(target);
    if (!n || !svg || n === svg || !isDrawn(n) || tagOf(n) === 'tspan') return null;
    const g = plainGroup(duplicateUnit(n).parentElement, svg);
    return g && pathFrom(target.top, g) ? g : null;
  }
  /** The `<g>` Ungroup takes apart for a selection: a group, or a plain `<g>` selected whole. */
  function ungroupable(target) {
    const n = target?.node; const svg = diagramOf(target);
    return n && svg && pathFrom(target.top, n)?.length && (isGroup(n) || plainGroup(n, svg)) ? n : null;
  }
  /** The `<g>` "Make it a group" marks for a selection: the plain `<g>` selected, or the one it stands in. */
  const markable = (target) => (plainGroup(target?.node, diagramOf(target)) && pathFrom(target.top, target.node) ? target.node : wholeOf(target));
  const cannotWrite = (what) => { toast(editmode.cannot?.(what) ?? 'this page cannot write the deck', 3200); };
  /** Is `a` before `b` in the page? */
  const paintsBefore = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  /** `n` and what the engine drew right after it for it (a riding head, a dashed line's mask). */
  const withRiders = (n) => { const out = [n]; for (let r = n.nextElementSibling; r?.matches(ENGINE_NODES); r = r.nextElementSibling) out.push(r); return out; };

  /**
   * Group: several shapes of one diagram, siblings in the file, wrapped in one
   * `<g data-group>` where the frontmost stood, in one write and one undo.
   * The page makes the same `<g>` round the very nodes it shows, and selects it.
   */
  async function group(targets) {
    if (!areShapes(targets)) { toast('⇧-click two shapes or more of one diagram, then group them', 2600); return null; }
    if (!editmode.available?.()) { cannotWrite('grouping shapes'); return null; }
    const t0 = targets[0];
    const svg = diagramOf(t0);
    const units = unitsOf(targets).sort((a, b) => (paintsBefore(a, b) ? -1 : 1));
    if (units.length < 2) { toast('these are one shape: ⇧-click another to group them', 2400); return null; }
    if (units.some((u) => u.parentElement !== units[0].parentElement)) { toast('these do not stand side by side in the file (one is inside a group): group shapes that share a parent', 3600); return null; }
    const paths = units.map((u) => ({ path: pathFrom(t0.top, u), tag: tagOf(u) }));
    if (paths.some((p) => !p.path?.length)) { toast('one of them is the engine’s, not the file’s', 2600); return null; }
    // in a diagram that builds, the clicks as they play go with it, frozen first: none of them changes
    const play = playOrder(svg);
    if (!play) return null;
    let j;
    try { j = await post('/deck/edit/element/group', { slide: t0.slide, index: t0.index, op: 'group', paths, ...(play.groups ? { groups: play.groups } : {}) }); }
    catch (e) { toast(`not grouped: ${commit.why(e)}`, 6000); return null; }
    // what stood between them that is not one of them is behind the group now
    const kids = drawnKids(units[0].parentElement);
    const between = kids.slice(kids.indexOf(units[0]), kids.indexOf(units.at(-1)) + 1).some((k) => !units.includes(k));
    let g;
    try {
      stampOrders(play.flat, j.orders);
      // the group as the file has it (its build, when the diagram builds), round the very nodes on the page
      g = liveNode(`${/^<g\b[^>]*>/.exec(j.markup ?? '')?.[0] ?? '<g data-group>'}</g>`, svg);
      withRiders(units.at(-1)).at(-1).after(g);
      for (const u of units) g.append(...withRiders(u));
      if (pathFrom(t0.top, g)?.join('.') !== j.path?.join('.')) throw new Error(`the page has it at ${pathFrom(t0.top, g)?.join('.')}, the file at ${j.path?.join('.')}`);
    } catch (e) { reloadFor('a group could not be made where the file made it', e); return null; }
    rescan(play);
    refit([], svg);
    editbar.selectNode(g, { exact: true });
    toast(`${units.length} shapes grouped${between ? ' · what stood between them is behind the group now' : ''}`, between ? 3200 : 1600);
    debugLog('edit', `group: slide ${t0.slide} element #${t0.index} › ${j.path.join('.')} (${units.length} nodes)`);
    return g;
  }

  /**
   * Ungroup: the members of a group (or of a plain `<g>` selected whole) put
   * back where it stood, its move given to each, in one write; a wire joined
   * to the group is joined to its nearest member (the server picks it and
   * names it). The page puts the members as the file has them now, and
   * selects them.
   */
  async function ungroup(target) {
    if (!editmode.available?.()) { cannotWrite('taking a group apart'); return null; }
    const g = ungroupable(target);
    if (!g) { toast('select a group to take it apart', 2400); return null; }
    const svg = diagramOf(target);
    const name = g.getAttribute('data-node');
    const joined = name ? connectorsIn(svg).filter((w) => w.getAttribute('data-from') === name || w.getAttribute('data-to') === name) : [];
    const path = pathFrom(target.top, g);
    const play = playOrder(svg);
    if (!play) return null;
    let j;
    try { j = await post('/deck/edit/element/group', { slide: target.slide, index: target.index, op: 'ungroup', path, tag: 'g', ...(play.groups ? { groups: play.groups } : {}) }); }
    catch (e) { toast(`not taken apart: ${commit.why(e)}`, 6000); return null; }
    let fresh;
    try {
      stampOrders(play.flat, j.orders);
      fresh = j.members.map((m) => liveNode(m.html, svg, { ids: true }));
      g.replaceWith(...fresh);
      joined.forEach((w, i) => { for (const end of ['from', 'to']) { const v = j.wires?.[i]?.[end]; if (v) w.setAttribute(`data-${end}`, v); } });
      if (fresh[0] && pathFrom(target.top, fresh[0])?.join('.') !== j.members[0].path.join('.')) throw new Error('the members are not where the file put them');
    } catch (e) { reloadFor('a group could not be taken apart as the file was', e); return null; }
    rescan(play);
    refit(fresh, svg, connectorsIn(svg));
    const drawn = fresh.filter((m) => isDrawn(m) && !NOT_PAINTED_TAGS.test(tagOf(m))).map(pickableOf);
    if (drawn.length > 1) editbar.selectShapes?.(drawn); else if (drawn[0]) editbar.selectNode(drawn[0], { exact: true });
    toast(`taken apart: ${drawn.length} shape${drawn.length === 1 ? '' : 's'}${joined.length ? `, ${joined.length === 1 ? 'its wire' : 'its wires'} joined to the nearest` : ''}`, 1800);
    debugLog('edit', `ungroup: slide ${target.slide} element #${target.index} › ${path.join('.')} (${fresh.length} members)`);
    return fresh;
  }

  /** "Make it a group": the plain `<g>` a selection stands in given `data-group`, then selected whole. */
  async function markGroup(target) {
    if (!editmode.available?.()) { cannotWrite('making a group'); return null; }
    const g = markable(target);
    if (!g) { toast('this is not inside a group of shapes', 2400); return null; }
    try { await post('/deck/edit/element/group', { slide: target.slide, index: target.index, op: 'mark', path: pathFrom(target.top, g), tag: 'g' }); }
    catch (e) { toast(`not made a group: ${commit.why(e)}`, 6000); return null; }
    g.setAttribute('data-group', '');
    editbar.selectNode(g, { exact: true });
    toast('a group now: a click selects it whole, a second click a shape in it', 2600);
    return g;
  }

  /** "Select the whole group": the plain `<g>` a selection stands in, selected, to move, copy or remove as one. */
  function selectWhole(target) {
    const g = wholeOf(target);
    if (g) editbar.selectNode(g, { exact: true });
    return g;
  }

  editbar.onSelect?.((t) => { if (t) showHandles(t); else hideHandles(); });
  editmode.onElementEditChange?.(() => { if (!active()) hideHandles(); });
  instance.on?.('slide', () => hideHandles());

  // ── add and duplicate (the element menu) ─────────────────────────────────
  /** This svg's live id prefix (namespaceSvgIds), made up for one that had no ids. */
  function idPrefix(svg) {
    for (const el of svg.querySelectorAll('[id]')) { const m = /^(svg\d+-)/.exec(el.id); if (m) return m[1]; }
    svg._dlPrefix ??= `svg${Math.random().toString(36).slice(2, 7)}-`;
    return svg._dlPrefix;
  }
  /** The node `markup` (a file's) as this page has it: SVG elements, its ids and `url(#…)` refs in the svg's namespace. */
  function liveNode(markup, svg, { ids = false } = {}) {
    const tpl = document.createElement('template');
    tpl.innerHTML = `<svg>${markup}</svg>`;
    const node = document.importNode(tpl.content.firstElementChild.firstElementChild, true);
    const prefix = idPrefix(svg);
    const known = (id) => !!svg.querySelector(`[id="${CSS.escape(prefix + id)}"]`);
    for (const el of [node, ...node.querySelectorAll('*')]) {
      if (ids && el.id) el.id = prefix + el.id;
      for (const a of [...el.attributes]) {
        if (a.value.includes('url(#')) el.setAttribute(a.name, a.value.replace(/url\((['"]?)#([^'")]+)\1\)/g, (m, q, id) => (known(id) ? `url(#${prefix}${id})` : m)));
        else if ((a.name === 'href' || a.name === 'xlink:href') && a.value.startsWith('#') && known(a.value.slice(1))) el.setAttribute(a.name, `#${prefix}${a.value.slice(1)}`);
      }
    }
    return node;
  }
  /** Put `node` where the file put it: at `path` below `top`, counted the file's way. */
  function insertAt(top, path, node) {
    const parent = liveAt(top, path.slice(0, -1));
    if (!parent) throw new Error('the page has no node where the file put it');
    const next = authoredKids(parent)[path.at(-1)];
    if (next) next.before(node); else parent.appendChild(node);
  }
  /** A screen point in the svg's own coordinates, or null when it is not over the svg. */
  function svgPoint(svg, pt) {
    if (!pt) return null;
    const r = svg.getBoundingClientRect();
    if (pt.x < r.left || pt.x > r.right || pt.y < r.top || pt.y > r.bottom) return null;
    const m = svg.getScreenCTM?.()?.inverse();
    if (!m) return null;
    return { x: Math.round(m.a * pt.x + m.c * pt.y + m.e), y: Math.round(m.b * pt.x + m.d * pt.y + m.f) };
  }

  const KIND_SAID = { box: 'box', ellipse: 'ellipse', label: 'label', line: 'arrow', ...Object.fromEntries(Object.keys(SHAPES).map((k) => [k, k])) };
  async function add(target, kind, point = null) {
    if (!editmode.available?.()) { toast(editmode.cannot?.('adding a shape') ?? 'this page cannot write the deck', 3200); return null; }
    const svg = diagramOf(target);
    const path = svg && pathFrom(target.top, svg);
    if (!svg || !path) { toast('shapes are added to a diagram you drew: right-click inside one', 2800); return null; }
    let j;
    try {
      j = await post('/deck/edit/element/shape', { slide: target.slide, index: target.index, path, tag: 'svg', op: 'add', kind, at: svgPoint(svg, point) });
    } catch (e) { toast(`the ${KIND_SAID[kind] ?? 'shape'} was not added: ${commit.why(e)}`, 6000); return null; }
    let node;
    try {
      putDefs(target.top, svg, j.defs);
      node = liveNode(j.added.html, svg);
      insertAt(target.top, j.added.path, node);
    } catch (e) {
      reloadFor('a new shape could not be put on the page', e);
      return null;
    }
    refit([], svg);
    const grouped = kind === 'box' || Object.hasOwn(SHAPES, kind);
    const shape = kind === 'box' ? node.querySelector('rect') ?? node : grouped ? node.querySelector('[data-shape]') ?? node : node;
    editbar.selectNode(shape, { exact: true });
    const words = grouped ? node.querySelector('text') : kind === 'label' ? node : null;
    if (words) authoring.editInline(words);
    else toast(`${KIND_SAID[kind]} added — drag it into place`, 1800);
    debugLog('edit', `${kind} added to slide ${target.slide} element #${target.index} at ${j.added.path.join('.')}`);
    return node;
  }

  /** What Duplicate copies for a selection: its box group when it is the shape of one, else the node. */
  function duplicateUnit(node) {
    if (!BOX_SHAPES.has(tagOf(node))) return node;
    const g = boxGroupOf(node);
    return g && !g.matches(ENGINE_NODES) ? g : node;
  }
  const canDuplicate = (target) => {
    const n = target?.node;
    return !!(n && isDrawn(n) && tagOf(n) !== 'tspan' && diagramOf(target) && pathFrom(target.top, duplicateUnit(n)));
  };
  async function duplicate(target) {
    if (!editmode.available?.()) { toast(editmode.cannot?.('duplicating a shape') ?? 'this page cannot write the deck', 3200); return null; }
    if (!canDuplicate(target)) { toast('select a shape in a diagram to duplicate it', 2600); return null; }
    const svg = diagramOf(target);
    const unit = duplicateUnit(target.node);
    const path = pathFrom(target.top, unit);
    let j;
    try {
      j = await post('/deck/edit/element/shape', { slide: target.slide, index: target.index, path, tag: tagOf(unit), op: 'duplicate' });
    } catch (e) { toast(`not duplicated: ${commit.why(e)}`, 6000); return null; }
    let copy;
    try {
      copy = liveNode(j.added.html, svg);
      insertAt(target.top, j.added.path, copy);
    } catch (e) {
      reloadFor('a copy could not be put on the page', e);
      return null;
    }
    // the copy's connectors join the copy's nodes (the server named them its own): routed where they are
    refit([], svg, connectorsIn(copy));
    // the copy of what was selected is what is selected now
    const rel = unit === target.node ? [] : pathFrom(unit, target.node);
    editbar.selectNode((rel && liveAt(copy, rel)) || copy, { exact: true });
    toast('duplicated — drag it into place', 1600);
    return copy;
  }

  return {
    diagramOf, canDuplicate, add, duplicate,
    /** The element menu's rows on a wire: is it one, its route and arrows, and the three edits. */
    isWire: (target) => !!wireOf(target), wireState, setRoute, setArrows, reverse,
    /** Wire ▸ Label…: does the wire have a label, and the add (or the edit of the one it has). */
    hasLabel: (target) => !!labelOfWire(target), labelWire,
    /** Line ▸ on a stroke and Corners ▸ on a box: is there one, which is ticked, and the write. */
    isStroke: (target) => !!strokeOf(target), lineState, setLine,
    hasCorners: (target) => !!cornerBox(target), cornerState, setCorners,
    /** Order ▸ (and Move up / down on a shape): is there a node to move, can it go `to`, and the move. */
    canOrder, order, isOrderable: (target) => !!orderUnit(target),
    /** Several shapes of one diagram (editbar's selectedShapes): are these such, and what changes them all. */
    areShapes, nudge, arrange, removeMany, duplicateMany, styleMany,
    /** Groups (SVG_DIAGRAMS): Group on several shapes; Ungroup, Select the whole group and Make it a group on one, and whether each applies. */
    group, ungroup, markGroup, selectWhole,
    canUngroup: (target) => !!ungroupable(target), hasWhole: (target) => !!wholeOf(target),
    canMark: (target) => !!markable(target), isGroup: (target) => isGroup(target?.node),
    /** Is a drag, a resize or a wire being drawn under way? (the harnesses) */
    busy: () => !!(drag || resizing || wiring),
    /** The handles on screen, for the harnesses: `[{ el, hx, hy, end }]`. */
    handles: () => handles.slice(),
    /** The connection dots on screen, for the harnesses: `[{ el, side }]`. */
    dots: () => dots.slice(),
    /** The alignment guides on screen, for the harnesses. */
    guides: () => guideEls.slice(),
  };
}
