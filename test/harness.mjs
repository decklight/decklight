// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What the four render harnesses each hand-rolled: launch a headless Chrome,
// dump the DOM, and pull the results out of it. Chrome discovery already lives
// in tools/chrome.mjs; this is the layer above it — the dump, and the
// DECKLIGHT-<NAME>-RESULTS marker every self-verifying harness page emits.

import { execFileSync } from 'node:child_process';
import { chromeBin, chromeArgs } from '../tools/chrome.mjs';

/**
 * Render a file:// URL headless and return the dumped DOM. Budgets, buffer
 * sizes and the file-access / autoplay flags differ per harness, so they are
 * options; `quietStderr` drops a headless Chrome's D-Bus/UPower noise on a
 * machine that has neither.
 */
export function dumpDom(url, {
  budget = 5000, fileAccess = false, maxBuffer = 32 * 1024 * 1024,
  quietStderr = false, extraFlags = [], who = 'render',
} = {}) {
  return execFileSync(chromeBin(who), chromeArgs(
    ...(fileAccess ? ['--allow-file-access-from-files'] : []),
    ...extraFlags,
    `--virtual-time-budget=${budget}`,
    '--dump-dom', url,
  ), { encoding: 'utf8', maxBuffer, ...(quietStderr ? { stdio: ['ignore', 'pipe', 'ignore'] } : {}) });
}

/** Pull the `DECKLIGHT-<NAME>-RESULTS {json}` object a harness page emits. */
export function resultsFrom(html, name, ctx = '') {
  const m = html.match(new RegExp(`DECKLIGHT-${name}-RESULTS (\\{[\\s\\S]*?\\})\\s*<`));
  if (!m) {
    console.error(`${name.toLowerCase()}-render: no results marker found in rendered DOM${ctx ? ` (${ctx})` : ''}`);
    process.exit(1);
  }
  return JSON.parse(m[1]);
}

/**
 * The whole shape of a PASS/FAIL page harness: render it, parse its results,
 * log them, and exit non-zero unless it reported PASS. (player and character
 * are exactly this; narration and render do their own per-result reporting.)
 */
export function runResultsPage(page, name, opts = {}) {
  const label = `${name.toLowerCase()}-render`;
  const results = resultsFrom(dumpDom(`file://${page}`, { fileAccess: true, budget: 60000, who: label, ...opts }), name);
  console.log(`${label} results:`, JSON.stringify(results, null, 2));
  if (results.PASS !== true) { console.error(`${label}: FAILED`); process.exit(1); }
  console.log(`${label}: PASS`);
}
