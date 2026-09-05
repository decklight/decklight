// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// An installed speech engine, end to end (SPEC ENGINE_UNITS, #267): a module
// decklight ships no code for, registered in a marketplace, installed into
// the unit library, and then actually SPOKEN with by the real `decklight tts`
// bridge on an ephemeral port.
//
// The bridge had never been covered by a test before this one, and the gap
// showed: every one of the six built-in engines happens to report a `cost` in
// its usage record, so the accounting read `usage.cost.toFixed()` unguarded.
// The first third-party engine that metered differently took the sentence
// down mid-talk with a TypeError — which is exactly the failure this ticket
// exists to make impossible, so it is pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rmTemp, tmp } from './helpers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * An engine whose usage record carries NO `cost` — the shape a metered or
 * free third-party engine legitimately returns, and the one the bridge used
 * to crash on.
 */
const NO_COST_ENGINE = `export default function createEngine(opts) {
  return {
    name: 'azure-tts',
    model: opts.model ?? 'neural',
    stylable: true,
    voices: [['Aria', 'neural'], ['Guy', 'neural']],
    synth: async (text) => ({
      wav: Buffer.from('RIFF0000WAVEfmt '),
      usage: { chars: text.length, note: text.length + ' chars via Azure' },
    }),
  };
}
`;

/** Register a marketplace carrying one engine, and install it. */
function installEngine(home, body = NO_COST_ENGINE) {
  const market = tmp('engine-e2e-market');
  mkdirSync(path.join(market, '.decklight'), { recursive: true });
  mkdirSync(path.join(market, 'engines'), { recursive: true });
  writeFileSync(path.join(market, 'engines/azure.mjs'), body);
  writeFileSync(path.join(market, '.decklight/marketplace.json'), JSON.stringify({
    name: 'voices',
    entries: [{
      name: 'azure-tts', type: 'engine', source: 'engines/azure.mjs',
      apiVersion: 1, capability: 'tts', sha256: sha256(body),
    }],
  }, null, 2));
  const env = { ...process.env, DECKLIGHT_HOME: home };
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', market], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync(process.execPath, [CLI, 'engine', 'add', 'azure-tts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return market;
}

/** Start the real bridge on an ephemeral port; resolve once it prints its URL. */
async function startBridge(t, home, engine = 'azure-tts') {
  const child = spawn(process.execPath, [CLI, 'tts', '--engine', engine, '--port', '0'], {
    // XDG_CACHE_HOME with the rest: the bridge caches every engine's synthesis
    // on disk now, so without this a second run of this file answers from the
    // developer's real ~/.cache and asserts on 'cached on disk' instead of the
    // engine's own usage note — a suite that passes once and then never again.
    env: { ...process.env, DECKLIGHT_HOME: home, XDG_CACHE_HOME: path.join(home, 'cache') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); }
    }, 25);
    child.on('exit', () => { clearInterval(scan); reject(new Error(`tts exited early:\n${out}`)); });
    setTimeout(() => { clearInterval(scan); reject(new Error(`timeout waiting for tts:\n${out}`)); }, 15000);
  });
  return { base, log: () => out };
}

test('the bridge speaks with an INSTALLED engine — /ping reports it like any built-in', async (t) => {
  const home = tmp('engine-e2e-home');
  try {
    installEngine(home);
    const { base, log } = await startBridge(t, home);
    assert.match(log(), /azure-tts/, 'the startup line names the installed engine');

    const ping = await (await fetch(`${base}/ping`)).json();
    assert.equal(ping.ok, true);
    assert.equal(ping.engine, 'azure-tts');
    assert.equal(ping.model, 'neural');
    // the player decides whether to show the tone step from this alone, so an
    // installed engine reaches that affordance exactly as a built-in does
    assert.equal(ping.stylable, true);
    assert.deepEqual(ping.voices, [['Aria', 'neural'], ['Guy', 'neural']]);
  } finally { rmTemp(home); }
});

test('an engine that quotes no price synthesizes fine, and no $0.0000 is invented', async (t) => {
  const home = tmp('engine-e2e-cost');
  try {
    installEngine(home);
    const { base, log } = await startBridge(t, home);
    const res = await fetch(`${base}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello from a marketplace engine.', voice: 'Aria' }),
    });
    // read the body ONCE — a `await res.text()` in the assertion message
    // consumes it eagerly, before the bytes can be checked
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(res.status, 200, body.toString('utf8').slice(0, 200));
    assert.equal(body.byteLength, 16, 'the engine\'s own audio comes back');
    assert.equal(res.headers.get('x-tts-tokens'), '32 chars via Azure');
    // characters, not a fabricated dollar figure — the same honesty the
    // ElevenLabs path already keeps (SPEC PRESENTING)
    assert.match(log(), /32 chars this session/);
    assert.doesNotMatch(log(), /\$0\.0000/);
  } finally { rmTemp(home); }
});

test('a name that is neither built in nor installed names both ways out', async () => {
  const home = tmp('engine-e2e-unknown');
  try {
    const r = execFileSync(process.execPath, [CLI, 'tts', '--engine', 'nope', '--port', '0'], {
      env: { ...process.env, DECKLIGHT_HOME: home }, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    assert.fail(`expected a refusal, got: ${r}`);
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    assert.match(out, /no engine "nope" installed/);
    assert.match(out, /decklight engine add nope/);
  } finally { rmTemp(home); }
});
