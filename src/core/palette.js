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
/**
 * A command's label, with the `(dev)` suffix that marked author-mode rows
 * turned into a flag: the suffix was jargon on thirty rows, and a tag says
 * the same thing once.
 */
export function normalizeCommand(c) {
  const m = /^(.*?)\s*\(dev\)$/.exec(c.label ?? '');
  return m ? { ...c, label: m[1], dev: true } : c;
}

/**
 * A ROW can be a header (`{ header }`, not selectable), a group row
 * (`{ groupRow }`, which opens its group), a back row, or a command.
 *
 * With no query the list is the deck's doors, not its every command: rows
 * that name a `group` fold into one row per group (`Export & share…`), and
 * the author-mode rows sit together under one header. Typing searches every
 * command flat, groups included, so "handout" still finds the PDF handout in
 * one step; `group` shows that group's rows under a back row.
 */
export function paletteRows({ commands: given, query = '', group = null, totalSlides = 0, makeGotoRow, makeSearchRow }) {
  const commands = given.map(normalizeCommand);
  const q = String(query).toLowerCase();
  if (!q && group) {
    return [{ label: '← back', back: true, hint: '⌫' }, ...commands.filter((c) => c.group === group)];
  }
  let rows;
  if (q) rows = commands.filter((c) => (c.label + ' ' + (c.alias ?? '') + ' ' + (c.group ?? '')).toLowerCase().includes(q));
  else {
    const seen = new Set();
    const top = [];
    for (const c of commands) {
      if (!c.group) { top.push(c); continue; }
      if (seen.has(c.group)) continue;
      seen.add(c.group);
      top.push({ label: `${c.group}…`, groupRow: c.group, hint: '▸', dev: c.dev });
    }
    const plain = top.filter((c) => !c.dev);
    const dev = top.filter((c) => c.dev);
    rows = dev.length ? [...plain, { header: 'author mode' }, ...dev] : plain;
  }

  const g = String(query).trim().match(/^(?:goto\s*)?(\d+)$/i);
  if (g && makeGotoRow) {
    const n = Math.max(1, Math.min(parseInt(g[1], 10), totalSlides));
    rows.unshift(makeGotoRow(n, totalSlides));
  }

  if (q && !g && makeSearchRow && !rows.some((c) => !c.header && c.label.toLowerCase().startsWith(q))) {
    rows.push(makeSearchRow(query));
  }
  return rows;
}
