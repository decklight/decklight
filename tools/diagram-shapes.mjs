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
