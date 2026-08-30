// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Finding the reviews waiting on a remote.
//
// The assertion this file cares most about is a negative one: when the check
// COULD NOT RUN, nothing anywhere says "no reviews". A silent failure and an
// all-clear look identical to an author, and mean opposite things — the whole
// state machine exists to keep them apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers.mjs';

import {
  reviewsWaiting, reviewLine, describeBranch, reviewCheckSuppressed, remoteNameProblem, doneComments, doneKey, setCommentDone, usableId,
} from '../cli/review-remote.mjs';
import { parseReview, mergeById, serializeRecord, reviewPathFor } from '../cli/review-store.mjs';
import { submitReview } from '../cli/review-submit.mjs';

const gitIn = (dir) => (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

/**
 * An author's clone of a repo holding two decks, and a bare origin that two
 * reviewers have already submitted to — through the real `submitReview`, so
 * this exercises the branches that command actually produces rather than
 * hand-built ones that might not match.
 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-incoming-'));
  const bare = path.join(dir, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);

  const author = path.join(dir, 'author');
  fs.mkdirSync(path.join(author, 'talks'), { recursive: true });
  const deck = path.join(author, 'talks', 'deck.html');
  fs.writeFileSync(deck, '<div class="decklight"><section><h2>Hi</h2></section></div>');
  const other = path.join(author, 'talks', 'other.html');
  fs.writeFileSync(other, '<div class="decklight"><section><h2>Elsewhere</h2></section></div>');
  const g = gitIn(author);
  g('init', '--quiet', '--initial-branch=main');
  g('config', 'user.name', 'Gilles'); g('config', 'user.email', 'g@example.com');
  g('remote', 'add', 'origin', bare);
  g('add', '-A'); g('commit', '--quiet', '-m', 'two decks'); g('push', '--quiet', '-u', 'origin', 'main');

  // two reviewers, each in their own clone, each submitting for real
  const submit = (who, email, day, deckName, lines) => {
    const clone = path.join(dir, who);
    execFileSync('git', ['clone', '--quiet', bare, clone]);
    const cg = gitIn(clone);
    cg('config', 'user.name', who); cg('config', 'user.email', email);
    const store = path.join(clone, 'talks', `${deckName}.review.jsonl`);
    fs.writeFileSync(store, lines.join('\n') + '\n');
    submitReview(path.join(clone, 'talks', `${deckName}.html`), {
      out: { write() {} }, now: () => new Date(`${day}T09:00:00Z`),
    });
  };
  const c = (id, body, extra = {}) =>
    JSON.stringify({ id, at: '2026-08-24T09:00:00Z', by: 'r', slide: 1, body, ...extra });

  submit('ana', 'ana@example.com', '2026-08-20', 'deck', [c('a1', 'first'), c('a2', 'second')]);
  submit('bo', 'bo@example.com', '2026-08-24', 'deck', [
    c('b1', 'a remark'),
    JSON.stringify({ id: 'b2', at: '2026-08-24T10:00:00Z', by: 'bo', re: 'a1', body: 'a reply' }),
  ]);
  // a review of the OTHER deck: must not show up when asking about this one
  submit('cy', 'cy@example.com', '2026-08-22', 'other', [c('x1', 'about the other deck')]);
  // an ordinary branch: must not be mistaken for a review
  const clone = path.join(dir, 'ana');
  gitIn(clone)('push', '--quiet', 'origin', 'main:refs/heads/feature/unrelated');

  return { dir, bare, author, deck, other, g };
}

test('describeBranch reads the who and the when back out of the ref', () => {
  assert.deepEqual(describeBranch('review/ana-2026-08-24'), { who: 'ana', when: '2026-08-24' });
  assert.deepEqual(describeBranch('review/ana.ruiz-2026-08-24'), { who: 'ana.ruiz', when: '2026-08-24' });
  // a branch somebody made by hand still renders, rather than throwing
  assert.deepEqual(describeBranch('review/whatever'), { who: 'whatever', when: null });
});

test('reviewsWaiting finds every review of THIS deck, newest first, and nothing else', async (t) => {
  const { dir, deck } = fixture();
  t.after(() => rmTemp(dir));

  const r = await reviewsWaiting(deck);
  assert.equal(r.state, 'ok');
  assert.deepEqual(r.reviews.map((x) => x.who), ['bo', 'ana'], 'newest first');
  assert.equal(r.reviews.find((x) => x.who === 'ana').comments, 2);
  const bo = r.reviews.find((x) => x.who === 'bo');
  assert.equal(bo.comments, 1, 'a reply is not a comment');
  // the records ride along — the overlay renders THEM, a count was a placeholder
  assert.ok(r.reviews.find((x) => x.who === 'ana').records.some((rec) => rec.body === 'first'),
    'the comments themselves did not travel');
  assert.equal(bo.replies, 1);
  assert.equal(bo.branch, 'review/bo-2026-08-24');
  // the review of another deck, and the unrelated branch, are both absent
  assert.equal(r.reviews.some((x) => x.who === 'cy'), false, 'a review of another deck leaked in');
  assert.equal(r.reviews.some((x) => x.branch.includes('feature')), false);

  // …and asking about the OTHER deck gets that one instead
  const o = await reviewsWaiting(path.join(path.dirname(deck), 'other.html'));
  assert.deepEqual(o.reviews.map((x) => x.who), ['cy']);
});

test('the fetch lands where a plain `git fetch` would, and nowhere new', async (t) => {
  const { dir, author, deck, g } = fixture();
  t.after(() => rmTemp(dir));
  await reviewsWaiting(deck);

  const refs = g('for-each-ref', '--format=%(refname)').split('\n').filter(Boolean);
  assert.ok(refs.includes('refs/remotes/origin/review/bo-2026-08-24'));
  // no namespace of decklight's own invention to clean up later
  assert.equal(refs.some((r) => /decklight|incoming|tmp/i.test(r)), false, `invented a ref namespace: ${refs}`);
  // and the author's own checkout is untouched by looking
  assert.equal(g('status', '--porcelain'), '');
  assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('a review already taken in stops waiting, however it was taken', async (t) => {
  const { dir, deck } = fixture();
  t.after(() => rmTemp(dir));
  const before = await reviewsWaiting(deck);
  assert.deepEqual(before.reviews.map((x) => x.who), ['bo', 'ana']);

  // the author takes ana's review in — the by-id merge the overlay's T and
  // --import both perform; HOW it arrived must not matter to "waiting"
  const store = reviewPathFor(deck);
  const mine = fs.existsSync(store) ? parseReview(fs.readFileSync(store, 'utf8')).records : [];
  const ana = before.reviews.find((x) => x.who === 'ana');
  const { records } = mergeById(mine, ana.records);
  fs.writeFileSync(store, records.map(serializeRecord).join('\n') + '\n');

  const after = await reviewsWaiting(deck);
  assert.deepEqual(after.reviews.map((x) => x.who), ['bo'], 'a taken review kept nagging');
  // …and taking it in TWICE would add nothing, which is the property that
  // makes the filter safe to compute this way
  assert.equal(mergeById(parseReview(fs.readFileSync(store, 'utf8')).records, ana.records).added, 0);
});

test('a resolved comment is not "waiting", and an all-resolved branch is not a review', async (t) => {
  const { dir, deck } = fixture();
  t.after(() => rmTemp(dir));
  // a fourth reviewer whose two comments are both already resolved, and a
  // duplicate line as a union merge would leave it
  const clone = path.join(dir, 'di');
  execFileSync('git', ['clone', '--quiet', path.join(dir, 'origin.git'), clone]);
  const cg = gitIn(clone);
  cg('config', 'user.name', 'di'); cg('config', 'user.email', 'di@example.com');
  const rec = (o) => JSON.stringify(o);
  fs.writeFileSync(path.join(clone, 'talks', 'deck.review.jsonl'), [
    rec({ id: 'd1', at: '2026-08-23T09:00:00Z', by: 'di', slide: 1, body: 'done already' }),
    rec({ id: 'd1', at: '2026-08-23T09:00:00Z', by: 'di', slide: 1, body: 'done already' }),
    rec({ op: 'resolve', re: 'd1', at: '2026-08-23T10:00:00Z', by: 'Gilles' }),
  ].join('\n') + '\n');
  submitReview(path.join(clone, 'talks', 'deck.html'), {
    out: { write() {} }, now: () => new Date('2026-08-23T11:00:00Z'),
  });

  const r = await reviewsWaiting(deck);
  assert.equal(r.reviews.some((x) => x.who === 'di'), false,
    'a branch with nothing open was reported as waiting');
  // and ana's open count is folded, not a line count
  assert.equal(r.reviews.find((x) => x.who === 'ana').comments, 2);
});

test('a remote name that could read as an option is refused, never repaired', async () => {
  assert.equal(remoteNameProblem('origin'), null);
  assert.equal(remoteNameProblem('up-stream.2'), null);
  assert.ok(remoteNameProblem('--upload-pack=x'));
  assert.ok(remoteNameProblem(''));
  const r = await reviewsWaiting('/nowhere/deck.html', {
    remote: '--upload-pack=touch /tmp/pwned',
    run: () => { throw new Error('git must not run for a refused remote name'); },
  });
  assert.equal(r.state, 'error');
  assert.match(r.reason, /not a remote name/);
});

test('a check that could not run is never reported as "no reviews"', async (t) => {
  const { dir, deck, g } = fixture();
  t.after(() => rmTemp(dir));
  // the remote goes away underneath us — the offline case, without a network
  g('remote', 'set-url', 'origin', path.join(dir, 'gone.git'));

  const r = await reviewsWaiting(deck);
  assert.notEqual(r.state, 'ok');
  assert.notEqual(r.state, 'none');
  assert.deepEqual(r.reviews, []);

  const line = reviewLine(r, { deck: 'deck.html' });
  assert.ok(line, 'a failed check said nothing at all');
  assert.match(line, /not checked/);
  assert.doesNotMatch(line, /no reviews/i);
});

test('reviewsWaiting stays out of the way where the feature does not apply', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-noincoming-'));
  t.after(() => rmTemp(dir));
  const loose = path.join(dir, 'deck.html');
  fs.writeFileSync(loose, '<div class="decklight"></div>');
  assert.equal((await reviewsWaiting(loose)).state, 'no-repo');
  assert.equal(reviewLine({ state: 'no-repo' }), null, 'nagged about a deck that is not in a repo');

  const g = gitIn(dir);
  g('init', '--quiet'); g('config', 'user.name', 'A'); g('config', 'user.email', 'a@x');
  // in a repo, but the deck is not a file it versions
  assert.equal((await reviewsWaiting(loose)).state, 'untracked');
  g('add', '-A'); g('commit', '--quiet', '-m', 'x');
  assert.equal((await reviewsWaiting(loose)).state, 'no-remote');
  assert.equal(reviewLine({ state: 'no-remote' }), null);
});

test('reviewLine says how many and from whom, and points at the next command', () => {
  const at = (d) => `2026-08-${d}T09:00:00Z`;
  const line = reviewLine({
    state: 'ok',
    reviews: [
      { who: 'bo', comments: 1, at: at('24') },
      { who: 'ana', comments: 2, at: at('20') },
    ],
  }, { deck: 'talk.html' });
  assert.equal(line, 'reviews: 3 comments waiting from bo, ana — decklight comments talk.html --incoming');

  const many = reviewLine({
    state: 'ok',
    reviews: ['a', 'b', 'c', 'd', 'e'].map((who) => ({ who, comments: 1, at: at('24') })),
  }, { deck: 'talk.html' });
  assert.match(many, /from a, b, c \+2 more/);

  assert.equal(reviewLine({ state: 'none', reviews: [] }), null, 'said something when there was nothing');
});

test('every off switch names itself, and none of them run git', () => {
  assert.equal(reviewCheckSuppressed({ args: ['--no-review-check'], env: {} }), '--no-review-check');
  assert.equal(reviewCheckSuppressed({ args: [], env: { DECKLIGHT_NO_REVIEW_CHECK: '1' } }),
    'DECKLIGHT_NO_REVIEW_CHECK is set');
  assert.equal(reviewCheckSuppressed({ args: [], env: { CI: 'true' } }), 'CI');
  assert.equal(reviewCheckSuppressed({ args: [], env: {} }), false);
  // the on-demand surface: CI silences only the unasked startup fetch — the
  // explicit switches still kill every surface
  assert.equal(reviewCheckSuppressed({ args: [], env: { CI: 'true' }, ci: false }), false);
  assert.equal(reviewCheckSuppressed({ args: ['--no-review-check'], env: { CI: 'true' }, ci: false }), '--no-review-check');
  assert.equal(reviewCheckSuppressed({ args: [], env: { DECKLIGHT_NO_REVIEW_CHECK: '1' }, ci: false }), 'DECKLIGHT_NO_REVIEW_CHECK is set');
});

test('a suppressed check makes ZERO git calls', async (t) => {
  const { dir, deck } = fixture();
  t.after(() => rmTemp(dir));
  // the caller's contract: consult the switch, and only then call. Proven by
  // handing reviewsWaiting a run() that fails the test if it is ever reached.
  const never = () => { assert.fail('git was run despite the check being suppressed'); };
  const suppressed = reviewCheckSuppressed({ args: [], env: { CI: '1' } });
  assert.ok(suppressed);
  if (!suppressed) await reviewsWaiting(deck, { run: never });
});

// ── a comment you are finished with ──────────────────────────────────────
//
// Doneness is per COMMENT, and where the mark lives follows who owns it: your
// own comments already have `{op:'resolve'}` in the sidecar, which travels; a
// reviewer's live on their branch, which is not yours to write, so the mark is
// private git config in this clone.

test('a comment mark round-trips, and does not touch its neighbours', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-done-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const branch = 'review/ana-2026-08-25';

  assert.deepEqual([...doneComments(dir, branch)], [], 'an unmarked review claimed marks');
  assert.equal(setCommentDone(dir, branch, 'aa1', true), true);
  assert.equal(setCommentDone(dir, branch, 'bb2', true), true);
  assert.deepEqual([...doneComments(dir, branch)].sort(), ['aa1', 'bb2']);
  // readable with plain git — the point of keeping it there
  assert.equal(execFileSync('git', ['config', '--get', doneKey(branch, 'aa1')],
    { cwd: dir, encoding: 'utf8' }).trim(), 'true');
  // …and one comes off without taking the other with it
  assert.equal(setCommentDone(dir, branch, 'aa1', false), true);
  assert.deepEqual([...doneComments(dir, branch)], ['bb2']);
  // a different review is a different subsection entirely
  assert.deepEqual([...doneComments(dir, 'review/bo-2026-01-01')], []);
});

test('an id that could not be a config key is refused, never handed to git', () => {
  // Ids are minted `[a-z0-9]{1,12}`, but a comment arrives from a file somebody
  // else wrote. A key git rejects is a silent no-op, which would read as "marked".
  assert.equal(usableId('aa1'), true);
  assert.equal(usableId('../evil'), false);
  assert.equal(usableId('has space'), false);
  assert.equal(usableId(''), false);
  assert.equal(usableId(null), false);
  assert.equal(setCommentDone('/nowhere', 'review/x', '../evil', true), false);
});

test('the whole-review mark the first version wrote still counts', (t) => {
  // `[decklight-review "<branch>"] done = true` shipped, briefly. Somebody may
  // have marked a review with it, and silently un-marking their work to
  // simplify the reader would be a poor trade.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const branch = 'review/old-2026-01-01';
  execFileSync('git', ['config', `decklight-review.${branch}.done`, 'true'], { cwd: dir });
  const records = [{ id: 'x1' }, { id: 'x2' }];
  assert.deepEqual([...doneComments(dir, branch, { records })].sort(), ['x1', 'x2']);
});

test('a repository that cannot be written costs a mark, never a crash', () => {
  const boom = () => { throw new Error('read-only'); };
  assert.deepEqual([...doneComments('/nowhere', 'review/x', { run: boom })], []);
  assert.equal(setCommentDone('/nowhere', 'review/x', 'aa1', true, { run: boom }), false);
});

test('the nag counts COMMENTS left, not whole reviews', () => {
  // Half a long review finished has to say so — counting reviews would call it
  // untouched until the last comment went.
  const line = reviewLine({
    state: 'ok',
    reviews: [
      { branch: 'review/a', who: 'ana', comments: 5, waiting: 2, done: false },
      { branch: 'review/b', who: 'bo', comments: 3, waiting: 3, done: false },
      { branch: 'review/c', who: 'cy', comments: 4, waiting: 0, done: true },
    ],
  }, { deck: 'talk.html' });
  assert.match(line, /5 comments waiting/, 'the count did not follow the marks');
  assert.match(line, /from ana, bo/);
  assert.doesNotMatch(line, /cy/, 'a finished review was named in the nag');
  // and nothing waiting says nothing at all
  assert.equal(reviewLine({ state: 'none', reviews: [{ branch: 'review/a', who: 'ana', comments: 2, waiting: 0, done: true }] }), null);
});
