// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * What `invisible-in-print` says (#1184): one sentence for `decklight pdf`,
 * `decklight check` and the Check deck… panel, so the three read alike. Pure,
 * and here rather than in src/ for the reason tools/click-match.mjs gives:
 * cli/ never imports src/, src/ may import a tool.
 */

/** What usually makes such a hole, and the way out of it. */
export const INVISIBLE_ADVICE = 'print shows an entrance the deck animates with its own CSS as it ends, '
  + 'and this one does not end visible: make it a build (SPEC BUILDS), or mark it data-invisible-ok if it is meant';

/**
 * The element a slide does not show and how many more: `a box “Batch”
 * (opacity 0), and 1 more element`. `what` is the runtime's naming
 * (`data-invisible`), '' for nothing.
 */
export function invisibleSaidOf(what, more = 0) {
  if (!what) return '';
  const n = Number(more);
  return `${what}${n > 0 ? `, and ${n} more element${n === 1 ? '' : 's'}` : ''}`;
}

/** The finding's message, as `check` prints it. */
export const invisibleMessage = (said) => `invisible in print: ${said} — ${INVISIBLE_ADVICE}`;
