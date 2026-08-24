#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight review submit` — send the comments back. SPEC REVIEW.
//
// A review that never leaves the reviewer's laptop is a review that did not
// happen. `decklight review` commits comments locally and then nothing happens:
// the reviewer presses Ctrl-C and walks away with commits nobody will ever see.
//
// WHAT THIS PUSHES, AND WHAT IT DOES NOT.
//
// Not the reviewer's branch. `review` commits each comment onto whatever branch
// they happen to be on, so pushing that would drag every unrelated local commit
// into somebody else's pull request. Instead this builds a commit the way
// cli/publish.mjs does — one blob, one tree parented on what the REMOTE has,
// one commit-tree, one push by object name:
//
//   hash-object -w --stdin                        the sidecar's current bytes
//   ls-remote / fetch / rev-parse FETCH_HEAD      the parent, as the remote has it
//   putBlob(parent, <path>, blob)                 every sibling preserved
//   commit-tree <tree> -p <parent>
//   push <sha>:refs/heads/review/<user>-<date>
//
// So the pull request's diff is exactly one file, and the working tree, the
// index and the checked-out branch are never touched — there is no `add`, no
// `checkout`, no `branch` and no `update-ref` anywhere in the path. That is
// asserted in test/review-submit.test.mjs with the same `write-tree` snapshot
// test/publish.test.mjs uses.
//
// ON PUSHING AT ALL. SPEC REVIEW said comments were "never pushed", and this
// changes that sentence deliberately rather than quietly. The invariant that
// carries the safety is not "no push exists" but "the SERVER never pushes":
// what a browser is pointed at holds no such capability. This is a subcommand
// somebody typed, which is the argument `publish` already makes.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { makeFail } from './util.mjs';
import { noPromptEnv, oneline } from './git.mjs';
import { refProblem } from './marketplace.mjs';
import { putBlob } from './git-tree.mjs';
import { reviewPathFor, parseReview } from './review-store.mjs';
import { foldReview } from '../tools/review-anchor.mjs';
import { reviewerIdentity } from './review.mjs';
import { ghReady } from './init.mjs';

const fail = makeFail('review submit');

/**
 * A branch-safe rendering of who is speaking.
 *
 * The email's local part first — it is nearly always `[a-z0-9._-]` already and
 * it is the half that identifies a person rather than describing them. The
 * display name is the fallback and needs the most work: "Ana Ruiz" has a space,
 * which git refuses in a ref.
 *
 * Lossy on purpose, and the loss is covered: the FULL identity rides in the
 * commit's `Signed-off-by`, so the branch name never has to be the only record
 * of who wrote a review.
 */
export function slugUser(identity) {
  const s = String(identity ?? '');
  const email = /<([^>]*)>/.exec(s)?.[1] ?? (s.includes('@') ? s : '');
  const from = email ? email.split('@')[0] : s;
  const slug = from.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 32);
  // Never empty: a machine with no git identity still gets to submit, and
  // "reviewer" is a true statement about whoever that is.
  return slug || 'reviewer';
}

/**
 * `review/<user>-<YYYY-MM-DD>`.
 *
 * The date is an ISO 8601 calendar date and NOT a full timestamp, because git
 * refuses a `:` in a ref name and an ISO time is full of them. One branch per
 * reviewer per day is also the more useful shape: a second submit the same day
 * lands on the same branch, so a morning's reviewing is one branch and one pull
 * request rather than one per time you pressed the button.
 */
export function branchName(identity, when = new Date()) {
  const day = when.toISOString().slice(0, 10);
  return `review/${slugUser(identity)}-${day}`;
}

/**
 * `owner/repo` from a GitHub remote, or null.
 *
 * The regex is `pagesUrl`'s (cli/publish.mjs), which has always captured both
 * and thrown them away. `--pr` needs them as `gh`'s `--repo`.
 */
export function ownerRepo(remoteUrl) {
  const m = (remoteUrl || '').trim().match(
    /^(?:https?:\/\/(?:[^/@]+@)?|git@|ssh:\/\/git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** The compare URL a reviewer can hand somebody when there is no `gh`. */
export function compareUrl(remoteUrl, branch) {
  const at = ownerRepo(remoteUrl);
  // per SEGMENT: the branch's own `/` is part of the path GitHub expects,
  // and encoding it to %2F gives a compare page for a branch nobody has
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  return at ? `https://github.com/${at.owner}/${at.repo}/compare/${ref}?expand=1` : null;
}

/**
 * Push the deck's review sidecar to a branch of its own.
 *
 * `exec` and `now` are injected so the whole thing is testable against a bare
 * repository without a clock.
 */
export function submitReview(deckPath, {
  remote = 'origin', pr = false, dryRun = false, out = process.stdout,
  exec = execFileSync, now = () => new Date(), gh = ghReady,
} = {}) {
  const cwd = dirname(resolve(deckPath));
  const name = basename(deckPath);
  // The deck's own directory, like publish: the repository being reviewed is
  // the deck's, wherever the command was typed.
  const git = (args, input) => {
    try {
      return exec('git', args, { cwd, encoding: 'utf8', input, env: noPromptEnv() }).trim();
    } catch (e) {
      fail(`git ${args[0]} failed: ${(e.stderr || e.message || '').toString().trim()}`);
    }
  };

  if (!existsSync(deckPath)) fail(`no such deck: ${deckPath}`);
  const storePath = reviewPathFor(resolve(deckPath));
  if (!existsSync(storePath)) {
    fail(`no comments to submit — ${basename(storePath)} does not exist yet`
      + `\n  leave some first:  decklight review ${name}`);
  }
  const bytes = readFileSync(storePath, 'utf8');
  const { records } = parseReview(bytes);
  if (!records.length) fail(`${basename(storePath)} has no comments in it`);

  try { exec('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'ignore' }); }
  catch { fail(`${cwd} is not inside a git repository — there is nowhere to push to`); }
  let remoteUrl;
  try { remoteUrl = exec('git', ['remote', 'get-url', remote], { cwd, encoding: 'utf8' }).trim(); }
  catch { fail(`no remote "${remote}" in this repository (git remote add ${remote} <url>)`); }

  const who = reviewerIdentity(cwd, exec);
  const branch = branchName(who, now());
  // The house rule: refuse a bad ref rather than repair it. `refProblem` is an
  // allowlist that already covers every character git forbids plus a leading
  // `-`, which would be read as an option rather than a ref.
  const bad = refProblem(branch);
  if (bad) fail(`the branch name ${JSON.stringify(branch)} ${bad}`);

  // The parent, as the REMOTE has it. The review branch if it is already there
  // (a second submit today appends to this morning's), else the branch this
  // deck sits on, so the diff is the comments and nothing else.
  const remoteHead = (ref) => {
    if (!git(['ls-remote', remote, ref])) return null;
    git(['fetch', '--quiet', remote, ref]);
    return git(['rev-parse', 'FETCH_HEAD']);
  };
  let parent = remoteHead(`refs/heads/${branch}`);
  const resubmit = Boolean(parent);
  if (!parent) {
    // whatever this checkout tracks, as the remote has it
    let upstreamRef = null;
    try {
      const up = exec('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        { cwd, encoding: 'utf8' }).trim();
      if (up) upstreamRef = `refs/heads/${up.split('/').slice(1).join('/')}`;
    } catch { upstreamRef = null; }
    if (upstreamRef) parent = remoteHead(upstreamRef);
  }
  if (!parent) {
    // No upstream — a detached HEAD (a reviewer on a tag), or a local branch
    // never pushed. The remote's own default branch is the right parent then:
    // it is what a pull request would diff against anyway.
    try {
      const head = exec('git', ['ls-remote', '--symref', remote, 'HEAD'],
        { cwd, encoding: 'utf8', env: noPromptEnv() });
      const m = /^ref:\s+(refs\/heads\/\S+)\s+HEAD/m.exec(head);
      if (m) parent = remoteHead(m[1]);
    } catch { parent = null; }
  }
  // NEVER AN ORPHAN. publish's orphan path is correct for gh-pages — a branch
  // whose whole history is the site. Here an orphan would be a commit whose
  // tree holds ONLY the sidecar, and a pull request from it reads as "delete
  // every file in the repository": a diff that proposes catastrophe, printed
  // under a success message. If no parent can be resolved, the true state is
  // "I cannot see what to base this on", and that is a refusal, not a guess.
  if (!parent) {
    fail(`could not find a commit on ${remote} to base the review on`
      + `\n  the review branch, this checkout's upstream, and ${remote}'s default branch all came back empty`
      + `\n  push the deck's branch first, or pass --remote if the deck lives on another remote`);
  }

  const blob = git(['hash-object', '-w', '--stdin'], bytes);
  // `--show-prefix` (where cwd sits under the root), NOT `relative(--show-toplevel, …)`.
  // On macOS the toplevel comes back as /private/var/… while the deck path is
  // /var/… — the same directory through a symlink — and `relative` of those two
  // is a string of `../..` that escapes the repository. That does not throw: it
  // builds a tree with the sidecar at an absurd name and the real directories
  // flattened out of it, which is a silently corrupt push.
  const prefix = git(['rev-parse', '--show-prefix']);
  const inRepo = [...prefix.split('/').filter(Boolean), basename(storePath)];
  const tree = putBlob(git, parent, inRepo, blob);

  // The same fold `decklight comments` renders with — a raw line count would
  // double-count union-merge duplicates and call a resolved comment a comment.
  const n = foldReview(records).filter((c) => !c.resolved).length;
  // A sidecar can hold nothing but resolves and replies — still worth pushing
  // (the union merge wants them), but never announced as "0 comments".
  const what = n ? `${n} comment${n === 1 ? '' : 's'}` : 'updates';
  let message = `review: ${what} on ${name}`;
  if (who) message += `\n\nSigned-off-by: ${who}`;
  const env = who
    ? { ...process.env, ...noPromptEnv() }
    : {
      ...process.env,
      ...noPromptEnv(),
      GIT_AUTHOR_NAME: 'decklight', GIT_AUTHOR_EMAIL: 'decklight@localhost',
      GIT_COMMITTER_NAME: 'decklight', GIT_COMMITTER_EMAIL: 'decklight@localhost',
    };
  let commit;
  try {
    commit = exec('git', ['commit-tree', tree, '-p', parent, '-m', message],
      { cwd, encoding: 'utf8', env }).trim();
  } catch (e) { fail(`git commit-tree failed: ${oneline(e)}`); }

  if (dryRun) {
    out.write(`would push ${commit.slice(0, 7)} → ${remote} ${branch}`
      + ` (${what}${resubmit ? ', onto the branch already there' : ''})\n`);
    out.write('  --dry-run: nothing was pushed, and no ref was written\n');
    return { branch, commit, pushed: false, comments: n, resubmit };
  }

  git(['push', '--quiet', remote, `${commit}:refs/heads/${branch}`]);
  out.write(`pushed ${what} on ${name} → ${remote} ${branch}\n`);

  let prUrl = null;
  if (pr) {
    const at = ownerRepo(remoteUrl);
    if (!at) out.write(`  --pr: ${remote} is not a GitHub remote — the branch is pushed\n`);
    else if (!gh(exec)) out.write('  --pr: needs gh installed and signed in (gh auth login) — the branch is pushed\n');
    else {
      try {
        prUrl = exec('gh', ['pr', 'create',
          '--repo', `${at.owner}/${at.repo}`,
          '--head', branch,
          '--title', `Review: ${what} on ${name}`,
          '--body', `Left with \`decklight review ${name}\`.\n\n`
            + `Read them with:\n\n    decklight comments ${name}\n`,
        ], { cwd, encoding: 'utf8', env: noPromptEnv(), timeout: 60_000 }).trim();
        out.write(`  ${prUrl}\n`);
      } catch (e) {
        // A note, never an exit: the comments are pushed, which is the product.
        out.write(`  --pr: gh could not open it — ${oneline(e)}\n`);
      }
    }
  }
  if (!prUrl) {
    const url = compareUrl(remoteUrl, branch);
    if (url) out.write(`  open a pull request:  ${url}\n`);
    else out.write(`  tell the author:  git fetch ${remote} ${branch}\n`);
  }
  return { branch, commit, pushed: true, comments: n, resubmit, pr: prUrl };
}
