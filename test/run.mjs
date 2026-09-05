#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `npm test` — the unit suite, found without a shell.
 *
 * It used to be `node --test test/*.test.mjs`, and that glob is expanded by the
 * SHELL. npm runs scripts through cmd/pwsh on Windows, neither of which globs,
 * so node was handed the literal string:
 *
 *     Could not find 'D:\a\decklight\decklight\test\*.test.mjs'
 *
 * Not one test failed there, because not one test ran — `npm test` exited 1
 * before the suite started, on every Windows machine, for as long as the script
 * has existed. The first Windows CI job found it in its first run.
 *
 * `node --test test/` would be worse, not better: node treats EVERY `.mjs`
 * under a directory named `test` as a test file, which sweeps in the render
 * harnesses, verify.mjs, and — the reason this is not a hypothetical — soak.mjs,
 * a script whose import packs this repo and npm-installs it.
 *
 * So the list is built here, explicitly, from the one pattern that has always
 * defined this suite: `test/*.test.mjs`, top level only.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

if (!files.length) {
  console.error('test/run.mjs: no test/*.test.mjs found — that is a broken checkout, not an empty suite');
  process.exit(1);
}

// Forwarded flags go BEFORE the file list. Node reads what follows `--test` as
// test files, and only some versions still recognise an option among them:
// `npm test -- --test-timeout=120000` worked on Node 26 and became
// `Could not find 'D:\a\decklight\decklight\--test-timeout=120000'` on the
// Node 20 this project promises in `engines`.
// Two batches, not one. `node --test` runs every file in parallel, and six of
// these boot a real TTS bridge or call the real `say`. macOS's speech server
// (speechsynthesisd) deadlocks under concurrent `say` — a child with no CPU
// and no output, which hung the suite for eight minutes before #431 made it a
// sixty-second failure. A failure is still a flake. So the files that touch
// the synthesizer run AFTER the rest, one at a time: ~15s more, and the only
// nondeterminism in the suite is gone.
const SERIAL = new Set([
  'tts-cache.test.mjs', 'native-voice.test.mjs', 'local-voice.test.mjs',
  'tts-setup.test.mjs', 'engine-units.test.mjs', 'tts-bridge-swap.test.mjs',
]);
const flags = process.argv.slice(2);
const batch = (list, extra = []) => spawnSync(
  process.execPath,
  ['--test', ...flags, ...extra, ...list.map((f) => join('test', f))],
  { stdio: 'inherit', cwd: join(here, '..') },
).status ?? 1;

const parallel = files.filter((f) => !SERIAL.has(f));
const serial = files.filter((f) => SERIAL.has(f));
const a = batch(parallel);
const b = serial.length ? batch(serial, ['--test-concurrency=1']) : 0;
process.exit(a || b);
