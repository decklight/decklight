// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A review is a branch (SPEC REVIEW).
//
// A reviewer's records never touch the branch she has checked out, nor the
// tracked sidecar in her work tree. Each one is a commit of its own on a LOCAL
// review branch, `refs/heads/review/<me>-<date>`, built with plumbing the way
// the wip snapshot and `comments submit` build theirs: a blob, a tree that is
// the parent's with one path replaced, `commit-tree`, `update-ref`. Nothing
// here touches the index, the work tree or HEAD, so a pull never diverges and a
// `git reset --hard` never loses a comment. Submit pushes the branch.
//
// What the reviewer sees is read back from those branches (`localReviews`), and
// so is what she submits.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parseReview, mergeById, reviewPathFor } from './review-store.mjs';
import { putBlob } from './git-tree.mjs';
import { isIdentityError } from './git.mjs';

const run = (cwd, exec) => (args, input) =>
  exec('git', args, { cwd, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

/** The sidecar's path inside the repository, as forward-slashed parts. */
export function sidecarInRepo(deckPath, exec = execFileSync) {
  const cwd = dirname(deckPath);
  const prefix = run(cwd, exec)(['rev-parse', '--show-prefix']);
  return [...prefix.split('/').filter(Boolean), basename(reviewPathFor(deckPath))];
}

/** Today's review branch for `who` (a slug, `slugUser`), as a full ref: one per reviewer per day. */
export const reviewRef = (who, date = new Date()) => `refs/heads/review/${who}-${date.toISOString().slice(0, 10)}`;

/**
 * Append one serialized record to the reviewer's review branch, as a commit
 * of its own. The branch is created on first use, parented on the checkout's
 * upstream as this clone knows it (no network), else on HEAD: what `submit`
 * pushes is re-parented on what the remote has anyway, so the local parent
 * only has to make `git log review/…` read sensibly.
 *
 * Returns `{ ref, commit, created }`. Throws when there is nothing to base
 * the branch on (an empty repository): a review branch is never an orphan,
 * for the same reason a submit never is.
 */
export function appendToReviewRef(deckPath, line, message, { who, date = new Date(), exec = execFileSync } = {}) {
  const cwd = dirname(deckPath);
  const git = run(cwd, exec);
  const ref = reviewRef(who, date);
  const inRepo = sidecarInRepo(deckPath, exec);
  let parent = null;
  try { parent = git(['rev-parse', '--verify', '--quiet', ref]); } catch { parent = null; }
  const created = !parent;
  if (!parent) {
    try { parent = git(['rev-parse', '--verify', '--quiet', '@{upstream}']); } catch { parent = null; }
    if (!parent) { try { parent = git(['rev-parse', '--verify', '--quiet', 'HEAD']); } catch { parent = null; } }
  }
  if (!parent) throw new Error('the repository has no commit to base a review branch on');
  let current = '';
  try { current = git(['show', `${parent}:${inRepo.join('/')}`]); } catch { current = ''; }
  const text = (current && !current.endsWith('\n') ? `${current}\n` : current) + line;
  const blob = git(['hash-object', '-w', '--stdin'], text);
  const tree = putBlob(git, parent, inRepo, blob);
  let commit;
  try {
    commit = git(['commit-tree', tree, '-p', parent, '-m', message]);
  } catch (e) {
    // a fresh machine has no git identity: a review still lands, under a
    // name that says so, the way gitAutocommit does for the deck
    if (!isIdentityError(e)) throw e;
    commit = git(['-c', 'user.name=decklight', '-c', 'user.email=decklight@localhost', 'commit-tree', tree, '-p', parent, '-m', message]);
  }
  git(['update-ref', '-m', message, ref, commit]);
  return { ref, branch: ref.slice('refs/heads/'.length), commit, created };
}

/**
 * The records on this reviewer's LOCAL review branches for this deck, merged
 * by id, oldest branch first: what she wrote here, whether or not it was
 * submitted yet. No network. `{ records, branches }`.
 */
export function localReviews(deckPath, who, { exec = execFileSync } = {}) {
  const cwd = dirname(deckPath);
  const git = run(cwd, exec);
  const out = { records: [], branches: [] };
  if (!who) return out;
  let names = [];
  try {
    names = git(['for-each-ref', '--format=%(refname:short)', '--sort=refname', `refs/heads/review/${who}-*`])
      .split('\n').filter(Boolean);
  } catch { return out; }
  if (!names.length) return out;
  const inRepo = sidecarInRepo(deckPath, exec).join('/');
  for (const b of names) {
    let text = '';
    try { text = git(['show', `${b}:${inRepo}`]); } catch { continue; }   // a review of another deck
    out.branches.push(b);
    out.records = mergeById(out.records, parseReview(text).records).records;
  }
  return out;
}

/**
 * The deck's review state as ONE reader sees it, so the CLI, the no-trust
 * server and submit never disagree: the sidecar beside the deck (the deck
 * branch's, carrying the author's ops after a pull) and the reviewer's own
 * local review branches, merged by id in that order. `who` is the slug the
 * branch names carry (`slugUser`); `''` reads the file alone.
 */
export function reviewState(deckPath, who, { exec = execFileSync } = {}) {
  const storePath = reviewPathFor(deckPath);
  const fileExists = existsSync(storePath);
  let text = '';
  if (fileExists) { try { text = readFileSync(storePath, 'utf8'); } catch { text = ''; } }
  const file = parseReview(text);
  const mine = who ? localReviews(deckPath, who, { exec }) : { records: [], branches: [] };
  return {
    records: mergeById(file.records, mine.records).records,
    skipped: file.skipped,
    branches: mine.branches,
    fileExists,
  };
}
