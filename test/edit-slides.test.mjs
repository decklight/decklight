// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The slide-mutation routes (cli/edit-slides.mjs), called as functions.
//
// Every other test of this surface boots the whole author server, waits for a
// URL to appear on its stdout and talks to it over a socket — ten seconds and
// a spawned process to prove that `data-layout="centered"` reached the file.
// These handlers were lifted out of editMain precisely so they would not need
// any of that: they take `readDeck`, `applyEdit` and `history` and nothing
// else, so a temp deck and a fake `json` are the whole harness, and a
// regression in one of them is milliseconds away instead of a server boot.
//
// What is NOT tested here is the dispatch — the table, the CSRF gate, the body
// read. That is the server's half and test/edit.test.mjs still holds it over a
// real socket, which is the only place it can honestly be checked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { createHistory } from '../cli/edit.mjs';
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
 * A deck on disk and the three bindings the handlers are given, wired exactly
 * as editMain wires them — `applyEdit` snapshots onto the history and writes,
 * and answers whether anything changed.
 */
function harness(t, html = DECK) {
  const dir = tmp('edit-slides', t);
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
  registerSlideRoutes(routes, { readDeck, applyEdit, history });
  return { routes, history, readDeck, deck };
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
    'GET /edit/element/source',
    'POST /edit/element/content',
    'POST /edit/element/effect',
    'POST /edit/element/remove',
    'POST /edit/hidden',
    'POST /edit/layout',
    'POST /edit/narration',
    'POST /edit/notes',
    'POST /edit/sources',
    'POST /edit/timings',
  ], 'a route that leaves this list has left the author server too');
});

test('POST /edit/notes writes the aside and leaves one undo entry behind', async (t) => {
  const { routes, readDeck, history } = harness(t);
  const r = await call(routes, 'POST /edit/notes', { body: { slide: 1, text: 'say this ⟨CLICK⟩ then this' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.undo, 1, 'the write must be one step of the ONE undo history');
  const html = readDeck();
  assert.match(html, /<aside class="notes">/, 'the aside never reached the file');
  assert.match(html, /<p>say this<\/p>/);
  assert.match(html, /<p>⟨CLICK⟩<\/p>/, 'the click marker is its own paragraph (SPEC PRESENTING)');
  assert.equal(history.counts().redo, 0, 'a fresh edit clears the redo stack');
});

test('POST /edit/layout writes data-layout, and saying it twice changes nothing', async (t) => {
  const { routes, readDeck } = harness(t);
  const first = await call(routes, 'POST /edit/layout', { body: { slide: 1, layout: 'split' } });
  assert.equal(first.code, 200);
  assert.equal(first.body.changed, true);
  assert.match(readDeck(), /<section data-layout="split">/);

  // The idempotent write is the one that matters: a picker that re-sends the
  // layout it is already on must not spend an undo entry on nothing.
  const again = await call(routes, 'POST /edit/layout', { body: { slide: 1, layout: 'split' } });
  assert.equal(again.body.changed, false, 'an unchanged write took a snapshot');
  assert.equal(again.body.undo, 1, 'and it spent an undo entry doing it');
});

test('POST /edit/hidden takes a slide out of the talk and puts it back', async (t) => {
  const { routes, readDeck } = harness(t);
  await call(routes, 'POST /edit/hidden', { body: { slide: 2, hidden: true } });
  assert.match(readDeck(), /<section data-layout="centered" data-hidden>/,
    'data-hidden lands beside the layout, not instead of it (DECK_ANATOMY HIDDEN_SLIDES)');
  await call(routes, 'POST /edit/hidden', { body: { slide: 2, hidden: false } });
  assert.doesNotMatch(readDeck(), /data-hidden/, 'showing it again must take the attribute off');
  assert.match(readDeck(), /data-layout="centered"/, 'and must leave the rest of the tag alone');
});

test('GET /edit/element/source reads the FILE, and 404s past the last element', async (t) => {
  const { routes } = harness(t);
  const ok = await call(routes, 'GET /edit/element/source', { query: '?slide=1&index=1' });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.html, '<ul><li>one</li></ul>', 'the element comes back verbatim, not as the DOM has it');

  const gone = await call(routes, 'GET /edit/element/source', { query: '?slide=1&index=9' });
  assert.equal(gone.code, 404, 'an index the slide does not have is not found, not a crash');
  assert.equal(gone.body.ok, false);

  const bad = await call(routes, 'GET /edit/element/source', { query: '?slide=0&index=1' });
  assert.equal(bad.code, 400, 'slide 0 is a bad payload, and is refused before the file is opened');
});

test('POST /edit/sources writes the card, and refuses a link that would execute', async (t) => {
  const { routes, readDeck } = harness(t);
  const r = await call(routes, 'POST /edit/sources', {
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

test('POST /edit/timings writes every slide in ONE edit, so Z takes the rehearsal back at once', async (t) => {
  const { routes, readDeck, history } = harness(t);
  const r = await call(routes, 'POST /edit/timings', {
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
    await assert.rejects(() => call(routes, 'POST /edit/notes', { body }), /bad payload/,
      `${JSON.stringify(body)} was accepted`);
  }
  assert.equal(readDeck(), before, 'a refused write must leave the deck byte-for-byte alone');
});
