#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Headless verification of engine.js's overlay + keyboard-nav system
 * (test/engine.html drives the real bundled engine). This is the interaction
 * the DOM-only render harness can't reach — the safety net for splitting the
 * overlay / theme-picker / palette machinery out of engine.js.
 *
 * file:// + ES modules + fetch() need --allow-file-access-from-files.
 *
 * Takes a mode list on argv, defaulting to all of them, so `verify` can run it
 * as several harnesses on an ordinary budget each rather than as one that has
 * to be widened every time a mode is added. `narration-render` was split the
 * same way and for the same reason (#439).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, 'engine.html');

let bad = 0;
/** Every mode this harness drives, grouped by concern (see test/verify.mjs). */
export const MODES = [
  'themepicker', 'added', 'browse', 'nobrowse', 'wizard',
  'palette', 'exclusive', 'contextmenu', 'commit',
  'narration', 'nonarration', 'panel',
  'restore', 'hidden', 'hidden&all', 'chapters', 'chaptersplaylist',
  'exportpptx', 'exportfail', 'publish',
  'template', 'templatelook', 'sources', 'sourcesedit',
];

// A typo in a mode name would otherwise run NOTHING and exit 0, which is the
// one failure a verification step must never have.
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const unknown = only.filter((m) => !MODES.includes(m));
if (unknown.length) {
  console.error(`engine-render: no such mode(s): ${unknown.join(', ')}`);
  process.exit(2);
}
const running = only.length ? only : MODES;

const started = Date.now();
for (const mode of running) {
  const r = resultsFrom(
    dumpDom(`file://${page}?mode=${mode}`, { fileAccess: true, budget: 30000, quietStderr: true, who: 'engine-render' }),
    'ENGINE', `mode=${mode}`);
  const ok = r.PASS === true;
  if (!ok) bad++;
  const flags = Object.entries(r)
    .filter(([k, v]) => typeof v === 'boolean')
    .map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${mode.padEnd(11)} ${flags}${r.exception ? ` · ${r.exception.split('\n')[0]}` : ''}`);
}
console.log(`\nengine-render: ${running.length} mode(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
if (bad) { console.error('engine-render: FAILED'); process.exit(1); }
console.log('engine-render: PASS');
