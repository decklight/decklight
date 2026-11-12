// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Adding content from the editing bar (SPEC PRESENTING_EDITING): the
// transform that puts markup onto a slide (`insertElement`), each starter the
// server owns (tools/starters.mjs), the route that writes one, and the kinds
// of new slide. Pure string surgery and route handlers called as functions:
// no browser, no socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { insertElement, insertImage, insertInElement, wrapInDiv, sectionBodies, sectionChildRanges, locateSlide } from '../tools/deck-html.mjs';
import { insertStarter, insertBlock, insertSlideOfKind, slideStarter, whereNewBlockLands, splitColumns, inlineWords, ELEMENT_KINDS, SLIDE_KINDS } from '../tools/starters.mjs';
import { duplicateSlideElement } from '../cli/edit.mjs';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { createHistory } from '../cli/edit.mjs';
import { tmp } from './helpers.mjs';

const DECK = `<!doctype html>
<html><body>
  <div class="decklight">
    <section>
      <h2>Alpha</h2>
      <p>Intro</p>
      <ul><li>one</li></ul>
      <aside class="notes">talk</aside>
    </section>
    <section>
      <h2>Beta</h2>
      <aside class="notes">more</aside>
    </section>
    <section data-template="acme/divider">
      <h2 data-slot="title">Part two</h2>
    </section>
    <section>
      <aside class="notes">only notes</aside>
    </section>
  </div>
</body></html>
`;

/** Slide `n`'s source, `<section` through its own `</section>`. */
const source = (html, n) => {
  const b = sectionBodies(html)[n - 1];
  return `<section${b.slice(0, b.indexOf('</section>') + '</section>'.length)}`;
};
const tags = (html, n) => {
  const { parts, idx } = locateSlide(html, n);
  return sectionChildRanges(parts[idx]).map((r) => r.tag);
};

// ── insertElement ───────────────────────────────────────────────────────

test('multi-line markup lands at the slide\'s own indentation, every line of it', () => {
  const { html, index } = insertElement(DECK, 1, 1, '<ul>\n  <li>New point</li>\n</ul>');
  assert.equal(index, 2);
  assert.equal(source(html, 1), [
    '<section>',
    '      <h2>Alpha</h2>',
    '      <p>Intro</p>',
    '      <ul>',
    '        <li>New point</li>',
    '      </ul>',
    '      <ul><li>one</li></ul>',
    '      <aside class="notes">talk</aside>',
    '    </section>',
  ].join('\n'));
});

test('with no index it goes after the last content child and before the asides', () => {
  const { html, index } = insertElement(DECK, 1, null, '<p>New text</p>');
  assert.equal(index, 3);
  assert.deepEqual(tags(html, 1), ['h2', 'p', 'ul', 'p', 'aside']);
  assert.match(source(html, 1), /<ul><li>one<\/li><\/ul>\n {6}<p>New text<\/p>\n {6}<aside/);
});

test('a slide of nothing but notes takes the element before them, on its own line', () => {
  const { html, index } = insertElement(DECK, 4, null, '<h2>Heading</h2>');
  assert.equal(index, 0);
  assert.equal(source(html, 4), '<section>\n      <h2>Heading</h2>\n      <aside class="notes">only notes</aside>\n    </section>');
});

test('the lines of a code block are never reindented: inside <pre> the spaces are the code\'s', () => {
  const { html } = insertElement(DECK, 2, 0, '<pre><code>a\n  b</code></pre>\n<p>after</p>');
  assert.match(source(html, 2), /\n {6}<pre><code>a\n {2}b<\/code><\/pre>\n {6}<p>after<\/p>/);
});

test('a slide written on one line stays on one line', () => {
  const deck = '<div><section><h2>A</h2><aside class="notes">n</aside></section></div>';
  const { html, index } = insertElement(deck, 1, null, '<p>x</p>');
  assert.equal(index, 1);
  assert.equal(html, '<div><section><h2>A</h2><p>x</p><aside class="notes">n</aside></section></div>');
});

test('an index or a slide that does not exist throws rather than guessing', () => {
  assert.throws(() => insertElement(DECK, 9, null, '<p>x</p>'), /no slide 9/);
  assert.throws(() => insertElement(DECK, 1, 7, '<p>x</p>'), /no element at index 7/);
});

test('insertImage is insertElement with an <img>, as before', () => {
  assert.deepEqual(insertImage(DECK, 1, null, { src: 'a.png', alt: 'x' }), insertElement(DECK, 1, null, '<img src="a.png" alt="x">'));
});

// ── the starters ────────────────────────────────────────────────────────

test('every kind has a starter that lands on the slide, after the selection, with its index answered', () => {
  for (const kind of ELEMENT_KINDS) {
    if (kind === 'columns') continue;   // its own rule, below
    const out = insertStarter(DECK, 1, 1, kind, { with: { src: 'assets/clip.mp4', cast: 'casts/demo.cast.json', url: 'https://example.com/' } });
    assert.equal(out.index, 2, `${kind}: after the selection`);
    assert.deepEqual(out.path, [], `${kind}: on the slide, not inside anything`);
    assert.equal(out.count, 1);
    const { parts, idx } = locateSlide(out.html, 1);
    const r = sectionChildRanges(parts[idx])[2];
    const written = parts[idx].slice(r.start, r.end);
    const lines = (s) => s.split('\n').map((l) => l.trimStart());
    assert.deepEqual(lines(written), lines(out.markup), `${kind}: the file has the markup the page is told`);
    assert.deepEqual(tags(out.html, 1).slice(-1), ['aside'], `${kind}: the notes stay last`);
  }
});

test('the starters say what they are and look like Decklight: placeholders, theme tokens, no literal colours', () => {
  const m = (kind, slide = 1, index = null) => insertStarter(DECK, slide, index, kind).markup;
  assert.equal(m('heading'), '<h3>Heading</h3>', 'a slide with a title gets a subheading');
  assert.equal(m('heading', 4), '<h2>Heading</h2>', 'a slide without one gets its title');
  assert.match(m('text'), /^<p>New text<\/p>$/);
  assert.match(m('bullets'), /^<ul>\n {2}<li>New point<\/li>/);
  assert.match(m('numbered'), /^<ol>\n {2}<li>First step<\/li>/);
  assert.match(m('quote'), /^<blockquote>/);
  assert.match(m('table'), /<thead>[\s\S]*<th>Column<\/th>[\s\S]*<tbody>[\s\S]*<td>Value<\/td>/);
  // CODE_AND_MATH: a language for the highlighter, the code at the margin
  assert.match(m('code'), /^<pre><code class="language-js">[^\n]*\nconst answer = 42;<\/code><\/pre>$/);
  // SVG_DIAGRAMS: two labelled boxes and a wire, tokens only, built
  const svg = m('diagram');
  assert.equal(svg.match(/<rect\b/g).length, 2);
  assert.equal(svg.match(/<line\b/g).length, 1);
  assert.deepEqual(svg.match(/>[^<>]+<\/text>/g), ['>Box A</text>', '>Box B</text>']);
  assert.match(svg, /data-build="draw"/);
  assert.match(svg, /markerWidth="6" markerHeight="4" refX="5" refY="2"/, 'the shipped arrowhead');
  assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i, 'no literal colour: every one a theme token');
  assert.match(svg, /var\(--d-fill-1\)[\s\S]*var\(--d-stroke\)[\s\S]*var\(--d-text\)/);
  // CHARTS: inline JSON the engine draws
  const chart = m('chart');
  assert.match(chart, /^<div class="chart" data-chart="bar" data-title="New chart" data-aspect="2:1">/);
  const json = /<script type="application\/json">([\s\S]*?)<\/script>/.exec(chart)[1];
  assert.deepEqual(JSON.parse(json).labels, ['A', 'B', 'C']);
  assert.doesNotMatch(chart, /#[0-9a-f]{3,8}\b/i);
});

test('a second diagram gets an arrowhead id of its own', () => {
  const once = insertStarter(DECK, 1, null, 'diagram');
  const twice = insertStarter(once.html, 2, null, 'diagram');
  assert.match(once.markup, /id="dl-wire-1"/);
  assert.match(twice.markup, /id="dl-wire-2"[\s\S]*url\(#dl-wire-2\)/);
});

test('a formula is a display formula in a paragraph, and marks its slide for math in the same write (CODE_AND_MATH)', () => {
  const out = insertStarter(DECK, 2, 0, 'formula');
  assert.equal(out.markup, '<p>$$e^{i\\pi} + 1 = 0$$</p>');
  assert.deepEqual(out.section, { 'data-math': '' });
  assert.match(source(out.html, 2), /^<section data-math>/);
  // a slide already marked keeps its mark, and says nothing about it
  const marked = insertStarter(out.html, 2, null, 'formula');
  assert.equal(marked.section, null);
  assert.equal((source(marked.html, 2).match(/data-math/g) ?? []).length, 1);
});

test('a video is the file it is given, beside the deck, with its controls; anything else is refused', () => {
  const out = insertStarter(DECK, 2, 0, 'video', { with: { src: 'assets/demo clip.mp4' } });
  assert.equal(out.markup, '<video src="assets/demo clip.mp4" controls playsinline preload="metadata"></video>');
  for (const src of [undefined, '', 'https://x.test/a.mp4', '/abs/a.mp4', '../a.mp4', 'assets/a.mov', 'a".mp4']) {
    assert.throws(() => insertStarter(DECK, 2, 0, 'video', { with: { src } }), (e) => e.status === 400 && /mp4 or a webm beside the deck/.test(e.message), String(src));
  }
});

test('a terminal plays the recording it is given, beside the deck, a command a click; anything else is refused', () => {
  const out = insertStarter(DECK, 2, 0, 'terminal', { with: { cast: 'casts/demo.cast.json' } });
  assert.equal(out.markup, '<div class="terminal" data-cast="casts/demo.cast.json" data-mode="step"></div>');
  assert.match(insertStarter(DECK, 2, 0, 'terminal', { with: { cast: 'talk.cast' } }).markup, /data-cast="talk\.cast"/, 'an asciicast too');
  for (const cast of [undefined, '', 'https://x.test/a.cast.json', '/abs/a.cast.json', '../a.cast.json', 'casts/a.json', 'a".cast.json']) {
    assert.throws(() => insertStarter(DECK, 2, 0, 'terminal', { with: { cast } }), (e) => e.status === 400 && /terminal recording is a \.cast\.json/.test(e.message), String(cast));
  }
});

test('a web page is an https address in a frame, with a title, loaded as it comes near; anything else is refused', () => {
  const out = insertStarter(DECK, 2, 0, 'webpage', { with: { url: 'https://example.com/a?b=1&c=2' } });
  assert.equal(out.markup, '<iframe src="https://example.com/a?b=1&amp;c=2" title="Web page: example.com" loading="lazy"></iframe>');
  assert.match(insertStarter(DECK, 2, 0, 'webpage', { with: { url: 'https://x.test/', title: 'The dashboard' } }).markup, /title="The dashboard"/);
  for (const url of [undefined, '', 'http://example.com/', 'javascript:alert(1)', 'https://a b', 'https://x.test/"onload="x', 'example.com']) {
    assert.throws(() => insertStarter(DECK, 2, 0, 'webpage', { with: { url } }), (e) => e.status === 400 && /an https address/.test(e.message), String(url));
  }
});

test('two columns are two sibling blocks under a split layout, first under the title (COMPARISON_SLIDES)', () => {
  const out = insertStarter(DECK, 2, 0, 'columns');
  assert.equal(out.index, 1);
  assert.equal(out.count, 2);
  assert.equal(out.layout, 'split');
  assert.match(source(out.html, 2), /^<section data-layout="split">/);
  assert.deepEqual(tags(out.html, 2), ['h2', 'div', 'div', 'aside']);
  assert.doesNotMatch(out.markup, /display\s*:\s*flex/, 'never a column flexbox of its own beside split');
  // a slide already split keeps the layout it has
  const flip = DECK.replace('<section>\n      <h2>Beta</h2>', '<section data-layout="split-flip">\n      <h2>Beta</h2>');
  const kept = insertStarter(flip, 2, null, 'columns');
  assert.equal(kept.layout, null);
  assert.match(source(kept.html, 2), /^<section data-layout="split-flip">/);
  // under the title and its subtitle, the columns still come first
  assert.equal(insertStarter(DECK, 1, 1, 'columns').index, 2);
});

test('two columns after content that would take a column are refused, and say what to do instead', () => {
  assert.throws(() => insertStarter(DECK, 1, null, 'columns'), (e) => e.status === 409 && /first under the title/.test(e.message) && /select the title/.test(e.message));
});

test('a kind outside the set is a 400, never markup', () => {
  assert.throws(() => insertStarter(DECK, 1, null, 'iframe'), (e) => e.status === 400 && /no kind "iframe"/.test(e.message));
  assert.throws(() => insertStarter(DECK, 1, null, '<script>'), (e) => e.status === 400);
});

test('a slide that follows a slide template takes no starter beside its slots (DESIGN_SYSTEMS)', () => {
  assert.throws(() => insertStarter(DECK, 3, null, 'text'), (e) => e.status === 409 && /"acme\/divider" slide template/.test(e.message) && /slots/.test(e.message));
});

// ── where a new block lands (PRESENTING_EDITING, Adding content) ────────

const SPLIT = `<!doctype html>
<html><body>
  <div class="decklight">
    <section data-layout="split">
      <h2>Before and after</h2>
      <div>
        <h3>Before</h3>
        <ul>
          <li>point</li>
        </ul>
      </div>
      <div>
        <h3>After</h3>
        <ul>
          <li>point</li>
        </ul>
      </div>
      <p>A note under both</p>
      <aside class="notes">talk</aside>
    </section>
    <section data-layout="split">
      <h2>Bare columns</h2>
      <p>The subtitle</p>
      <ul>
        <li>one</li>
        <li>two</li>
      </ul>
      <img src="a.png" alt="a">
    </section>
    <section data-layout="split">
      <h2>One list</h2>
      <ul><li>a</li><li>b</li></ul>
    </section>
    <section data-layout="split"><h2>One line</h2><div><p>x</p></div><div><p>y</p></div></section>
  </div>
</body></html>
`;
const seg = (html, n) => { const { parts, idx } = locateSlide(html, n); return parts[idx]; };
/** The source of slide `n`'s top-level child `i`. */
const child = (html, n, i) => { const s = seg(html, n); const r = sectionChildRanges(s)[i]; return s.slice(r.start, r.end); };

test('a split slide names its two columns; a lone list, a template or no split has none', () => {
  assert.deepEqual(splitColumns(seg(SPLIT, 1)), [1, 2]);
  assert.deepEqual(splitColumns(seg(SPLIT, 2)), [2, 3], 'past the title and its subtitle');
  assert.equal(splitColumns(seg(SPLIT, 3)), null, 'one list splits across CSS columns: no pair');
  assert.equal(splitColumns(seg(DECK, 1)), null);
});

test('with a column selected, Add puts the new block inside it, at its end, and the slide keeps its two columns', () => {
  const out = insertStarter(SPLIT, 1, 1, 'text');
  assert.equal(out.index, 1);
  assert.deepEqual(out.path, [2], 'the column\'s third child');
  assert.equal(out.wrapped, false);
  assert.deepEqual(tags(out.html, 1), ['h2', 'div', 'div', 'p', 'aside'], 'still a pair and a footer');
  assert.equal(child(out.html, 1, 1), [
    '<div>',
    '        <h3>Before</h3>',
    '        <ul>',
    '          <li>point</li>',
    '        </ul>',
    '        <p>New text</p>',
    '      </div>',
  ].join('\n'), 'at the column\'s own indentation');
  assert.equal(insertStarter(SPLIT, 1, 2, 'bullets').index, 2, 'the right column takes it too');
});

test('with a block inside a column selected, the new one goes right after that block', () => {
  const out = insertStarter(SPLIT, 1, 1, 'text', { path: [0] });
  assert.deepEqual(out.path, [1]);
  assert.match(child(out.html, 1, 1), /<h3>Before<\/h3>\n {8}<p>New text<\/p>\n {8}<ul>/);
  // a point of the list selected: after the list, never inside it
  const deep = insertStarter(SPLIT, 1, 2, 'quote', { path: [1, 0] });
  assert.deepEqual(deep.path, [2]);
  assert.match(child(deep.html, 1, 2), /<\/ul>\n {8}<blockquote>/);
});

test('the title selected on a slide with a subtitle: the new block lands after the subtitle, not between them', () => {
  const out = insertStarter(DECK, 1, 0, 'text');
  assert.equal(out.index, 2);
  assert.deepEqual(tags(out.html, 1), ['h2', 'p', 'p', 'ul', 'aside']);
  assert.match(source(out.html, 1), /<h2>Alpha<\/h2>\n {6}<p>Intro<\/p>\n {6}<p>New text<\/p>/);
  // no subtitle: right after the title, as before
  assert.equal(insertStarter(DECK, 2, 0, 'text').index, 1);
});

test('the header of a split slide selected: the new block goes first in the left column, so the pair stays a pair', () => {
  const out = insertStarter(SPLIT, 1, 0, 'heading');
  assert.equal(out.index, 1);
  assert.deepEqual(out.path, [0]);
  assert.match(child(out.html, 1, 1), /^<div>\n {8}<h3>Heading<\/h3>\n {8}<h3>Before<\/h3>/);
  assert.deepEqual(tags(out.html, 1), ['h2', 'div', 'div', 'p', 'aside']);
});

test('a column that is one bare block is wrapped in a .column in the same write, and keeps every byte of its own', () => {
  const list = insertStarter(SPLIT, 2, 2, 'text');
  assert.equal(list.wrapped, true);
  assert.deepEqual(list.path, [1]);
  assert.deepEqual(tags(list.html, 2), ['h2', 'p', 'div', 'img']);
  assert.equal(child(list.html, 2, 2), [
    '<div class="column">',
    '        <ul>',
    '          <li>one</li>',
    '          <li>two</li>',
    '        </ul>',
    '        <p>New text</p>',
    '      </div>',
  ].join('\n'));
  const pic = insertStarter(SPLIT, 2, 3, 'text', { path: [] });
  assert.equal(child(pic.html, 2, 3), '<div class="column">\n        <img src="a.png" alt="a">\n        <p>New text</p>\n      </div>');
  // a column the editor wrapped is a wrapper the next add goes into, not wrapped again
  const again = insertStarter(pic.html, 2, 3, 'quote');
  assert.equal(again.wrapped, false);
  assert.deepEqual(again.path, [2]);
  // a chart is a block of its own, not a wrapper: wrapped too
  const chart = SPLIT.replace('<img src="a.png" alt="a">', '<div class="chart" data-chart="bar"><script type="application/json">{}</script></div>');
  assert.equal(insertStarter(chart, 2, 3, 'text').wrapped, true);
});

test('the footer selected, or a slide written on one line, still land where they should', () => {
  const footer = insertStarter(SPLIT, 1, 3, 'text');
  assert.equal(footer.index, 4);
  assert.deepEqual(footer.path, []);
  const line = insertStarter(SPLIT, 4, 2, 'text');
  assert.equal(child(line.html, 4, 2), '<div><p>y</p><p>New text</p></div>');
});

test('Add › Two columns with a column selected is refused with a sentence; under the title it still goes first', () => {
  assert.throws(() => insertStarter(SPLIT, 1, 1, 'columns'), (e) => e.status === 409 && /do not go inside a column/.test(e.message) && /New slide/.test(e.message));
  assert.throws(() => insertStarter(SPLIT, 1, 2, 'columns', { path: [0] }), (e) => e.status === 409);
  assert.equal(insertStarter(DECK, 1, 0, 'columns').index, 2, 'title selected, subtitle kept: under both');
});

test('a picture follows the same rule as Add, and so does whatever the next one is', () => {
  const pic = '<img src="b.png" alt="b">';
  assert.deepEqual(insertBlock(SPLIT, 1, 1, pic).path, [2]);
  assert.deepEqual(insertBlock(SPLIT, 1, 1, pic, { path: [0] }).path, [1]);
  assert.deepEqual(insertBlock(SPLIT, 1, null, pic).path, [], 'nothing selected: after the content, as before');
  assert.deepEqual(whereNewBlockLands(seg(SPLIT, 1), 3), { index: 3 });
});

test('insertInElement puts a child first, after another, or into an empty element on a line of its own', () => {
  const empty = SPLIT.replace('<div>\n        <h3>After</h3>\n        <ul>\n          <li>point</li>\n        </ul>\n      </div>', '<div>\n      </div>');
  assert.equal(child(insertInElement(empty, 1, 2, { markup: '<p>x</p>' }).html, 1, 2), '<div>\n        <p>x</p>\n      </div>');
  const flat = SPLIT.replace('<div>\n        <h3>After</h3>\n        <ul>\n          <li>point</li>\n        </ul>\n      </div>', '<div></div>');
  assert.equal(child(insertInElement(flat, 1, 2, { markup: '<p>x</p>' }).html, 1, 2), '<div>\n        <p>x</p>\n      </div>');
  const first = insertInElement(SPLIT, 1, 1, { markup: '<p>x</p>', after: -1 });
  assert.deepEqual(first.path, [0]);
  assert.match(child(first.html, 1, 1), /^<div>\n {8}<p>x<\/p>\n {8}<h3>Before/);
  assert.throws(() => insertInElement(SPLIT, 2, 3, { markup: '<p>x</p>' }), /nothing can go inside/);
  assert.equal(child(wrapInDiv(SPLIT, 2, 3), 2, 3), '<div class="column">\n        <img src="a.png" alt="a">\n      </div>');
});

test('duplicating a column is refused with a sentence; what is inside one still duplicates', () => {
  assert.throws(() => duplicateSlideElement(SPLIT, 1, 1), (e) => e.code === 'REFUSED' && /would make a third/.test(e.message));
  assert.throws(() => duplicateSlideElement(SPLIT, 1, 2, { tag: 'div' }), (e) => e.code === 'REFUSED');
  const inner = duplicateSlideElement(SPLIT, 1, 1, { path: [0], tag: 'h3' });
  assert.deepEqual(inner.path, [1]);
  assert.equal(duplicateSlideElement(SPLIT, 1, 3).index, 4, 'the footer is not a column');
});

test('the insert and image routes take a path and answer where the new block is', async (t) => {
  const { routes, readDeck, history } = harness(t, SPLIT);
  const r = await call(routes, 'POST /deck/edit/element/insert', { slide: 1, index: 1, path: [0], kind: 'text', quiet: true });
  assert.equal(r.code, 200);
  assert.equal(r.body.index, 1);
  assert.deepEqual(r.body.path, [1]);
  assert.equal(r.body.wrapped, undefined);
  const bare = await call(routes, 'POST /deck/edit/element/insert', { slide: 2, index: 2, kind: 'text' });
  assert.equal(bare.body.wrapped, true, 'the page is told, so it reloads rather than guess');
  assert.equal(history.counts().undo, 2, 'the wrapper and the block are one undo entry');
  const before = readDeck();
  const refused = await call(routes, 'POST /deck/edit/element/insert', { slide: 1, index: 1, kind: 'columns' });
  assert.equal(refused.code, 409);
  assert.equal(readDeck(), before, 'refused: nothing written');
  const pic = await call(routes, 'POST /deck/edit/element/image', { slide: 1, index: 2, path: [0], src: 'assets/b.png', alt: 'b' });
  assert.equal(pic.code, 200);
  assert.equal(pic.body.index, 2);
  assert.deepEqual(pic.body.path, [1], 'a picture dropped on the right column\'s heading goes in after it');
  assert.match(child(readDeck(), 1, 2), /<h3>After<\/h3>\n {8}<img src="assets\/b.png" alt="b">/);
});

// ── words pasted from another app (PRESENTING_EDITING, the clipboard) ────

test('pasted words become a paragraph or a list the server builds, placed by the rule every add follows', () => {
  const p = insertStarter(DECK, 2, 0, 'text', { words: ['Some <strong>pasted</strong> words'] });
  assert.equal(p.markup, '<p>Some <strong>pasted</strong> words</p>');
  assert.equal(p.index, 1);
  const list = insertStarter(SPLIT, 1, 1, 'bullets', { words: ['one', 'two <em>2</em>'] });
  assert.equal(list.markup, '<ul>\n  <li>one</li>\n  <li>two <em>2</em></li>\n</ul>');
  assert.deepEqual(list.path, [2], 'a column selected: inside it, as Add lands');
  assert.match(insertStarter(DECK, 2, 0, 'numbered', { words: ['a', 'b'] }).markup, /^<ol>\n {2}<li>a<\/li>/);
});

test('pasted words are words and the editor\'s emphasis only: anything else is a 400, never written', () => {
  for (const bad of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:alert(1)">x</a>', '<a href="javascript&#58;x">x</a>',
    '<strong onclick="x">b</strong>', '<span style="color:red">x</span>', 'a < b', '<strong>open', '<em><strong>x</em></strong>', 'two\nlines', '']) {
    assert.throws(() => inlineWords(bad), (e) => e.status === 400, bad);
  }
  for (const good of ['plain', 'a &lt; b &amp; c', 'x<sup>2</sup> H<sub>2</sub>O <mark>m</mark> <s>s</s> <code>c</code>',
    '<a href="https://e.io/?a=1&amp;b">web</a> <a href="mailto:a@b.c">mail</a> <a href="#/3">slide</a> <a href="notes.html">file</a>']) {
    assert.equal(inlineWords(good), good);
  }
  assert.throws(() => insertStarter(DECK, 2, 0, 'text', { words: ['one', 'two'] }), (e) => e.status === 400 && /one line/.test(e.message));
  assert.throws(() => insertStarter(DECK, 2, 0, 'table', { words: ['x'] }), (e) => e.status === 400);
  assert.throws(() => insertStarter(DECK, 2, 0, 'bullets', { words: [] }), (e) => e.status === 400);
  assert.throws(() => insertStarter(DECK, 3, null, 'text', { words: ['x'] }), (e) => e.status === 409, 'a template slide takes nothing beside its slots');
});

test('the insert route takes pasted words, and refuses words that are not strings', async (t) => {
  const { routes, readDeck } = harness(t);
  const r = await call(routes, 'POST /deck/edit/element/insert', { slide: 2, index: 0, kind: 'bullets', words: ['first', 'second'], quiet: true });
  assert.equal(r.code, 200);
  assert.match(readDeck(), /<h2>Beta<\/h2>\n {6}<ul>\n {8}<li>first<\/li>\n {8}<li>second<\/li>\n {6}<\/ul>/);
  const before = readDeck();
  assert.equal((await call(routes, 'POST /deck/edit/element/insert', { slide: 2, index: 0, kind: 'text', words: [{ x: 1 }] })).code, 400);
  assert.equal((await call(routes, 'POST /deck/edit/element/insert', { slide: 2, index: 0, kind: 'text', words: ['<script>x</script>'] })).code, 400);
  assert.equal(readDeck(), before, 'nothing written');
});

// ── new slides of a kind ────────────────────────────────────────────────

test('each slide kind is a section that lands level with its neighbours, its title placeholder first', () => {
  for (const kind of SLIDE_KINDS) {
    const html = insertSlideOfKind(DECK, 1, kind);
    assert.equal(sectionBodies(html).length, 5, kind);
    const sec = source(html, 2);
    assert.match(sec, /^<section[^>]*>\n {6}</, `${kind}: indented like the others`);
    assert.match(sec, /\n {6}<aside class="notes"><\/aside>\n {4}<\/section>$/, `${kind}: with notes, closed at the base`);
    assert.doesNotMatch(sec, /[ \t]\n/, `${kind}: no line ends in spaces nobody typed`);
    if (kind !== 'blank') assert.match(sec, /^<section[^>]*>\n\s*<h[12]>(Slide title|Section title)<\/h[12]>/, `${kind}: the title comes first`);
  }
  assert.match(slideStarter('columns'), /^<section data-layout="split">[\s\S]*<div>[\s\S]*<div>/);
  assert.match(slideStarter('section'), /<h1>Section title<\/h1>\n {2}<p>/);
  assert.doesNotMatch(slideStarter('blank'), /<h[12]/, 'blank is blank');
  assert.throws(() => insertSlideOfKind(DECK, 1, 'poster'), (e) => e.status === 400);
});

// ── the routes ──────────────────────────────────────────────────────────

function harness(t, html = DECK, deps = {}) {
  const dir = tmp('add-content', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, html);
  const history = createHistory();
  const readDeck = () => readFileSync(deck, 'utf8');
  const applyEdit = (change, before = readDeck()) => {
    const next = typeof change === 'function' ? change(before) : change;
    if (next === before) return false;
    history.record(before);
    writeFileSync(deck, next);
    return true;
  };
  const routes = new Map();
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: deck, ...deps });
  return { routes, history, readDeck };
}
async function call(routes, key, body) {
  const sent = {};
  await routes.get(key)({ req: {}, res: {}, url: new URL(`http://x${key.split(' ')[1]}`), body: JSON.stringify(body), json: (code, obj) => { sent.code = code; sent.body = obj; }, CORS: {} });
  return sent;
}

test('POST /deck/edit/element/insert writes one starter as one undo entry and answers its index and markup', async (t) => {
  const quiet = [];
  const told = [];
  const { routes, readDeck, history } = harness(t, DECK, { quiet: (h) => quiet.push(h), broadcast: (event, data) => told.push({ event, data }) });
  const r = await call(routes, 'POST /deck/edit/element/insert', { slide: 1, index: 1, kind: 'bullets', quiet: true, from: 'page-a' });
  assert.equal(r.code, 200);
  assert.equal(r.body.index, 2);
  assert.deepEqual(r.body.path, []);
  assert.equal(r.body.inPlace, true);
  assert.match(r.body.html, /^<ul>/);
  assert.deepEqual(tags(readDeck(), 1), ['h2', 'p', 'ul', 'ul', 'aside']);
  assert.equal(history.counts().undo, 1, 'one undo entry');
  assert.equal(quiet.at(-1), readDeck(), 'quiet: the watcher skips what this write put there');
  assert.deepEqual(told.at(-1), { event: 'content', data: { slide: 1, index: 2, from: 'page-a' } });
  // two columns and their layout are ONE entry, and the answer names the layout
  const cols = await call(routes, 'POST /deck/edit/element/insert', { slide: 2, index: null, kind: 'columns' });
  assert.equal(cols.body.layout, 'split');
  assert.equal(cols.body.count, 2);
  assert.equal(history.counts().undo, 2);
  assert.equal(quiet.length, 1, 'not asked for in place: the reload it always was');
});

test('the insert route refuses what it cannot honestly write, with a sentence', async (t) => {
  const { routes, readDeck } = harness(t);
  const before = readDeck();
  for (const body of [{ slide: 0, kind: 'text' }, { slide: 1, index: -1, kind: 'text' }, { slide: 1, index: 1.5, kind: 'text' }, { slide: 1 },
    { slide: 1, index: 1, path: 'x', kind: 'text' }, { slide: 1, index: 1, path: [-1], kind: 'text' }]) {
    assert.equal((await call(routes, 'POST /deck/edit/element/insert', body)).code, 400, JSON.stringify(body));
  }
  const unknown = await call(routes, 'POST /deck/edit/element/insert', { slide: 1, index: null, kind: 'marquee' });
  assert.equal(unknown.code, 400);
  assert.match(unknown.body.error, /no kind "marquee"/);
  const templated = await call(routes, 'POST /deck/edit/element/insert', { slide: 3, index: null, kind: 'heading' });
  assert.equal(templated.code, 409);
  assert.match(templated.body.error, /slide template/);
  assert.equal((await call(routes, 'POST /deck/edit/element/insert', { slide: 9, index: null, kind: 'text' })).code, 404);
  assert.equal((await call(routes, 'POST /deck/edit/element/insert', { slide: 1, index: 9, kind: 'text' })).code, 404);
  assert.equal(readDeck(), before, 'nothing written by any of them');
});

test('POST /deck/edit/slide op new takes a kind from a closed set; no kind is the blank slide it always was', async (t) => {
  const { routes, readDeck } = harness(t);
  const r = await call(routes, 'POST /deck/edit/slide', { op: 'new', slide: 1, kind: 'columns', quiet: true });
  assert.equal(r.code, 200);
  assert.equal(r.body.slide, 2);
  assert.match(r.body.section, /^<section data-layout="split">\n\s*<h2>Slide title<\/h2>/, 'the new slide as the file has it, for the page to put in');
  assert.match(source(readDeck(), 2), /^<section data-layout="split">/);
  const plain = await call(routes, 'POST /deck/edit/slide', { op: 'new', slide: 1 });
  assert.equal(plain.code, 200);
  assert.match(source(readDeck(), 2), /<h2>New slide<\/h2>/);
  const bad = await call(routes, 'POST /deck/edit/slide', { op: 'new', slide: 1, kind: 'poster' });
  assert.equal(bad.code, 400);
  assert.match(bad.body.error, /no slide kind "poster"/);
  assert.equal((await call(routes, 'POST /deck/edit/slide', { op: 'duplicate', slide: 1, kind: 'text' })).code, 400, 'only a new slide has a kind');
});
