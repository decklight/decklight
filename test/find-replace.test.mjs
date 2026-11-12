// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Find and replace across a deck (PRESENTING_EDITING): the file's text, never
// a tag, an attribute, a script or a style; code and notes only when asked;
// entities read as what they stand for; and every other byte left alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInDeck, replaceInDeck } from '../cli/find-replace.mjs';

const DECK = `<!doctype html>
<html><head><title>The deck</title><style>.deck { color: red }</style></head><body>
  <div class="decklight">
    <section data-module="deck">
      <h2>This deck, and the Deck</h2>
      <p class="deck">A <strong>deck</strong> of Q&amp;A: decks and decking.</p>
      <pre><code>const deck = 1;</code></pre>
      <script type="application/json">{ "deck": true }</script>
      <!-- the deck's notes -->
      <aside class="notes"><p>Say deck twice: deck.</p></aside>
      <aside class="sources"><ul><li>deck source</li></ul></aside>
    </section>
    <section>
      <svg viewBox="0 0 100 40"><text x="1" y="20">deck label</text></svg>
      <p>q&amp;a and Q&A</p>
    </section>
  </div>
</body></html>
`;

test('only text is found: no tag, attribute, comment, script, style, code, notes or sources', () => {
  const m = findInDeck(DECK, 'deck');
  assert.deepEqual(m.map((x) => [x.slide, x.text]), [[1, 'deck'], [1, 'Deck'], [1, 'deck'], [1, 'deck'], [1, 'deck'], [2, 'deck']],
    'This deck, the Deck, <strong>deck</strong>, decks, decking, and the diagram label');
  for (const x of m) assert.equal(DECK.slice(x.start, x.end).toLowerCase(), 'deck', 'each match points at its bytes in the file');
  assert.ok(m.every((x) => !x.notes));
});

test('a whole word, and the case as written, when asked', () => {
  assert.deepEqual(findInDeck(DECK, 'deck', { wholeWord: true }).map((x) => x.text), ['deck', 'Deck', 'deck', 'deck']);
  assert.deepEqual(findInDeck(DECK, 'Deck', { caseSensitive: true }).map((x) => x.text), ['Deck']);
});

test('notes and code only when asked, and a match says where it is', () => {
  const notes = findInDeck(DECK, 'deck', { notes: true, wholeWord: true }).filter((x) => x.notes);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].slide, 1);
  const code = findInDeck(DECK, 'const deck', { code: true });
  assert.equal(code.length, 1);
  assert.equal(code[0].before.trim(), '');
  const one = findInDeck(DECK, 'Q&A')[0];
  assert.equal(one.text, 'Q&A');
  assert.match(one.before, /of $/);
  assert.match(one.after, /^: decks/);
});

test('entities are read as what they stand for, and written back as text', () => {
  const m = findInDeck(DECK, 'q&a');
  assert.deepEqual(m.map((x) => DECK.slice(x.start, x.end)), ['Q&amp;A', 'q&amp;a', 'Q&A']);
  const { html, count } = replaceInDeck(DECK, { find: 'Q&A', replace: 'R & <D>', opts: { caseSensitive: true } });
  assert.equal(count, 2);
  assert.match(html, /A <strong>deck<\/strong> of R &amp; &lt;D&gt;: decks/);
  assert.match(html, /q&amp;a and R &amp; &lt;D&gt;<\/p>/);
});

test('replace all changes the matches and nothing else; replace one only the one named', () => {
  const { html, count } = replaceInDeck(DECK, { find: 'deck', replace: 'talk', opts: { wholeWord: true } });
  assert.equal(count, 4);
  assert.match(html, /<h2>This talk, and the talk<\/h2>/);
  assert.match(html, /<section data-module="deck">/, 'an attribute is never touched');
  assert.match(html, /<p class="deck">A <strong>talk<\/strong> of Q&amp;A: decks and decking\.<\/p>/);
  assert.match(html, /const deck = 1;/);
  assert.match(html, /\{ "deck": true \}/);
  assert.match(html, /<!-- the deck's notes -->/);
  assert.match(html, /<title>The deck<\/title>/, 'nothing outside the slides');
  assert.match(html, /\.deck \{ color: red \}/);
  assert.match(html, /<text x="1" y="20">talk label<\/text>/);
  const all = findInDeck(DECK, 'deck', { wholeWord: true });
  const one = replaceInDeck(DECK, { find: 'deck', replace: 'talk', opts: { wholeWord: true }, only: [all[1].id] });
  assert.equal(one.count, 1);
  assert.match(one.html, /<h2>This deck, and the talk<\/h2>/);
  assert.equal(replaceInDeck(DECK, { find: 'nowhere', replace: 'x' }).html, DECK);
});

test('a phrase is one line of text; a replacement too', () => {
  for (const bad of ['', '   ', 'two\nlines', 'x'.repeat(201)]) assert.throws(() => findInDeck(DECK, bad), /one line/, JSON.stringify(bad));
  assert.throws(() => replaceInDeck(DECK, { find: 'deck', replace: 'x'.repeat(201) }), /up to 200/);
  assert.equal(findInDeck(DECK, 'a.b').length, 0, 'the phrase is a phrase, not a pattern');
  assert.equal(findInDeck('<div class="decklight"><section><p>a.b axb</p></section></div>', 'a.b').length, 1);
});
