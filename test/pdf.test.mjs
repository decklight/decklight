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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pdfOut, printUrl, pdfPageCount, overflowSlides, splitConflictSlides, slideCount } from '../cli/pdf.mjs';

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
