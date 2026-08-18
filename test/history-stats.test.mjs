// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What a version WAS and what it CHANGED — the two numbers the history overlay
// puts on every row (SPEC PRESENTING).
//
// Both come off git plumbing whose output is easy to parse ALMOST right, and
// both failure modes are silent: a numstat parser that mistakes a hash for a
// path attributes one commit's churn to another, and a `cat-file --batch`
// walker that splits on newlines instead of counting bytes desynchronises the
// moment a deck contains one — which every deck does. Neither throws. They just
// draw confident wrong numbers next to somebody's commits, under a button that
// overwrites their deck. So the parsers are pure and pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  STAT_DEPTH, countSlides, decorateHistory, deckHistory, parseCatFileBatch, parseNumstat,
} from '../cli/restore.mjs';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

// ── parseNumstat ─────────────────────────────────────────────────────────

test('numstat rows attach to the commit above them', () => {
  const out = `${H1}\n\n12\t3\tdeck.html\n\n${H2}\n\n40\t0\tdeck.html\n`;
  const m = parseNumstat(out);
  assert.deepEqual(m.get(H1), { add: 12, del: 3 });
  assert.deepEqual(m.get(H2), { add: 40, del: 0 });
});

test('a hash is recognised by BEING a hash, so no separator is needed', () => {
  // The distinction is real rather than positional: a numstat row always has
  // tabs and a hash line never does. Getting this wrong would attribute one
  // commit's churn to the commit before it, which is a wrong number that looks
  // completely plausible.
  const m = parseNumstat(`${H1}\n\n1\t1\tdeck.html\n`);
  assert.equal(m.size, 1);
  assert.ok(m.has(H1));
});

test('sha-256 repositories parse too', () => {
  const long = 'c'.repeat(64);
  assert.deepEqual(parseNumstat(`${long}\n\n5\t2\td.html\n`).get(long), { add: 5, del: 2 });
});

test('git\'s binary marker is null, not zero', () => {
  // `-` means "no line counts exist here", and reporting that as 0 would tell
  // an author their commit changed nothing when it may have changed everything.
  const m = parseNumstat(`${H1}\n\n-\t-\tdeck.html\n`);
  assert.deepEqual(m.get(H1), { add: null, del: null });
});

test('a commit with no numstat at all is simply absent', () => {
  // A merge shows no per-path stat without -m. Absent is the honest answer;
  // the overlay then draws that row without badges.
  const m = parseNumstat(`${H1}\n\n${H2}\n\n7\t7\tdeck.html\n`);
  assert.equal(m.has(H1), false);
  assert.deepEqual(m.get(H2), { add: 7, del: 7 });
});

test('empty and junk input yield an empty map rather than throwing', () => {
  for (const bad of ['', null, undefined, 'not a hash\nnor this']) {
    assert.equal(parseNumstat(bad).size, 0, JSON.stringify(bad));
  }
});

// ── parseCatFileBatch ────────────────────────────────────────────────────

const record = (body) => Buffer.concat([
  Buffer.from(`${'0'.repeat(40)} blob ${Buffer.byteLength(body)}\n`),
  Buffer.from(body),
  Buffer.from('\n'),
]);

test('records are walked by byte length, not by line', () => {
  // The whole point: a deck is full of newlines, and splitting on them would
  // desynchronise on the very first record.
  const a = '<section>1</section>\n<section>2</section>\n';
  const b = '<section>only</section>\n';
  const m = parseCatFileBatch(Buffer.concat([record(a), record(b)]), [H1, H2]);
  assert.equal(m.get(H1), 2);
  assert.equal(m.get(H2), 1);
});

test('a multi-byte deck does not shift the walk', () => {
  // `size` is BYTES and the offsets must be too — an em dash is three of them,
  // so a walk that counted characters would land mid-record on the next one.
  const a = '<section><h1>Café — naïve 日本語</h1></section>\n';
  const m = parseCatFileBatch(Buffer.concat([record(a), record('<section>x</section>')]), [H1, H2]);
  assert.equal(m.get(H1), 1);
  assert.equal(m.get(H2), 1);
});

test('a missing object is skipped without eating the next record', () => {
  const buf = Buffer.concat([
    Buffer.from(`${H1}:deck.html missing\n`),
    record('<section>a</section><section>b</section>'),
  ]);
  const m = parseCatFileBatch(buf, [H1, H2]);
  assert.equal(m.has(H1), false);
  assert.equal(m.get(H2), 2);
});

test('a truncated buffer stops the walk instead of inventing counts', () => {
  const buf = Buffer.from(`${'0'.repeat(40)} blob 999\n<section>a</section>`);
  const m = parseCatFileBatch(buf, [H1, H2]);
  assert.equal(m.get(H1), 1);          // what is there is counted
  assert.equal(m.has(H2), false);      // what is not is not guessed at
});

// ── countSlides ──────────────────────────────────────────────────────────

test('countSlides matches the measure decklight pdf already uses', () => {
  assert.equal(countSlides('<section>a</section>\n<section class="dark">b</section>'), 2);
  assert.equal(countSlides('<SECTION>a</SECTION>'), 1);
  assert.equal(countSlides('<p>no slides here</p>'), 0);
  assert.equal(countSlides(''), 0);
  // `<section` is a word: an element whose name merely starts with it is not one
  assert.equal(countSlides('<sectionish>x</sectionish>'), 0);
});

// ── decorateHistory, against a real repository ───────────────────────────

const repo = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-stats-'));
  const g = (a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 't@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  const deck = path.join(dir, 'deck.html');
  return { dir, deck, g };
};
const commit = ({ deck, g }, html, msg) => {
  fs.writeFileSync(deck, html);
  g(['add', '-A']);
  g(['commit', '-qm', msg]);
};
const S = (n) => Array.from({ length: n }, (_, i) => `<section><h2>${i + 1}</h2></section>`).join('\n') + '\n';

test('every row learns what its version was and what it changed', () => {
  const r = repo();
  commit(r, S(2), 'two slides');
  commit(r, S(4), 'four slides');
  commit(r, S(3), 'back down to three');
  const rows = decorateHistory(deckHistory(r.deck, r.dir), r.deck, r.dir);

  assert.deepEqual(rows.map((e) => e.slides), [3, 4, 2]);       // newest first
  assert.deepEqual(rows.map((e) => e.subject),
    ['back down to three', 'four slides', 'two slides']);
  // the first commit ADDED the file, so it has additions and no deletions
  assert.equal(rows[2].del, 0);
  assert.ok(rows[2].add > 0);
  // cutting a slide shows up as a deletion, which is the whole point of the
  // red number: "back down to three" must not look like an ordinary edit
  assert.ok(rows[0].del > 0, 'a removed slide produced no deletions');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('it is additive — the fields deckHistory already returns are untouched', () => {
  const r = repo();
  commit(r, S(1), 'one');
  const [before] = deckHistory(r.deck, r.dir);
  const [after] = decorateHistory(deckHistory(r.deck, r.dir), r.deck, r.dir);
  for (const k of ['hash', 'when', 'subject', 'full']) assert.equal(after[k], before[k], k);
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('past STAT_DEPTH a row keeps its churn but loses its slide count', () => {
  // Slide counts are the one expensive stat — they need the whole deck at that
  // revision — so they stop at a depth. Churn is cheap and does not.
  const r = repo();
  const n = STAT_DEPTH + 2;
  for (let i = 0; i < n; i++) commit(r, S(1 + (i % 3)), `edit ${i}`);
  const rows = decorateHistory(deckHistory(r.deck, r.dir), r.deck, r.dir);
  assert.equal(rows.length, n);
  assert.ok(Number.isFinite(rows[STAT_DEPTH - 1].slides), 'the last row inside the depth has no count');
  assert.equal(rows[STAT_DEPTH].slides, undefined, 'the first row past the depth was counted anyway');
  assert.ok(Number.isFinite(rows[n - 1].add), 'churn should reach every row');
  fs.rmSync(r.dir, { recursive: true, force: true });
});

test('a repository that cannot answer costs the list nothing', () => {
  // Best-effort by construction: badges are a nicety, the list is the feature,
  // and a history overlay that refused to open because one probe failed would
  // be strictly worse than one with no numbers on it.
  const entries = [{ hash: 'a1b2c3d', when: 'now', subject: 'x', full: H1 }];
  const boom = () => { throw new Error('git said no'); };
  const out = decorateHistory(entries, '/x/deck.html', '/x', { run: boom, exec: boom });
  assert.deepEqual(out, entries);
  assert.equal(out[0].slides, undefined);
});

test('an empty history is returned as-is without spawning anything', () => {
  const never = () => { throw new Error('should not have run'); };
  assert.deepEqual(decorateHistory([], '/x/d.html', '/x', { run: never, exec: never }), []);
});
