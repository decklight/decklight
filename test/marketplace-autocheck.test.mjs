// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// "Check for updates when decklight starts" (SPEC MARKETPLACES_SCREEN, #894):
// off until it is turned on, and nothing runs while it is off; on, a starting
// server runs `marketplace outdated` once in a window and records the answer;
// the deck offers what is behind, naming what it uses from there, and a
// dismissal holds for that commit only. Every check here is a fake `run` or a
// LOCAL marketplace, so nothing reaches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.mjs';
import { saveRegistry, loadRegistry } from '../cli/marketplace.mjs';
import {
  AUTO_CHECK_WINDOW_MS, autoCheckOn, autoCheckOffered, setAutoCheck, markAutoCheckOffered, autoCheckDue,
  readCheckRecord, recordCheck, noteUpdated, dismissOffer, autoCheckOffers, checkSummary, runAutoCheck, offerText,
} from '../cli/marketplace-autocheck.mjs';
import { autoCheckToastText } from '../src/core/marketplaces.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

/** A home with two registered remotes, never fetched for real: the check is faked. */
function home(t) {
  const h = tmp('autocheck-home', t);
  saveRegistry({ version: 1, marketplaces: {
    'decklight-confluent': { source: 'confluentinc/decklight-confluent', commit: A },
    acme: { source: 'acme/themes', commit: B },
  } }, h);
  return h;
}

/** What `outdated --json` answers: confluent behind (A → C), acme current. */
const answer = (remote = C) => ({
  marketplaces: [
    { name: 'acme', state: 'current', commit: B, remote: B, local: false },
    { name: 'decklight-confluent', state: 'behind', commit: A, remote, local: false },
  ],
});

/** A `run` that answers like the command, and counts. */
function fakeRun(json = answer()) {
  const calls = [];
  const run = async (args) => { calls.push(args); return { ok: true, stdout: JSON.stringify(json) }; };
  return { run, calls };
}

const DECK = `<!doctype html><html><head>
<script type="application/json" data-decklight-config>
{ "decklight": "0.9.0", "designSystems": ["confluent-developer@decklight-confluent"], "fonts": ["inter@acme"] }
</script></head><body><div class="decklight"><section><h2>x</h2></section></div></body></html>`;

test('off until it is turned on, and nothing runs while it is off', async (t) => {
  const h = home(t);
  assert.equal(autoCheckOn(h), false);
  assert.equal(autoCheckDue(h), false);
  const { run, calls } = fakeRun();
  assert.equal(await runAutoCheck({ run, home: h }), null);
  assert.deepEqual(calls, [], 'no command ran');
  assert.equal(readCheckRecord(h), null, 'nothing recorded');
  recordCheck(answer().marketplaces, h);
  assert.deepEqual(await autoCheckOffers(DECK, h), [], 'a recorded answer offers nothing while it is off');
});

test('on, a starting server runs `outdated --json` once in the window, and records the answer', async (t) => {
  const h = home(t);
  assert.equal(setAutoCheck(true, h), true);
  assert.equal(loadRegistry(h).autoCheck, true, 'kept in the registry, per machine');
  const { run, calls } = fakeRun();
  const now = 1_000_000_000_000;
  const rec = await runAutoCheck({ run, home: h, now });
  assert.deepEqual(calls, [['outdated', '--json']], 'the same command C runs');
  assert.equal(rec.checkedAt, now);
  assert.deepEqual(rec.marketplaces.map((r) => [r.name, r.state]), [['acme', 'current'], ['decklight-confluent', 'behind']]);
  assert.equal(await runAutoCheck({ run, home: h, now: now + AUTO_CHECK_WINDOW_MS - 1 }), null, 'a restart in the window asks nothing');
  assert.equal(calls.length, 1);
  assert.ok(await runAutoCheck({ run, home: h, now: now + AUTO_CHECK_WINDOW_MS }), 'past the window it asks again');
  assert.equal(calls.length, 2);
  assert.equal(checkSummary(rec, now + 3 * 60 * 1000), 'checked 3 min ago: 1 of 2 out of date');
});

test('a check that fails is silent: nothing recorded, nothing thrown', async (t) => {
  const h = home(t);
  setAutoCheck(true, h);
  assert.equal(await runAutoCheck({ run: async () => ({ ok: false, error: 'offline' }), home: h }), null);
  assert.equal(await runAutoCheck({ run: async () => { throw new Error('boom'); }, home: h }), null);
  assert.equal(await runAutoCheck({ run: async () => ({ ok: true, stdout: 'not json' }), home: h }), null);
  assert.equal(readCheckRecord(h), null);
});

test('the deck offers what is behind and names what it uses from there; a dismissal holds for that commit only', async (t) => {
  const h = home(t);
  setAutoCheck(true, h);
  recordCheck(answer().marketplaces, h);
  const [o, ...more] = await autoCheckOffers(DECK, h);
  assert.equal(more.length, 0, 'the current one is not offered');
  assert.equal(o.name, 'decklight-confluent');
  assert.equal(o.remote, C);
  assert.equal(o.text, 'decklight-confluent has an update: this deck uses confluent-developer (design system) from it');
  assert.equal(offerText({ name: 'acme' }), 'acme has an update', 'a deck that uses nothing from it is told only that');

  dismissOffer('decklight-confluent', C, h);
  assert.deepEqual(await autoCheckOffers(DECK, h), [], 'dismissed at that commit');
  recordCheck(answer('d'.repeat(40)).marketplaces, h);
  assert.equal((await autoCheckOffers(DECK, h)).length, 1, 'the next commit is offered again');
});

test('an update takes the marketplace out of the offer', async (t) => {
  const h = home(t);
  setAutoCheck(true, h);
  recordCheck(answer().marketplaces, h);
  assert.equal(noteUpdated('decklight-confluent', C, h), true);
  assert.deepEqual(await autoCheckOffers(DECK, h), []);
  assert.equal(readCheckRecord(h).marketplaces.find((r) => r.name === 'decklight-confluent').state, 'current');
});

test('a check of one marketplace folds into the record without moving the window; a never-fetched one is not offered', async (t) => {
  const h = home(t);
  setAutoCheck(true, h);
  recordCheck(answer().marketplaces, h, { now: 1000 });
  recordCheck([{ name: 'acme', state: 'unfetched', commit: null, remote: null }], h, { all: false, now: 5000 });
  const rec = readCheckRecord(h);
  assert.equal(rec.checkedAt, 1000);
  assert.equal(rec.marketplaces.length, 2);
  assert.deepEqual((await autoCheckOffers(DECK, h)).map((x) => x.name), ['decklight-confluent']);
});

test('the screen asks once whether to turn it on, and turning it either way answers that', (t) => {
  const h = home(t);
  assert.equal(autoCheckOffered(h), false);
  assert.equal(markAutoCheckOffered(h), true);
  assert.equal(markAutoCheckOffered(h), false, 'asked once');
  const h2 = home(t);
  setAutoCheck(false, h2);
  assert.equal(autoCheckOffered(h2), true);
});

test('the toast: one offer in the server\'s sentence, several named together, none says nothing', () => {
  assert.equal(autoCheckToastText([]), '');
  assert.equal(autoCheckToastText([{ name: 'a', text: 'a has an update', uses: [] }]), 'a has an update');
  assert.equal(autoCheckToastText([{ name: 'a', uses: [{ name: 'x' }] }, { name: 'b', uses: [] }]),
    '2 marketplaces have updates: a, b (this deck uses a)');
});

test('`decklight marketplace auto-check on|off` sets it, `list` says which, and `outdated` records its answer', (t) => {
  const h = tmp('autocheck-cli', t);
  const market = tmp('autocheck-market', t);
  mkdirSync(path.join(market, '.decklight'), { recursive: true });
  writeFileSync(path.join(market, '.decklight', 'marketplace.json'), JSON.stringify({ name: 'northwind', entries: [] }));
  const env = { ...process.env, DECKLIGHT_HOME: h, DECKLIGHT_NO_UPDATE_CHECK: '1', GIT_TERMINAL_PROMPT: '0' };
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'marketplace', ...args], { encoding: 'utf8', env });
  assert.equal(cli('add', market, '--name', 'northwind').status, 0);
  // the first-party one is registered on first run and never fetched; keep this offline
  const reg = loadRegistry(h);
  for (const n of Object.keys(reg.marketplaces)) if (n !== 'northwind') delete reg.marketplaces[n];
  saveRegistry(reg, h);

  assert.match(cli('list').stdout, /^auto-check: off — decklight marketplace auto-check on/m);
  assert.match(cli('auto-check').stdout, /^auto-check: off/);
  const on = cli('auto-check', 'on');
  assert.equal(on.status, 0, on.stderr);
  assert.match(cli('list').stdout, /^auto-check: on — not checked yet/m);
  assert.equal(cli('auto-check', 'maybe').status, 1);

  assert.equal(cli('outdated').status, 0);
  assert.deepEqual(readCheckRecord(h).marketplaces.map((r) => [r.name, r.state]), [['northwind', 'current']]);
  assert.match(cli('list').stdout, /^auto-check: on — checked just now: all up to date/m);
  writeFileSync(path.join(market, '.decklight', 'marketplace.json'), JSON.stringify({ name: 'northwind', entries: [], description: 'moved' }));
  cli('outdated');
  assert.equal(readCheckRecord(h).marketplaces[0].state, 'behind');
  assert.equal(cli('update', 'northwind').status, 0);
  assert.equal(readCheckRecord(h).marketplaces[0].state, 'current', 'an update clears what the record says');
  assert.equal(cli('auto-check', 'off').status, 0);
  assert.equal(JSON.parse(readFileSync(path.join(h, 'marketplaces.json'), 'utf8')).autoCheck, false);
});
