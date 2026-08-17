// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The remote half of cli/git.mjs — SPEC PRESENTING's durable record, looking
// past the machine it is on.
//
// Two properties carry this file, and both are the kind that look fine until
// the day they are not:
//
//   IT NEVER HANGS. A remote that is unreachable, private, or simply slow has
//   to be an ANSWER. The failure classifier is what turns each of those into a
//   word, and the integration test at the bottom asserts a wall-clock bound on
//   an unreachable remote — the "never hangs" property is only real if
//   something measures it.
//
//   IT NEVER NAGS. `pushHint` returning null when there is nothing to push is
//   stated once, here, so that four call sites cannot each get it wrong.
//
// Everything except the last section runs with an injected `run`, so the whole
// state machine is exercised with no repository, no network, and no git.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers.mjs';
import {
  aheadBehind, classifyRemoteError, exitPushLine, gitAvailable, headState, looksLikeGitUrl,
  foreignWarning, noPromptEnv, parseAheadBehind, preferredRemote, pushHint, remoteLine,
  remoteState, splitDeckPaths, unpushed,
} from '../cli/git.mjs';

// ── the counts, and the trap in them ──────────────────────────────────────

test('the LEFT count is behind — the classic bug in this command', () => {
  // `git rev-list --left-right --count @{u}...HEAD` prints "<behind>\t<ahead>":
  // the left side is what is reachable from the upstream and not from HEAD.
  // Reading it the other way round type-checks, looks right, and reports your
  // own unpushed work as the other side's.
  assert.deepEqual(parseAheadBehind('2\t5'), { behind: 2, ahead: 5 });
  assert.deepEqual(parseAheadBehind('0\t0'), { behind: 0, ahead: 0 });
  assert.deepEqual(parseAheadBehind('3 0'), { behind: 3, ahead: 0 }, 'spaces count too');
  assert.deepEqual(parseAheadBehind('  1\t2\n'), { behind: 1, ahead: 2 });
});

test('anything that is not two counts is not an answer', () => {
  // A malformed answer must not become `{ahead: NaN}` and travel.
  for (const bad of ['', '1', '1\t2\t3', 'abc\tdef', '-1\t2', '1.5\t2', null, undefined]) {
    assert.equal(parseAheadBehind(bad), null, JSON.stringify(bad));
  }
});

// ── which remote, when a command has to name one ──────────────────────────

test('origin wins, a lone remote wins, and several with no origin is a refusal', () => {
  // Guessing among several would put someone's work on the wrong host.
  assert.deepEqual(preferredRemote([]), { name: null, state: 'none' });
  assert.deepEqual(preferredRemote(['origin']), { name: 'origin', state: 'ok' });
  assert.deepEqual(preferredRemote(['upstream', 'origin']), { name: 'origin', state: 'ok' });
  assert.deepEqual(preferredRemote(['fork']), { name: 'fork', state: 'ok' });
  assert.deepEqual(preferredRemote(['fork', 'upstream']), { name: null, state: 'ambiguous' });
});

// ── why it failed, in one word ────────────────────────────────────────────

test('a missing credential and a missing network are different answers', () => {
  // Telling someone to check their network when the answer is a missing key
  // wastes the ten minutes before a talk.
  const denied = [
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    "fatal: Authentication failed for 'https://github.com/x/y.git/'",
    'git@github.com: Permission denied (publickey).',
    'remote: HTTP Basic: Access denied',
  ];
  for (const e of denied) assert.equal(classifyRemoteError({ stderr: e }), 'denied', e);

  const offline = [
    "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
    'ssh: Could not resolve hostname github.com: nodename nor servname provided',
    'fatal: unable to connect to github.com: Connection refused',
    'fatal: unable to access: Network is unreachable',
  ];
  for (const e of offline) assert.equal(classifyRemoteError({ stderr: e }), 'offline', e);

  assert.equal(classifyRemoteError({ stderr: 'remote: Repository not found.' }), 'gone');
  assert.equal(classifyRemoteError({ stderr: 'something nobody has seen' }), 'unknown');
});

test('a killed child is offline, not unknown', () => {
  // A remote that did not answer inside the bound is indistinguishable from one
  // that is not there, and both are answers rather than hangs.
  assert.equal(classifyRemoteError({ signal: 'SIGTERM', stderr: '' }), 'offline');
  assert.equal(classifyRemoteError({ message: 'spawnSync git ETIMEDOUT' }), 'offline');
});

// ── never a hang ──────────────────────────────────────────────────────────

test('the no-prompt env covers ssh, not just https', () => {
  // GIT_TERMINAL_PROMPT=0 stops git's own prompts and the https askpass. An
  // ssh:// remote still sits forever on a host-key or passphrase question
  // nobody is there to type — BatchMode is the other half, and leaving it out
  // is how the "never hangs" contract quietly becomes "usually".
  const env = noPromptEnv({ PATH: '/usr/bin', GIT_ASKPASS: '/usr/bin/gui-ask', SSH_ASKPASS: '/x' });
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.match(env.GIT_SSH_COMMAND, /BatchMode=yes/);
  assert.match(env.GIT_SSH_COMMAND, /ConnectTimeout=/);
  assert.ok(!('GIT_ASKPASS' in env), 'a GUI credential window must not open behind a headless probe');
  assert.ok(!('SSH_ASKPASS' in env), 'likewise');
  assert.equal(env.PATH, '/usr/bin', 'the rest of the environment is untouched');
});

test("a caller's own GIT_SSH_COMMAND is respected", () => {
  // Somebody with a deploy key in an ssh command already solved this;
  // overwriting it would break the case the flag exists for.
  assert.equal(noPromptEnv({ GIT_SSH_COMMAND: 'ssh -i /k/deploy' }).GIT_SSH_COMMAND, 'ssh -i /k/deploy');
});

// ── a URL is not an argument ──────────────────────────────────────────────

test('a leading dash is refused — `git remote add` has no -- to hide behind', () => {
  // `git remote add origin --upload-pack=...` is an argument, not a URL.
  assert.equal(looksLikeGitUrl('--upload-pack=/bin/sh'), false);
  assert.equal(looksLikeGitUrl('-u'), false);
  for (const url of [
    'https://github.com/a/b.git', 'ssh://git@github.com/a/b', 'git://host/a',
    'file:///tmp/bare.git', 'git@github.com:a/b.git', '/srv/git/a.git',
  ]) assert.equal(looksLikeGitUrl(url), true, url);
  for (const junk of ['', '   ', 'notaurl', null, undefined]) {
    assert.equal(looksLikeGitUrl(junk), false, JSON.stringify(junk));
  }
});

// ── the state machine, with no repository at all ──────────────────────────

/** A fake `git` keyed on the command, so the whole table runs without one. */
const fakeRun = (table) => (args) => {
  const key = args.join(' ');
  const hit = Object.entries(table).find(([k]) => key.startsWith(k));
  if (!hit) throw new Error(`unexpected: git ${key}`);
  if (hit[1] instanceof Error) throw hit[1];
  return hit[1];
};
const alwaysOk = { '--version': 'git version 2.0', 'rev-parse --is-inside-work-tree': 'true' };
const state = (table) => remoteState('/x', {
  run: fakeRun({ ...alwaysOk, ...table }),
  exec: () => 'true',
});

test('every state the resolution can reach, in order', () => {
  const unborn = state({ 'rev-parse --verify': new Error('bad') });
  assert.equal(unborn.state, 'unborn');

  const detached = state({
    'rev-parse --verify': 'abc', 'symbolic-ref': '',
    'rev-list HEAD --not --remotes': 'a\nb',
  });
  assert.deepEqual([detached.state, detached.unpushed], ['detached', 2]);

  const noRemote = state({
    'rev-parse --verify': 'abc', 'symbolic-ref': 'main',
    'rev-list HEAD --not --remotes': 'a\nb\nc', remote: '',
  });
  assert.deepEqual([noRemote.state, noRemote.branch, noRemote.unpushed], ['no-remote', 'main', 3]);

  const ambiguous = state({
    'rev-parse --verify': 'abc', 'symbolic-ref': 'main',
    'rev-list HEAD --not --remotes': '', remote: 'fork\nupstream',
  });
  assert.equal(ambiguous.state, 'ambiguous-remote');

  const noUpstream = state({
    'rev-parse --verify': 'abc', 'symbolic-ref': 'main',
    'rev-list HEAD --not --remotes': 'a', remote: 'origin',
    'remote get-url': 'https://x/y.git',
    'rev-parse --abbrev-ref': new Error('no upstream configured'),
  });
  assert.deepEqual([noUpstream.state, noUpstream.remote, noUpstream.unpushed], ['no-upstream', 'origin', 1]);

  const ok = state({
    'rev-parse --verify': 'abc', 'symbolic-ref': 'main',
    'rev-list HEAD --not --remotes': 'a\nb', remote: 'origin',
    'remote get-url': 'https://x/y.git',
    'rev-parse --abbrev-ref': 'origin/main',
    'rev-list --left-right': '1\t2',
  });
  assert.deepEqual(
    [ok.state, ok.ahead, ok.behind, ok.unpushed, ok.upstream],
    ['ok', 2, 1, 2, 'origin/main'],
  );
});

test('no git at all is its own state, not "not a repository"', () => {
  // inGitRepo swallows ENOENT, so without this a machine with no git installed
  // is told it is not in a repository — true, but not the useful answer.
  const s = remoteState('/x', { run: () => 'true', exec: () => { throw new Error('ENOENT'); } });
  assert.equal(s.state, 'no-git');
});

// ── the words, so four call sites cannot disagree ─────────────────────────

test('nothing to push says NOTHING — the do-not-nag guarantee', () => {
  // Stated once, here, rather than at each of the four reminder sites.
  assert.equal(pushHint({ state: 'ok', ahead: 0, behind: 0, unpushed: 0 }), null);
  assert.equal(pushHint({ state: 'no-repo' }), null);
  assert.equal(pushHint({ state: 'unborn' }), null);
  assert.equal(pushHint(null), null);
  // No remote is silent too: telling someone to push when there is nowhere to
  // push is noise, and that nudge belongs to `init`, once.
  assert.equal(pushHint({ state: 'no-remote', unpushed: 9 }), null);
});

test('something to push names the number and the command that would work', () => {
  const ok = pushHint({ state: 'ok', ahead: 3, unpushed: 3, remote: 'origin', branch: 'main' });
  assert.deepEqual([ok.kind, ok.n], ['unpushed', 3]);
  assert.equal(ok.text, '↑3 unpushed — git push');

  // A branch that tracks nothing needs -u, and saying plain `git push` there
  // would send someone to an error message.
  const fresh = pushHint({ state: 'no-upstream', unpushed: 12, remote: 'origin', branch: 'talk' });
  assert.deepEqual([fresh.kind, fresh.n], ['no-upstream', 12]);
  assert.equal(fresh.text, '↑12 unpushed — git push -u origin talk');
});

test('the exit line speaks up about no remote, where the toast stays quiet', () => {
  // The end of a session is the moment "this only exists here" is worth
  // knowing — said once, rather than every few minutes while you work.
  assert.match(exitPushLine({ state: 'no-remote', unpushed: 4 }), /only on this machine — back it up/);
  assert.equal(exitPushLine({ state: 'no-remote', unpushed: 0 }), null);
  assert.equal(exitPushLine({ state: 'ok', ahead: 1, unpushed: 1, remote: 'origin', branch: 'main' }),
    '  ↑1 commit only on this machine — git push');
  assert.match(exitPushLine({ state: 'ok', ahead: 6, unpushed: 6, remote: 'origin', branch: 'main' }),
    /↑6 commits only/, 'plural');
  assert.equal(exitPushLine({ state: 'ok', ahead: 0, unpushed: 0 }), null, 'a clean exit stays clean');
});

test('the readout says where you stand, in every state', () => {
  assert.equal(remoteLine({ state: 'ok', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0 }),
    'main → origin/main · all pushed');
  assert.equal(remoteLine({ state: 'ok', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 0 }),
    'main → origin/main · ↑2 unpushed');
  assert.equal(remoteLine({ state: 'ok', branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1 }),
    'main → origin/main · ↑2 unpushed · ↓1 behind');
  assert.match(remoteLine({ state: 'no-remote', branch: 'main', unpushed: 3 }), /only on this machine/);
  assert.match(remoteLine({ state: 'no-upstream', branch: 'talk', remote: 'origin', unpushed: 12 }), /↑12 never pushed/);
  assert.equal(remoteLine({ state: 'unborn' }), 'nothing committed yet');
  assert.equal(remoteLine({ state: 'no-git' }), 'git is not installed');
});

// ── against a real repository, with no network ────────────────────────────

const HAVE_GIT = gitAvailable();
const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('a real repo, a file:// remote, and the counts moving', { skip: !HAVE_GIT && 'git is not installed' }, () => {
  // A bare repo over file:// is a real remote that needs no network, which is
  // what makes this whole layer testable in CI and offline.
  const root = mkdtempSync(path.join(tmpdir(), 'decklight-remote-'));
  try {
    const bare = path.join(root, 'bare.git');
    const work = path.join(root, 'work');
    sh(['init', '--bare', '-q', bare], root);
    sh(['init', '-q', work], root);
    const id = ['-c', 'user.name=t', '-c', 'user.email=t@e.com'];
    writeFileSync(path.join(work, 'deck.html'), '<h1>one</h1>');
    sh(['add', '-A'], work); sh([...id, 'commit', '-qm', 'one'], work);

    // No remote yet: every commit is unpushed, and that is the honest count.
    let s = remoteState(work);
    assert.equal(s.state, 'no-remote');
    assert.equal(s.unpushed, 1, 'with no remote, nothing exists anywhere else');

    sh(['remote', 'add', 'origin', `file://${bare}`], work);
    s = remoteState(work);
    assert.equal(s.state, 'no-upstream', 'a remote is not an upstream');
    assert.equal(s.unpushed, 1, 'and unpushed still answers, where @{u} would fail');

    sh(['push', '-q', '-u', 'origin', 'HEAD'], work);
    s = remoteState(work);
    assert.deepEqual([s.state, s.ahead, s.behind, s.unpushed], ['ok', 0, 0, 0]);
    assert.equal(remoteLine(s).includes('all pushed'), true);

    writeFileSync(path.join(work, 'deck.html'), '<h1>two</h1>');
    sh(['add', '-A'], work); sh([...id, 'commit', '-qm', 'two'], work);
    s = remoteState(work);
    assert.deepEqual([s.state, s.ahead, s.unpushed], ['ok', 1, 1]);
    assert.equal(unpushed(work).length, 1, 'and it is per-commit, so rows can be marked');
    assert.deepEqual(aheadBehind(work), { ahead: 1, behind: 0 });
    assert.equal(headState(work).branch, sh(['symbolic-ref', '--short', 'HEAD'], work).trim());
  } finally { rmTemp(root); }
});

test('an unreachable remote answers, and answers QUICKLY', { skip: !HAVE_GIT && 'git is not installed' }, () => {
  // The "never hangs" contract is only real if something measures it. A remote
  // that does not exist must come back as a state, not sit there while a talk
  // is starting.
  const root = mkdtempSync(path.join(tmpdir(), 'decklight-remote-dead-'));
  try {
    sh(['init', '-q', root], root);
    const id = ['-c', 'user.name=t', '-c', 'user.email=t@e.com'];
    writeFileSync(path.join(root, 'a.txt'), 'x');
    sh(['add', '-A'], root); sh([...id, 'commit', '-qm', 'one'], root);
    sh(['remote', 'add', 'origin', 'file:///definitely/not/here.git'], root);

    const at = Date.now();
    const s = remoteState(root);
    const took = Date.now() - at;
    assert.equal(s.state, 'no-upstream', 'an unreachable remote is still a remote');
    assert.ok(took < 10_000, `remoteState took ${took}ms — it must never be the thing that hangs`);
  } finally { rmTemp(root); }
});

// ── what else rides along on a pull ───────────────────────────────────────
//
// A fast-forward updates the WHOLE working tree, so a deck sharing a repo with
// anything else means "update the deck" is also "update the source tree". The
// person clicking is thinking about a slide. These pin what counts as a
// surprise, and — just as importantly — what does not: a warning that fires on
// a deck's own theme file is a warning people learn to dismiss.

test("a deck's own siblings are not a surprise; the rest is", () => {
  const { own, foreign } = splitDeckPaths([
    'talks/deck.html', 'talks/themes/aurora.css', 'talks/assets/logo.svg',
    'src/server.js', 'package.json',
  ], 'talks/deck.html');
  assert.deepEqual(own, ['talks/deck.html', 'talks/themes/aurora.css', 'talks/assets/logo.svg'],
    'themes, images and narration travel WITH a deck');
  assert.deepEqual(foreign, ['src/server.js', 'package.json']);
});

test('a deck at the repository root owns only itself', () => {
  // With no directory to scope to, everything else is foreign — which is the
  // honest answer for `git init` in a folder that already held other work.
  const { own, foreign } = splitDeckPaths(['deck.html', 'notes.md', 'src/a.js'], 'deck.html');
  assert.deepEqual(own, ['deck.html']);
  assert.deepEqual(foreign, ['notes.md', 'src/a.js']);
});

test('a repository that holds only a deck says NOTHING', () => {
  // The whole design rests on this: if the warning fires on the good case, it
  // is noise, and the next one is dismissed unread.
  assert.equal(foreignWarning({ total: 2, own: ['deck.html', 'themes/x.css'], foreign: [] }), null);
  assert.equal(foreignWarning(null), null, 'unreadable is not a warning nobody can dismiss');
});

test('the warning names three files, counts the rest, and ends with the fix', () => {
  const lines = foreignWarning({
    total: 14,
    own: ['deck.html'],
    foreign: ['src/server.js', 'package.json', '.github/workflows/ci.yml', 'a.js', 'b.js'],
  });
  assert.match(lines[0], /14 files, 5 of them not the deck/);
  assert.match(lines[1], /src\/server\.js · package\.json · \.github\/workflows\/ci\.yml · … 2 more/);
  // The recommendation is last because it is the fix, not the finding.
  assert.match(lines.at(-1), /keep the deck in a repository of its own/);
});

test('the same shape warns about a PUSH, in init\'s words', () => {
  // The hazard at the other end: initRepo runs `git add -A`, so `init` in a
  // directory holding other work commits all of it, and a repo created from
  // that pushes all of it.
  const lines = foreignWarning({ total: 24, own: ['deck.html'], foreign: ['.env.local', 'src/a.js'] },
    { verb: 'push', scope: 'everything in this directory' });
  assert.match(lines[0], /this push would change 24 files/);
  assert.match(lines.at(-1), /a push updates everything in this directory/);
});

test('one file is singular', () => {
  const lines = foreignWarning({ total: 1, own: [], foreign: ['x.js'] });
  assert.match(lines[0], /change 1 file,/);
});
