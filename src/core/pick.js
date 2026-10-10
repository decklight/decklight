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
 * The spotlight is the feedback for it: a faint glow on the node under the
 * pointer and the rest of the stage dimmed a little, drawn by one box that
 * lets pointer events through, so it never takes the click it is about.
 */

const DRAWN = 'rect, circle, ellipse, polygon, polyline, path, line, text, image, use, foreignObject';
const NOT_THE_FILES = 'defs, marker, .draw-head, [data-ds-injected]';

/** The node a click on `clicked` selects inside the top-level block `top`. */
export function pickNode(top, clicked) {
  if (!top || !clicked?.closest || !top.contains(clicked)) return top;
  const svg = clicked.closest('svg');
  if (!svg || !top.contains(svg) || svg.closest('[data-chart], .terminal')) return top;
  if (clicked.closest(NOT_THE_FILES)) return svg;
  const drawn = clicked.closest(DRAWN);
  return drawn && svg.contains(drawn) ? drawn : svg;
}

/** Is `node` a drawn node inside a diagram (a box, a label, a wire), not the block or the canvas? */
export const isDrawn = (node) => node instanceof SVGElement && node.tagName.toLowerCase() !== 'svg' && !!node.closest?.('svg');

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
      // an SVG node glows by its own outline (a drop-shadow follows the shape);
      // a block glows by the box drawn around it
      if (isDrawn(node)) node.classList.add('dl-glow');
    }
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
 * `place()`.
 */
export function createFrame(root) {
  let box = null;
  let node = null;
  function place() {
    if (!box || !node?.isConnected) return;
    const r = node.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
  }
  return {
    on(n) {
      node = n;
      box ??= Object.assign(document.createElement('div'), { className: 'dl-frame' });
      if (!box.isConnected) root.appendChild(box);
      place();
    },
    off() { box?.remove(); box = null; node = null; },
    place,
  };
}
