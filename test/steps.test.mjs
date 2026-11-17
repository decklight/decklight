// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A run of slides that shows where it is (SPEC DECK_ANATOMY, #1188): where it
// starts and ends, which group each slide is in, how it is counted, and the
// one finding `decklight check` makes of it. tools/steps.mjs is the one
// reading the strip, the finder and the check share.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, listSteps, stepRuns, stepLabel, stepKey, STEP_GROUPS_MAX } from '../tools/steps.mjs';
import { staticFindings } from '../cli/check.mjs';

test('a run\'s groups: comma-separated, trimmed, each once, bounded', () => {
  assert.deepEqual(parseSteps('Foundation,  Fresh   context , Tools,,The agent'), ['Foundation', 'Fresh context', 'Tools', 'The agent']);
  assert.deepEqual(parseSteps('A, a, B'), ['A', 'B'], 'case is no difference');
  assert.deepEqual(parseSteps(''), []);
  assert.equal(parseSteps(Array.from({ length: 20 }, (_, i) => `g${i}`).join(',')).length, STEP_GROUPS_MAX);
  assert.deepEqual(listSteps([' Plan ', 'Build, test', 'Ship']), ['Plan', 'Build test', 'Ship'], 'a list item is one group, its commas no split');
  assert.equal(stepKey('  Fresh   Context '), 'fresh context');
});

test('a run starts where it is declared and runs until a chapter, a marked end, or the next run', () => {
  const r = stepRuns([
    {}, { steps: 'A, B' }, {}, { step: 'B' }, { module: true },          // ended by a chapter
    { steps: 'C, D' }, { end: true },                                    // ended by data-steps-end: that slide is the first after
    { list: ['E', 'F'] }, { steps: 'G' }, {},                             // a list declares one, the next run ends it
  ]);
  assert.deepEqual(r.runs.map((x) => [x.start, x.end, x.groups.join('')]), [[2, 4, 'AB'], [6, 6, 'CD'], [8, 8, 'EF'], [9, 10, 'G']]);
  assert.deepEqual(r.at.map((w) => (w ? `${w.run}${'ABCDEFG'[[0, 2, 4, 6][w.run] + w.group]}` : '-')), ['-', '0A', '0A', '0B', '-', '1C', '-', '2E', '3G', '3G']);
  assert.deepEqual(r.unknown, []);
});

test('data-steps wins over a list on the same slide, and data-step on the first slide picks its group', () => {
  const r = stepRuns([{ steps: 'A, B', list: ['X', 'Y'], step: 'b' }, {}]);
  assert.deepEqual(r.runs[0].groups, ['A', 'B']);
  assert.deepEqual(r.at.map((w) => w.group), [1, 1]);
});

test('counted over the slides an audience sees: a hidden slide keeps its group, not a number', () => {
  const r = stepRuns([{ steps: 'A, B', count: true }, { hidden: true }, { step: 'B' }]);
  assert.deepEqual(r.at.map((w) => [w.n, w.of]), [[1, 2], [null, 2], [2, 2]]);
  assert.equal(r.runs[0].slides, 2);
  const plain = stepRuns([{ steps: 'A, B' }, {}]);
  assert.deepEqual(plain.at.map((w) => w.n), [null, null], 'a run not counted numbers nothing');
  assert.equal(stepLabel(r.runs[0], r.at[2]), 'Step 2 of 2: B');
  assert.equal(stepLabel(plain.runs[0], plain.at[1]), 'A, 1 of 2');
});

test('a data-step that names no group of its run, or sits in no run, is said and continues the group before', () => {
  const r = stepRuns([{ steps: 'A, B' }, { step: 'B' }, { step: 'Z' }, { module: true, step: 'A' }]);
  assert.deepEqual(r.unknown, [{ slide: 3, step: 'Z', groups: ['A', 'B'] }, { slide: 4, step: 'A', groups: null }]);
  assert.equal(r.at[2].group, 1, 'Z continues B');
});

test('decklight check names a data-step that is not one of its run\'s groups, from the file alone', () => {
  const html = `<div class="decklight">
    <section><h1>Cover</h1></section>
    <section data-steps="Foundation, Fresh context" data-steps-count><h2>One</h2></section>
    <section data-step="fresh context"><h2>Two</h2></section>
    <section data-step="Tools"><h2>Three</h2></section>
    <section data-module="Next"><nav class="steps"><ol><li>Plan</li><li>Ship &amp; tell</li></ol></nav><h2>Four</h2></section>
    <section data-step="Ship &amp; tell"><h2>Five</h2></section>
    <section data-steps-end data-step="Plan"><h2>Six</h2></section>
    <section><aside class="callouts"><p data-step="2">a callout's step is another word</p></aside><h2>Seven</h2></section>
  </div>`;
  const found = staticFindings(html, { exists: () => true, designSystems: () => new Map(), stylesheets: () => [] }).filter((f) => f.rule === 'step-group');
  assert.deepEqual(found.map((f) => f.slide), [4, 7]);
  assert.match(found[0].message, /^data-step="Tools" is not one of its run's groups \(Foundation, Fresh context\)/);
  assert.equal(found[0].title, 'Three');
  assert.match(found[1].message, /^data-step="Plan" is on a slide in no run/);
  assert.equal(found[0].level, 'warn');
});
