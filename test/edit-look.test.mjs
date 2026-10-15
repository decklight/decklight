// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The look routes (cli/edit-look.mjs), called as functions.
//
// The theme pick, the brand-themes switch and the marks were lifted out of
// editMain with the six bindings they use and nothing else, so the harness is
// the one test/edit-slides.test.mjs uses: a temp deck, `applyEdit` and
// `writeDeck` wired as editMain wires them, and a fake `json`. The marketplace
// half is pointed at an empty DECKLIGHT_HOME, so the browse lists and the
// refusals for a catalog this machine has never heard of are answered from a
// cache that is honestly empty, never from the author's real one, and nothing
// here reaches the network.
//
// What is NOT tested here is the dispatch (the table, the CSRF gate, the body
// read): test/edit.test.mjs holds that over a real socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerLookRoutes } from '../cli/edit-look.mjs';
import { createHistory } from '../cli/edit.mjs';
import { tmp } from './helpers.mjs';

// the marketplace cache these routes read: empty, and this file's own
process.env.DECKLIGHT_HOME = tmp('edit-look-home');

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
    </section>
  </div>
</body></html>
`;

/** A deck with no configuration block, no embedded theme and no theme link: nowhere to write a theme. */
const BARE = `<!doctype html>
<html><body>
  <div class="decklight"><section><h2>Bare</h2></section></div>
</body></html>
`;

/**
 * A deck on disk and the bindings the handlers are given, wired as editMain
 * wires them: `writeDeck` is the one write of the file, `applyEdit` snapshots
 * onto the history and goes through it, and `quiet` and `broadcast` are
 * recorded so a test can say which writes were in place.
 */
function harness(t, html = DECK, extra = {}) {
  const dir = tmp('edit-look', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, html);
  const history = createHistory();
  const readDeck = () => readFileSync(deck, 'utf8');
  const writes = [];
  const writeDeck = (next) => { writes.push(next); writeFileSync(deck, next); };
  const applyEdit = (change, before = readDeck()) => {
    const next = typeof change === 'function' ? change(before) : change;
    if (next === before) return false;
    history.record(before);
    writeDeck(next);
    return true;
  };
  const quiet = [];
  const sent = [];
  const routes = new Map();
  registerLookRoutes(routes, {
    readDeck, applyEdit, writeDeck, history,
    broadcast: (e, d) => sent.push([e, d]),
    quiet: (h) => quiet.push(h),
    deckPath: deck,
    ...extra,
  });
  return { routes, history, readDeck, deck, dir, writes, quiet, sent };
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

test('every look route the server dispatches is registered here', () => {
  const { routes } = harness();
  assert.deepEqual([...routes.keys()].sort(), [
    'GET /deck/edit/design-system/browse',
    'GET /deck/edit/font/browse',
    'GET /deck/edit/theme/browse',
    'POST /deck/edit/brand-themes',
    'POST /deck/edit/design-system/apply',
    'POST /deck/edit/design-system/mark',
    'POST /deck/edit/font/mark',
    'POST /deck/edit/marketplace/add',
    'POST /deck/edit/theme',
    'POST /deck/edit/theme/add',
    'POST /deck/edit/theme/mark',
  ], 'a route that leaves this list has left the edit server too');
});

test('POST /deck/edit/theme writes the deck\'s theme into its config block as one undo entry, and the same pick again is nothing', async (t) => {
  const { routes, readDeck, history, quiet, sent } = harness(t);
  const r = await call(routes, 'POST /deck/edit/theme', { body: { theme: 'carbon' } });
  assert.deepEqual(r.body, { ok: true, changed: true, inPlace: false, undo: 1, redo: 0 });
  assert.match(readDeck(), /"theme": "carbon"/);
  assert.doesNotMatch(readDeck(), /aurora/, 'the theme is swapped, not added beside the old one');
  assert.deepEqual([quiet, sent], [[], []], 'not asked in place: the ordinary reload, and no event');
  const again = await call(routes, 'POST /deck/edit/theme', { body: { theme: 'carbon' } });
  assert.deepEqual([again.body.changed, again.body.undo], [false, 1], 'an unchanged write spends no undo entry');
  assert.equal(history.counts().undo, 1);
});

test('POST /deck/edit/theme asked in place is quiet: the bytes written are the quiet ones, and every page is sent a theme event', async (t) => {
  const { routes, readDeck, quiet, sent } = harness(t);
  const r = await call(routes, 'POST /deck/edit/theme', { body: { theme: 'berry', quiet: true, from: 'page-1' } });
  assert.deepEqual([r.body.changed, r.body.inPlace], [true, true]);
  assert.deepEqual(quiet, [readDeck()], 'the watcher is told to skip exactly the file as written');
  assert.deepEqual(sent, [['theme', { theme: 'berry', from: 'page-1' }]]);
  const same = await call(routes, 'POST /deck/edit/theme', { body: { theme: 'berry', quiet: true } });
  assert.deepEqual([same.body.changed, same.body.inPlace], [false, false]);
  assert.deepEqual([quiet.length, sent.length], [1, 1], 'nothing written, nothing quieted, nothing sent');
});

test('POST /deck/edit/theme on a bundle picks among the themes it embeds, and refuses one it does not carry', async (t) => {
  const bundle = `<!doctype html>
<html><head>
<style data-theme="aurora">a{}</style>
<style data-theme="carbon" media="not all">b{}</style>
</head><body><div class="decklight"><section><h2>B</h2></section></div></body></html>
`;
  const { routes, readDeck, history } = harness(t, bundle);
  const r = await call(routes, 'POST /deck/edit/theme', { body: { theme: 'carbon' } });
  assert.equal(r.body.changed, true);
  assert.match(readDeck(), /<style data-theme="aurora" media="not all">/);
  assert.match(readDeck(), /<style data-theme="carbon">/, 'the chosen block is the active one');
  const before = readDeck();
  const missing = await call(routes, 'POST /deck/edit/theme', { body: { theme: 'berry' } });
  assert.equal(missing.code, 409);
  assert.match(missing.body.error, /a bundle holds only the themes it embeds/);
  assert.equal(readDeck(), before, 'a refusal leaves the file byte-for-byte alone');
  assert.equal(history.counts().undo, 1, 'and records nothing');
});

test('POST /deck/edit/theme refuses a name that is not a name (400) and a deck with nowhere to write it (409), writing nothing', async (t) => {
  const { routes, readDeck, writes } = harness(t);
  const before = readDeck();
  for (const theme of ['../etc', 'two words', '', 7, null]) {
    const r = await call(routes, 'POST /deck/edit/theme', { body: { theme } });
    assert.equal(r.code, 400, `${JSON.stringify(theme)} was accepted`);
    assert.equal(r.body.error, 'theme is a name');
  }
  assert.equal(readDeck(), before);

  const bare = harness(t, BARE);
  const r = await call(bare.routes, 'POST /deck/edit/theme', { body: { theme: 'carbon', quiet: true } });
  assert.equal(r.code, 409);
  assert.equal(bare.readDeck(), BARE);
  assert.deepEqual([writes.length, bare.writes.length, bare.quiet.length, bare.sent.length], [0, 0, 0, 0]);
  assert.equal(bare.history.counts().undo, 0);
});

test('POST /deck/edit/brand-themes records "false" in the config block to show every theme, and takes it off again', async (t) => {
  const { routes, readDeck, history } = harness(t);
  const off = await call(routes, 'POST /deck/edit/brand-themes', { body: { only: false } });
  assert.deepEqual([off.code, off.body.changed, off.body.undo], [200, true, 1]);
  assert.match(readDeck(), /"brandThemesOnly": false/);
  const on = await call(routes, 'POST /deck/edit/brand-themes', { body: { only: true } });
  assert.deepEqual([on.body.changed, on.body.undo], [true, 2]);
  assert.doesNotMatch(readDeck(), /brandThemesOnly/, 'true is the default, so the key is taken off rather than written');
  assert.match(readDeck(), /"theme": "aurora"\n\}/, 'and the comma that joined it goes with it');
  const same = await call(routes, 'POST /deck/edit/brand-themes', { body: { only: true } });
  assert.equal(same.body.changed, false);
  assert.equal(history.counts().undo, 2);
});

test('POST /deck/edit/brand-themes in place is quiet and tells every page; a bad value is 400 and a deck without a block 409', async (t) => {
  const { routes, readDeck, quiet, sent } = harness(t);
  const r = await call(routes, 'POST /deck/edit/brand-themes', { body: { only: false, quiet: true, from: 'p' } });
  assert.equal(r.body.inPlace, true);
  assert.deepEqual(quiet, [readDeck()]);
  assert.deepEqual(sent, [['styles', { slide: 1, index: 0, from: 'p' }]]);

  const before = readDeck();
  for (const only of ['false', 0, null, undefined]) {
    const bad = await call(routes, 'POST /deck/edit/brand-themes', { body: { only } });
    assert.equal(bad.code, 400, `${JSON.stringify(only)} was accepted`);
  }
  assert.equal(readDeck(), before);

  const bare = harness(t, BARE);
  const none = await call(bare.routes, 'POST /deck/edit/brand-themes', { body: { only: false } });
  assert.equal(none.code, 409);
  assert.match(none.body.error, /decklight upgrade --link/);
  assert.equal(bare.readDeck(), BARE);
});

test('POST /deck/edit/theme/mark marks a shipped theme in the config block as one undo entry, and unmarks it', async (t) => {
  const { routes, readDeck, history, quiet, writes } = harness(t);
  const r = await call(routes, 'POST /deck/edit/theme/mark', { body: { ref: 'carbon', quiet: true } });
  assert.deepEqual(r.body, { ok: true, ref: 'carbon', marked: true, changed: true, undo: 1, redo: 0 });
  assert.match(readDeck(), /"markedThemes": \[\s*"carbon"\s*\]/);
  assert.deepEqual(quiet, [readDeck()], 'the picker asked for quiet: the bytes it wrote are the ones quieted');
  const again = await call(routes, 'POST /deck/edit/theme/mark', { body: { ref: 'carbon' } });
  assert.equal(again.body.changed, false, 'marking twice is one mark');
  const off = await call(routes, 'POST /deck/edit/theme/mark', { body: { ref: 'carbon', marked: false } });
  assert.deepEqual([off.body.marked, off.body.changed, off.body.undo], [false, true, 2]);
  assert.doesNotMatch(readDeck(), /"carbon"/);
  assert.equal(writes.length, 2, 'two writes, one per change');
  assert.equal(history.counts().undo, 2);
  assert.equal(quiet.length, 1, 'only the write asked for in place was quiet');
});

test('POST /deck/edit/theme/add is 0.9.0\'s name for marking, and means exactly that', async (t) => {
  const { routes, readDeck } = harness(t);
  const r = await call(routes, 'POST /deck/edit/theme/add', { body: { ref: 'berry' } });
  assert.deepEqual([r.code, r.body.marked, r.body.changed], [200, true, true]);
  assert.match(readDeck(), /"markedThemes": \[\s*"berry"\s*\]/);
});

test('the marks refuse what they cannot resolve, and leave the deck byte-for-byte alone', async (t) => {
  const { routes, readDeck, history } = harness(t);
  const before = readDeck();
  const cases = [
    ['POST /deck/edit/theme/mark', { ref: 'not-a-shipped-theme' }, 400, /which theme/],
    ['POST /deck/edit/theme/mark', { ref: 'ghost@nowhere' }, 404, /./],
    ['POST /deck/edit/design-system/mark', { ref: 'plain' }, 400, /name@marketplace/],
    ['POST /deck/edit/design-system/mark', { ref: 'ghost@nowhere' }, 404, /./],
    ['POST /deck/edit/font/mark', { ref: 'plain' }, 400, /name@marketplace/],
    ['POST /deck/edit/font/mark', { ref: 'ghost@nowhere' }, 404, /./],
    ['POST /deck/edit/design-system/apply', { ref: 'ghost@nowhere' }, 404, /this deck does not use ghost@nowhere/],
  ];
  for (const [key, body, code, error] of cases) {
    const r = await call(routes, key, { body });
    assert.equal(r.code, code, `${key} ${JSON.stringify(body)} answered ${r.code}: ${r.body.error}`);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, error);
  }
  assert.equal(readDeck(), before);
  assert.equal(history.counts().undo, 0, 'no refusal is an undo entry');
});

test('a mark on a deck with no config block is a 409 that says how to give it one', async (t) => {
  const { routes, readDeck } = harness(t, BARE);
  const r = await call(routes, 'POST /deck/edit/theme/mark', { body: { ref: 'carbon' } });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /no configuration block/);
  assert.equal(readDeck(), BARE);
});

test('the browse lists read the cache only: an empty one lists nothing, and says it never left this machine', async (t) => {
  const { routes, readDeck } = harness(t);
  const before = readDeck();
  const themes = await call(routes, 'GET /deck/edit/theme/browse');
  assert.deepEqual(themes, { code: 200, body: { ok: true, themes: [], stale: [], cacheOnly: true } });
  const systems = await call(routes, 'GET /deck/edit/design-system/browse');
  assert.deepEqual([systems.code, systems.body.systems, systems.body.cacheOnly], [200, [], true]);
  const fonts = await call(routes, 'GET /deck/edit/font/browse');
  assert.deepEqual([fonts.code, fonts.body.fonts, fonts.body.cacheOnly], [200, [], true]);
  assert.equal(readDeck(), before, 'a list is a read');
});

// ── Add a marketplace… (SPEC DESIGN_SYSTEMS, PLATFORM MARKETPLACE_REGISTRY) ──

/** A local marketplace beside the deck, offering one design system and one theme. */
function localMarketplace(dir, name = 'northwind', manifest = null) {
  const root = path.join(dir, name);
  mkdirSync(path.join(root, '.decklight'), { recursive: true });
  writeFileSync(path.join(root, '.decklight', 'marketplace.json'), manifest ?? JSON.stringify({
    name, entries: [
      { name: 'northwind', type: 'design-system', source: 'systems/northwind', version: '1.0.0', apiVersion: 1 },
      { name: 'northwind-dark', type: 'theme', source: './themes/northwind-dark.css' },
    ],
  }));
  return root;
}

test('POST /deck/edit/marketplace/add without confirm says what it would do, reads a relative path from the deck\'s folder, and registers nothing', async (t) => {
  let ran = 0;
  const { routes, dir } = harness(t, DECK, { addMarketplace: async () => { ran++; return { ok: true }; } });
  const root = localMarketplace(dir);
  const r = await call(routes, 'POST /deck/edit/marketplace/add', { body: { spec: './northwind' } });
  assert.equal(r.code, 200);
  assert.equal(r.body.confirm, true);
  assert.equal(r.body.plan.spec, root, 'registered absolute: a relative source would mean something else to the next update');
  assert.equal(r.body.plan.kind, 'local');
  assert.match(r.body.plan.does, /^register .*northwind — read in place, nothing is fetched$/);
  assert.equal(ran, 0, 'the first ⏎ runs nothing');
});

test('POST /deck/edit/marketplace/add names the clone a remote source would make, before making it', async (t) => {
  const { routes } = harness(t, DECK, { addMarketplace: async () => assert.fail('nothing is cloned without confirm') });
  const r = await call(routes, 'POST /deck/edit/marketplace/add', { body: { spec: 'acme/brand-kit' } });
  assert.equal(r.body.plan.url, 'https://github.com/acme/brand-kit.git');
  assert.match(r.body.plan.does, /^clone https:\/\/github\.com\/acme\/brand-kit\.git with your git credentials on this machine$/);
});

test('POST /deck/edit/marketplace/add refuses what is not a source, in a sentence, before anything runs', async (t) => {
  const { routes, dir } = harness(t, DECK, { addMarketplace: async () => assert.fail('a refusal runs nothing') });
  for (const [spec, why] of [
    ['', /needs an owner\/repo, a git url, or a path/],
    ['--upload-pack=x', /is not an owner\/repo, a git url, or a path/],
    ['acme/x\nevil', /is not an owner\/repo, a git url, or a path/],
    ['./nowhere', /no such directory: .*nowhere/],
  ]) {
    const r = await call(routes, 'POST /deck/edit/marketplace/add', { body: { spec, confirm: true } });
    assert.equal(r.code, 400, spec);
    assert.match(r.body.error, why, spec);
  }
  mkdirSync(path.join(dir, 'plain'));
  const r = await call(routes, 'POST /deck/edit/marketplace/add', { body: { spec: './plain', confirm: true } });
  assert.match(r.body.error, /has no \.decklight\/marketplace\.json — is it a marketplace\?/);
});

test('POST /deck/edit/marketplace/add with confirm runs `decklight marketplace add`: the registry has it as the command line would, and the answer counts what it offers', async (t) => {
  const { loadRegistry } = await import('../cli/marketplace.mjs');
  const { routes, dir } = harness(t);
  const root = localMarketplace(dir, 'northwind-door');
  const r = await call(routes, 'POST /deck/edit/marketplace/add', { body: { spec: './northwind-door', confirm: true } });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.name, 'northwind-door');
  assert.equal(r.body.refreshed, false);
  assert.deepEqual(r.body.counts, { 'design-system': 1, theme: 1 });
  assert.match(r.body.said, /^registered northwind-door from /);
  assert.equal(loadRegistry().marketplaces['northwind-door']?.source, root);
  // the same again is a refresh, as `add` of a registered source is
  const again = await call(routes, 'POST /deck/edit/marketplace/add', { body: { spec: root } });
  assert.equal(again.body.plan.registered, 'northwind-door');
});

test('POST /deck/edit/marketplace/add says why a registration failed, and leaves nothing registered', async (t) => {
  const { loadRegistry } = await import('../cli/marketplace.mjs');
  const { routes, dir } = harness(t);
  localMarketplace(dir, 'broken-door', '{ "name": "broken-door", "entries": [ { "name": "x" } ] }');
  const r = await call(routes, 'POST /deck/edit/marketplace/add', { body: { spec: './broken-door', confirm: true } });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /is not a valid marketplace manifest/);
  assert.match(r.body.error, /entries\[0\]\.type/, 'the reason, not only the fact');
  assert.equal(loadRegistry().marketplaces['broken-door'], undefined);
});
