// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight dev`: which services come up, which are skipped, and why.
// planServices() is pure — no ports are bound here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planServices, inGitRepo } from '../cli/dev.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

const NO_BINS = () => false;
const ALL_BINS = () => true;
const plan = (args, { env = {}, hasBin = NO_BINS } = {}) => planServices({ args, env, hasBin });

const names = (p) => p.run.map((s) => s.name);
const svc = (p, name) => p.run.find((s) => s.name === name);
const why = (p, name) => p.skip.find((s) => s.name === name)?.why ?? '';

test('the deck is found past flags that take a value', () => {
  assert.equal(plan(['--port', '9000', 'deck.html']).deck, 'deck.html');
  assert.equal(plan(['deck.html', '--port', '9000']).deck, 'deck.html');
  // "8788" is --port's value, not the deck
  assert.notEqual(plan(['--port', '8788']).deck, '8788');
  assert.equal(plan(['--no-tts', 'deck.html']).deck, 'deck.html');
});

test('the edit server always runs — it needs no credentials and no cost', () => {
  const p = plan(['deck.html']);
  assert.ok(names(p).includes('edit'));
  assert.deepEqual(svc(p, 'edit').args, ['edit', 'deck.html', '--port', '8788']);
  assert.equal(svc(p, 'edit').url, 'http://127.0.0.1:8788/deck.html');
});

test('a bare machine still gets the deck — bridges are skipped, not fatal', () => {
  const p = plan(['deck.html']);
  assert.deepEqual(names(p), ['edit'], 'no bridges, but edit still comes up');
  assert.match(why(p, 'voice'), /GOOGLE_CLOUD_PROJECT|--project/);
  assert.match(why(p, 'lip-sync'), /rhubarb/);
});

test('voice comes up when a project is available (flag or env)', () => {
  const viaFlag = plan(['deck.html', '--project', 'proj-1']);
  assert.ok(names(viaFlag).includes('tts'));
  assert.deepEqual(svc(viaFlag, 'tts').args, ['tts', '--port', '8787', '--project', 'proj-1']);

  const viaEnv = plan(['deck.html'], { env: { GOOGLE_CLOUD_PROJECT: 'proj-2' } });
  assert.deepEqual(svc(viaEnv, 'tts').args, ['tts', '--port', '8787', '--project', 'proj-2']);
});

test('lip-sync comes up when rhubarb is on PATH, or when explicitly configured', () => {
  const onPath = plan(['deck.html'], { hasBin: ALL_BINS });
  assert.ok(names(onPath).includes('lipsync'));

  // no rhubarb on PATH, but the user pointed at a portrait — trust them
  const configured = plan(['deck.html', '--portrait', 'me=face.png']);
  assert.ok(names(configured).includes('lipsync'));
  assert.deepEqual(svc(configured, 'lipsync').args,
    ['lipsync', '--port', '8789', '--portrait', 'me=face.png']);
});

test('--no-tts / --no-lipsync opt out, and say so', () => {
  const p = plan(['deck.html', '--no-tts', '--no-lipsync'], { env: { GOOGLE_CLOUD_PROJECT: 'p' }, hasBin: ALL_BINS });
  assert.deepEqual(names(p), ['edit']);
  assert.match(why(p, 'voice'), /--no-tts/);
  assert.match(why(p, 'lip-sync'), /--no-lipsync/);
});

test('ports and bridge flags pass through to the right child', () => {
  const p = plan(
    ['deck.html', '--port', '9000', '--tts-port', '9001', '--lipsync-port', '9002',
      '--project', 'p', '--tts-model', 'm', '--wav2lip-dir', '/w'],
    { hasBin: ALL_BINS },
  );
  assert.equal(svc(p, 'edit').args.at(-1), '9000');
  assert.deepEqual(svc(p, 'tts').args, ['tts', '--port', '9001', '--project', 'p', '--tts-model', 'm']);
  assert.deepEqual(svc(p, 'lipsync').args, ['lipsync', '--port', '9002', '--wav2lip-dir', '/w']);
});

test('git and agent flags ride along to the edit child', () => {
  const p = plan(['deck.html', '--git', '--commit-every', '60', '--agent', 'codex']);
  assert.deepEqual(svc(p, 'edit').args,
    ['edit', 'deck.html', '--port', '8788', '--git', '--commit-every', '60', '--agent', 'codex']);
  assert.ok(svc(plan(['deck.html', '--no-git']), 'edit').args.includes('--no-git'));
  // the deck is still found past the new value flags
  assert.equal(plan(['--agent', 'claude', 'deck.html']).deck, 'deck.html');
  assert.equal(plan(['--commit-every', '60', 'deck.html']).deck, 'deck.html');
});

test('the agent roster is part of the plan — the big three included', () => {
  const all = plan(['deck.html'], { hasBin: ALL_BINS });
  for (const name of ['claude', 'codex', 'bob']) {
    assert.ok(all.agents.includes(name), `${name} missing`);
  }
  assert.deepEqual(plan(['deck.html']).agents, [], 'a bare machine has none');
});

test('inGitRepo trusts git\'s answer and treats failure as "no repo"', () => {
  assert.equal(inGitRepo('/anywhere', () => 'true\n'), true);
  assert.equal(inGitRepo('/anywhere', () => 'false\n'), false);
  assert.equal(inGitRepo('/anywhere', () => { throw new Error('not a repo'); }), false);
});

test('dev is routed and documented by the dispatcher', () => {
  const help = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help, /^  dev {5}/m, 'dev is listed in the global help');

  const devHelp = execFileSync('node', [CLI, 'dev', '--help'], { encoding: 'utf8' });
  assert.match(devHelp, /usage: decklight dev/);
});

test('dev without a deck, or with a missing one, fails with usage — not a stack trace', () => {
  const bare = spawnSync('node', [CLI, 'dev'], { encoding: 'utf8' });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /needs a deck/);
  assert.doesNotMatch(bare.stderr, /at .*\.mjs:\d+/, 'no stack trace');

  const missing = spawnSync('node', [CLI, 'dev', 'nope.html'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such deck/);
});
