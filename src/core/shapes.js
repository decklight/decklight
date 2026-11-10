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
 *   holds the move to one axis.
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
 * Wires do not follow the boxes they join.
 */

import { pathFrom } from './colorpicker.js';
import { injectedIn, isDrawn } from './pick.js';
import { refitStroke } from './builds.js';
import { boundedFetch } from './devmode.js';

/** Nodes in the page that are not in the file: the engine's and a template's. */
const ENGINE_NODES = '.draw-head, .draw-mask, [data-ds-injected]';
/** A shape a label can sit on. */
const BOX_SHAPES = new Set(['rect', 'circle', 'ellipse', 'image', 'polygon', 'path']);
const NUMERIC = /^\s*-?\d+(?:\.\d+)?\s*$/;
/** How far the pointer goes before a press becomes a drag, in screen px. */
const DRAG_AFTER = 4;
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

// ── the page ─────────────────────────────────────────────────────────────────

const tagOf = (el) => el?.tagName?.toLowerCase() ?? '';
const num = (el, a) => { const v = parseFloat(el.getAttribute(a)); return Number.isFinite(v) ? v : 0; };
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

export function createShapes({ root, instance, editmode, editbar, authoring, toast, debugLog = () => {}, repaint = () => {} }) {
  const active = () => editmode.elementEditOn?.() && editmode.available?.() && editbar.isOpen?.() && !authoring.editing?.();

  // ── writes ────────────────────────────────────────────────────────────────
  async function post(path, body) {
    const p = (async () => {
      const res = await boundedFetch((editmode.base?.() ?? '') + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, quiet: true, from: editmode.pageId?.() ?? null }),
      });
      const j = await res.json().catch(() => ({}));
      editmode.noteHistory?.(j);
      if (!res.ok || j.ok === false) throw new Error(j.error || `the edit server answered ${res.status}`);
      return j;
    })();
    editmode.trackWrite?.(p);
    return p;
  }

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
        } else edits.push({ path, tag: tagOf(el), attr, value: Number(now) });
      }
    }
    return edits;
  }
  /** Put the attributes `before` remembers back (a refused write, an Esc mid-drag). */
  function restore(before) {
    for (const [el, attrs] of before) for (const [a, v] of Object.entries(attrs)) { if (v === null) el.removeAttribute(a); else el.setAttribute(a, v); }
  }
  /** What the engine drew from these nodes, drawn again for where they are now. */
  function refit(nodes, svg) {
    for (const n of nodes) {
      if (n.matches?.('.draw-stroke')) refitStroke(n);
      n.querySelectorAll?.('.draw-stroke').forEach(refitStroke);
    }
    if (svg) repaint(svg);
  }
  async function save(target, before, what) {
    const edits = editsFor(target.top, before);
    if (!edits) { restore(before); toast('that node is the engine’s, not the file’s — nothing to move', 2600); return false; }
    if (!edits.length) return true;
    try {
      await post('/deck/edit/element/geometry', { slide: target.slide, index: target.index, edits });
      debugLog('edit', `${what}: slide ${target.slide} element #${target.index} · ${edits.length} attribute${edits.length === 1 ? '' : 's'}`);
      return true;
    } catch (e) {
      restore(before);
      refit([...before.keys()], target.node?.ownerSVGElement);
      toast(`${what} not saved: ${String(e.message || e)}`, 6000);
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
    if (sel?.node && isDrawn(sel.node) && (sel.node === e.target || sel.node.contains(e.target) || membersOf(sel.node).some((m) => m === e.target || m.contains(e.target)))) {
      node = sel.node; target = sel;
    } else {
      const t = editmode.elementTargetOf(e.target);
      if (t?.node && isDrawn(t.node) && diagramOf(t)) { node = t.node; target = t; }
    }
    if (!node || !diagramOf(target) || tagOf(node) === 'tspan') return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, node, target };
  }, true);

  function beginMove(e) {
    const { node } = press;
    let { target } = press;
    if (editbar.selected()?.node !== node) {
      editbar.selectNode(node, { exact: true });
      target = editbar.selected() ?? target;
    }
    const members = membersOf(node);
    const specs = members.map(moveSpec);
    if (specs.some((s) => !s)) {
      toast('this one is a build step, and its build owns where it is: move what it holds, or the group it is in', 3600);
      return null;
    }
    const before = new Map();
    const parts = members.map((m, i) => {
      const s = specs[i];
      if (s.translate) {
        before.set(m, { ...(before.get(m) ?? {}), transform: m.getAttribute('transform') });
        const inv = m.parentNode.getScreenCTM?.()?.inverse();
        return { m, translate: true, inv, t0: m.getAttribute('transform'), at: leadingTranslate(m.getAttribute('transform')) };
      }
      const inv = m.getScreenCTM?.()?.inverse();
      const pairs = s.attrs.map(([el, ax, ay]) => {
        const rec = before.get(el) ?? {};
        if (ax) rec[ax] = el.getAttribute(ax);
        if (ay) rec[ay] = el.getAttribute(ay);
        before.set(el, rec);
        return { el, ax, ay, x0: ax ? num(el, ax) : 0, y0: ay ? num(el, ay) : 0 };
      });
      return { m, inv, pairs };
    });
    if (parts.some((p) => !p.inv)) return null;
    root.classList.add('dl-shape-dragging');
    window.getSelection?.()?.removeAllRanges();
    return { target, node, members, parts, before, svg: node.ownerSVGElement, x: press.x, y: press.y, moved: false };
  }

  function applyMove(e) {
    let dx = e.clientX - drag.x; let dy = e.clientY - drag.y;
    if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0; }
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
    refit(drag.members, drag.svg);
  }

  window.addEventListener('pointermove', (e) => {
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
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 350);
    if (cancel) { restore(d.before); refit(d.members, d.svg); return; }
    if (!d.moved) return;
    await save(d.target, d.before, 'move');
  }
  window.addEventListener('pointerup', (e) => {
    if (resizing) { resizeEnd(e); return; }
    if (drag && e.pointerId === drag.id) endMove(e);
    press = null;
  });
  window.addEventListener('pointercancel', () => {
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
    if (e.key !== 'Escape' || !(drag || resizing)) return;
    e.stopPropagation(); e.preventDefault();
    if (drag) endMove(null, { cancel: true });
    if (resizing) resizeEnd(null, { cancel: true });
  }, true);

  // ── resize ────────────────────────────────────────────────────────────────
  let handles = [];    // { el, kind, hx, hy, end }
  let handled = null;  // { target, shape, kind }
  let placing = 0;
  let resizing = null;

  /** What a selection resizes: `{ shape, kind }` (box or line), or null. */
  function resizable(target) {
    let node = target?.node;
    if (!node || !isDrawn(node) || !diagramOf(target) || pathFrom(target.top, node) === null) return null;
    if (tagOf(node) === 'g') {
      const shape = authoredKids(node).find((k) => BOX_SHAPES.has(tagOf(k)));
      if (!shape || boxGroupOf(shape) !== node) return null;
      node = shape;
    }
    const tag = tagOf(node);
    const need = { rect: ['x', 'y', 'width', 'height'], image: ['x', 'y', 'width', 'height'], ellipse: ['cx', 'cy', 'rx', 'ry'], circle: ['cx', 'cy', 'r'], line: ['x1', 'y1', 'x2', 'y2'] }[tag];
    if (!need || !need.every((a) => numericAttr(node, a))) return null;
    return { shape: node, kind: tag === 'line' ? 'line' : 'box' };
  }
  /** A box shape's box in its own coordinates. */
  function boxOf(shape) {
    switch (tagOf(shape)) {
      case 'ellipse': return { x: num(shape, 'cx') - num(shape, 'rx'), y: num(shape, 'cy') - num(shape, 'ry'), w: 2 * num(shape, 'rx'), h: 2 * num(shape, 'ry') };
      case 'circle': return { x: num(shape, 'cx') - num(shape, 'r'), y: num(shape, 'cy') - num(shape, 'r'), w: 2 * num(shape, 'r'), h: 2 * num(shape, 'r') };
      default: return { x: num(shape, 'x'), y: num(shape, 'y'), w: num(shape, 'width'), h: num(shape, 'height') };
    }
  }
  /** Write box `b` on `shape` in the attributes it uses, in the grain each had. */
  function setBox(shape, b, was) {
    const g = (a, v) => shape.setAttribute(a, String(keepGrain(was[a] ?? 0, v)));
    switch (tagOf(shape)) {
      case 'ellipse': g('cx', b.x + b.w / 2); g('cy', b.y + b.h / 2); g('rx', b.w / 2); g('ry', b.h / 2); break;
      case 'circle': g('cx', b.x + b.w / 2); g('cy', b.y + b.h / 2); g('r', Math.max(b.w, b.h) / 2); break;
      default: g('x', b.x); g('y', b.y); g('width', b.w); g('height', b.h);
    }
  }
  const BOX_HANDLES = [[-1, -1, 'nwse'], [0, -1, 'ns'], [1, -1, 'nesw'], [1, 0, 'ew'], [1, 1, 'nwse'], [0, 1, 'ns'], [-1, 1, 'nesw'], [-1, 0, 'ew']];
  function showHandles(target) {
    hideHandles();
    const r = active() ? resizable(target) : null;
    if (!r) return;
    handled = { target, ...r };
    const make = (cls, cursor, data) => {
      const el = Object.assign(document.createElement('div'), { className: `dl-shape-handle ${cls}` });
      el.style.cursor = `${cursor}-resize`;
      el.setAttribute('aria-hidden', 'true');
      el.addEventListener('pointerdown', (e) => resizeStart(e, data));
      el.addEventListener('mousedown', (e) => e.preventDefault());
      root.appendChild(el);
      handles.push({ el, ...data });
    };
    if (r.kind === 'line') { make('dl-shape-end', 'move', { end: 1 }); make('dl-shape-end', 'move', { end: 2 }); } else for (const [hx, hy, cursor] of BOX_HANDLES) make('', cursor, { hx, hy });
    // the ⋯ menu handle steps aside for the corner handle it would sit on
    root.classList.add('dl-shape-handles');
    const tick = () => { placeHandles(); placing = requestAnimationFrame(tick); };
    placing = requestAnimationFrame(tick);
    placeHandles();
  }
  function hideHandles() {
    cancelAnimationFrame(placing);
    for (const h of handles) h.el.remove();
    handles = []; handled = null;
    root.classList.remove('dl-shape-handles');
  }
  function placeHandles() {
    if (!handled) return;
    const { shape } = handled;
    if (!shape.isConnected) { hideHandles(); return; }
    const m = shape.getScreenCTM?.();
    if (!m) return;
    const at = (x, y) => ({ left: m.a * x + m.c * y + m.e, top: m.b * x + m.d * y + m.f });
    for (const h of handles) {
      let p;
      if (h.end) p = at(num(shape, `x${h.end}`), num(shape, `y${h.end}`));
      else { const b = boxOf(shape); p = at(b.x + (h.hx + 1) / 2 * b.w, b.y + (h.hy + 1) / 2 * b.h); }
      h.el.style.left = `${p.left}px`; h.el.style.top = `${p.top}px`;
    }
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
    // the labels on a box come along, by what they are to it; a line has none
    const labels = data.end || shape.hasAttribute('transform') ? [] : labelsOn(shape).filter((t) => !t.hasAttribute('transform') && numericAttr(t, 'x') && numericAttr(t, 'y'))
      .map((t) => {
        keep(t, ['x', 'y']);
        const anchor = t.getAttribute('text-anchor') ?? getComputedStyle(t).textAnchor ?? 'start';
        return { t, x: num(t, 'x'), y: num(t, 'y'), anchor };
      });
    resizing = { id: e.pointerId, data, shape, target, inv, was, box: data.end ? null : boxOf(shape), labels, before, svg: shape.ownerSVGElement, moved: false };
    root.classList.add('dl-shape-dragging');
  }
  function resizeMove(e) {
    const R = resizing;
    if (!R || e.pointerId !== R.id) return;
    const m = R.inv;
    const p = { x: m.a * e.clientX + m.c * e.clientY + m.e, y: m.b * e.clientX + m.d * e.clientY + m.f };
    if (R.data.end) {
      const k = R.data.end; const o = k === 1 ? 2 : 1;
      let { x, y } = p;
      if (e.shiftKey) { const ox = R.was[`x${o}`]; const oy = R.was[`y${o}`]; if (Math.abs(x - ox) >= Math.abs(y - oy)) y = oy; else x = ox; }
      R.shape.setAttribute(`x${k}`, String(keepGrain(R.was[`x${k}`], x)));
      R.shape.setAttribute(`y${k}`, String(keepGrain(R.was[`y${k}`], y)));
    } else {
      const { hx, hy } = R.data;
      let b;
      if (tagOf(R.shape) === 'circle') {
        // a circle keeps its centre: the handle sets the radius
        const cx = R.was.cx; const cy = R.was.cy;
        const r = Math.max(MIN_SIZE / 2, hx && hy ? Math.max(Math.abs(p.x - cx), Math.abs(p.y - cy)) : hx ? Math.abs(p.x - cx) : Math.abs(p.y - cy));
        b = { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
      } else b = resizeBox(R.box, hx, hy, p, { aspect: e.shiftKey });
      setBox(R.shape, b, R.was);
      const now = boxOf(R.shape);
      for (const l of R.labels) {
        const q = followLabel(l, R.box, now);
        l.t.setAttribute('x', String(keepGrain(l.x, q.x)));
        l.t.setAttribute('y', String(keepGrain(l.y, q.y)));
      }
    }
    R.moved = true;
    refit([R.shape], R.svg);
    placeHandles();
  }
  async function resizeEnd(e, { cancel = false } = {}) {
    const R = resizing;
    if (!R || (e && e.pointerId !== R.id)) return;
    resizing = null;
    root.classList.remove('dl-shape-dragging');
    if (cancel) { restore(R.before); refit([R.shape], R.svg); placeHandles(); return; }
    if (!R.moved) return;
    await save(R.target, R.before, R.data.end ? 'line end' : 'resize');
    placeHandles();
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

  const KIND_SAID = { box: 'box', ellipse: 'ellipse', label: 'label', line: 'arrow' };
  async function add(target, kind, point = null) {
    if (!editmode.available?.()) { toast(editmode.cannot?.('adding a shape') ?? 'this page cannot write the deck', 3200); return null; }
    const svg = diagramOf(target);
    const path = svg && pathFrom(target.top, svg);
    if (!svg || !path) { toast('shapes are added to a diagram you drew: right-click inside one', 2800); return null; }
    let j;
    try {
      j = await post('/deck/edit/element/shape', { slide: target.slide, index: target.index, path, tag: 'svg', op: 'add', kind, at: svgPoint(svg, point) });
    } catch (e) { toast(`the ${KIND_SAID[kind] ?? 'shape'} was not added: ${String(e.message || e)}`, 6000); return null; }
    let node;
    try {
      if (j.defs) {
        const d = liveNode(j.defs.html, svg, { ids: true });
        if (j.defs.replaced) liveAt(target.top, j.defs.path)?.replaceWith(d);
        else insertAt(target.top, j.defs.path, d);
      }
      node = liveNode(j.added.html, svg);
      insertAt(target.top, j.added.path, node);
    } catch (e) {
      debugLog('edit', `a new shape could not be put on the page (${String(e.message || e)}) — reloading`);
      location.reload();
      return null;
    }
    repaint(svg);
    const shape = kind === 'box' ? node.querySelector('rect') ?? node : node;
    editbar.selectNode(shape, { exact: true });
    const words = kind === 'box' ? node.querySelector('text') : kind === 'label' ? node : null;
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
    } catch (e) { toast(`not duplicated: ${String(e.message || e)}`, 6000); return null; }
    let copy;
    try {
      copy = liveNode(j.added.html, svg);
      insertAt(target.top, j.added.path, copy);
    } catch (e) {
      debugLog('edit', `a copy could not be put on the page (${String(e.message || e)}) — reloading`);
      location.reload();
      return null;
    }
    repaint(svg);
    // the copy of what was selected is what is selected now
    const rel = unit === target.node ? [] : pathFrom(unit, target.node);
    editbar.selectNode((rel && liveAt(copy, rel)) || copy, { exact: true });
    toast('duplicated — drag it into place', 1600);
    return copy;
  }

  return {
    diagramOf, canDuplicate, add, duplicate,
    /** Is a drag or a resize under way? (the harnesses) */
    busy: () => !!(drag || resizing),
    /** The handles on screen, for the harnesses: `[{ el, hx, hy, end }]`. */
    handles: () => handles.slice(),
  };
}
