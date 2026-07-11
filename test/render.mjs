// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Headless-render verification of demo/smoke.html — the "prove the deck
// works" harness (SPEC intro + §10). Exits non-zero on any failed assertion.

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.DECKLIGHT_CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function dump(url) {
  return execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--virtual-time-budget=5000',
    '--dump-dom', url,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function sink(html) {
  const m = html.match(/<div id="test-sink"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) throw new Error('test-sink not found in rendered DOM');
  const out = {};
  for (const line of m[1].trim().split('\n')) {
    const [k, ...v] = line.split('=');
    out[k.trim()] = v.join('=').trim();
  }
  return out;
}

let failures = 0;
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

const deckUrl = 'file://' + resolve(here, '../demo/smoke.html');

// --- default load ---------------------------------------------------------
{
  const html = dump(deckUrl);
  const s = sink(html);
  check('no runtime errors', s.errors, 'none');
  check('slide count', s.slides, '11');
  check('slide 1 build steps (3 li + 1 leaf)', s.slide1steps, '4');
  check('slide 2 svg steps (3 g, caption stays)', s.svgsteps, '3');
  check('markdown build steps', s.mdsteps, '2');
  check('code lines wrapped', Number(s.codelines) >= 8, true);
  check('hljs tokens present', s.hljs, 'true');
  check('svg ids namespaced', Number(s.nsids) >= 1, true);
  check('url(#) refs rewritten', s.nsrefs, 'true');
  check('markdown rendered to h2', s.mdrendered, 'true');
  check('markdown notes extracted', s.mdnotes, 'true');
  check('markdown gfm table', s.mdtable, 'true');
  check('draw strokes prepared', Number(s.drawlen) >= 3, true);
  check('auto layout pins by default', s.autopinned, 'true');
  check('data-layout=pinned pins the title', s.layoutpinned, 'true');
  check('data-layout=top stays unpinned, top-aligned', s.layouttop, 'true');
  check('data-layout=split is a wrapping flex row', s.splitrow, 'true');
  check('lone-list split gets two columns', s.splitcols, 'true');
  check('cycleLayout(1): auto → centered (pinned skipped)', s.layoutcycle, 'centered');
  check('cycleLayout(-1): back to auto, storage cleared', s.layoutreset, 'true');
  check('one content block: split-flip skipped in the ring', s.flipskip, 'true');
  check('no template text leaked',
    /text\/template/.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), false);
  check('slide 1 initially unbuilt',
    /data-slide-index="1"[\s\S]*?data-build-state="pending"/.test(html), true);
}

// --- deep link: slide 1, step 2 -------------------------------------------
{
  const html = dump(deckUrl + '#/1/2');
  const section = html.match(/<section[^>]*data-slide-index="1"[\s\S]*?<\/section>/)[0];
  const done = (section.match(/data-build-state="(done|current)"/g) || []).length;
  const pending = (section.match(/data-build-state="pending"/g) || []).length;
  check('deep link: 2 steps built', done, 2);
  check('deep link: 2 steps pending', pending, 2);
}

// --- print mode ------------------------------------------------------------
{
  const html = dump(deckUrl + '?print');
  check('print: everything built',
    (html.match(/data-build-state="pending"/g) || []).length, 0);
  check('print: print class set', /decklight-print/.test(html), true);
}

console.log(failures ? `\n${failures} FAILED` : '\nall render checks passed');
process.exit(failures ? 1 : 0);
