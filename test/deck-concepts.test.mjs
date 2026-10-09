// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Concept colours written by the edit server (SPEC SVG_DIAGRAMS, #718): the
// deck's `concepts` map spliced into the way the deck carries its
// configuration, and a shape's `data-concept` set or taken off in place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setDeckConcepts } from '../cli/runtime-link.mjs';
import { setElementAttr } from '../cli/edit.mjs';

const data = (inner) => `<!doctype html>
<html><head>
<script type="application/json" data-decklight-config>
${inner}
</script>
</head><body><div class="decklight"><section><h2>One</h2></section></div></body></html>`;

const inner = (html) => /data-decklight-config>\n([\s\S]*?)\n<\/script>/.exec(html)[1];

test('a deck that is data: concepts are added after the other keys, in place, and nothing else moves', () => {
  const html = data('{\n  "decklight": "0.9.0",\n  "theme": "aurora"\n}');
  const next = setDeckConcepts(html, { agent: 3 });
  assert.equal(inner(next), '{\n  "decklight": "0.9.0",\n  "theme": "aurora",\n  "concepts": { "agent": 3 }\n}');
  assert.deepEqual(JSON.parse(inner(next)).concepts, { agent: 3 });
  // replaced in place: the key keeps its position, the neighbours their bytes
  const again = setDeckConcepts(next, { agent: 5, tools: 'var(--accent)' });
  assert.equal(inner(again), '{\n  "decklight": "0.9.0",\n  "theme": "aurora",\n  "concepts": { "agent": 5, "tools": "var(--accent)" }\n}');
  // an empty map takes the key off, comma included
  const off = setDeckConcepts(again, {});
  assert.equal(inner(off), '{\n  "decklight": "0.9.0",\n  "theme": "aurora"\n}');
  assert.equal(setDeckConcepts(off, {}), off, 'nothing to take off: the bytes are the same');
});

test('a one-line block, an empty block, and a key that sits first all splice cleanly', () => {
  assert.equal(inner(setDeckConcepts(data('{ "decklight": "0.9.0" }'), { a: 1 })), '{ "decklight": "0.9.0", "concepts": { "a": 1 } }');
  assert.equal(inner(setDeckConcepts(data('{}'), { a: 1 })), '{ "concepts": { "a": 1 } }');
  const first = data('{\n  "concepts": { "a": 1 },\n  "theme": "paper"\n}');
  assert.equal(inner(setDeckConcepts(first, {})), '{\n  "theme": "paper"\n}');
  assert.equal(inner(setDeckConcepts(first, { b: 2 })), '{\n  "concepts": { "b": 2 },\n  "theme": "paper"\n}');
  // a brace inside a string is a character, not a block
  const tricky = data('{\n  "logo": "a{b}.svg",\n  "concepts": { "a": 1 }\n}');
  assert.equal(inner(setDeckConcepts(tricky, { a: 2 })), '{\n  "logo": "a{b}.svg",\n  "concepts": { "a": 2 }\n}');
});

test('a bundle: the concepts of a plain-data Decklight.init literal, bare keys and all', () => {
  const html = `<!doctype html><html><body><div class="decklight"></div>
<script>Decklight.init({ theme: 'paper', hash: false });</script></body></html>`;
  const next = setDeckConcepts(html, { agent: 2 });
  assert.match(next, /Decklight\.init\(\{ theme: 'paper', hash: false, "concepts": \{ "agent": 2 \} \}\);/);
  const off = setDeckConcepts(next, {});
  assert.match(off, /Decklight\.init\(\{ theme: 'paper', hash: false \}\);/);
});

test('refused with null: a call that is code, a bad name, a slot off the chart, a colour that is not a token or a hex', () => {
  const code = `<!doctype html><html><body><script>const opts = {}; Decklight.init(opts);</script></body></html>`;
  assert.equal(setDeckConcepts(code, { a: 1 }), null);
  const ok = data('{ "decklight": "0.9.0" }');
  assert.equal(setDeckConcepts(ok, { 'bad name': 1 }), null);
  assert.equal(setDeckConcepts(ok, { a: 7 }), null);
  assert.equal(setDeckConcepts(ok, { a: 'red; x' }), null);
  assert.equal(setDeckConcepts(ok, { a: 'url(x)' }), null);
  assert.notEqual(setDeckConcepts(ok, { a: '#fa0' }), null, 'a hex is a colour the runtime reads');
  assert.equal(setDeckConcepts(data('{ not json'), { a: 1 }), null, 'a broken block is not written over');
});

const DECK = `<!doctype html><html><body><div class="decklight">
<section>
  <h2>Diagram</h2>
  <svg viewBox="0 0 100 100">
    <g class="box"><rect x="1" y="1" width="10" height="10" fill="var(--d-fill-1)"/><text x="2" y="8">A</text></g>
    <circle data-concept="agent" cx="50" cy="50" r="5"/>
  </svg>
</section>
</div></body></html>`;

test('data-concept is set on the shape, replaced in place, and taken off — the rest of the tag byte for byte', () => {
  const set = setElementAttr(DECK, 1, 1, { path: [0, 0], tag: 'rect', name: 'data-concept', value: 'tools' });
  assert.match(set, /<rect x="1" y="1" width="10" height="10" fill="var\(--d-fill-1\)" data-concept="tools"\/>/);
  const swapped = setElementAttr(set, 1, 1, { path: [0, 0], tag: 'rect', name: 'data-concept', value: 'data' });
  assert.match(swapped, /<rect x="1" y="1" width="10" height="10" fill="var\(--d-fill-1\)" data-concept="data"\/>/);
  const off = setElementAttr(swapped, 1, 1, { path: [0, 0], tag: 'rect', name: 'data-concept', value: null });
  assert.equal(off, DECK, 'taken off, the file is what it was');
  const detached = setElementAttr(DECK, 1, 1, { path: [1], tag: 'circle', name: 'data-concept', value: null });
  assert.match(detached, /<circle cx="50" cy="50" r="5"\/>/);
});

test('a path that lands on another tag, a name that is not one, or an attribute this server does not write: refused', () => {
  assert.throws(() => setElementAttr(DECK, 1, 1, { path: [0, 0], tag: 'circle', name: 'data-concept', value: 'x' }), (e) => e.code === 'STALE');
  assert.throws(() => setElementAttr(DECK, 1, 1, { path: [0, 9], tag: 'rect', name: 'data-concept', value: 'x' }), (e) => e.code === 'STALE');
  assert.throws(() => setElementAttr(DECK, 1, 1, { path: [1], tag: 'circle', name: 'data-concept', value: 'not a name' }), /not a name/);
  assert.throws(() => setElementAttr(DECK, 1, 1, { path: [1], tag: 'circle', name: 'onclick', value: 'x' }), /not an attribute/);
});
