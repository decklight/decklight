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

/** The node a click on `clicked` selects inside the top-level block `top`. */
export function pickNode(top, clicked) {
  if (!top || !clicked?.closest || !top.contains(clicked)) return top;
  // a picture in a figure or a column is the picture (PRESENTING_EDITING):
  // what you resize, caption or make the background is it, not its box
  const img = clicked.closest('img');
  if (img && img !== top && top.contains(img) && !img.closest('svg, [data-chart], .terminal')) return img;
  const svg = clicked.closest('svg');
  if (!svg || !top.contains(svg) || svg.closest('[data-chart], .terminal')) return top;
  if (svg.hasAttribute?.('data-ds-injected')) return top;
  if (clicked.closest(NOT_THE_FILES) || injectedIn(clicked, svg)) return svg;
  const drawn = clicked.closest(DRAWN);
  return drawn && svg.contains(drawn) ? drawn : svg;
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
