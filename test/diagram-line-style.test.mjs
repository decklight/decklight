// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Line ▸ and Corners ▸ in a diagram (SPEC SVG_DIAGRAMS, PRESENTING_EDITING):
// a stroke's dashes written inline, so a `draw` build keeps them as it draws;
// a box's corners square, rounded or a pill, and a pill kept so on a resize.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setElementStyles, setElementGeometry, editedNodes, createHistory } from '../cli/edit.mjs';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { LINE_DASHES, LINES, lineOf, CORNERS, cornersOf, cornerRadius } from '../tools/diagram-shapes.mjs';
import { tmp } from './helpers.mjs';

const DECK = `<!doctype html><html><body><div class="decklight">
  <section>
    <h2>Flow</h2>
    <svg viewBox="0 0 800 300">
      <rect x="60" y="110" width="180" height="70" style="fill: var(--d-fill-3)"/>
      <line x1="240" y1="145" x2="320" y2="145" style="stroke: var(--d-stroke)" data-from="a" data-to="b"/>
      <path d="M 10 10 L 90 90" stroke-dasharray="3 3" stroke="#333"/>
      <rect x="400" y="100" width="120" height="40" rx="20" ry="20"/>
    </svg>
  </section>
</div></body></html>`;

const lineOfDeck = (html, needle) => html.split('\n').find((l) => l.includes(needle));
const style = (edits) => setElementStyles(DECK, 1, 1, edits);

test('the values Line ▸ writes, and what a dash pattern reads back as', () => {
  assert.deepEqual(LINES, ['solid', 'dashed', 'dotted']);
  assert.deepEqual({ ...LINE_DASHES }, { dashed: '6 4', dotted: '0 4' });
  assert.equal(lineOf(null), 'solid');
  assert.equal(lineOf('none'), 'solid');
  assert.equal(lineOf('0'), 'solid');
  assert.equal(lineOf('6 4'), 'dashed');
  assert.equal(lineOf('6px, 4px'), 'dashed', 'as a browser reads an inline style back');
  assert.equal(lineOf('0 4'), 'dotted');
  assert.equal(lineOf('0px, 4px'), 'dotted');
  assert.equal(lineOf('0.5 3'), 'dotted');
});

test('a dash is written inline in the stroke\'s style, the rest of its tag byte for byte', () => {
  const next = style([{ path: [1], tag: 'line', prop: 'stroke-dasharray', value: '6 4' }]);
  assert.equal(lineOfDeck(next, '<line'), '      <line x1="240" y1="145" x2="320" y2="145" style="stroke: var(--d-stroke); stroke-dasharray: 6 4" data-from="a" data-to="b"/>');
  const dotted = style([{ path: [1], tag: 'line', prop: 'stroke-dasharray', value: '0 4' }, { path: [1], tag: 'line', prop: 'stroke-linecap', value: 'round' }]);
  assert.match(lineOfDeck(dotted, '<line'), /style="stroke: var\(--d-stroke\); stroke-dasharray: 0 4; stroke-linecap: round"/);
});

test('writing a dash takes off the attribute of the same name, so the file never says two things; solid takes off both', () => {
  const dashed = style([{ path: [2], tag: 'path', prop: 'stroke-dasharray', value: '6 4' }]);
  assert.equal(lineOfDeck(dashed, '<path'), '      <path d="M 10 10 L 90 90" stroke="#333" style="stroke-dasharray: 6 4"/>');
  const solid = style([{ path: [2], tag: 'path', prop: 'stroke-dasharray', value: null }]);
  assert.equal(lineOfDeck(solid, '<path'), '      <path d="M 10 10 L 90 90" stroke="#333"/>');
});

test('a dash pattern or a cap outside the closed set is refused', () => {
  assert.throws(() => style([{ path: [1], tag: 'line', prop: 'stroke-dasharray', value: '1 2 3' }]), /not a line style/);
  assert.throws(() => style([{ path: [1], tag: 'line', prop: 'stroke-dasharray', value: '6 4; fill: red' }]), /not a line style/);
  assert.throws(() => style([{ path: [1], tag: 'line', prop: 'stroke-linecap', value: 'pointy' }]), /not a line style/);
});

test('editedNodes hands back the markup of each node styled, once', () => {
  const edits = [{ path: [1], tag: 'line', prop: 'stroke-dasharray', value: '0 4' }, { path: [1], tag: 'line', prop: 'stroke-linecap', value: 'round' }];
  const nodes = editedNodes(style(edits), 1, 1, edits);
  assert.equal(nodes.length, 1);
  assert.deepEqual(nodes[0].path, [1]);
  assert.match(nodes[0].html, /^<line [^>]*stroke-dasharray: 0 4; stroke-linecap: round"[^>]*\/>$/);
});

test('the corners a box has, and the radius each choice gives it', () => {
  assert.deepEqual(CORNERS, ['square', 'rounded', 'pill']);
  assert.equal(cornersOf({ width: 100, height: 40 }), 'square');
  assert.equal(cornersOf({ width: 100, height: 40, rx: 0 }), 'square');
  assert.equal(cornersOf({ width: 100, height: 40, rx: 8 }), 'rounded');
  assert.equal(cornersOf({ width: 100, height: 40, rx: 20 }), 'pill');
  assert.equal(cornersOf({ width: 100, height: 40, ry: 30 }), 'pill', 'a radius past half is drawn as half');
  assert.equal(cornerRadius('square', 100, 40), null);
  assert.equal(cornerRadius('pill', 100, 41), 20.5);
  assert.equal(cornerRadius('rounded', 180, 70), 12);
  assert.equal(cornerRadius('rounded', 30, 10), 2);
  assert.equal(cornersOf({ width: 30, height: 10, rx: cornerRadius('rounded', 30, 10) }), 'rounded');
});

test('Corners ▸ square takes a box\'s rx and ry off; a null is refused on anything but a box\'s corners', () => {
  const next = setElementGeometry(DECK, 1, 1, [{ path: [3], tag: 'rect', attr: 'rx', value: null }, { path: [3], tag: 'rect', attr: 'ry', value: null }]);
  assert.equal(lineOfDeck(next, 'x="400"'), '      <rect x="400" y="100" width="120" height="40"/>');
  assert.throws(() => setElementGeometry(DECK, 1, 1, [{ path: [3], tag: 'rect', attr: 'x', value: null }]), /not a coordinate/);
  assert.throws(() => setElementGeometry(DECK, 1, 1, [{ path: [1], tag: 'line', attr: 'rx', value: null }]), /only a box's corners/);
  const pill = setElementGeometry(DECK, 1, 1, [{ path: [0], tag: 'rect', attr: 'rx', value: 35 }, { path: [0], tag: 'rect', attr: 'ry', value: 35 }]);
  assert.match(lineOfDeck(pill, 'x="60"'), /height="70" style="fill: var\(--d-fill-3\)" rx="35" ry="35"\/>/);
});

function harness(t) {
  const dir = tmp('diagram-line-style', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, DECK);
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
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: deck, quiet: () => {}, broadcast: () => {} });
  return { routes, history, readDeck };
}
async function call(routes, key, body) {
  const sent = {};
  await routes.get(key)({ req: {}, res: {}, url: new URL(`http://x${key.split(' ')[1]}`), body: JSON.stringify(body), json: (code, obj) => { sent.code = code; sent.body = obj; }, CORS: {} });
  return sent;
}

test('POST /deck/edit/element/style asked to echo answers with the node as the file now has it; one undo entry', async (t) => {
  const { routes, readDeck, history } = harness(t);
  const edits = [{ path: [1], tag: 'line', prop: 'stroke-dasharray', value: '6 4' }];
  const r = await call(routes, 'POST /deck/edit/element/style', { slide: 1, index: 1, edits, echo: true, quiet: true, from: 'p' });
  assert.equal(r.code, 200);
  assert.equal(r.body.changed, true);
  assert.equal(r.body.nodes.length, 1);
  assert.ok(readDeck().includes(r.body.nodes[0].html), 'the echoed markup is the file\'s');
  assert.equal(history.counts().undo, 1);
  const plain = await call(routes, 'POST /deck/edit/element/style', { slide: 1, index: 1, edits: [{ path: [1], tag: 'line', prop: 'stroke-dasharray', value: null }] });
  assert.equal(plain.body.nodes, undefined, 'no echo unless asked');
});
