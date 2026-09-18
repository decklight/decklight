// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The slide-mutation routes (cli/edit-slides.mjs), called as functions.
//
// Every other test of this surface boots the whole author server, waits for a
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
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
 * A deck on disk and the four bindings the handlers are given, wired exactly
 * as editMain wires them — `applyEdit` snapshots onto the history and writes,
 * and answers whether anything changed, and `deckPath` is the deck itself,
 * which is what /edit/asset saves an image beside.
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
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: deck });
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
    'GET /edit/element/source',
    'POST /edit/asset',
    'POST /edit/element/content',
    'POST /edit/element/effect',
    'POST /edit/element/remove',
    'POST /edit/element/style',
    'POST /edit/hidden',
    'POST /edit/image',
    'POST /edit/layout',
    'POST /edit/narration',
    'POST /edit/notes',
    'POST /edit/slide',
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

test('POST /edit/slide makes a blank slide after the one you were on and moves you to it', async (t) => {
  const { routes, readDeck, history } = harness(t, THREE);
  const r = await call(routes, 'POST /edit/slide', { body: { op: 'new', slide: 1 } });
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.ok, r.body.slide, r.body.total], [true, 2, 4],
    'the answer carries where the stage should BE, so the browser does not redo the arithmetic');
  assert.deepEqual(titles(readDeck()), ['Alpha', 'New slide', 'Beta', 'Gamma']);
  assert.equal(history.counts().undo, 1, 'one op is one press of Z');
  assert.match(readDeck(), /<aside class="notes"><\/aside>/, 'the blank slide arrives ready for notes');
});

test('POST /edit/slide duplicates a slide byte for byte, and lands you on the copy', async (t) => {
  const { routes, readDeck } = harness(t, THREE);
  const r = await call(routes, 'POST /edit/slide', { body: { op: 'duplicate', slide: 2 } });
  assert.deepEqual([r.body.slide, r.body.total], [3, 4]);
  const html = readDeck();
  assert.deepEqual(titles(html), ['Alpha', 'Beta', 'Beta', 'Gamma']);
  assert.equal((html.match(/<section data-layout="centered">/g) ?? []).length, 2,
    'the copy keeps the original\'s layout — a duplicate is the same slide twice');
});

test('POST /edit/slide deletes a slide, and deleting the last one leaves you on the new last', async (t) => {
  const { routes, readDeck } = harness(t, THREE);
  const mid = await call(routes, 'POST /edit/slide', { body: { op: 'delete', slide: 2 } });
  assert.deepEqual([mid.body.slide, mid.body.total], [2, 2], 'you stay at the same number, now a different slide');
  assert.deepEqual(titles(readDeck()), ['Alpha', 'Gamma']);
  assert.doesNotMatch(readDeck(), /\n[ \t]*\n/, 'the line the slide sat on must go with it');

  const last = await call(routes, 'POST /edit/slide', { body: { op: 'delete', slide: 2 } });
  assert.deepEqual([last.body.slide, last.body.total], [1, 1],
    'there is no slide 2 to stand on any more, so the answer walks you back');
});

test('POST /edit/slide refuses to delete the only slide a deck has', async (t) => {
  const one = THREE.replace(/ {4}<section data-layout[\s\S]*?<\/section>\n/, '')
    .replace(/ {4}<section>\n {6}<h2>Gamma<\/h2>\n {4}<\/section>\n/, '');
  const { routes, readDeck } = harness(t, one);
  const before = readDeck();
  const r = await call(routes, 'POST /edit/slide', { body: { op: 'delete', slide: 1 } });
  assert.equal(r.code, 409);
  assert.deepEqual(r.body, { ok: false, error: 'a deck needs at least one slide' },
    'a deck with no slides is not a deck, and the refusal has to say so in words');
  assert.equal(readDeck(), before, 'a refused op must leave the file byte-for-byte alone');
});

test('POST /edit/slide moves a slide up and down, and refuses at the two ends', async (t) => {
  const { routes, readDeck, history } = harness(t, THREE);
  const up = await call(routes, 'POST /edit/slide', { body: { op: 'up', slide: 2 } });
  assert.deepEqual([up.body.slide, up.body.total], [1, 3], 'you follow the slide you moved');
  assert.deepEqual(titles(readDeck()), ['Beta', 'Alpha', 'Gamma']);
  assert.equal(history.counts().undo, 1, 'two sections changed places in ONE undo entry');

  const down = await call(routes, 'POST /edit/slide', { body: { op: 'down', slide: 1 } });
  assert.deepEqual([down.body.slide, down.body.total], [2, 3]);
  assert.deepEqual(titles(readDeck()), ['Alpha', 'Beta', 'Gamma'], 'down undoes up, so the deck is back');

  const top = await call(routes, 'POST /edit/slide', { body: { op: 'up', slide: 1 } });
  assert.equal(top.code, 409);
  assert.equal(top.body.error, 'already the first slide');
  const bottom = await call(routes, 'POST /edit/slide', { body: { op: 'down', slide: 3 } });
  assert.equal(bottom.code, 409);
  assert.equal(bottom.body.error, 'already the last slide');
  assert.equal(history.counts().undo, 2, 'neither refusal spent an undo entry');
});

test('POST /edit/slide counts hidden slides like any other section', async (t) => {
  // Numbering is by SOURCE ORDER here (DECK_ANATOMY) — the same way comments,
  // review anchors and history number a deck.
  const { routes, readDeck } = harness(t, THREE.replace('<section data-layout="centered">', '<section data-hidden>'));
  const r = await call(routes, 'POST /edit/slide', { body: { op: 'down', slide: 2 } });
  assert.deepEqual([r.body.slide, r.body.total], [3, 3], 'a hidden slide is still slide 2');
  assert.deepEqual(titles(readDeck()), ['Alpha', 'Gamma', 'Beta']);
});

test('POST /edit/slide refuses a bad op or slide with 400, and an absent slide with 404', async (t) => {
  const { routes, readDeck } = harness(t, THREE);
  const before = readDeck();
  for (const body of [{ op: 'shuffle', slide: 1 }, { op: 'new', slide: 1.5 }, { op: 'new', slide: 0 }, { slide: 1 }]) {
    const r = await call(routes, 'POST /edit/slide', { body });
    assert.equal(r.code, 400, `${JSON.stringify(body)} was accepted`);
    assert.equal(r.body.error, 'bad payload');
  }
  const gone = await call(routes, 'POST /edit/slide', { body: { op: 'new', slide: 9 } });
  assert.equal(gone.code, 404, 'a slide the deck does not have is not found, not a crash');
  assert.match(gone.body.error, /no slide 9 \(deck has 3\)/);
  assert.equal(readDeck(), before, 'and nothing was written on the way to either answer');
});

/**
 * Call POST /edit/asset the way the dispatcher calls a BEFORE_BODY route: the
 * raw request stream and its headers, and no body string at all.
 *
 * `pulled` counts the chunks the handler actually took, which is how the size
 * limit is checked honestly — a limit that buffers the whole upload before
 * announcing it costs more than it saves.
 */
async function upload(routes, { type = 'image/png', name = 'photo.PNG', chunks = ['x'], length } = {}) {
  const handler = routes.get('POST /edit/asset');
  assert.ok(handler, 'no handler registered for POST /edit/asset');
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
    req, res: {}, url: new URL('http://x/edit/asset'),
    json: (code, obj) => { sent.code = code; sent.body = obj; }, CORS: {},
  });
  return { ...sent, pulled };
}

test('POST /edit/asset saves a dropped image under assets/, named safely', async (t) => {
  const { routes, dir } = harness(t, THREE);
  const r = await upload(routes, { name: 'My Holiday Photo!.jpeg', type: 'image/png', chunks: ['png-bytes'] });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, src: 'assets/my-holiday-photo.png', bytes: 9 },
    'the extension comes from the content type, never from the name the browser sent');
  assert.equal(readFileSync(path.join(dir, 'assets', 'my-holiday-photo.png'), 'utf8'), 'png-bytes',
    'the bytes are saved as they arrived — an editor that rewrote them would be lying about the slide');
});

test('POST /edit/asset never writes outside assets/, whatever the name claims', async (t) => {
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

test('POST /edit/asset de-duplicates rather than overwriting a picture already on a slide', async (t) => {
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

test('POST /edit/asset refuses anything that is not an image a slide can carry', async (t) => {
  const { routes, dir } = harness(t, THREE);
  for (const type of ['text/html', 'application/pdf', 'image/tiff', null, '']) {
    const r = await upload(routes, { type, chunks: ['x'] });
    assert.equal(r.code, 415, `${type} was accepted`);
    assert.equal(r.body.ok, false);
  }
  assert.ok(!existsSync(path.join(dir, 'assets')), 'a refused upload must not even make the folder');
});

test('POST /edit/asset refuses an oversized upload WITHOUT reading it', async (t) => {
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

test('POST /edit/asset takes an SVG as it is, but refuses one carrying a script', async (t) => {
  const { routes, dir } = harness(t, THREE);
  const plain = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
  const ok = await upload(routes, { type: 'image/svg+xml', name: 'diagram.svg', chunks: [plain] });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.src, 'assets/diagram.svg');
  assert.equal(readFileSync(path.join(dir, 'assets', 'diagram.svg'), 'utf8'), plain,
    'nothing is stripped — decklight present --check names what a deck runs (SPEC PRESENTING), it does not edit it');

  const armed = await upload(routes, {
    type: 'image/svg+xml',
    name: 'trap.svg',
    chunks: ['<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("//evil")</script></svg>'],
  });
  assert.equal(armed.code, 400);
  assert.equal(armed.body.error, 'an SVG with a script is not an image');
  assert.ok(!existsSync(path.join(dir, 'assets', 'trap.svg')), 'a refused SVG must not reach the disk at all');
});

test('POST /edit/image puts the picture on the slide, not inside the notes', async (t) => {
  const { routes, readDeck, history } = harness(t, THREE);
  const r = await call(routes, 'POST /edit/image', {
    body: { slide: 1, index: null, src: 'assets/chart.png', alt: 'revenue by quarter' },
  });
  assert.equal(r.code, 200);
  assert.equal(r.body.index, 1, 'the answer names the new element, since everything after it has shifted');
  assert.equal(history.counts().undo, 1);
  assert.match(readDeck(), /<h2>Alpha<\/h2>\n {6}<img src="assets\/chart\.png" alt="revenue by quarter">\n {6}<aside/,
    'an image inside the aside is an image the audience never sees');
});

test('POST /edit/image accepts an explicit index, addressed like the element routes', async (t) => {
  const { routes, readDeck } = harness(t, THREE);
  const r = await call(routes, 'POST /edit/image', { body: { slide: 2, index: 0, src: 'assets/a.png', alt: '' } });
  assert.equal(r.body.index, 1);
  assert.match(readDeck(), /<h2>Beta<\/h2>\n {6}<img src="assets\/a\.png" alt="">/);
});

test('POST /edit/image refuses an src that is not a path beside the deck', async (t) => {
  const { routes, readDeck } = harness(t, THREE);
  const before = readDeck();
  for (const src of [
    'https://example.org/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAA',
    '/etc/passwd.png', '../secrets/a.png', 'a/../../b.png', '', 7, null,
  ]) {
    const r = await call(routes, 'POST /edit/image', { body: { slide: 1, index: null, src, alt: '' } });
    assert.equal(r.code, 400, `${JSON.stringify(src)} was accepted as an image src`);
    assert.equal(r.body.ok, false);
  }
  assert.equal(readDeck(), before, 'a deck is one file and what sits beside it — nothing else reached it');
});

test('POST /edit/image refuses a bad payload with 400 and an absent slide with 404', async (t) => {
  const { routes } = harness(t, THREE);
  for (const body of [{ slide: 0, src: 'a.png' }, { slide: 1, index: -1, src: 'a.png' }, { slide: 1, index: 1.5, src: 'a.png' }]) {
    const r = await call(routes, 'POST /edit/image', { body });
    assert.equal(r.code, 400, `${JSON.stringify(body)} was accepted`);
  }
  const gone = await call(routes, 'POST /edit/image', { body: { slide: 9, index: null, src: 'a.png', alt: '' } });
  assert.equal(gone.code, 404);
  assert.match(gone.body.error, /no slide 9/);
  const noChild = await call(routes, 'POST /edit/image', { body: { slide: 2, index: 7, src: 'a.png', alt: '' } });
  assert.equal(noChild.code, 404, 'an index the slide does not have is not found, not a crash');
});
