#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `decklight pptx`, run for real — the one thing its unit tests cannot see.
 *
 * test/pptx-export.test.mjs drives pptxMain with a stubbed renderer, which is
 * the right way to test the pagination, the notes and the refusals: it proves
 * everything about the export except that it runs. 0.8.0 shipped with that as
 * the whole coverage, and the command did not work AT ALL — the export served
 * the deck from its own process and then blocked the event loop waiting for
 * Chrome, so the browser waited five minutes for a server that could not
 * answer until the browser exited. Both blessed suites were green.
 *
 * So this harness spawns the real CLI on a real deck and looks at what came
 * back: N pictures for N slides, each a PNG with actual pixels, the notes
 * carried as notes, and the file readable by decklight's own OOXML reader —
 * the same one `decklight import` uses, so a file this asserts is a file that
 * round-trips.
 *
 * The BUDGET is the regression test for the deadlock itself: a two-slide deck
 * renders in about five seconds here, and the failure mode is not slowness but
 * a full stall, so anything past a minute is the bug coming back rather than a
 * slow machine.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipEntries, zipRead } from '../tools/zip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');
const BUDGET_MS = 60_000;

const dir = mkdtempSync(path.join(tmpdir(), 'decklight-pptx-render-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

let bad = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(44)} ${got}${ok ? '' : ` (expected ${want})`}`);
};

// The runtime is COPIED next to the deck and linked relatively. pptx serves
// the deck's directory over http rather than opening it as a file, so an
// absolute path to dist/ is a 404 there: the deck renders as unstyled HTML,
// every slide comes out the same blank picture, and the harness passes while
// proving nothing. (It did, on the first run.)
// The deck's LAST slide is hidden (HIDDEN_SLIDES), because that is the shape
// an imported PowerPoint has: the backup detail nobody presents, kept after
// the talk ends. It must not be in the file handed over — and the way it used
// to arrive is the reason this is asserted end to end rather than in a unit
// test: a deep link onto a hidden slide lands on its nearest SHOWN neighbour,
// so the export wrote the previous slide's picture again, under the hidden
// slide's notes, and every count still added up.
const SHOWN = 2;
const HIDDEN_NOTES = 'Backup detail nobody presents.';
mkdirSync(path.join(dir, 'dist'), { recursive: true });
for (const f of ['decklight.js', 'decklight.css']) copyFileSync(path.join(root, 'dist', f), path.join(dir, 'dist', f));
const deck = path.join(dir, 'deck.html');
const slide = (n, attr = '', notes = `Spoken words for slide ${n}.`) =>
  `<section${attr}><h2>Slide ${n}</h2><p>Body of slide ${n}</p><ul data-build><li>first</li><li>second</li></ul>`
  + `<aside class="notes">${notes}</aside></section>`;
writeFileSync(deck, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="dist/decklight.css">
<body><div class="decklight">${
  [slide(1), slide(2), slide(3, ' data-hidden', HIDDEN_NOTES)].join('\n')
}</div>
<script src="dist/decklight.js"></script>
<script>Decklight.init();</script></body></html>`);

console.log(`     rendering ${SHOWN} shown slide(s) (of 3) through the real CLI…`);
const started = Date.now();
let ran = true;
try {
  execFileSync(process.execPath, [CLI, 'pptx', 'deck.html'], {
    cwd: dir, timeout: BUDGET_MS, killSignal: 'SIGKILL', stdio: ['ignore', 'ignore', 'ignore'],
  });
} catch (e) {
  ran = false;
  const stalled = e.killed || e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL';
  console.log(`FAIL decklight pptx ${stalled ? `did not finish inside ${BUDGET_MS / 1000}s — the render is stalled` : `exited ${e.status}`}`);
  bad++;
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

const out = path.join(dir, 'deck.pptx');
check('the file was written', existsSync(out) && ran, true);

if (existsSync(out) && ran) {
  console.log(`     wrote deck.pptx in ${elapsed}s`);
  const buf = readFileSync(out);
  const names = zipEntries(buf).map((e) => e.name);
  check('a slide part per shown slide', names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, SHOWN);
  check('a notes part per shown slide', names.filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).length, SHOWN);
  check('a picture per shown slide', names.filter((n) => /^ppt\/media\/slide\d+\.png$/.test(n)).length, SHOWN);
  // Not just absent as a page: absent as WORDS. A hidden slide whose notes
  // rode along on somebody else's picture is the failure that counted right.
  check('the hidden slide is nowhere in the file',
    names.filter((n) => /^ppt\/notesSlides\//.test(n))
      .some((n) => zipRead(buf, zipEntries(buf).find((e) => e.name === n)).toString('utf8').includes(HIDDEN_NOTES)), false);

  // Every slide is its OWN slide: the export drives Chrome to `#/n/999`, and
  // an export that ignored the hash — or a deck that never booted — writes the
  // same picture N times and is otherwise indistinguishable from a good one.
  const shots = Array.from({ length: SHOWN }, (_, i) =>
    createHash('sha1').update(zipRead(buf, zipEntries(buf).find((e) => e.name === `ppt/media/slide${i + 1}.png`))).digest('hex'));
  check('each slide is its own picture', new Set(shots).size, SHOWN);

  for (let n = 1; n <= SHOWN; n++) {
    // A stalled render used to leave a 0-byte file behind; a PNG that is only
    // a header is the same failure with a different size, so the pixels are
    // what this counts.
    const png = zipRead(buf, zipEntries(buf).find((e) => e.name === `ppt/media/slide${n}.png`));
    const isPng = png.length > 5000 && png[0] === 0x89 && png.toString('latin1', 1, 4) === 'PNG';
    check(`slide ${n}: a real picture (${png.length} B)`, isPng, true);

    const notes = zipRead(buf, zipEntries(buf).find((e) => e.name === `ppt/notesSlides/notesSlide${n}.xml`)).toString('utf8');
    check(`slide ${n}: its notes, as notes`, notes.includes(`Spoken words for slide ${n}.`), true);
  }
}

if (bad) { console.error('pptx-render: FAILED'); process.exit(1); }
console.log('pptx-render: PASS');
