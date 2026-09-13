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
