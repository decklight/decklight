// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Committing on the author's word, with a snapshot underneath.
//
// The cadence used to commit every five minutes and the log filled with
// `decklight: autosave talk.html` — commits that marked nothing. The backup and
// the history are now separate things: a silent snapshot on a ref nobody walks,
// and a commit you asked for. What is asserted here is mostly that the snapshot
// is INVISIBLE — it must not move your branch, appear in your log, or sweep in
// somebody else's uncommitted work — because a safety net that changes the
// repository is not one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  NAG_AFTER_LINES, NAG_AFTER_MS, WIP_REF, deckDirty, nagText, planNag, snapshotWip, wipLine,
} from '../cli/commit-flow.mjs';

function repo(t, { deckDir = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-flow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  g('config', 'user.name', 'T');
  g('config', 'user.email', 't@x');
  if (deckDir) fs.mkdirSync(path.join(dir, deckDir), { recursive: true });
  const rel = path.join(deckDir, 'talk.html');
  const abs = path.join(dir, rel);
  fs.writeFileSync(abs, '<section><h1>One</h1></section>\n');
  g('add', '-A');
  g('commit', '-qm', 'first');
  return { dir, g, rel: rel.split(path.sep).join('/'), abs };
}

// ── the nag rule ──────────────────────────────────────────────────────────

test('the nag fires on time OR size, whichever comes first', () => {
  assert.equal(planNag({ dirty: true, sinceMs: NAG_AFTER_MS, lines: 1 }), true, 'time did not fire it');
  assert.equal(planNag({ dirty: true, sinceMs: 0, lines: NAG_AFTER_LINES }), true, 'size did not fire it');
  assert.equal(planNag({ dirty: true, sinceMs: 1000, lines: 2 }), false, 'fired below both');
});

test('a clean tree never nags', () => {
  assert.equal(planNag({ dirty: false, sinceMs: 10 * NAG_AFTER_MS, lines: 9999 }), false);
});

test('ONE nag per episode — an unanswered nag is an answer', () => {
  // The push toast's lesson: a limit expressed as a count cannot drift into
  // "every few minutes" by accident. Once it has spoken it stays quiet, however
  // long the work sits or however large it grows, until a commit resets it.
  const loud = { dirty: true, sinceMs: 10 * NAG_AFTER_MS, lines: 10 * NAG_AFTER_LINES };
  assert.equal(planNag({ ...loud, nagged: true }), false, 'it nagged twice in one episode');
  assert.equal(planNag({ ...loud, dismissed: true }), false, 'a dismissal did not hold');
  assert.equal(planNag(loud), true, 'the same state fires when the episode is fresh');
});

test('the chip says how much and how long, and stays quiet about seconds', () => {
  assert.match(nagText({ lines: 12, sinceMs: 0 }), /^12 lines uncommitted$/);
  assert.match(nagText({ lines: 1, sinceMs: 0 }), /^1 line uncommitted$/);
  assert.match(nagText({ lines: 5, sinceMs: 3 * 60000 }), /5 lines uncommitted · 3m/);
  assert.match(nagText({ lines: 5, sinceMs: 2 * 3600_000 }), /· 2h/);
  assert.match(nagText({ lines: 0, sinceMs: 0 }), /changes uncommitted/);
});

// ── what is actually uncommitted ──────────────────────────────────────────

test('a committed deck is clean, an edited one is dirty and counted', (t) => {
  const { dir, rel, abs } = repo(t);
  assert.deepEqual(deckDirty(dir, rel), { dirty: false, lines: 0 });
  fs.writeFileSync(abs, '<section><h1>Two</h1></section>\n<section><h2>New</h2></section>\n');
  const d = deckDirty(dir, rel);
  assert.equal(d.dirty, true);
  assert.ok(d.lines >= 2, `expected a line count, got ${d.lines}`);
});

test('a deck git has never seen is the most uncommitted a file can be', (t) => {
  const { dir } = repo(t);
  fs.writeFileSync(path.join(dir, 'other.html'), '<section>hi</section>');
  const d = deckDirty(dir, 'other.html');
  assert.equal(d.dirty, true, 'an untracked deck reported clean — it has no diff, which is not the same');
  assert.equal(d.untracked, true);
});

// ── the snapshot ──────────────────────────────────────────────────────────

test('the snapshot holds the deck as it is NOW, without touching the branch', (t) => {
  const { dir, g, rel, abs } = repo(t);
  const before = g('rev-parse', 'HEAD');
  fs.writeFileSync(abs, '<section><h1>Edited but uncommitted</h1></section>\n');

  const sha = snapshotWip(dir, abs, rel);
  assert.ok(sha, 'no snapshot was written');

  // the ref holds the NEW bytes …
  assert.match(g('show', `${WIP_REF}:${rel}`), /Edited but uncommitted/);
  // … and nothing else moved: same HEAD, same log, still dirty on disk
  assert.equal(g('rev-parse', 'HEAD'), before, 'the snapshot moved the branch');
  assert.equal(g('log', '--oneline').split('\n').length, 1, 'the snapshot landed in the log');
  assert.match(g('status', '--porcelain'), /talk\.html/, 'the snapshot staged or reverted the working tree');
  assert.equal(deckDirty(dir, rel).dirty, true, 'the snapshot pretended the work was committed');
});

test('the snapshot is reachable by name and by nothing else', (t) => {
  const { dir, g, rel, abs } = repo(t);
  fs.writeFileSync(abs, '<section><h1>wip</h1></section>\n');
  snapshotWip(dir, abs, rel);
  // NOT on a branch: `--branches` is the walk that matters, because branches
  // are what `git log` shows by default and what a push carries. (`--all`
  // walks every ref by definition, this one included — it would prove nothing.)
  assert.doesNotMatch(g('log', '--branches', '--oneline'), /wip snapshot/,
    'the snapshot is on a branch, so it will be logged and pushed');
  assert.equal(g('branch', '--contains', g('rev-parse', WIP_REF)).trim(), '',
    'a branch contains the snapshot');
  // …and still reachable by the one name that knows about it
  assert.match(g('rev-parse', WIP_REF), /^[0-9a-f]{40}$/, 'the ref is not readable by name');
});

test('a deck in a subdirectory snapshots the deck and keeps its siblings', (t) => {
  // putBlob rebuilds the tree path by path; a bug here would drop everything
  // beside the deck, which is exactly the bug `publish` shipped once (#384).
  const { dir, g, rel, abs } = repo(t, { deckDir: 'talks' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'kept\n');
  fs.writeFileSync(path.join(dir, 'talks', 'notes.txt'), 'kept too\n');
  g('add', '-A'); g('commit', '-qm', 'siblings');
  fs.writeFileSync(abs, '<section><h1>deep wip</h1></section>\n');

  assert.ok(snapshotWip(dir, abs, rel));
  assert.match(g('show', `${WIP_REF}:${rel}`), /deep wip/);
  assert.match(g('show', `${WIP_REF}:README.md`), /kept/, 'the snapshot dropped a sibling at the root');
  assert.match(g('show', `${WIP_REF}:talks/notes.txt`), /kept too/, "it dropped the deck's own neighbour");
});

test('somebody else\'s uncommitted work is never swept into the snapshot', (t) => {
  // The reason this is plumbing and not `git stash create`: stash takes every
  // tracked change in the tree, and decklight commits one file.
  const { dir, g, rel, abs } = repo(t);
  fs.writeFileSync(path.join(dir, 'theirs.txt'), 'committed\n');
  g('add', '-A'); g('commit', '-qm', 'theirs');
  fs.writeFileSync(path.join(dir, 'theirs.txt'), 'THEIR UNCOMMITTED EDIT\n');
  fs.writeFileSync(abs, '<section><h1>mine</h1></section>\n');

  snapshotWip(dir, abs, rel);
  assert.match(g('show', `${WIP_REF}:${rel}`), /mine/);
  assert.match(g('show', `${WIP_REF}:theirs.txt`), /^committed$/m,
    "the snapshot captured someone else's working-tree change");
});

test('a repository that cannot snapshot costs nothing', () => {
  // The safety net fails like a safety net: quietly, with the session intact.
  assert.equal(snapshotWip('/nowhere-at-all', '/nowhere-at-all/x.html', 'x.html'), null);
});

test('the startup line names the ref and how to read it', () => {
  const line = wipLine('talk.html');
  assert.match(line, /when you say so/);
  assert.match(line, /decklight\/wip:talk\.html/, 'the line does not say how to get the work back');
});

// ── what the deck says (src/core/devmode.js) ─────────────────────────────

test('the chip speaks only when the server decided to ask', async () => {
  const { commitChipText } = await import('../src/core/devmode.js');
  const asking = { dirty: true, nag: true, canWrite: true, lines: 12, sinceMs: 0 };
  assert.match(commitChipText(asking), /12 lines uncommitted — K commits/);
  // every one of these is a reason to stay silent, and the chip must not
  // second-guess any of them: the once-per-episode rule lives server-side.
  assert.equal(commitChipText({ ...asking, nag: false }), null, 'it spoke before being asked to');
  assert.equal(commitChipText({ ...asking, dirty: false }), null);
  assert.equal(commitChipText({ ...asking, canWrite: false }), null, 'it offered to commit with no git');
  assert.equal(commitChipText(null), null);
});

test('the chip ages the work in minutes and hours, never seconds', async () => {
  const { commitChipText } = await import('../src/core/devmode.js');
  const at = (sinceMs) => commitChipText({ dirty: true, nag: true, canWrite: true, lines: 3, sinceMs });
  assert.doesNotMatch(at(30_000), /·/, 'half a minute is not worth a number');
  assert.match(at(5 * 60_000), /· 5m/);
  assert.match(at(3 * 3600_000), /· 3h/);
  assert.match(at(0), /^3 lines uncommitted — K commits$/);
});

// ── the one commit that is NOT an autosave ────────────────────────────────

test('a deck with no HEAD to parent on reports the case that needs a real commit', (t) => {
  // The first commit is how the deck ENTERS git, not an autosave of it: without
  // it there is no HEAD for the snapshot to hang from and nothing in the
  // repository to recover. Removing the opening commit along with the rest of
  // the bookends left `decklight author --git` creating an empty repository —
  // `git log` fatal, `snapshotWip` unable to run, the deck in git nowhere.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-first-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'talk.html'), '<section><h1>New</h1></section>\n');

  const d = deckDirty(dir, 'talk.html');
  assert.equal(d.dirty, true);
  assert.equal(d.firstCommit, true, 'a repository with no HEAD did not say so');
  // …and the snapshot cannot stand in for it: there is nothing to parent on
  assert.equal(snapshotWip(dir, path.join(dir, 'talk.html'), 'talk.html'), null,
    'a snapshot was written with no HEAD — it would have no parent');
});
