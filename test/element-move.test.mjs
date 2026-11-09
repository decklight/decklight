// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Moving an element within its slide (PRESENTING_EDITING, Moving): the pure
// transform (tools/deck-html.mjs `moveSlideElement`), the design-system guard
// (`slotMoveProblem`) and the route that puts them through one undo entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { moveSlideElement } from '../tools/deck-html.mjs';
import { slotMoveProblem } from '../cli/design-system-edit.mjs';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { createHistory } from '../cli/edit.mjs';
import { tmp } from './helpers.mjs';

const deck = (slides) => `<!doctype html>\n<html><body>\n  <div class="decklight">\n${slides}\n  </div>\n</body></html>\n`;

const SLIDE = `    <section>
      <h2>Plan</h2>
      <p>First a sentence.</p>
      <ul>
        <li>one</li>
        <li>two</li>
        <li>three</li>
      </ul>
      <aside class="notes">
        <p>Say this.</p>
      </aside>
    </section>`;

test('an element moves down whole lines at a time, the asides staying last', () => {
  const html = deck(SLIDE);
  const { html: out, index } = moveSlideElement(html, 1, 1, { to: 2 });
  assert.equal(index, 2, 'the paragraph is the third child now');
  assert.equal(out, deck(`    <section>
      <h2>Plan</h2>
      <ul>
        <li>one</li>
        <li>two</li>
        <li>three</li>
      </ul>
      <p>First a sentence.</p>
      <aside class="notes">
        <p>Say this.</p>
      </aside>
    </section>`));
  // and back again is the file it was, byte for byte
  assert.equal(moveSlideElement(out, 1, 2, { to: 1 }).html, html);
});

test('the title moves like anything else', () => {
  const { html: out, index } = moveSlideElement(deck(SLIDE), 1, 0, { to: 2 });
  assert.equal(index, 2);
  assert.match(out, /<p>First a sentence\.<\/p>\n {6}<ul>[\s\S]*<\/ul>\n {6}<h2>Plan<\/h2>\n {6}<aside class="notes">/);
});

test('the notes and sources stay where they are: nothing moves onto or past them, and they do not move', () => {
  const html = deck(SLIDE);
  assert.throws(() => moveSlideElement(html, 1, 2, { to: 3 }), (e) => e.code === 'REFUSED' && /notes and sources stay last/.test(e.message));
  assert.throws(() => moveSlideElement(html, 1, 3, { to: 0 }), (e) => e.code === 'REFUSED' && /notes and sources stay/.test(e.message));
  assert.throws(() => moveSlideElement(html, 1, 0, { to: 0 }), (e) => e.code === 'REFUSED' && /already first/.test(e.message));
  assert.throws(() => moveSlideElement(html, 1, 9, { to: 0 }), (e) => e.code === 'STALE');
});

test('a slide written on one line stays on one line', () => {
  const html = deck('    <section><h2>One</h2><p>a</p><p>b</p><aside class="notes"><p>n</p></aside></section>');
  const { html: out, index } = moveSlideElement(html, 1, 2, { to: 1 });
  assert.equal(index, 1);
  assert.equal(out, deck('    <section><h2>One</h2><p>b</p><p>a</p><aside class="notes"><p>n</p></aside></section>'));
});

test('an element keeps its own indentation, and a first child on the section\'s line leaves the lines where they are', () => {
  const odd = deck('    <section>\n      <h2>T</h2>\n          <p>deep</p>\n      <p>flat</p>\n    </section>');
  assert.equal(moveSlideElement(odd, 1, 1, { to: 2 }).html,
    deck('    <section>\n      <h2>T</h2>\n      <p>flat</p>\n          <p>deep</p>\n    </section>'));
  const inline = deck('    <section><h2>T</h2>\n      <p>x</p>\n    </section>');
  assert.equal(moveSlideElement(inline, 1, 0, { to: 1 }).html, deck('    <section><p>x</p>\n      <h2>T</h2>\n    </section>'));
});

test('a list item moves among its own siblings, by its path, and answers its new path', () => {
  const { html: out, index, path: p } = moveSlideElement(deck(SLIDE), 1, 2, { path: [0], tag: 'li', to: 2 });
  assert.equal(index, 2, 'the list stays where it is');
  assert.deepEqual(p, [2]);
  assert.match(out, /<ul>\n {8}<li>two<\/li>\n {8}<li>three<\/li>\n {8}<li>one<\/li>\n {6}<\/ul>/);
  // a nested list's item, two levels down
  const nested = deck('    <section>\n      <ul>\n        <li>a\n          <ul><li>x</li><li>y</li></ul>\n        </li>\n      </ul>\n    </section>');
  const moved = moveSlideElement(nested, 1, 0, { path: [0, 0, 1], tag: 'li', to: 0 });
  assert.deepEqual(moved.path, [0, 0, 0]);
  assert.match(moved.html, /<ul><li>y<\/li><li>x<\/li><\/ul>/);
});

test('a path or a tag the file does not have is stale, never a guess', () => {
  const html = deck(SLIDE);
  assert.throws(() => moveSlideElement(html, 1, 2, { path: [7], tag: 'li', to: 0 }), (e) => e.code === 'STALE');
  assert.throws(() => moveSlideElement(html, 1, 2, { path: [1], tag: 'p', to: 0 }), (e) => e.code === 'STALE' && /<p>.*<li>/.test(e.message));
  assert.throws(() => moveSlideElement(html, 1, 1, { tag: 'ul', to: 2 }), (e) => e.code === 'STALE');
  assert.throws(() => moveSlideElement(html, 1, 2, { path: [2], tag: 'li', to: 3 }), (e) => e.code === 'REFUSED');
});

const TEMPLATED = deck(`    <section data-template="acme/two-col">
      <h2 data-slot="title">T</h2>
      <p data-slot="left">l1</p>
      <p data-slot="left">l2</p>
      <p data-slot="right">r1</p>
    </section>`);

test('on a design-system slide an element moves only within its slot', () => {
  assert.equal(slotMoveProblem(TEMPLATED, 1, 1, 2), null, 'two of the left slot, swapped');
  assert.match(slotMoveProblem(TEMPLATED, 1, 2, 3), /fills the "left" slot[\s\S]*not past the "right" slot's/);
  assert.match(slotMoveProblem(TEMPLATED, 1, 0, 1), /"title" slot/);
  assert.equal(slotMoveProblem(deck(SLIDE), 1, 0, 2), null, 'a plain slide has no slots to keep');
});

function harness(t, html, deps = {}) {
  const dir = tmp('element-move', t);
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
    await routes.get('POST /deck/edit/element/move')({ body: JSON.stringify(body), json: (code, obj) => { sent.code = code; sent.body = obj; } });
    return sent;
  };
  return { call, readDeck, history };
}

test('POST /deck/edit/element/move: one undo entry, the new place in the answer, quiet in place for the page that asked', async (t) => {
  const quiet = [];
  const told = [];
  const { call, readDeck, history } = harness(t, deck(SLIDE), { quiet: (h) => quiet.push(h), broadcast: (event, data) => told.push({ event, data }) });
  const r = await call({ slide: 1, index: 1, to: 2, tag: 'p', quiet: true, from: 'page-a' });
  assert.equal(r.code, 200);
  assert.equal(r.body.index, 2);
  assert.equal(r.body.inPlace, true);
  assert.equal(r.body.undo, 1, 'one undo entry');
  assert.equal(quiet.at(-1), readDeck());
  assert.deepEqual(told.at(-1), { event: 'content', data: { slide: 1, index: 2, from: 'page-a' } });
  assert.equal(history.counts().undo, 1);
  const item = await call({ slide: 1, index: 1, path: [2], tag: 'li', to: 0 });
  assert.deepEqual(item.body.path, [0]);
  assert.equal(item.body.inPlace, false, 'not asked for in place: the ordinary reload');
  assert.equal(quiet.length, 1);
  // refusals are 409s said as sentences; a stale one says it is stale
  const end = await call({ slide: 1, index: 2, to: 3 });
  assert.equal(end.code, 409);
  assert.match(end.body.error, /notes and sources stay last/);
  const stale = await call({ slide: 1, index: 1, path: [9], tag: 'li', to: 0 });
  assert.equal(stale.code, 409);
  assert.equal(stale.body.stale, true);
  const bad = await call({ slide: 1, index: 1 });
  assert.equal(bad.code, 400);
});

test('POST /deck/edit/element/move refuses to take an element out of its template slot', async (t) => {
  const { call, readDeck } = harness(t, TEMPLATED);
  const r = await call({ slide: 1, index: 2, to: 3 });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /moves only among the "left" slot's own elements/);
  assert.equal(readDeck(), TEMPLATED, 'nothing written');
  const ok = await call({ slide: 1, index: 2, to: 1 });
  assert.equal(ok.code, 200);
  assert.match(readDeck(), /l2<\/p>\n {6}<p data-slot="left">l1/);
});
