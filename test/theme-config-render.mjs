#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Which theme a deck opens on, asked of a real browser (#547).
 *
 * A data-only deck whose themes are inline `<style data-theme>` blocks — every
 * `upgrade --link` deck — is never given a theme link, so the configuration
 * block's `"theme"` was the only thing that could say which block to show, and
 * nothing read it: the deck opened on its FIRST block. A render made it worse,
 * because a render is a fresh browser with no saved pick either, so every
 * video of such a deck came out in whichever theme happened to be first.
 *
 * The deck below holds three blocks of its own and one added by `theme add`,
 * each painting a different `--bg`, and its block names the SECOND. Booted
 * from the block alone (no `Decklight.init` call — the deck as data), it must
 * open on that one; `?theme=` and a saved pick must still win over it; the
 * configured default must not be saved as though somebody had picked it; and
 * a configured ADDED theme must be honoured too.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-theme-config-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const dist = (f) => pathToFileURL(path.join(root, 'dist', f)).href;
const BG = { first: '#111111', second: '#222222', third: '#333333', added: '#444444' };
const block = (name, extra = '') =>
  `<style data-theme="${name}"${extra}>.decklight { --bg: ${BG[name]}; --fg: #eeeeee; }</style>`;

function deck(file, theme) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${dist('decklight.css')}">
${block('first')}
${block('second', ' media="not all"')}
${block('third', ' media="not all"')}
${block('added', ' data-theme-added media="not all"')}
<script>
  // a pick saved on an earlier visit, when the run asks for one
  const q = new URLSearchParams(location.search);
  try {
    localStorage.removeItem('decklight-theme:' + location.pathname);
    if (q.has('saved')) localStorage.setItem('decklight-theme:' + location.pathname, q.get('saved'));
  } catch { /* file:// storage off — the saved case then reports itself */ }
</script>
</head><body>
<div class="decklight">
  <section><h1>One</h1></section>
  <section><h2>Two</h2></section>
</div>
<script type="application/json" data-decklight-config>
{ "decklight": "0.8.1", "theme": "${theme}" }
</script>
<script src="${dist('decklight.js')}"></script>
<script>
  setTimeout(() => {
    const deck = document.querySelector('.decklight');
    const r = {
      booted: !!deck.__decklight,
      bg: getComputedStyle(deck).getPropertyValue('--bg').trim(),
    };
    try { r.stored = localStorage.getItem('decklight-theme:' + location.pathname); } catch { r.stored = 'n/a'; }
    document.body.insertAdjacentHTML('beforeend',
      '<pre id="sink">DECKLIGHT-THEMECONFIG-RESULTS ' + JSON.stringify(r) + '</pre>');
  }, 400);
</script>
</body></html>`;
  writeFileSync(path.join(dir, file), html);
  return pathToFileURL(path.join(dir, file)).href;
}

const configured = deck('configured.html', 'second');
const configuredAdded = deck('added.html', 'added');
const configuredMissing = deck('missing.html', 'nope');

const CASES = [
  ['the configured theme, not the first block', configured, '', (r) => r.bg === BG.second],
  ['…and it is not saved as a pick', configured, '', (r) => r.stored === null],
  ['?theme= wins over the configuration', configured, '?theme=third', (r) => r.bg === BG.third],
  ['a saved pick wins over the configuration', configured, '?saved=third', (r) => r.bg === BG.third],
  ['a configured ADDED theme is honoured', configuredAdded, '', (r) => r.bg === BG.added],
  ['a configured theme the deck lacks falls back to the first block', configuredMissing, '', (r) => r.bg === BG.first],
  ['a render (?capture) opens on the configured theme too', configured, '?capture', (r) => r.bg === BG.second],
];

let bad = 0;
for (const [what, url, query, ok] of CASES) {
  let r;
  try {
    r = resultsFrom(dumpDom(url + query, { fileAccess: true, budget: 3000, quietStderr: true, who: 'theme-config-render' }),
      'THEMECONFIG', what);
  } catch (e) {
    r = { exception: String(e.message || e) };
  }
  const pass = r.booted === true && ok(r);
  if (!pass) bad++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${what} (bg ${r.bg ?? '?'}${r.stored !== undefined ? `, saved ${r.stored}` : ''})`
    + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
}
console.log(bad ? `theme-config-render: ${bad} FAILED` : 'theme-config-render: PASS');
process.exit(bad ? 1 : 0);
