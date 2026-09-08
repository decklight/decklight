// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Taking slides from a deck template (UNITS#REST) — the pure half: reading a
// template as a numbered list, and splicing chosen sections into a deck that
// already exists. Both are string surgery on somebody's file, so both are
// tested against the shapes a real deck takes rather than a tidy fixture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { templateSlides, parseSlideSpec, externalRefs } from '../tools/template-slides.mjs';
import { insertSectionsAfter, reindentSection, sectionCloseIndex } from '../tools/deck-html.mjs';

const TEMPLATE = `<!doctype html><html><body>
<div class="decklight">
  <section>
    <h1>Startup pitch</h1>
  </section>
  <section data-hidden>
    <h2>Backup: unit economics</h2>
    <img src="assets/chart.png">
  </section>
  <section>
    <h2>The demo</h2>
    <div class="terminal" data-cast="casts/demo.cast"></div>
    <img src="data:image/png;base64,AAA" alt="logo">
    <a href="https://example.com">more</a>
  </section>
</div>
</body></html>`;

const DECK = `<!doctype html><html><body>
<div class="decklight">
  <section>
    <h2>Mine one</h2>
  </section>
  <section>
    <h2>Mine two</h2>
  </section>
</div>
</body></html>`;

test('a template reads as a numbered list, with the heading each slide shows', () => {
  const slides = templateSlides(TEMPLATE);
  assert.deepEqual(slides.map((s) => [s.n, s.title, s.hidden]), [
    [1, 'Startup pitch', false],
    [2, 'Backup: unit economics', true],
    [3, 'The demo', false],
  ]);
  // `html` is the whole section, open tag included, ready to paste elsewhere
  assert.match(slides[1].html, /^<section data-hidden>/);
  assert.match(slides[1].html, /<\/section>$/);
});

test('what a slide points at that another deck will not have is named — and only that', () => {
  const slides = templateSlides(TEMPLATE);
  assert.deepEqual(slides[0].needs, [], 'a slide of markup needs nothing');
  assert.deepEqual(slides[1].needs, ['assets/chart.png']);
  // a data: image travels with the markup, and so does a link to the web:
  // neither is a file the new deck has to have
  assert.deepEqual(slides[2].needs, ['casts/demo.cast']);
  assert.deepEqual(externalRefs('<section><img src="data:image/png;base64,A"><a href="#next">x</a></section>'), []);
});

test('a slide TEACHING markup is not flagged for the markup it teaches', () => {
  // Found by running this against the first real template: a slide whose code
  // sample shows a deck's <link> tags was reported as needing two files it
  // merely talks about. Only the angle brackets of a sample are escaped, so
  // `href="…"` sits there as literal text for any attribute scan to find.
  const teaching = `<section>
    <h2>A deck is one HTML file</h2>
    <pre data-lines="1-4"><code class="language-html">&lt;head&gt;
  &lt;link rel="stylesheet" href="decklight/dist/decklight.css"&gt;
  &lt;img src="assets/logo.png"&gt;
&lt;/head&gt;</code></pre>
  </section>`;
  assert.deepEqual(externalRefs(teaching), [], 'a sample is text, not a reference');

  // …and the open tag still counts, because that is where a real one lives
  assert.deepEqual(
    externalRefs('<section><pre class="terminal" data-cast="casts/demo.cast">x</pre></section>'),
    ['casts/demo.cast'],
  );
  // a script's contents are machinery, and a chart's JSON is not markup
  assert.deepEqual(
    externalRefs('<section><script type="application/json">{"labels":["<img src=\'a.png\'>"]}<\/script></section>'),
    [],
  );
  // the thing itself, outside any sample, is still named
  assert.deepEqual(externalRefs('<section><img src="assets/x.png"><pre><code>nothing</code></pre></section>'),
    ['assets/x.png']);
});

test('a slide spec names slides, and refuses one the template does not have', () => {
  assert.deepEqual(parseSlideSpec('2,5-7', 8), [2, 5, 6, 7]);
  assert.deepEqual(parseSlideSpec('3,1,3', 3), [1, 3], 'sorted, and each slide once');
  assert.throws(() => parseSlideSpec('4', 3), /no slide 4 in this template \(it has 3\)/);
  assert.throws(() => parseSlideSpec('2-9', 3), /no slides 2-9/);
  assert.throws(() => parseSlideSpec('two', 3), /not a slide or a range: "two"/);
  assert.throws(() => parseSlideSpec('', 3), /no slides named/);
});

test('a section lands after the slide you were on, at the deck’s own indentation', () => {
  const [, , demo] = templateSlides(TEMPLATE);
  const out = insertSectionsAfter(DECK, 1, [demo.html]);
  const order = [...out.matchAll(/<h[12]>([^<]+)<\/h[12]>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['Mine one', 'The demo', 'Mine two']);
  assert.match(out, /\n  <section>\n    <h2>The demo<\/h2>/, 'two spaces, like the sections around it');
  // the inserted slide brings its own <div>, so counting those proves nothing:
  // what matters is that the deck still ends the way it started
  assert.equal((out.match(/class="decklight"/g) || []).length, 1);
  assert.ok(out.endsWith('</div>\n</body></html>'), 'the deck’s tail is untouched');
});

test('after 0 puts them first, and after the last slide appends', () => {
  const [title] = templateSlides(TEMPLATE);
  const first = insertSectionsAfter(DECK, 0, [title.html]);
  assert.deepEqual([...first.matchAll(/<h[12]>([^<]+)<\/h[12]>/g)].map((m) => m[1]),
    ['Startup pitch', 'Mine one', 'Mine two']);

  const last = insertSectionsAfter(DECK, 2, [title.html]);
  assert.deepEqual([...last.matchAll(/<h[12]>([^<]+)<\/h[12]>/g)].map((m) => m[1]),
    ['Mine one', 'Mine two', 'Startup pitch']);
  assert.match(last, /<\/section>\n  <section>\n    <h1>Startup pitch<\/h1>\n  <\/section>\n<\/div>/,
    'appended inside the deck container, not after it');
});

test('a slide that SHOWS markup does not end the section early', () => {
  // The trap `sectionCloseIndex` exists for: a deck teaching decklight carries
  // `</section>` as text, and the last slide's piece carries the whole tail of
  // the document. Neither end of the string is a reliable answer on its own.
  const showing = `<!doctype html><body><div class="decklight">
  <section>
    <pre><code>&lt;section&gt;…&lt;/section&gt;</code></pre>
    <script type="application/json">{"note":"</section>"}<\/script>
  </section>
  <section><h2>Next</h2></section>
</div></body>`;
  const out = insertSectionsAfter(showing, 1, ['<section><h2>New</h2></section>']);
  assert.deepEqual([...out.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]), ['New', 'Next']);
  assert.ok(out.includes('{"note":"</section>"}'), 'the sample is still in the slide it belonged to');

  assert.equal(sectionCloseIndex('<script>"</section>"<\/script> x </section> tail'),
    ' x '.length + '<script>"</section>"<\/script>'.length,
    'a script body is not where a section ends');
});

test('nothing to insert changes nothing; a deck with no slides refuses', () => {
  assert.equal(insertSectionsAfter(DECK, 1, []), DECK);
  assert.equal(insertSectionsAfter(DECK, 1, ['   ']), DECK);
  assert.throws(() => insertSectionsAfter('<html><body>no slides</body></html>', 0, ['<section>x</section>']),
    /no slides to insert beside/);
});

test('re-indenting shifts every line by the same amount, and leaves the shape', () => {
  const sec = '      <section>\n        <h2>Deep</h2>\n          <p>deeper</p>\n      </section>';
  assert.equal(reindentSection(sec, '  '),
    '  <section>\n    <h2>Deep</h2>\n      <p>deeper</p>\n  </section>');
});
