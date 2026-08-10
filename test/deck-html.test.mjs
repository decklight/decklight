// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// sectionChildRanges: the raw-position top-level-child walker element edit
// mode (#112) addresses elements by. Deliberately hostile fixtures — nested
// same-name tags, self-closing SVG children, void elements, comments, and a
// quoted `>` in an attribute — since a naive same-tag-name counter gets every
// one of them wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateSlide, sectionChildRanges } from '../tools/deck-html.mjs';

// sectionChildRanges takes `parts[idx]` exactly as locateSlide hands it back —
// this helper is what every real caller (cli/edit.mjs) does first.
function ranges(deckHtml, slide) {
  const { parts, idx } = locateSlide(deckHtml, slide);
  const seg = parts[idx];
  return sectionChildRanges(seg).map((r) => ({ tag: r.tag, text: seg.slice(r.start, r.end) }));
}

test('flat children, title included as a raw child (not filtered as chrome)', () => {
  const deck = '<section><h2>Title</h2><ul><li>one</li></ul></section>';
  assert.deepEqual(ranges(deck, 1), [
    { tag: 'h2', text: '<h2>Title</h2>' },
    { tag: 'ul', text: '<ul><li>one</li></ul>' },
  ]);
});

test('a nested div of the SAME tag name ends at its own close, not the outer one', () => {
  const deck = '<section><div><div>inner</div> after</div><p>next</p></section>';
  const r = ranges(deck, 1);
  assert.equal(r.length, 2);
  assert.equal(r[0].text, '<div><div>inner</div> after</div>');
  assert.equal(r[1].text, '<p>next</p>');
});

test('self-closing SVG children never open a nesting level', () => {
  const deck = '<section><svg><g><circle/><path d="M0 0"/></g></svg><h2>t</h2></section>';
  const r = ranges(deck, 1);
  assert.equal(r.length, 2);
  assert.equal(r[0].tag, 'svg');
  assert.equal(r[0].text, '<svg><g><circle/><path d="M0 0"/></g></svg>');
  assert.equal(r[1].tag, 'h2');
});

test('void elements (br, img) close themselves without a matching close tag', () => {
  const deck = '<section><p>a<br>b</p><img src="x.png"><h2>t</h2></section>';
  const r = ranges(deck, 1);
  assert.deepEqual(r.map((x) => x.tag), ['p', 'img', 'h2']);
  assert.equal(r[1].text, '<img src="x.png">');
});

test('a comment between children is not a child itself', () => {
  const deck = '<section><h2>t</h2><!-- a note --><p>x</p></section>';
  const r = ranges(deck, 1);
  assert.deepEqual(r.map((x) => x.tag), ['h2', 'p']);
});

test('a quoted `>` inside an attribute does not end the tag early', () => {
  const deck = '<section><div data-note="a > b">x</div><h2>t</h2></section>';
  const r = ranges(deck, 1);
  assert.equal(r[0].text, '<div data-note="a > b">x</div>');
  assert.equal(r[1].tag, 'h2');
});

test('<script>/<style> bodies are opaque — embedded JSON is never tag-parsed', () => {
  const deck = '<section><script>const spec = { html: "<div>" };</script><h2>t</h2></section>';
  const r = ranges(deck, 1);
  assert.equal(r.length, 2);
  assert.equal(r[0].tag, 'script');
  assert.equal(r[0].text, '<script>const spec = { html: "<div>" };</script>');
  assert.equal(r[1].tag, 'h2');
});

test('an aside (notes) is a raw child too, at its own index', () => {
  const deck = '<section><h2>t</h2><aside class="notes"><p>hi</p></aside></section>';
  const r = ranges(deck, 1);
  assert.deepEqual(r.map((x) => x.tag), ['h2', 'aside']);
});

test('ranges are directly spliceable: slice(0,start)+repl+slice(end) round-trips', () => {
  const { parts, idx } = locateSlide('<section><h2>old</h2><p>keep</p></section>', 1);
  const seg = parts[idx];
  const [h2] = sectionChildRanges(seg);
  const rewritten = seg.slice(0, h2.start) + '<h2>new</h2>' + seg.slice(h2.end);
  parts[idx] = rewritten;
  assert.equal(parts.join(''), '<section><h2>new</h2><p>keep</p></section>');
});

test('malformed <section> tag throws, like locateSlide throwing on a bad index', () => {
  assert.throws(() => sectionChildRanges('no angle bracket here'), /malformed <section> tag/);
});

test('the Node and runtime escapes are the same function, spelled twice', async () => {
  // src/ bundles into a zero-dependency artifact, so it cannot import
  // tools/escape.mjs and keeps its own copy. Two copies is the layering's
  // price; two BEHAVIOURS is how this area got into trouble in the first
  // place — four escapes existed, two of them named escapeHtml, escaping
  // three different sets. This fails the moment one side grows a character
  // the other does not.
  const { escapeHtml: node } = await import('../tools/escape.mjs');
  const { escapeHtml: runtime } = await import('../src/core/escape.js');

  const corpus = [
    'plain text', 'a & b', '<script>alert(1)</script>', 'say "hi"',
    "it's fine", '<a href="x">', 'a&amp;b already escaped', '&<>"\'',
    '', '1 < 2 && 3 > 2', 'ünïcødé — em dash', '</style><img onerror=x>',
  ];
  for (const s of corpus) {
    assert.equal(runtime(s), node(s), `escapes disagree on ${JSON.stringify(s)}`);
  }

  // and the contract itself: safe in text and in a double-quoted attribute
  assert.equal(node('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
  assert.equal(node('&lt;'), '&amp;lt;', 'ampersand first, or escapes double-escape');
});
