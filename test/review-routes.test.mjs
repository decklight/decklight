// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The review routes are the one server's, in both of its modes (SPEC REVIEW):
// a comment lands in the sidecar whether the deck was opened read-only or to
// write, the deck itself is never touched by one, and the ping says which
// mode is answering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTemp, stop } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const DECK = '<!doctype html><html><body><div class="decklight"><section><h2>Alpha</h2></section><section><h2>Beta</h2></section></div><script>Decklight.init()</script></body></html>\n';

/** The one command, one way or the other, on an ephemeral port. */
async function open(t, mode) {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-review-routes-'));
  writeFileSync(path.join(dir, 'talk.html'), DECK);
  const home = mkdtempSync(path.join(tmpdir(), 'decklight-review-routes-home-'));
  const args = ['talk.html', '--port', '0', '--no-git', ...(mode === 'read-only' ? ['--read-only'] : ['--no-open', '--no-tts', '--no-lipsync'])];
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

for (const mode of ['read-only', 'write']) {
  test(`in ${mode} mode a comment is appended to the sidecar, listed back, and the deck is never touched`, async (t) => {
    const { base, dir } = await open(t, mode);
    const deck = path.join(dir, 'talk.html');
    const before = readFileSync(deck);

    const ping = await (await fetch(`${base}/deck/ping`)).json();
    assert.equal(ping.ok, true);
    assert.equal(ping.readOnly, mode === 'read-only', 'the one probe says which mode is answering');
    assert.equal(ping.review?.mode, mode, 'and its review block says the same');
    assert.equal(ping.review.git, mode === 'read-only' ? false : false, 'comments commit only in read-only mode, and --no-git turned that off here');
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

test('read-only mode refuses every edit route, with the review routes beside it', async (t) => {
  const { base } = await open(t, 'read-only');
  const edit = await fetch(`${base}/deck/edit/slide/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"slide":1,"text":"x"}' });
  assert.equal(edit.status, 403, 'refused by the mode, by name');
  const page = await fetch(`${base}/talk.html`);
  assert.ok(page.headers.get('content-security-policy')?.startsWith("default-src 'none'"), 'under the policy');
});
