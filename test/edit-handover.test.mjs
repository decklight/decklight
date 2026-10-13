// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The hand-over routes (cli/edit-handover.mjs), called as functions.
//
// An export or a publish proper launches Chrome, spawns a tool or pushes to a
// remote, and none of that belongs in a unit test: those runs are held by the
// render suite and test/edit.test.mjs. What this file holds is everything a
// route decides BEFORE it reaches for any of that: the payload refusals, the
// theme question (`unmarkedOnScreen`), the publish plan's "nowhere to publish
// to", and the two routes that only read the deck (the bundle estimate and the
// inspector). Each is a temp deck, the five bindings editMain hands over and a
// fake `json`, the harness test/edit-slides.test.mjs uses.
//
// The "an export is already running" refusal is not here: the flag is only
// raised after Chrome is found, by an export that then runs for real, so the
// only honest way to see it is two exports racing on a live server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerHandoverRoutes } from '../cli/edit-handover.mjs';
import { tmp } from './helpers.mjs';

// the marketplace cache the theme question reads: empty, and this file's own
process.env.DECKLIGHT_HOME = tmp('edit-handover-home');

const DECK = `<!doctype html>
<html><head>
<script type="application/json" data-decklight-config>
{
  "decklight": "0.9.0",
  "theme": "aurora"
}
</script>
</head><body>
  <div class="decklight">
    <section>
      <h2>Alpha</h2>
      <ul><li>one</li></ul>
    </section>
    <section>
      <h2>Beta</h2>
      <img src="assets/missing.png" alt="a chart">
    </section>
  </div>
</body></html>
`;

/** A bundle: its theme embedded, its runtime inline, nothing left to flatten. */
const ONE_FILE = `<!doctype html>
<html><head>
<style data-theme="aurora">a{}</style>
</head><body>
  <div class="decklight"><section><h2>Only</h2></section></div>
  <script data-decklight-runtime="js">window.Decklight = {};</script>
</body></html>
`;

/**
 * A deck on disk and the bindings the handlers are given, wired as editMain
 * wires them. `gitOn` is a getter over a variable the test owns, as editMain's
 * is over its `let`; `root` is the deck's own directory, the repository a
 * publish would push from when the test makes it one.
 */
function harness(t, html = DECK, { git = false } = {}) {
  const dir = tmp('edit-handover', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, html);
  const readDeck = () => readFileSync(deck, 'utf8');
  const sent = [];
  const state = { gitOn: git };
  const routes = new Map();
  registerHandoverRoutes(routes, {
    readDeck, deckPath: deck, root: dir,
    gitOn: () => state.gitOn,
    broadcast: (e, d) => sent.push([e, d]),
  });
  return { routes, readDeck, deck, dir, sent, state };
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

test('every hand-over route the server dispatches is registered here', () => {
  const { routes } = harness();
  assert.deepEqual([...routes.keys()].sort(), [
    'GET /deck/edit/export/estimate',
    'GET /deck/edit/inspect',
    'GET /deck/edit/publish/plan',
    'POST /deck/edit/export',
    'POST /deck/edit/publish',
  ], 'a route that leaves this list has left the edit server too');
});

test('POST /deck/edit/export refuses a bad payload before anything runs, and the deck and its folder are untouched', async (t) => {
  const { routes, readDeck, dir, sent } = harness(t);
  const cases = [
    [{ kind: 'docx' }, 400, /not a file this server writes: docx — try pptx, pdf, pdf-notes, pdf-handout, video, bundle/],
    [{ kind: 'pdf', theme: '../evil' }, 400, /the theme is a theme name/],
    [{ kind: 'pdf', theme: 7 }, 400, /the theme is a theme name/],
    [{ kind: 'pdf', gen: 'not base64url!' }, 400, /base64url/],
    [{ kind: 'pdf', theme: 'carbon', gen: 'abc' }, 400, /one theme/],
    [{ kind: 'bundle', gen: 'abc' }, 400, /a generated theme lives only in this browser/],
    [{ kind: 'video', format: 'avi' }, 400, /^format must be /],
    [{ kind: 'video', slides: 'all of them' }, 400, /slides must be a-b or a single slide number/],
    [{ kind: 'video', narration: 'take-1', silent: true }, 400, /one voice at a time/],
  ];
  for (const [body, code, error] of cases) {
    const r = await call(routes, 'POST /deck/edit/export', { body });
    assert.equal(r.code, code, `${JSON.stringify(body)} answered ${r.code}: ${r.body.error}`);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, error, JSON.stringify(body));
  }
  assert.equal(readDeck(), DECK);
  assert.deepEqual(readdirSync(dir), ['talk.html'], 'a refused export writes nothing beside the deck');
  assert.deepEqual(sent, [], 'and announces nothing on the export channel');
});

test('POST /deck/edit/export asks before bundling a shipped theme the deck neither marks nor opens on', async (t) => {
  const { routes, dir, sent } = harness(t);
  const r = await call(routes, 'POST /deck/edit/export', { body: { kind: 'bundle', theme: 'carbon' } });
  assert.deepEqual(r, { code: 409, body: { ok: false, unmarked: 'carbon', error: 'carbon is not marked for this deck' } },
    'a bundle carries only what the deck marks, plus the theme it opens on');
  assert.deepEqual(readdirSync(dir), ['talk.html']);
  assert.deepEqual(sent, []);
});

test('POST /deck/edit/export refuses to bundle a deck that is already one file', async (t) => {
  const { routes, dir } = harness(t, ONE_FILE);
  const r = await call(routes, 'POST /deck/edit/export', { body: { kind: 'bundle' } });
  assert.deepEqual(r, { code: 409, body: { ok: false, error: 'this deck is already one file — send it as it is' } });
  assert.deepEqual(readdirSync(dir), ['talk.html']);
});

test('GET /deck/edit/export/estimate sizes a bundle without writing it, in the theme on screen or the deck\'s own', async (t) => {
  const { routes, dir } = harness(t);
  const plain = await call(routes, 'GET /deck/edit/export/estimate', { query: '?kind=bundle' });
  assert.equal(plain.code, 200);
  assert.equal(plain.body.ok, true);
  assert.equal(plain.body.audio, null, 'no recorded narration on this disk, so nothing to carry');
  assert.ok(Number.isInteger(plain.body.base) && plain.body.base > DECK.length,
    `a bundle is the deck plus its runtime and theme, not ${plain.body.base} bytes`);

  const themed = await call(routes, 'GET /deck/edit/export/estimate', { query: '?kind=bundle&theme=carbon' });
  assert.equal(themed.code, 200);
  assert.notEqual(themed.body.base, plain.body.base, 'the theme on screen is the one sized');

  // a theme that cannot be bundled yet falls back to the deck's own: an
  // estimate one stylesheet away is still an estimate
  const unknown = await call(routes, 'GET /deck/edit/export/estimate', { query: '?kind=bundle&theme=no-such-theme' });
  assert.deepEqual(unknown, { code: 200, body: { ok: true, base: plain.body.base, audio: null } });

  assert.deepEqual(readdirSync(dir), ['talk.html'], 'an estimate writes no file');
});

test('GET /deck/edit/export/estimate refuses every kind but the bundle, and a theme that is not a name', async (t) => {
  const { routes } = harness(t);
  const none = await call(routes, 'GET /deck/edit/export/estimate');
  assert.deepEqual([none.code, none.body.error], [400, 'no estimate for that — only a bundle has one']);
  const pdf = await call(routes, 'GET /deck/edit/export/estimate', { query: '?kind=pdf' });
  assert.deepEqual([pdf.code, pdf.body.error], [400, 'no estimate for pdf — only a bundle has one']);
  const bad = await call(routes, 'GET /deck/edit/export/estimate', { query: '?kind=bundle&theme=..%2Fx' });
  assert.deepEqual([bad.code, bad.body.error], [400, 'the theme is a theme name']);
});

test('GET /deck/edit/inspect says where a slide and each of its blocks live in the file, and what check says of it', async (t) => {
  const { routes, readDeck } = harness(t);
  const lineOf = (needle) => DECK.slice(0, DECK.indexOf(needle)).split('\n').length;

  const one = await call(routes, 'GET /deck/edit/inspect', { query: '?slide=1' });
  assert.equal(one.code, 200);
  assert.equal(one.body.file, 'talk.html');
  assert.deepEqual(one.body.lines, [lineOf('<section>'), lineOf('<section>') + 3]);
  assert.deepEqual(one.body.blocks, [
    { tag: 'h2', lines: [lineOf('<h2>Alpha'), lineOf('<h2>Alpha')] },
    { tag: 'ul', lines: [lineOf('<ul>'), lineOf('<ul>')] },
  ], 'each top-level child by the raw index the element routes use');

  const two = await call(routes, 'GET /deck/edit/inspect', { query: '?slide=2' });
  assert.equal(two.code, 200);
  assert.deepEqual(two.body.blocks.map((b) => b.tag), ['h2', 'img']);
  assert.ok(two.body.findings.some((f) => /missing\.png/.test(f.message)),
    `the missing image is the static check's finding for slide 2: ${JSON.stringify(two.body.findings)}`);
  assert.ok(two.body.findings.every((f) => Object.keys(f).sort().join() === 'level,message,rule'));
  assert.ok(!one.body.findings.some((f) => /missing\.png/.test(f.message)), 'a finding is reported on its own slide only');
  assert.equal(readDeck(), DECK, 'the inspector reads');
});

test('GET /deck/edit/inspect refuses a slide the deck does not have', async (t) => {
  const { routes } = harness(t);
  for (const q of ['?slide=0', '?slide=3', '?slide=1.5', '?slide=two', '']) {
    const r = await call(routes, 'GET /deck/edit/inspect', { query: q });
    assert.equal(r.code, 400, `${q} was accepted`);
    assert.match(r.body.error, /— the deck has 2$/);
  }
});

test('publish asks whether this session has git at all, before anything else, and reads the switch as it stands', async (t) => {
  const { routes, state } = harness(t);
  for (const key of ['GET /deck/edit/publish/plan', 'POST /deck/edit/publish']) {
    const r = await call(routes, key, { body: { theme: 'carbon' } });
    assert.deepEqual(r, { code: 409, body: { ok: false, error: 'git is off for this session — there is nothing to publish from' } }, key);
  }
  // `gitOn` is a getter: flipped after registration, the routes see it
  state.gitOn = true;
  const bad = await call(routes, 'POST /deck/edit/publish', { body: { theme: 'not a name' } });
  assert.deepEqual([bad.code, bad.body.error], [400, 'the theme is a theme name'], 'the payload is refused before any push');
});

test('GET /deck/edit/publish/plan in a repository with no remote says there is nowhere to publish to', async (t) => {
  const { routes, dir, deck } = harness(t, DECK, { git: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  g('add', path.basename(deck));
  g('commit', '-qm', 'the deck');
  const r = await call(routes, 'GET /deck/edit/publish/plan');
  assert.equal(r.code, 409);
  assert.equal(r.body.error, 'nowhere to publish to — main · no remote — this history is only on this machine');
});
