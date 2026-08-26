// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The bridge's disk cache: a local engine's synthesis costs a machine ONCE.
//
// Warming 184 say previews took ~6 minutes of background synthesis — and
// again on every bridge restart, because the response cache lived in the
// process. A voice's identity (its name — exactly what `say -v` selects by)
// is stable per machine and the audio is deterministic there, so say/sapi/
// piper responses persist under $XDG_CACHE_HOME/decklight/tts and a NEW
// bridge answers from disk. Cloud engines stay memory-only: their output
// drifts with server models, and a stale clip that sounds unlike today's
// voice is worse than re-billing one preview sentence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTemp } from './helpers.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/decklight.mjs');

function startBridge(t, env) {
  const child = spawn(process.execPath, [CLI, 'tts', '--port', '0', '--engine', 'say'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  return new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = log.match(/tts bridge on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(scan); resolve({ child, port: Number(m[1]), log: () => log }); }
    }, 25);
    child.on('exit', () => { clearInterval(scan); reject(new Error('bridge exited early:\n' + log)); });
    setTimeout(() => { clearInterval(scan); reject(new Error('no bridge URL:\n' + log)); }, 20000);
  });
}

test('a say synthesis survives the bridge — the SECOND bridge answers from disk', async (t) => {
  if (process.platform !== 'darwin') { t.skip('say is macOS — the sapi/piper paths share the code'); return; }

  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-ttscache-'));
  t.after(() => rmTemp(cacheHome));
  const env = { XDG_CACHE_HOME: cacheHome };
  const say = async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Cache check.', voice: 'Samantha' }),
    });
    assert.equal(r.status, 200);
    return (await r.arrayBuffer()).byteLength;
  };

  // first bridge: a real synthesis, and the wav lands in the cache dir
  const a = await startBridge(t, env);
  const bytes1 = await say(a.port);
  assert.ok(bytes1 > 44, 'no audio came back');
  const dir = path.join(cacheHome, 'decklight', 'tts');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav'));
  assert.equal(files.length, 1, 'the synthesis was not written to the disk cache');
  a.child.kill('SIGTERM');
  await new Promise((ok) => a.child.on('exit', ok));

  // second bridge, same machine: the identical request is a DISK hit — no
  // synthesis, the same bytes, and the log says where they came from
  const b = await startBridge(t, env);
  const bytes2 = await say(b.port);
  assert.equal(bytes2, bytes1, 'the cached clip is not the clip that was cached');
  assert.match(b.log(), /cached on disk/, 'the second bridge synthesized instead of reading the cache');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).length, 1, 'a duplicate landed');
});
