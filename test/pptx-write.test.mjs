// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/pptx-write.mjs — the lossy exporter's package. Proved by the one
// reader we own: decklight's own importer must open what decklight wrote,
// find every slide in order, one picture on each, and the notes intact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPptx, SLIDE_W, SLIDE_H } from '../tools/pptx-write.mjs';
import { unzip } from '../tools/zip.mjs';
import { slideOrder, parseSlide, parseRels, notesText, resolvePart } from '../tools/pptx.mjs';
import { parseXml, find } from '../tools/ooxml.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000101f8b3c0f60000000049454e44ae426082', 'hex');
const deck = (n) => Array.from({ length: n }, (_, i) => ({ png: PNG, notes: i === 1 ? [] : [`Slide ${i + 1} says hello.`, 'And a second line.'] }));

test('the package opens with our own reader: every slide in order, one picture each', () => {
  const zip = unzip(buildPptx(deck(3), { title: 'Q3 review' }));
  const order = slideOrder(zip.get('ppt/presentation.xml').toString(), zip.get('ppt/_rels/presentation.xml.rels').toString());
  assert.deepEqual(order, ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml']);
  for (const p of order) {
    const rels = parseRels(zip.get(p.replace(/([^/]+)$/, '_rels/$1') + '.rels').toString());
    const seen = [];
    const slide = parseSlide(zip.get(p).toString(), { rels, mediaOf: (t) => { seen.push(resolvePart(p, t)); return { bytes: PNG, mime: 'image/png' }; } });
    assert.equal(slide.blocks.filter((b) => b.kind === 'image').length, 1, `${p}: one picture`);
    assert.equal(slide.drops.length, 0, `${p}: nothing dropped`);
    assert.ok(zip.has(seen[0]), `${p}: its media part exists`);
  }
});

test('notes survive the trip as text, line for line — and a silent slide has an empty notes part, not none', () => {
  const zip = unzip(buildPptx(deck(3)));
  const notesOf = (k) => {
    const p = `ppt/slides/slide${k}.xml`;
    const rels = parseRels(zip.get(p.replace(/([^/]+)$/, '_rels/$1') + '.rels').toString());
    const rel = [...rels.values()].find((r) => r.type.endsWith('/notesSlide'));
    return notesText(zip.get(resolvePart(p, rel.target)).toString());
  };
  assert.deepEqual(notesOf(1), ['Slide 1 says hello.', 'And a second line.']);
  assert.deepEqual(notesOf(2).filter(Boolean), []);
  assert.deepEqual(notesOf(3), ['Slide 3 says hello.', 'And a second line.']);
});

test('the picture fills the page, and the page is PowerPoint\'s own 16:9', () => {
  const zip = unzip(buildPptx(deck(1)));
  const pres = parseXml(zip.get('ppt/presentation.xml').toString());
  assert.equal(find(pres, 'p:sldSz').attrs.cx, String(SLIDE_W));
  assert.equal(find(pres, 'p:sldSz').attrs.cy, String(SLIDE_H));
  const sld = parseXml(zip.get('ppt/slides/slide1.xml').toString());
  const ext = find(find(sld, 'p:pic'), 'a:ext');
  assert.deepEqual([ext.attrs.cx, ext.attrs.cy], [String(SLIDE_W), String(SLIDE_H)]);
  assert.equal(Math.round((SLIDE_W / SLIDE_H) * 100) / 100, 1.78);
});

test('every part the package claims is there, and the masters PowerPoint insists on are present', () => {
  const zip = unzip(buildPptx(deck(2), { title: 'x & y' }));
  const types = zip.get('[Content_Types].xml').toString();
  for (const m of types.matchAll(/PartName="\/([^"]+)"/g)) assert.ok(zip.has(m[1]), `declared but missing: ${m[1]}`);
  for (const must of ['ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/notesMasters/notesMaster1.xml', 'ppt/theme/theme1.xml']) assert.ok(zip.has(must), must);
  assert.match(zip.get('docProps/core.xml').toString(), /<dc:title>x &amp; y<\/dc:title>/, 'the title is escaped');
});

test('a slide with no rendered image is refused by number, and an empty deck is refused', () => {
  assert.throws(() => buildPptx([{ png: PNG, notes: [] }, { png: Buffer.alloc(0), notes: [] }]), /slide 2: no rendered image/);
  assert.throws(() => buildPptx([]), /at least one slide/);
});
