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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const HARNESSES = [
  'render',
  'player-render',
  'narration-render',
  'character-render',
  'engine-render',
  'pdf-render',
  'contrast',
  'palette-rules',
];

const results = [];
for (const name of HARNESSES) {
  process.stdout.write(`\n─── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}\n`);
  const res = spawnSync(process.execPath, [path.join(here, `${name}.mjs`)], { stdio: 'inherit' });
  results.push({ name, ok: res.status === 0 });
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n─── verify ${'─'.repeat(56)}\n`);
for (const { name, ok } of results) process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}\n`);

if (failed.length) {
  process.stdout.write(`\nverify: ${failed.length} of ${results.length} harnesses FAILED — ${failed.map((f) => f.name).join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`\nverify: all ${results.length} harnesses passed\n`);
