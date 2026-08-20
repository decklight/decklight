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
  canPull, checkUpstream, classifyFailure, describe as describeState, resolveInterval, resolveUpstream,
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

// ── checkUpstream — the half that talks to a real remote ──────────────────
//
// Everything above tests the DECISIONS (resolve, classify, describe, canPull).
// This is the runner that fetches and counts, and it went untested from #342
// until this review — which mattered, because it is the function whose answer
// decides whether present offers to move somebody's working tree. `run` is
// injected, so every network condition is a scripted answer.

const ctx = { repoRoot: '/r', branch: 'main', upstream: 'origin/main' };
const script = (answers) => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const key = args.includes('fetch') ? 'fetch'
      : args.includes('rev-list') ? 'revlist'
      : args.includes('status') ? 'status'
      : args.includes('log') ? 'log' : 'other';
    return answers[key] ?? { ok: true, stdout: '' };
  };
  return { run, calls };
};

test('a clean fetch and equal counts is up-to-date, with a timestamp', async () => {
  const { run } = script({
    fetch: { ok: true, stdout: '' },
    revlist: { ok: true, stdout: '0\t0' },
    status: { ok: true, stdout: '' },
    log: { ok: true, stdout: '' },
  });
  const s = await checkUpstream(ctx, { run, now: () => 1234 });
  assert.equal(s.state, 'up-to-date');
  assert.equal(s.checkedAt, 1234);
});

test('behind counts LEFT, which is the classic inversion to get wrong', async () => {
  // `rev-list --left-right --count @{upstream}...HEAD`: the LEFT number is
  // commits only upstream has — behind. Swap them and the deck offers to pull
  // work it already has while missing the work it lacks.
  const { run } = script({
    fetch: { ok: true, stdout: '' },
    revlist: { ok: true, stdout: '3\t0' },
    status: { ok: true, stdout: '' },
    log: { ok: true, stdout: 'abc1234\x01sharpen the title' },
  });
  const s = await checkUpstream(ctx, { run });
  assert.equal(s.state, 'behind');
  assert.equal(s.behind, 3);
  assert.equal(s.ahead, 0);
  assert.deepEqual(s.commits[0], { hash: 'abc1234', subject: 'sharpen the title' });
});

test('a failed fetch is NEVER reported as up to date', async () => {
  // The property the whole function is shaped around: comparing against a
  // stale ref would turn "I could not ask" into "nothing new", which is the
  // one wrong answer a presenter acts on.
  const { run, calls } = script({ fetch: { ok: false, stderr: 'Could not resolve host: github.com' } });
  const s = await checkUpstream(ctx, { run });
  assert.equal(s.state, 'offline');
  assert.match(s.message, /NOT up to date/);
  assert.equal(s.checkedAt, null, 'a non-answer carried a timestamp');
  assert.equal(calls.length, 1, 'counted against a ref the fetch never refreshed');
});

test('the fetch runs under the safe config and never recurses', async () => {
  // decklight is not the presenter typing `git fetch`: hooks, gc, submodule
  // recursion and credential prompts are all pinned off for the talk's sake.
  const { run, calls } = script({ fetch: { ok: false, stderr: 'x' } });
  await checkUpstream(ctx, { run });
  const fetch = calls[0];
  for (const flag of SAFE_CONFIG) assert.ok(fetch.includes(flag), `fetch missing ${flag}`);
  assert.ok(fetch.includes('--no-recurse-submodules'));
  assert.ok(fetch.includes('--no-tags'));
});

test('a dirty tree is reported, because a pull would collide with it', async () => {
  const { run } = script({
    fetch: { ok: true, stdout: '' },
    revlist: { ok: true, stdout: '1\t0' },
    status: { ok: true, stdout: ' M deck.html' },
    log: { ok: true, stdout: '' },
  });
  assert.equal((await checkUpstream(ctx, { run })).dirty, true);
});

test('garbage counts are an error, not a zero', async () => {
  const { run } = script({
    fetch: { ok: true, stdout: '' },
    revlist: { ok: true, stdout: 'fatal: bad revision' },
  });
  const s = await checkUpstream(ctx, { run });
  assert.equal(s.state, 'error');
});
