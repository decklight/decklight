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
//   2. A COMMAND — matched against its category, its name and its aliases,
//      every word typed, in any order: "cc" finds Captions, "voice live" finds
//      `Voice: Live voice…`, "rollback" finds History. A presenter reaches for
//      the word they think in, not the word the menu happens to use.
//   3. ANYTHING ELSE — offered as a slide search. Only when nothing matched by
//      PREFIX, though: typing "the" should not turn a palette that is already
//      showing `Look: Theme…` into a search box.

/**
 * The title a row is shown and matched under: its category, then its name,
 * the way VS Code's command palette reads (`Voice: Live voice…`). A row with
 * no category (the synthetic goto and search rows) is its name alone.
 */
export const commandTitle = (c) => (c.cat ? `${c.cat}: ${c.label}` : c.label);

/** Lower-cased words, with the category's colon dropped so "voice: live" matches. */
const words = (text) => String(text).toLowerCase().replace(/:/g, ' ').split(/\s+/).filter(Boolean);

/**
 * How well `c` matches the query, or 0 when it does not: every typed word has
 * to appear in the title or the aliases. 3 when the title or the bare name
 * starts with the query, 2 when every word is in the title, 1 when an alias
 * was needed.
 */
export function matchRank(c, q) {
  const terms = words(q);
  if (!terms.length) return 1;
  const title = commandTitle(c).toLowerCase();
  const hay = `${title} ${String(c.alias ?? '').toLowerCase()}`;
  if (!terms.every((t) => hay.includes(t))) return 0;
  const typed = String(q).trim().toLowerCase();
  if (title.startsWith(typed) || String(c.label).toLowerCase().startsWith(typed)) return 3;
  return terms.every((t) => title.includes(t)) ? 2 : 1;
}

/**
 * The rows to render for `query`.
 *
 * Every command sits at the root. With no query they are listed by category,
 * in the order `categories` gives, and in the order they were written within
 * each. A query keeps the commands that match every word, best match first,
 * so "theme" puts `Look: Theme…` above a row that only mentions themes in an
 * alias. Write-mode rows carry `write`, which the palette shows as a tag.
 *
 * `makeGotoRow(n)` and `makeSearchRow(text)` build the two synthetic rows, so
 * this file never needs to know how to move a deck or open the finder.
 */
export function paletteRows({ commands, query = '', categories = [], totalSlides = 0, makeGotoRow, makeSearchRow }) {
  const q = String(query).trim();
  const order = (c) => { const i = categories.indexOf(c.cat); return i === -1 ? categories.length : i; };
  let rows = commands
    .map((c, i) => ({ c, i, rank: matchRank(c, q) }))
    .filter((r) => r.rank > 0)
    .sort((a, b) => (q ? b.rank - a.rank : 0) || order(a.c) - order(b.c) || a.i - b.i)
    .map((r) => r.c);

  const g = q.match(/^(?:goto\s*)?(\d+)$/i);
  if (g && makeGotoRow) {
    const n = Math.max(1, Math.min(parseInt(g[1], 10), totalSlides));
    rows = [makeGotoRow(n, totalSlides), ...rows];
  }

  if (q && !g && makeSearchRow && !rows.some((c) => matchRank(c, q) === 3)) {
    rows.push(makeSearchRow(query));
  }
  return rows;
}
