// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The finder's index and ranking, and the debug log's ring buffer — the two
// pieces of "what the presenter is looking for" that had lived in init()'s
// closure and so had never been asserted outside a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildIndex, rankMatches } from '../src/core/finder.js';
import { createDebugLog, DEBUG_KEEP } from '../src/core/debuglog.js';

// A section with the three things the index reads: children, their text, and
// a heading. `aside` (speaker notes), script and style are excluded by the
// same matches() the browser would use.
function section({ heading = null, paras = [], notes = null } = {}) {
  const kids = [];
  if (heading) kids.push({ tag: 'h2', textContent: heading, matches: (s) => s.includes('h2') === false && false });
  for (const p of paras) kids.push({ tag: 'p', textContent: p, matches: () => false });
  if (notes) kids.push({ tag: 'aside', textContent: notes, matches: (sel) => sel.includes('aside') });
  return {
    children: kids,
    querySelector: (sel) => (heading && sel.includes('h1') ? { textContent: heading } : null),
  };
}

test('a slide is titled by its heading, and searched by its body', () => {
  const idx = buildIndex({
    sections: [section({ heading: 'Charts', paras: ['bar line area'] })],
  });
  assert.deepEqual(idx, [{ slide: 1, title: 'Charts', haystack: 'charts bar line area' }]);
});

test('a slide with no heading is titled by its opening words, then by its number', () => {
  const idx = buildIndex({
    sections: [
      section({ paras: ['A slide that never got a title but does have prose'] }),
      section({}),
    ],
  });
  assert.equal(idx[0].title, 'A slide that never got a title but does have prose');
  assert.equal(idx[1].title, 'slide 2', 'an empty slide is still findable by its number');
});

test('speaker notes are not searchable — the audience never saw them', () => {
  const idx = buildIndex({
    sections: [section({ heading: 'Pricing', paras: ['three tiers'], notes: 'remember the discount' })],
  });
  assert.doesNotMatch(idx[0].haystack, /discount/);
});

test('the other modules of a playlist are in the index; this one is not', () => {
  const idx = buildIndex({
    sections: [section({ heading: 'Here' })],
    modules: [{ title: 'Intro', href: 'a.html' }, { title: 'This one', href: 'b.html' }],
    skipModule: 1,
  });
  assert.deepEqual(idx.map((e) => e.title), ['Here', 'Intro']);
  assert.equal(idx[1].href, 'a.html', 'a module carries the file to load');
});

test('matching is word-AND, in any order', () => {
  const idx = buildIndex({
    sections: [
      section({ heading: 'Theme tokens', paras: ['contrast'] }),
      section({ heading: 'Charts', paras: ['a themed chart'] }),
      section({ heading: 'Fonts' }),
    ],
  });
  assert.deepEqual(rankMatches(idx, 'chart theme').map((m) => m.slide), [2]);
  assert.deepEqual(rankMatches(idx, 'theme chart').map((m) => m.slide), [2], 'order does not matter');
  assert.deepEqual(rankMatches(idx, 'nothing here').map((m) => m.slide), []);
});

test('a title hit outranks every body-only hit', () => {
  const idx = buildIndex({
    sections: [
      section({ heading: 'Overview', paras: ['mentions pricing in passing'] }),
      section({ heading: 'Appendix', paras: ['pricing again'] }),
      section({ heading: 'Pricing', paras: ['the actual slide'] }),
    ],
  });
  assert.deepEqual(rankMatches(idx, 'pricing').map((m) => m.slide), [3, 1, 2],
    'the slide CALLED pricing leads, then body hits in deck order');
});

test('an empty query lists the whole deck rather than nothing', () => {
  const idx = buildIndex({ sections: [section({ heading: 'A' }), section({ heading: 'B' })] });
  assert.equal(rankMatches(idx, '').length, 2);
  assert.equal(rankMatches(idx, '   ').length, 2);
  assert.equal(rankMatches(idx, undefined).length, 2);
});

test('search is case-insensitive on both sides', () => {
  const idx = buildIndex({ sections: [section({ heading: 'Deployment Pipeline' })] });
  assert.equal(rankMatches(idx, 'DEPLOYMENT').length, 1);
});

// ── debug log ──────────────────────────────────────────────────────────────

test('the ring buffer records from the start, whether or not anyone is watching', () => {
  let clock = 1000;
  const debug = createDebugLog({ now: () => clock });
  clock = 4001;
  debug.log('tts', 'voice started');
  assert.deepEqual(debug.entries, [{ t: '3.001', kind: 'tts', msg: 'voice started' }],
    'elapsed seconds from init — the figure that ties a stall to its cause');
});

test('it keeps the last N and drops the oldest, never the newest', () => {
  const debug = createDebugLog({ now: () => 0, keep: 3 });
  for (const n of [1, 2, 3, 4, 5]) debug.log('nav', `slide ${n}`);
  assert.deepEqual(debug.entries.map((e) => e.msg), ['slide 3', 'slide 4', 'slide 5']);
  assert.equal(DEBUG_KEEP, 200, 'the real buffer is a talk\'s worth of moments');
});

test('the window attaches after the fact and gets everything from then on', () => {
  const debug = createDebugLog({ now: () => 0 });
  debug.log('boot', 'theme restored');       // before D was ever pressed
  const seen = [];
  debug.onEntry((e) => seen.push(e.msg));
  debug.log('tts', 'bridge up');
  assert.deepEqual(debug.entries.map((e) => e.msg), ['theme restored', 'bridge up'],
    'opening the window shows what already happened');
  assert.deepEqual(seen, ['bridge up'], 'and it is fed live from then on');

  debug.onEntry(null);                        // D closes
  debug.log('tts', 'bridge down');
  assert.deepEqual(seen, ['bridge up'], 'a closed window is not written to');
  assert.equal(debug.entries.length, 3, 'but the buffer keeps recording');
});
