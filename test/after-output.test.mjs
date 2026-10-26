// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// afterOutput: an agent run is finalised once the agent has exited AND what
// it wrote has been read — the report is its last line, and Node's 'exit' can
// come before that line does. Bounded, because a grandchild holding the pipe
// open must not leave the run busy until its ten-minute timeout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { afterOutput } from '../cli/util.mjs';

/** Runs `src` in a child node, collecting stdout; resolves what afterOutput saw. */
function run(src, graceMs) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const t0 = Date.now();
    afterOutput(child, (code) => done({ code, out, ms: Date.now() - t0 }), graceMs);
  });
}

test('the last line written before a sudden exit is read before the run is finalised', async () => {
  // a long stream, its result line last, and an exit the instant it is
  // queued: the shape that lost the report. Many times, since it is a race.
  const src = "process.stdout.write('x'.repeat(1 << 20) + '\\n');"
    + "process.stdout.write(JSON.stringify({ type: 'result', result: 'done' }) + '\\n', () => process.exit(3));";
  for (let i = 0; i < 8; i++) {
    const r = await run(src, 5000);
    assert.equal(r.code, 3);
    assert.match(r.out.trimEnd().split('\n').pop(), /"result":"done"/, `run ${i}: the result line was lost`);
  }
});

test('a grandchild holding the pipe open does not keep the run waiting past the grace', async () => {
  // the child exits at once; a detached grandchild inherits its stdout and
  // sits on it for ten seconds
  const src = "const { spawn } = require('node:child_process');"
    + "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });"
    + "g.unref(); console.log('pid ' + g.pid); process.exit(0);";
  const r = await run(src, 300);
  try { process.kill(Number(/pid (\d+)/.exec(r.out)?.[1]), 'SIGKILL'); } catch { /* already gone */ }
  assert.equal(r.code, 0);
  assert.ok(r.ms < 5000, `finalised after ${r.ms} ms, not at the grace`);
});
