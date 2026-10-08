// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The review routes are the one server's, in both of its modes (SPEC REVIEW):
// a comment lands in the sidecar whether the deck was opened without trust or to
// write, the deck itself is never touched by one, and the ping says which
// mode is answering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTemp, stop } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const DECK = '<!doctype html><html><body><div class="decklight"><section><h2>Alpha</h2></section><section><h2>Beta</h2></section></div><script>Decklight.init()</script></body></html>\n';

/** The one command, one way or the other, on an ephemeral port. */
async function open(t, mode, { git: withGit = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-review-routes-'));
  writeFileSync(path.join(dir, 'talk.html'), DECK);
  if (withGit) {
    // a repository somebody else made: the deck committed, no .gitattributes
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', 'add', 'talk.html'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'deck'], { cwd: dir });
  }
  const home = mkdtempSync(path.join(tmpdir(), 'decklight-review-routes-home-'));
  const args = ['talk.html', '--port', '0', ...(withGit ? [] : ['--no-git']), ...(mode === 'no-trust' ? ['--no-trust'] : ['--no-open', '--no-tts', '--no-lipsync'])];
  const child = spawn(process.execPath, [CLI, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECKLIGHT_HOME: home } });
  t.after(async () => { await stop(child); rmTemp(dir); rmTemp(home); });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => { const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); } }, 25);
    child.on('exit', () => { clearInterval(scan); reject(new Error('exited early:\n' + out)); });
    setTimeout(() => { clearInterval(scan); reject(new Error('timeout:\n' + out)); }, 15000);
  });
  return { base, dir, log: () => out };
}
const post = (base, body) => fetch(`${base}/deck/review/comments`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

for (const mode of ['no-trust', 'write']) {
  test(`in ${mode} mode a comment is appended to the sidecar, listed back, and the deck is never touched`, async (t) => {
    const { base, dir } = await open(t, mode);
    const deck = path.join(dir, 'talk.html');
    const before = readFileSync(deck);

    const ping = await (await fetch(`${base}/deck/ping`)).json();
    assert.equal(ping.ok, true);
    assert.equal(ping.noTrust, mode === 'no-trust', 'the one probe says which mode is answering');
    assert.equal(ping.review?.mode, mode, 'and its review block says the same');
    assert.equal(ping.review.git, mode === 'no-trust' ? false : false, 'comments commit only in no-trust mode, and --no-git turned that off here');
    assert.equal(ping.name, 'talk.html');

    const r = await post(base, { slide: 2, title: 'Beta', body: 'Say less here.' });
    const text = await r.text();
    assert.equal(r.status, 200, text);
    const j = JSON.parse(text);
    assert.equal(j.ok, true);
    assert.match(j.id, /^[a-z0-9]{1,12}$/);
    const store = path.join(dir, 'talk.review.jsonl');
    assert.ok(existsSync(store), 'the sidecar, beside the deck');
    const lines = readFileSync(store, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.slide, 2);
    assert.equal(rec.body, 'Say less here.');
    assert.deepEqual(readFileSync(deck), before, 'the deck is byte-identical');

    const listed = await (await fetch(`${base}/deck/review/comments`)).json();
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0].id, j.id);

    const bad = await post(base, { slide: 2, body: '   ' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /needs something in it/);
    assert.equal(readFileSync(store, 'utf8').trim().split('\n').length, 1, 'a refused comment writes nothing');
  });
}

test('the first comment in a repository writes the union attribute, committed beside it', async (t) => {
  // The reviewer's clone of a repo that never heard of decklight: their
  // first comment must leave the repository able to merge the sidecar, or
  // their first pull after the author's resolve loses the comment.
  const { base, dir } = await open(t, 'no-trust', { git: true });
  assert.equal(existsSync(path.join(dir, '.gitattributes')), false, 'the fixture has none');
  const r = await (await post(base, { slide: 1, title: 'Alpha', body: 'First.' })).json();
  assert.equal(r.committed, true);
  assert.match(readFileSync(path.join(dir, '.gitattributes'), 'utf8'), /^\*\.review\.jsonl merge=union$/m);
  const shown = execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.match(shown, /\.gitattributes/, 'the attribute travels in the same commit as the comment');
  assert.match(shown, /talk\.review\.jsonl/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim(), '', 'nothing left behind');
  // the second record has nothing to add
  await post(base, { slide: 2, title: 'Beta', body: 'Second.' });
  assert.doesNotMatch(execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf8' }), /gitattributes/);
});

test('a resolve is taken back by a reopen — a line of its own, and the file stays a log', async (t) => {
  const { base, dir } = await open(t, 'write');
  const { id } = await (await post(base, { slide: 1, title: 'Alpha', body: 'Tighten.' })).json();
  const store = path.join(dir, 'talk.review.jsonl');
  const lines = () => readFileSync(store, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  assert.equal((await post(base, { op: 'resolve', re: id })).status, 200);
  assert.equal((await post(base, { op: 'reopen', re: id })).status, 200);
  const recs = lines();
  assert.equal(recs.length, 3, 'two appends, nothing rewritten');
  assert.deepEqual(recs.slice(1).map((r) => r.op), ['resolve', 'reopen']);
  assert.ok(recs[2].at > recs[1].at || recs[2].at === recs[1].at, 'stamped, so the fold can order them');
  assert.equal(recs[2].re, id);
  assert.equal('body' in recs[2], false, 'an op carries no prose');

  // a delete is one more line, and the listing (raw records) still carries
  // the comment: the FOLD is what drops it, wherever the file is read
  assert.equal((await post(base, { op: 'delete', re: id })).status, 200);
  assert.deepEqual(lines().slice(1).map((r) => r.op), ['resolve', 'reopen', 'delete']);
  const listed = await (await fetch(`${base}/deck/review/comments`)).json();
  assert.equal(listed.records.length, 4, 'the log is handed over whole');

  // the store knows five records and no more (REVIEW: comments are one-way)
  const reply = await post(base, { re: id, body: 'a reply' });
  assert.equal(reply.status, 400, 'a reply is refused, not stored');
  const other = await post(base, { op: 'nudge', re: id });
  assert.equal(other.status, 400);
  assert.match((await other.json()).error, /a comment, a resolve, a reopen, a delete or a move/);
  assert.equal(lines().length, 4, 'a refused op writes nothing');
});

test('no-trust mode refuses every edit route, with the review routes beside it', async (t) => {
  const { base } = await open(t, 'no-trust');
  const edit = await fetch(`${base}/deck/edit/slide/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"slide":1,"text":"x"}' });
  assert.equal(edit.status, 403, 'refused by the mode, by name');
  const page = await fetch(`${base}/talk.html`);
  assert.ok(page.headers.get('content-security-policy')?.startsWith("default-src 'none'"), 'under the policy');
});
