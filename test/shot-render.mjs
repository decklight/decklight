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
 * `--no-trust` CSP instead (serveForRender), where an http origin cannot touch
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
import { serveForRender, CSP } from '../cli/serve.mjs';

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

// ── a deck with no doctype (#1190) ──────────────────────────────────────────
// A deck written as only its slides parses in quirks mode, where a table
// takes neither the colour nor the size of the text around it: on a dark
// theme its cells were the browser's black on black. Rendered twice: served
// (what every render and server does, which puts the doctype in front) and
// opened from the file itself (no server: the runtime's own table rule has to
// hold the colour in quirks mode).
const TABLE = '<table><caption>Caption</caption><thead><tr><th>A</th><th>B</th></tr></thead>'
  + '<tbody><tr><td>one cell</td><td>two cell</td></tr></tbody></table>'
  // a table the author sized inline: its cells take that size, no smaller
  + '<table class="sized" style="font-size:0.7em"><tbody><tr><td>sized cell</td></tr></tbody></table>';
const TABLE_PROBE = `<script type="module">
setTimeout(() => {
  const css = (el) => (el ? getComputedStyle(el) : null);
  const section = document.querySelector('.decklight-stage > section') ?? document.querySelector('.decklight section');
  const table = section?.querySelector('table:not(.sized)');
  const td = table?.querySelector('td');
  const sized = section?.querySelector('table.sized');
  const size = (el) => parseFloat(css(el)?.fontSize ?? 'NaN');
  const wel = document.querySelector('.decklight-welcome .wel-card');
  const welTd = wel?.querySelector('td:nth-child(2)');
  const pre = document.createElement('pre');
  pre.textContent = 'DECKLIGHT-DOCTYPE-RESULTS ' + JSON.stringify({
    compatMode: document.compatMode,
    mounted: !!document.querySelector('.decklight-stage'),
    sectionColor: css(section)?.color ?? null,
    tdColor: css(td)?.color ?? null,
    sectionSize: parseFloat(css(section)?.fontSize ?? 'NaN'),
    tdSize: size(td),
    // #1190: the table takes the size of the text it sits in, its cells set the smaller text
    tableSize: size(table),
    tableParentSize: size(table?.parentElement),
    thSize: size(table?.querySelector('th')),
    captionSize: size(table?.querySelector('caption')),
    sizedParentSize: size(sized?.parentElement),
    sizedTdSize: size(sized?.querySelector('td')),
    welcomeColor: css(wel)?.color ?? null,
    welcomeTdColor: css(welTd)?.color ?? null,
  });
  document.body.appendChild(pre);
}, 600);
</script>`;

const servedDeck = join(root, 'no-doctype.html');
writeFileSync(servedDeck, `<script type="application/json" data-decklight-config>{ "theme": "eclipse" }</script>
<div class="decklight">
<section><h2>Table</h2>${TABLE}</section>
</div>
${TABLE_PROBE}
`);
const doctypeServer = await serveForRender(root);
let served;
try {
  const { stdout } = await run(chromeBin('shot-render'), chromeArgs(
    '--virtual-time-budget=5000', '--dump-dom', `${doctypeServer.origin}/no-doctype.html?capture`,
  ), { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  served = resultsFrom(stdout, 'DOCTYPE', 'a doctype-less deck, served');
} finally {
  await doctypeServer.close();
}

// The same slides opened as a file, with the runtime and a dark theme linked
// by hand and still no doctype: quirks mode, which no server is there to fix.
const repo = join(import.meta.dirname, '..');
const fileUrl = (p) => 'file://' + join(repo, p);
const quirksDeck = join(base, 'quirks.html');
writeFileSync(quirksDeck, `<link rel="stylesheet" href="${fileUrl('dist/decklight.css')}">
<link rel="stylesheet" href="${fileUrl('themes/eclipse.css')}">
<div class="decklight">
<section><h2>Table</h2>${TABLE}</section>
</div>
<script src="${fileUrl('dist/decklight.js')}"></script>
${TABLE_PROBE}
`);
const quirks = resultsFrom(
  dumpDom(`file://${quirksDeck}`, { budget: 5000, who: 'shot-render(quirks)', quietStderr: true }),
  'DOCTYPE', 'a doctype-less deck, opened as a file');

console.log('shot-render results:', JSON.stringify({ vuln, fixed, cspHeader, served, quirks }, null, 2));

const checks = [
  ['file:// + flag leaks the out-of-tree secret (the danger is real)', vuln.leaked === true],
  ['http loopback origin cannot read it (the fix contains the deck)', fixed.leaked === false],
  ['the deck is served over an http origin, not file://', /^http:\/\/127\.0\.0\.1:/.test(fixed.origin)],
  ['every served response carries the present CSP header', cspHeader === CSP],
  // #1190: served, a deck with no doctype is a standards-mode page
  ['a deck with no doctype is served in standards mode', served.compatMode === 'CSS1Compat' && served.mounted],
  ['served, its table cells take the theme\'s text colour', !!served.tdColor && served.tdColor === served.sectionColor],
  // #1190: opened as a file, quirks mode, and the runtime's table rule still holds
  ['opened as a file it is in quirks mode (the case the stylesheet covers)', quirks.compatMode === 'BackCompat' && quirks.mounted],
  ['in quirks mode its table cells still take the theme\'s text colour', !!quirks.tdColor && quirks.tdColor === quirks.sectionColor],
  ['in quirks mode the table is still sized off the slide\'s text', Math.abs(quirks.tdSize / quirks.sectionSize - served.tdSize / served.sectionSize) < 0.01],
  // #1190: the table is the size of the text around it and its cells are 0.82 of
  // that, the size they had when the table itself was 0.82em, in both modes
  ...[['served', served], ['in quirks mode', quirks]].flatMap(([how, r]) => [
    [`${how}, the table takes its parent's font size`, Math.abs(r.tableSize - r.tableParentSize) < 0.01],
    [`${how}, its cells, header and caption are 0.82 of it, as before`, [r.tdSize, r.thSize, r.captionSize].every((n) => Math.abs(n - 0.82 * r.tableParentSize) < 0.01)],
    [`${how}, a table sized inline gives its cells that size`, Math.abs(r.sizedTdSize - 0.7 * r.sizedParentSize) < 0.01],
  ]),
  ['in quirks mode the welcome card\'s table reads, when it shows', !quirks.welcomeColor || quirks.welcomeTdColor === quirks.welcomeColor],
];

let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}`);
  ok &&= pass;
}
if (!ok) { console.error('shot-render: FAILED'); process.exit(1); }
console.log('shot-render: PASS');
