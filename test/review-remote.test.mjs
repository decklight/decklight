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
import { rmTemp, stop } from './helpers.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  reviewsWaiting, myReviews, reviewLine, describeBranch, reviewCheckSuppressed, remoteNameProblem, doneComments, doneKey, usableId,
} from '../cli/review-remote.mjs';
import { parseReview, mergeById, serializeRecord, reviewPathFor } from '../cli/review-store.mjs';
import { submitReview } from '../cli/review-submit.mjs';
import { foldReview } from '../tools/review-anchor.mjs';

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

test('myReviews lists back what THIS reviewer submitted, and nobody else\'s', async (t) => {
  // ana's clone after a `git reset --hard origin/main`: her sidecar is gone,
  // her comments sit on the remote. M must still show them — hers, not bo's.
  const { dir } = fixture();
  t.after(() => rmTemp(dir));
  const anaDeck = path.join(dir, 'ana', 'talks', 'deck.html');
  fs.rmSync(path.join(dir, 'ana', 'talks', 'deck.review.jsonl'), { force: true });
  const mine = await myReviews(anaDeck, 'ana');
  assert.equal(mine.state, 'ok');
  assert.deepEqual(mine.branches, ['review/ana-2026-08-20']);
  assert.deepEqual(mine.records.map((r) => r.id).sort(), ['a1', 'a2']);
  // bo's branch is not hers; a stranger has nothing
  assert.deepEqual((await myReviews(anaDeck, 'bo')).records.map((r) => r.id), ['b1', 'b2']);
  assert.equal((await myReviews(anaDeck, 'nobody')).state, 'none');
  assert.equal((await myReviews(anaDeck, null)).state, 'none', 'no identity, no lookup');
  // the other deck's review branch is not this deck's
  assert.equal((await myReviews(path.join(dir, 'ana', 'talks', 'other.html'), 'ana')).state, 'none');
});

test('the no-trust server lists the reviewer\'s submitted comments beside her sidecar', async (t) => {
  // The route merges by id: a comment that is in both is one; one her local
  // branch lost is still hers to see, and one she just wrote is there too.
  const { dir } = fixture();
  t.after(() => rmTemp(dir));
  const clone = path.join(dir, 'ana');
  const store = path.join(clone, 'talks', 'deck.review.jsonl');
  // keep a1 locally, lose a2 (the reset), and add a fresh local line
  fs.writeFileSync(store, [
    JSON.stringify({ id: 'a1', at: '2026-08-24T09:00:00Z', by: 'r', slide: 1, body: 'first' }),
    JSON.stringify({ id: 'a9', at: '2026-08-25T09:00:00Z', by: 'r', slide: 1, body: 'local only' }),
  ].join('\n') + '\n');
  const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/decklight.mjs');
  const child = spawn(process.execPath, [CLI, 'talks/deck.html', '--no-trust', '--port', '0', '--no-git'],
    { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECKLIGHT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'dl-home-')) } });
  t.after(() => stop(child));
  let out = '';
  child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((ok, no) => {
    const scan = setInterval(() => { const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearInterval(scan); ok(`http://127.0.0.1:${m[1]}`); } }, 25);
    child.on('exit', () => { clearInterval(scan); no(new Error('exited early:\n' + out)); });
    setTimeout(() => { clearInterval(scan); no(new Error('timeout:\n' + out)); }, 15000);
  });
  const listed = await (await fetch(`${base}/deck/review/comments`)).json();
  assert.deepEqual(listed.records.map((r) => r.id).sort(), ['a1', 'a2', 'a9'], 'sidecar first, the remote\'s own behind it, merged by id');
  assert.deepEqual(listed.mine, { state: 'ok', branches: ['review/ana-2026-08-20'] });
});

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
  assert.equal(bo.replies, undefined, 'replies are not a thing a review reports');
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
// Doneness is per COMMENT, and the mark is the same record whoever owns the
// comment: `{op:'resolve'}` in the author's own sidecar, naming the id, which
// travels so the reviewer sees the tick after a pull. A reviewer's branch is
// never written; the listing folds their comments with the author's ops.

test('a resolve in the author\'s own sidecar marks a reviewer\'s comment done, and travels', async (t) => {
  const { dir, deck } = fixture();
  t.after(() => rmTemp(dir));
  const store = path.join(path.dirname(deck), 'deck.review.jsonl');
  // ana sent a1 and a2; the author resolves a1 from their own file, then
  // takes it back, then resolves it again — the latest wins
  fs.appendFileSync(store, [
    JSON.stringify({ op: 'resolve', re: 'a1', at: '2026-08-25T09:00:00Z', by: 'Gilles' }),
    JSON.stringify({ op: 'reopen', re: 'a1', at: '2026-08-25T09:10:00Z', by: 'Gilles' }),
    JSON.stringify({ op: 'resolve', re: 'a1', at: '2026-08-25T09:20:00Z', by: 'Gilles' }),
  ].join('\n') + '\n');
  const r = await reviewsWaiting(deck);
  const ana = r.reviews.find((x) => x.who === 'ana');
  assert.deepEqual(ana.doneIds, ['a1']);
  assert.equal(ana.waiting, 1, 'one of two left');
  assert.equal(ana.done, false);
  // nothing of ana's was copied: the sidecar holds the ops and nothing else
  assert.ok(!fs.readFileSync(store, 'utf8').includes('"first"'));
  // and the mark is what the REVIEWER'S fold would read after a pull: her
  // branch's records plus the author's ops fold to a resolved a1
  const hers = fs.readFileSync(store, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const theirs = [{ id: 'a1', slide: 1, body: 'first' }, { id: 'a2', slide: 1, body: 'second' }];
  const folded = foldReview([...theirs, ...hers]);
  assert.ok(folded.find((c) => c.id === 'a1').resolved, 'the reviewer sees it resolved');
  assert.equal(folded.find((c) => c.id === 'a2').resolved, null);
});

test('a legacy git-config mark yields to the sidecar once the sidecar speaks about that comment', async (t) => {
  // Marked done on an earlier build (git config), then R on the new one:
  // the reopen is appended and must WIN, or the comment stays pinned done and
  // the resolve that travels can never be written.
  const { dir, deck } = fixture();
  t.after(() => rmTemp(dir));
  const branch = 'review/ana-2026-08-20';
  execFileSync('git', ['config', `decklight-review.${branch}.done-a1`, 'true'], { cwd: path.dirname(deck) });
  execFileSync('git', ['config', `decklight-review.${branch}.done-a2`, 'true'], { cwd: path.dirname(deck) });
  const store = path.join(path.dirname(deck), 'deck.review.jsonl');
  fs.appendFileSync(store, JSON.stringify({ op: 'reopen', re: 'a1', at: '2026-08-25T09:00:00Z', by: 'Gilles' }) + '\n');
  let ana = (await reviewsWaiting(deck)).reviews.find((x) => x.who === 'ana');
  assert.deepEqual(ana.doneIds, ['a2'], 'the reopened one is open again; the untouched legacy mark still counts');
  fs.appendFileSync(store, JSON.stringify({ op: 'resolve', re: 'a1', at: '2026-08-25T09:05:00Z', by: 'Gilles' }) + '\n');
  ana = (await reviewsWaiting(deck)).reviews.find((x) => x.who === 'ana');
  assert.deepEqual([...ana.doneIds].sort(), ['a1', 'a2']);
  assert.equal(ana.done, true);
});

test('an id that could not be a config key is refused when reading legacy marks', () => {
  // Ids are minted `[a-z0-9]{1,12}`, but a comment arrives from a file somebody
  // else wrote. The shape check guards the legacy git-config read.
  assert.equal(usableId('aa1'), true);
  assert.equal(usableId('../evil'), false);
  assert.equal(usableId('has space'), false);
  assert.equal(usableId(''), false);
  assert.equal(usableId(null), false);
});

test('the marks an earlier version kept in git config still count, and are only read', (t) => {
  // `[decklight-review "<branch>"] done = true` (whole review) and
  // `done-<id>` (per comment) shipped before the mark became a resolve
  // record. Somebody may have marked a review with them, and silently
  // un-marking their work on upgrade would be a poor trade.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-legacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const branch = 'review/old-2026-01-01';
  execFileSync('git', ['config', `decklight-review.${branch}.done`, 'true'], { cwd: dir });
  const records = [{ id: 'x1' }, { id: 'x2' }];
  assert.deepEqual([...doneComments(dir, branch, { records })].sort(), ['x1', 'x2']);
});

test('a repository that cannot be read costs the legacy marks, never a crash', () => {
  const boom = () => { throw new Error('read-only'); };
  assert.deepEqual([...doneComments('/nowhere', 'review/x', { run: boom })], []);
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
