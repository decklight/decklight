// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The update notice (#314) — which is mostly a list of times decklight must say
// NOTHING, so that is what this checks. Every condition is injected: a rule
// nothing can reach is a rule nobody can check, and the cost of getting one
// wrong here is a line of noise inside somebody's piped deck.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmTemp } from './helpers.mjs';
import {
  CACHE_TTL_MS, newerVersion, noticeLine, readCache, refreshMain, stale,
  suppressed, updateNotice, writeCache,
} from '../cli/update-check.mjs';

const home = (latest, ageMs = 0) => {
  const dir = mkdtempSync(join(tmpdir(), 'decklight-update-'));
  if (latest) writeCache(latest, dir, Date.now() - ageMs);
  return dir;
};
const tty = { env: {}, isTty: true };

test('a newer version is announced, once there is an answer on disk', () => {
  const dir = home('0.5.0');
  try {
    assert.equal(updateNotice('0.4.0', { home: dir, ...tty }),
      '  update: decklight 0.5.0 is out (you have 0.4.0) — npx decklight@latest …');
    assert.match(noticeLine('0.4.0', '0.5.0'), /npx decklight@latest/, 'and it says what to type');
  } finally { rmTemp(dir); }
});

test('a machine that has never checked hears nothing', () => {
  // The first run of a fresh install has nothing to be behind on, and must not
  // pay for a network call to discover that.
  const dir = home(null);
  try { assert.equal(updateNotice('0.4.0', { home: dir, ...tty }), null); } finally { rmTemp(dir); }
});

test('every reason to stay quiet, by name', () => {
  const dir = home('9.9.9');
  try {
    assert.equal(suppressed({ env: { CI: '1' }, isTty: true }), 'CI');
    assert.equal(suppressed({ env: { DECKLIGHT_NO_UPDATE_CHECK: '1' }, isTty: true }), 'DECKLIGHT_NO_UPDATE_CHECK is set');
    assert.equal(suppressed({ env: { NO_UPDATE_NOTIFIER: '1' }, isTty: true }), 'NO_UPDATE_NOTIFIER is set',
      "the ecosystem's own opt-out — set once, meant for every CLI");
    assert.equal(suppressed({ env: {}, isTty: false }), 'stderr is not a terminal');
    assert.equal(suppressed({ env: {}, isTty: true }), false);

    for (const o of [{ env: { CI: '1' }, isTty: true }, { env: {}, isTty: false },
      { env: { DECKLIGHT_NO_UPDATE_CHECK: '1' }, isTty: true }]) {
      assert.equal(updateNotice('0.4.0', { home: dir, ...o }), null, JSON.stringify(o));
    }
  } finally { rmTemp(dir); }
});

test('only a genuinely higher version counts', () => {
  assert.equal(newerVersion('0.4.0', '0.5.0'), '0.5.0');
  assert.equal(newerVersion('0.4.0', '1.0.0'), '1.0.0');
  assert.equal(newerVersion('0.4.0', '0.4.1'), '0.4.1');
  assert.equal(newerVersion('0.4.0', '0.4.0'), null, 'the same version is not news');
  assert.equal(newerVersion('0.10.0', '0.9.0'), null, 'compared as numbers, not as strings');
  assert.equal(newerVersion('0.9.0', '0.10.0'), '0.10.0');
  // Nobody on a stable build gets nudged onto a prerelease, and a machine
  // already on one knows what it is doing.
  assert.equal(newerVersion('0.4.0', '0.5.0-rc.1'), null);
  assert.equal(newerVersion('0.5.0-rc.1', '0.5.0'), null);
  assert.equal(newerVersion('0.4.0', 'garbage'), null);
  assert.equal(newerVersion(undefined, '1.0.0'), null);
});

test('the cache is refreshed on a day, and read back as it was written', () => {
  const dir = home('0.5.0');
  try {
    assert.deepEqual(readCache(dir).latest, '0.5.0');
    assert.equal(stale(readCache(dir)), false);
    assert.equal(stale(readCache(home('0.5.0', CACHE_TTL_MS + 1000))), true);
    assert.equal(stale(null), true, 'nothing cached is stale by definition');
  } finally { rmTemp(dir); }
});

test('a corrupt cache is silence, not a crash', () => {
  // It is a file in a config home a user can edit, and nothing here is worth
  // failing a command over.
  const dir = home(null);
  try {
    for (const junk of ['', 'not json', '{}', '{"latest":5,"checkedAt":1}', '{"latest":"0.5.0"}']) {
      writeFileSync(join(dir, 'update-check.json'), junk);
      assert.equal(readCache(dir), null, junk);
      assert.equal(updateNotice('0.4.0', { home: dir, ...tty }), null, junk);
    }
  } finally { rmTemp(dir); }
});

test('the refresh writes what the registry said, and nothing when it cannot ask', async () => {
  const dir = home(null);
  try {
    assert.equal(await refreshMain({ home: dir, fetchImpl: async () => ({ ok: true, json: async () => ({ version: '1.2.3' }) }) }), true);
    assert.equal(readCache(dir).latest, '1.2.3');

    // Offline, refused, or answering nonsense: the cache is left exactly as it
    // was, and nothing is thrown at a caller who is not waiting anyway.
    for (const bad of [
      async () => { throw new Error('ENOTFOUND'); },
      async () => ({ ok: false, status: 503 }),
      async () => ({ ok: true, json: async () => ({ version: 'latest' }) }),
      async () => ({ ok: true, json: async () => { throw new Error('not json'); } }),
    ]) {
      assert.equal(await refreshMain({ home: dir, fetchImpl: bad }), false);
      assert.equal(readCache(dir).latest, '1.2.3', 'the last good answer survives');
    }
  } finally { rmTemp(dir); }
});
