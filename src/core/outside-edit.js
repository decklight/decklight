// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a page lands after an outside edit (PRESENTING_EDITING): the deck
 * file changed under write mode, by an editor, git or a tool, and the server
 * said how (cli/outside-edit.mjs): `land = { go, moves, was, total }`.
 *
 * The rule, one line each:
 *  - a page that is editing (write mode, unlocked, not full screen) goes to
 *    `go`, the slide the change touched first, at its first step;
 *  - any other page, or a change that touched no slide, stays on its CONTENT:
 *    its slide's new number from `moves`, the step kept. A slide that is gone
 *    gives way to the one that now stands in its place.
 *
 * Pure, so the rule is tested without a page.
 */

/** Slide `n` of the old deck, numbered in the new one: itself, where it moved, or the next one still there. */
export function movedTo(n, land) {
  const moves = new Map(Array.isArray(land?.moves) ? land.moves : []);
  const total = Number.isInteger(land?.total) ? land.total : n;
  const was = Number.isInteger(land?.was) ? land.was : total;
  const at = (k) => (moves.has(k) ? moves.get(k) : k);
  let to = at(n);
  for (let k = n + 1; to == null && k <= was; k++) to = at(k);
  return Math.max(1, Math.min(to ?? total, total || 1));
}

/**
 * Where a page on `{ slide, step }` lands after `lands`, the changes in the
 * order they came (a reload held for a draft gathers several): `{ slide, step }`.
 * `follow` is whether this page goes to what changed.
 */
export function landing({ slide, step = 0 }, lands, { follow = false } = {}) {
  let at = { slide, step };
  for (const land of lands) {
    if (!land || typeof land !== 'object') continue;
    if (follow && Number.isInteger(land.go) && land.go > 0) { at = { slide: land.go, step: 0 }; continue; }
    const to = movedTo(at.slide, land);
    const gone = new Map(Array.isArray(land.moves) ? land.moves : []).get(at.slide) === null;
    at = { slide: to, step: gone ? 0 : at.step };
  }
  return at;
}
