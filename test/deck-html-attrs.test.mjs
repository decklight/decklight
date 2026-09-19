// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The open-tag string primitives of tools/deck-html.mjs. test/deck-html.test.mjs
// covers sectionChildRanges — the child walker — and leaves the layer under it
// untested, which is the layer every file-side edit of a slide passes through:
// setSectionAttrs is splitOpenTag → readAttrs → writeAttrs, and a slide's open
// tag carries data-hidden and data-layout (SPEC DECK_ANATOMY), so a quoted `>`
// misread here silently rewrites the wrong bytes of somebody's deck. The same
// goes for the three consumers pinned alongside it: injectBeforeBodyEnd (what
// bundling and shot inject through), and cleanNotes / NOTES_ASIDE, which are
// how a tool reading the FILE sees the speaker notes the runtime gets free from
// textContent (SPEC PRESENTING).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readAttrs, writeAttrs, splitOpenTag, injectBeforeBodyEnd, cleanNotes, NOTES_ASIDE,
  sectionBodies, slideHeading, slideRange,
  insertBlankSlide, duplicateSlide, deleteSlide, swapSlides, insertImage,
} from '../tools/deck-html.mjs';

// ── splitOpenTag ───────────────────────────────────────────────────────────

test('a `>` inside a quoted attribute value does not end the open tag', () => {
  const body = ' data-note="a > b" class="x">inner<p>1 &gt; 0</p></section>';
  const { attrs, close, rest } = splitOpenTag(body);
  assert.equal(attrs, ' data-note="a > b" class="x"',
    'ending the tag at the first `>` would put half an attribute into the slide\'s content');
  assert.equal(close, '>');
  assert.equal(rest, 'inner<p>1 &gt; 0</p></section>');
});

test('single quotes close a value just as double quotes do', () => {
  const { attrs, rest } = splitOpenTag(" data-note='a > b'>inner");
  assert.equal(attrs, " data-note='a > b'");
  assert.equal(rest, 'inner');
});

test('a self-closing section keeps its slash in the close, not in the attributes', () => {
  const { attrs, close, rest } = splitOpenTag(' id="a"/>rest');
  assert.equal(attrs, ' id="a"', 'the slash is punctuation, and readAttrs must not see it as a value');
  assert.equal(close, '/>');
  assert.equal(rest, 'rest');
});

test('a tag with no attributes splits into nothing and everything', () => {
  assert.deepEqual(splitOpenTag('>just the body'), { attrs: '', close: '>', rest: 'just the body' });
});

test('an unterminated open tag is all body and no attributes', () => {
  assert.deepEqual(splitOpenTag('no closing angle bracket'),
    { attrs: '', close: '>', rest: 'no closing angle bracket' },
    'a half-typed tag must not make the rewriter invent an attribute list');
});

test('splitOpenTag coerces rather than throwing on nothing at all', () => {
  assert.deepEqual(splitOpenTag(undefined), { attrs: '', close: '>', rest: '' });
});

// ── readAttrs / writeAttrs ─────────────────────────────────────────────────

test('a bare attribute reads as the empty string and is written back bare', () => {
  const attrs = readAttrs(' class="a" data-hidden data-layout=split');
  assert.deepEqual(attrs, { class: 'a', 'data-hidden': '', 'data-layout': 'split' },
    'data-hidden is a flag: giving it a value would change what isHiddenSection sees');
  assert.equal(writeAttrs(attrs), ' class="a" data-hidden data-layout="split"',
    'the flag stays a flag, and an unquoted value comes back quoted');
});

test('attribute names are lower-cased, as an HTML parser would read them', () => {
  assert.deepEqual(readAttrs(' CLASS="a" Data-Layout="split"'), { class: 'a', 'data-layout': 'split' },
    'a deck typed in mixed case must still match the names the tools look for');
});

test('an empty or missing attribute list is an empty set, not a crash', () => {
  assert.deepEqual(readAttrs(''), {});
  assert.deepEqual(readAttrs('   '), {});
  assert.deepEqual(readAttrs(null), {});
  assert.equal(writeAttrs({}), '');
});

test('a value carrying a double quote is escaped on the way out and is stable thereafter', () => {
  // The pair works on RAW SOURCE, not on decoded text: readAttrs hands back
  // what the file literally says, and writeAttrs re-encodes anything that
  // would otherwise close its own quote. So a value picked up from a
  // single-quoted attribute comes back double-quoted and entity-escaped —
  // different bytes, the same attribute once a parser reads it — and a second
  // pass is byte-identical, which is what makes repeated edits of one slide
  // safe.
  const fromSource = readAttrs(" title='say \"hi\"'");
  assert.deepEqual(fromSource, { title: 'say "hi"' });

  const written = writeAttrs(fromSource);
  assert.equal(written, ' title="say &quot;hi&quot;"',
    'an unescaped quote here would end the attribute and corrupt the tag');

  const again = readAttrs(written);
  assert.deepEqual(again, { title: 'say &quot;hi&quot;' },
    'readAttrs does not decode entities — the entity IS the file\'s spelling of that character');
  assert.equal(writeAttrs(again), written,
    'and so the round trip is a fixed point: editing a slide twice does not double-escape it');
});

test('unicode and emoji in a value survive both directions untouched', () => {
  const attrs = { 'data-title': 'Café — 90 % 😀 ünïcødé', class: 'ok' };
  const round = readAttrs(writeAttrs(attrs));
  assert.deepEqual(round, attrs, 'nothing here needs escaping, so nothing here may be changed');
  assert.deepEqual(readAttrs(' data-title="Café — 😀">'), { 'data-title': 'Café — 😀' },
    'read straight out of a UTF-8 deck, too');
});

test('the whole open tag round-trips through read and write', () => {
  const src = ' class="lead big" data-hidden data-layout="split" data-build="fade"';
  assert.equal(writeAttrs(readAttrs(src)), src,
    'setSectionAttrs rewrites every tag it touches — an unchanged slide must come out unchanged');
});

// ── injectBeforeBodyEnd ────────────────────────────────────────────────────

test('the injection goes before the LAST </body>, not the first', () => {
  // A bundled deck inlines the runtime, whose speaker-view popup template
  // carries a literal </body> as a string.
  const html = '<body><p>slide</p><script>const tpl = "</body>";</script></body>';
  const out = injectBeforeBodyEnd(html, '<i>added</i>');
  assert.equal(out, '<body><p>slide</p><script>const tpl = "</body>";</script><i>added</i></body>',
    'splitting at the first match would cut the inlined runtime in half mid-string');
});

test('the closing tag is found whatever case it is written in', () => {
  assert.equal(injectBeforeBodyEnd('<BODY>x</BODY>', '<i>'), '<BODY>x<i></BODY>',
    'a hand-written deck is not obliged to lower-case its tags');
});

test('a document with no </body> returns null rather than a guess', () => {
  assert.equal(injectBeforeBodyEnd('<div>a fragment, not a document</div>', '<i>'), null,
    'each caller picks its own fallback from this — bundle fails, shot appends');
});

// Was a bug: injectBeforeBodyEnd takes lastIndexOf on html.toLowerCase() and
// slices the ORIGINAL at that index; a character whose lower case is longer
// than itself (U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE lower-cases to two
// code units) shifts every later index, so the fragment is spliced one
// character inside the closing tag and the document is corrupted
test('injecting into a deck whose tail is Turkish lands before the closing tag', () => {
  const html = '<body><p>İstanbul</p></body>';
  assert.equal(injectBeforeBodyEnd(html, '<i>'), '<body><p>İstanbul</p><i></body>',
    'the fragment must land between the content and the closing tag, whatever the text says');
});

// ── cleanNotes ─────────────────────────────────────────────────────────────

test('notes come out as plain text: tags gone, whitespace flat', () => {
  assert.equal(cleanNotes('<p>Hello <b>world</b></p>\n  <p>second</p>'), 'Hello world second',
    'a tool reading the file has to see exactly what textContent gives the runtime');
});

test('a tag is replaced by a space, so two lines never run into one word', () => {
  assert.equal(cleanNotes('<p>one</p><p>two</p>'), 'one two',
    'stripping to nothing would hand the voice "onetwo"');
});

test('the ⟨CLICK⟩ marker is punctuation, not something to read aloud', () => {
  assert.equal(cleanNotes('first beat ⟨CLICK⟩ second beat'), 'first beat second beat');
});

test('⟨PAUSE⟩ is not read aloud either — unless the caller keeps it as the hold it is (#560)', () => {
  assert.equal(cleanNotes('<p>Look.</p><p>⟨PAUSE⟩</p><p>Now.</p>'), 'Look. Now.');
  // kept, it is spaced as a word of its own however it was written
  assert.equal(cleanNotes('<p>Look.⟨PAUSE⟩</p><p>Now.</p>', { pauses: true }), 'Look. ⟨PAUSE⟩ Now.');
  assert.equal(cleanNotes('Look.⟨PAUSE⟩Now.', { pauses: true }), 'Look. ⟨PAUSE⟩ Now.');
});

test('the three entities a note can actually contain are decoded', () => {
  assert.equal(cleanNotes('a &lt;b&gt; and &amp; too'), 'a <b> and & too',
    'tags are stripped before entities are decoded, so escaped markup survives as text');
  assert.equal(cleanNotes('&amp;lt;'), '&lt;',
    'ampersand last: one level of decoding, exactly like a parser');
});

test('entities beyond those three are left as written', () => {
  // Pinned as it behaves. The set matches what the deck writer emits
  // (escapeHtml writes &amp; &lt; &gt;), so anything else in a note was typed
  // by hand and is not this tool's to guess at.
  assert.equal(cleanNotes('&quot;hi&quot; &#39;x&#39; &nbsp;'), '&quot;hi&quot; &#39;x&#39; &nbsp;');
});

test('nothing at all cleans to the empty string', () => {
  assert.equal(cleanNotes(null), '');
  assert.equal(cleanNotes('  \n  '), '');
});

// ── NOTES_ASIDE ────────────────────────────────────────────────────────────

test('the notes aside matches across lines, capturing its inner HTML', () => {
  const section = [
    '<section>',
    '  <h2>Title</h2>',
    '  <aside class="notes">',
    '    first line',
    '    <b>second</b> line',
    '  </aside>',
    '</section>',
  ].join('\n');
  const m = NOTES_ASIDE.exec(section);
  assert.ok(m, 'notes are written over several lines far more often than on one');
  assert.match(m[1], /first line/);
  assert.match(m[1], /<b>second<\/b> line/, 'group 1 is inner HTML — voiceover cleans it, edit replaces it');
  assert.ok(m[0].startsWith('<aside class="notes">') && m[0].endsWith('</aside>'),
    'the whole match is the element, which is what a rewrite swaps out');
});

test('two asides in one deck do not merge into one match', () => {
  const html = '<aside class="notes">first</aside><aside class="notes">second</aside>';
  const m = NOTES_ASIDE.exec(html);
  assert.equal(m[1], 'first', 'a greedy match would swallow the next slide\'s notes as well');
  assert.equal(m[0], '<aside class="notes">first</aside>');
  assert.equal(NOTES_ASIDE.exec(html)[1], 'first',
    'and the regex is not /g, so a second call starts over rather than continuing');
});

test('only the canonical spelling counts as a notes aside', () => {
  assert.equal(NOTES_ASIDE.exec('<aside>just an aside</aside>'), null,
    'an aside is a layout element too; notes are the ones the deck writer marked');
  assert.equal(NOTES_ASIDE.exec('<aside class="notes fragment">x</aside>'), null,
    'pinned as it behaves: the pattern is the exact tag decklight itself writes');
});

// ── whole-slide operations: new · duplicate · delete · reorder ─────────────
// The slide bar's verbs, as string surgery on the deck FILE. The assertion
// that matters in all of them is the same one: everything that was not the
// slide being moved comes out byte for byte — the head, the runtime script
// tags, the closing `</html>`, and the sections either side. A deck is a text
// file people diff, and an op that reflowed the document would make every
// reorder a review nobody can read.

const DECK = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '  <meta charset="utf-8">',
  '  <link rel="stylesheet" href="decklight/dist/decklight.css">',
  '</head>',
  '<body>',
  '  <div class="decklight">',
  '    <section>',
  '      <h2>Alpha</h2>',
  '      <aside class="notes">one</aside>',
  '    </section>',
  '    <section data-layout="centered">',
  '      <h2>Beta</h2>',
  '    </section>',
  '    <section>',
  '      <h2>Gamma</h2>',
  '    </section>',
  '  </div>',
  '  <script src="decklight/dist/decklight.js"></script>',
  '  <script>Decklight.init();</script>',
  '</body>',
  '</html>',
  '',
].join('\n');

/** Slide `n`'s source exactly as it sits in `html`. */
const source = (html, n) => {
  const { start, end } = slideRange(html, n);
  return html.slice(start, end);
};
/** Every slide's title, in source order — the deck's running order. */
const running = (html) => sectionBodies(html).map((b, i) => slideHeading(b, i));
/** Everything before the first slide, and everything after the last one. */
const head = (html) => html.slice(0, html.indexOf('<section'));
const tail = (html) => html.slice(html.lastIndexOf('</section>') + '</section>'.length);

test('every slide op leaves the head, the runtime scripts and the closing tag exactly where they were', () => {
  for (const [what, out] of [
    ['new', insertBlankSlide(DECK, 2)],
    ['duplicate', duplicateSlide(DECK, 2)],
    ['delete', deleteSlide(DECK, 2)],
    ['up', swapSlides(DECK, 1, 2)],
    ['down', swapSlides(DECK, 2, 3)],
  ]) {
    assert.equal(head(out), head(DECK), `${what} rewrote the deck's head`);
    assert.equal(tail(out), tail(DECK), `${what} moved the runtime script or the closing </html>`);
  }
});

test('a new slide arrives blank and indented level with its neighbours', () => {
  const out = insertBlankSlide(DECK, 1);
  assert.deepEqual(running(out), ['Alpha', 'New slide', 'Beta', 'Gamma'],
    'the blank slide goes in AFTER the one it was asked for, not before it');
  assert.equal(source(out, 2), [
    '<section>',
    '      <h2>New slide</h2>',
    '      <p>Say something here.</p>',
    '      <aside class="notes"></aside>',
    '    </section>',
  ].join('\n'), 'a block four spaces out of step is a diff nobody can review');
  assert.ok(out.includes('\n    <section>\n      <h2>New slide</h2>'),
    'the opening tag sits on its own line at the sections\' own indentation');
  assert.equal(source(out, 1), source(DECK, 1), 'the slide it was inserted after must not be touched');
  assert.equal(source(out, 4), source(DECK, 3), 'nor the ones after it');
});

test('a deck whose sections sit at the left margin gets its blank slide there too', () => {
  // The indentation is READ, never assumed: an init-scaffolded deck nests its
  // sections inside <div class="decklight">, a hand-written one need not.
  const flat = '<body>\n<section>\n<h2>One</h2>\n</section>\n</body>\n';
  const out = insertBlankSlide(flat, 1);
  assert.ok(out.includes('\n<section>\n  <h2>New slide</h2>\n  <p>Say something here.</p>'),
    'the section keeps its own inner shape and only its base indentation moves');
  assert.equal(head(out), head(flat));
  assert.equal(tail(out), tail(flat));
});

test('a duplicate is byte-identical to the slide it came from', () => {
  const out = duplicateSlide(DECK, 2);
  assert.deepEqual(running(out), ['Alpha', 'Beta', 'Beta', 'Gamma']);
  assert.equal(source(out, 2), source(DECK, 2), 'the original must come through untouched');
  assert.equal(source(out, 3), source(DECK, 2),
    'a copy that differs from its original by a space is a diff claiming something happened');
  assert.equal(source(out, 3), '<section data-layout="centered">\n      <h2>Beta</h2>\n    </section>',
    'the open tag and its attributes are copied too — a duplicate keeps the slide\'s layout');
});

test('deleting a slide takes the line it sat on with it, leaving no blank gap', () => {
  const out = deleteSlide(DECK, 2);
  assert.equal(out, DECK.replace('    <section data-layout="centered">\n      <h2>Beta</h2>\n    </section>\n', ''),
    'the deck must differ by exactly the three lines that were the slide');
  assert.doesNotMatch(out, /\n[ \t]*\n/, 'the indentation left behind would be a blank line nobody typed');
});

test('deleting the first slide moves the second one up rather than opening a hole', () => {
  const out = deleteSlide(DECK, 1);
  assert.deepEqual(running(out), ['Beta', 'Gamma']);
  assert.equal(out, DECK.replace(
    '    <section>\n      <h2>Alpha</h2>\n      <aside class="notes">one</aside>\n    </section>\n', ''));
});

test('deleting the last slide leaves the deck ending as it began', () => {
  const out = deleteSlide(DECK, 3);
  assert.deepEqual(running(out), ['Alpha', 'Beta']);
  assert.equal(tail(out), tail(DECK), 'the closing </div> and the runtime must still follow the last slide');
  assert.doesNotMatch(out, /\n[ \t]*\n/);
});

test('reordering exchanges two sections and rewrites nothing inside either', () => {
  const up = swapSlides(DECK, 1, 2);
  assert.deepEqual(running(up), ['Beta', 'Alpha', 'Gamma']);
  assert.equal(source(up, 1), source(DECK, 2), 'the moved slide arrives byte for byte');
  assert.equal(source(up, 2), source(DECK, 1));
  assert.equal(source(up, 3), source(DECK, 3), 'the slide that did not move must not have moved');

  const down = swapSlides(DECK, 2, 3);
  assert.deepEqual(running(down), ['Alpha', 'Gamma', 'Beta']);
  assert.equal(source(down, 1), source(DECK, 1));
});

test('swapping two slides twice is the deck you started with', () => {
  assert.equal(swapSlides(swapSlides(DECK, 2, 3), 2, 3), DECK,
    'a reorder that did not round-trip would drift the file one edit at a time');
  assert.equal(swapSlides(DECK, 2, 2), DECK, 'a slide swapped with itself is not an edit');
  assert.equal(swapSlides(DECK, 3, 2), swapSlides(DECK, 2, 3), 'the pair is unordered — up and down are one op');
});

test('a slide taken from a deck at another depth lands at the depth it is going to', () => {
  // Not the ordinary case, and the one the reindent is there for: a section
  // pasted in two levels deep must not drag those levels up the file every
  // time somebody presses the reorder key.
  const mixed = [
    '<div class="decklight">',
    '  <section>',
    '    <h2>Shallow</h2>',
    '  </section>',
    '      <section>',
    '        <h2>Deep</h2>',
    '      </section>',
    '</div>',
  ].join('\n');
  const out = swapSlides(mixed, 1, 2);
  assert.deepEqual(running(out), ['Deep', 'Shallow']);
  assert.equal(out, [
    '<div class="decklight">',
    '  <section>',
    '    <h2>Deep</h2>',
    '  </section>',
    '      <section>',
    '        <h2>Shallow</h2>',
    '      </section>',
    '</div>',
  ].join('\n'), 'each slide takes the other\'s indentation, not its own');
});

test('a hidden slide is numbered and moved like any other section', () => {
  // Numbering here is by SOURCE ORDER (DECK_ANATOMY): a hidden slide keeps its
  // number, exactly as comments, review anchors and history number it.
  const deck = DECK.replace('<section data-layout="centered">', '<section data-hidden>');
  assert.equal(sectionBodies(deck).length, 3, 'the hidden slide is still one of the three');
  const out = swapSlides(deck, 2, 3);
  assert.deepEqual(running(out), ['Alpha', 'Gamma', 'Beta']);
  assert.match(source(out, 3), /^<section data-hidden>/, 'and it keeps being hidden after the move');
});

// ── insertImage ───────────────────────────────────────────────────────────

test('an image with no index lands on the slide, before the asides', () => {
  const { html, index } = insertImage(DECK, 1, null, { src: 'assets/chart.png', alt: 'a chart' });
  assert.equal(index, 1, 'the new element is the second child — after the heading, before the notes');
  assert.equal(source(html, 1), [
    '<section>',
    '      <h2>Alpha</h2>',
    '      <img src="assets/chart.png" alt="a chart">',
    '      <aside class="notes">one</aside>',
    '    </section>',
  ].join('\n'), 'an image inside the notes is an image the audience never sees');
  assert.equal(head(html), head(DECK));
  assert.equal(tail(html), tail(DECK));
});

test('an image with an index lands after that child, and says which child it now is', () => {
  const { html, index } = insertImage(DECK, 1, 0, { src: 'assets/a.png', alt: '' });
  assert.equal(index, 1, 'everything after the insertion has shifted, so the caller is told where it went');
  assert.equal(source(html, 1), [
    '<section>',
    '      <h2>Alpha</h2>',
    '      <img src="assets/a.png" alt="">',
    '      <aside class="notes">one</aside>',
    '    </section>',
  ].join('\n'));
});

test('an image can be asked for after the notes aside, when that is what was asked', () => {
  const { html, index } = insertImage(DECK, 1, 1, { src: 'assets/a.png' });
  assert.equal(index, 2);
  assert.match(source(html, 1), /<\/aside>\n      <img src="assets\/a\.png" alt="">/,
    'an explicit index is the author\'s decision, not something to second-guess');
});

test('a slide that is all asides still takes an image onto the slide itself', () => {
  const deck = '<div>\n  <section>\n    <aside class="notes">talk</aside>\n  </section>\n</div>';
  const { html, index } = insertImage(deck, 1, null, { src: 'a.png', alt: 'x' });
  assert.equal(index, 0);
  assert.equal(html, '<div>\n  <section>\n    <img src="a.png" alt="x">\n    <aside class="notes">talk</aside>\n  </section>\n</div>');
});

test('src and alt are escaped, so neither can close the tag it is written into', () => {
  const { html } = insertImage(DECK, 1, null, { src: 'a"onerror="alert(1).png', alt: 'a <b> & "c"' });
  assert.match(html, /<img src="a&quot;onerror=&quot;alert\(1\)\.png" alt="a &lt;b&gt; &amp; &quot;c&quot;">/,
    'an unescaped quote here would end the attribute and hand the slide a handler');
});

test('an image onto a slide or an index that does not exist throws rather than guessing', () => {
  assert.throws(() => insertImage(DECK, 9, null, { src: 'a.png' }), /no slide 9/);
  assert.throws(() => insertImage(DECK, 1, 9, { src: 'a.png' }), /no element at index 9/);
});
