// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight pptx — the command over tools/pptx-write.mjs. Chrome is injected
// as a renderer that writes a PNG, so the whole path from a deck file to a
// PowerPoint file that our own importer opens runs without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pptxMain, pptxOut, notesLines } from '../cli/pptx-export.mjs';
import { unzip } from '../tools/zip.mjs';
import { slideOrder, parseRels, notesText, resolvePart } from '../tools/pptx.mjs';
import { decodeEntities } from '../tools/ooxml.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000101f8b3c0f60000000049454e44ae426082', 'hex');
const DECK = `<!doctype html><html><head><title>Q3 &amp; beyond</title></head><body><div class="decklight">
<section><h1>One</h1><aside class="notes"><p>First point.</p><p>Second &amp; last.</p></aside></section>
<section><h1>Two</h1></section>
<section><h1>Three</h1><aside class="notes">Line one<br>Line two</aside></section>
</div></body></html>`;

test('notes become lines: paragraphs and breaks split, tags fall away, entities come back', () => {
  assert.deepEqual(notesLines(DECK), [['First point.', 'Second & last.'], [], ['Line one', 'Line two']]);
});

test('the output name follows the deck unless -o says otherwise', () => {
  // resolve() on both sides — on Windows this is D:\t\q3.pptx, and the point is the name
  assert.equal(pptxOut('/t/q3.html'), resolve('/t/q3.pptx'));
  assert.equal(pptxOut('/t/q3.html', '/x/out.pptx'), resolve('/x/out.pptx'));
});

test('a deck becomes a PowerPoint file our importer opens — a picture per slide, the notes intact, the title carried', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'decklight-pptx-cli-'));
  writeFileSync(join(dir, 'talk.html'), DECK);
  // leave the directory BEFORE removing it — t.after runs in registration
  // order, and Windows refuses to rmdir the current directory (EBUSY)
  const cwd = process.cwd(); process.chdir(dir);
  t.after(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  const asked = [];
  const render = async (bin, argv, { n, png }) => { asked.push({ n, url: argv.find((a) => a.startsWith('http')) }); writeFileSync(png, PNG); };
  const logs = [];
  const code = await pptxMain(['talk.html'], { render, log: (l) => logs.push(l) });
  assert.equal(code, 0, logs.join('\n'));
  assert.deepEqual(asked.map((a) => a.n), [1, 2, 3]);
  assert.match(asked[0].url, /\/talk\.html#\/1\/999$/, 'every slide is asked for at its last build step');
  const out = join(dir, 'talk.pptx');
  assert.ok(existsSync(out));
  const zip = unzip(readFileSync(out));
  const order = slideOrder(zip.get('ppt/presentation.xml').toString(), zip.get('ppt/_rels/presentation.xml.rels').toString());
  assert.equal(order.length, 3);
  const notesOf = (k) => {
    const p = `ppt/slides/slide${k}.xml`;
    const rels = parseRels(zip.get(p.replace(/([^/]+)$/, '_rels/$1') + '.rels').toString());
    // notesText keeps the XML's entities (the importer decodes at the end); an
    // ampersand written as &amp; is the escaping working, not a mangled note
    return notesText(zip.get(resolvePart(p, [...rels.values()].find((r) => r.type.endsWith('/notesSlide')).target)).toString()).filter(Boolean).map(decodeEntities);
  };
  assert.deepEqual(notesOf(1), ['First point.', 'Second & last.']);
  assert.deepEqual(notesOf(3), ['Line one', 'Line two']);
  assert.match(zip.get('docProps/core.xml').toString(), /<dc:title>Q3 &amp; beyond<\/dc:title>/);
});

test('a hidden slide is not in the file you hand over — and does not duplicate its neighbour', async (t) => {
  // The bug this pins: a deep link onto a hidden slide lands on the nearest
  // SHOWN one (the engine's goto), so the export used to write slide 1's
  // picture twice — the second copy carrying the hidden slide's notes.
  const dir = mkdtempSync(join(tmpdir(), 'decklight-pptx-cli-'));
  writeFileSync(join(dir, 'talk.html'), DECK.replace('<section><h1>Two</h1>', '<section data-hidden><h1>Two</h1>'));
  const cwd = process.cwd(); process.chdir(dir);
  t.after(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  const asked = [];
  const render = async (bin, argv, { n, png }) => { asked.push(n); writeFileSync(png, PNG); };
  const logs = [];
  assert.equal(await pptxMain(['talk.html'], { render, log: (l) => logs.push(l) }), 0, logs.join('\n'));
  assert.deepEqual(asked, [1, 3], 'the hidden slide was rendered');
  assert.ok(logs.some((l) => /1 hidden, skipped/.test(l)), logs.join('\n'));
  const zip = unzip(readFileSync(join(dir, 'talk.pptx')));
  const order = slideOrder(zip.get('ppt/presentation.xml').toString(), zip.get('ppt/_rels/presentation.xml.rels').toString());
  assert.equal(order.length, 2, 'the hidden slide still took a page');
  // Slide 2 of the FILE is slide 3 of the deck, notes and all — the numbering
  // closes up on export, exactly as it does in the pdf.
  const rels = parseRels(zip.get('ppt/slides/_rels/slide2.xml.rels').toString());
  const notes = notesText(zip.get(resolvePart('ppt/slides/slide2.xml', [...rels.values()].find((r) => r.type.endsWith('/notesSlide')).target)).toString()).filter(Boolean).map(decodeEntities);
  assert.deepEqual(notes, ['Line one', 'Line two']);
});

test('a deck with nothing left to show is a refusal, not an empty file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'decklight-pptx-cli-'));
  writeFileSync(join(dir, 'talk.html'), DECK.replace(/<section>/g, '<section data-hidden>'));
  const cwd = process.cwd(); process.chdir(dir);
  t.after(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  const logs = [];
  assert.equal(await pptxMain(['talk.html'], { render: async () => {}, log: (l) => logs.push(l) }), 1);
  assert.match(logs.at(-1), /every slide in this deck is hidden/);
  assert.equal(existsSync(join(dir, 'talk.pptx')), false);
});

test('a deck outside the current directory is served from its own, not refused', async (t) => {
  // 0.8.x told you to cd there first. The deck is served rather than opened as
  // a file, and a server has one root: a deck under the cwd keeps the cwd (so
  // a deck in a subdirectory still reaches the project's dist/), and a deck
  // anywhere else gets its own directory, where its assets are.
  const dir = mkdtempSync(join(tmpdir(), 'decklight-pptx-away-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'talk.html'), DECK);
  const urls = [];
  const render = async (bin, argv, { png }) => { urls.push(argv.find((a) => a.startsWith('http'))); writeFileSync(png, PNG); };
  const logs = [];
  assert.equal(await pptxMain([join(dir, 'talk.html')], { render, log: (l) => logs.push(l) }), 0, logs.join('\n'));
  assert.match(urls[0], /\/talk\.html#\/1\/999$/, 'the deck was not served from its own directory');
  assert.ok(existsSync(join(dir, 'talk.pptx')));
});

test('a slide Chrome did not render stops the export by number, rather than shipping a blank page', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'decklight-pptx-cli-'));
  writeFileSync(join(dir, 'talk.html'), DECK);
  // leave the directory BEFORE removing it — t.after runs in registration
  // order, and Windows refuses to rmdir the current directory (EBUSY)
  const cwd = process.cwd(); process.chdir(dir);
  t.after(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  const logs = [];
  const render = async (bin, argv, { n, png }) => { if (n !== 2) writeFileSync(png, PNG); };
  assert.equal(await pptxMain(['talk.html'], { render, log: (l) => logs.push(l) }), 1);
  assert.ok(logs.some((l) => /slide 2 did not render/.test(l)), logs.join('\n'));
  assert.equal(existsSync(join(dir, 'talk.pptx')), false);
});

test('no deck, or a deck that is not here, is a one-line refusal', async () => {
  const logs = [];
  assert.equal(await pptxMain([], { log: (l) => logs.push(l) }), 1);
  assert.match(logs[0], /needs a deck/);
  assert.equal(await pptxMain(['nope.html'], { log: (l) => logs.push(l) }), 1);
  assert.match(logs.at(-1), /no such deck/);
});
