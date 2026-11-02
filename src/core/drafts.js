// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Work typed into the page that the deck file does not have yet
 * (PRESENTING_EDITING).
 *
 * Write mode reloads the page whenever the file changes on disk: an agent
 * finishing, another tab, an outside editor. A reload is the right answer to
 * a file that moved, and the wrong one to the half-typed sentence in the notes
 * card, the HTML editor, a comment or the agent prompt, which it threw away
 * without a word. So every place that holds a draft says so here, and the
 * reload asks first: while anything is held, it waits, and says what for.
 *
 * One registry for the page, not one per panel: the reload is the page's, and
 * a panel built before write mode answered (sources, the review panel) holds
 * drafts all the same.
 */

const holders = new Set();

/**
 * `what` answers, whenever asked, what this place holds that the file does
 * not, in a few words ("the notes on slide 3"), or null when it holds nothing.
 * Returns the function that lets go, for when the place closes.
 */
export function holdDraft(what) {
  holders.add(what);
  return () => { holders.delete(what); };
}

/** Everything held right now, each in its own words; [] when nothing is. */
export function unsavedDrafts() {
  const out = [];
  for (const what of holders) {
    let said = null;
    try { said = what(); } catch { /* a closed panel's leftover: holds nothing */ }
    if (typeof said === 'string' && said && !out.includes(said)) out.push(said);
  }
  return out;
}

/** The held drafts in one phrase: "a, b and c". */
export function draftList(drafts) {
  const d = drafts.filter(Boolean);
  if (d.length <= 1) return d[0] ?? '';
  return `${d.slice(0, -1).join(', ')} and ${d.at(-1)}`;
}

/**
 * What the bar says while a reload waits on `drafts`: what happened, what it
 * waits for, and that nothing is lost by waiting.
 */
export function heldReloadText(drafts) {
  const list = draftList(drafts);
  return `The deck changed on disk. It reloads by itself once you save or close ${list || 'your edit'}, so nothing you typed is lost.`;
}
