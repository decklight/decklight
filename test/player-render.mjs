#!/usr/bin/env node
/**
 * Headless verification of the terminal player (test/player.html drives a
 * mock Decklight; this script renders it in Chrome and checks the emitted
 * DECKLIGHT-PLAYER-RESULTS JSON).
 *
 * file:// + ES modules + fetch() need --allow-file-access-from-files.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, 'player.html');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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
