// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight review`'s server, against a real one (SPEC REVIEW).
//
// The claim this file exists to hold: reviewing adds ONE capability — append a
// line to `<deck>.review.jsonl` — and adds it by what it registers, not by what
// it checks. SPEC PRESENTING refuses to let a non-authoring server acquire a
// write capability, so "there is no /edit/* route here" has to be a test rather
// than a sentence in a header.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, rmTemp } from './helpers.mjs';

import { reviewRecord, commentProblem, reviewerIdentity } from '../cli/review.mjs';
import { parseReview } from '../cli/review-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

const DECK = `<!doctype html>
<html><body><div class="decklight">
  <section><h1>One</h1><p>the first slide</p></section>
  <section><h2>Two</h2><p>the second slide</p></section>
</div><script src="decklight.js"></script><script>Decklight.init({});</script></body></html>
`;

// ── the pure halves ───────────────────────────────────────────────────────

test('a record carries what the browser knows and what only the server knows', () => {
  const rec = reviewRecord(
    { slide: 12, title: 'Why this matters', fp: '9f2a1c6b', body: 'This contradicts slide 4.' },
    { by: 'Ana <ana@x>', at: '2026-08-23T10:00:00Z', deck: 'a1b2c3d', id: 'k3f9' });
  assert.deepEqual(rec, {
    id: 'k3f9',
    at: '2026-08-23T10:00:00Z',
    by: 'Ana <ana@x>',
    deck: 'a1b2c3d',
    slide: 12,
    title: 'Why this matters',
    fp: '9f2a1c6b',
    body: 'This contradicts slide 4.',
  });
  // a reply anchors to the comment, not to a slide — the slide is the parent's
  const reply = reviewRecord({ re: 'k3f9', body: 'agreed' }, { by: '', at: 't', deck: null, id: 'm1x8' });
  assert.deepEqual(reply, { id: 'm1x8', at: 't', re: 'k3f9', body: 'agreed' });
  assert.equal('by' in reply, false, 'an unnamed reviewer writes no empty by');
  assert.equal('deck' in reply, false, 'and no null commit');
});

test('a comment must belong somewhere and say something', () => {
  const ok = { slide: 1, body: 'fine' };
  assert.equal(commentProblem(ok), null);
  assert.match(commentProblem({ slide: 1, body: '   ' }), /needs something in it/);
  assert.match(commentProblem({ body: 'no slide' }), /belongs to a slide/);
  assert.match(commentProblem({ slide: 0, body: 'x' }), /belongs to a slide/);
  assert.match(commentProblem({ slide: 1, body: 'x'.repeat(4001) }), /4000 characters/);
  assert.match(commentProblem({ re: '../../etc', body: 'x' }), /bad reply target/);
  assert.match(commentProblem(null), /not a comment/);
  // a reply needs no slide — it inherits its parent's
  assert.equal(commentProblem({ re: 'k3f9', body: 'agreed' }), null);
});

test('identity is git\'s answer, and its absence is not a refusal', () => {
  const cfg = (vals) => (bin, argv) => {
    const v = vals[argv[1]];
    if (v === undefined) throw new Error('not set');
    return v;
  };
  assert.equal(reviewerIdentity('.', cfg({ 'user.name': 'Ana', 'user.email': 'a@x' })), 'Ana <a@x>');
  assert.equal(reviewerIdentity('.', cfg({ 'user.name': 'Ana' })), 'Ana');
  // a machine with no git identity still gets to speak
  assert.equal(reviewerIdentity('.', cfg({})), '');
});

// ── the server ────────────────────────────────────────────────────────────

async function startReview(t, dir, extra = []) {
  const child = spawn(process.execPath, [CLI, 'review', 'talk.html', '--port', '0', '--no-open', ...extra],
    { cwd: dir, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((ok, no) => {
    const scan = setInterval(() => {
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(scan); ok(`http://127.0.0.1:${m[1]}`); }
    }, 25);
    child.on('exit', () => { clearInterval(scan); no(new Error(`review exited early:\n${out}`)); });
    setTimeout(() => { clearInterval(scan); no(new Error(`timeout:\n${out}`)); }, 15000);
  });
  return { base, log: () => out };
}

const post = (base, body) => fetch(`${base}/review/comments`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('a comment is appended to the sidecar, and the deck is never touched', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-review-'));
  t.after(() => rmTemp(dir));
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, DECK);
  const before = readFileSync(deck);

  const { base } = await startReview(t, dir);
  const r = await (await post(base, {
    slide: 2, title: 'Two', fp: 'abc12345', body: 'This contradicts slide 1.',
  })).json();
  assert.equal(r.ok, true);
  assert.match(r.id, /^[0-9a-z]{6}$/);

  const store = path.join(dir, 'talk.review.jsonl');
  const { records } = parseReview(readFileSync(store, 'utf8'));
  assert.equal(records.length, 1);
  assert.equal(records[0].slide, 2);
  assert.equal(records[0].body, 'This contradicts slide 1.');
  assert.equal(records[0].fp, 'abc12345', 'the anchor the browser computed travels intact');

  // THE claim: this server writes one file and reads the deck.
  assert.deepEqual(readFileSync(deck), before, 'the deck is byte-identical');
  assert.deepEqual(readdirSync(dir).sort(), ['talk.html', 'talk.review.jsonl']);

  // …and appending is appending
  await post(base, { slide: 1, body: 'second' });
  assert.equal(parseReview(readFileSync(store, 'utf8')).records.length, 2);
  const lines = readFileSync(store, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'one line per comment — that is what merge=union needs');
  assert.match(lines[0], /"body":"This contradicts slide 1\."\}$/, 'body last, for the diff');
});

test('there is no /edit/* route to have refused — the capability, as a test', async (t) => {
  // SPEC PRESENTING: "a shared path with a boolean in it is how a presenting
  // server quietly acquires an editing capability later". The enforcement here
  // is that these routes were never registered, so they answer exactly like any
  // other unknown path.
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-review-'));
  t.after(() => rmTemp(dir));
  writeFileSync(path.join(dir, 'talk.html'), DECK);
  const before = readFileSync(path.join(dir, 'talk.html'));
  const { base } = await startReview(t, dir);

  for (const [method, route, body] of [
    ['POST', '/edit/notes', { slide: 1, text: 'rewritten' }],
    ['POST', '/edit/layout', { slide: 1, layout: 'split' }],
    ['POST', '/edit/element/content', { slide: 1, index: 0, html: '<p>x</p>' }],
    ['POST', '/edit/narration', { files: 'voiceover' }],
    ['POST', '/edit/record', {}],
    ['POST', '/edit/restore', { ref: 'HEAD' }],
    ['POST', '/edit/undo', {}],
    ['POST', '/edit/agent', { prompt: 'rewrite the deck' }],
    ['GET', '/edit/ping', null],
    ['GET', '/edit/history', null],
  ]) {
    const res = await fetch(base + route, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    // 404 for a GET (the static handler answers first, as it does under
    // `present`) and 405 for anything else. Both say the same thing and it is
    // the thing that matters: there was no route here to have refused.
    assert.ok(res.status === 404 || res.status === 405,
      `${method} ${route} answered ${res.status} — it should not exist at all`);
  }
  assert.deepEqual(readFileSync(path.join(dir, 'talk.html')), before, 'and none of them changed anything');
  assert.equal(existsSync(path.join(dir, 'talk.review.jsonl')), false, 'nor wrote a store');
});

test('a bad comment is refused with the reason, and writes nothing', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-review-'));
  t.after(() => rmTemp(dir));
  writeFileSync(path.join(dir, 'talk.html'), DECK);
  const { base } = await startReview(t, dir);

  for (const [payload, why] of [
    [{ slide: 1, body: '' }, /needs something in it/],
    [{ body: 'no slide' }, /belongs to a slide/],
    [{ slide: 1, body: 'x'.repeat(4001) }, /4000 characters/],
  ]) {
    const res = await post(base, payload);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, why);
  }
  assert.equal(existsSync(path.join(dir, 'talk.review.jsonl')), false);
});

test('in a repository each comment is committed — the sidecar, by itself', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-review-'));
  t.after(() => rmTemp(dir));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  g('config', 'user.name', 'Ana Ruiz');
  g('config', 'user.email', 'ana@example.com');
  writeFileSync(path.join(dir, 'talk.html'), DECK);
  g('add', 'talk.html');
  g('commit', '-qm', 'the deck');
  const deckHead = g('rev-parse', '--short', 'HEAD');

  const { base } = await startReview(t, dir);
  await post(base, { slide: 2, title: 'Two', fp: 'abc12345', body: 'Cut the third bullet.' });

  // committed, and the subject is the reviewer's prose through the sanitizer
  assert.match(g('log', '-1', '--format=%s'), /^review: Cut the third bullet\.$/);
  // ONLY the sidecar is in it — a review must never carry a deck change
  assert.deepEqual(g('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean),
    ['talk.review.jsonl']);
  // and the comment knows which deck it was written against
  const { records } = parseReview(readFileSync(path.join(dir, 'talk.review.jsonl'), 'utf8'));
  assert.equal(records[0].deck, deckHead);
  assert.equal(records[0].by, 'Ana Ruiz <ana@example.com>');
});

test('with no repository it still works — that file IS the deliverable', async (t) => {
  // The reviewer who was sent a deck and has no clone. Refusing them is
  // refusing half the people who review decks.
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-review-'));
  t.after(() => rmTemp(dir));
  writeFileSync(path.join(dir, 'talk.html'), DECK);
  const { base, log } = await startReview(t, dir);

  const r = await (await post(base, { slide: 1, body: 'no repo here' })).json();
  assert.equal(r.ok, true);
  assert.equal(r.committed, false);
  assert.equal(parseReview(readFileSync(path.join(dir, 'talk.review.jsonl'), 'utf8')).records.length, 1);
  // …and it says so up front, naming the way back
  assert.match(log(), /not committed — this is not a git repository/);
  assert.match(log(), /decklight comments talk\.html --import talk\.review\.jsonl/);
});
