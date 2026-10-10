// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Diagram labels edited in place (SPEC SVG_DIAGRAMS): the words between one
// <text> or <tspan>'s tags change, and every other byte of the diagram stays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setElementText } from '../cli/edit.mjs';

const DECK = `<!doctype html><html><body><div class="decklight">
  <section>
    <h2>Flow</h2>
    <svg viewBox="0 0 200 100">
      <g><rect x="1" y="1" width="90" height="40"/><text x="46" y="26" text-anchor="middle">
        API &amp; gateway
      </text></g>
      <!-- the store -->
      <g><rect x="100" y="1" width="90" height="40"/><text x="145" y="20"><tspan x="145">Line one</tspan><tspan x="145" dy="14">Line two</tspan></text></g>
      <text x="4" y="90"></text>
    </svg>
  </section>
</div></body></html>`;

const label = (html) => /<g><rect x="1"[^]*?<\/text>/.exec(html)[0];

test('the words change, the whitespace around them and every other byte stay', () => {
  const next = setElementText(DECK, 1, 1, { path: [0, 1], tag: 'text', was: 'API & gateway', text: 'Edge & <proxy>' });
  assert.equal(label(next), '<g><rect x="1" y="1" width="90" height="40"/><text x="46" y="26" text-anchor="middle">\n        Edge &amp; &lt;proxy&gt;\n      </text>');
  assert.equal(next.replace(label(next), ''), DECK.replace(label(DECK), ''), 'nothing outside the label moved');
  assert.match(next, /viewBox="0 0 200 100"/);
});

test('one line of a multi-line label is its own tspan', () => {
  const next = setElementText(DECK, 1, 1, { path: [1, 1, 1], tag: 'tspan', was: 'Line two', text: 'Second' });
  assert.match(next, /<tspan x="145">Line one<\/tspan><tspan x="145" dy="14">Second<\/tspan>/);
  assert.throws(() => setElementText(DECK, 1, 1, { path: [1, 1], tag: 'text', was: 'Line oneLine two', text: 'x' }), /one line at a time/);
});

test('an empty label takes words', () => {
  const next = setElementText(DECK, 1, 1, { path: [2], tag: 'text', was: '', text: 'note' });
  assert.match(next, /<text x="4" y="90">note<\/text>/);
});

test('stale: another tag at the path, or words the page did not show', () => {
  assert.throws(() => setElementText(DECK, 1, 1, { path: [0, 1], tag: 'tspan', was: 'API & gateway', text: 'x' }), (e) => e.code === 'STALE');
  assert.throws(() => setElementText(DECK, 1, 1, { path: [0, 1], tag: 'text', was: 'Something else', text: 'x' }), (e) => e.code === 'STALE');
  assert.throws(() => setElementText(DECK, 1, 1, { path: [9], tag: 'text', was: '', text: 'x' }), (e) => e.code === 'STALE');
});

test('refused: a shape, a line break, a label too long to be one', () => {
  assert.throws(() => setElementText(DECK, 1, 1, { path: [0, 0], tag: 'rect', was: '', text: 'x' }), /not a diagram label/);
  assert.throws(() => setElementText(DECK, 1, 1, { path: [0, 1], tag: 'text', was: 'API & gateway', text: 'a\nb' }), /one line/);
  assert.throws(() => setElementText(DECK, 1, 1, { path: [0, 1], tag: 'text', was: 'API & gateway', text: 'x'.repeat(401) }), /one line/);
  assert.throws(() => setElementText(DECK, 1, 1, { path: [0, 1], tag: 'text', text: 'x' }), /bad payload/);
});
