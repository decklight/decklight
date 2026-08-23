// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight comments` — the author's side of a review (SPEC REVIEW).
//
// The thing worth testing here is not the printing, it is that a comment
// written against one deck is still findable after the deck has moved on:
// slides inserted above it, its own words edited, or the slide deleted
// outright. Those three are what happens between a review and reading it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers.mjs';

import {
  commentsMain, indexDeckFile, ago, groupComments, commitsSince, knowsCommit, slideTextOf,
} from '../cli/comments.mjs';
import { parseReview } from '../cli/review-store.mjs';
import { fingerprint } from '../src/core/review.js';

const DECK_V1 = `<!doctype html><div class="decklight">
<section><h1>Intro</h1><p>opening</p></section>
<section><h2>Why this matters</h2><p>the argument</p></section>
<section><h2>Cut me</h2><p>doomed</p></section>
</div><script>Decklight.init({});</script>`;

// A slide inserted at the top, slide 2's words edited, slide 3 deleted.
const DECK_V2 = `<!doctype html><div class="decklight">
<section><h2>Brand new</h2><p>inserted above everything</p></section>
<section><h1>Intro</h1><p>opening</p></section>
<section><h2>Why this matters</h2><p>the argument, rewritten</p></section>
</div><script>Decklight.init({});</script>`;

/** A deck, its comments, and a capture of what the command printed. */
function fixture(t, { deck = DECK_V1, lines = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-comments-'));
  t.after(() => rmTemp(dir));
  writeFileSync(path.join(dir, 'talk.html'), deck);
  if (lines.length) writeFileSync(path.join(dir, 'talk.review.jsonl'), lines.join('\n') + '\n');
  const run = (argv = []) => {
    const out = { text: '', write(s) { this.text += s; } };
    const err = { text: '', write(s) { this.text += s; } };
    const cwd = process.cwd();
    process.chdir(dir);
    try { return { code: commentsMain(['talk.html', ...argv], { out, err }), out: out.text, err: err.text }; }
    finally { process.chdir(cwd); }
  };
  return { dir, run };
}

/** A comment on slide `n` of DECK_V1, anchored the way the browser would. */
const on = (n, body, extra = {}) => {
  const s = indexDeckFile(DECK_V1)[n - 1];
  return JSON.stringify({
    id: extra.id ?? `c${n}`,
    at: extra.at ?? new Date().toISOString(),
    by: extra.by ?? 'Ana Ruiz <ana@example.com>',
    slide: n,
    title: s.title,
    fp: s.fp,
    body,
  });
};

test('no comments is an answer, and it names how to leave one', (t) => {
  // Not an error: every deck starts here, and the useful reply is how somebody
  // would leave one.
  const { run } = fixture(t);
  const { code, out } = run();
  assert.equal(code, 0);
  assert.match(out, /no comments yet/);
  assert.match(out, /decklight review talk\.html/);
});

test('the three ways a deck moves on, in one read', async (t) => {
  const { dir, run } = fixture(t, {
    lines: [
      on(2, 'This contradicts slide 1.', { id: 'aa1' }),
      on(3, 'Agreed, cut this.', { id: 'bb2' }),
      on(1, 'Nice opening.', { id: 'cc3' }),
    ],
  });
  // …and now the deck moves
  writeFileSync(path.join(dir, 'talk.html'), DECK_V2);
  const { out, code } = run();
  assert.equal(code, 0);

  // MOVED: slide 1 became slide 2, found by fingerprint, and said so
  assert.match(out, /slide 2 · Intro\s+\(was slide 1 when this was written\)/);
  // EDITED: found by title, flagged as changed, and its move reported
  assert.match(out, /slide 3 · Why this matters\s+\(was slide 2 when this was written\)/);
  assert.match(out, /⚠ this slide changed since the comment was written/);
  // DELETED: listed, not silently re-pinned to whatever is third now
  assert.match(out, /1 comment on slides that are gone/);
  assert.match(out, /⚠ the slide this was written on is gone/);
  assert.match(out, /\(was slide 3 · Cut me\)/);
  assert.match(out, /Agreed, cut this\./);

  // and nothing landed under a slide it has no business being under
  const brandNew = out.split('\n').findIndex((l) => /Brand new/.test(l));
  assert.equal(brandNew, -1, 'a comment was pinned to a slide nobody commented on');
});

test('replies nest, and resolved ones are counted rather than shouted', async (t) => {
  const { run } = fixture(t, {
    lines: [
      on(1, 'The question.', { id: 'q1' }),
      JSON.stringify({ id: 'r1', re: 'q1', by: 'Bo <bo@x>', at: new Date().toISOString(), body: 'The answer.' }),
      on(2, 'Closed off.', { id: 'z9' }),
      JSON.stringify({ op: 'resolve', re: 'z9', by: 'Gilles', at: new Date().toISOString() }),
    ],
  });
  const { out } = run();
  assert.match(out, /1 open comment, 1 resolved/);
  assert.match(out, /↳ Bo/, 'a reply hangs off its parent');
  assert.doesNotMatch(out, /Closed off/, 'resolved is not in the way by default');
  // …until asked for
  assert.match(run(['--all']).out, /Closed off/);
  assert.match(run(['--all']).out, /✓ resolved/);
});

test('unreadable lines are reported, not silently fewer comments', async (t) => {
  const { run } = fixture(t, { lines: [on(1, 'real'), '{"id":"broken"', 'nonsense'] });
  const { out } = run();
  assert.match(out, /2 line\(s\) in talk\.review\.jsonl could not be read/);
  assert.match(out, /real/);
});

test('--import merges a reviewer\'s file, and doing it twice changes nothing', async (t) => {
  // The return path for somebody who was sent the deck and has no clone.
  const { dir, run } = fixture(t, { lines: [on(1, 'mine', { id: 'mine1' })] });
  const theirs = path.join(dir, 'from-ana.review.jsonl');
  writeFileSync(theirs, [on(2, 'theirs', { id: 'ana1' }), on(3, 'also theirs', { id: 'ana2' })].join('\n') + '\n');

  const first = run(['--import', 'from-ana.review.jsonl']);
  assert.equal(first.code, 0);
  assert.match(first.out, /2 new/);
  const merged = parseReview(readFileSync(path.join(dir, 'talk.review.jsonl'), 'utf8')).records;
  assert.deepEqual(merged.map((r) => r.id), ['mine1', 'ana1', 'ana2'], 'appended, so the file stays a log');

  const again = run(['--import', 'from-ana.review.jsonl']);
  assert.match(again.out, /nothing new/);
  assert.equal(parseReview(readFileSync(path.join(dir, 'talk.review.jsonl'), 'utf8')).records.length, 3);
});

test('--import commits the sidecar, and only the sidecar', async (t) => {
  const { dir, run } = fixture(t);
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  g('config', 'user.name', 'Gilles');
  g('config', 'user.email', 'g@example.com');
  g('add', 'talk.html');
  g('commit', '-qm', 'the deck');
  // a deck edit sitting uncommitted beside it — importing must not sweep it up
  writeFileSync(path.join(dir, 'talk.html'), DECK_V2);
  writeFileSync(path.join(dir, 'in.review.jsonl'), on(1, 'from a stranger', { id: 'x1' }) + '\n');

  run(['--import', 'in.review.jsonl']);
  assert.deepEqual(g('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean),
    ['talk.review.jsonl'], 'the reviewer\'s import is not a deck change');
  assert.match(g('status', '--porcelain'), /talk\.html/, 'and the author\'s own edit is still theirs to commit');
});

test('--import refuses a file with nothing in it, naming why', async (t) => {
  const { dir, run } = fixture(t);
  writeFileSync(path.join(dir, 'empty.jsonl'), 'not json\n');
  const r = run(['--import', 'empty.jsonl']);
  assert.equal(r.code, 1);
  assert.match(r.err, /has no comments in it \(1 unreadable line/);
  assert.equal(existsSync(path.join(dir, 'talk.review.jsonl')), false, 'and wrote nothing');
});

test('orphans sort last so they are not lost among the numbered groups', () => {
  const slides = indexDeckFile(DECK_V1);
  const { groups, orphans } = groupComments([
    { id: 'a', slide: 9, title: 'Gone', fp: 'deadbeef' },
    { id: 'b', slide: 2, title: slides[1].title, fp: slides[1].fp },
    { id: 'c', slide: 1, title: slides[0].title, fp: slides[0].fp },
  ], slides);
  assert.deepEqual(groups.map((g) => g.slide), [1, 2], 'and in slide order');
  assert.deepEqual(orphans.map((c) => c.id), ['a']);
});

test('relative time reads as a person would say it', () => {
  const t0 = Date.parse('2026-08-23T12:00:00Z');
  const at = (ms) => ago(new Date(t0 - ms).toISOString(), t0);
  assert.equal(at(30e3), 'just now');
  assert.equal(at(10 * 60e3), '10 minutes ago');
  assert.equal(at(60 * 60e3), 'an hour ago');
  assert.equal(at(5 * 3600e3), '5 hours ago');
  assert.equal(at(3 * 86400e3), '3 days ago');
  assert.equal(ago('not a date'), '', 'a comment with no timestamp says nothing about when');
});

// ── which version a comment was written against ──────────────────────────
//
// Every comment records the deck's commit. The anchor verdict answers whether
// the SLIDE is still the slide; this answers which deck somebody was reading,
// and neither implies the other.

/** A repo whose deck has moved on since a comment was left. */
function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-prov-'));
  t.after(() => rmTemp(dir));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  g('config', 'user.name', 'Ana Ruiz');
  g('config', 'user.email', 'ana@example.com');
  writeFileSync(path.join(dir, 'talk.html'), DECK_V1);
  g('add', 'talk.html');
  g('commit', '-qm', 'the deck');
  const at = g('rev-parse', '--short', 'HEAD');
  return { dir, g, at };
}

test('how far the deck has moved is counted, and "unknown" is not zero', (t) => {
  const { dir, g, at } = repo(t);
  assert.equal(commitsSince(at, dir), 0, 'nothing has happened yet');
  g('commit', '-q', '--allow-empty', '-m', 'one');
  g('commit', '-q', '--allow-empty', '-m', 'two');
  assert.equal(commitsSince(at, dir), 2);
  // A comment with no commit recorded, and a commit this clone never had, are
  // both "cannot say" — reporting 0 for either would be a confident lie.
  assert.equal(commitsSince(null, dir), null);
  assert.equal(commitsSince('deadbee', dir), null);
  assert.equal(knowsCommit(at, dir), true);
  assert.equal(knowsCommit('deadbee', dir), false);
  assert.equal(knowsCommit(null, dir), false);
});

test('the listing says which version, and only when there is something to say', (t) => {
  const { dir, g, at } = repo(t);
  const store = path.join(dir, 'talk.review.jsonl');
  const line = (extra) => JSON.stringify({
    id: 'aa1', at: new Date().toISOString(), by: 'Ana Ruiz <ana@example.com>',
    slide: 1, title: 'Intro', fp: indexDeckFile(DECK_V1)[0].fp, body: 'a remark', ...extra,
  });
  const run = () => {
    const out = { text: '', write(s) { this.text += s; } };
    const cwd = process.cwd();
    process.chdir(dir);
    try { commentsMain(['talk.html'], { out, err: out }); return out.text; } finally { process.chdir(cwd); }
  };

  writeFileSync(store, line({ deck: at }) + '\n');
  assert.match(run(), new RegExp(`against ${at} \\(still current\\)`), 'the deck has not moved');

  g('commit', '-q', '--allow-empty', '-m', 'moved on');
  assert.match(run(), new RegExp(`against ${at}, 1 commit ago`));

  // a comment from a clone this repository has never seen: named, not counted
  writeFileSync(store, line({ deck: 'deadbee' }) + '\n');
  const out = run();
  assert.match(out, /against deadbee/);
  assert.doesNotMatch(out, /commits? ago|still current/, 'no count for a hash it cannot resolve');

  // and a comment written outside a repository says nothing at all rather than
  // wearing an empty field
  writeFileSync(store, line({}) + '\n');
  assert.doesNotMatch(run(), /against/);
});

test('--at shows what the slide SAID then, beside what it says now', (t) => {
  const { dir, g, at } = repo(t);
  writeFileSync(path.join(dir, 'talk.review.jsonl'), JSON.stringify({
    id: 'aa1', at: new Date().toISOString(), by: 'Ana Ruiz <ana@example.com>', deck: at,
    slide: 2, title: 'Why this matters', fp: indexDeckFile(DECK_V1)[1].fp,
    body: 'Which argument?',
  }) + '\n');
  // the deck moves: slide 2's words change
  writeFileSync(path.join(dir, 'talk.html'), DECK_V1.replace('the argument', 'the rewritten argument'));
  g('commit', '-qam', 'rewrite slide 2');

  const out = { text: '', write(s) { this.text += s; } };
  const cwd = process.cwd();
  process.chdir(dir);
  let code;
  try { code = commentsMain(['talk.html', '--at', 'aa1'], { out, err: out }); } finally { process.chdir(cwd); }
  assert.equal(code, 0);
  assert.match(out.text, /then · slide 2 · Why this matters/);
  assert.match(out.text, /Why this matters the argument\b/, 'the words they were reading');
  assert.match(out.text, /now {2}· slide 2 · Why this matters/);
  assert.match(out.text, /the rewritten argument/, 'and the words that replaced them');
});

test('--at refuses, with the reason, when it cannot show anything', (t) => {
  const { dir, at } = repo(t);
  const store = path.join(dir, 'talk.review.jsonl');
  const run = (argv) => {
    const out = { text: '', write(s) { this.text += s; } };
    const cwd = process.cwd();
    process.chdir(dir);
    try { return { code: commentsMain(['talk.html', ...argv], { out, err: out }), text: out.text }; }
    finally { process.chdir(cwd); }
  };
  const base = { id: 'aa1', at: 'now', slide: 1, title: 'Intro', body: 'x' };

  writeFileSync(store, JSON.stringify({ ...base, deck: at }) + '\n');
  let r = run(['--at', 'nope']);
  assert.equal(r.code, 1);
  assert.match(r.text, /no comment \[nope\]/);

  // written outside a repository — there is no earlier version to show, and
  // saying which of the reasons applies is the difference between an answer
  // and a shrug
  writeFileSync(store, JSON.stringify(base) + '\n');
  r = run(['--at', 'aa1']);
  assert.equal(r.code, 1);
  assert.match(r.text, /records no commit/);

  // arrived by --import from a clone with commits this one has never seen
  writeFileSync(store, JSON.stringify({ ...base, deck: 'deadbee' }) + '\n');
  r = run(['--at', 'aa1']);
  assert.equal(r.code, 1);
  assert.match(r.text, /this clone does not have deadbee/);
});

test('one slide out of a whole deck, by number', () => {
  assert.equal(slideTextOf(DECK_V1, 1), 'Intro opening');
  assert.equal(slideTextOf(DECK_V1, 3), 'Cut me doomed');
  assert.equal(slideTextOf(DECK_V1, 9), '', 'past the end is empty, not a throw');
  assert.equal(slideTextOf(DECK_V1, undefined), '');
});
