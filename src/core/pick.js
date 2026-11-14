// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * What a pointer means inside a diagram (PRESENTING, selection; SVG_DIAGRAMS).
 *
 * A slide's element is its top-level block, and for most blocks that is the
 * thing you act on. A diagram is the exception: what you point at is a box, a
 * label, a wire, so a click selects the deepest drawn node under the pointer
 * (a label's line selects its whole `<text>`), and the diagram's empty
 * canvas selects the `<svg>`. A chart draws itself from data, so it stays
 * one block. Nodes the engine or a template added are never picked: they are
 * not in the file.
 *
 * The spotlight is the feedback for it: a dashed line in the theme's accent
 * around the node under the pointer, a faint glow on the node, and the rest
 * of the stage dimmed a little, drawn by one box that lets pointer events
 * through, so it never takes the click it is about.
 */

import { WIRE_TAGS, isConnector } from './connectors.js';

const DRAWN = 'rect, circle, ellipse, polygon, polyline, path, line, text, image, use, foreignObject';
const NOT_THE_FILES = 'defs, marker, mask, .draw-head, .draw-mask';

/**
 * Did a slide template bring `n` (SPEC DESIGN_SYSTEMS): the `<svg>` itself, or
 * a node between `n` and it? A slot container ABOVE the svg does not count:
 * it holds the author's diagram, it is not it.
 */
export const injectedIn = (n, svg) => {
  for (let e = n; e; e = e.parentElement) {
    if (e.hasAttribute?.('data-ds-injected')) return true;
    if (e === svg) return false;
  }
  return false;
};

/**
 * The deepest drawn node under `clicked` in a diagram of `top` (a box, a
 * label, a wire), the diagram's `<svg>` for its canvas, or null when the
 * click is not in an author's diagram.
 */
function drawnAt(top, clicked) {
  const svg = clicked.closest('svg');
  if (!svg || !top.contains(svg) || svg.closest('[data-chart], .terminal') || svg.hasAttribute?.('data-ds-injected')) return null;
  if (clicked.closest(NOT_THE_FILES) || injectedIn(clicked, svg)) return svg;
  const drawn = clicked.closest(DRAWN);
  return drawn && svg.contains(drawn) ? drawn : svg;
}

// ── groups (SVG_DIAGRAMS) ─────────────────────────────────────────────────
// A group is a `<g data-group>` in a diagram. The first click on any of its
// members selects the outermost group under the pointer; a click inside the
// selected group goes one level down, to a group inside it or to the shape
// under the pointer, as a second click reaches a block in a column; ⌥-click
// goes straight to the shape; Escape steps back up one level. A `<g>`
// without the mark (a box group, a step unit) is picked by the shape under
// the pointer, as it always was.

/** Is `n` a group: a `<g data-group>`? */
export const isGroup = (n) => !!n?.matches?.('g[data-group]');
/** The group right above `n` in its diagram, or null. */
export function groupAbove(n) {
  for (let p = n?.parentElement; p && !p.matches('svg'); p = p.parentElement) if (isGroup(p)) return p;
  return null;
}
/** What `drawn` is, seen from inside `holder` (null: the diagram): the outermost group below `holder` holding it, else itself. */
function levelBelow(holder, drawn) {
  let out = drawn;
  for (let g = groupAbove(drawn); g && g !== holder; g = groupAbove(g)) out = g;
  return out;
}

/** The node a click on `clicked` selects inside the top-level block `top`. */
export function pickNode(top, clicked) {
  if (!top || !clicked?.closest || !top.contains(clicked)) return top;
  // a picture in a figure or a column is the picture (PRESENTING_EDITING):
  // what you resize, caption or make the background is it, not its box
  const img = clicked.closest('img');
  if (img && img !== top && top.contains(img) && !img.closest('svg, [data-chart], .terminal')) return img;
  const drawn = drawnAt(top, clicked);
  if (!drawn) return top;
  // a member of a group: the outermost group holding it
  return drawn.matches('svg') ? drawn : levelBelow(null, drawn);
}

/**
 * What a click on `clicked` in a diagram selects while `cur` (a node of it,
 * or null) is selected: inside the selected group, or beside a selected
 * member of one, the next level down under the pointer; with ⌥, the shape
 * itself; else what pickNode says. Undefined when the click is not on a
 * diagram's drawn node.
 */
function groupLevel(top, clicked, cur, alt) {
  const drawn = drawnAt(top, clicked);
  if (!drawn || drawn.matches('svg')) return undefined;
  if (alt) return drawn;
  let holder = isGroup(cur) && cur.contains(clicked) ? cur : null;
  for (let g = cur && !holder ? groupAbove(cur) : null; g && !holder; g = groupAbove(g)) if (g.contains(clicked)) holder = g;
  return holder ? levelBelow(holder, drawn) : levelBelow(null, drawn);
}

// ── blocks at depth (PRESENTING_EDITING, Selection) ───────────────────────
// A column is a block of blocks: a heading over its points, a picture, a
// quote. The first click selects the column (its drag and its layout are the
// column's); a second click on the same column goes one level down, to the
// block under the pointer, and a click on another block beside that one
// selects it in turn. ⌥-click goes straight to the deepest block. Only plain
// wrappers are stepped into: a list, a table and a figure have their own
// sessions (their points, cells and caption), and a chart or a terminal is
// one block.

/** What the engine put there: never a block of the file's. */
const ENGINE_NODE = '.slide-bg, .decklight-hero-logo, [data-ds-injected], .draw-head, .draw-mask';
const NOT_A_WRAPPER = `.chart, [data-chart], .terminal, ${ENGINE_NODE}`;
/** Is `el` a plain wrapper of blocks: a `<div>` that is not a chart, a terminal or the engine's? */
export const isWrapper = (el) => el?.tagName === 'DIV' && !el.matches(NOT_A_WRAPPER) && !el.closest('svg');
/** The block one level below wrapper `from` that holds `clicked`, or null. */
export function blockBelow(from, clicked) {
  if (!isWrapper(from) || !clicked || clicked === from || !from.contains(clicked)) return null;
  return [...from.children].find((c) => c.contains(clicked) && !c.matches(ENGINE_NODE)) ?? null;
}
/** The deepest block under `clicked`, stepping down through wrappers from `top` (⌥-click). */
export function innermostBlock(top, clicked) {
  let n = top;
  for (let b = blockBelow(n, clicked); b; b = blockBelow(n, clicked)) n = b;
  return n;
}
/** Is `node` a block at depth: below its top-level element `top`, in a wrapper, not a diagram's node? */
export const atDepth = (top, node) => !!node && !!top && node !== top && top.contains(node)
  && isWrapper(node.parentElement) && !(typeof SVGElement !== 'undefined' && node instanceof SVGElement);

/**
 * What a click on `clicked` selects inside `top` while `current` (a target,
 * or null) is selected: a picture or a diagram's node as `pickNode` says;
 * with ⌥, the deepest block; on the selected wrapper, the block below it
 * under the pointer; on a block beside a selected inner one, that block; on
 * the selected inner block itself, that block still; else the top-level block.
 */
export function nodeForClick(top, clicked, current, { alt = false } = {}) {
  const cur = current?.top === top ? current.node : null;
  // a diagram's groups: one level a click (above)
  const level = top?.contains?.(clicked) && !clicked.closest('img') ? groupLevel(top, clicked, cur, alt) : undefined;
  if (level !== undefined) return level;
  const picked = pickNode(top, clicked);
  if (picked !== top) return picked;
  if (alt) return innermostBlock(top, clicked);
  if (!cur || !top.contains(clicked)) return top;
  const holder = cur.contains(clicked) ? cur
    : atDepth(top, cur) && cur.parentElement.contains(clicked) ? cur.parentElement : null;
  if (!holder) return top;
  return blockBelow(holder, clicked) ?? (holder === cur ? cur : top);
}

/** Is `node` a drawn node inside a diagram (a box, a label, a wire), not the block or the canvas? */
export const isDrawn = (node) => node instanceof SVGElement && node.tagName.toLowerCase() !== 'svg' && !!node.closest?.('svg');

/**
 * Is `node` a wire: a connector, a `<line>`, or an unfilled `<path>` or
 * `<polyline>`? A wire's bounding box is the rectangle its route spans, mostly
 * empty, so a wire is never boxed: it glows along its own stroke instead.
 */
export function isWireNode(node) {
  if (!isDrawn(node)) return false;
  const tag = node.tagName.toLowerCase();
  if (!WIRE_TAGS.has(tag)) return false;
  return tag === 'line' || isConnector(node) || getComputedStyle(node).fill === 'none';
}

/** The middle of a wire's stroke on the screen, `{ x, y }`, or null when it cannot be measured (a hidden slide). */
export function wireMiddle(node) {
  try {
    const m = node.getScreenCTM?.();
    const p = node.getPointAtLength?.(node.getTotalLength() / 2);
    if (!m || !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  } catch { return null; }
}

/**
 * One spotlight inside `root`: `show(node, { dim })` glows `node` and, with
 * `dim`, darkens everything around its box; `hide()` takes it off.
 */
export function createSpotlight(root) {
  let box = null;
  let lit = null;
  function hide() {
    lit?.classList.remove('dl-glow');
    lit = null;
    box?.remove();
    box = null;
  }
  function show(node, { dim = true } = {}) {
    if (!node?.isConnected) { hide(); return; }
    if (lit !== node) {
      lit?.classList.remove('dl-glow');
      lit = node;
      // an SVG node glows by its own outline (a drop-shadow follows the shape)
      // inside the dashed box; a block glows by the box drawn around it
      if (isDrawn(node)) node.classList.add('dl-glow');
    }
    // a wire only glows: no box around the rectangle its route spans, nothing dimmed around it
    if (isWireNode(node)) { box?.remove(); box = null; return; }
    box ??= Object.assign(document.createElement('div'), { className: 'dl-spot' });
    if (!box.isConnected) root.appendChild(box);
    box.classList.toggle('dl-spot-dim', dim);
    box.classList.toggle('dl-spot-block', !isDrawn(node));
    const r = node.getBoundingClientRect();
    const pad = 3;
    Object.assign(box.style, {
      left: `${r.left - pad}px`, top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    });
  }
  return { show, hide, node: () => lit };
}

/**
 * The frame a selection inside a diagram wears: SVG takes no CSS outline, so
 * the selected node is framed by a box drawn over it, kept in place by
 * `place()`. A wire wears no box: it takes a class, and glows along its own
 * stroke (a filter on the wire itself, so it follows every re-route with
 * nothing to place). The class is the page's, never the file's.
 */
export function createFrame(root) {
  let box = null;
  let node = null;
  function place() {
    if (!box || !node?.isConnected) return;   // a wire has no box: nothing to place
    const r = node.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
  }
  return {
    on(n) {
      this.off();
      node = n;
      if (isWireNode(n)) { n.classList.add('dl-wire-selected'); return; }
      box ??= Object.assign(document.createElement('div'), { className: 'dl-frame' });
      if (!box.isConnected) root.appendChild(box);
      place();
    },
    off() { node?.classList.remove('dl-wire-selected'); box?.remove(); box = null; node = null; },
    place,
  };
}
