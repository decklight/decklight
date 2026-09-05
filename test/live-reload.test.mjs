// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The live-reload watcher must survive the file being REPLACED.
//
// A path watch follows the inode, and an atomic save — temp file + rename,
// which is how an agent's editor and most careful tools write — swaps the
// inode out from under it: the watcher sits deaf on the old one, and every
// later edit, restore included, reloads nobody. Found in 0.7.0 manual testing
// as "restore worked but the deck kept showing the old slides" — the one
// step nobody could see was that a claude-agent edit minutes earlier had
// killed the watcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTemp, stop } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const EDIT = path.resolve(here, '../cli/edit.mjs');

test('a rename-replace does not kill live reload', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-reload-'));
  t.after(() => rmTemp(dir));
  const deck = path.join(dir, 'talk.html');
  fs.writeFileSync(deck, '<!doctype html><div class="decklight"><section><h1>Hi</h1></section></div>');

  const child = spawn(process.execPath, [EDIT, 'talk.html', '--port', '0', '--no-git', '--no-review-check'],
    { cwd: dir, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stop(child));
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = log.match(/decklight author on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { clearInterval(scan); resolve(m[1]); }
    }, 25);
    child.on('exit', () => { clearInterval(scan); reject(new Error('edit exited early:\n' + log)); });
    setTimeout(() => { clearInterval(scan); reject(new Error('no server URL:\n' + log)); }, 20000);
  });

  // listen to the reload stream the deck itself listens to
  let reloads = 0;
  const res = await fetch(`${base}/edit/events`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      reloads += (dec.decode(value, { stream: true }).match(/data: reload/g) ?? []).length;
    }
  })();
  t.after(() => reader.cancel().catch(() => { /* stream already closed */ }));
  const settle = async (want, ms = 6000) => {
    const stop = Date.now() + ms;
    while (reloads < want && Date.now() < stop) await new Promise((ok) => setTimeout(ok, 50));
    return reloads;
  };

  // 1 · a plain in-place write — the server's own style
  fs.writeFileSync(deck, fs.readFileSync(deck, 'utf8').replace('Hi', 'One'));
  assert.equal(await settle(1), 1, 'the plain write did not reload');

  // 2 · an ATOMIC save: temp file + rename, the agent-editor style
  const tmp = path.join(dir, '.talk.html.tmp');
  fs.writeFileSync(tmp, fs.readFileSync(deck, 'utf8').replace('One', 'Two'));
  fs.renameSync(tmp, deck);
  await settle(2);

  // 3 · THE assertion: a plain write AFTER the rename must still reload —
  // this is the write a path-watch never hears, because its inode is gone
  fs.writeFileSync(deck, fs.readFileSync(deck, 'utf8').replace('Two', 'Three'));
  const after = await settle(reloads + 1, 8000);
  assert.ok(after >= 3, `the watcher went deaf after the rename (${after} reloads for 3 writes)`);
});
