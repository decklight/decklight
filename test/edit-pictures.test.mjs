// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Pictures after the drop (PRESENTING_EDITING): the transforms that resize a
// picture, change its alt text or its file, put a caption round it and make
// it the slide's background (cli/edit.mjs), and the two routes that put them
// through `applyEdit` (cli/edit-slides.mjs), called as functions the way
// test/edit-slides.test.mjs calls the others.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { createHistory, setElementPicture, setSlideBackground, pictureToBackground, PICTURE_WIDTH, undoMeta, whatWrote } from '../cli/edit.mjs';
import { tmp } from './helpers.mjs';

const DECK = `<!doctype html>
<html><body>
  <div class="decklight">
    <section>
      <h2>Alpha</h2>
      <img src="assets/a.png" alt="a chart" height="300" style="width: 400px; border-color: #fff">
      <div class="columns">
        <figure>
          <img src="assets/b&amp;c.png" alt="">
        </figure>
        <p>words</p>
      </div>
      <aside class="notes">said</aside>
    </section>
    <section data-layout="top" data-background-image="assets/old.jpg" data-background-dim="0.4">
      <h2>Beta</h2>
      <img src="data:image/png;base64,AAAA" alt="inline">
    </section>
  </div>
</body></html>
`;

function harness(t, html = DECK, deps = {}) {
  const dir = tmp('edit-pictures', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, html);
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
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: deck, ...deps });
  return { routes, history, readDeck };
}

async function call(routes, key, body) {
  const sent = {};
  await routes.get(key)({ req: {}, res: {}, url: new URL(`http://x${key.split(' ')[1]}`), body: JSON.stringify(body), json: (code, obj) => { sent.code = code; sent.body = obj; }, CORS: {} });
  return sent;
}

const line = (html, re) => html.split('\n').find((l) => re.test(l));

// ── the transforms ─────────────────────────────────────────────────────────

test('a width is written as the width attribute in deck units, and what would fight it goes', () => {
  const out = setElementPicture(DECK, 1, 1, { width: 512.4 });
  assert.equal(line(out, /assets\/a\.png/), '      <img src="assets/a.png" alt="a chart" style="border-color: #fff" width="512">',
    'a height attribute would stretch it and an inline width would win over it; the rest of the tag stays as it was');
  const natural = setElementPicture(out, 1, 1, { width: null });
  assert.equal(line(natural, /assets\/a\.png/), '      <img src="assets/a.png" alt="a chart" style="border-color: #fff">', 'null is its own size again');
  assert.equal(out.replace(/\n.*assets\/a\.png.*/, ''), DECK.replace(/\n.*assets\/a\.png.*/, ''), 'nothing but that line changed');
});

test('a width outside its bounds, or not a number, is refused and nothing is written', () => {
  for (const width of [PICTURE_WIDTH.min - 1, PICTURE_WIDTH.max + 1, -5, Number.NaN, Infinity, '300', '300px', true, {}]) {
    assert.throws(() => setElementPicture(DECK, 1, 1, { width }), /width/, `${String(width)} was accepted`);
  }
});

test('alt text is any string, escaped into the attribute in its own place; empty says decoration', () => {
  const out = setElementPicture(DECK, 1, 1, { alt: 'Q3 "revenue" <up> & away' });
  assert.match(line(out, /assets\/a\.png/), /<img src="assets\/a\.png" alt="Q3 &quot;revenue&quot; &lt;up&gt; &amp; away" height="300"/);
  assert.match(line(setElementPicture(DECK, 1, 1, { alt: '' }), /assets\/a\.png/), / alt="" /);
  assert.throws(() => setElementPicture(DECK, 1, 1, { alt: 7 }), /alt/);
});

test('a picture inside a figure in the columns is addressed by its path, and a path that lands elsewhere is stale', () => {
  const out = setElementPicture(DECK, 1, 2, { path: [0, 0], tag: 'img', alt: 'second' });
  assert.match(out, /<img src="assets\/b&amp;c\.png" alt="second">/);
  assert.throws(() => setElementPicture(DECK, 1, 2, { path: [1], tag: 'img', alt: 'x' }), (e) => e.code === 'STALE');
  assert.throws(() => setElementPicture(DECK, 1, 2, { path: [1], tag: null, alt: 'x' }), /not a picture: <p>/);
  assert.throws(() => setElementPicture(DECK, 1, 0, { tag: null, alt: 'x' }), /not a picture: <h2>/);
});

test('a new src is only a relative path beside the deck', () => {
  const out = setElementPicture(DECK, 1, 1, { src: 'assets/new one.png' });
  assert.match(line(out, /new one/), /<img src="assets\/new one\.png" alt="a chart" height="300"/, 'its size and alt stay');
  for (const src of ['https://x.org/a.png', '/abs.png', '../up.png', 'a/../../b.png', 'javascript:alert(1)', 'data:image/png;base64,AA', '', 3]) {
    assert.throws(() => setElementPicture(DECK, 1, 1, { src }), /relative path/, `${JSON.stringify(src)} was accepted`);
  }
});

test('a caption wraps the picture in a figure, indented where it stood, and a picture in a figure already is refused', () => {
  const out = setElementPicture(DECK, 1, 1, { caption: 'Revenue <2026>' });
  assert.match(out, /\n {6}<figure>\n {8}<img src="assets\/a\.png"[^\n]*>\n {8}<figcaption>Revenue &lt;2026&gt;<\/figcaption>\n {6}<\/figure>\n {6}<div class="columns">/);
  assert.throws(() => setElementPicture(DECK, 1, 2, { path: [0, 0], caption: 'x' }), /caption already/);
  const oneLine = '<div class="decklight"><section><h2>A</h2><img src="a.png" alt=""></section></div>';
  assert.equal(setElementPicture(oneLine, 1, 1, { caption: 'c' }),
    '<div class="decklight"><section><h2>A</h2><figure><img src="a.png" alt=""><figcaption>c</figcaption></figure></section></div>', 'a one-line slide stays on one line');
});

test('a slide background is set in its own place on the section, and taking it off takes its tuning with it', () => {
  const set = setSlideBackground(DECK, 1, 'assets/sky.jpg');
  assert.match(set, /\n {4}<section data-background-image="assets\/sky\.jpg">\n {6}<h2>Alpha/);
  const swapped = setSlideBackground(DECK, 2, 'assets/new.jpg');
  assert.match(swapped, /<section data-layout="top" data-background-image="assets\/new\.jpg" data-background-dim="0\.4">/, 'replaced where it was, the dim kept');
  const gone = setSlideBackground(DECK, 2, null);
  assert.match(gone, /<section data-layout="top">\n {6}<h2>Beta/, 'no picture: the dim that tuned it means nothing');
  const video = '<div class="decklight"><section data-background-image="a.jpg" data-background-video="v.mp4" data-background-dim="0.5"><h2>V</h2></section></div>';
  assert.match(setSlideBackground(video, 1, null), /<section data-background-video="v\.mp4" data-background-dim="0\.5">/, 'a video still there keeps its dim');
  for (const src of ['https://x.org/a.jpg', '/a.jpg', '../a.jpg', 'blob:x']) assert.throws(() => setSlideBackground(DECK, 1, src), /relative path/);
});

test('a picture made the background leaves the content in the same edit, an emptied figure with it', () => {
  const top = pictureToBackground(DECK, 1, 1);
  assert.equal(top.src, 'assets/a.png');
  assert.match(top.html, /<section data-background-image="assets\/a\.png">/);
  assert.doesNotMatch(top.html, /<img src="assets\/a\.png"/);
  const nested = pictureToBackground(DECK, 1, 2, { path: [0, 0] });
  assert.equal(nested.src, 'assets/b&c.png', 'the file\'s src, its entities read');
  assert.deepEqual(nested.removed, [0], 'the figure held nothing else, so it went too');
  assert.match(nested.html, /<section data-background-image="assets\/b&amp;c\.png">/);
  assert.match(nested.html, /<div class="columns">\n {8}<p>words<\/p>/);
  assert.throws(() => pictureToBackground(DECK, 2, 1), /beside the deck/, 'an inline picture is not a file the deck carries');
});

test('the two routes have labels: the undo toast and the reload line say what they did', () => {
  assert.equal(undoMeta('/deck/edit/element/picture', '{"slide":1}').what, 'picture');
  assert.equal(undoMeta('/deck/edit/slide/background', '{"slide":2}').what, 'slide background');
  assert.equal(whatWrote('/deck/edit/slide/background'), 'slide background set');
});

// ── the routes ─────────────────────────────────────────────────────────────

test('POST /deck/edit/element/picture changes size and alt in ONE undo entry, quiet when asked, every other page told', async (t) => {
  const quiet = []; const told = [];
  const { routes, readDeck, history } = harness(t, DECK, { quiet: (h) => quiet.push(h), broadcast: (e, d) => told.push([e, d]) });
  const r = await call(routes, 'POST /deck/edit/element/picture', { slide: 1, index: 1, width: 300, alt: 'smaller', quiet: true, from: 'page-a' });
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.changed, r.body.inPlace, history.counts().undo], [true, true, 1]);
  assert.match(readDeck(), /<img src="assets\/a\.png" alt="smaller" style="border-color: #fff" width="300">/);
  assert.deepEqual(quiet, [readDeck()]);
  assert.deepEqual(told, [['content', { slide: 1, index: 1, from: 'page-a' }]]);
  const same = await call(routes, 'POST /deck/edit/element/picture', { slide: 1, index: 1, width: 300 });
  assert.equal(same.body.changed, false, 'the same width again writes nothing');
  assert.equal(history.counts().undo, 1);
});

test('POST /deck/edit/element/picture refuses a bad width, a src off the deck and a stale path, and writes nothing', async (t) => {
  const { routes, readDeck } = harness(t);
  const before = readDeck();
  for (const body of [
    { slide: 1, index: 1, width: 2 }, { slide: 1, index: 1, width: 99999 }, { slide: 1, index: 1, width: '40px' },
    { slide: 1, index: 1, src: '/etc/a.png' }, { slide: 1, index: 1, src: 'https://evil.example/a.png' },
    { slide: 1, index: 1, src: '../a.png' }, { slide: 1, index: 1, src: 'data:image/png;base64,AA' },
    { slide: 1, index: 1 }, { slide: 0, index: 1, alt: 'x' }, { slide: 1, index: -1, alt: 'x' },
  ]) {
    const r = await call(routes, 'POST /deck/edit/element/picture', body);
    assert.equal(r.code, 400, `${JSON.stringify(body)} was accepted`);
  }
  const stale = await call(routes, 'POST /deck/edit/element/picture', { slide: 1, index: 2, path: [1], tag: 'img', alt: 'x' });
  assert.equal(stale.code, 409);
  const gone = await call(routes, 'POST /deck/edit/element/picture', { slide: 9, index: 1, alt: 'x' });
  assert.equal(gone.code, 404);
  assert.equal(readDeck(), before, 'a refused write leaves the deck byte for byte alone');
});

test('POST /deck/edit/element/picture replaces the file and keeps size and alt; a caption answers where it went', async (t) => {
  const { routes, readDeck } = harness(t);
  await call(routes, 'POST /deck/edit/element/picture', { slide: 1, index: 1, src: 'assets/a-2.png' });
  assert.match(readDeck(), /<img src="assets\/a-2\.png" alt="a chart" height="300" style="width: 400px; border-color: #fff">/);
  const c = await call(routes, 'POST /deck/edit/element/picture', { slide: 1, index: 1, caption: 'Caption' });
  assert.deepEqual(c.body.caption, { figure: [], img: [0], figcaption: [1] });
  assert.match(readDeck(), /<figure>\n {8}<img src="assets\/a-2\.png"[^\n]*>\n {8}<figcaption>Caption<\/figcaption>\n {6}<\/figure>/);
});

test('POST /deck/edit/slide/background sets, replaces and removes, one undo entry each, and refuses a src off the deck', async (t) => {
  const quiet = []; const told = [];
  const { routes, readDeck, history } = harness(t, DECK, { quiet: (h) => quiet.push(h), broadcast: (e, d) => told.push([e, d]) });
  const set = await call(routes, 'POST /deck/edit/slide/background', { slide: 1, src: 'assets/sky.jpg', quiet: true, from: 'p' });
  assert.deepEqual([set.code, set.body.changed, set.body.inPlace, set.body.src], [200, true, true, 'assets/sky.jpg']);
  assert.match(readDeck(), /<section data-background-image="assets\/sky\.jpg">/);
  assert.deepEqual(told.at(-1), ['content', { slide: 1, index: null, from: 'p' }]);
  const off = await call(routes, 'POST /deck/edit/slide/background', { slide: 1, src: null });
  assert.equal(off.body.inPlace, false, 'not asked for in place: the reload it always was');
  assert.match(readDeck(), /\n {4}<section>\n {6}<h2>Alpha/);
  assert.equal(history.counts().undo, 2);
  const before = readDeck();
  for (const src of ['https://x.org/a.jpg', '/a.jpg', '../a.jpg', 'javascript:x', 7]) {
    const r = await call(routes, 'POST /deck/edit/slide/background', { slide: 1, src });
    assert.equal(r.code, 400, `${JSON.stringify(src)} was accepted`);
  }
  assert.equal((await call(routes, 'POST /deck/edit/slide/background', { slide: 9, src: null })).code, 404);
  assert.equal(readDeck(), before);
});

test('POST /deck/edit/slide/background with take moves the picture there in ONE undo entry', async (t) => {
  const { routes, readDeck, history } = harness(t);
  const r = await call(routes, 'POST /deck/edit/slide/background', { slide: 1, take: { index: 2, path: [0, 0], tag: 'img' } });
  assert.deepEqual([r.code, r.body.src, r.body.removed, history.counts().undo], [200, 'assets/b&c.png', [0], 1]);
  assert.match(readDeck(), /<section data-background-image="assets\/b&amp;c\.png">/);
  assert.doesNotMatch(readDeck(), /<figure>/);
  const stale = await call(routes, 'POST /deck/edit/slide/background', { slide: 1, take: { index: 2, path: [0, 0], tag: 'img' } });
  assert.equal(stale.code, 409, 'the figure is gone: that path is something else now');
  const inline = await call(routes, 'POST /deck/edit/slide/background', { slide: 2, take: { index: 1 } });
  assert.equal(inline.code, 400);
  assert.equal(history.counts().undo, 1);
});

// ── the drag, page side (src/core/pictures.js) ─────────────────────────────

test('a corner drag asks for a whole width, by the axis the pointer went further along, inside its bounds', async () => {
  const { dragWidth, PICTURE_MIN } = await import('../src/core/pictures.js');
  const at = (o) => dragWidth({ w0: 400, dx: 0, dy: 0, perX: 0.5, perY: 0.25, east: true, south: true, max: 1000, ...o });
  assert.equal(at({ dx: 80 }), 560, 'a centred picture grows both ways: 80px of pointer is 160 units at half scale');
  assert.equal(at({ dx: 80, east: false }), 240, 'the west corners grow leftwards');
  assert.equal(at({ dx: 10, dy: 50 }), 600, 'the further axis wins: 50px down at a quarter is 200 units');
  assert.equal(at({ dx: 5000 }), 1000, 'never past what the slide holds');
  assert.equal(at({ dx: -5000 }), PICTURE_MIN, 'never smaller than the server writes');
  assert.equal(at({ dx: 0.3 }), 401, 'whole units');
});
