// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Diagram labels edited in place (SPEC SVG_DIAGRAMS): the words between one
// <text> or <tspan>'s tags change, and every other byte of the diagram stays.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setElementText, setElementLines, labelLinesOf, setElementGeometry, LINE_HEIGHT_EM } from '../cli/edit.mjs';
import { wrapWords, lineOffsets, roomOf, LINE_EM } from '../src/core/diagram-labels.js';

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

// ── labels that wrap (SVG_DIAGRAMS) ─────────────────────────────────────────

const store = (html) => /<g><rect x="100"[^]*?<\/text>/.exec(html)[0];

test('a label written as lines: positioned tspans at its x, a dy in em, the block centred on its y', () => {
  const next = setElementLines(DECK, 1, 1, { path: [0, 1], was: 'API & gateway', lines: ['API &', 'gateway', 'edge'] });
  assert.equal(label(next), '<g><rect x="1" y="1" width="90" height="40"/><text x="46" y="26" text-anchor="middle">'
    + '<tspan x="46" dy="-1.2em">API &amp;</tspan><tspan x="46" dy="1.2em">gateway</tspan><tspan x="46" dy="1.2em">edge</tspan></text>');
  assert.equal(next.replace(label(next), ''), DECK.replace(label(DECK), ''), 'nothing outside the label moved');
  assert.equal(LINE_HEIGHT_EM, LINE_EM, 'the page and the server space lines alike');
  assert.deepEqual(lineOffsets(3), [-1.2, 1.2, 1.2]);
  assert.deepEqual(lineOffsets(2), [-0.6, 1.2]);
  assert.deepEqual(lineOffsets(1), [0]);
});

test('lines back to one: plain words, the whitespace the file had around plain words kept; lines re-broken', () => {
  const one = setElementLines(DECK, 1, 1, { path: [0, 1], was: 'API & gateway', lines: ['Edge'] });
  assert.match(label(one), /middle">\n {8}Edge\n {6}<\/text>$/);
  const two = setElementLines(DECK, 1, 1, { path: [1, 1], was: 'Line one\nLine two', lines: ['Line one Line', 'two'] });
  assert.equal(store(two), '<g><rect x="100" y="1" width="90" height="40"/><text x="145" y="20"><tspan x="145" dy="-0.6em">Line one Line</tspan><tspan x="145" dy="1.2em">two</tspan></text>');
  const flat = setElementLines(two, 1, 1, { path: [1, 1], was: 'Line one Line\ntwo', lines: ['Both'] });
  assert.equal(store(flat), '<g><rect x="100" y="1" width="90" height="40"/><text x="145" y="20">Both</text>');
});

test('what counts as lines: words, or positioned tspans and nothing else; a run (#986) is not a line', () => {
  assert.deepEqual(labelLinesOf('  API &amp; gateway '), ['API & gateway']);
  assert.deepEqual(labelLinesOf('<tspan x="1">a</tspan>\n  <tspan x="1" dy="1.2em">b c</tspan>'), ['a', 'b c']);
  assert.equal(labelLinesOf('What happens in <tspan class="code">AI_RUN</tspan>'), null, 'words beside a run');
  assert.equal(labelLinesOf('<tspan class="code">AI_RUN</tspan>'), null, 'an unpositioned tspan is a run');
  assert.equal(labelLinesOf('<tspan x="1">a<tspan>b</tspan></tspan>'), null);
  const runs = DECK.replace('<text x="4" y="90"></text>', '<text x="4" y="90">in <tspan class="code">X</tspan></text>');
  assert.throws(() => setElementLines(runs, 1, 1, { path: [2], was: 'in X', lines: ['a', 'b'] }), /runs or other elements/);
});

test('lines refused: stale words, too many or empty lines, control characters, a tspan target, no x to write them at', () => {
  assert.throws(() => setElementLines(DECK, 1, 1, { path: [0, 1], was: 'Something else', lines: ['a', 'b'] }), (e) => e.code === 'STALE');
  assert.throws(() => setElementLines(DECK, 1, 1, { path: [0, 1], was: 'API & gateway', lines: [] }), /1 to 12 lines/);
  assert.throws(() => setElementLines(DECK, 1, 1, { path: [0, 1], was: 'API & gateway', lines: Array(13).fill('a') }), /1 to 12 lines/);
  assert.throws(() => setElementLines(DECK, 1, 1, { path: [0, 1], was: 'API & gateway', lines: ['a', ' '] }), /1 to 12 lines/);
  assert.throws(() => setElementLines(DECK, 1, 1, { path: [0, 1], was: 'API & gateway', lines: ['a\tb'] }), /1 to 12 lines/);
  assert.throws(() => setElementLines(DECK, 1, 1, { path: [1, 1, 0], tag: 'tspan', was: 'Line one', lines: ['a'] }), /not a <tspan>/);
  const noX = DECK.replace('<text x="4" y="90"></text>', '<text y="90">one two</text>');
  assert.throws(() => setElementLines(noX, 1, 1, { path: [2], was: 'one two', lines: ['one', 'two'] }), /needs the x/);
});

test('a resize that re-wraps its label: the geometry and the lines in ONE write, the lines after the text\'s x', () => {
  const next = setElementGeometry(DECK, 1, 1, [
    { path: [0, 0], tag: 'rect', attr: 'width', value: 60 }, { path: [0, 1], tag: 'text', attr: 'x', value: 31 },
    { path: [0, 1], tag: 'text', was: 'API & gateway', lines: ['API &', 'gateway'] },
  ]);
  assert.equal(label(next), '<g><rect x="1" y="1" width="60" height="40"/><text x="31" y="26" text-anchor="middle"><tspan x="31" dy="-0.6em">API &amp;</tspan><tspan x="31" dy="1.2em">gateway</tspan></text>');
  assert.throws(() => setElementGeometry(DECK, 1, 1, [{ path: [0, 1], tag: 'text', was: 'stale', lines: ['a', 'b'] }]), (e) => e.code === 'STALE');
});

test('words break to the room: greedy, typed breaks kept, a word wider than the room alone and overflowing', () => {
  const m = (t) => t.length * 10;
  assert.deepEqual(wrapWords('Payment service (primary region)', 160, m), { lines: ['Payment service', '(primary region)'], overflow: false });
  assert.deepEqual(wrapWords('Payment service (primary region)', 100, m), { lines: ['Payment', 'service', '(primary', 'region)'], overflow: false });
  assert.deepEqual(wrapWords('One\n  two   three ', 500, m), { lines: ['One', 'two three'], overflow: false });
  assert.deepEqual(wrapWords('Supercalifragilistic x', 100, m), { lines: ['Supercalifragilistic', 'x'], overflow: true });
  assert.deepEqual(wrapWords('', 100, m), { lines: [], overflow: false });
  // a diamond's middle holds less than a box of the same size
  assert.ok(roomOf('diamond', 200, 100).w < roomOf('rect', 200, 100).w);
});
