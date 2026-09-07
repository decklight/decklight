// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight pdf`: the decisions it makes before Chrome is involved — where the
// file lands, what URL is printed, how many pages came back, and which slides
// the print-mode guardrail flagged. All pure, so none of this needs a browser;
// the page-count-equals-slide-count proof lives in test/pdf-render.mjs.

import { test } from 'node:test';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pdfOut, printUrl, pdfPageCount, overflowSlides, splitConflictSlides, slideCount, expectedPages, HANDOUT_PER_PAGE } from '../cli/pdf.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

test('the PDF lands beside the deck, named after it, unless -o says otherwise', () => {
  // resolve(), not literals: pdfOut resolves against cwd, and '/talks' lands on
  // the current DRIVE on Windows. The claim is "beside the deck, .html → .pdf",
  // which is what these compare — not the spelling of an absolute path.
  assert.equal(pdfOut('/talks/q3.html'), resolve('/talks/q3.pdf'));
  assert.equal(pdfOut('/talks/q3.HTM'), resolve('/talks/q3.pdf'), 'the extension is matched case-insensitively');
  assert.equal(pdfOut('/talks/q3.html', '/tmp/handout.pdf'), resolve('/tmp/handout.pdf'));
  assert.equal(pdfOut('/talks/q3.html', 'rel.pdf'), resolve('rel.pdf'), '-o resolves against cwd');
  // a deck whose name merely CONTAINS .html must not be truncated mid-word
  assert.equal(pdfOut('/talks/about-html-parsing.html'), resolve('/talks/about-html-parsing.pdf'));
});

test('the printed URL is the deck plus ?print — the whole rendering contract', () => {
  assert.equal(printUrl('/talks/q3.html'), 'file:///talks/q3.html?print');
  assert.equal(printUrl('/talks/q3.html', { theme: 'graphite' }),
    'file:///talks/q3.html?print&theme=graphite');
  assert.match(printUrl('/t/q.html', { theme: 'a b&c' }), /theme=a%20b%26c$/, 'a theme name is escaped');
});

test('pages are counted off the bytes — /Page, never /Pages', () => {
  const pdf = (s) => Buffer.from(s, 'latin1');
  assert.equal(pdfPageCount(pdf('/Type /Pages /Count 3 /Type /Page x /Type /Page y /Type /Page z')), 3,
    'the page-tree node is not a page');
  assert.equal(pdfPageCount(pdf('/Type/Page\n/Type/Page\n')), 2, 'whitespace is optional in a PDF name');
  // a future Chrome could bury the page objects in compressed streams; the
  // tree's own count is the fallback, and 0 means "could not tell"
  assert.equal(pdfPageCount(pdf('/Type /Pages /Count 8 /Count 8 /Count 4')), 8);
  assert.equal(pdfPageCount(pdf('nothing pdf-shaped here')), 0);
});

test('overflowing slides are reported by their slide NUMBER, in document order', () => {
  const dom = '<section><h2>a</h2></section>'
    + '<section data-overflow=""><h2>b</h2></section>'
    + '<section><h2>c</h2></section>'
    + '<section data-overflow><h2>d</h2></section>';
  assert.deepEqual(overflowSlides(dom), [2, 4]);
  assert.equal(slideCount(dom), 4);
  assert.deepEqual(overflowSlides('<section></section>'), [], 'a clean deck reports nothing');
});

test('a deck that merely TALKS about data-overflow does not report itself', () => {
  // demo/showcase.html documents the guardrail in a code sample — the attribute
  // has to be matched inside a <section> tag, not anywhere in the document
  const dom = '<section><h2>Overflow</h2><pre><code>data-overflow</code></pre></section>';
  assert.deepEqual(overflowSlides(dom), []);
});

test('slides mixing split with their own column flexbox are named too', () => {
  // the SPEC COMPARISON_SLIDES trap: the engine marks the CAUSE with
  // data-split-conflict, and the audit reads it back like data-overflow
  const dom = '<section><h2>clean</h2></section>'
    + '<section data-layout="split" data-split-conflict=""><h2>mixed</h2></section>'
    + '<section data-layout="split"><h2>proper split</h2></section>';
  assert.deepEqual(splitConflictSlides(dom), [2]);
  assert.deepEqual(overflowSlides(dom), [], 'the two audits are independent');
  // and talking about the attribute in a code sample is not carrying it
  assert.deepEqual(splitConflictSlides('<section><pre><code>data-split-conflict</code></pre></section>'), []);
});

test('pdf is routed and documented by the dispatcher', () => {
  const help = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help, /^  pdf {6}/m, 'pdf is listed in the global help');

  const own = execFileSync('node', [CLI, 'pdf', '--help'], { encoding: 'utf8' });
  assert.match(own, /usage: decklight pdf/);
  assert.match(own, /--theme/);
  assert.match(own, /--wait/);
});

test('pdf without a deck, or with a missing one, fails with usage — not a stack trace', () => {
  const bare = spawnSync('node', [CLI, 'pdf'], { encoding: 'utf8' });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /needs a deck/);
  assert.doesNotMatch(bare.stderr, /at .*\.mjs:\d+/, 'no stack trace');

  const missing = spawnSync('node', [CLI, 'pdf', 'nope.html'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such deck/);
});


test('a hidden slide is not a page: slideCount skips data-hidden, and only data-hidden', () => {
  const html = '<section><h1>a</h1></section><section data-hidden><h1>b</h1></section>'
    + '<section class="x" data-hidden="" ><h1>c</h1></section><section data-hidden-not><h1>d</h1></section>';
  assert.equal(slideCount(html), 2);
});

// ── the two print variants the runtime already had, now reachable from the CLI ─

test('--notes and --handout ride the runtime\'s own ?print= variants, theme and all', () => {
  assert.equal(printUrl('/talks/q3.html', { variant: 'notes' }), 'file:///talks/q3.html?print=notes');
  assert.equal(printUrl('/talks/q3.html', { variant: 'handout', theme: 'graphite' }),
    'file:///talks/q3.html?print=handout&theme=graphite');
  assert.equal(printUrl('/talks/q3.html', { variant: '' }), 'file:///talks/q3.html?print', 'no variant is plain print');
});

test('a variant gets its own file name, so the handout never overwrites the slides', () => {
  // resolve() on both sides: on Windows the answer is D:\talks\q3.pdf, and
  // the point is the NAME, not the separator
  assert.equal(pdfOut('/talks/q3.html'), resolve('/talks/q3.pdf'));
  assert.equal(pdfOut('/talks/q3.html', null, 'notes'), resolve('/talks/q3.notes.pdf'));
  assert.equal(pdfOut('/talks/q3.html', null, 'handout'), resolve('/talks/q3.handout.pdf'));
  assert.equal(pdfOut('/talks/q3.html', '/tmp/x.pdf', 'handout'), resolve('/tmp/x.pdf'), '-o always wins');
});

test('expected pages: one per slide, except the handout, which packs three — print.js\'s own number', () => {
  assert.equal(expectedPages(7), 7);
  assert.equal(expectedPages(7, 'notes'), 7);
  assert.equal(expectedPages(7, 'handout'), 3);
  assert.equal(expectedPages(6, 'handout'), 2);
  assert.equal(expectedPages(1, 'handout'), 1);
});

test('the CLI\'s handout constant is the runtime\'s, held by this test rather than an import', () => {
  // cli/pdf.mjs used to `import { HANDOUT_PER_PAGE } from '../src/core/print.js'`,
  // which resolves in a clone and never in an install — src/ is not in the
  // package (test/cli.test.mjs asserts that boundary). So the number is
  // restated on the shipped side, and the two are read out of their sources
  // and compared here: paginating the PDF differently from the page the
  // runtime lays out puts blank pages, or missing slides, in a handout.
  const read = (rel) => {
    const m = /export const HANDOUT_PER_PAGE = (\d+);/.exec(
      fs.readFileSync(path.resolve(here, '..', rel), 'utf8'));
    assert.ok(m, `${rel} no longer exports HANDOUT_PER_PAGE`);
    return Number(m[1]);
  };
  assert.equal(read('cli/pdf.mjs'), read('src/core/print.js'),
    'cli/pdf.mjs and src/core/print.js disagree about how many slides a handout page holds');
  assert.equal(HANDOUT_PER_PAGE, read('src/core/print.js'));
});
