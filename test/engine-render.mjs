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
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, 'engine.html');

let bad = 0;
for (const mode of ['themepicker', 'palette', 'exclusive']) {
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
if (bad) { console.error('engine-render: FAILED'); process.exit(1); }
console.log('engine-render: PASS');
