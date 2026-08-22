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
 * A section body from `sectionBodies`, reduced to what is actually inside the
 * section.
 *
 * `sectionBodies` splits on `<section` and keeps everything after it, so each
 * piece begins with the REST OF THE OPEN TAG (` class="x">`) and ends with the
 * closing tag and whatever follows. A DOM reader never sees either. Anything
 * comparing the two — the review fingerprint does — has to drop them, or the
 * file side hashes a stray `>` that the browser side cannot produce.
 */
export const sectionInner = (body) => {
  const s = String(body ?? '');
  const open = s.indexOf('>');
  const inner = open === -1 ? s : s.slice(open + 1);
  const close = inner.toLowerCase().lastIndexOf('</section>');
  return close === -1 ? inner : inner.slice(0, close);
};

/**
 * A slide's own text, as the fingerprint that anchors review comments sees it
 * (SPEC REVIEW) — the file-reading twin of `slideBody` in src/core/finder.js.
 *
 * Asides are dropped before anything else: a comment is about what the audience
 * sees, so an author rewriting their own speaker notes must not orphan every
 * comment on the slide. Scripts and styles go for the same reason the DOM side
 * filters them — they are machinery, not content.
 *
 * The two sides do NOT have to agree about spacing, because `fingerprint`
 * removes whitespace rather than collapsing it. They do have to agree about
 * what counts as content, which is what this shares with its DOM twin.
 */
export const slideText = (sectionBody) => String(sectionBody ?? '')
  .replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ')
  .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * A slide's title as the finder and the comment list both name it: the first
 * heading, else its opening words. The file-reading twin of `slideTitle`.
 */
export const slideHeading = (sectionBody, i) => {
  const h = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(sectionBody);
  const fromHeading = h ? slideText(h[1]) : '';
  return fromHeading || slideText(sectionBody).slice(0, 60) || `slide ${i + 1}`;
};

/**
 * Speaker-note HTML as plain text: tags out, entities back, whitespace flat.
 *
 * The runtime gets this for free from `textContent`; a tool reading the FILE
 * has to do it, and has to do it the same way or the two disagree about what a
 * segment says.
 */
export const cleanNotes = (s) => String(s ?? '')
  .replace(/⟨CLICK⟩/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * A slide's notes split into the ⟨CLICK⟩ segments that become FILES, or null
 * when there are not enough to be worth segmenting.
 *
 * Lives here rather than in tools/voiceover.mjs — which cannot be imported at
 * all, it arg-parses and exits at load — so the runtime's
 * `segmentFileIndex` can be tested against the very function that names the
 * files it is predicting. Those two disagreeing is a silent bug: the runtime
 * keeps empty segments (segment k must line up with build step k) and this
 * drops them (it is naming files), so a ⟨CLICK⟩ at the start of a note shifts
 * every filename by one.
 *
 * An empty segment is dropped rather than recorded as silence — a ⟨CLICK⟩ at
 * the very start or end of a note is punctuation, not a beat.
 */
export const notesSegments = (notes) => {
  const parts = String(notes ?? '').split('⟨CLICK⟩').map(cleanNotes).filter(Boolean);
  return parts.length > 1 ? parts : null;
};

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
