// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight review submit`: the branch name (pure, and every result run back
// through the same `refProblem` that guards it in production), and the plumbing
// against a real bare origin.
//
// The claim this file exists to hold down is that submitting NEVER TOUCHES THE
// REVIEWER'S CHECKOUT. A reviewer runs this in the middle of their own work,
// often on a branch with uncommitted changes; a `git add` or a `checkout` in
// this path would be a data-loss bug in somebody else's repository. It is
// asserted the way test/publish.test.mjs asserts it — `write-tree` as the index
// probe, because a staged-but-uncommitted change moves the index and nothing
// else, and `status --porcelain` alone would not see a re-staged identical file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers.mjs';

import { refProblem } from '../cli/marketplace.mjs';
import { branchName, slugUser, ownerRepo, compareUrl, submitReview } from '../cli/review-submit.mjs';

// --- the pure half ----------------------------------------------------------

const DAY = new Date('2026-08-24T09:41:00Z');

test('branchName is review/<user>-<ISO date>, and git accepts every one of them', () => {
  const cases = [
    ['Gilles Philippart <gilles.philippart@gmail.com>', 'review/gilles.philippart-2026-08-24'],
    ['Ana Ruiz', 'review/ana-ruiz-2026-08-24'],                      // a space is illegal in a ref
    ['ana.ruiz+deck@example.com', 'review/ana.ruiz-deck-2026-08-24'], // `+` is legal, but keep it plain
    ['', 'review/reviewer-2026-08-24'],                              // no git identity at all
    ['   ', 'review/reviewer-2026-08-24'],
    ['-rf <-rf@x>', 'review/rf-2026-08-24'],                         // a leading `-` reads as an option
    ['Ünïcödé Nàme', 'review/u-ni-co-de-na-me-2026-08-24'],
  ];
  for (const [who, expected] of cases) {
    const b = branchName(who, DAY);
    assert.equal(b, expected, JSON.stringify(who));
    assert.equal(refProblem(b), null, `git would refuse ${b}`);
  }
});

test('slugUser prefers the email local part, which is the identifying half', () => {
  // "Ana Ruiz <ana@corp.com>" is one person; the branch should say who, not what
  // they are called, and the display name is the fallback rather than the source.
  assert.equal(slugUser('Ana Ruiz <ana@corp.com>'), 'ana');
  assert.equal(slugUser('Ana Ruiz'), 'ana-ruiz');
  assert.equal(slugUser('a'.repeat(80) + '@x.com').length, 32, 'a ref is not a place for 80 characters');
});

test('ownerRepo reads every GitHub remote spelling, and nothing else', () => {
  assert.deepEqual(ownerRepo('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(ownerRepo('https://github.com/owner/repo'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(ownerRepo('ssh://git@github.com/owner/repo.git'), { owner: 'owner', repo: 'repo' });
  assert.deepEqual(ownerRepo('https://token@github.com/owner/repo/'), { owner: 'owner', repo: 'repo' });
  assert.equal(ownerRepo('https://gitlab.com/owner/repo.git'), null);
  assert.equal(ownerRepo(''), null);
});

test('compareUrl keeps the branch a path, not one percent-encoded blob', () => {
  // encodeURIComponent on the whole ref gives review%2Fana-…, which is a compare
  // page for a branch nobody has.
  assert.equal(
    compareUrl('git@github.com:o/r.git', 'review/ana-2026-08-24'),
    'https://github.com/o/r/compare/review/ana-2026-08-24?expand=1',
  );
  assert.equal(compareUrl('https://gitlab.com/o/r.git', 'review/ana-2026-08-24'), null);
});

// --- against a real bare origin ---------------------------------------------

const gitIn = (dir) => (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

/**
 * A repo holding a deck and a review sidecar, tracking a bare origin.
 *
 * The sidecar lives in a subdirectory so `putBlob`'s intermediate-tree path is
 * exercised — a submit that only ever wrote to the repo root would not notice
 * a tree builder that flattened one.
 */
function fixture({ comments = 2 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-submit-'));
  const bare = path.join(dir, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  const work = path.join(dir, 'work');
  fs.mkdirSync(path.join(work, 'talks'), { recursive: true });
  const deck = path.join(work, 'talks', 'deck.html');
  fs.writeFileSync(deck, '<!doctype html><div class="decklight"><section><h2>Hi</h2></section></div>');
  fs.writeFileSync(path.join(work, 'README.md'), 'a sibling that must survive\n');

  const git = gitIn(work);
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Ana Ruiz');
  git('config', 'user.email', 'ana@example.com');
  git('remote', 'add', 'origin', bare);
  git('add', '-A');
  git('commit', '--quiet', '-m', 'the deck');
  git('push', '--quiet', '-u', 'origin', 'main');

  const store = path.join(work, 'talks', 'deck.review.jsonl');
  const lines = Array.from({ length: comments }, (_, i) =>
    JSON.stringify({ id: `c${i}`, at: '2026-08-24T09:00:00Z', by: 'Ana Ruiz <ana@example.com>', slide: i + 1, body: `remark ${i}` }));
  fs.writeFileSync(store, lines.join('\n') + '\n');
  return { dir, bare, work, deck, store, git, bareGit: gitIn(bare) };
}

const snapshot = (git) => ({
  head: git('rev-parse', 'HEAD'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  status: git('status', '--porcelain'),
  index: git('write-tree'),
});

const sink = () => { const out = { text: '', write(s) { this.text += s; } }; return out; };
const at = (iso) => () => new Date(iso);

test('submit pushes one file to review/<user>-<date> and never touches the checkout', (t) => {
  const { dir, work, deck, git, bareGit } = fixture();
  t.after(() => rmTemp(dir));
  // a reviewer mid-work: a staged change and an unstaged one, neither of which
  // may be committed, stashed or reverted by submitting
  fs.appendFileSync(path.join(work, 'README.md'), 'staged edit\n');
  git('add', 'README.md');
  fs.writeFileSync(path.join(work, 'scratch.txt'), 'untracked\n');
  const before = snapshot(git);

  const out = sink();
  const r = submitReview(deck, { out, now: at('2026-08-24T09:41:00Z') });

  assert.equal(r.branch, 'review/ana-2026-08-24');
  assert.equal(r.pushed, true);
  assert.equal(r.comments, 2);
  assert.equal(r.resubmit, false);
  assert.equal(bareGit('rev-parse', 'refs/heads/review/ana-2026-08-24'), r.commit);

  // THE claim: the reviewer's repository is exactly as they left it
  assert.deepEqual(snapshot(git), before, 'submit moved the reviewer’s checkout');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');

  // the diff against the branch it forked from is exactly one file
  const changed = bareGit('diff', '--name-only', 'main', 'review/ana-2026-08-24').split('\n').filter(Boolean);
  assert.deepEqual(changed, ['talks/deck.review.jsonl']);
  // …and the siblings came along rather than being replaced by it
  assert.equal(bareGit('show', 'review/ana-2026-08-24:README.md'), 'a sibling that must survive');
  assert.match(bareGit('show', 'review/ana-2026-08-24:talks/deck.html'), /decklight/);

  // the full identity survives where the branch name could not carry it
  const msg = bareGit('log', '-1', '--format=%B', 'review/ana-2026-08-24');
  assert.match(msg, /^review: 2 comments on deck\.html/);
  assert.match(msg, /Signed-off-by: Ana Ruiz <ana@example\.com>/);
  assert.match(out.text, /pushed 2 comments on deck\.html → origin review\/ana-2026-08-24/);
});

test('a second submit the same day lands on the branch already there', (t) => {
  const { dir, deck, store, bareGit } = fixture({ comments: 1 });
  t.after(() => rmTemp(dir));
  const first = submitReview(deck, { out: sink(), now: at('2026-08-24T09:00:00Z') });

  fs.appendFileSync(store, JSON.stringify({ id: 'late', at: '2026-08-24T17:00:00Z', by: 'Ana Ruiz <ana@example.com>', slide: 3, body: 'one more' }) + '\n');
  const out = sink();
  const second = submitReview(deck, { out, now: at('2026-08-24T17:30:00Z') });

  assert.equal(second.branch, first.branch, 'a day of reviewing is one branch');
  assert.equal(second.resubmit, true);
  // main(1) + first submit + second submit — a fork would have left it at 2
  assert.equal(bareGit('rev-list', '--count', first.branch), '3', 'appended, not forked');
  assert.equal(bareGit('rev-parse', `${second.commit}^`), first.commit);
  // the second commit says only what the second batch added
  const delta = bareGit('diff', '--name-only', first.commit, second.commit).split('\n').filter(Boolean);
  assert.deepEqual(delta, ['talks/deck.review.jsonl']);
  assert.match(bareGit('show', `${second.commit}:talks/deck.review.jsonl`), /one more/);
});

test('--dry-run reaches commit-tree and stops: no ref anywhere', (t) => {
  const { dir, deck, git, bareGit } = fixture();
  t.after(() => rmTemp(dir));
  const before = snapshot(git);

  const out = sink();
  const r = submitReview(deck, { out, dryRun: true, now: at('2026-08-24T09:41:00Z') });

  assert.equal(r.pushed, false);
  assert.equal(bareGit('for-each-ref', '--format=%(refname)', 'refs/heads/review/'), '', 'the remote gained a branch');
  assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/heads/review/'), '', 'a local ref was written');
  assert.deepEqual(snapshot(git), before);
  // the object exists — the work was really done, only the ref was withheld
  assert.equal(git('cat-file', '-t', r.commit), 'commit');
  assert.match(out.text, /would push [0-9a-f]{7} → origin review\/ana-2026-08-24/);
  assert.match(out.text, /nothing was pushed/);
});

test('a detached-HEAD reviewer parents on the remote default branch, never an orphan', (t) => {
  const { dir, deck, git, bareGit } = fixture();
  t.after(() => rmTemp(dir));
  // a reviewer who checked out a tag to review exactly what shipped
  git('tag', 'v1.0');
  git('checkout', '--quiet', '--detach', 'v1.0');

  const r = submitReview(deck, { out: sink(), now: at('2026-08-24T09:41:00Z') });

  assert.equal(bareGit('rev-parse', `${r.commit}^`), bareGit('rev-parse', 'main'),
    'the parent is the remote default branch');
  // THE catastrophe this guards: an orphan\'s PR diff deletes the whole repo
  const changed = bareGit('diff', '--name-only', 'main', r.commit).split('\n').filter(Boolean);
  assert.deepEqual(changed, ['talks/deck.review.jsonl'], 'the diff must be the sidecar alone');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD', 'still detached, untouched');
});

test('no resolvable parent anywhere is a REFUSAL, and nothing is pushed', (t) => {
  // an empty bare remote: no review branch, no upstream worth the name, no HEAD
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-orphan-'));
  t.after(() => rmTemp(dir));
  const bare = path.join(dir, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', bare]);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const g = gitIn(work);
  g('init', '--quiet'); g('config', 'user.name', 'Ana'); g('config', 'user.email', 'ana@x.com');
  g('remote', 'add', 'origin', bare);
  const deck = path.join(work, 'deck.html');
  fs.writeFileSync(deck, '<div class="decklight"></div>');
  fs.writeFileSync(path.join(work, 'deck.review.jsonl'), JSON.stringify({ id: 'a', slide: 1, body: 'hi' }) + '\n');
  g('add', '-A'); g('commit', '--quiet', '-m', 'never pushed');

  assert.throws(() => submitReview(deck, { out: sink() }), /could not find a commit .* to base the review on/);
  assert.equal(gitIn(bare)('for-each-ref', '--format=%(refname)'), '', 'refused, yet something was pushed');
});

test('resolved comments are not announced — the count is OPEN comments, folded', (t) => {
  const { dir, deck, store, bareGit } = fixture({ comments: 2 });
  t.after(() => rmTemp(dir));
  // one of the two is resolved, and one line is a duplicate from a union merge
  fs.appendFileSync(store,
    JSON.stringify({ op: 'resolve', re: 'c0', at: '2026-08-24T10:00:00Z', by: 'Gilles' }) + '\n'
    + JSON.stringify({ id: 'c1', at: '2026-08-24T09:00:00Z', by: 'Ana Ruiz <ana@example.com>', slide: 2, body: 'remark 1' }) + '\n');

  const out = sink();
  const r = submitReview(deck, { out, now: at('2026-08-24T11:00:00Z') });
  assert.equal(r.comments, 1, 'two minus one resolved, duplicate not double-counted');
  assert.match(out.text, /pushed 1 comment on deck\.html/);
  assert.match(bareGit('log', '-1', '--format=%s', r.branch), /^review: 1 comment on deck\.html$/);
});

test('submit refuses, with a way forward, when there is nothing to send', (t) => {
  const { dir, deck, store } = fixture();
  t.after(() => rmTemp(dir));
  fs.rmSync(store);
  assert.throws(() => submitReview(deck, { out: sink() }), /no comments to submit/);

  fs.writeFileSync(store, '\n\n');
  assert.throws(() => submitReview(deck, { out: sink() }), /no comments in it/);
});

test('submit says which remote is missing rather than guessing one', (t) => {
  const { dir, deck, git } = fixture();
  t.after(() => rmTemp(dir));
  git('remote', 'remove', 'origin');
  assert.throws(() => submitReview(deck, { out: sink() }), /no remote "origin"/);
});

test('--pr without a GitHub remote is a note, never an exit', (t) => {
  const { dir, deck, bareGit } = fixture();
  t.after(() => rmTemp(dir));
  const out = sink();
  // the fixture's origin is a local bare path, which is not GitHub
  const r = submitReview(deck, { out, pr: true, now: at('2026-08-24T09:41:00Z'), gh: () => true });
  assert.equal(r.pushed, true, 'the comments are the product — they still went');
  assert.equal(r.pr, null);
  assert.match(out.text, /--pr: origin is not a GitHub remote — the branch is pushed/);
  assert.match(out.text, /tell the author:  git fetch origin review\/ana-2026-08-24/);
  bareGit('rev-parse', 'refs/heads/review/ana-2026-08-24'); // throws if absent
});
