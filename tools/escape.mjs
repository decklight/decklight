// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The Node side's HTML escape. One function, deliberately.
//
// This file replaced four of them: `cli/serve.mjs` escaped `& < >`,
// `cli/bundle.mjs`'s escAttr escaped `& " <`, `tools/pptx.mjs` and
// `src/core/charts.js` escaped `& < > "` — two of them named `escapeHtml` and
// behaving differently. None of the call sites was wrong, which is exactly the
// problem: the next caller picks one by name, and the one whose name reads
// most general (`escapeHtml`, in serve.mjs) was the one that left quotes
// alone. `cli/init.mjs` already carried the comment "a prompt invites &, <
// and quotes" above a call that escaped two of those three.
//
// So the choice here is a single escape that is correct in BOTH places text
// can land — element content and a double-quoted attribute — rather than a
// pair the caller has to choose between correctly. Single quotes are left
// alone: every attribute decklight writes is double-quoted, and `&#39;` in a
// title is churn with no reader.
//
// `<!--` and `</script` are a different problem with a different answer —
// they are about what a SCRIPT body may contain, not what text may, and
// `scriptSafe` in cli/util.mjs owns them.
//
// The runtime has its own copy in src/core/escape.js, because src/ is bundled
// into a zero-dependency artifact and cannot import from tools/. A test pins
// the two against each other so "its own copy" cannot become "its own
// behaviour" (test/deck-html.test.mjs).

/**
 * Escape `s` for HTML text or a double-quoted attribute value.
 *
 * Order matters: `&` first, or the ampersands introduced by the later
 * replacements get escaped a second time.
 */
export const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
