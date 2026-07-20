// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck is a flat list of top-level <section>s — they never nest — so a split
// on the open tag is exact. Five call sites across cli/ and tools/ each
// re-derived that shape; this is the one place that knows it, so the slide
// count video sees and the slide count voiceover's manifest is keyed on can
// never drift apart. Lives under tools/ because tools/shot.mjs is a consumer
// and the dependency only ever flows cli/ → tools/.

/**
 * A section's `<aside class="notes">`. Capture group [1] is the inner HTML (what
 * voiceover pulls); the whole match is what edit tests for and replaces.
 */
export const NOTES_ASIDE = /<aside class="notes">([\s\S]*?)<\/aside>/;

/**
 * Read-only: each slide's `<section>` body, in order (the open tag is dropped).
 * What video and voiceover walk to count slides and pull notes — they MUST see
 * the same list, which is exactly why they share this.
 */
export const sectionBodies = (html) => html.split(/<section\b/).slice(1);

/**
 * Locate slide `n` (1-based) for a round-trip rewrite. Returns the capturing
 * split (`[preamble, '<section', body1, '<section', body2, …]`) and the index
 * of slide n's body segment; throws with the deck's real slide count when n is
 * out of range. The caller rewrites `parts[idx]` and `parts.join('')`s it back.
 */
export function locateSlide(html, n) {
  const parts = html.split(/(<section\b)/);
  const idx = 2 * n; // parts[0] preamble, then [tag, body] pairs
  if (!parts[idx]) throw new Error(`no slide ${n} (deck has ${(parts.length - 1) / 2})`);
  return { parts, idx };
}

/**
 * Insert `fragment` right before the deck's LAST `</body>`. A bundled deck
 * inlines decklight.js, whose speaker-view popup template carries a literal
 * `</body>` that a first-match search would split mid-string, corrupting the
 * runtime. Returns null when there is no `</body>`, so each caller picks its
 * own fallback (bundle fails; shot appends).
 */
export function injectBeforeBodyEnd(html, fragment) {
  const at = html.toLowerCase().lastIndexOf('</body>');
  return at === -1 ? null : html.slice(0, at) + fragment + html.slice(at);
}
