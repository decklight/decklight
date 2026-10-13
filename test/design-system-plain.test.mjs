// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Plain markup on a design system (SPEC DESIGN_SYSTEMS): a design system
// styles plain content elements on a slide without a template (base styles),
// names its slots by convention, so a slide switched between two design
// systems keeps its content, and is told (a `·` note, a `·` hint, never a
// warning) where it or a slide misses either.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch } from './helpers.mjs';
import { baseStyles, conventionalMiss, CONVENTIONAL_SLOTS } from '../tools/design-system-format.mjs';
import { checkDir, reportLines } from '../cli/design-system.mjs';
import { packageVerdict } from '../cli/design-system-refs.mjs';
import { applySlideTemplate, describeTemplateChange } from '../cli/design-system-edit.mjs';
import { staticFindings, checkEntry } from '../cli/check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'design-systems');
const NORTH = path.join(FIX, 'base');
const SOUTH = path.join(FIX, 'base-alt');

/** A template as the switch takes it, read through the gate like every server reads it. */
const templateOf = (dir, id) => {
  const r = checkDir(dir);
  const t = r.summary.templates.find((x) => x.id === id);
  return { ref: `${r.summary.name}/${id}`, id, slots: t.slots };
};

test('base styles: the plain elements a stylesheet styles inside a slide, and which component each also is', () => {
  const css = readFileSync(path.join(NORTH, 'design-system.css'), 'utf8');
  assert.deepEqual(baseStyles(css), { elements: ['h2', 'ul', 'li'], components: { 'north-title': ['h2'], 'north-points': ['ul'] } },
    'the tile has no plain equivalent, so it is no component of any element');
  assert.deepEqual(baseStyles('.decklight section :is(h1, h2, p) { font-family: serif; }').elements, ['h1', 'h2', 'p']);
  assert.deepEqual(baseStyles('.decklight h2 { color: red } h2 { color: blue }').elements, [], 'outside a slide is not a base style');
  assert.deepEqual(baseStyles('/* .decklight section h2 { } */ @media print { .decklight section > p { color: black } }').elements, ['p'],
    'a comment is not a rule; a rule inside @media is');
});

test('a design system that styles plain markup and names its slots by convention passes, says so, and is not told it paints the page', () => {
  for (const dir of [NORTH, SOUTH]) {
    const r = checkDir(dir);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.warnings, [], 'h2 and ul inside a section are content, not the page');
    assert.deepEqual(r.summary.notes, []);
    assert.match(reportLines(dir, r).join('\n'), /base styles {10}h2, ul, li — a slide without a template takes the brand's look for these/);
  }
});

test('the conventional slot names, and the near-miss a gate notes but never refuses', (t) => {
  assert.deepEqual(CONVENTIONAL_SLOTS.map((c) => c.name),
    ['eyebrow', 'title', 'subtitle', 'number', 'points', 'body', 'diagram', 'table', 'quote', 'code', 'image', 'caption']);
  assert.deepEqual(conventionalMiss({ name: 'heading', hint: 'h1,h2' }), { part: 'title' });
  assert.deepEqual(conventionalMiss({ name: 'bullets', hint: 'ul' }), { part: 'points' });
  assert.equal(conventionalMiss({ name: 'kicker', hint: 'p' }), null, 'a paragraph could be any of six parts: nothing to say');
  assert.equal(conventionalMiss({ name: 'title', hint: 'h2' }), null);
  assert.equal(conventionalMiss({ name: 'mixed', hint: 'h2,ul' }), null, 'two parts in one hint is no one part');
  assert.equal(conventionalMiss({ name: 'rest', hint: 'ul', default: true }), null, 'the default slot takes whatever is left');

  const dir = path.join(scratch('plain-gate', t), 'north');
  cpSync(NORTH, dir, { recursive: true });
  const tpl = path.join(dir, 'templates.html');
  writeFileSync(tpl, readFileSync(tpl, 'utf8').replace('data-slot="title"', 'data-slot="heading"'));
  const r = checkDir(dir);
  assert.equal(r.ok, true, 'a note, never a refusal');
  assert.deepEqual(r.summary.notes.map((n) => n.rule), ['slot-name-conventional']);
  assert.match(r.summary.notes[0].msg, /title-points: the slot "heading" \(hint h1,h2\) is a title; the conventional name for this part is "title"/);
  assert.match(reportLines(dir, r).join('\n'), /· title-points: the slot "heading".*\[slot-name-conventional\]/);
  assert.deepEqual(checkDir(path.join(FIX, 'brand')).summary.notes.filter((n) => n.rule === 'slot-name-conventional'), [], 'kicker is not noted');
});

const deck = (body) => `<!doctype html><html><head><title>T</title>
<script type="application/json" data-decklight-config>{"decklight":"0.9.0","theme":"aurora","designSystems":["north@mkt","south@mkt"]}</script>
</head><body><div class="decklight">
${body}
</div></body></html>
`;

test('a slide switched between two design systems that name their parts by convention loses nothing, and the sentence says so', () => {
  const slide = `<section data-template="north/title-points">
    <p data-slot="eyebrow">Module 2</p>
    <h2 data-slot="title">Streams</h2>
    <p data-slot="subtitle">and tables</p>
    <ul data-slot="points"><li>one</li><li>two</li></ul>
    <aside class="notes">say it</aside>
  </section>`;
  const south = templateOf(SOUTH, 'title-points');
  const r = applySlideTemplate(deck(slide), 1, south);
  assert.equal(r.mode, 'switch');
  assert.deepEqual(r.lacking, []);
  assert.match(r.html, /<section data-template="south\/title-points">/);
  for (const part of ['eyebrow', 'title', 'subtitle', 'points']) assert.match(r.html, new RegExp(`data-slot="${part}"`));
  assert.equal(describeTemplateChange(r, south.ref), 'now south/title-points — content stays by slot name, nothing left over');

  // a design system without the part says which content it cannot place
  const statement = templateOf(path.join(FIX, 'ok'), 'statement');
  const lossy = applySlideTemplate(deck(slide), 1, statement);
  assert.deepEqual(lossy.lacking, ['eyebrow', 'subtitle', 'points']);
  assert.doesNotMatch(describeTemplateChange(lossy, statement.ref), /nothing left over/);
});

test('decklight check hints, never warns, at a component class on a part plain markup already gets it on', () => {
  const systems = () => new Map([['north', checkEntry('north@mkt', packageVerdict(NORTH))]]);
  const html = deck(`<section><h2>Plain</h2><ul><li>fine</li></ul></section>
<section><div class="north-title">By hand</div><ul class="north-points"><li>also</li></ul><div class="north-tile">A tile</div></section>`);
  const found = staticFindings(html, { designSystems: systems }).filter((f) => f.rule === 'ds-plain-markup');
  assert.deepEqual(found.map((f) => [f.slide, f.level]), [[2, 'hint']], 'the plain slide passes; the hand-classed one is said once');
  assert.match(found[0].message, /<div class="north-title">: a plain <h2> \(or a template's title slot\) gets this component from the design system/);
  assert.match(found[0].message, /<ul class="north-points">: a plain <ul> \(or a template's points slot\)/);
  assert.doesNotMatch(found[0].message, /north-tile/, 'a tile has no plain equivalent: its class is the only way to say it');
});
