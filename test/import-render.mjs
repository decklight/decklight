#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * An imported deck has to actually present.
 *
 * The unit tests prove the XML maps to the markup we intended. They cannot
 * prove the markup is a deck the runtime accepts — a mis-nested list, a stray
 * tag from someone else's file, or a slide too full to fit are all things that
 * only show up once a browser has the file. So: convert the fixture for real,
 * open it, and ask the engine what it got.
 *
 * `[data-overflow]` is asserted absent for the same reason the authoring skill
 * tells agents to assert it: an imported slide that silently clips is the exact
 * failure an importer is most likely to introduce, since the content was laid
 * out for somebody else's template.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const FIXTURE = path.resolve(here, 'fixtures/sample.pptx');

const dir = mkdtempSync(path.join(tmpdir(), 'decklight-import-render-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const deck = path.join(dir, 'imported.html');
execFileSync('node', [CLI, 'import', FIXTURE, '-o', deck], { stdio: ['ignore', 'ignore', 'ignore'] });

// The probe rides in the deck the importer actually wrote — no second
// template. It goes in at the LAST </body>: the inlined runtime contains that
// string too, and a naive replace injects the probe into the middle of the
// engine's own source, which breaks the page in a way that looks like the
// importer's fault.
const source = readFileSync(deck, 'utf8');
const at = source.lastIndexOf('</body>');
const html = (source.slice(0, at) + `<pre id="test-sink">running…</pre>
<script>
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
const warns = [];
const realWarn = console.warn.bind(console);
console.warn = (...a) => { warns.push(a.join(' ')); realWarn(...a); };
setTimeout(() => {
  const root = document.querySelector('.decklight');
  const sections = [...document.querySelectorAll('.decklight-stage > section')];
  // walk the whole deck: overflow is stamped on activation, so a slide nobody
  // visits is a slide nobody checked
  const deckApi = window.__deck;
  for (let i = 1; i <= sections.length; i++) deckApi.goto(i, 999);
  setTimeout(() => {
    document.getElementById('test-sink').textContent = 'DECKLIGHT-IMPORT-RESULTS ' + JSON.stringify({
      slides: sections.length,
      titleIsH1: !!sections[0].querySelector('h1'),
      notes: sections.filter((s) => s.querySelector('aside.notes')).length,
      buildList: !!document.querySelector('ul[data-build]'),
      nestedInsideLi: !!document.querySelector('li > ul > li'),
      table: !!document.querySelector('table th'),
      imageInlined: (document.querySelector('img') || {}).src?.startsWith('data:') ?? false,
      overflow: [...document.querySelectorAll('[data-overflow]')].length,
      errors: errors.length ? errors.join(' | ') : 'none',
      overflowWarns: warns.filter((w) => /overflows/.test(w)).length,
    });
  }, 200);
}, 300);
</script>` + source.slice(at)).replace('Decklight.init({});', 'window.__deck = Decklight.init({});');
const probe = path.join(dir, 'probe.html');
writeFileSync(probe, html);

// resultsFrom anchors on the `{` that must follow the marker, so it reads the
// <pre> the page filled in rather than the script source that names the marker
const dom = dumpDom(`file://${probe}`, { fileAccess: true, budget: 6000, quietStderr: true, who: 'import-render' });
const r = resultsFrom(dom, 'IMPORT', 'the converted fixture');

let bad = 0;
const check = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(38)} ${got}${ok ? '' : ` (expected ${want})`}`);
};

check('visible slides (the hidden one is out)', r.slides, 3);
check('the title slide is an h1', r.titleIsH1, true);
check('speaker notes came across', r.notes, 1);
check('the build list steps', r.buildList, true);
check('sublists nest inside their <li>', r.nestedInsideLi, true);
check('the table has a header row', r.table, true);
check('the image is inlined as data:', r.imageInlined, true);
check('no slide overflows', r.overflow, 0);
check('the engine never warned about overflow', r.overflowWarns, 0);
check('no runtime errors', r.errors, 'none');

if (bad) { console.error('import-render: FAILED'); process.exit(1); }
console.log('import-render: PASS');
