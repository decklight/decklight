#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The render tools' file-access protection (#229), measured in a real browser.
 *
 * `tools/shot.mjs` and `tools/video.mjs` used to open a deck over file:// with
 * `--allow-file-access-from-files` — which let the deck's OWN JavaScript read
 * any local file it could name (.git/config, tokens, keys) over a file:// XHR
 * and exfiltrate it. That path runs on decks nobody vetted: a repro deck off an
 * issue (`.github/workflows/bug-repro.yml`), or one a user screenshots before
 * presenting it. The fix serves the deck over http://127.0.0.1 under the
 * `present` CSP instead (serveForRender), where an http origin cannot touch
 * file:// at all.
 *
 * A string test ("shot no longer passes the flag") would not prove the deck is
 * actually contained — only a browser can. So this renders the SAME hostile
 * deck two ways and compares what the browser let it read:
 *   vuln    file:// + --allow-file-access-from-files  — the old path
 *   fixed   http://127.0.0.1 via serveForRender       — the new path
 *
 * The deck tries to fetch a secret file OUTSIDE the served tree. `vuln` MUST
 * leak it (otherwise the danger is not real and this test proves nothing) and
 * `fixed` MUST NOT (otherwise the fix does not fix it). If either flips, the
 * change regressed. The CSP header is asserted on the served response too — the
 * "CSP for free" half of the fix.
 *
 * NOTE: the fixed path drives Chrome with an ASYNC execFile, never dumpDom's
 * execFileSync. serveForRender's server is in-process; a synchronous child
 * blocks the event loop and the server would never answer the browser.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromeBin, chromeArgs } from '../tools/chrome.mjs';
import { dumpDom, resultsFrom } from './harness.mjs';
import { serveForRender, CSP } from '../cli/present.mjs';

const run = promisify(execFile);
const SECRET = 'TOPSECRET-229';

const base = mkdtempSync(join(tmpdir(), 'decklight-shotsec-'));
process.on('exit', () => rmSync(base, { recursive: true, force: true }));

// The secret lives OUTSIDE the served root — the file a repro deck must not be
// able to reach. The root holds only the deck.
const root = join(base, 'root');
const secretFile = join(base, 'secret.txt');
mkdirSync(root, { recursive: true });
writeFileSync(secretFile, SECRET);

// A hostile deck: on boot it tries to read the out-of-tree secret over a
// file:// XHR and reports whether it succeeded. This is exactly what an
// attacker-authored repro deck would do, minus the exfiltration hop.
const deck = join(root, 'deck.html');
writeFileSync(deck, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"></head><body>
<script type="module">
  let leaked = false;
  try {
    const r = await fetch(${JSON.stringify('file://' + secretFile)});
    if (r.ok) leaked = (await r.text()).trim() === ${JSON.stringify(SECRET)};
  } catch { leaked = false; }
  const pre = document.createElement('pre');
  pre.textContent = 'DECKLIGHT-SHOTSEC-RESULTS ' + JSON.stringify({ leaked, origin: location.origin });
  document.body.appendChild(pre);
</script>
</body></html>`);

// ── vuln: the old path — file:// with --allow-file-access-from-files ──────────
const vuln = resultsFrom(
  dumpDom(`file://${deck}`, { fileAccess: true, budget: 5000, who: 'shot-render(vuln)', quietStderr: true }),
  'SHOTSEC', 'file:// + --allow-file-access-from-files');

// ── fixed: the new path — http://127.0.0.1 under the present CSP ──────────────
const server = await serveForRender(root);
let fixed;
let cspHeader;
try {
  // The CSP rides on the served response — the header a file:// deck can never have.
  cspHeader = (await fetch(`${server.origin}/deck.html`)).headers.get('content-security-policy');
  const { stdout } = await run(chromeBin('shot-render'), chromeArgs(
    '--virtual-time-budget=5000', '--dump-dom', `${server.origin}/deck.html`,
  ), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  fixed = resultsFrom(stdout, 'SHOTSEC', 'http loopback via serveForRender');
} finally {
  await server.close();
}

console.log('shot-render results:', JSON.stringify({ vuln, fixed, cspHeader }, null, 2));

const checks = [
  ['file:// + flag leaks the out-of-tree secret (the danger is real)', vuln.leaked === true],
  ['http loopback origin cannot read it (the fix contains the deck)', fixed.leaked === false],
  ['the deck is served over an http origin, not file://', /^http:\/\/127\.0\.0\.1:/.test(fixed.origin)],
  ['every served response carries the present CSP header', cspHeader === CSP],
];

let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}`);
  ok &&= pass;
}
if (!ok) { console.error('shot-render: FAILED'); process.exit(1); }
console.log('shot-render: PASS');
