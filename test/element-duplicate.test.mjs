// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Duplicating any element (PRESENTING_EDITING, Duplicate): the pure transform
// (cli/edit.mjs `duplicateSlideElement`) and the route that puts it through
// one undo entry, answering with the copy's markup for the page to show.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { duplicateSlideElement, createHistory, undoMeta } from '../cli/edit.mjs';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { tmp } from './helpers.mjs';

const deck = (slides) => `<!doctype html>\n<html><body>\n  <div class="decklight">\n${slides}\n  </div>\n</body></html>\n`;

const SLIDE = `    <section>
      <h2 id="plan">Plan</h2>
      <ul data-build="fade-up">
        <li>one</li>
        <li id="two">two</li>
      </ul>
      <figure><img src="a.png" alt="A"><figcaption>A</figcaption></figure>
      <aside class="notes">
        <p>Say this.</p>
      </aside>
    </section>`;

test('an element is copied right after itself, on its own lines, without its ids', () => {
  const { html, index, path: p, markup } = duplicateSlideElement(deck(SLIDE), 1, 1);
  assert.equal(index, 2, 'the copy is the next child');
  assert.deepEqual(p, []);
  assert.equal(markup, '<ul data-build="fade-up">\n        <li>one</li>\n        <li>two</li>\n      </ul>');
  assert.equal(html, deck(SLIDE.replace('      <figure>', `      ${markup}\n      <figure>`)));
  // the original keeps its own id
  assert.match(html, /<li id="two">two<\/li>/);
  // the title too, its id dropped from the copy only
  const title = duplicateSlideElement(deck(SLIDE), 1, 0);
  assert.match(title.html, /<h2 id="plan">Plan<\/h2>\n {6}<h2>Plan<\/h2>\n {6}<ul/);
});

test('a node inside an element is copied among its siblings, by its path', () => {
  const { html, index, path: p, markup } = duplicateSlideElement(deck(SLIDE), 1, 2, { path: [0], tag: 'img' });
  assert.equal(index, 2, 'the figure stays where it is');
  assert.deepEqual(p, [1]);
  assert.equal(markup, '<img src="a.png" alt="A">');
  assert.match(html, /<figure><img src="a.png" alt="A"><img src="a.png" alt="A"><figcaption>/, 'inline, as the original stands');
});

test('a copied diagram is a second diagram: its node names its own, its inner ids kept for its own arrowheads', () => {
  const svg = `    <section>
      <svg viewBox="0 0 100 50" id="flow">
        <defs><marker id="arr"/></defs>
        <rect data-node="api"/><rect data-node="db"/>
        <line data-from="api" data-to="db" marker-end="url(#arr)"/>
      </svg>
    </section>`;
  const { markup } = duplicateSlideElement(deck(svg), 1, 0);
  assert.match(markup, /^<svg viewBox="0 0 100 50">/, 'the svg\'s own id goes');
  assert.match(markup, /<marker id="arr"\/>/, 'the ids inside stay: the engine scopes them per diagram');
  assert.match(markup, /data-node="api-2"[\s\S]*data-node="db-2"[\s\S]*data-from="api-2" data-to="db-2"/);
});

test('the notes, a stale tag or a path the file does not have are refused, never a guess', () => {
  const html = deck(SLIDE);
  assert.throws(() => duplicateSlideElement(html, 1, 3), (e) => e.code === 'REFUSED' && /notes/.test(e.message));
  assert.throws(() => duplicateSlideElement(html, 1, 1, { tag: 'p' }), (e) => e.code === 'STALE');
  assert.throws(() => duplicateSlideElement(html, 1, 1, { path: [5], tag: 'li' }), (e) => e.code === 'STALE');
  assert.throws(() => duplicateSlideElement(html, 1, 9), /no element at index 9/);
});

function harness(t, html, deps = {}) {
  const dir = tmp('element-duplicate', t);
  const file = path.join(dir, 'talk.html');
  writeFileSync(file, html);
  const history = createHistory();
  const readDeck = () => readFileSync(file, 'utf8');
  const applyEdit = (change, before = readDeck()) => {
    const next = typeof change === 'function' ? change(before) : change;
    if (next === before) return false;
    history.record(before);
    writeFileSync(file, next);
    return true;
  };
  const routes = new Map();
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: file, ...deps });
  const call = async (body) => {
    const sent = {};
    await routes.get('POST /deck/edit/element/duplicate')({ body: JSON.stringify(body), json: (code, obj) => { sent.code = code; sent.body = obj; } });
    return sent;
  };
  return { call, readDeck, history };
}

test('POST /deck/edit/element/duplicate: one undo entry, the copy and its place in the answer, quiet for the page that asked', async (t) => {
  const quiet = [];
  const told = [];
  const { call, readDeck, history } = harness(t, deck(SLIDE), { quiet: (h) => quiet.push(h), broadcast: (event, data) => told.push({ event, data }) });
  const r = await call({ slide: 1, index: 0, tag: 'h2', quiet: true, from: 'page-a' });
  assert.equal(r.code, 200);
  assert.equal(r.body.index, 1);
  assert.equal(r.body.html, '<h2>Plan</h2>');
  assert.equal(r.body.inPlace, true);
  assert.equal(r.body.undo, 1, 'one undo entry');
  assert.equal(history.counts().undo, 1);
  assert.equal(quiet.at(-1), readDeck());
  assert.deepEqual(told.at(-1), { event: 'content', data: { slide: 1, index: 1, from: 'page-a' } });
  assert.deepEqual(undoMeta('/deck/edit/element/duplicate', JSON.stringify({ slide: 1 })), { what: 'duplicate', slide: 1 });
  const nested = await call({ slide: 1, index: 2, path: [1], tag: 'li' });
  assert.deepEqual(nested.body.path, [2]);
  assert.equal(nested.body.inPlace, false, 'not asked for in place: the ordinary reload');
  const notes = await call({ slide: 1, index: 4 });
  assert.equal(notes.code, 409);
  const stale = await call({ slide: 1, index: 0, tag: 'p' });
  assert.equal(stale.code, 409);
  assert.equal(stale.body.stale, true);
  const missing = await call({ slide: 1, index: 40 });
  assert.equal(missing.code, 404);
  const bad = await call({ slide: 1, index: 'x' });
  assert.equal(bad.code, 400);
  assert.equal(history.counts().undo, 2, 'a refusal writes nothing');
});
