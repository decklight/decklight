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

// ── a raw section's top-level children (element edit mode, #112) ──────────
// Void/self-closing tags never open a nesting level, and <script>/<style>
// bodies are never tag-parsed (a chart's embedded JSON spec is not markup) —
// between those two, everything else nests by genuine recursion rather than a
// same-tag-name counter, so a <div> holding another <div>, or an <svg> full of
// self-closing children, still ends exactly where it should.
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const OPAQUE_ELEMENTS = new Set(['script', 'style']);

function skipComment(html, at) {
  const end = html.indexOf('-->', at + 4);
  return end === -1 ? html.length : end + 3;
}

function readTagName(html, at) {
  let j = at;
  while (j < html.length && /[a-zA-Z0-9:_-]/.test(html[j])) j++;
  return html.slice(at, j).toLowerCase();
}

/** Index of the '>' that closes the tag opening at `at` (html[at] === '<'), skipping quoted attribute values (a `>` inside `"..."` or `'...'` ends nothing). */
function findTagEnd(html, at) {
  let quote = null;
  for (let j = at + 1; j < html.length; j++) {
    const c = html[j];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return j;
  }
  return html.length - 1;
}

/**
 * One element starting at `start` (html[start] === '<', an opening tag — never
 * '</' or '<!--', which the caller has already stepped past). Recurses into
 * children to find ITS OWN matching close, so nesting depth falls out of the
 * recursion instead of a counter that would have to know every tag name
 * involved. Malformed input (an unclosed tag) ends at the string's end rather
 * than throwing: a best-effort range for a slide someone is mid-edit on.
 */
function consumeElement(html, start) {
  const name = readTagName(html, start + 1);
  const tagEnd = findTagEnd(html, start);
  if (html[tagEnd - 1] === '/' || VOID_ELEMENTS.has(name)) {
    return { tag: name, start, end: tagEnd + 1 };
  }
  if (OPAQUE_ELEMENTS.has(name)) {
    const marker = `</${name}`;
    const at = html.toLowerCase().indexOf(marker, tagEnd + 1);
    const end = at === -1 ? html.length : findTagEnd(html, at) + 1;
    return { tag: name, start, end };
  }
  let i = tagEnd + 1;
  while (i < html.length) {
    if (html[i] !== '<') { i++; continue; }
    if (html.startsWith('<!--', i)) { i = skipComment(html, i); continue; }
    if (html[i + 1] === '/') return { tag: name, start, end: findTagEnd(html, i) + 1 };
    i = consumeElement(html, i).end; // a whole child, skipped over regardless of its own name
  }
  return { tag: name, start, end: html.length };
}

/**
 * The top-level element children of slide `n`'s raw `<section>` segment (as
 * `locateSlide` returns it in `parts[idx]`), by RAW POSITION — title included,
 * not filtered as chrome the way the engine's own `splitContent()` filters a
 * live, parsed DOM. `start`/`end` are offsets into `seg` itself, so a caller
 * splices directly: `seg.slice(0, r.start) + replacement + seg.slice(r.end)`.
 * Top-level text and comments are not children and never appear in the list.
 */
export function sectionChildRanges(seg) {
  const gt = seg.indexOf('>');
  if (gt < 0) throw new Error('malformed <section> tag');
  const close = seg.indexOf('</section>', gt);
  const body = close === -1 ? seg.slice(gt + 1) : seg.slice(gt + 1, close);
  const ranges = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== '<') { i++; continue; }
    if (body.startsWith('<!--', i)) { i = skipComment(body, i); continue; }
    if (body[i + 1] === '/') break; // this section's own closing tag
    const el = consumeElement(body, i);
    ranges.push({ tag: el.tag, start: el.start + gt + 1, end: el.end + gt + 1 });
    i = el.end;
  }
  return ranges;
}
