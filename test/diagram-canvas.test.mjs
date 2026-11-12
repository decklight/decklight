// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A diagram's canvas (SPEC SVG_DIAGRAMS): more room for the drawing from an
// edge, or less, never past what is drawn; the svg's width following, so
// nothing drawn changes size; the room trimmed to an even margin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setDiagramCanvas, createHistory } from '../cli/edit.mjs';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { edgeCanvas, fitCanvas, keptWidth } from '../src/core/canvas.js';
import { tmp } from './helpers.mjs';

const DECK = `<!doctype html><html><body><div class="decklight">
  <section>
    <h2>Flow</h2>
    <svg viewBox="0 0 800 300" width="600" aria-label="flow">
      <rect x="100" y="50" width="200" height="100"/>
    </svg>
    <svg viewbox='0,0,100,50'><circle cx="50" cy="25" r="10"/></svg>
  </section>
</div></body></html>`;
const open = (html, n = 0) => html.match(/<svg[^>]*>/g)[n];

test('the canvas written: the viewBox and the width where they stand, every other byte kept', () => {
  const next = setDiagramCanvas(DECK, 1, 1, { viewBox: { x: 0, y: 0, w: 1000, h: 300 }, width: 750 });
  assert.equal(open(next), '<svg viewBox="0 0 1000 300" width="750" aria-label="flow">');
  assert.equal(next.replace(open(next), ''), DECK.replace(open(DECK), ''));
  const lower = setDiagramCanvas(DECK, 1, 2, { viewBox: { x: -10, y: 0, w: 120.25, h: 50 }, height: 80 });
  assert.equal(open(lower, 1), "<svg viewbox='-10 0 120.3 50' height=\"80\">", 'the casing and the quotes the file wrote it in');
  const none = DECK.replace('<svg viewBox="0 0 800 300" width="600" ', '<svg ');
  assert.match(open(setDiagramCanvas(none, 1, 1, { viewBox: { x: 0, y: 0, w: 10, h: 10 } })), /<svg aria-label="flow" viewBox="0 0 10 10">/);
});

test('refused: a size under 1, something not a number, a width past the bounds, anything but a diagram\'s svg', () => {
  assert.throws(() => setDiagramCanvas(DECK, 1, 1, { viewBox: { x: 0, y: 0, w: 0, h: 10 } }), /at least 1/);
  assert.throws(() => setDiagramCanvas(DECK, 1, 1, { viewBox: { x: 'a', y: 0, w: 10, h: 10 } }), /at least 1/);
  assert.throws(() => setDiagramCanvas(DECK, 1, 1, { viewBox: { x: 0, y: 0, w: 10, h: 10 }, width: 5000 }), /not a width/);
  assert.throws(() => setDiagramCanvas(DECK, 1, 0, { tag: 'h2', viewBox: { x: 0, y: 0, w: 10, h: 10 } }), /not a <h2>/);
  assert.throws(() => setDiagramCanvas(DECK, 1, 1, { tag: 'img', viewBox: { x: 0, y: 0, w: 10, h: 10 } }), (e) => e.code === 'STALE');
  assert.throws(() => setDiagramCanvas(DECK, 1, 1, { path: [0], tag: 'rect', viewBox: { x: 0, y: 0, w: 10, h: 10 } }), /not a <rect>/);
  const chart = DECK.replace('aria-label="flow"', 'data-chart="bar"');
  assert.throws(() => setDiagramCanvas(chart, 1, 1, { viewBox: { x: 0, y: 0, w: 10, h: 10 } }), /chart draws itself/);
});

test('an edge drag: out freely, in no further than the drawing, the opposite edge held', () => {
  const vb = { x: 0, y: 0, w: 800, h: 300 };
  const art = { x: 100, y: 50, w: 200, h: 100 };
  assert.deepEqual(edgeCanvas(vb, 'e', 200, 0, art), { x: 0, y: 0, w: 1000, h: 300 });
  assert.deepEqual(edgeCanvas(vb, 'e', -700, 0, art), { x: 0, y: 0, w: 300, h: 300 }, 'stops at the drawing\'s right');
  assert.deepEqual(edgeCanvas(vb, 'w', -50, 0, art), { x: -50, y: 0, w: 850, h: 300 });
  assert.deepEqual(edgeCanvas(vb, 'w', 500, 0, art), { x: 100, y: 0, w: 700, h: 300 }, 'stops at the drawing\'s left');
  assert.deepEqual(edgeCanvas(vb, 's', 0, -500, art), { x: 0, y: 0, w: 800, h: 150 });
  assert.deepEqual(edgeCanvas(vb, 'n', 0, 80, art), { x: 0, y: 50, w: 800, h: 250 });
  assert.deepEqual(edgeCanvas(vb, 'e', -2000, 0, null), { x: 0, y: 0, w: 1, h: 300 }, 'nothing drawn: down to 1');
});

test('the width follows the room so nothing drawn changes size, until the slide\'s width caps it; a fit is an even margin', () => {
  assert.equal(keptWidth(600, 800, 1000), 750);
  assert.equal(keptWidth(600, 800, 1000, 700), 700, 'capped: from here, more room draws smaller');
  assert.equal(keptWidth(600, 800, 400), 300);
  assert.deepEqual(fitCanvas({ x: 100, y: 50, w: 200, h: 100 }), { x: 90, y: 40, w: 220, h: 120 });
  assert.deepEqual(fitCanvas({ x: 0, y: 0, w: 40, h: 10 }), { x: -8, y: -8, w: 56, h: 26 }, 'eight units at least');
});

test('POST /deck/edit/element/canvas: one undo entry, quiet for the page that asked; stale is a 409', async (t) => {
  const dir = tmp('diagram-canvas', t);
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
  const quiet = []; const told = [];
  const routes = new Map();
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: deck, quiet: (h) => quiet.push(h), broadcast: (e, d) => told.push([e, d]) });
  const call = async (body) => {
    const sent = {};
    await routes.get('POST /deck/edit/element/canvas')({ body: JSON.stringify(body), json: (code, obj) => { sent.code = code; sent.body = obj; } });
    return sent;
  };
  const r = await call({ slide: 1, index: 1, path: [], tag: 'svg', viewBox: { x: 0, y: 0, w: 1000, h: 300 }, width: 750, quiet: true, from: 'p' });
  assert.deepEqual([r.code, r.body.changed, r.body.undo], [200, true, 1]);
  assert.match(readDeck(), /<svg viewBox="0 0 1000 300" width="750"/);
  assert.equal(quiet.length, 1);
  assert.deepEqual(told, [['content', { slide: 1, index: 1, from: 'p' }]]);
  const stale = await call({ slide: 1, index: 1, path: [], tag: 'img', viewBox: { x: 0, y: 0, w: 10, h: 10 } });
  assert.equal(stale.code, 409);
  assert.equal(history.counts().undo, 1);
});
