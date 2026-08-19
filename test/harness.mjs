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
/**
 * The wall clock every dump gets, unless a caller asks for a tighter one.
 *
 * `--virtual-time-budget` is not a timeout. It bounds Chrome's own clock, and a
 * page that leaves work pending never drains it — so the child sits there with
 * no output and no exit, forever. That is not hypothetical: it is #323, where
 * `narration-render` normally takes ~73s on a Windows runner and once ran past
 * the 180s `verify` kills at. Every other harness in that run was fine and the
 * log said only that this one had been killed, because a stuck child looks
 * exactly like a slow one from outside.
 *
 * Two minutes is ~100x the slowest legitimate dump here (they finish in under a
 * second; a cold Chrome on Windows takes a few) and far under any harness
 * budget, so this can only ever convert a HANG into a named failure. It cannot
 * make a passing run fail.
 */
export const WALL_CLOCK_MS = Number(process.env.DUMP_TIMEOUT_MS ?? 120_000);

/** True when `err` is a child this module killed for running too long. */
export const timedOut = (err) => !!err
  && (err.killed === true || err.signal === 'SIGKILL' || err.code === 'ETIMEDOUT');

export function dumpDom(url, {
  budget = 5000, fileAccess = false, maxBuffer = 32 * 1024 * 1024,
  quietStderr = false, extraFlags = [], who = 'render', timeout = WALL_CLOCK_MS,
} = {}) {
  return execFileSync(chromeBin(who), chromeArgs(
    ...(fileAccess ? ['--allow-file-access-from-files'] : []),
    ...extraFlags,
    `--virtual-time-budget=${budget}`,
    '--dump-dom', url,
  ), {
    encoding: 'utf8',
    maxBuffer,
    // `--virtual-time-budget` bounds Chrome's own clock, not the real one: a
    // page whose virtual time never drains hangs the dump forever, with no
    // output and no exit. So every dump now carries a wall clock (see
    // WALL_CLOCK_MS) and a caller may tighten it — the same belt-and-braces
    // tools/extension-check.mjs already wears, made the default because the
    // harness that did not have it is the one that hung (#323).
    //
    // The way to drain a virtual clock is to leave no fetch pending, and one
    // page in this project cannot: a deck served by `decklight present` opens
    // an EventSource on /present/events for the phone remote (PRESENT#REMOTE),
    // which by design never ends. Dump such a deck from file:// — or from a
    // server that does not answer /present/ping — and it settles in ~2s.
    ...(timeout ? { timeout, killSignal: 'SIGKILL' } : {}),
    ...(quietStderr ? { stdio: ['ignore', 'pipe', 'ignore'] } : {}),
  });
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
