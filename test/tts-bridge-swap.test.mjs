// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The bridge changing which engine it speaks with, live (SPEC PRESENTING).
//
// Every assertion here runs against a REAL bridge process, because what is
// being tested is state that survives a request: the engine, and everything
// derived from it. A swap that updated the engine but left the roster, the
// `stylable` flag or the installed-voice id map behind would pass any unit test
// of the swap function and then offer the presenter voices the new engine
// cannot say.
//
// No network is touched. `chirp` and `gemini` both CONSTRUCT against a project
// id without calling anything — which is exactly the property that makes them
// dangerous in production (they fail on the first sentence, not at startup) and
// convenient here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmTemp, stop } from './helpers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli/decklight.mjs');
const PROJECT = 'decklight-test-project';

async function startBridge(t, { engine = 'chirp', env = {} } = {}) {
  // Every bridge in the suite gets its own cache home. The disk cache now
  // covers every engine, so a bridge started without one writes into the
  // developer's real ~/.cache and reads back from it on the next run.
  const cache = mkdtempSync(path.join(tmpdir(), 'dl-swap-cache-'));
  t.after(() => rmTemp(cache));
  const child = spawn(process.execPath, [CLI, 'tts', '--port', '0', '--engine', engine], {
    env: { ...process.env, GOOGLE_CLOUD_PROJECT: PROJECT, XDG_CACHE_HOME: cache, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stop(child));
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); }
    }, 25);
    child.on('exit', () => { clearInterval(scan); reject(new Error(`tts exited early:\n${out}`)); });
    setTimeout(() => { clearInterval(scan); reject(new Error(`timeout waiting for the bridge:\n${out}`)); }, 15000);
  });
  return { base, log: () => out };
}

const swap = (base, engine) => fetch(`${base}/engine`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ engine }),
});
const ping = async (base) => (await fetch(`${base}/ping`)).json();

test('/engines lists every engine and marks the live one', async (t) => {
  const { base } = await startBridge(t);
  const j = await (await fetch(`${base}/engines`)).json();
  assert.equal(j.ok, true);
  assert.equal(j.engine, 'chirp');
  const names = j.engines.map((e) => e.name);
  for (const n of ['piper', 'chirp', 'gemini', 'elevenlabs']) assert.ok(names.includes(n), n);
  const cur = j.engines.filter((e) => e.current);
  assert.equal(cur.length, 1, 'exactly one engine is speaking');
  assert.equal(cur[0].name, 'chirp');
  assert.equal(cur[0].ready, true, 'the engine that is SPEAKING was listed as unavailable');
});

test('a swap moves the roster, the model and the style channel together', async (t) => {
  // The reason this is an integration test. chirp and gemini share a voice
  // roster but not a model and not `stylable` — and `stylable` is what decides
  // whether the picker offers a tone step at all, so a swap that left it stale
  // would show a delivery-instruction screen for an engine that ignores it.
  const { base } = await startBridge(t, { engine: 'chirp' });
  const before = await ping(base);
  assert.equal(before.engine, 'chirp');
  assert.equal(before.stylable, false);

  const r = await swap(base, 'gemini');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.changed, true);
  assert.equal(j.engine, 'gemini');
  assert.equal(j.stylable, true);
  assert.ok(j.voices.length, 'a swap answers with the new roster, so the picker need not re-ask');

  // and the bridge really changed, not just the reply
  const after = await ping(base);
  assert.equal(after.engine, 'gemini');
  assert.equal(after.stylable, true);
  assert.notEqual(after.model, before.model);
});

test('swapping to the engine already speaking is a no-op, not an error', async (t) => {
  const { base } = await startBridge(t, { engine: 'chirp' });
  const j = await (await swap(base, 'chirp')).json();
  assert.equal(j.ok, true);
  assert.equal(j.changed, false);
  assert.equal(j.engine, 'chirp');
});

test('an engine this machine cannot use is refused WITH its reason', async (t) => {
  // 409, not 500: this is a state the deck can render, and the row it draws
  // needs the reason and the fix — a bare failure would leave the presenter
  // with a picker that does nothing when clicked.
  const { base } = await startBridge(t, { engine: 'chirp', env: { ELEVENLABS_API_KEY: '' } });
  const r = await swap(base, 'elevenlabs');
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.reason, 'no-key');
  assert.match(j.why, /ELEVENLABS_API_KEY/);
  assert.ok(j.fix, 'a blocker with no way out');
  // and the bridge is untouched — a refused swap must not leave it half-way
  assert.equal((await ping(base)).engine, 'chirp');
});

test('the check runs BEFORE the engine is built', async (t) => {
  // The whole safety argument, and piper is the clearest case of it:
  // `createEngine('piper')` succeeds on a machine with no piper at all — it
  // returns a perfectly-shaped engine whose synth spawns a binary that is not
  // there. Nothing about building it says no. Only the machine probe does, and
  // it has to happen first, because the alternative is a bridge that looks
  // healthy until the first sentence — which mid-talk is a keypress into
  // silence. (The cloud engines have the same shape: a project id nobody
  // validated builds fine and 403s later. Covered as a unit in
  // test/tts-engine-pick.test.mjs, where the project can be varied without
  // restarting a process.)
  const { base } = await startBridge(t, { engine: 'chirp', env: { PATH: '' } });
  const r = await swap(base, 'piper');
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.ok(['no-binary', 'no-model'].includes(j.reason), `unexpected reason ${j.reason}`);
  assert.ok(j.why, 'no reason to show');
  assert.ok(j.fix, 'no way out to show');
  assert.equal((await ping(base)).engine, 'chirp');
});

test('a name that is neither built in nor installed is refused, and says so', async (t) => {
  const { base } = await startBridge(t);
  const r = await swap(base, 'not-a-real-engine');
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.match(j.error, /not-a-real-engine/);
  assert.equal((await ping(base)).engine, 'chirp');
});

test('a request with no engine named is a 400, not a crash', async (t) => {
  const { base } = await startBridge(t);
  for (const body of ['{}', 'not json', '{"engine":42}', '{"engine":""}']) {
    const r = await fetch(`${base}/engine`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(r.status, 400, body);
  }
  assert.equal((await ping(base)).engine, 'chirp');
});

test('a swap round trip leaves the bridge exactly where it started', async (t) => {
  const { base } = await startBridge(t, { engine: 'chirp' });
  const start = await ping(base);
  await swap(base, 'gemini');
  await swap(base, 'chirp');
  const end = await ping(base);
  assert.equal(end.engine, start.engine);
  assert.equal(end.model, start.model);
  assert.equal(end.stylable, start.stylable);
  assert.deepEqual(end.voices, start.voices);
});
