// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `present`'s upstream check — SPEC PRESENTING (PRESENT#UPSTREAM).
//
// This file is mostly about what the feature REFUSES, because that is where its
// safety lives. `present` gained its first route that acts, and the argument
// that this is still not an editing server rests on three things a test can
// hold: the feature is unreachable for a deck that is not in a clone, the pull
// takes no parameter of any kind, and a fetch that failed is never reported as
// up to date.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers.mjs';
import {
  canPull, classifyFailure, describe as describeState, resolveInterval, resolveUpstream,
  SAFE_CONFIG, upstreamSuppressed,
} from '../cli/upstream.mjs';

const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@e.com'];

// ── the gates, which are the feature's safety ─────────────────────────────

test('a deck that is not in a repository is not a question', async () => {
  // The emailed deck, and the whole safety argument: nothing is registered, so
  // a POST lands on the same 405 as a POST to anything else.
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-up-'));
  try {
    writeFileSync(path.join(dir, 'deck.html'), '<html></html>');
    assert.equal((await resolveUpstream(path.join(dir, 'deck.html'))).state, 'no-repo');
  } finally { rmTemp(dir); }
});

test('a deck inside a repo that does not TRACK it is refused', async () => {
  // The gate that is not obvious, and the one that matters most: anyone whose
  // $HOME is a git repository — yadm, chezmoi, a dotfiles clone — has every
  // deck in ~/Downloads "inside a clone". Without this, presenting a downloaded
  // deck would offer to fast-forward their home directory.
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-up2-'));
  try {
    sh(['init', '-q', dir], dir);
    writeFileSync(path.join(dir, 'tracked.txt'), 'x');
    sh(['add', '-A'], dir); sh([...ID, 'commit', '-qm', 'one'], dir);
    writeFileSync(path.join(dir, 'downloaded.html'), '<html></html>');
    assert.equal((await resolveUpstream(path.join(dir, 'downloaded.html'))).state, 'untracked');
  } finally { rmTemp(dir); }
});

test('a tracked deck with no upstream gets that far and stops', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-up3-'));
  try {
    sh(['init', '-q', dir], dir);
    writeFileSync(path.join(dir, 'deck.html'), '<html></html>');
    sh(['add', '-A'], dir); sh([...ID, 'commit', '-qm', 'one'], dir);
    const r = await resolveUpstream(path.join(dir, 'deck.html'));
    assert.equal(r.state, 'no-upstream');
    assert.ok(r.branch, 'the branch is known even though it tracks nothing');
  } finally { rmTemp(dir); }
});

// ── never a false pass ────────────────────────────────────────────────────

test('a failed fetch is never "up to date"', () => {
  // The rule signature verification already follows: when it cannot be done
  // here, that is its own state and never a pass. A comparison against a STALE
  // remote-tracking ref would look like an answer and be a lie.
  for (const [why, expected] of [
    [{ stderr: 'fatal: unable to access: Could not resolve host: github.com' }, 'offline'],
    [{ stderr: 'fatal: Authentication failed for https://x' }, 'no-credential'],
    [{ stderr: 'remote: Permission denied (publickey).' }, 'no-credential'],
    [{ err: { killed: true }, stderr: '' }, 'timeout'],
    [{ stderr: 'something nobody has seen' }, 'error'],
  ]) assert.equal(classifyFailure(why), expected, JSON.stringify(why));
  // and none of those words is ever `up-to-date`
  assert.ok(!['offline', 'no-credential', 'timeout', 'error'].includes('up-to-date'));
});

// ── what may be pulled ────────────────────────────────────────────────────

test('the pull refuses everything but a clean fast-forward', () => {
  const offered = { offered: true };
  assert.equal(canPull({ state: 'behind', dirty: false }, offered).ok, true);
  // A checkout over uncommitted work is how somebody loses an edit made in the
  // ten minutes before a talk.
  assert.equal(canPull({ state: 'behind', dirty: true }, offered).state, 'dirty');
  assert.equal(canPull({ state: 'diverged' }, offered).state, 'diverged');
  assert.equal(canPull({ state: 'ahead' }, offered).state, 'ahead');
  assert.equal(canPull({ state: 'up-to-date' }, offered).state, 'up-to-date');
  assert.equal(canPull({ state: 'offline' }, offered).state, 'offline');
  assert.equal(canPull(null, offered).ok, false);
  // Without the flag there is nothing to ask.
  assert.equal(canPull({ state: 'behind' }, { offered: false }).state, 'not-offered');
});

// ── the flags ─────────────────────────────────────────────────────────────

test('every reason not to check, by name', () => {
  assert.equal(upstreamSuppressed({ args: ['--no-upstream'], env: {} }), '--no-upstream');
  assert.equal(upstreamSuppressed({ args: ['--check'], env: {} }), '--check');
  assert.equal(upstreamSuppressed({ args: [], env: { CI: '1' } }), 'CI');
  assert.equal(upstreamSuppressed({ args: [], env: { DECKLIGHT_NO_UPSTREAM_CHECK: '1' } }),
    'DECKLIGHT_NO_UPSTREAM_CHECK is set');
  assert.equal(upstreamSuppressed({ args: [], env: {} }), false);
});

test('--upstream-every 0 stops the TIMER, not the feature', () => {
  // Somebody who does not want background network during a talk still wants the
  // manual check. --no-upstream is how you turn it all off, and the two being
  // different is the point.
  assert.equal(resolveInterval(['--upstream-every', '0']), 0);
  assert.equal(upstreamSuppressed({ args: ['--upstream-every', '0'], env: {} }), false,
    'the routes stay');
  assert.equal(resolveInterval([]), 600_000, 'ten minutes by default');
  assert.equal(resolveInterval(['--upstream-every', '3']), 180_000);
  // A floor, so a script cannot ask for a fetch every second.
  assert.equal(resolveInterval(['--upstream-every', '0.1']), 60_000);
  // A typo must not silently cost you the thing you were configuring.
  assert.equal(resolveInterval(['--upstream-every', 'soon']), 600_000);
});

// ── what git is actually told ─────────────────────────────────────────────

test('hooks, maintenance and submodules are off on every invocation', () => {
  // decklight is not the presenter typing `git pull`: it must not run arbitrary
  // local scripts in the middle of a talk, and a background gc must not start
  // behind a slide.
  const flat = SAFE_CONFIG.join(' ');
  assert.match(flat, /gc\.auto=0/);
  assert.match(flat, /maintenance\.auto=false/);
  assert.match(flat, /core\.fsmonitor=false/);
  assert.match(flat, /submodule\.recurse=false/);
});

test('the states read as sentences a presenter can act on', () => {
  assert.equal(describeState('behind', { behind: 3, upstream: 'origin/main' }),
    '3 commits behind origin/main');
  assert.equal(describeState('behind', { behind: 1, upstream: 'origin/main' }),
    '1 commit behind origin/main', 'singular');
  assert.match(describeState('diverged', { behind: 1, ahead: 2, upstream: 'origin/main' }),
    /a fast-forward is not possible/);
  assert.match(describeState('ahead', { ahead: 2, upstream: 'origin/main' }), /nothing to pull/);
  assert.match(describeState('behind', { behind: 1, upstream: 'o/m', dirty: true }),
    /uncommitted changes here/);
});
