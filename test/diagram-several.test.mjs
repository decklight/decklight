// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Several shapes of one diagram (SPEC SVG_DIAGRAMS): lined up, spaced and
// sized by Arrange ▸, removed and duplicated together, each ONE write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { removeNestedElements, duplicateDiagramNodes, setElementGeometry, createHistory } from '../cli/edit.mjs';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { arrangeBoxes, ARRANGE } from '../src/core/shapes.js';
import { tmp } from './helpers.mjs';

const DECK = `<!doctype html><html><body><div class="decklight">
  <section>
    <h2>Flow</h2>
    <svg viewBox="0 0 400 200">
      <rect class="a" data-node="a" x="0" y="0" width="50" height="50"/>
      <line data-from="a" data-to="c" x1="50" y1="25" x2="200" y2="25"/>
      <rect class="b" x="100" y="0" width="50" height="50"/>
      <g class="c" data-node="c"><rect x="200" y="0" width="50" height="50"/><text x="225" y="25">C</text></g>
    </svg>
  </section>
</div></body></html>`;
const svgOf = (html) => /<svg[^]*<\/svg>/.exec(html)[0];
const classes = (html) => (svgOf(html).match(/class="(\w)"/g) ?? []).map((m) => m[7]).join('');

test('Arrange: six alignments on the box round them all, spacing that keeps the outer two, the primary\'s size', () => {
  assert.equal(ARRANGE.length, 10);
  const boxes = [{ x: 0, y: 10, w: 40, h: 20 }, { x: 100, y: 0, w: 20, h: 40 }, { x: 300, y: 50, w: 60, h: 10 }];
  const d = (how, k = 'dx') => arrangeBoxes(boxes, how).map((m) => m[k]);
  assert.deepEqual(d('left'), [0, -100, -300]);
  assert.deepEqual(d('right'), [320, 240, 0]);
  assert.deepEqual(d('center'), [160, 70, -150]);
  assert.deepEqual(d('top', 'dy'), [-10, 0, -50]);
  assert.deepEqual(d('bottom', 'dy'), [30, 20, 0]);
  assert.deepEqual(d('middle', 'dy'), [10, 10, -25]);
  // across: the outer two stay; the middle one makes both gaps (360 - 120) / 2 = 120
  assert.deepEqual(d('across'), [0, 60, 0]);
  assert.deepEqual(arrangeBoxes(boxes, 'width').map((m) => m.w), [undefined, 40, 40]);
  assert.deepEqual(arrangeBoxes(boxes, 'height').map((m) => m.h), [undefined, 20, 20]);
  assert.deepEqual(arrangeBoxes(boxes.slice(0, 2), 'across'), [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }], 'two: nothing to space');
  assert.deepEqual(arrangeBoxes(boxes.slice(0, 1), 'left'), [{ dx: 0, dy: 0 }]);
});

test('several nodes removed in ONE write, read before any goes: their connectors with them, a node inside another never twice', () => {
  const out = removeNestedElements(DECK, 1, 1, [{ path: [0], tag: 'rect' }, { path: [3], tag: 'g' }, { path: [3, 0], tag: 'rect' }]);
  assert.equal(classes(out), 'b');
  assert.doesNotMatch(out, /<line/, 'the wire went with its nodes');
  assert.throws(() => removeNestedElements(DECK, 1, 1, [{ path: [9], tag: 'rect' }]), (e) => e.code === 'STALE');
  assert.throws(() => removeNestedElements(DECK, 1, 1, []), /bad nodes/);
});

test('several nodes duplicated in ONE write: each right after itself, each copy\'s path where it ends up', () => {
  const out = duplicateDiagramNodes(DECK, 1, 1, [{ path: [3], tag: 'g' }, { path: [0], tag: 'rect' }]);
  assert.equal(classes(out.html), 'aabcc');
  assert.deepEqual(out.added.map((a) => a.path), [[5], [1]], 'the copy of c moved one along by the copy of a before it');
  assert.match(out.added[0].html, /^<g class="c" data-node="c-2"/, 'its name its own');
});

test('a group move is one write of up to 600 edits', () => {
  const edits = Array.from({ length: 300 }, () => ({ path: [0], tag: 'rect', attr: 'x', value: 1 }));
  assert.match(setElementGeometry(DECK, 1, 1, edits), /class="a" data-node="a" x="1"/);
  assert.throws(() => setElementGeometry(DECK, 1, 1, Array(601).fill(edits[0])), /bad edits/);
});

test('POST remove with paths and POST shape duplicate with paths: one undo entry each', async (t) => {
  const deck = path.join(tmp('diagram-several', t), 'talk.html');
  writeFileSync(deck, DECK);
  const history = createHistory();
  const readDeck = () => readFileSync(deck, 'utf8');
  const applyEdit = (change, before = readDeck()) => { const next = change(before); if (next === before) return false; history.record(before); writeFileSync(deck, next); return true; };
  const routes = new Map();
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: deck, quiet: () => {}, broadcast: () => {} });
  const call = async (key, body) => { const sent = {}; await routes.get(key)({ body: JSON.stringify(body), json: (code, obj) => { sent.code = code; sent.body = obj; } }); return sent; };
  const dup = await call('POST /deck/edit/element/shape', { slide: 1, index: 1, op: 'duplicate', paths: [{ path: [0], tag: 'rect' }, { path: [2], tag: 'rect' }] });
  assert.equal(dup.code, 200);
  assert.deepEqual(dup.body.added.map((a) => a.path), [[1], [4]]);
  assert.equal(history.counts().undo, 1);
  const rm = await call('POST /deck/edit/element/remove', { slide: 1, index: 1, paths: [{ path: [1], tag: 'rect' }, { path: [4], tag: 'rect' }] });
  assert.equal(rm.code, 200);
  assert.equal(classes(readDeck()), 'abc');
  assert.equal(history.counts().undo, 2);
});
