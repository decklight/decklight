#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `EXTENSIONS#CHECK`'s headless-load phase, in a real browser — the one
 * thing the unit tests (test/extension-check.test.mjs) cannot prove, because
 * they deliberately never touch Chrome (the npm test / npm run verify split
 * test/pdf.test.mjs already documents).
 *
 * Five cases:
 *   clean      — a clean transform passes end to end.
 *   smuggled   — a transform whose OUTPUT carries an (inert) <script> block,
 *                past the source lint — the lint only reads the transform's
 *                OWN source text, never what it prints — is still refused,
 *                because the headless load inspects the rendered RESULT.
 *   handler    — a transform whose OUTPUT carries no <script> at all, just an
 *                inline on…= handler: exactly as executable, once missed by
 *                the <script>-only grep. Refused at the output phase.
 *   recognizer — a transform that behaves only when it sees the fixture the
 *                checker used to always present (title "fixture"), injecting
 *                into anything else. The randomised fixture makes it misfire
 *                during the check itself, so it is refused — where the old
 *                fixed fixture let it through.
 *   blocking   — a transform whose OUTPUT calls alert() synchronously used to
 *                hang the check forever: --virtual-time-budget bounds
 *                Chrome's own clock, not a native dialog blocking the render
 *                loop outside it. Proves the 15s wall-clock kill actually
 *                fires, and that the whole check still returns in bounded
 *                real time rather than hanging whatever runs it.
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

const SMUGGLES_HANDLER = transform('smuggles-handler.mjs',
  'export default async function transform(html) { return html.replace(\'<section>\', \'<section onclick="alert(1)">\'); }\n');

const RECOGNIZES_FIXTURE = transform('recognizes-fixture.mjs',
  'export default async function transform(html) {\n'
  + '  if (html.includes(\'<title>fixture</title>\')) return html; // behave for the checker of old\n'
  + '  return html + \'<script>1;</script>\';\n'
  + '}\n');

const SMUGGLES_BLOCKING_SCRIPT = transform('smuggles-blocking-script.mjs',
  'export default async function transform(html) { return html + \'<script>alert("bad")</script>\'; }\n');

const before = Date.now();
const results = {
  clean: await checkExtension(CLEAN),
  smuggled: await checkExtension(SMUGGLES_SCRIPT),
  handler: await checkExtension(SMUGGLES_HANDLER),
  recognizer: await checkExtension(RECOGNIZES_FIXTURE),
  blocking: await checkExtension(SMUGGLES_BLOCKING_SCRIPT),
};
const elapsedMs = Date.now() - before;

const checks = [
  ['a clean transform passes the headless load', results.clean.ok === true],
  ['a passing check emits the digest its catalog entry pins (SPEC UNIT_PINNING)',
    /^[0-9a-f]{64}$/.test(results.clean.sha256 ?? '')],
  ['a transform whose OUTPUT carries a <script> is refused, at the output phase — not the lint',
    results.smuggled.ok === false && results.smuggled.phase === 'output'],
  ['a transform whose OUTPUT carries an inline on…= handler (no <script> anywhere) is refused too',
    results.handler.ok === false && results.handler.phase === 'output'
    && /inline event handler/.test(results.handler.error)],
  ['a transform that special-cases the old fixed fixture misfires on the randomised one and is refused',
    results.recognizer.ok === false && results.recognizer.phase === 'output'],
  ['a transform whose OUTPUT blocks the page (alert()) is refused rather than hanging the check',
    results.blocking.ok === false && results.blocking.phase === 'output'],
  ['all five checks together finished well within the per-execution safety kills',
    elapsedMs < 90_000],
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
