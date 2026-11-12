// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Front and back in a diagram (SPEC SVG_DIAGRAMS): what covers what is the
// order a diagram's nodes are written in, and so is the order they build in
// unless a key says otherwise. A node moves among its drawn siblings; when the
// diagram builds, every step is frozen first, so the clicks do not change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setDiagramOrder, setSlideBuildOrder, addDiagramShape, createHistory, ORDER_MOVES } from '../cli/edit.mjs';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { tmp } from './helpers.mjs';

const DECK = `<!doctype html><html><body><div class="decklight">
  <section>
    <h2>Layers</h2>
    <svg viewBox="0 0 400 200" data-build="draw">
      <title>three boxes</title>
      <defs><marker id="m"/></defs>
      <g class="a"><rect x="10" y="10" width="80" height="40"/><text x="50" y="30">A</text></g>
      <rect class="b" x="40" y="20" width="80" height="40"/>
      <rect class="c" x="70" y="30" width="80" height="40"/>
    </svg>
  </section>
</div></body></html>`;

const order = (html) => (html.match(/class="([abc])"/g) ?? []).map((m) => m.slice(7, 8)).join('');
const move = (p, to, html = DECK) => setDiagramOrder(html, 1, 1, { path: [p], tag: p === 2 ? 'g' : 'rect', to });

test('to front, forward, backward, to back: among the drawn siblings, its line moving with it', () => {
  assert.deepEqual(ORDER_MOVES, ['front', 'forward', 'backward', 'back']);
  const front = move(2, 'front');
  assert.equal(order(front.html), 'bca');
  assert.deepEqual(front.path, [4]);
  assert.match(front.html, /<rect class="c"[^\n]*\/>\n {6}<g class="a">/, 'whole lines move, at their indentation');
  assert.equal(order(move(4, 'back').html), 'cab');
  assert.deepEqual(move(4, 'back').path, [2], 'behind the shapes, never behind the title and the defs');
  assert.match(move(4, 'back').html, /<defs><marker id="m"\/><\/defs>\n {6}<rect class="c"/);
  assert.equal(order(move(2, 'forward').html), 'bac');
  assert.equal(order(move(4, 'backward').html), 'acb');
});

test('refused: already at that end, something not drawn, a node outside a diagram, an unknown move', () => {
  assert.throws(() => move(4, 'front'), (e) => e.code === 'REFUSED' && /already at the front/.test(e.message));
  assert.throws(() => move(4, 'forward'), (e) => e.code === 'REFUSED');
  assert.throws(() => move(2, 'back'), (e) => e.code === 'REFUSED' && /already at the back/.test(e.message));
  assert.throws(() => setDiagramOrder(DECK, 1, 1, { path: [1], tag: 'defs', to: 'front' }), /not drawn/);
  assert.throws(() => setDiagramOrder(DECK, 1, 1, { path: [], tag: 'svg', to: 'front' }), /inside a diagram/);
  assert.throws(() => setDiagramOrder(DECK, 1, 0, { path: [], tag: 'h2', to: 'front' }), /inside a diagram/);
  assert.throws(() => move(3, 'top'), /front, forward, backward or back/);
  assert.throws(() => setDiagramOrder(DECK, 1, 1, { path: [3], tag: 'circle', to: 'front' }), (e) => e.code === 'STALE');
});

test('freeze: the file\'s own order is stamped, not taken off, so a move after it changes nothing that plays', () => {
  const groups = [[{ index: 1, path: [2] }], [{ index: 1, path: [3] }], [{ index: 1, path: [4] }]];
  assert.deepEqual(setSlideBuildOrder(DECK, 1, groups).orders.map((o) => o.order), [null, null, null], 'as written, unfrozen: nothing stamped');
  const frozen = setSlideBuildOrder(DECK, 1, groups, { freeze: true });
  assert.deepEqual(frozen.orders.map((o) => o.order), ['1', '2', '3']);
  const moved = move(2, 'front', frozen.html).html;
  assert.equal(order(moved), 'bca');
  assert.match(moved, /<g class="a" data-build-order="1">/, 'a, now at the front, still plays first');
  assert.match(moved, /<rect class="c" x="70" y="30" width="80" height="40" data-build-order="3"\/>/);
});

test('a shape added to a diagram whose steps are frozen takes the next key: it plays last, not mid-order', () => {
  const frozen = setSlideBuildOrder(DECK, 1, [[{ index: 1, path: [2] }], [{ index: 1, path: [3] }], [{ index: 1, path: [4] }]], { freeze: true }).html;
  const added = addDiagramShape(frozen, 1, 1, { path: [], kind: 'ellipse' });
  assert.match(added.added.html, /^<ellipse data-build-order="4" /);
  assert.doesNotMatch(addDiagramShape(DECK, 1, 1, { path: [], kind: 'ellipse' }).added.html, /data-build-order/, 'unfrozen, it takes none');
});

function harness(t) {
  const dir = tmp('diagram-order', t);
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

test('POST /deck/edit/element/order: the play order frozen and the node moved in ONE undo entry; an end is a 409', async (t) => {
  const { routes, readDeck, history } = harness(t);
  const groups = [[{ index: 1, path: [2], tag: 'g' }], [{ index: 1, path: [3], tag: 'rect' }], [{ index: 1, path: [4], tag: 'rect' }]];
  const r = await call(routes, 'POST /deck/edit/element/order', { slide: 1, index: 1, path: [2], tag: 'g', to: 'back', groups });
  assert.equal(r.code, 409, 'already at the back');
  assert.equal(history.counts().undo, 0, 'a refusal writes nothing, not even the freeze');
  const ok = await call(routes, 'POST /deck/edit/element/order', { slide: 1, index: 1, path: [2], tag: 'g', to: 'front', groups, quiet: true, from: 'p' });
  assert.equal(ok.code, 200);
  assert.deepEqual(ok.body.path, [4]);
  assert.deepEqual(ok.body.orders.map((o) => o.order), ['1', '2', '3']);
  assert.equal(order(readDeck()), 'bca');
  assert.equal(history.counts().undo, 1);
  // a diagram with no builds: nothing stamped
  const plain = await call(routes, 'POST /deck/edit/element/order', { slide: 1, index: 1, path: [3], tag: 'rect', to: 'back' });
  assert.equal(plain.code, 200);
  assert.deepEqual(plain.body.orders, []);
  const bad = await call(routes, 'POST /deck/edit/element/order', { slide: 1, index: 1, to: 'front' });
  assert.equal(bad.code, 400);
});
