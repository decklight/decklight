// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The slide-mutation routes (cli/edit-slides.mjs), called as functions.
//
// Every other test of this surface boots the whole edit server, waits for a
// URL to appear on its stdout and talks to it over a socket — ten seconds and
// a spawned process to prove that `data-layout="centered"` reached the file.
// These handlers were lifted out of editMain precisely so they would not need
// any of that: they take `readDeck`, `applyEdit`, `history` and `deckPath` and
// nothing else, so a temp deck and a fake `json` are the whole harness, and a
// regression in one of them is milliseconds away instead of a server boot.
//
// What is NOT tested here is the dispatch — the table, the CSRF gate, the body
// read. That is the server's half and test/edit.test.mjs still holds it over a
// real socket, which is the only place it can honestly be checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { createHistory, setSlideNotes, setSlideSources, notesTextToAside } from '../cli/edit.mjs';
import { tmp } from './helpers.mjs';

const DECK = `<!doctype html>
<html><body>
  <div class="decklight">
    <section>
      <h2>Alpha</h2>
      <ul><li>one</li></ul>
    </section>
    <section data-layout="centered">
      <h2>Beta</h2>
    </section>
  </div>
</body></html>
`;

/**
 * A deck on disk and the four bindings the handlers are given, wired exactly
 * as editMain wires them — `applyEdit` snapshots onto the history and writes,
 * and answers whether anything changed, and `deckPath` is the deck itself,
 * which is what /deck/edit/asset saves an image beside.
 */
function harness(t, html = DECK, deps = {}) {
  const dir = tmp('edit-slides', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, html);
  const history = createHistory();
  const readDeck = () => readFileSync(deck, 'utf8');
  const applyEdit = (change, before = readDeck(), also = null) => {
    const next = typeof change === 'function' ? change(before) : change;
    if (next === before) return false;
    history.record(also ? { deck: before, ...also } : before);
    writeFileSync(deck, next);
    return true;
  };
  const routes = new Map();
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: deck, ...deps });
  return { routes, history, readDeck, deck, dir };
}

/** Call one route the way the dispatcher does: a fake `json`, no socket. */
async function call(routes, key, { body, query = '' } = {}) {
  const handler = routes.get(key);
  assert.ok(handler, `no handler registered for ${key}`);
  const sent = {};
  const json = (code, obj) => { sent.code = code; sent.body = obj; };
  await handler({
    req: {},
    res: {},
    url: new URL(`http://x${key.split(' ')[1]}${query}`),
    body: body === undefined ? '' : JSON.stringify(body),
    json,
    CORS: {},
  });
  return sent;
}

test('every slide-mutation route the server dispatches is registered here', () => {
  const { routes } = harness();
  assert.deepEqual([...routes.keys()].sort(), [
    'GET /deck/edit/element/source',
    'GET /deck/edit/find',
    'POST /deck/edit/asset',
    'POST /deck/edit/concepts',
    'POST /deck/edit/element/build',
    'POST /deck/edit/element/canvas',
    'POST /deck/edit/element/concept',
    'POST /deck/edit/element/concepts',
    'POST /deck/edit/element/connector',
    'POST /deck/edit/element/content',
    'POST /deck/edit/element/duplicate',
    'POST /deck/edit/element/effect',
    'POST /deck/edit/element/geometry',
    'POST /deck/edit/element/image',
    'POST /deck/edit/element/insert',
    'POST /deck/edit/element/join',
    'POST /deck/edit/element/move',
    'POST /deck/edit/element/options',
    'POST /deck/edit/element/order',
    'POST /deck/edit/element/paste',
    'POST /deck/edit/element/picture',
    'POST /deck/edit/element/remove',
    'POST /deck/edit/element/shape',
    'POST /deck/edit/element/style',
    'POST /deck/edit/element/text',
    'POST /deck/edit/narration',
    'POST /deck/edit/replace',
    'POST /deck/edit/slide',
    'POST /deck/edit/slide/attr',
    'POST /deck/edit/slide/background',
    'POST /deck/edit/slide/builds',
    'POST /deck/edit/slide/face',
    'POST /deck/edit/slide/hidden',
    'POST /deck/edit/slide/layout',
    'POST /deck/edit/slide/notes',
    'POST /deck/edit/slide/sources',
    'POST /deck/edit/slide/template',
    'POST /deck/edit/timings',
  ], 'a route that leaves this list has left the edit server too');
});

test('POST /deck/edit/element/build sets a node\'s build settings in one undo entry, and a stale path is a 409', async (t) => {
  const { routes, readDeck } = harness(t);
  const before = readDeck();
  const r = await call(routes, 'POST /deck/edit/element/build', { body: { slide: 1, index: 0, effect: 'zoom', animate: 'pulse' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.changed, true);
  assert.equal(r.body.undo, 1, 'both attributes, one step of the undo history');
  assert.match(readDeck(), /data-build="zoom"[^>]*data-animate="pulse"/);
  assert.notEqual(readDeck(), before);
  const again = await call(routes, 'POST /deck/edit/element/build', { body: { slide: 1, index: 0, effect: 'zoom' } });
  assert.equal(again.body.changed, false, 'the same setting again writes nothing');
  const gone = await call(routes, 'POST /deck/edit/element/build', { body: { slide: 1, index: 0, path: [9], effect: 'fade' } });
  assert.equal(gone.code, 409);
});

test('POST /deck/edit/slide/builds stamps the slide\'s order in one undo entry, and answers each node\'s order', async (t) => {
  const { routes, readDeck } = harness(t);
  const deck = readDeck();
  const sec = deck.slice(deck.indexOf('<section'), deck.indexOf('</section>'));
  assert.ok(sec, 'the harness deck has a first slide');
  // the first two elements of slide 1, the second first
  const r = await call(routes, 'POST /deck/edit/slide/builds', { body: { slide: 1, groups: [[{ index: 1 }], [{ index: 0 }]] } });
  assert.equal(r.code, 200);
  assert.equal(r.body.undo, 1);
  assert.deepEqual(r.body.orders.map((o) => [o.index, o.order]), [[1, '1'], [0, '2']]);
  assert.equal((readDeck().match(/data-build-order=/g) || []).length, 2);
  const back = await call(routes, 'POST /deck/edit/slide/builds', { body: { slide: 1, groups: [[{ index: 0 }], [{ index: 1 }]] } });
  assert.deepEqual(back.body.orders.map((o) => o.order), [null, null]);
  assert.equal(readDeck(), deck, 'the file\'s own order leaves the file as it was');
  const bad = await call(routes, 'POST /deck/edit/slide/builds', { body: { slide: 1, groups: [[{ index: 0, path: [42] }]] } });
  assert.equal(bad.code, 409);
});

test('several selected: remove, duplicate, move and restyle each take items and are ONE undo entry', async (t) => {
  const deck = '<!doctype html>\n<html><body>\n  <div class="decklight">\n    <section>\n      <h2>T</h2>\n      <p>a</p>\n      <p>b</p>\n      <p>c</p>\n    </section>\n  </div>\n</body></html>\n';
  const { routes, readDeck, history } = harness(t, deck);
  const undoes = () => history.counts().undo;
  let r = await call(routes, 'POST /deck/edit/element/duplicate', { body: { slide: 1, items: [{ index: 1 }, { index: 3 }], quiet: true } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.copies, [{ index: 2, html: '<p>a</p>' }, { index: 5, html: '<p>c</p>' }]);
  assert.equal(undoes(), 1);
  r = await call(routes, 'POST /deck/edit/element/move', { body: { slide: 1, items: [{ index: 4 }, { index: 5 }], dir: -1 } });
  assert.deepEqual(r.body.indices, [3, 4]);
  assert.equal(undoes(), 2);
  r = await call(routes, 'POST /deck/edit/element/style', { body: { slide: 1, items: [{ index: 1, edits: [{ path: [], prop: 'color', value: '#ff0000' }] }, { index: 2, edits: [{ path: [], prop: 'color', value: '#ff0000' }] }] } });
  assert.equal(r.code, 200);
  assert.equal((readDeck().match(/color: #ff0000/g) || []).length, 2);
  assert.equal(undoes(), 3);
  r = await call(routes, 'POST /deck/edit/element/remove', { body: { slide: 1, items: [{ index: 1 }, { index: 2 }, { index: 3 }] } });
  assert.equal(r.code, 200);
  assert.equal(undoes(), 4, 'three removed, one entry');
  assert.equal((readDeck().match(/<p/g) || []).length, 2);
  // a stale page and a move that cannot happen are 409s, and write nothing
  const before = readDeck();
  r = await call(routes, 'POST /deck/edit/element/remove', { body: { slide: 1, items: [{ index: 1, tag: 'ul' }] } });
  assert.equal(r.code, 409);
  r = await call(routes, 'POST /deck/edit/element/move', { body: { slide: 1, items: [{ index: 0 }], dir: -1 } });
  assert.equal(r.code, 409);
  assert.equal(readDeck(), before);
});

test('POST /deck/edit/element/join puts the joined block where the first stood and takes the others out, one undo', async (t) => {
  const deck = '<!doctype html>\n<html><body>\n  <div class="decklight">\n    <section>\n      <h2>T</h2>\n      <p>a</p>\n      <p>b</p>\n    </section>\n  </div>\n</body></html>\n';
  const { routes, readDeck, history } = harness(t, deck);
  const r = await call(routes, 'POST /deck/edit/element/join', { body: { slide: 1, items: [{ index: 1, tag: 'p' }, { index: 2, tag: 'p' }], html: '<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.index, 1);
  assert.equal(history.counts().undo, 1);
  assert.match(readDeck(), /<h2>T<\/h2>\n {6}<ul>\n {8}<li>a<\/li>\n {8}<li>b<\/li>\n {6}<\/ul>\n {4}<\/section>/);
  const one = await call(routes, 'POST /deck/edit/element/join', { body: { slide: 1, items: [{ index: 1 }], html: '<p>x</p>' } });
  assert.equal(one.code, 400, 'one element is not a join');
});

test('POST /deck/edit/slide/notes writes the aside and leaves one undo entry behind', async (t) => {
  const { routes, readDeck, history } = harness(t);
  const r = await call(routes, 'POST /deck/edit/slide/notes', { body: { slide: 1, text: 'say this [click] then this' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.undo, 1, 'the write must be one step of the ONE undo history');
  const html = readDeck();
  assert.match(html, /<aside class="notes">/, 'the aside never reached the file');
  assert.match(html, /<p>say this<\/p>/);
  assert.match(html, /<p>\[click\]<\/p>/, 'the click marker is its own paragraph, written in brackets (SPEC PRESENTING)');
  assert.equal(history.counts().redo, 0, 'a fresh edit clears the redo stack');
});

test('POST /deck/edit/slide/notes says whether it wrote: the same notes again is `changed: false`, and no undo entry (#646)', async (t) => {
  const { routes, history } = harness(t);
  const first = await call(routes, 'POST /deck/edit/slide/notes', { body: { slide: 1, text: 'Say this.' } });
  assert.equal(first.body.changed, true);
  const again = await call(routes, 'POST /deck/edit/slide/notes', { body: { slide: 1, text: 'Say this.  ' } });
  assert.deepEqual([again.code, again.body.ok, again.body.changed], [200, true, false], 'normalises to the same bytes: nothing written, so no reload is coming');
  assert.equal(history.counts().undo, 1, 'a write that did not happen is not an undo step');
});

test('notes and sources are the author\'s text: $1, $&, $` and $\' are written literally, never as replacement patterns (#646)', () => {
  const text = 'Costs $1 per call, $& more, $` before and $\' after — $12,000 in all.';
  const deckWith = '<div class="decklight">\n    <section><h2>A</h2>\n      <aside class="notes"><p>Old notes, once.</p></aside>\n    </section>\n</div>';
  const deckWithout = '<div class="decklight">\n    <section><h2>A</h2>\n    </section>\n</div>';
  for (const html of [deckWith, deckWithout]) {
    const out = setSlideNotes(html, 1, notesTextToAside(text));
    assert.ok(out.includes('Costs $1 per call, $&amp; more') || out.includes('Costs $1 per call, $& more'), out);
    assert.match(out, /\$` before and \$' after — \$12,000 in all\./);
    assert.equal((out.match(/Old notes, once\./g) ?? []).length, 0, 'the old notes are replaced, never spliced back in where $1 was typed');
    assert.equal((out.match(/<aside class="notes">/g) ?? []).length, 1);
  }
  const src = setSlideSources(deckWithout, 1, `<ul><li>Revenue grew $1M — see $& and $' and $\`</li></ul>`);
  assert.match(src, /Revenue grew \$1M — see \$& and \$' and \$`/);
  const again = setSlideSources(src, 1, '<ul><li>Now $1 and $&</li></ul>');
  assert.match(again, /Now \$1 and \$&/);
  assert.doesNotMatch(again, /Revenue grew/, 'replaced, not spliced');
});

test('POST /deck/edit/slide/notes saves in place: a quiet write, and every page sent the slide\'s new notes, never a reload', async (t) => {
  const quiet = [];
  const sent = [];
  const { routes, readDeck } = harness(t, DECK, { quiet: (html) => quiet.push(html), broadcast: (e, d) => sent.push([e, d]) });
  const r = await call(routes, 'POST /deck/edit/slide/notes', { body: { slide: 1, text: 'Said here.', from: 'page-1' } });
  assert.deepEqual([r.body.changed, r.body.inPlace], [true, true]);
  assert.deepEqual(quiet, [readDeck()], 'the bytes written are the quiet ones: the watcher skips their reload');
  assert.deepEqual(sent, [['notes', { slide: 1, aside: '<p>Said here.</p>', from: 'page-1' }]]);
  const again = await call(routes, 'POST /deck/edit/slide/notes', { body: { slide: 1, text: 'Said here.' } });
  assert.equal(again.body.changed, false);
  assert.equal(sent.length, 1, 'nothing written, nothing sent');
});

test('POST /deck/edit/slide/layout with quiet saves in place: a quiet write, a layout event to every page, never a reload', async (t) => {
  const quiet = [];
  const sent = [];
  const { routes, readDeck } = harness(t, DECK, { quiet: (html) => quiet.push(html), broadcast: (e, d) => sent.push([e, d]) });
  const r = await call(routes, 'POST /deck/edit/slide/layout', { body: { slide: 1, layout: 'split', quiet: true, from: 'page-1' } });
  assert.deepEqual([r.body.changed, r.body.inPlace], [true, true]);
  assert.deepEqual(quiet, [readDeck()], 'the bytes written are the quiet ones: the watcher skips their reload');
  assert.deepEqual(sent, [['layout', { slide: 1, layout: 'split', from: 'page-1' }]]);
  const again = await call(routes, 'POST /deck/edit/slide/layout', { body: { slide: 1, layout: 'split', quiet: true } });
  assert.deepEqual([again.body.changed, again.body.inPlace], [false, false], 'nothing written, nothing sent');
  assert.equal(sent.length, 1);
  // without quiet, the write reloads as any other does
  const loud = await call(routes, 'POST /deck/edit/slide/layout', { body: { slide: 1, layout: 'centered' } });
  assert.deepEqual([loud.body.changed, loud.body.inPlace], [true, false]);
  assert.equal(quiet.length, 1, 'not a quiet write');
  assert.equal(sent.length, 1, 'and no event — the reload carries it');
});

const CONCEPT_DECK = `<!doctype html>
<html><head>
<script type="application/json" data-decklight-config>
{
  "decklight": "0.9.0"
}
</script>
</head><body>
  <div class="decklight">
    <section>
      <h2>Diagram</h2>
      <svg viewBox="0 0 100 100"><g><rect data-concept="agent" x="1" y="1" width="9" height="9"/><text x="2" y="8">A</text></g></svg>
    </section>
  </div>
</body></html>
`;

test('POST /deck/edit/element/concept sets a shape\'s data-concept, takes it off, and refuses a path that lands elsewhere', async (t) => {
  const { routes, readDeck, history } = harness(t, CONCEPT_DECK);
  const off = await call(routes, 'POST /deck/edit/element/concept', { body: { slide: 1, index: 1, path: [0, 0], tag: 'rect', concept: null } });
  assert.deepEqual([off.code, off.body.ok, off.body.changed, off.body.undo], [200, true, true, 1]);
  assert.match(readDeck(), /<rect x="1" y="1" width="9" height="9"\/>/);
  const on = await call(routes, 'POST /deck/edit/element/concept', { body: { slide: 1, index: 1, path: [0, 0], tag: 'rect', concept: 'tools' } });
  assert.deepEqual([on.body.changed, on.body.undo], [true, 2]);
  assert.match(readDeck(), /<rect x="1" y="1" width="9" height="9" data-concept="tools"\/>/);
  const stale = await call(routes, 'POST /deck/edit/element/concept', { body: { slide: 1, index: 1, path: [0, 0], tag: 'circle', concept: 'x' } });
  assert.equal(stale.code, 409);
  assert.match(stale.body.error, /reload/);
  assert.equal(history.counts().undo, 2, 'a refusal records nothing');
});

const TWO_DIAGRAMS = `<!doctype html>
<html><head><title>t</title></head><body>
  <div class="decklight">
    <section>
      <h2>One</h2>
      <svg viewBox="0 0 100 100"><rect x="1" y="1" width="9" height="9"/><text x="2" y="8">Agent</text></svg>
    </section>
    <section>
      <h2>Two</h2>
      <svg viewBox="0 0 100 100"><g><rect x="1" y="1" width="9" height="9"/><text x="2" y="8">Agent</text></g></svg>
    </section>
  </div>
</body></html>
`;

test('POST /deck/edit/element/concepts puts shapes on several slides into one concept in ONE undo entry, and a stale one refuses the whole batch', async (t) => {
  const { routes, readDeck, history } = harness(t, TWO_DIAGRAMS);
  const items = [{ slide: 1, index: 1, path: [0], tag: 'rect' }, { slide: 2, index: 1, path: [0, 0], tag: 'rect' }];
  const on = await call(routes, 'POST /deck/edit/element/concepts', { body: { items, concept: 'agent' } });
  assert.deepEqual([on.code, on.body.ok, on.body.changed, on.body.count, on.body.undo], [200, true, true, 2, 1], 'one write, one undo entry');
  assert.equal(readDeck().match(/<rect x="1" y="1" width="9" height="9" data-concept="agent"\/>/g)?.length, 2);
  const off = await call(routes, 'POST /deck/edit/element/concepts', { body: { items, concept: null } });
  assert.deepEqual([off.body.changed, off.body.undo], [true, 2]);
  assert.doesNotMatch(readDeck(), /data-concept/);
  // the second item names a circle the file does not have: nothing is written
  const before = readDeck();
  const stale = await call(routes, 'POST /deck/edit/element/concepts', { body: { items: [items[0], { ...items[1], tag: 'circle' }], concept: 'agent' } });
  assert.equal(stale.code, 409);
  assert.equal(readDeck(), before, 'the first item was not written either');
  assert.equal(history.counts().undo, 2, 'a refusal records nothing');
  // a payload with no items is a refusal, not a no-op
  await assert.rejects(call(routes, 'POST /deck/edit/element/concepts', { body: { items: [], concept: 'agent' } }));
});

test('POST /deck/edit/element/text changes a diagram label\'s words, one undo entry, and refuses a label the file no longer says', async (t) => {
  const { routes, readDeck, history } = harness(t, CONCEPT_DECK);
  const ok = await call(routes, 'POST /deck/edit/element/text', { body: { slide: 1, index: 1, path: [0, 1], tag: 'text', was: 'A', text: 'Agent' } });
  assert.deepEqual([ok.code, ok.body.ok, ok.body.changed, ok.body.undo], [200, true, true, 1]);
  assert.match(readDeck(), /<rect data-concept="agent" x="1" y="1" width="9" height="9"\/><text x="2" y="8">Agent<\/text>/);
  const stale = await call(routes, 'POST /deck/edit/element/text', { body: { slide: 1, index: 1, path: [0, 1], tag: 'text', was: 'A', text: 'B' } });
  assert.equal(stale.code, 409);
  assert.match(stale.body.error, /reload/);
  assert.equal(history.counts().undo, 1, 'a refusal records nothing');
});

test('POST /deck/edit/element/remove with a path takes one node out of a diagram, its line with it, and refuses a stale one', async (t) => {
  const deck = CONCEPT_DECK.replace('<g><rect data-concept="agent" x="1" y="1" width="9" height="9"/><text x="2" y="8">A</text></g>',
    '<g>\n        <rect data-concept="agent" x="1" y="1" width="9" height="9"/>\n        <text x="2" y="8">A</text>\n      </g>');
  const { routes, readDeck, history } = harness(t, deck);
  const stale = await call(routes, 'POST /deck/edit/element/remove', { body: { slide: 1, index: 1, path: [0, 0], tag: 'text' } });
  assert.equal(stale.code, 409);
  assert.equal(history.counts().undo, 0, 'a refusal records nothing');
  const ok = await call(routes, 'POST /deck/edit/element/remove', { body: { slide: 1, index: 1, path: [0, 0], tag: 'rect' } });
  assert.deepEqual([ok.code, ok.body.changed, ok.body.undo], [200, true, 1]);
  assert.match(readDeck(), /<g>\n {8}<text x="2" y="8">A<\/text>\n {6}<\/g>/, 'the rect and its line are gone, the label and the group stay');
  assert.match(readDeck(), /<svg viewBox="0 0 100 100">/);
});

test('POST /deck/edit/element/style asked in place is quiet: no reload here, every other page told', async (t) => {
  const quiet = [];
  const sent = [];
  const { routes, readDeck } = harness(t, CONCEPT_DECK, { quiet: (html) => quiet.push(html), broadcast: (e, d) => sent.push([e, d]) });
  const edit = { path: [0, 1], tag: 'text', prop: 'font-size', value: '20px' };
  const r = await call(routes, 'POST /deck/edit/element/style', { body: { slide: 1, index: 1, edits: [edit], quiet: true, from: 'page-a' } });
  assert.equal(r.body.changed, true);
  assert.deepEqual(quiet, [readDeck()], 'the write the watcher is told to skip is the file as written');
  assert.deepEqual(sent, [['styles', { slide: 1, index: 1, from: 'page-a' }]]);
  await call(routes, 'POST /deck/edit/element/style', { body: { slide: 1, index: 1, edits: [{ ...edit, value: '22px' }] } });
  assert.equal(quiet.length, 1, 'not asked in place: the ordinary reload');
});

test('POST /deck/edit/element/style: a pasted style carries its concept, in the same edit (one undo)', async (t) => {
  const { routes, readDeck, history } = harness(t, CONCEPT_DECK);
  const r = await call(routes, 'POST /deck/edit/element/style', { body: { slide: 1, index: 1,
    edits: [{ path: [0, 1], tag: 'text', prop: 'font-weight', value: '700' }],
    concept: { path: [0, 0], tag: 'rect', value: 'tools' } } });
  assert.deepEqual([r.code, r.body.changed, r.body.undo], [200, true, 1], 'the style and the concept are ONE undo entry');
  assert.match(readDeck(), /<rect data-concept="tools" x="1"/);
  assert.match(readDeck(), /<text x="2" y="8" style="font-weight: 700">A<\/text>/);
  // the concept alone (a paste whose colours already match), and taken off
  const off = await call(routes, 'POST /deck/edit/element/style', { body: { slide: 1, index: 1, edits: [], concept: { path: [0, 0], tag: 'rect', value: null } } });
  assert.equal(off.body.changed, true);
  assert.match(readDeck(), /<rect x="1" y="1"/);
  assert.equal(history.counts().undo, 2);
  // a concept where the file has another tag is stale, and nothing is written
  const before = readDeck();
  const stale = await call(routes, 'POST /deck/edit/element/style', { body: { slide: 1, index: 1,
    edits: [{ path: [0, 1], tag: 'text', prop: 'font-weight', value: '400' }], concept: { path: [0, 1], tag: 'rect', value: 'x' } } });
  assert.equal(stale.code, 409);
  assert.equal(readDeck(), before, 'the style edit before the stale concept is not written either');
  // neither edits nor a concept is nothing to do
  await assert.rejects(call(routes, 'POST /deck/edit/element/style', { body: { slide: 1, index: 1, edits: [] } }), /bad edits/);
});

test('POST /deck/edit/element/content asked in place is quiet: the page keeps what it typed, every other page told', async (t) => {
  const quiet = [];
  const sent = [];
  const { routes, readDeck } = harness(t, DECK, { quiet: (html) => quiet.push(html), broadcast: (e, d) => sent.push([e, d]) });
  const r = await call(routes, 'POST /deck/edit/element/content', { body: { slide: 1, index: 0, html: '<h2>Alpha, typed</h2>', quiet: true, from: 'page-a' } });
  assert.equal(r.body.changed, true);
  assert.match(readDeck(), /<h2>Alpha, typed<\/h2>/);
  assert.deepEqual(quiet, [readDeck()], 'the write the watcher is told to skip is the file as written');
  assert.deepEqual(sent, [['content', { slide: 1, index: 0, from: 'page-a' }]]);
  const same = await call(routes, 'POST /deck/edit/element/content', { body: { slide: 1, index: 0, html: '<h2>Alpha, typed</h2>', quiet: true, from: 'page-a' } });
  assert.equal(same.body.changed, false);
  assert.equal(sent.length, 1, 'nothing written, nothing sent');
  await call(routes, 'POST /deck/edit/element/content', { body: { slide: 1, index: 0, html: '<h2>Alpha, again</h2>' } });
  assert.equal(quiet.length, 1, 'not asked in place: the ordinary reload');
});

test('POST /deck/edit/element/text asked in place is quiet: the label shows its words, every other page told', async (t) => {
  const quiet = [];
  const sent = [];
  const { routes, readDeck } = harness(t, CONCEPT_DECK, { quiet: (html) => quiet.push(html), broadcast: (e, d) => sent.push([e, d]) });
  const r = await call(routes, 'POST /deck/edit/element/text', { body: { slide: 1, index: 1, path: [0, 1], tag: 'text', was: 'A', text: 'Agent', quiet: true, from: 'page-b' } });
  assert.equal(r.body.changed, true);
  assert.match(readDeck(), /<text x="2" y="8">Agent<\/text>/);
  assert.deepEqual(quiet, [readDeck()]);
  assert.deepEqual(sent, [['content', { slide: 1, index: 1, from: 'page-b' }]]);
  const stale = await call(routes, 'POST /deck/edit/element/text', { body: { slide: 1, index: 1, path: [0, 1], tag: 'text', was: 'A', text: 'Tools', quiet: true, from: 'page-b' } });
  assert.equal(stale.code, 409, 'a label the file no longer says is refused, and nothing is sent');
  assert.equal(sent.length, 1);
});

test('POST /deck/edit/concepts writes the deck\'s map in place: quiet, and every other page sent a concepts event', async (t) => {
  const quiet = [];
  const sent = [];
  const { routes, readDeck } = harness(t, CONCEPT_DECK, { quiet: (html) => quiet.push(html), broadcast: (e, d) => sent.push([e, d]) });
  const r = await call(routes, 'POST /deck/edit/concepts', { body: { concepts: { agent: 3 }, quiet: true, from: 'page-1' } });
  assert.deepEqual([r.code, r.body.changed, r.body.inPlace], [200, true, true]);
  assert.match(readDeck(), /"decklight": "0.9.0",\n  "concepts": \{ "agent": 3 \}\n\}/);
  assert.deepEqual(quiet, [readDeck()], 'the bytes written are the quiet ones: the watcher skips their reload');
  assert.deepEqual(sent, [['concepts', { concepts: { agent: 3 }, from: 'page-1' }]]);
  const same = await call(routes, 'POST /deck/edit/concepts', { body: { concepts: { agent: 3 }, quiet: true } });
  assert.deepEqual([same.body.changed, same.body.inPlace], [false, false], 'nothing written, nothing sent');
  assert.equal(sent.length, 1);
  const bad = await call(routes, 'POST /deck/edit/concepts', { body: { concepts: { agent: 9 } } });
  assert.equal(bad.code, 409, 'a slot the runtime does not read is refused, not written');
});

test('POST /deck/edit/slide/notes keeps the paragraphs: a blank line is a new <p>, never merged away', async (t) => {
  const { routes, readDeck } = harness(t);
  const r = await call(routes, 'POST /deck/edit/slide/notes', { body: { slide: 1, text: 'First para.\n\nSecond para,\nsame one.\n\n[click]\n\nBeat two.\n\n\nMore of it.' } });
  assert.equal(r.code, 200);
  const aside = /<aside class="notes">([\s\S]*?)<\/aside>/.exec(readDeck())[1];
  assert.deepEqual([...aside.matchAll(/<p>(.*?)<\/p>/g)].map((m) => m[1]),
    ['First para.', 'Second para, same one.', '[click]', 'Beat two.', 'More of it.']);
});

test('POST /deck/edit/slide/notes reads every marker spelling and writes each one in brackets', async (t) => {
  const { routes, readDeck } = harness(t);
  const text = 'one <pause> two ⟨PAUSE⟩⟨PAUSE⟩ [whispers] three\n\n<click>\n\n[CLICK]\n\nfour ⟨SLOW⟩slowly⟨/SLOW⟩';
  const r = await call(routes, 'POST /deck/edit/slide/notes', { body: { slide: 1, text } });
  assert.equal(r.code, 200);
  const aside = /<aside class="notes">([\s\S]*?)<\/aside>/.exec(readDeck())[1];
  assert.match(aside, /<p>one \[pause\] two \[long pause\] \[whispers\] three<\/p>/, 'an audio tag is kept as written');
  assert.equal(aside.match(/<p>\[click\]<\/p>/g)?.length, 2, 'each click spelling is one [click]');
  assert.match(aside, /<p>four \[slow\]slowly<\/p>/, 'an old slow stretch is the [slow] tag, its close gone');
  assert.doesNotMatch(aside, /⟨|&lt;/, 'no angle-bracket form survives the save');
});

test('POST /deck/edit/slide/layout writes data-layout, and saying it twice changes nothing', async (t) => {
  const { routes, readDeck } = harness(t);
  const first = await call(routes, 'POST /deck/edit/slide/layout', { body: { slide: 1, layout: 'split' } });
  assert.equal(first.code, 200);
  assert.equal(first.body.changed, true);
  assert.match(readDeck(), /<section data-layout="split">/);

  // The idempotent write is the one that matters: a picker that re-sends the
  // layout it is already on must not spend an undo entry on nothing.
  const again = await call(routes, 'POST /deck/edit/slide/layout', { body: { slide: 1, layout: 'split' } });
  assert.equal(again.body.changed, false, 'an unchanged write took a snapshot');
  assert.equal(again.body.undo, 1, 'and it spent an undo entry doing it');
});

test('POST /deck/edit/slide/hidden takes a slide out of the talk and puts it back', async (t) => {
  const { routes, readDeck } = harness(t);
  await call(routes, 'POST /deck/edit/slide/hidden', { body: { slide: 2, hidden: true } });
  assert.match(readDeck(), /<section data-layout="centered" data-hidden>/,
    'data-hidden lands beside the layout, not instead of it (DECK_ANATOMY HIDDEN_SLIDES)');
  await call(routes, 'POST /deck/edit/slide/hidden', { body: { slide: 2, hidden: false } });
  assert.doesNotMatch(readDeck(), /data-hidden/, 'showing it again must take the attribute off');
  assert.match(readDeck(), /data-layout="centered"/, 'and must leave the rest of the tag alone');
});

test('POST /deck/edit/slide/attr writes a slide\'s settings in place: one undo, quiet, every page sent the edits', async (t) => {
  const quiet = [];
  const sent = [];
  const { routes, readDeck, history } = harness(t, DECK, { quiet: (html) => quiet.push(html), broadcast: (e, d) => sent.push([e, d]) });
  const r = await call(routes, 'POST /deck/edit/slide/attr', {
    body: { slide: 2, set: { 'data-module': 'Words', 'data-transition': 'flip', 'data-timing': '90' }, quiet: true, from: 'page-1' },
  });
  assert.equal(r.code, 200);
  assert.equal(r.body.changed, true);
  assert.equal(r.body.inPlace, true);
  assert.equal(r.body.undo, 1, 'three settings, one undo entry');
  assert.match(readDeck(), /<section data-layout="centered" data-module="Words" data-transition="flip" data-timing="90">/,
    'each lands after what the tag had, the layout kept');
  assert.deepEqual(quiet, [readDeck()], 'the bytes written are the quiet ones: no reload here');
  assert.deepEqual(sent, [['slide-attrs', { edits: [{ slide: 2, set: { 'data-module': 'Words', 'data-transition': 'flip', 'data-timing': '90' } }], from: 'page-1' }]]);

  // the same again is no write and no undo entry
  const again = await call(routes, 'POST /deck/edit/slide/attr', { body: { slide: 2, set: { 'data-transition': 'flip' } } });
  assert.equal(again.body.changed, false);
  assert.equal(history.counts().undo, 1);

  // two slides in one edit: a morph is this slide's and the one before's
  const both = await call(routes, 'POST /deck/edit/slide/attr', {
    body: { edits: [{ slide: 2, set: { 'data-auto-animate': true } }, { slide: 1, set: { 'data-auto-animate': true } }] },
  });
  assert.equal(both.body.undo, 2, 'one more undo entry for both slides');
  assert.equal(both.body.inPlace, false, 'not asked for quiet, not quiet');
  assert.equal((readDeck().match(/data-auto-animate>/g) ?? []).length, 2, 'written bare on both');

  // taking one off, and the deck's transition back
  await call(routes, 'POST /deck/edit/slide/attr', { body: { slide: 2, set: { 'data-transition': null, 'data-module': null } } });
  assert.match(readDeck(), /<section data-layout="centered" data-timing="90" data-auto-animate>/);
});

test('POST /deck/edit/slide/attr refuses what it does not write, and writes nothing then', async (t) => {
  const { routes, readDeck } = harness(t);
  const before = readDeck();
  for (const [body, why] of [
    [{ slide: 1, set: { 'data-layout': 'top' } }, /not a slide attribute this server writes: data-layout/],
    [{ slide: 1, set: { 'data-hidden': true } }, /not a slide attribute/],
    [{ slide: 1, set: { onclick: 'x' } }, /not a slide attribute/],
    [{ slide: 1, set: { 'data-transition': 'spin' } }, /not a value data-transition takes: spin/],
    [{ slide: 1, set: { 'data-transition': 'fade', 'data-timing': '-3' } }, /not a value data-timing takes/],
    [{ slide: 1, set: { 'data-background-video': 'https://x.invalid/a.mp4' } }, /not a value/],
  ]) {
    const r = await call(routes, 'POST /deck/edit/slide/attr', { body });
    assert.equal(r.code, 400, JSON.stringify(body));
    assert.match(r.body.error, why);
  }
  assert.equal((await call(routes, 'POST /deck/edit/slide/attr', { body: { slide: 9, set: { 'data-transition': 'fade' } } })).code, 404);
  assert.equal((await call(routes, 'POST /deck/edit/slide/attr', { body: { slide: 1 } })).code, 400);
  assert.equal((await call(routes, 'POST /deck/edit/slide/attr', { body: { edits: Array(5).fill({ slide: 1, set: { 'data-math': true } }) } })).code, 400);
  assert.equal(readDeck(), before, 'a refusal is a refusal: not one byte written');
});

test('GET /deck/edit/find and POST /deck/edit/replace: the matches, replaced in one undo, refused when the deck changed since', async (t) => {
  const { routes, readDeck, history } = harness(t);
  const call2 = (key, body, query) => call(routes, key, { body, query });
  const found = await call2('GET /deck/edit/find', undefined, '?q=e&word=0');
  assert.equal(found.code, 200);
  assert.equal(found.body.count, found.body.matches.length);
  const alpha = await call2('GET /deck/edit/find', undefined, '?q=alpha');
  assert.deepEqual(alpha.body.matches.map((m) => [m.slide, m.text]), [[1, 'Alpha']]);
  const stale = await call2('POST /deck/edit/replace', { find: 'alpha', replace: 'Gamma', expect: 3 });
  assert.equal(stale.code, 409);
  assert.match(stale.body.error, /changed since the search: it now has 1 match, not 3/);
  assert.equal(history.counts().undo, 0, 'refused: nothing written');
  const ok = await call2('POST /deck/edit/replace', { find: 'alpha', replace: 'Gamma', expect: 1 });
  assert.equal(ok.body.count, 1);
  assert.equal(ok.body.undo, 1);
  assert.match(readDeck(), /<h2>Gamma<\/h2>/);
  const one = await call2('GET /deck/edit/find', undefined, '?q=a');
  const pick = one.body.matches[0].id;
  const r1 = await call2('POST /deck/edit/replace', { find: 'a', replace: 'A', expect: one.body.count, only: [pick] });
  assert.equal(r1.body.count, 1, 'replace one is only the one named');
  assert.equal((await call2('POST /deck/edit/replace', { find: 'a', replace: 'b', expect: 0, only: ['9:9'] })).code, 409, 'a match that is no longer there');
  assert.equal((await call2('GET /deck/edit/find', undefined, '?q=')).code, 400);
  assert.equal((await call2('POST /deck/edit/replace', { find: 'a' })).code, 400);
});

test('POST /deck/edit/element/paste: cleaned, placed, one undo, and a picture this deck does not have named', async (t) => {
  const { routes, readDeck, history, dir } = harness(t);
  writeFileSync(path.join(dir, 'here.png'), 'x');
  const r = await call(routes, 'POST /deck/edit/element/paste', {
    body: { slide: 1, index: 1, html: '<figure><img src="here.png" alt=""><img src="assets/elsewhere.png" alt="" onerror="x()"></figure><script>y()</script>', quiet: true, from: 'p1' },
  });
  assert.equal(r.code, 200);
  assert.equal(r.body.index, 2);
  assert.deepEqual(r.body.dropped, ['a script', 'an onerror handler']);
  assert.deepEqual(r.body.missing, ['assets/elsewhere.png'], 'the file beside the deck is there; the other deck\'s is named');
  assert.equal(history.counts().undo, 1);
  assert.match(readDeck(), /<ul><li>one<\/li><\/ul>\s*<figure><img src="here\.png" alt=""><img src="assets\/elsewhere\.png" alt=""><\/figure>/);
  assert.doesNotMatch(readDeck(), /script|onerror/);
  assert.equal((await call(routes, 'POST /deck/edit/element/paste', { body: { slide: 1, index: 1, html: '<script>z()</script>' } })).code, 400);
  assert.equal((await call(routes, 'POST /deck/edit/element/paste', { body: { slide: 9, html: '<p>x</p>' } })).code, 404);
  assert.equal((await call(routes, 'POST /deck/edit/element/paste', { body: { slide: 1, html: 7 } })).code, 400);
  assert.equal(history.counts().undo, 1, 'a refusal writes nothing');
});

test('GET /deck/edit/element/source by path: the node below the element, as the file has it', async (t) => {
  const { routes } = harness(t);
  const li = await call(routes, 'GET /deck/edit/element/source', { query: '?slide=1&index=1&path=0&tag=li' });
  assert.equal(li.code, 200);
  assert.equal(li.body.html, '<li>one</li>');
  assert.equal((await call(routes, 'GET /deck/edit/element/source', { query: '?slide=1&index=1&path=0&tag=p' })).code, 409, 'a stale tag');
});

test('GET /deck/edit/element/source reads the FILE, and 404s past the last element', async (t) => {
  const { routes } = harness(t);
  const ok = await call(routes, 'GET /deck/edit/element/source', { query: '?slide=1&index=1' });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.html, '<ul><li>one</li></ul>', 'the element comes back verbatim, not as the DOM has it');

  const gone = await call(routes, 'GET /deck/edit/element/source', { query: '?slide=1&index=9' });
  assert.equal(gone.code, 404, 'an index the slide does not have is not found, not a crash');
  assert.equal(gone.body.ok, false);

  const bad = await call(routes, 'GET /deck/edit/element/source', { query: '?slide=0&index=1' });
  assert.equal(bad.code, 400, 'slide 0 is a bad payload, and is refused before the file is opened');
});

test('POST /deck/edit/slide/sources writes the card, and refuses a link that would execute', async (t) => {
  const { routes, readDeck } = harness(t);
  const r = await call(routes, 'POST /deck/edit/slide/sources', {
    body: {
      slide: 1,
      facts: [['sample', '1,200 people']],
      links: [
        { title: 'the paper', href: 'https://example.org/p' },
        { title: 'a trap', href: 'javascript:alert(1)' },
      ],
    },
  });
  assert.equal(r.code, 200);
  assert.equal(r.body.changed, true);
  assert.deepEqual(r.body.dropped, ['javascript:alert(1)'],
    'a rejected scheme is a decision the author has to hear about, not a silent drop');
  const html = readDeck();
  assert.match(html, /<aside class="sources">/);
  assert.match(html, /<dt>sample<\/dt><dd>1,200 people<\/dd>/);
  assert.doesNotMatch(html, /javascript:/, 'an executable href must never reach the file — this aside travels');
});

test('POST /deck/edit/timings writes every slide in ONE edit, so Z takes the rehearsal back at once', async (t) => {
  const { routes, readDeck, history } = harness(t);
  const r = await call(routes, 'POST /deck/edit/timings', {
    body: { timings: [{ slide: 1, seconds: 42 }, { slide: 2, seconds: 90.4 }] },
  });
  assert.equal(r.code, 200);
  assert.equal(r.body.changed, true);
  assert.equal(history.counts().undo, 1, 'two slides, one undo entry');
  const html = readDeck();
  assert.match(html, /<section data-timing="42">/);
  assert.match(html, /data-timing="90"/, 'seconds are whole (PRESENTING REHEARSAL_TIMINGS)');
});

test('a bad payload throws rather than writing, and the dispatcher turns that into a 400', async (t) => {
  const { routes, readDeck } = harness(t);
  const before = readDeck();
  for (const body of [{ slide: 0, text: 'x' }, { slide: 1, text: 7 }, { slide: 1.5, text: 'x' }]) {
    await assert.rejects(() => call(routes, 'POST /deck/edit/slide/notes', { body }), /bad payload/,
      `${JSON.stringify(body)} was accepted`);
  }
  assert.equal(readDeck(), before, 'a refused write must leave the deck byte-for-byte alone');
});

// ── whole slides, a dropped image, and the <img> that points at it ─────────

const THREE = `<!doctype html>
<html><head><title>t</title></head><body>
  <div class="decklight">
    <section>
      <h2>Alpha</h2>
      <aside class="notes">one</aside>
    </section>
    <section data-layout="centered">
      <h2>Beta</h2>
    </section>
    <section>
      <h2>Gamma</h2>
    </section>
  </div>
  <script src="decklight/dist/decklight.js"></script>
</body></html>
`;

/** The deck's running order, read back out of the file. */
const titles = (html) => [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]);

test('POST /deck/edit/slide makes a blank slide after the one you were on and moves you to it', async (t) => {
  const { routes, readDeck, history } = harness(t, THREE);
  const r = await call(routes, 'POST /deck/edit/slide', { body: { op: 'new', slide: 1 } });
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.ok, r.body.slide, r.body.total], [true, 2, 4],
    'the answer carries where the stage should BE, so the browser does not redo the arithmetic');
  assert.deepEqual(titles(readDeck()), ['Alpha', 'New slide', 'Beta', 'Gamma']);
  assert.equal(history.counts().undo, 1, 'one op is one press of Z');
  assert.match(readDeck(), /<aside class="notes"><\/aside>/, 'the blank slide arrives ready for notes');
});

test('POST /deck/edit/slide duplicates a slide byte for byte, and lands you on the copy', async (t) => {
  const { routes, readDeck } = harness(t, THREE);
  const r = await call(routes, 'POST /deck/edit/slide', { body: { op: 'duplicate', slide: 2 } });
  assert.deepEqual([r.body.slide, r.body.total], [3, 4]);
  const html = readDeck();
  assert.deepEqual(titles(html), ['Alpha', 'Beta', 'Beta', 'Gamma']);
  assert.equal((html.match(/<section data-layout="centered">/g) ?? []).length, 2,
    'the copy keeps the original\'s layout — a duplicate is the same slide twice');
});

test('POST /deck/edit/slide deletes a slide, and deleting the last one leaves you on the new last', async (t) => {
  const { routes, readDeck } = harness(t, THREE);
  const mid = await call(routes, 'POST /deck/edit/slide', { body: { op: 'delete', slide: 2 } });
  assert.deepEqual([mid.body.slide, mid.body.total], [2, 2], 'you stay at the same number, now a different slide');
  assert.deepEqual(titles(readDeck()), ['Alpha', 'Gamma']);
  assert.doesNotMatch(readDeck(), /\n[ \t]*\n/, 'the line the slide sat on must go with it');

  const last = await call(routes, 'POST /deck/edit/slide', { body: { op: 'delete', slide: 2 } });
  assert.deepEqual([last.body.slide, last.body.total], [1, 1],
    'there is no slide 2 to stand on any more, so the answer walks you back');
});

test('POST /deck/edit/slide refuses to delete the only slide a deck has', async (t) => {
  const one = THREE.replace(/ {4}<section data-layout[\s\S]*?<\/section>\n/, '')
    .replace(/ {4}<section>\n {6}<h2>Gamma<\/h2>\n {4}<\/section>\n/, '');
  const { routes, readDeck } = harness(t, one);
  const before = readDeck();
  const r = await call(routes, 'POST /deck/edit/slide', { body: { op: 'delete', slide: 1 } });
  assert.equal(r.code, 409);
  assert.deepEqual(r.body, { ok: false, error: 'a deck needs at least one slide' },
    'a deck with no slides is not a deck, and the refusal has to say so in words');
  assert.equal(readDeck(), before, 'a refused op must leave the file byte-for-byte alone');
});

test('POST /deck/edit/slide moves a slide up and down, and refuses at the two ends', async (t) => {
  const { routes, readDeck, history } = harness(t, THREE);
  const up = await call(routes, 'POST /deck/edit/slide', { body: { op: 'up', slide: 2 } });
  assert.deepEqual([up.body.slide, up.body.total], [1, 3], 'you follow the slide you moved');
  assert.deepEqual(titles(readDeck()), ['Beta', 'Alpha', 'Gamma']);
  assert.equal(history.counts().undo, 1, 'two sections changed places in ONE undo entry');

  const down = await call(routes, 'POST /deck/edit/slide', { body: { op: 'down', slide: 1 } });
  assert.deepEqual([down.body.slide, down.body.total], [2, 3]);
  assert.deepEqual(titles(readDeck()), ['Alpha', 'Beta', 'Gamma'], 'down undoes up, so the deck is back');

  const top = await call(routes, 'POST /deck/edit/slide', { body: { op: 'up', slide: 1 } });
  assert.equal(top.code, 409);
  assert.equal(top.body.error, 'already the first slide');
  const bottom = await call(routes, 'POST /deck/edit/slide', { body: { op: 'down', slide: 3 } });
  assert.equal(bottom.code, 409);
  assert.equal(bottom.body.error, 'already the last slide');
  assert.equal(history.counts().undo, 2, 'neither refusal spent an undo entry');

  // `move` is what a drag in the overview asks for: the slide ends up AT `to`
  const far = await call(routes, 'POST /deck/edit/slide', { body: { op: 'move', slide: 1, to: 3 } });
  assert.deepEqual([far.body.slide, far.body.total], [3, 3], 'you follow the slide to where it landed');
  assert.deepEqual(titles(readDeck()), ['Beta', 'Gamma', 'Alpha']);
  const back = await call(routes, 'POST /deck/edit/slide', { body: { op: 'move', slide: 3, to: 1 } });
  assert.deepEqual(titles(readDeck()), ['Alpha', 'Beta', 'Gamma'], 'and back');
  assert.equal(back.body.slide, 1);
  const there = await call(routes, 'POST /deck/edit/slide', { body: { op: 'move', slide: 2, to: 2 } });
  assert.equal(there.code, 409);
  assert.equal(there.body.error, 'slide 2 is already there');
  const past = await call(routes, 'POST /deck/edit/slide', { body: { op: 'move', slide: 2, to: 9 } });
  assert.equal(past.code, 404);
  const noTo = await call(routes, 'POST /deck/edit/slide', { body: { op: 'move', slide: 2 } });
  assert.equal(noTo.code, 400);
  assert.equal(history.counts().undo, 4, 'a move is one undo entry however far it went, and a refusal none');
});

test('POST /deck/edit/slide counts hidden slides like any other section', async (t) => {
  // Numbering is by SOURCE ORDER here (DECK_ANATOMY) — the same way comments,
  // review anchors and history number a deck.
  const { routes, readDeck } = harness(t, THREE.replace('<section data-layout="centered">', '<section data-hidden>'));
  const r = await call(routes, 'POST /deck/edit/slide', { body: { op: 'down', slide: 2 } });
  assert.deepEqual([r.body.slide, r.body.total], [3, 3], 'a hidden slide is still slide 2');
  assert.deepEqual(titles(readDeck()), ['Alpha', 'Gamma', 'Beta']);
});

test('POST /deck/edit/slide refuses a bad op or slide with 400, and an absent slide with 404', async (t) => {
  const { routes, readDeck } = harness(t, THREE);
  const before = readDeck();
  for (const body of [{ op: 'shuffle', slide: 1 }, { op: 'new', slide: 1.5 }, { op: 'new', slide: 0 }, { slide: 1 }]) {
    const r = await call(routes, 'POST /deck/edit/slide', { body });
    assert.equal(r.code, 400, `${JSON.stringify(body)} was accepted`);
    assert.equal(r.body.error, 'bad payload');
  }
  const gone = await call(routes, 'POST /deck/edit/slide', { body: { op: 'new', slide: 9 } });
  assert.equal(gone.code, 404, 'a slide the deck does not have is not found, not a crash');
  assert.match(gone.body.error, /no slide 9 \(deck has 3\)/);
  assert.equal(readDeck(), before, 'and nothing was written on the way to either answer');
});

/**
 * Call POST /deck/edit/asset the way the dispatcher calls a BEFORE_BODY route: the
 * raw request stream and its headers, and no body string at all.
 *
 * `pulled` counts the chunks the handler actually took, which is how the size
 * limit is checked honestly — a limit that buffers the whole upload before
 * announcing it costs more than it saves.
 */
async function upload(routes, { type = 'image/png', name = 'photo.PNG', chunks = ['x'], length } = {}) {
  const handler = routes.get('POST /deck/edit/asset');
  assert.ok(handler, 'no handler registered for POST /deck/edit/asset');
  let pulled = 0;
  const req = Readable.from((function* () {
    for (const c of chunks) { pulled++; yield Buffer.from(c); }
  })());
  req.headers = {
    ...(type === null ? {} : { 'content-type': type }),
    ...(name === null ? {} : { 'x-decklight-name': name }),
    ...(length === undefined ? {} : { 'content-length': String(length) }),
  };
  const sent = {};
  await handler({
    req, res: {}, url: new URL('http://x/deck/edit/asset'),
    json: (code, obj) => { sent.code = code; sent.body = obj; }, CORS: {},
  });
  return { ...sent, pulled };
}

test('POST /deck/edit/asset saves a dropped image under assets/, named safely', async (t) => {
  const { routes, dir } = harness(t, THREE);
  const r = await upload(routes, { name: 'My Holiday Photo!.jpeg', type: 'image/png', chunks: ['png-bytes'] });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, src: 'assets/my-holiday-photo.png', bytes: 9 },
    'the extension comes from the content type, never from the name the browser sent');
  assert.equal(readFileSync(path.join(dir, 'assets', 'my-holiday-photo.png'), 'utf8'), 'png-bytes',
    'the bytes are saved as they arrived — an editor that rewrote them would be lying about the slide');
});

test('POST /deck/edit/asset never writes outside assets/, whatever the name claims', async (t) => {
  const { routes, dir } = harness(t, THREE);
  for (const [name, expected] of [
    ['../../etc/passwd', 'assets/passwd.png'],
    ['..\\..\\windows\\system32\\evil', 'assets/evil.png'],
    ['..', 'assets/image.png'],
    ['.env', 'assets/image.png'],
    ['', 'assets/image.png'],
  ]) {
    const r = await upload(routes, { name, chunks: ['x'] });
    assert.equal(r.code, 200, `${name} was refused rather than made safe`);
    assert.match(r.body.src, /^assets\/[a-z0-9][a-z0-9._-]*$/, `${name} produced ${r.body.src}`);
    assert.ok(r.body.src === expected || r.body.src.startsWith(expected.replace(/\.png$/, '-')),
      `${name} → ${r.body.src}, not a variant of ${expected}`);
  }
  assert.ok(!existsSync(path.join(dir, 'passwd.png')), 'a name that climbed out would land beside the deck');
});

test('POST /deck/edit/asset de-duplicates rather than overwriting a picture already on a slide', async (t) => {
  const { routes, dir } = harness(t, THREE);
  const first = await upload(routes, { name: 'logo.png', chunks: ['one'] });
  const second = await upload(routes, { name: 'logo.png', chunks: ['two'] });
  const third = await upload(routes, { name: 'logo.png', chunks: ['three'] });
  assert.deepEqual([first.body.src, second.body.src, third.body.src],
    ['assets/logo.png', 'assets/logo-2.png', 'assets/logo-3.png'],
    'two pictures called logo are two pictures');
  assert.equal(readFileSync(path.join(dir, 'assets', 'logo.png'), 'utf8'), 'one',
    'overwriting the first would change a slide the author was not editing');
});

test('POST /deck/edit/asset saves an mp4 or a webm under assets/, streamed, its name its own, and says it is not in the autocommits', async (t) => {
  const { routes, dir } = harness(t, THREE);
  const r = await upload(routes, { type: 'video/mp4', name: 'Demo Clip.MOV', chunks: ['aa', 'bb', 'cc'] });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, src: 'assets/demo-clip.mp4', bytes: 6, video: true, committed: false });
  assert.equal(readFileSync(path.join(dir, 'assets', 'demo-clip.mp4'), 'utf8'), 'aabbcc');
  const again = await upload(routes, { type: 'video/webm', name: 'demo-clip.webm', chunks: ['x'] });
  assert.equal(again.body.src, 'assets/demo-clip.webm');
  const twice = await upload(routes, { type: 'video/mp4', name: 'demo clip', chunks: ['y'] });
  assert.equal(twice.body.src, 'assets/demo-clip-2.mp4', 'two videos of one name are two videos');
  assert.deepEqual(readdirSync(path.join(dir, 'assets')).filter((f) => f.startsWith('.')), [], 'no scratch file is left behind');
});

test('POST /deck/edit/asset refuses a video over its cap with the cap in the sentence, before reading it when it says its size', async (t) => {
  const { routes, dir } = harness(t, THREE);
  const declared = await upload(routes, { type: 'video/mp4', chunks: ['x', 'x', 'x'], length: 300e6 });
  assert.equal(declared.code, 413);
  assert.match(declared.body.error, /a video on a slide is at most 200 MB: this one is 300 MB/);
  assert.equal(declared.pulled, 0, 'refused on content-length, not after reading it');
  assert.ok(!existsSync(path.join(dir, 'assets')), 'nothing written');
});

test('POST /deck/edit/asset refuses anything that is not an image a slide can carry', async (t) => {
  const { routes, dir } = harness(t, THREE);
  for (const type of ['text/html', 'application/pdf', 'image/tiff', null, '']) {
    const r = await upload(routes, { type, chunks: ['x'] });
    assert.equal(r.code, 415, `${type} was accepted`);
    assert.equal(r.body.ok, false);
  }
  assert.ok(!existsSync(path.join(dir, 'assets')), 'a refused upload must not even make the folder');
});

test('POST /deck/edit/asset refuses an oversized upload WITHOUT reading it', async (t) => {
  const { routes } = harness(t, THREE);
  // The declared length is the cheap refusal: the browser said how big it is,
  // so the bytes never have to cross the socket at all.
  const declared = await upload(routes, { length: 26e6, chunks: ['x'] });
  assert.equal(declared.code, 413);
  assert.equal(declared.pulled, 0, 'the body was read despite content-length already answering the question');

  // And with no content-length, the stream itself is capped as it arrives.
  const mb = Buffer.alloc(1e6);
  const streamed = await upload(routes, { chunks: Array(40).fill(mb) });
  assert.equal(streamed.code, 413);
  assert.ok(streamed.pulled <= 26, `read ${streamed.pulled} MB before refusing — the cap is not stopping the stream`);
});

test('POST /deck/edit/asset takes an SVG as it is, but refuses one carrying a script', async (t) => {
  const { routes, dir } = harness(t, THREE);
  const plain = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
  const ok = await upload(routes, { type: 'image/svg+xml', name: 'diagram.svg', chunks: [plain] });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.src, 'assets/diagram.svg');
  assert.equal(readFileSync(path.join(dir, 'assets', 'diagram.svg'), 'utf8'), plain,
    'nothing is stripped — decklight --no-trust --audit names what a deck runs (SPEC PRESENTING), it does not edit it');

  const armed = await upload(routes, {
    type: 'image/svg+xml',
    name: 'trap.svg',
    chunks: ['<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("//evil")</script></svg>'],
  });
  assert.equal(armed.code, 400);
  assert.equal(armed.body.error, 'an SVG with a script is not an image');
  assert.ok(!existsSync(path.join(dir, 'assets', 'trap.svg')), 'a refused SVG must not reach the disk at all');
});

test('POST /deck/edit/element/image puts the picture on the slide, not inside the notes', async (t) => {
  const { routes, readDeck, history } = harness(t, THREE);
  const r = await call(routes, 'POST /deck/edit/element/image', {
    body: { slide: 1, index: null, src: 'assets/chart.png', alt: 'revenue by quarter' },
  });
  assert.equal(r.code, 200);
  assert.equal(r.body.index, 1, 'the answer names the new element, since everything after it has shifted');
  assert.equal(history.counts().undo, 1);
  assert.match(readDeck(), /<h2>Alpha<\/h2>\n {6}<img src="assets\/chart\.png" alt="revenue by quarter">\n {6}<aside/,
    'an image inside the aside is an image the audience never sees');
});

test('POST /deck/edit/element/image accepts an explicit index, addressed like the element routes', async (t) => {
  const { routes, readDeck } = harness(t, THREE);
  const r = await call(routes, 'POST /deck/edit/element/image', { body: { slide: 2, index: 0, src: 'assets/a.png', alt: '' } });
  assert.equal(r.body.index, 1);
  assert.match(readDeck(), /<h2>Beta<\/h2>\n {6}<img src="assets\/a\.png" alt="">/);
});

test('POST /deck/edit/element/image refuses an src that is not a path beside the deck', async (t) => {
  const { routes, readDeck } = harness(t, THREE);
  const before = readDeck();
  for (const src of [
    'https://example.org/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAA',
    '/etc/passwd.png', '../secrets/a.png', 'a/../../b.png', '', 7, null,
  ]) {
    const r = await call(routes, 'POST /deck/edit/element/image', { body: { slide: 1, index: null, src, alt: '' } });
    assert.equal(r.code, 400, `${JSON.stringify(src)} was accepted as an image src`);
    assert.equal(r.body.ok, false);
  }
  assert.equal(readDeck(), before, 'a deck is one file and what sits beside it — nothing else reached it');
});

test('POST /deck/edit/element/image refuses a bad payload with 400 and an absent slide with 404', async (t) => {
  const { routes } = harness(t, THREE);
  for (const body of [{ slide: 0, src: 'a.png' }, { slide: 1, index: -1, src: 'a.png' }, { slide: 1, index: 1.5, src: 'a.png' }]) {
    const r = await call(routes, 'POST /deck/edit/element/image', { body });
    assert.equal(r.code, 400, `${JSON.stringify(body)} was accepted`);
  }
  const gone = await call(routes, 'POST /deck/edit/element/image', { body: { slide: 9, index: null, src: 'a.png', alt: '' } });
  assert.equal(gone.code, 404);
  assert.match(gone.body.error, /no slide 9/);
  const noChild = await call(routes, 'POST /deck/edit/element/image', { body: { slide: 2, index: 7, src: 'a.png', alt: '' } });
  assert.equal(noChild.code, 404, 'an index the slide does not have is not found, not a crash');
});

test('a slide op asked for in place is a quiet write that hands back the new slide, and other pages hear it (PRESENTING_EDITING)', async (t) => {
  const quiet = [];
  const told = [];
  const { routes, readDeck } = harness(t, THREE, { quiet: (html) => quiet.push(html), broadcast: (event, data) => told.push({ event, data }) });
  const made = await call(routes, 'POST /deck/edit/slide', { body: { op: 'new', slide: 1, quiet: true, from: 'page-a' } });
  assert.equal(made.body.inPlace, true);
  assert.equal(quiet.at(-1), readDeck(), 'the watcher skips exactly what this write put there');
  assert.match(made.body.section, /^<section[\s\S]*New slide[\s\S]*<\/section>$/, 'the new slide as the file has it, for the page to put in');
  assert.deepEqual(told.at(-1), { event: 'content', data: { from: 'page-a', slide: 2 } });
  // a move in place has no markup to hand back; and one not asked for is the reload it always was
  const moved = await call(routes, 'POST /deck/edit/slide', { body: { op: 'down', slide: 1, quiet: true } });
  assert.equal(moved.body.inPlace, true);
  assert.equal(moved.body.section, undefined);
  const loud = await call(routes, 'POST /deck/edit/slide', { body: { op: 'up', slide: 2 } });
  assert.equal(loud.body.inPlace, false);
  assert.equal(quiet.length, 2, 'only the two asked for were quiet');
});

test('the pictures of one drop are placed quietly until the last, so the reload cannot cut the drop short', async (t) => {
  const quiet = [];
  const { routes, readDeck } = harness(t, THREE, { quiet: (html) => quiet.push(html) });
  await call(routes, 'POST /deck/edit/element/image', { body: { slide: 1, src: 'a.png', alt: 'a', more: true } });
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0], readDeck());
  await call(routes, 'POST /deck/edit/element/image', { body: { slide: 1, src: 'b.png', alt: 'b' } });
  assert.equal(quiet.length, 1, 'the last one reloads, all of them in');
  assert.match(readDeck(), /a\.png[\s\S]*b\.png/);
});

test('POST /deck/edit/element/remove asked quiet takes a block inside a column off in place: no reload here, every other page told', async (t) => {
  const split = DECK.replace('<section>\n      <h2>Alpha</h2>\n      <ul><li>one</li></ul>\n    </section>',
    '<section data-layout="split">\n      <h2>Alpha</h2>\n      <div>\n        <h3>Left</h3>\n        <p>gone</p>\n      </div>\n      <div><p>right</p></div>\n    </section>');
  const quiet = [];
  const told = [];
  const { routes, readDeck } = harness(t, split, { quiet: (h) => quiet.push(h), broadcast: (event, data) => told.push({ event, data }) });
  const r = await call(routes, 'POST /deck/edit/element/remove', { body: { slide: 1, index: 1, path: [1], tag: 'p', quiet: true, from: 'page-a' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.changed, true);
  assert.equal(r.body.inPlace, true);
  assert.doesNotMatch(readDeck(), /gone/);
  assert.match(readDeck(), /<div>\n {8}<h3>Left<\/h3>\n {6}<\/div>/, 'its line goes with it');
  assert.equal(quiet.at(-1), readDeck(), 'the watcher skips what this write put there');
  assert.deepEqual(told.at(-1), { event: 'content', data: { slide: 1, index: 1, from: 'page-a' } });
  // not asked quiet: the reload it always was
  const loud = await call(routes, 'POST /deck/edit/element/remove', { body: { slide: 1, index: 1, path: [0], tag: 'h3' } });
  assert.equal(loud.body.inPlace, false);
  assert.equal(quiet.length, 1);
});
