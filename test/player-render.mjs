#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Headless verification of the terminal player (test/player.html drives a
 * mock Decklight; this script renders it in Chrome and checks the emitted
 * DECKLIGHT-PLAYER-RESULTS JSON).
 *
 * file:// + ES modules + fetch() need --allow-file-access-from-files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, 'player.html');

// $CHROME wins; otherwise take the first browser that is actually here, so the
// harness runs on Linux/CI and not just a Mac.
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];
const CHROME = process.env.CHROME || CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error('player-render: no Chrome found — install one, or point $CHROME at it');
  process.exit(1);
}

const html = execFileSync(CHROME, [
  '--headless', '--disable-gpu',
  '--allow-file-access-from-files',
  '--virtual-time-budget=60000',
  '--dump-dom', `file://${page}`,
], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const m = html.match(/DECKLIGHT-PLAYER-RESULTS (\{[\s\S]*?\})\s*</);
if (!m) {
  console.error('player-render: no results marker found in rendered DOM');
  process.exit(1);
}
const results = JSON.parse(m[1]);
console.log('player-render results:', JSON.stringify(results, null, 2));
if (results.PASS !== true) {
  console.error('player-render: FAILED');
  process.exit(1);
}
console.log('player-render: PASS');
