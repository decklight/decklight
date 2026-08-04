#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `EXTENSIONS#CHECK`'s headless-load phase, in a real browser — the one
 * thing the unit tests (test/extension-check.test.mjs) cannot prove, because
 * they deliberately never touch Chrome (the npm test / npm run verify split
 * test/pdf.test.mjs already documents).
 *
 * Three cases:
 *   clean     — a clean transform passes end to end.
 *   smuggled  — a transform whose OUTPUT carries an (inert) <script> block,
 *               past the source lint — the lint only reads the transform's
 *               OWN source text, never what it prints — is still refused,
 *               because the headless load inspects the rendered RESULT.
 *   blocking  — a transform whose OUTPUT calls alert() synchronously used to
 *               hang the check forever: --virtual-time-budget bounds
 *               Chrome's own clock, not a native dialog blocking the render
 *               loop outside it. Proves the 15s wall-clock kill actually
 *               fires, and that the whole check still returns in bounded
 *               real time rather than hanging whatever runs it.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkExtension } from '../tools/extension-check.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'decklight-extension-check-render-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

function transform(name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return file;
}

const CLEAN = transform('clean.mjs',
  'export default async function transform(html) { return html.replace("<h2>", "<h2>[checked] "); }\n');

const SMUGGLES_SCRIPT = transform('smuggles-script.mjs',
  'export default async function transform(html) { return html + \'<script>1;</script>\'; }\n');

const SMUGGLES_BLOCKING_SCRIPT = transform('smuggles-blocking-script.mjs',
  'export default async function transform(html) { return html + \'<script>alert("bad")</script>\'; }\n');

const before = Date.now();
const results = {
  clean: await checkExtension(CLEAN),
  smuggled: await checkExtension(SMUGGLES_SCRIPT),
  blocking: await checkExtension(SMUGGLES_BLOCKING_SCRIPT),
};
const elapsedMs = Date.now() - before;

const checks = [
  ['a clean transform passes the headless load', results.clean.ok === true],
  ['a passing check emits the digest its catalog entry pins (SPEC UNIT_PINNING)',
    /^[0-9a-f]{64}$/.test(results.clean.sha256 ?? '')],
  ['a transform whose OUTPUT carries a <script> is refused, at the output phase — not the lint',
    results.smuggled.ok === false && results.smuggled.phase === 'output'],
  ['a transform whose OUTPUT blocks the page (alert()) is refused rather than hanging the check',
    results.blocking.ok === false && results.blocking.phase === 'output'],
  ['all three checks together finished well within the 15s-per-load safety kill',
    elapsedMs < 45_000],
];

console.log('extension-check-render results:', JSON.stringify({ ...results, elapsedMs }, null, 2));
let failed = 0;
for (const [what, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(`\nextension-check-render: ${failed} of ${checks.length} FAILED`);
  process.exit(1);
}
console.log(`\nextension-check-render: PASS — ${checks.length} checks`);
