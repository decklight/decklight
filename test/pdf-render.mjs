#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The one thing about a PDF export that unit tests cannot see: whether the
 * pages came out right.
 *
 * ONE PAGE PER SLIDE is the whole contract, and it is a contract the CSS can
 * break silently — the exporter reports whatever Chrome wrote, so a stray blank
 * sheet looks like a successful run. It was in fact broken when this harness
 * was written: the UA's default 8px margin on <body> pushed the last slide's
 * final pixels past the last page box, and every export ended on a blank page
 * (35 slides → 36 pages). Nothing in the exporter could have told you.
 *
 * Three decks, because the failure only shows at the seams:
 *   plain    — N slides, N pages, at the deck's own 1280×720 (960×540 pt)
 *   handout  — 3 slides to a portrait US-Letter page
 *   notes    — one slide + its notes per portrait page
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfPageCount } from '../cli/pdf.mjs';
import { chromeBin, chromeArgs } from '../tools/chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const bin = chromeBin('pdf-render');

const dir = mkdtempSync(path.join(tmpdir(), 'decklight-pdf-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

/** A deck of `n` slides, each with notes, loading the built runtime by path. */
function deck(n) {
  const file = path.join(dir, `deck-${n}.html`);
  const slides = Array.from({ length: n }, (_, i) =>
    `<section><h2>Slide ${i + 1}</h2><p>Body ${i + 1}</p>`
    + `<aside class="notes">Spoken words for slide ${i + 1}.</aside></section>`).join('\n');
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(root, 'dist/decklight.css')}"></head>
<body><div class="decklight">${slides}</div>
<script src="${path.join(root, 'dist/decklight.js')}"></script>
<script>Decklight.init();</script></body></html>`);
  return file;
}

function pages(file, query) {
  const out = path.join(dir, `${path.basename(file, '.html')}-${query.replace(/\W/g, '')}.pdf`);
  execFileSync(bin, [
    ...chromeArgs('--allow-file-access-from-files', '--virtual-time-budget=6000'),
    '--no-pdf-header-footer', `--print-to-pdf=${out}`, `file://${file}?${query}`,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  const buf = readFileSync(out);
  const boxes = [...new Set(buf.toString('latin1').match(/\/MediaBox\s*\[[^\]]*\]/g) ?? [])];
  return { n: pdfPageCount(buf), boxes };
}

let bad = 0;
const check = (label, got, want, extra = '') => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(34)} ${got} (expected ${want})${extra}`);
};

// A one-slide deck is the sharpest version of the blank-page bug: it either
// makes one page or it makes two, and there is nowhere for the error to hide.
for (const n of [1, 3, 12]) {
  const file = deck(n);
  const { n: got, boxes } = pages(file, 'print');
  check(`plain: ${n} slide(s)`, got, n, ` · ${boxes.join(' ')}`);
  if (n === 3 && !boxes.every((b) => /960 540/.test(b))) {
    console.log(`FAIL plain page box is not 960×540 pt — got ${boxes.join(' ')}`);
    bad++;
  }
}

// 12 slides, 3 to a page
check('handout: 12 slides', pages(deck(12), 'print=handout').n, 4);
// 12 slides, one per page
check('notes: 12 slides', pages(deck(12), 'print=notes').n, 12);

if (bad) { console.error('pdf-render: FAILED'); process.exit(1); }
console.log('pdf-render: PASS');
