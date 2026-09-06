// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The folder publish target: the same files every other target uploads,
// written into a directory for whatever serves it. No credential, because the
// folder is the credential — so the one thing to get right is never writing
// OUTSIDE it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TARGETS, schemaFor, envVarsFor, envAnswers, deploy, deployFolder } from '../tools/publish-targets.mjs';

const scratch = (t) => { const d = mkdtempSync(join(tmpdir(), 'decklight-pubfolder-')); t.after(() => rmSync(d, { recursive: true, force: true })); return d; };
const SITE = [
  { path: 'index.html', data: '<!doctype html><title>deck</title>' },
  { path: 'index.html.sig', data: '{"sig":1}\n' },
  { path: 'index.decklight', data: Buffer.from([0x50, 0x4b]) },
];

test('folder is a target like the others — a schema, env names, and a deployer', () => {
  assert.ok(TARGETS.includes('folder'));
  const schema = schemaFor('folder');
  assert.deepEqual(schema.fields.map((f) => f.name), ['dir', 'url']);
  assert.equal(schema.fields[0].required, true, 'the directory is the one thing it cannot guess');
  assert.deepEqual(envVarsFor('folder'), { dir: 'DECKLIGHT_PUBLISH_DIR', url: 'DECKLIGHT_PUBLISH_URL' });
  // an unset optional answer is absent, not undefined — checkAnswers reads it that way
  assert.deepEqual(envAnswers('folder', { DECKLIGHT_PUBLISH_DIR: '/tmp/x' }), { dir: '/tmp/x' });
});

test('the site lands in the directory, every file, subdirectory included', async (t) => {
  const dir = scratch(t);
  const r = await deploy('folder', { dir, url: 'https://decks.example.com/' }, SITE);
  assert.equal(readFileSync(join(dir, 'index.html'), 'utf8'), SITE[0].data);
  assert.equal(readFileSync(join(dir, 'index.html.sig'), 'utf8'), SITE[1].data);
  assert.deepEqual([...readFileSync(join(dir, 'index.decklight'))], [0x50, 0x4b]);
  assert.equal(r.url, 'https://decks.example.com/', 'the trailing slash is normalised, not doubled');
  assert.equal(r.id, dir);
});

test('--path\'s subdirectory is written and printed as part of the link', async (t) => {
  const dir = scratch(t);
  const under = SITE.map((f) => ({ ...f, path: `talks/q3/${f.path}` }));
  const r = await deployFolder({ dir, url: 'https://decks.example.com' }, under);
  assert.ok(existsSync(join(dir, 'talks', 'q3', 'index.html')));
  assert.equal(r.url, 'https://decks.example.com/talks/q3/');
});

test('no url means no link, not a made-up one', async (t) => {
  const dir = scratch(t);
  const r = await deployFolder({ dir }, SITE);
  assert.equal(r.url, null);
});

test('a path that climbs out of the folder is refused before anything is written', async (t) => {
  const dir = scratch(t);
  await assert.rejects(
    deployFolder({ dir }, [{ path: '../escape.html', data: 'x' }]),
    /refusing to write outside/,
  );
  assert.equal(existsSync(join(dir, '..', 'escape.html')), false);
});
