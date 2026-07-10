#!/usr/bin/env node
/**
 * Headless verification of the character overlay (test/character.html drives
 * src/core/character.js with a stubbed bridge and a mock audio clock; this
 * script renders it in Chrome and checks the emitted
 * DECKLIGHT-CHARACTER-RESULTS JSON).
 *
 * file:// + ES modules + fetch() need --allow-file-access-from-files.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, 'character.html');
const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const html = execFileSync(CHROME, [
  '--headless', '--disable-gpu',
  '--allow-file-access-from-files',
  '--virtual-time-budget=60000',
  '--dump-dom', `file://${page}`,
], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

const m = html.match(/DECKLIGHT-CHARACTER-RESULTS (\{[\s\S]*?\})\s*</);
if (!m) {
  console.error('character-render: no results marker found in rendered DOM');
  process.exit(1);
}
const results = JSON.parse(m[1]);
console.log('character-render results:', JSON.stringify(results, null, 2));
if (results.PASS !== true) {
  console.error('character-render: FAILED');
  process.exit(1);
}
console.log('character-render: PASS');
