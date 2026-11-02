// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `publish --audio` carries the narration inside the published page, the way
// `bundle --audio` does. Without it the clips stayed beside the deck, and a
// published talk (a folder, Pages, Netlify) played no voice at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'decklight.mjs');

function deck(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-pubaudio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'voices'));
  writeFileSync(path.join(dir, 'voices', 'slide-01.m4a'), 'one');
  writeFileSync(path.join(dir, 'talk.html'), '<!doctype html><html><head><title>T</title></head><body><div class="decklight"><section><h2>One</h2></section></div>'
    + `<script type="application/json" data-decklight-config>${JSON.stringify({ narration: { files: 'voices' } })}</script></body></html>`);
  return dir;
}
const publish = (dir, ...args) => spawnSync(process.execPath, [CLI, 'publish', 'talk.html', '--target', 'folder', '--out', path.join(dir, 'site'), '--no-sign', ...args],
  { cwd: dir, encoding: 'utf8', env: { ...process.env, DECKLIGHT_PUBLISH_URL: '' } });
const audioKeys = (html) => [...html.matchAll(/data-decklight-audio="([^"]+)"/g)].map((m) => m[1]);

test('publish --audio puts the narration inside the published page', (t) => {
  const dir = deck(t);
  const r = publish(dir, '--audio');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(audioKeys(readFileSync(path.join(dir, 'site', 'index.html'), 'utf8')), ['voices/slide-01.m4a']);
});

test('without --audio the clips stay beside the deck, as before', (t) => {
  const dir = deck(t);
  const r = publish(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(audioKeys(readFileSync(path.join(dir, 'site', 'index.html'), 'utf8')), []);
  assert.match(r.stdout + r.stderr, /stay beside the deck/);
});

test('--audio with --no-bundle is refused, since there is no bundle to carry it', (t) => {
  const dir = deck(t);
  const r = publish(dir, '--audio', 'aac', '--no-bundle');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--audio carries the narration inside the bundle, and --no-bundle/);
});
