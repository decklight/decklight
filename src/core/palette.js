// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What the command palette (/) shows for a given query.
//
// NOT the palette itself. The command LIST stays in engine.js, because every
// row closes over the thing it runs and hauling thirty handlers through a
// parameter list would make the seam worse than the closure. What moved is the
// part that can be wrong with nothing on screen: which rows survive a query,
// what "goto 27" means, and when the deck offers to search its slides instead.
//
// THE THREE THINGS A TYPED STRING CAN BE, in the order they are tried:
//
//   1. A NUMBER — "27", or "goto 27". The presenter knows where they are
//      going; the row jumps there and is put FIRST, because a deck with a
//      slide titled "27 things" would otherwise bury it under text matches.
//      Out-of-range clamps rather than refusing: past the end means the end.
//   2. A COMMAND — matched against the label and its aliases, so "cc" finds
//      Captions and "rollback" finds Restore. A presenter reaches for the word
//      they think in, not the word the menu happens to use.
//   3. ANYTHING ELSE — offered as a slide search. Only when nothing matched by
//      PREFIX, though: typing "the" should not turn a palette that is already
//      showing "Theme…" into a search box.

/**
 * The rows to render for `query`.
 *
 * `makeGotoRow(n)` and `makeSearchRow(text)` build the two synthetic rows, so
 * this file never needs to know how to move a deck or open the finder.
 */
export function paletteRows({ commands, query = '', totalSlides = 0, makeGotoRow, makeSearchRow }) {
  const q = String(query).toLowerCase();
  const rows = commands.filter((c) => !q || (c.label + ' ' + (c.alias ?? '')).toLowerCase().includes(q));

  const g = String(query).trim().match(/^(?:goto\s*)?(\d+)$/i);
  if (g && makeGotoRow) {
    const n = Math.max(1, Math.min(parseInt(g[1], 10), totalSlides));
    rows.unshift(makeGotoRow(n, totalSlides));
  }

  if (q && !g && makeSearchRow && !rows.some((c) => c.label.toLowerCase().startsWith(q))) {
    rows.push(makeSearchRow(query));
  }
  return rows;
}
