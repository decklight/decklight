#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Narration auto-advance, and what a failing voice bridge does to it.
 *
 * The voice is the clock: the deck advances when a segment finishes speaking.
 * So when the voice CANNOT be played, the deck must stop — advancing in silence
 * would walk the talk past slides nobody has heard — and it must say why, where
 * the presenter is actually looking.
 *
 * Three runs of test/narration.html (audio and bridge both mocked in-page):
 *   healthy — every sentence synthesizes: the deck walks itself to the last slide
 *   flaky   — the first sentence 429s: the deck HOLDS on slide 1, shows a message
 *             explaining it, and keeps that message in the log (I)
 *   dead    — every sentence 429s: same, and it never races ahead
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, 'narration.html');

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  `${process.env.HOME}/.nix-profile/bin/chromium`,
];
const CHROME = process.env.CHROME || process.env.DECKLIGHT_CHROME
  || CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error('narration-render: no Chrome found — install one, or point $CHROME at it');
  process.exit(1);
}

function run(mode) {
  const html = execFileSync(CHROME, [
    '--headless', '--disable-gpu',
    '--allow-file-access-from-files',
    '--virtual-time-budget=30000',
    '--dump-dom', `file://${page}?mode=${mode}`,
    // stderr is ignored: a headless Chrome on a machine with no D-Bus/UPower
    // prints pages of unrelated noise that would bury the actual result
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const m = html.match(/DECKLIGHT-NARRATION-RESULTS (\{[\s\S]*?\})\s*</);
  if (!m) throw new Error(`no results marker for mode=${mode}`);
  return JSON.parse(m[1]);
}

let bad = 0;
for (const mode of ['healthy', 'flaky', 'dead', 'keys', 'modules']) {
  const r = run(mode);
  const ok = r.PASS === true;
  if (!ok) bad++;
  if (mode === 'keys') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} play: \` opens=${r.playOpens} closes=${r.playCloses} azerty(²)=${r.azertyOpens}`
      + ` · edit: bare ignored=${r.editIgnoresBareKey} ⌃\` opens=${r.editCtrlOpens} ⌥\` opens=${r.editAltOpens}`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  if (mode === 'modules') {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} M gone=${r.noModuleMenu} · finder lists slides=${r.listsSlides}`
      + ` modules=${r.listsModules} (marked=${r.moduleRowMarked}, current hidden=${r.hidesCurrentModule})`
      + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
    continue;
  }
  const detail = mode === 'healthy'
    ? ''
    : ` · stopped=${r.stopped} explained=${r.explained} window=${r.windowUp} log=${r.logUp}`;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} slide ${r.slide}/${r.total} · ${r.ttsCalls} tts calls, ${r.failures} failed${detail}`
    + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
  if (r.lastMessage) console.log(`       message: "${r.lastMessage}"`);
}
if (bad) { console.error('narration-render: FAILED'); process.exit(1); }
console.log('narration-render: PASS');
