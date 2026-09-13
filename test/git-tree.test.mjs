// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Building a git tree without a checkout — the plumbing under `publish` and
// `review submit` (SPEC PRESENTING, SPEC REVIEW).
//
// Every bug this module can have is silent. A sibling dropped while rebuilding
// an intermediate tree deletes files in the pushed commit with no error
// anywhere; a tree sorted by plain name is accepted by `mktree` and only
// reported much later by `git fsck`; a `remoteHead` that fetches before asking
// turns "the branch does not exist yet" into a failure. None of that is
// reachable from a unit test against a real repository without writing objects,
// but `git` is injected here — so these tests hand the module a fake runner and
// read back the exact bytes it would have piped into `git mktree`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lsTree, mktree, putBlob, remoteHead } from '../cli/git-tree.mjs';

// ── a fake `git(args, input)` ──────────────────────────────────────────────

// `trees` maps a treeish to the exact stdout `git ls-tree --full-tree` would
// print for it. mktree hands back a synthetic sha and records what it was fed.
function fakeGit(trees = {}, { lsRemote = '', revParse = 'f'.repeat(40) } = {}) {
  const calls = [];
  const written = new Map();   // synthetic sha → the stdin mktree received
  let n = 0;
  const git = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'ls-tree') {
      const sha = args[args.length - 1];
      assert.ok(sha in trees, `fake git asked for an unknown tree: ${sha}`);
      return trees[sha];
    }
    if (args[0] === 'mktree') {
      const sha = `tree${++n}`;
      written.set(sha, input);
      return sha;
    }
    if (args[0] === 'ls-remote') return lsRemote;
    if (args[0] === 'fetch') return '';
    if (args[0] === 'rev-parse') return revParse;
    assert.fail(`fake git got an unexpected command: ${args.join(' ')}`);
  };
  return { git, calls, written };
}

const line = (mode, type, sha, name) => `${mode} ${type} ${sha}\t${name}`;
const lines = (...ls) => `${ls.join('\n')}\n`;

// A repository with a blob and a tree that share a prefix at the root, and a
// deck two levels down — the shape that exercises both hazards at once.
const ROOT = lines(
  line('100644', 'blob', 'b_readme', 'README.md'),
  line('100644', 'blob', 'b_atxt', 'a.txt'),
  line('040000', 'tree', 't_a', 'a'),
  line('040000', 'tree', 't_talks', 'talks'),
);
const TALKS = lines(
  line('040000', 'tree', 't_deck', 'deck'),
  line('100644', 'blob', 'b_index', 'index.html'),
  line('100644', 'blob', 'b_notes', 'notes.md'),
);
const DECK = lines(
  line('100644', 'blob', 'b_old', 'index.html'),
  line('100644', 'blob', 'b_style', 'style.css'),
);
const REPO = { HEAD: ROOT, t_talks: TALKS, t_deck: DECK };

// ── lsTree ─────────────────────────────────────────────────────────────────

test('an ls-tree line splits into mode, type, sha and name', () => {
  const { git } = fakeGit(REPO);
  assert.deepEqual(lsTree(git, 't_deck'), [
    { mode: '100644', type: 'blob', sha: 'b_old', name: 'index.html' },
    { mode: '100644', type: 'blob', sha: 'b_style', name: 'style.css' },
  ], 'the name is after the TAB, the three meta fields before it');
});

test('ls-tree is always asked with --full-tree', () => {
  // Without it the listing is scoped to git\'s CURRENT PATH PREFIX, so a deck
  // in a subdirectory would rebuild the whole repository from that
  // subdirectory\'s contents — every sibling above it deleted, and no error.
  const { git, calls } = fakeGit(REPO);
  lsTree(git, 'HEAD');
  assert.deepEqual(calls[0].args, ['ls-tree', '--full-tree', 'HEAD'],
    '--full-tree is load-bearing, not a flourish');
});

test('an empty listing is no entries rather than one blank one', () => {
  const { git } = fakeGit({ empty: '' });
  assert.deepEqual(lsTree(git, 'empty'), [], 'a blank line would become an entry with no name');
});

// ── mktree: git's own sort ─────────────────────────────────────────────────

test('a tree sorts as if its name ended in a slash', () => {
  // "a/" against "a.txt": "." is 0x2E and "/" is 0x2F, so the blob wins; "a/"
  // against "ab.txt": "/" beats "b", so the tree wins. The tree lands BETWEEN
  // the two blobs, which no plain name sort produces. Get it wrong and mktree
  // still accepts the tree — `git fsck` is where you find out, much later.
  const { git, written } = fakeGit();
  const sha = mktree(git, [
    { mode: '100644', type: 'blob', sha: 'B2', name: 'ab.txt' },
    { mode: '040000', type: 'tree', sha: 'T', name: 'a' },
    { mode: '100644', type: 'blob', sha: 'B1', name: 'a.txt' },
  ]);
  assert.equal(written.get(sha), lines(
    line('100644', 'blob', 'B1', 'a.txt'),
    line('040000', 'tree', 'T', 'a'),
    line('100644', 'blob', 'B2', 'ab.txt'),
  ), 'a.txt before a/ before ab.txt is git\'s ordering, not JavaScript\'s default');
});

test('every entry is written as one newline-terminated mktree line', () => {
  const { git, written } = fakeGit();
  const sha = mktree(git, [{ mode: '100644', type: 'blob', sha: 'B', name: 'x' }]);
  assert.equal(written.get(sha), '100644 blob B\tx\n',
    'mktree reads stdin line by line; a missing trailing newline drops the last entry');
});

// ── putBlob: siblings survive at every level ───────────────────────────────

test('a blob placed two levels down keeps every sibling at every level', () => {
  const { git, written } = fakeGit(REPO);
  const root = putBlob(git, 'HEAD', ['talks', 'deck', 'index.html'], 'NEW');

  assert.equal(written.get('tree1'), lines(
    line('100644', 'blob', 'NEW', 'index.html'),
    line('100644', 'blob', 'b_style', 'style.css'),
  ), 'the deepest tree swaps one blob and keeps style.css');

  assert.equal(written.get('tree2'), lines(
    line('040000', 'tree', 'tree1', 'deck'),
    line('100644', 'blob', 'b_index', 'index.html'),
    line('100644', 'blob', 'b_notes', 'notes.md'),
  ), 'talks/ keeps its own index.html and notes.md — the name collision with the deck\'s is not a match');

  assert.equal(written.get(root), lines(
    line('100644', 'blob', 'b_readme', 'README.md'),
    line('100644', 'blob', 'b_atxt', 'a.txt'),
    line('040000', 'tree', 't_a', 'a'),
    line('040000', 'tree', 'tree2', 'talks'),
  ), 'the root keeps README.md, a.txt and the a/ tree untouched');
});

test('an intermediate tree is written with mode 040000', () => {
  // 040000, not 40000 and not 100644: the entry the parent tree records for a
  // rebuilt directory has to say "directory" in git\'s own spelling.
  const { git, written } = fakeGit(REPO);
  putBlob(git, 'HEAD', ['talks', 'deck', 'index.html'], 'NEW');
  for (const input of written.values()) {
    for (const l of input.split('\n').filter(Boolean)) {
      const [mode, type] = l.split(' ');
      assert.equal(type === 'tree', mode === '040000',
        `mode and type disagree in "${l}" — fsck reads the mode, not the word`);
    }
  }
});

test('replacing a top-level blob leaves the other entries byte-identical', () => {
  // The pushed commit is the only place a dropped or reworded entry would show
  // up, so the unchanged lines are compared against ls-tree\'s own output.
  const { git, written } = fakeGit(REPO);
  const root = putBlob(git, 'HEAD', ['README.md'], 'NEW');
  const got = written.get(root).split('\n').filter(Boolean);
  const original = ROOT.split('\n').filter(Boolean);
  assert.equal(got[0], line('100644', 'blob', 'NEW', 'README.md'), 'only README.md changed sha');
  assert.deepEqual(got.slice(1), original.slice(1),
    'a.txt, a/ and talks/ come back out exactly as ls-tree printed them');
});

test('a null treeish builds from an empty tree without asking git for one', () => {
  // This is how an orphan branch\'s first commit and a missing intermediate
  // directory are both built. Calling ls-tree on null would fail the publish
  // on the one path that has nothing to list.
  for (const nothing of [null, undefined]) {
    const { git, calls, written } = fakeGit();
    const sha = putBlob(git, nothing, ['index.html'], 'NEW');
    assert.ok(!calls.some((c) => c.args[0] === 'ls-tree'),
      `putBlob(${nothing}) must not try to list a tree that does not exist`);
    assert.equal(written.get(sha), '100644 blob NEW\tindex.html\n',
      'the result is a tree holding just the new blob');
  }
});

test('a missing intermediate directory is created rather than refused', () => {
  const { git, written } = fakeGit(REPO);
  const root = putBlob(git, 'HEAD', ['slides', 'talk.html'], 'NEW');
  assert.equal(written.get('tree1'), '100644 blob NEW\ttalk.html\n',
    'slides/ did not exist, so it is built from nothing');
  assert.ok(written.get(root).includes(line('040000', 'tree', 'tree1', 'slides')),
    'and linked into the root beside everything already there');
});

// ── remoteHead ─────────────────────────────────────────────────────────────

test('a remote ref that does not exist is null, not an error', () => {
  // ls-remote first so a first publish — the branch has never been pushed —
  // is an answer rather than a fetch failure.
  const { git, calls } = fakeGit({}, { lsRemote: '' });
  assert.equal(remoteHead(git, 'origin', 'refs/heads/gh-pages'), null,
    'no ref means no parent commit, which is how an orphan branch starts');
  assert.ok(!calls.some((c) => c.args[0] === 'fetch'),
    'fetching a ref ls-remote just said is absent would fail the command for no reason');
  assert.deepEqual(calls.map((c) => c.args[0]), ['ls-remote'], 'one question, one call');
});

test('an existing remote ref is fetched into FETCH_HEAD and never into a ref', () => {
  const head = 'a'.repeat(40);
  const { git, calls } = fakeGit({}, {
    lsRemote: `${head}\trefs/heads/gh-pages\n`,
    revParse: head,
  });
  assert.equal(remoteHead(git, 'origin', 'refs/heads/gh-pages'), head,
    'the parent is the commit the REMOTE has, not anything local');
  assert.deepEqual(calls.map((c) => c.args), [
    ['ls-remote', 'origin', 'refs/heads/gh-pages'],
    ['fetch', '--quiet', 'origin', 'refs/heads/gh-pages'],
    ['rev-parse', 'FETCH_HEAD'],
  ], 'a destination-less fetch creates and moves no local ref — FETCH_HEAD is a file');
});
