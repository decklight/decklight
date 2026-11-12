// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What the editing bar's Add menu and the New slide kinds put into a deck
// (SPEC PRESENTING_EDITING): a closed set of starters, each idiomatic
// Decklight, and the one transform that writes one onto a slide.
//
// The SERVER owns this markup, not the page. A page that posted the HTML it
// wanted would make the route a second "write any markup" door beside the
// content editor, and two pages of different versions would add two
// different lists. Here a kind is a name, an unknown name is refused, and
// the answer carries the markup the file got, so the page shows exactly that.
//
// Every starter is written at zero indentation; `insertElement` and
// `insertSectionsAfter` move it to where it lands. The placeholder words are
// obviously placeholders, so nobody presents one by mistake.

import {
  locateSlide, sectionChildRanges, splitOpenTag, readAttrs, setSectionAttrs,
  insertElement, insertInElement, wrapInDiv, insertSectionsAfter,
} from './deck-html.mjs';

/** The kinds of element Add offers, in its order (Picture is the page's file chooser, not a starter). */
export const ELEMENT_KINDS = ['heading', 'text', 'bullets', 'numbered', 'quote', 'table', 'code', 'formula', 'columns', 'diagram', 'chart'];

/** The kinds of slide New slide offers; no kind is today's blank slide (`BLANK_SLIDE`). */
export const SLIDE_KINDS = ['bullets', 'text', 'columns', 'section', 'blank'];

/** A refusal the route answers with its own status: 400 for a kind outside the set, 409 for a slide that cannot take it. */
class StarterError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// one column of a comparison slide (COMPARISON_SLIDES): a heading over its points
const COLUMN = (name) => `<div>
  <h3>${name}</h3>
  <ul>
    <li>New point</li>
    <li>Another point</li>
  </ul>
</div>`;

/**
 * The starter for `kind`. `ctx.titled` says the slide already has its title
 * (a heading added then is a subheading, h3, rather than a second title);
 * `ctx.wire` is an arrowhead id no other element of the deck uses.
 */
function elementStarter(kind, { titled = true, wire = 'dl-wire-1' } = {}) {
  switch (kind) {
    case 'heading': return titled ? '<h3>Heading</h3>' : '<h2>Heading</h2>';
    case 'text': return '<p>New text</p>';
    case 'bullets': return '<ul>\n  <li>New point</li>\n  <li>Another point</li>\n</ul>';
    case 'numbered': return '<ol>\n  <li>First step</li>\n  <li>Next step</li>\n</ol>';
    case 'quote': return '<blockquote>A quote worth repeating</blockquote>';
    case 'table': return `<table>
  <thead>
    <tr><th>Column</th><th>Column</th></tr>
  </thead>
  <tbody>
    <tr><td>Value</td><td>Value</td></tr>
    <tr><td>Value</td><td>Value</td></tr>
  </tbody>
</table>`;
    // CODE_AND_MATH: a language class for the highlighter; the code's own
    // lines start at the margin, since inside <pre> every space is shown
    case 'code': return `<pre><code class="language-js">// New code
const answer = 42;</code></pre>`;
    // CODE_AND_MATH: a display formula in a paragraph, typed as its TeX
    // source; the route marks the slide for math in the same write
    case 'formula': return '<p>$$e^{i\\pi} + 1 = 0$$</p>';
    // COMPARISON_SLIDES: two sibling blocks under a split layout (the route
    // sets the layout), never a column flexbox of our own
    case 'columns': return `${COLUMN('Column')}\n${COLUMN('Column')}`;
    // SVG_DIAGRAMS: two labelled boxes and a wire, theme tokens only, the
    // arrowhead the shipped size, built (a diagram arrives in parts)
    case 'diagram': return `<svg viewBox="0 0 640 200" width="640" data-build="draw" role="img" aria-label="New diagram">
  <defs><marker id="${wire}" markerWidth="6" markerHeight="4" refX="5" refY="2" orient="auto"><polygon points="0 0, 6 2, 0 4" style="fill: var(--d-stroke)"/></marker></defs>
  <g>
    <rect x="40" y="56" width="200" height="88" rx="10" style="fill: var(--d-fill-1); stroke: var(--d-stroke)" stroke-width="2"/>
    <text x="140" y="106" text-anchor="middle" font-size="20" style="font-family: var(--font-body); fill: var(--d-text)">Box A</text>
  </g>
  <line x1="244" y1="100" x2="392" y2="100" stroke-width="2" style="stroke: var(--d-stroke)" marker-end="url(#${wire})"/>
  <g>
    <rect x="400" y="56" width="200" height="88" rx="10" style="fill: var(--d-fill-2); stroke: var(--d-stroke)" stroke-width="2"/>
    <text x="500" y="106" text-anchor="middle" font-size="20" style="font-family: var(--font-body); fill: var(--d-text)">Box B</text>
  </g>
</svg>`;
    // CHARTS: inline JSON the engine draws, its colours the theme's
    case 'chart': return `<div class="chart" data-chart="bar" data-title="New chart" data-aspect="2:1">
  <script type="application/json">
  { "labels": ["A", "B", "C"],
    "series": [ { "name": "Series", "data": [3, 5, 2] } ] }
  </script>
</div>`;
    default: return null;
  }
}

/** The section a New slide of `kind` inserts, or null for a kind outside the set. */
export function slideStarter(kind) {
  const notes = '  <aside class="notes"></aside>';
  switch (kind) {
    case 'bullets': return `<section>\n  <h2>Slide title</h2>\n  <ul>\n    <li>New point</li>\n    <li>Another point</li>\n  </ul>\n${notes}\n</section>`;
    case 'text': return `<section>\n  <h2>Slide title</h2>\n  <p>New text</p>\n${notes}\n</section>`;
    case 'columns': return `<section data-layout="split">\n  <h2>Slide title</h2>\n${[COLUMN('Column'), COLUMN('Column')].map((c) => c.replace(/^/gm, '  ')).join('\n')}\n${notes}\n</section>`;
    // a title card: the engine keeps a slide with nothing past its subtitle centred
    case 'section': return `<section>\n  <h1>Section title</h1>\n  <p>What this part is about</p>\n${notes}\n</section>`;
    case 'blank': return `<section>\n${notes}\n</section>`;
    default: return null;
  }
}

/** A deck with a new slide of `kind` after slide `after`; throws a 400 for a kind outside the set. */
export function insertSlideOfKind(html, after, kind) {
  const section = slideStarter(kind);
  if (!section) throw new StarterError(`no slide kind "${kind}" (one of: ${SLIDE_KINDS.join(', ')})`, 400);
  return insertSectionsAfter(String(html ?? ''), after, [section]);
}

const openTagOf = (el) => {
  const m = /^<([A-Za-z][\w:-]*)/.exec(el);
  return readAttrs(splitOpenTag(el.slice(m ? m[0].length : 0)).attrs);
};

/**
 * A slide's header and content blocks the way a split layout counts them:
 * `title` and `subtitle` (raw child indices, or null), and `blocks`, the
 * indices past them, never an aside, a script, a style or the slide's
 * background (the engine's `splitContent`, read from the file).
 */
function slideBlocks(seg) {
  const subtitleOff = readAttrs(splitOpenTag(seg).attrs)['data-subtitle'] === 'none';
  const kids = sectionChildRanges(seg).map((r, i) => ({ ...r, i, attrs: openTagOf(seg.slice(r.start, r.end)) }))
    .filter((k) => !['aside', 'script', 'style'].includes(k.tag) && !/\bslide-bg\b/.test(k.attrs.class ?? ''));
  let from = 0; let title = null; let subtitle = null;
  if (kids[0] && (kids[0].tag === 'h1' || kids[0].tag === 'h2')) {
    from = 1; title = kids[0].i;
    if (!subtitleOff && kids[1]?.tag === 'p') { from = 2; subtitle = kids[1].i; }
  }
  return { title, subtitle, blocks: kids.slice(from).map((k) => k.i) };
}
const contentBlocks = (seg) => slideBlocks(seg).blocks;

/**
 * The raw indices of a split slide's two columns (COMPARISON_SLIDES), or null
 * when the slide is not split, follows a template (the engine does not split
 * those), or has no pair yet (a lone list splits across two CSS columns and
 * is not a column itself).
 */
export function splitColumns(seg) {
  const attrs = readAttrs(splitOpenTag(seg).attrs);
  if (!/^split/.test(attrs['data-layout'] ?? '') || attrs['data-template']) return null;
  const { blocks } = slideBlocks(seg);
  return blocks.length >= 2 ? [blocks[0], blocks[1]] : null;
}

/**
 * Where a new block lands on slide `seg` when the page asks for "after
 * top-level child `index`, or after the node at `path` below it"
 * (PRESENTING_EDITING, Adding content). The one rule every way of adding
 * shares (Add, the Picture button, a dropped picture, a paste), so that none
 * of them can break the slide's shape:
 *
 *   - the title selected on a slide with a subtitle: after the subtitle, not
 *     between the two (a block there would become the subtitle);
 *   - a column of a split slide selected, or anything inside it: inside that
 *     column, after the column's own child the selection is in, or at the
 *     column's end. Beside it, the block would become a column itself and the
 *     real second column drop underneath as a footer;
 *   - the header of a split slide selected: first in the left column, for the
 *     same reason.
 *
 * Returns `{ index }` for a top-level landing (null: after the last content
 * child, before the asides), or `{ index, into: true, after }` for one inside
 * column `index`: after its element child `after`, first for -1, last for null.
 * `column` says a column was what was selected; `header`, the header child a
 * landing in the left column was moved from.
 */
export function whereNewBlockLands(seg, index, path = null) {
  if (index === null || index === undefined) return { index: null };
  const { title, subtitle } = slideBlocks(seg);
  const i = index === title && subtitle !== null ? subtitle : index;
  const pair = splitColumns(seg);
  if (pair?.includes(i)) {
    const inside = i === index && Array.isArray(path) && Number.isInteger(path[0]) ? path[0] : null;
    return { index: i, into: true, after: inside, column: true };
  }
  if (pair && (i === title || i === subtitle)) return { index: pair[0], into: true, after: -1, header: i };
  return { index: i };
}

/** Is a column's source a plain wrapper a block can go into, rather than one block of its own (a list, a picture, a chart)? */
const isWrapper = (src) => {
  if (!/^<div\b/i.test(src)) return false;
  const attrs = openTagOf(src);
  return !/\b(?:chart|terminal)\b/.test(attrs.class ?? '') && !('data-chart' in attrs) && !('data-cast' in attrs);
};

/**
 * A deck with `markup` (one element) added to slide `slide` where
 * `whereNewBlockLands` says. Returns `{ html, index, path, wrapped }`: the
 * top-level child it is, or is in, and its `path` below that (`[]` on the
 * slide itself). A column that is a single bare block is wrapped in a
 * `<div>` in the same write (`wrapped`), so the new block has somewhere to go.
 */
export function insertBlock(html, slide, index, markup, { path = null } = {}) {
  const deck = String(html ?? '');
  const { parts, idx } = locateSlide(deck, slide);
  const seg = parts[idx];
  if (index !== null && index !== undefined && !sectionChildRanges(seg)[index]) {
    const n = sectionChildRanges(seg).length;
    throw Object.assign(new Error(`slide ${slide}: no element at index ${index} (has ${n})`), { status: 404 });
  }
  const land = whereNewBlockLands(seg, index, path);
  if (!land.into) {
    const out = insertElement(deck, slide, land.index, markup);
    return { html: out.html, index: out.index, path: [], wrapped: false };
  }
  const r = sectionChildRanges(seg)[land.index];
  let next = deck; let after = land.after; let wrapped = false;
  if (!isWrapper(seg.slice(r.start, r.end))) {
    next = wrapInDiv(deck, slide, land.index);
    after = after === -1 ? -1 : 0;   // the bare block is the wrapper's one child
    wrapped = true;
  }
  const out = insertInElement(next, slide, land.index, { markup, after });
  return { html: out.html, index: land.index, path: out.path, wrapped };
}

/** An arrowhead id no element of the deck carries yet. */
function freeWireId(html) {
  for (let n = 1; ; n++) if (!new RegExp(`\\bid=["']dl-wire-${n}["']`).test(html)) return `dl-wire-${n}`;
}

/**
 * A deck with a starter of `kind` on slide `slide`, after top-level child
 * `index` or the node at `path` below it (`index: null`: after the last
 * content child, before the asides, as a dropped picture lands), placed by
 * the one rule every add follows (`whereNewBlockLands`). Returns `{ html,
 * index, path, wrapped, count, markup, layout }`: the first new element's
 * top-level index and its path below it (`[]` on the slide itself, one step
 * inside a column), whether its column was wrapped to take it, how many
 * siblings went in (two columns are two), the markup exactly as written
 * (unindented), the layout the slide was given, when one was (`split`,
 * for two columns), and the attributes its `<section>` was given (`section`,
 * `{ 'data-math': '' }` for a formula on a slide not yet marked for math).
 *
 * Refused (thrown, with the status the route answers): a kind outside the set
 * (400); a slide that follows a design system's slide template (409), whose
 * content goes in its slots and nowhere beside them (DESIGN_SYSTEMS), the
 * same reason an edit may never drop a slot; two columns where the slide
 * already has content before them (409): a split layout makes its first two
 * blocks the columns, so the columns go first under the title; and two
 * columns asked for inside a column (409).
 */
export function insertStarter(html, slide, index, kind, { path = null } = {}) {
  const deck = String(html ?? '');
  if (!ELEMENT_KINDS.includes(kind)) {
    throw new StarterError(`no kind "${kind}" to add (one of: ${ELEMENT_KINDS.join(', ')})`, 400);
  }
  const { parts, idx } = locateSlide(deck, slide);
  const seg = parts[idx];
  const sectionAttrs = readAttrs(splitOpenTag(seg).attrs);
  const template = sectionAttrs['data-template'];
  if (template) {
    throw new StarterError(`slide ${slide} follows the "${template}" slide template: what it says goes in the template's slots, so nothing is added beside them. Edit a slot's words, or take the slide out of the template (Use slide template…) to add freely`, 409);
  }
  const titled = sectionChildRanges(seg).some((r) => r.tag === 'h1' || r.tag === 'h2');
  const markup = elementStarter(kind, { titled, wire: kind === 'diagram' ? freeWireId(deck) : undefined });
  const count = kind === 'columns' ? 2 : 1;
  let layout = null;
  let out;
  if (kind === 'columns') {
    // two siblings, never inside a column: a slide has one pair
    const land = whereNewBlockLands(seg, index, path);
    if (land.column) {
      throw new StarterError(`two columns do not go inside a column: slide ${slide} already has its pair, and a third column would drop underneath as a footer. Add a new slide in two columns instead (Slide ▾, New slide)`, 409);
    }
    out = { ...insertElement(deck, slide, land.into ? land.header : land.index, markup), path: [], wrapped: false };
    const after = locateSlide(out.html, slide);
    const blocks = contentBlocks(after.parts[after.idx]);
    if (blocks[0] !== out.index || blocks[1] !== out.index + 1) {
      throw new StarterError(`two columns go first under the title (a split layout makes the slide's first two blocks its columns), and slide ${slide} already has content there: select the title and add them right under it, or add a new slide in two columns (Slide ▾, New slide)`, 409);
    }
    if (!/^split/.test(sectionAttrs['data-layout'] ?? '')) {
      out.html = setSectionAttrs(out.html, slide, { set: { 'data-layout': 'split' } }).html;
      layout = 'split';
    }
  } else out = insertBlock(deck, slide, index, markup, { path });
  // a formula renders only on a slide marked for math: marked in the same write, one undo for both
  let section = null;
  if (kind === 'formula' && !Object.hasOwn(sectionAttrs, 'data-math')) {
    out.html = setSectionAttrs(out.html, slide, { set: { 'data-math': '' } }).html;
    section = { 'data-math': '' };
  }
  return { html: out.html, index: out.index, path: out.path, wrapped: out.wrapped, count, markup, layout, section };
}
