// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck is a flat list of top-level <section>s — they never nest — so a split
// on the open tag is exact. Five call sites across cli/ and tools/ each
// re-derived that shape; this is the one place that knows it, so the slide
// count video sees and the slide count voiceover's manifest is keyed on can
// never drift apart. Lives under tools/ because tools/shot.mjs is a consumer
// and the dependency only ever flows cli/ → tools/.

import { escapeHtml } from './escape.mjs';
import { PAUSE_MARK, CLICK_MARK, spoken, stripSlow, notesMarks } from './sentences.mjs';

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
 * Is a `sectionBodies` entry a hidden slide? `data-hidden` on the open tag
 * (DECK_ANATOMY). File-side tools that produce one THING per slide — a video
 * frame, a voiceover file, a PDF page — skip it; tools that NUMBER slides —
 * comments, review anchors, history — do not, because a hidden slide keeps
 * its number exactly as it does in PowerPoint.
 */
export const isHiddenSection = (body) => /^[^>]*\sdata-hidden(?=[\s=>\/])/.test(body);

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
  const close = lastIndexOfCI(inner, '</section>');
  return close === -1 ? inner : inner.slice(0, close);
};

/**
 * `indexOf` / `lastIndexOf`, case-insensitively, WITHOUT lower-casing the
 * haystack first. `s.toLowerCase().indexOf(x)` looks equivalent and is not:
 * lower-casing can change a string's length (U+0130 İ becomes two code units),
 * after which every index it returns is off by one per such character, and a
 * slice of the original at that index lands inside the tag it was aiming at.
 * The needles here are ASCII tag names, so a case-insensitive regex is exact.
 */
const literal = (needle) => new RegExp(needle.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'gi');
export function indexOfCI(s, needle, from = 0) {
  const re = literal(needle);
  re.lastIndex = from;
  const m = re.exec(s);
  return m ? m.index : -1;
}
export function lastIndexOfCI(s, needle) {
  let at = -1;
  for (const m of s.matchAll(literal(needle))) at = m.index;
  return at;
}

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
 * segment says — an `&mdash;` the deck shows as a dash was once spoken, and
 * hashed, as the letters of its name.
 *
 * ⟨PAUSE⟩ (#560) goes too, by default — this is the text that is SPOKEN and
 * SHOWN. `{ pauses: true }` keeps each marker, spaced as a word of its own,
 * for the callers to whom a hold is part of the take: the hash that decides a
 * slide is stale (a moved pause is a re-record, since a recording bakes it),
 * the synthesis core, and the `.txt` script written beside the audio.
 */
export const cleanNotes = (s, { pauses = false } = {}) => decodeNoteEntities(stripSlow(readNotes(s))
  .replaceAll(CLICK_MARK, ' ')
  .replaceAll(PAUSE_MARK, pauses ? ` ${PAUSE_MARK} ` : ' ')
  .replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ')
  .trim();

/**
 * A slide's notes markup with every marker in its one canonical form, the way
 * the runtime reads them: brackets written as entities are brackets, and
 * `[pause]`, `<click>`, `<slow>…</slow>` and the rest are `⟨PAUSE⟩`,
 * `⟨CLICK⟩`, `⟨SLOW⟩…⟨/SLOW⟩` (tools/sentences.mjs `notesMarks`). Everything
 * that splits the raw file on a marker reads it through this first.
 */
export const readNotes = (s) => notesMarks(markBrackets(s));

/**
 * A marker's angle brackets written as entities — `&#10216;CLICK&#10217;`,
 * `&lang;PAUSE&rang;` — as the brackets themselves. The browser reads them that
 * way (`textContent` decodes), so a tool splitting the raw FILE on ⟨CLICK⟩ has
 * to as well, before it splits, or the two count different beats.
 */
export const markBrackets = (s) => String(s ?? '')
  .replace(/&(?:#10216|#x27e8|lang);/gi, '⟨')
  .replace(/&(?:#10217|#x27e9|rang);/gi, '⟩');

// The named entities prose in a note actually uses. A browser knows ~2,000;
// these are the ones an author (or an agent writing HTML) reaches for, and one
// not listed is left as written rather than guessed at.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', lang: '⟨', rang: '⟩', larr: '←', rarr: '→', uarr: '↑',
  darr: '↓', harr: '↔', crarr: '↵', times: '×', middot: '·', bull: '•', deg: '°',
  copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç',
};

/**
 * Entities in note text decoded as a browser decodes them: numeric refs and
 * the named set above, in ONE pass — so `&amp;lt;` is `&lt;`, exactly like a
 * parser. Runs after tags are stripped, so escaped markup survives as text.
 */
export const decodeNoteEntities = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body) => {
  if (body[0] !== '#') return NAMED[body] ?? m;
  const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
});

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
 * the very start or end of a note is punctuation, not a beat. So is one that
 * is nothing but ⟨PAUSE⟩: a hold with no words has no take to be baked into.
 */
export const notesSegments = (notes, { pauses = false } = {}) => {
  const parts = readNotes(notes).split(CLICK_MARK)
    .map((part) => cleanNotes(part, { pauses }))
    .filter((part) => spoken(part));
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
 * Where a section body's OWN `</section>` starts, or -1.
 *
 * `sectionBodies` cuts at the next `<section`, so for every slide but the last
 * one the closing tag is simply the last thing in the piece. The last slide's
 * piece carries the whole tail of the document — `</div>`, the inlined runtime,
 * `</body>` — and a deck that SHOWS markup in a code block carries `</section>`
 * as text. So neither end is reliable on its own: scan from the front with
 * script, style and comment bodies blanked out, and take the first real one.
 *
 * Blanking preserves offsets (same length, spaces), so the index found in the
 * blanked copy is the index in the original.
 */
export function sectionCloseIndex(body) {
  const blanked = String(body ?? '').replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi,
    (m) => ' '.repeat(m.length),
  );
  return indexOfCI(blanked, '</section>');
}

/**
 * One section's markup, re-indented to sit at `indent` in its new deck.
 *
 * A slide arrives with the indentation of the file it came from, and a deck is
 * a text file people read and diff — a block that lands four spaces out of
 * step is a diff nobody can review. Every line is shifted by the same amount,
 * so the section's own inner structure is preserved exactly.
 */
export function reindentSection(section, indent) {
  const lines = String(section).replace(/\s+$/, '').split('\n');
  // The section's own base indentation is NOT the first line's: a section read
  // out of a deck starts at `<section`, its leading whitespace having been the
  // previous line's. The closing tag sits at the base, and where there is none
  // to read, the shallowest line does.
  const closing = /^([ \t]*)<\/section>/.exec(lines[lines.length - 1])?.[1];
  const inner = lines.slice(1).filter((l) => l.trim());
  const own = closing ?? (inner.length
    ? inner.reduce((m, l) => {
      const w = /^[ \t]*/.exec(l)[0];
      return w.length < m.length ? w : m;
    }, /^[ \t]*/.exec(inner[0])[0])
    : '');
  return lines.map((l, i) => {
    if (i === 0) return indent + l.trimStart();
    return l.startsWith(own) ? indent + l.slice(own.length) : l;
  }).join('\n');
}

/**
 * A deck with `sections` inserted after slide `n` (0 puts them first).
 *
 * The sections are written as they arrive, only re-indented — a slide is
 * self-contained markup, which is what makes taking one from another deck a
 * paste rather than a merge.
 */
export function insertSectionsAfter(html, n, sections) {
  const list = sections.filter((x) => String(x ?? '').trim());
  if (!list.length) return html;
  const parts = String(html).split(/(<section\b)/);
  if (parts.length < 3) throw new Error('this deck has no slides to insert beside');
  // the whitespace the anchor slide's own <section> sits at: the run after the
  // last newline of whatever precedes that token
  const before = parts[Math.max(0, 2 * n - 2)];
  const indent = /\n([ \t]*)$/.exec(before)?.[1] ?? '';
  const block = list.map((sec) => reindentSection(sec, indent)).join('\n');

  if (n === 0) {
    // Before the first slide: the deck's preamble ends where slide 1 opens, so
    // this is the one insertion that never looks for a closing tag.
    parts[0] = parts[0].replace(/\s*$/, '') + '\n' + block + '\n' + indent;
    return parts.join('');
  }

  const { parts: p2, idx } = locateSlide(html, n);
  const seg = p2[idx];
  const close = sectionCloseIndex(seg);
  if (close === -1) throw new Error(`slide ${n}: no </section> to insert after`);
  const end = close + '</section>'.length;
  p2[idx] = seg.slice(0, end) + '\n' + block + seg.slice(end);
  return p2.join('');
}

/**
 * Insert `fragment` right before the deck's LAST `</body>`. A bundled deck
 * inlines decklight.js, whose speaker-view popup template carries a literal
 * `</body>` that a first-match search would split mid-string, corrupting the
 * runtime. Returns null when there is no `</body>`, so each caller picks its
 * own fallback (bundle fails; shot appends).
 */
export function injectBeforeBodyEnd(html, fragment) {
  const at = lastIndexOfCI(html, '</body>');
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
    const at = indexOfCI(html, marker, tagEnd + 1);
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

/**
 * The element children of ONE element's raw html (`<g …>…</g>`), by raw
 * position — `sectionChildRanges` one level further down, so an edit can
 * reach a shape inside a diagram by its path from the slide's top-level
 * child. Offsets are into `el` itself. A void or self-closed element has none.
 */
export function elementChildRanges(el) {
  const src = String(el ?? '');
  const open = findTagEnd(src, 0);
  if (src[0] !== '<' || open < 0 || src[open - 1] === '/') return [];
  const name = readTagName(src, 1);
  if (VOID_ELEMENTS.has(name) || OPAQUE_ELEMENTS.has(name)) return [];
  const ranges = [];
  let i = open + 1;
  while (i < src.length) {
    if (src[i] !== '<') { i++; continue; }
    if (src.startsWith('<!--', i)) { i = skipComment(src, i); continue; }
    if (src[i + 1] === '/') break; // the element's own closing tag
    const child = consumeElement(src, i);
    ranges.push({ tag: child.tag, start: child.start, end: child.end });
    i = child.end;
  }
  return ranges;
}

/**
 * Put CSS into a deck's `<head>` under a marker, merging with what that marker
 * already holds rather than stacking a second block beside it.
 *
 * The marker is the point: slides taken from `demo-pitch` put their design in
 * `<style data-from-template="demo-pitch">`, so a second insert from the same
 * template adds to that block, `Z` takes the whole edit back, and a human
 * reading the file can see which rules are somebody else's and where they came
 * from. Rules already present are not repeated — taking two slides that share
 * a class must not write it twice.
 */
export function mergeHeadStyle(html, marker, css) {
  const src = String(html ?? '');
  const add = String(css ?? '').trim();
  if (!add) return src;
  const attr = `data-from-template="${marker}"`;
  const open = new RegExp(`<style\\b[^>]*${attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>([\\s\\S]*?)<\\/style\\s*>`, 'i');
  const found = open.exec(src);
  if (found) {
    const had = found[1];
    const fresh = add.split(/\n(?=\S)/).filter((rule) => !had.includes(rule.trim())).join('\n');
    if (!fresh.trim()) return src;
    const merged = `${had.replace(/\s+$/, '')}\n${fresh}\n`;
    return src.slice(0, found.index) + found[0].replace(had, merged) + src.slice(found.index + found[0].length);
  }
  const block = `  <style ${attr}>\n${add}\n  </style>\n`;
  const headClose = /<\/head\s*>/i.exec(src);
  if (headClose) return src.slice(0, headClose.index) + block + src.slice(headClose.index);
  // no <head> to speak of: before the first section is the next best place a
  // stylesheet can sit and still apply to it
  const firstSection = src.search(/<section\b/i);
  return firstSection === -1 ? src + block : src.slice(0, firstSection) + block + src.slice(firstSection);
}

/** A section body split into its open tag's attributes and everything after. */
export function splitOpenTag(body) {
  const src = String(body ?? '');
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') {
      const attrs = src.slice(0, i).replace(/\/$/, '');
      return { attrs, close: src.slice(i - (src[i - 1] === '/' ? 1 : 0), i + 1), rest: src.slice(i + 1) };
    }
  }
  return { attrs: '', close: '>', rest: src };
}

/** `class="a" data-layout="split"` → `{ class: 'a', 'data-layout': 'split' }`. */
export function readAttrs(text) {
  const out = {};
  const re = /([:@\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const m of String(text ?? '').matchAll(re)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

export const writeAttrs = (attrs) => Object.entries(attrs)
  .map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${String(v).replace(/"/g, '&quot;')}"`))
  .join('');

/**
 * Rewrite slide `n`'s opening tag: every name in `clear` dropped, then `set`
 * written on. The slide's CONTENT is not touched — this is the tag only.
 *
 * Returns `{ html, replaced }`, where `replaced` is what the cleared names held
 * before, so the caller can say what it took away rather than only what it put.
 */
export function setSectionAttrs(html, n, { clear = [], clearIf = null, set = {} } = {}) {
  const { parts, idx } = locateSlide(String(html ?? ''), n);
  const { attrs, rest } = splitOpenTag(parts[idx]);
  const had = readAttrs(attrs);
  const replaced = {};
  for (const k of Object.keys(had)) {
    if (!clear.includes(k) && !clearIf?.(k)) continue;
    replaced[k] = had[k];
    delete had[k];
  }
  for (const [k, v] of Object.entries(set)) had[k] = v;
  parts[idx] = `${writeAttrs(had)}>${rest}`;
  return { html: parts.join(''), replaced };
}

// ── whole-slide operations: new · duplicate · delete · reorder ─────────────
// The slide bar's five verbs, as string transforms over the deck FILE rather
// than over a parsed DOM — the same reason every other file-side edit here is
// (SPEC DECK_ANATOMY): the file is what an author reads and diffs, so moving a
// slide has to hand back the bytes they typed, not a re-serialisation of them.
//
// Numbering is by SOURCE ORDER throughout. A hidden slide is a slide here,
// exactly as it is for comments, review anchors and history — `isHiddenSection`
// is for tools that produce one THING per slide, and none of these do.

/**
 * Slide `n`'s source range in the deck: `[start, end)`, spanning its
 * `<section` through its own `</section>`, plus the indentation the line it
 * opens on sits at.
 *
 * The two offsets are what makes a move a MOVE — the section's bytes are cut
 * and pasted rather than rebuilt, so duplicating a slide or swapping two of
 * them changes nothing whatever about the slides themselves.
 */
export function slideRange(html, n) {
  const src = String(html ?? '');
  const { parts, idx } = locateSlide(src, n);
  let start = 0;
  for (let i = 0; i < idx - 1; i++) start += parts[i].length;   // up to, not including, the `<section` token
  const close = sectionCloseIndex(parts[idx]);
  if (close === -1) throw new Error(`slide ${n}: no </section> to work with`);
  const end = start + parts[idx - 1].length + close + '</section>'.length;
  return { start, end, indent: /\n([ \t]*)$/.exec(src.slice(0, start))?.[1] ?? '' };
}

/**
 * The section a `new` slide inserts. Written at zero indentation and moved
 * into place by `reindentSection`, so it lands level with its neighbours in a
 * deck whose sections sit inside `<div class="decklight">` and in one whose
 * sections sit at the left margin alike.
 */
export const BLANK_SLIDE = `<section>
  <h2>New slide</h2>
  <p>Say something here.</p>
  <aside class="notes"></aside>
</section>`;

/** A deck with a blank slide inserted after slide `after`. */
export const insertBlankSlide = (html, after) =>
  insertSectionsAfter(String(html ?? ''), after, [BLANK_SLIDE]);

/**
 * A deck with slide `n` copied to sit right after itself.
 *
 * The copy is BYTE-IDENTICAL, not reindented: it is going in at the same
 * indentation it came out of, and a duplicate that differs from its original
 * by a space is a diff that says something happened when nothing did.
 */
export function duplicateSlide(html, n) {
  const src = String(html ?? '');
  const { start, end, indent } = slideRange(src, n);
  const copy = src.slice(start, end);
  return src.slice(0, end) + '\n' + indent + copy + src.slice(end);
}

/**
 * A deck with slide `n` removed — and with the line it sat on removed too.
 *
 * Cutting the section alone would leave its newline and its indentation
 * behind as a blank line that nobody typed, and the next `git diff` would
 * carry it. The newline taken is the one BEFORE the slide, so the newline
 * that ends the slide goes on ending whatever now follows it.
 */
export function deleteSlide(html, n) {
  const src = String(html ?? '');
  const { start, end } = slideRange(src, n);
  const before = /\n[ \t]*$/.exec(src.slice(0, start));
  if (before) return src.slice(0, before.index) + src.slice(end);
  // slide 1 of a deck that opens on it (no line above to take): drop the
  // break that followed it instead, so the next slide moves up to the top.
  const after = /^[ \t]*\n/.exec(src.slice(end));
  return src.slice(0, start) + src.slice(end + (after ? after[0].length : 0));
}

/**
 * A deck with slides `a` and `b` swapped, each landing at the OTHER'S
 * indentation (`reindentSection`) rather than carrying its own along.
 *
 * In the ordinary deck, where both sit at the same depth, that is a no-op and
 * the two sections are exchanged byte for byte. It matters for the deck it is
 * not: a slide pasted in at the wrong depth must not drag that depth up the
 * file with it every time somebody presses the reorder key.
 */
export function swapSlides(html, a, b) {
  const src = String(html ?? '');
  const [lo, hi] = a < b ? [a, b] : [b, a];
  if (lo === hi) return src;
  const first = slideRange(src, lo);
  const second = slideRange(src, hi);
  // The destination's own leading whitespace is already in the deck — it sits
  // before `start` — so the moved section is reindented and then has its FIRST
  // line's indentation taken off again, or every swap would push the pair one
  // level deeper than the one before it.
  const moved = (text, indent) => reindentSection(text, indent).replace(/^[ \t]*/, '');
  return src.slice(0, first.start)
    + moved(src.slice(second.start, second.end), first.indent)
    + src.slice(first.end, second.start)
    + moved(src.slice(first.start, first.end), second.indent)
    + src.slice(second.end);
}

/**
 * A deck with `<img src alt>` inserted into slide `slide`, after top-level
 * child `index` — the same addressing the element-edit routes use
 * (`sectionChildRanges`).
 *
 * `index === null` means "on the slide": the image goes after the last content
 * child and BEFORE the asides, so a picture dropped on a slide that has
 * speaker notes lands on the slide and not inside the notes, where the
 * audience would never see it (DECK_ANATOMY — notes, sources and rehearse are
 * all `<aside>` siblings at the end of a section).
 *
 * Returns `{ html, index }`: the caller has to be able to tell the browser
 * which child the new element IS, since every element route addresses by
 * position and everything after the insertion has just shifted.
 */
export function insertImage(html, slide, index, { src = '', alt = '' } = {}) {
  const deck = String(html ?? '');
  const { parts, idx } = locateSlide(deck, slide);
  const seg = parts[idx];
  const ranges = sectionChildRanges(seg);
  // the whitespace a child's own line begins at, or null when it does not
  // begin a line (a slide written on one line stays on one line)
  const indentOf = (r) => (r ? /\n([ \t]*)$/.exec(seg.slice(0, r.start))?.[1] ?? null : null);

  let at;         // offset in `seg` to insert at
  let position;   // the new element's child index once it is in
  if (index === null || index === undefined) {
    let k = ranges.length;
    while (k > 0 && ranges[k - 1].tag === 'aside') k--;
    position = k;
    at = k > 0 ? ranges[k - 1].end : seg.indexOf('>') + 1;
  } else {
    const r = ranges[index];
    if (!r) throw new Error(`slide ${slide}: no element at index ${index} (has ${ranges.length})`);
    position = index + 1;
    at = r.end;
  }
  const tag = `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
  const indent = indentOf(ranges[Math.max(0, position - 1)]) ?? indentOf(ranges[0]);
  parts[idx] = seg.slice(0, at) + (indent === null ? tag : `\n${indent}${tag}`) + seg.slice(at);
  return { html: parts.join(''), index: position };
}
