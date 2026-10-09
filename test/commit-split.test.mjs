// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The commit window's split, tag and push (SPEC PRESENTING): uncommitted work
// cut into hunks, an agent's grouping turned into several commits that land
// at once, an annotated tag on HEAD, and a push that says why it could not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers.mjs';
import {
  applyHunks, commitPlan, headTags, normalizePlan, parsePlan, parseZeroHunks, planPrompt, planWorking,
  pushBlocked, pushBranch, pushError, tagHead, whereLabel, workingUnits,
} from '../cli/commit-split.mjs';
import { remoteState } from '../cli/git.mjs';

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const slide = (n, body) => `    <section>\n      <h2>Slide ${n}</h2>\n      <p>${body}</p>\n    </section>\n`;
const deck = (bodies) => `<!doctype html>\n<html><head><title>Pace</title></head><body>\n  <div class="decklight">\n${bodies.map((b, i) => slide(i + 1, b)).join('')}  </div>\n</body></html>\n`;

function repo(t, html = deck(['one', 'two', 'three', 'four'])) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-split-'));
  t.after(() => rmTemp(dir));
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'user.name', 'Tester');
  g(dir, 'config', 'user.email', 'tester@example.com');
  writeFileSync(path.join(dir, 'deck.html'), html);
  g(dir, 'add', '-A');
  g(dir, 'commit', '-q', '-m', 'the deck');
  return dir;
}

// ── the splice ──────────────────────────────────────────────────────────────

test('zero-context hunks splice back into the old file, any subset, in any order', () => {
  const before = 'a\nb\nc\nd\ne\n';
  // b changed, a line inserted after d, e removed
  const diff = '@@ -2 +2 @@\n-b\n+B\n@@ -4,0 +5 @@\n+d2\n@@ -5 +6,0 @@\n-e\n';
  const hunks = parseZeroHunks(diff);
  assert.equal(hunks.length, 3);
  assert.equal(applyHunks(before, hunks), 'a\nB\nc\nd\nd2\n');
  assert.equal(applyHunks(before, [hunks[1]]), 'a\nb\nc\nd\nd2\ne\n');
  assert.equal(applyHunks(before, [hunks[2], hunks[0]]), 'a\nB\nc\nd\n');
  assert.equal(parseZeroHunks('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n'), null, 'a missing newline sends the file whole');
});

test('a unit is named by the slides it touches', () => {
  assert.equal(whereLabel([]), 'theme or metadata');
  assert.equal(whereLabel([3]), 'slide 3');
  assert.equal(whereLabel([3, 4]), 'slides 3-4');
  assert.equal(whereLabel([2, 5]), 'slides 2, 5');
});

// ── the plan ────────────────────────────────────────────────────────────────

test('the agent\'s lines are read whatever their dressing, and every unit lands in exactly one commit', () => {
  assert.deepEqual(parsePlan('Sure:\n1, 3 | shorten the title\n- [2] : recolour the tools box\nthanks'), [
    { units: [1, 3], subject: 'shorten the title' },
    { units: [2], subject: 'recolour the tools box' },
  ]);
  const units = [1, 2, 3, 4].map((id) => ({ id }));
  // 2 named twice stays with the first; 4 forgotten joins the commit of 3
  assert.deepEqual(normalizePlan([{ subject: 'a', units: [1, 2] }, { subject: 'b', units: [2, 3] }], units), [
    { subject: 'a', units: [1, 2] }, { subject: 'b', units: [3, 4] },
  ]);
  assert.deepEqual(normalizePlan([], units), [{ subject: '', units: [1, 2, 3, 4] }], 'no answer: one commit, no subject');
  assert.deepEqual(normalizePlan([{ subject: 'x', units: [9] }, { subject: 'y', units: [1, 2, 3, 4] }], units), [{ subject: 'y', units: [1, 2, 3, 4] }], 'an empty commit is dropped');
});

test('the prompt numbers each change by its slide and spells out the reply format', () => {
  const p = planPrompt({ deck: 'deck.html', title: 'Pace', units: [
    { id: 1, where: 'slide 2', file: 'deck.html', diff: '@@ -9 +9 @@\n-<p>two</p>\n+<p>TWO</p>' },
  ] });
  assert.match(p, /The deck is titled "Pace"/);
  assert.match(p, /\[1\] slide 2 \(deck\.html\)\n@@ -9 \+9 @@/);
  assert.match(p, /<change numbers, comma-separated> \| <subject>/);
});

test('three edits on three slides, grouped two and one by the agent, land as two commits; the second is the working file', async (t) => {
  const dir = repo(t);
  const work = deck(['ONE', 'two', 'THREE', 'FOUR']);
  writeFileSync(path.join(dir, 'deck.html'), work);
  g(dir, 'add', 'deck.html');   // even staged: the index is the author's, and is left agreeing with HEAD
  const answer = '1, 3 | shout the first and last points\n2 | shout the third point\n';
  const { work: w, commits } = await planWorking({
    cwd: dir, deckPath: path.join(dir, 'deck.html'), deckRel: 'deck.html',
    resolve: (_a, prompt) => ({ prompt }), exec: async () => answer,
  });
  assert.equal(w.units.length, 3);
  assert.deepEqual(w.units.map((u) => u.where), ['slide 1', 'slide 3', 'slide 4']);
  assert.deepEqual(commits, [{ subject: 'shout the first and last points', units: [1, 3] }, { subject: 'shout the third point', units: [2] }]);

  const before = g(dir, 'rev-parse', 'HEAD');
  const made = commitPlan({
    cwd: dir, deckRel: 'deck.html', base: w.base, template: 'decklight: autosave deck.html',
    commits: commits.map((c) => ({ message: c.subject, units: c.units })),
  });
  assert.equal(made.ok, true, made.error);
  assert.equal(made.shas.length, 2);
  assert.equal(g(dir, 'rev-parse', 'HEAD~2'), before, 'two commits, on top of the HEAD the plan was made on');
  assert.deepEqual(g(dir, 'log', '--format=%s', '-2').split('\n'), ['shout the third point', 'shout the first and last points']);
  const first = g(dir, 'show', 'HEAD~1:deck.html');
  assert.match(first, /ONE/); assert.match(first, /FOUR/); assert.doesNotMatch(first, /THREE/);
  assert.equal(g(dir, 'show', 'HEAD:deck.html') + '\n', work, 'the last commit is the working file, byte for byte');
  assert.equal(g(dir, 'status', '--porcelain'), '', 'nothing left over, and the index agrees');
});

test('a plan for work that changed, or a HEAD that moved, is refused and nothing is committed', async (t) => {
  const dir = repo(t);
  writeFileSync(path.join(dir, 'deck.html'), deck(['ONE', 'two', 'three', 'four']));
  const w = workingUnits({ cwd: dir, deckRel: 'deck.html' });
  writeFileSync(path.join(dir, 'deck.html'), deck(['ONE', 'TWO', 'three', 'four']));
  const head = g(dir, 'rev-parse', 'HEAD');
  const stale = commitPlan({ cwd: dir, deckRel: 'deck.html', base: w.base, template: 't', commits: [{ message: 'x', units: [1] }] });
  assert.equal(stale.code, 'STALE');
  assert.equal(g(dir, 'rev-parse', 'HEAD'), head);
});

test('the review sidecar is its own commit, its subject read from its records, never sent to the agent', async (t) => {
  const dir = repo(t);
  writeFileSync(path.join(dir, 'deck.html'), deck(['ONE', 'two', 'three', 'four']));
  writeFileSync(path.join(dir, 'deck.review.jsonl'), `${JSON.stringify({ op: 'resolve', target: 'c1', ts: 1 })}\n`);
  let prompt = '';
  const { work, commits } = await planWorking({
    cwd: dir, deckPath: path.join(dir, 'deck.html'), deckRel: 'deck.html', also: ['deck.review.jsonl'],
    resolve: (_a, p) => { prompt = p; return {}; }, exec: async () => '1 | shout the first point',
  });
  assert.doesNotMatch(prompt, /review\.jsonl|resolve/, 'the sidecar was sent to the agent');
  assert.deepEqual(commits.map((c) => c.subject), ['shout the first point', 'review: resolve 1 comment']);
  const made = commitPlan({ cwd: dir, deckRel: 'deck.html', also: ['deck.review.jsonl'], base: work.base, template: 't',
    commits: commits.map((c) => ({ message: c.subject, units: c.units })) });
  assert.equal(made.ok, true, made.error);
  assert.equal(g(dir, 'show', '--name-only', '--format=', 'HEAD'), 'deck.review.jsonl');
  assert.equal(g(dir, 'show', '--name-only', '--format=', 'HEAD~1'), 'deck.html');
  assert.equal(g(dir, 'status', '--porcelain'), '');
});

test('what else the author staged stays staged, and out of these commits', async (t) => {
  const dir = repo(t);
  writeFileSync(path.join(dir, 'notes.txt'), 'mine\n');
  g(dir, 'add', 'notes.txt');
  writeFileSync(path.join(dir, 'deck.html'), deck(['ONE', 'two', 'three', 'four']));
  const w = workingUnits({ cwd: dir, deckRel: 'deck.html' });
  const made = commitPlan({ cwd: dir, deckRel: 'deck.html', base: w.base, template: 't', commits: [{ message: 'one', units: [1] }] });
  assert.equal(made.ok, true, made.error);
  assert.equal(g(dir, 'show', '--name-only', '--format=', 'HEAD'), 'deck.html');
  assert.equal(g(dir, 'status', '--porcelain'), 'A  notes.txt');
});

// ── tag ─────────────────────────────────────────────────────────────────────

test('a tag is annotated, on HEAD, and a bad or taken name is refused in words', (t) => {
  const dir = repo(t);
  const made = tagHead(dir, 'v1.0');
  assert.equal(made.ok, true, made.error);
  assert.equal(g(dir, 'cat-file', '-t', 'refs/tags/v1.0'), 'tag', 'annotated, not lightweight');
  assert.deepEqual(headTags(dir), ['v1.0']);
  assert.equal(tagHead(dir, 'v1.0').code, 'EXISTS');
  assert.equal(tagHead(dir, '--force').code, 'BAD');
  assert.equal(tagHead(dir, 'two words').code, 'BAD');
  assert.equal(tagHead(dir, '').code, 'BAD');
});

// ── push ────────────────────────────────────────────────────────────────────

test('push sends the branch with -u the first time, and the annotated tag on it', async (t) => {
  const dir = repo(t);
  const hub = mkdtempSync(path.join(tmpdir(), 'dl-hub-'));
  t.after(() => rmTemp(hub));
  g(hub, 'init', '-q', '--bare', '-b', 'main');
  assert.match(pushBlocked(remoteState(dir)), /git remote add origin/);
  g(dir, 'remote', 'add', 'origin', hub);
  tagHead(dir, 'v1');
  const first = await pushBranch(dir);
  assert.equal(first.ok, true, first.error);
  assert.match(first.args, /-u origin main/);
  assert.equal(g(hub, 'rev-parse', 'main'), g(dir, 'rev-parse', 'HEAD'));
  assert.equal(g(hub, 'cat-file', '-t', 'refs/tags/v1'), 'tag', 'the tag followed the branch');
  assert.equal(remoteState(dir).state, 'ok');
  const again = await pushBranch(dir);
  assert.equal(again.ok, true);
  assert.doesNotMatch(again.args, /-u/);
});

test('a push the remote rejects says to pull first; one that cannot go says why', () => {
  const s = { remote: 'origin', url: 'x' };
  assert.match(pushError({ stderr: ' ! [rejected]        main -> main (fetch first)' }, s), /pull them first/);
  assert.match(pushError({ stderr: 'fatal: Authentication failed' }, s), /refused the credentials/);
  assert.match(pushError({ stderr: 'Could not resolve host: github.com' }, s), /did not answer/);
  assert.equal(pushBlocked({ state: 'ok' }), null);
  assert.equal(pushBlocked({ state: 'no-upstream' }), null);
  assert.match(pushBlocked({ state: 'detached' }), /no branch/);
  assert.match(pushBlocked({ state: 'ambiguous-remote' }), /origin/);
});
