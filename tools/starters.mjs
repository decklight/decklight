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
  insertElement, insertSectionsAfter,
} from './deck-html.mjs';

/** The kinds of element Add offers, in its order (Picture is the page's file chooser, not a starter). */
export const ELEMENT_KINDS = ['heading', 'text', 'bullets', 'numbered', 'quote', 'table', 'code', 'columns', 'diagram', 'chart'];

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
 * The indices of slide content's blocks the way a split layout counts them:
 * past the title and its subtitle, never an aside, a script, a style or the
 * slide's background (the engine's `splitContent`, read from the file).
 */
function contentBlocks(seg) {
  const subtitleOff = readAttrs(splitOpenTag(seg).attrs)['data-subtitle'] === 'none';
  const kids = sectionChildRanges(seg).map((r, i) => ({ ...r, i, attrs: openTagOf(seg.slice(r.start, r.end)) }))
    .filter((k) => !['aside', 'script', 'style'].includes(k.tag) && !/\bslide-bg\b/.test(k.attrs.class ?? ''));
  let from = 0;
  if (kids[0] && (kids[0].tag === 'h1' || kids[0].tag === 'h2')) {
    from = 1;
    if (!subtitleOff && kids[1]?.tag === 'p') from = 2;
  }
  return kids.slice(from).map((k) => k.i);
}

/** An arrowhead id no element of the deck carries yet. */
function freeWireId(html) {
  for (let n = 1; ; n++) if (!new RegExp(`\\bid=["']dl-wire-${n}["']`).test(html)) return `dl-wire-${n}`;
}

/**
 * A deck with a starter of `kind` on slide `slide`, after top-level child
 * `index` (`null`: after the last content child, before the asides, as a
 * dropped picture lands). Returns `{ html, index, count, markup, layout }`:
 * the first new element's index, how many siblings went in (two columns are
 * two), the markup exactly as written (unindented), and the layout the slide
 * was given, when one was (`split`, for two columns).
 *
 * Refused (thrown, with the status the route answers): a kind outside the set
 * (400); a slide that follows a design system's slide template (409), whose
 * content goes in its slots and nowhere beside them (DESIGN_SYSTEMS), the
 * same reason an edit may never drop a slot; and two columns where the slide
 * already has content before them (409): a split layout makes its first two
 * blocks the columns, so the columns go first under the title.
 */
export function insertStarter(html, slide, index, kind) {
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
  const out = insertElement(deck, slide, index, markup);
  const count = kind === 'columns' ? 2 : 1;
  let layout = null;
  let next = out.html;
  if (kind === 'columns') {
    const after = locateSlide(next, slide);
    const blocks = contentBlocks(after.parts[after.idx]);
    if (blocks[0] !== out.index || blocks[1] !== out.index + 1) {
      throw new StarterError(`two columns go first under the title (a split layout makes the slide's first two blocks its columns), and slide ${slide} already has content there: select the title and add them right under it, or add a new slide in two columns (Slide ▾, New slide)`, 409);
    }
    if (!/^split/.test(sectionAttrs['data-layout'] ?? '')) {
      next = setSectionAttrs(next, slide, { set: { 'data-layout': 'split' } }).html;
      layout = 'split';
    }
  }
  return { html: next, index: out.index, count, markup, layout };
}
