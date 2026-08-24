// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Building a git tree without touching the working tree.
//
// Lifted out of cli/publish.mjs, which invented this, when `review submit`
// turned out to need exactly the same thing. It is the mechanism behind every "push something without checking
// anything out" in decklight: objects land in the repository's database,
// nothing references them until the push, and neither the working tree, the
// index nor the checked-out branch ever hears about it.
//
// Extracted rather than copied because the one subtle line here — git's tree
// ordering, which compares a directory as if its name ended in `/` — is exactly
// the kind of thing two copies diverge on silently. A tree sorted the other way
// is accepted by `mktree` and then reported by `git fsck`, long after whoever
// wrote the second copy has moved on.
//
// Every function takes the caller's own `git(args, input)` runner, so the cwd,
// the failure convention and the error wording stay the caller's business.

/**
 * One tree's entries: `<mode> <type> <sha>\t<name>` per line.
 *
 * `--full-tree` is load-bearing and not a flourish. Plain `git ls-tree <tree>`
 * is implicitly scoped to the CURRENT PATH PREFIX: run from `talks/` it lists
 * `<tree>:talks` rather than the root. Both callers run git in the deck's own
 * directory, so without this a deck in a subdirectory rebuilds the repository's
 * whole tree from that subdirectory's contents — every sibling above it silently
 * deleted in the pushed commit, and no error anywhere.
 */
export function lsTree(git, sha) {
  return git(['ls-tree', '--full-tree', sha]).split('\n').filter(Boolean).map((l) => {
    const [meta, name] = l.split('\t');
    const [mode, type, entrySha] = meta.split(/\s+/);
    return { mode, type, sha: entrySha, name };
  });
}

/**
 * Write a tree object from entries.
 *
 * The sort is git's own: byte-wise, with a tree's name compared as `name/`.
 * Get it wrong and `mktree` still accepts the tree — `git fsck` is where you
 * find out, which is much later and somewhere else.
 */
export function mktree(git, entries) {
  const key = (e) => (e.type === 'tree' ? `${e.name}/` : e.name);
  entries.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return git(['mktree'], entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\n`).join(''));
}

/**
 * A copy of the tree at `treeish` with `blobSha` placed at `pathParts`,
 * building intermediate trees and **keeping every sibling entry**.
 *
 * `treeish` may be a commit — `ls-tree` resolves it — which is why a caller can
 * hand it the parent commit directly. `null`/`undefined` means "nothing there
 * yet", which is how a missing intermediate directory gets created and how an
 * orphan commit's tree is built.
 */
export function putBlob(git, treeish, pathParts, blobSha) {
  const entries = treeish ? lsTree(git, treeish) : [];
  const name = pathParts[0];
  const kept = entries.filter((e) => e.name !== name);
  if (pathParts.length === 1) {
    kept.push({ mode: '100644', type: 'blob', sha: blobSha, name });
  } else {
    const sub = entries.find((e) => e.name === name && e.type === 'tree');
    kept.push({ mode: '040000', type: 'tree', sha: putBlob(git, sub?.sha, pathParts.slice(1), blobSha), name });
  }
  return mktree(git, kept);
}
