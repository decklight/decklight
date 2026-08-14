#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Run every render/lint harness and report ALL of them.
 *
 * `verify` used to be a shell `&&` chain, which meant the first harness to
 * fail hid the six behind it — including engine-render, the overlay safety
 * net. That is exactly backwards for a verification step: the moment it has
 * something to tell you is the moment it stops telling you the rest, and one
 * environment-specific failure (a headless Chrome that will not autoplay
 * video, say) makes a whole suite look like it ran when it never started.
 *
 * So: run them all, print a summary naming each, and exit non-zero if any
 * failed. Same coverage, same exit code, no silence.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every harness runs against a config home of its OWN.
 *
 * Four of them spawn the CLI, and a command reads the unit library from the
 * config home: `import` resolves its adapter for a `.pptx` from there, and
 * `present` would load the plugin library. On an ephemeral CI runner that home
 * is empty and none of this mattered — which is exactly why it went unnoticed
 * until `verify` ran on a real Mac (#309), where the home belongs to a person
 * and holds their marketplaces, plugins and credentials.
 *
 * A verification step whose result depends on what the developer running it
 * happens to have installed is not verifying the thing it names. So: one
 * scratch home for the run, inherited by every harness, removed afterwards.
 */
const HOME = mkdtempSync(path.join(tmpdir(), 'decklight-verify-home-'));
const env = { ...process.env, DECKLIGHT_HOME: HOME };

const HARNESSES = [
  'render',
  'player-render',
  'narration-render',
  'character-render',
  'engine-render',
  'pin-render',
  'overflow-render',
  'split-render',
  'strict-render',
  'shot-render',
  'plugin-render',
  'extension-check-render',
  'deckfile-render',
  'pdf-render',
  'import-render',
  'contrast',
  'palette-rules',
];

/**
 * A harness that HANGS must name itself.
 *
 * The first attempt to run this on a macOS runner (#309) died to the job's own
 * 30-minute limit, and a cancelled job's logs are unrecoverable — so the run
 * said only that `npm run verify` had not finished, with no way to tell a slow
 * harness from a stuck one. That is the `--test-timeout` lesson from the
 * Windows unit job, one directory over. Ten minutes is far above the slowest
 * legitimate harness (pdf-render, ~9s here) and far below any job limit.
 */
const HARNESS_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS ?? 10 * 60 * 1000);

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const results = [];
for (const name of HARNESSES) {
  process.stdout.write(`\n─── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}\n`);
  const at = Date.now();
  const res = spawnSync(process.execPath, [path.join(here, `${name}.mjs`)],
    { stdio: 'inherit', timeout: HARNESS_TIMEOUT_MS, env });
  const ms = Date.now() - at;
  const timedOut = res.error?.code === 'ETIMEDOUT';
  if (timedOut) process.stdout.write(`\n${name}: KILLED after ${secs(ms)} — it never finished\n`);
  results.push({ name, ok: res.status === 0 && !timedOut, ms, timedOut });
}

rmSync(HOME, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n─── verify ${'─'.repeat(56)}\n`);
// The timings are the report, not decoration: this suite runs on machines
// nobody can attach to, and "which harness costs the time" is otherwise a
// question only a cancelled log could have answered.
for (const { name, ok, ms, timedOut } of results) {
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(22)} ${secs(ms).padStart(7)}`
    + `${timedOut ? '  (timed out)' : ''}\n`);
}
process.stdout.write(`     ${'total'.padEnd(22)} ${secs(results.reduce((a, r) => a + r.ms, 0)).padStart(7)}\n`);

if (failed.length) {
  process.stdout.write(`\nverify: ${failed.length} of ${results.length} harnesses FAILED — ${failed.map((f) => f.name).join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`\nverify: all ${results.length} harnesses passed\n`);
