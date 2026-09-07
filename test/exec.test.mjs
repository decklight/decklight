// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/exec.mjs — the bounded exec. Four things, each the reason a caller
// could not just call execFileSync: a hang is killed and NAMED; every other
// error is rethrown exactly as it was, because probes read `.code` and
// `.status` off it; and a healthy call is just execFileSync.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runAsync, PROBE_MS, NETWORK_MS, CODEC_MS } from '../tools/exec.mjs';

const posix = process.platform !== 'win32';
const fakeBin = (t, name, body) => {
  const dir = mkdtempSync(join(tmpdir(), 'decklight-exec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, name);
  writeFileSync(p, '#!/bin/sh\n' + body + '\n');
  chmodSync(p, 0o755);
  return p;
};

test('a hang is killed at the timeout and the error names the binary, the wait and the cure', (t) => {
  if (!posix) return t.skip('a shell script stands in for the wedged tool');
  const bin = fakeBin(t, 'stuck', 'sleep 30');
  const t0 = Date.now();
  assert.throws(() => run(bin, [], { timeout: 500, why: 'restart the thing' }), (e) => {
    assert.equal(e.code, 'ETIMEDOUT');
    assert.equal(e.bin, bin);
    assert.match(e.message, /hung for 1s and was killed — restart the thing$/);
    return true;
  });
  assert.ok(Date.now() - t0 < 5000, 'the timeout did not fire');
});

test('a missing binary is ENOENT, untouched — probes depend on telling it from "present but failing"', () => {
  assert.throws(() => run('/no/such/binary-' + Date.now(), []), (e) => e.code === 'ENOENT');
});

test('a non-zero exit is rethrown with its status and stderr, untouched', (t) => {
  if (!posix) return t.skip();
  const bin = fakeBin(t, 'fails', 'echo nope >&2; exit 3');
  assert.throws(() => run(bin, [], { encoding: 'utf8' }), (e) => {
    assert.equal(e.status, 3);
    assert.match(String(e.stderr), /nope/);
    assert.notEqual(e.code, 'ETIMEDOUT', 'a failure was mistaken for a hang');
    return true;
  });
});

test('a healthy call is execFileSync — output, encoding and all', (t) => {
  if (!posix) return t.skip();
  const bin = fakeBin(t, 'ok', 'echo hello "$1"');
  assert.equal(run(bin, ['there'], { encoding: 'utf8' }), 'hello there\n');
});

test('runAsync is the same contract without blocking — a caller can serve the child it spawned', async (t) => {
  if (!posix) return t.skip();
  // The reason this exists: cli/pptx-export.mjs serves the deck from its own
  // process while Chrome renders it. With execFileSync the event loop is held
  // for the whole render, so the server never answers and the browser waits
  // for a first byte until the timeout kills it. This asserts the property
  // that fixes it — a timer fires WHILE the child runs — rather than only the
  // return value, because the return value was never the problem.
  const bin = fakeBin(t, 'slow', 'sleep 0.4; echo done');
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 100);
  const out = await runAsync(bin, [], { encoding: 'utf8', timeout: 5000 });
  clearTimeout(timer);
  assert.equal(String(out), 'done\n');
  assert.ok(ticked, 'the event loop was blocked for the child — this is the deadlock runAsync exists to avoid');
});

test('runAsync names a hang the same way run does, and rethrows everything else untouched', async (t) => {
  if (!posix) return t.skip();
  const stuck = fakeBin(t, 'stuck', 'sleep 30');
  await assert.rejects(() => runAsync(stuck, [], { timeout: 500, why: 'restart the thing' }), (e) => {
    assert.equal(e.code, 'ETIMEDOUT');
    assert.equal(e.bin, stuck);
    assert.match(e.message, /hung for 1s and was killed — restart the thing$/);
    return true;
  });
  await assert.rejects(() => runAsync('/no/such/binary-' + Date.now(), []), (e) => e.code === 'ENOENT');
  const fails = fakeBin(t, 'fails', 'echo nope >&2; exit 3');
  await assert.rejects(() => runAsync(fails, [], { encoding: 'utf8' }), (e) => {
    assert.equal(e.code, 3, 'execFile reports the exit status as .code');
    assert.match(String(e.stderr), /nope/);
    return true;
  });
});

test('the budgets are named for what they are, and ordered that way', () => {
  assert.ok(PROBE_MS < NETWORK_MS && NETWORK_MS < CODEC_MS);
  assert.ok(PROBE_MS >= 5_000, 'a probe budget so short it fails on a busy machine is a flake');
});
