// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Layout cycling (L / ⇧L): the ring's skip rules and the debounced
// write-through. Both are author-facing edits to a file, and both were
// previously only reachable by driving a dev server in a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LAYOUTS, ringFor, nextInRing, createLayoutCycler } from '../src/core/layout.js';

test('the ring skips entries that could not change the slide', () => {
  assert.deepEqual(ringFor({ autoPins: false, hasSplitPair: true }), LAYOUTS,
    'a slide that neither auto-pins nor has two blocks gets everything');
  assert.deepEqual(ringFor({ autoPins: true, hasSplitPair: true }),
    ['auto', 'centered', 'top', 'split', 'split-flip'],
    'pinned is pointless where auto already pins');
  assert.deepEqual(ringFor({ autoPins: false, hasSplitPair: false }),
    ['auto', 'centered', 'pinned', 'top', 'split'],
    'and split-flip where there is nothing to swap');
});

test('cycling wraps in both directions, from wherever the slide is now', () => {
  const ring = ['auto', 'centered', 'pinned'];
  assert.equal(nextInRing(ring, 'auto', 1), 'centered');
  assert.equal(nextInRing(ring, 'pinned', 1), 'auto', 'forward off the end wraps');
  assert.equal(nextInRing(ring, 'auto', -1), 'pinned', 'and back off the front');
  assert.equal(nextInRing(ring, 'not-in-ring', 1), 'centered',
    'a layout the ring skipped is treated as position 0, never as -1');
  assert.equal(nextInRing([], 'auto', 1), null);
});

// ── the cycler ─────────────────────────────────────────────────────────────

function section(attrs = {}) {
  const a = { ...attrs };
  return {
    getAttribute: (k) => a[k] ?? null,
    setAttribute: (k, v) => { a[k] = v; },
    removeAttribute: (k) => { delete a[k]; },
    hasAttribute: (k) => k in a,
    attrs: a,
  };
}

function harness({ available = true, sections = [section()], conflict = false, postFails = false } = {}) {
  let slide = 1;
  const toasts = [], logs = [], posted = [];
  let pending = null;
  const cycler = createLayoutCycler({
    slideOf: () => slide,
    sectionAt: (i) => sections[i - 1],
    describe: () => ({ autoPins: false, hasSplitPair: true }),
    available: () => available,
    unavailableMessage: () => 'run decklight author to change layouts',
    apply: (sec, name) => {
      if (name === 'auto') sec.removeAttribute('data-layout');
      else sec.setAttribute('data-layout', name);
    },
    relayout: () => conflict,
    post: (body) => { posted.push(body); return postFails ? Promise.reject(new Error('down')) : Promise.resolve(); },
    toast: (m) => toasts.push(m),
    debugLog: (_k, m) => logs.push(m),
    schedule: (fn) => { pending = fn; return 1; },
    cancel: () => { pending = null; },
  });
  return {
    cycler, toasts, logs, posted, sections,
    to: (n) => { slide = n; },
    tick: () => { const f = pending; pending = null; f?.(); },
  };
}

test('without the edit server the key explains itself and changes nothing', () => {
  const h = harness({ available: false });
  h.cycler.cycle(1);
  assert.equal(h.sections[0].getAttribute('data-layout'), null, 'no edit');
  assert.deepEqual(h.posted, [], 'and nothing sent anywhere');
  assert.deepEqual(h.toasts, ['run decklight author to change layouts']);
});

test('a pick applies instantly and is written back once the burst settles', () => {
  const h = harness();
  h.cycler.cycle(1);
  assert.equal(h.sections[0].getAttribute('data-layout'), 'centered', 'the DOM does not wait for the server');
  assert.deepEqual(h.posted, [], 'but the write is held');
  h.tick();
  assert.deepEqual(h.posted, [{ slide: 1, layout: 'centered' }]);
});

test('a cycling burst writes once — the last pick, not every keypress', () => {
  const h = harness();
  h.cycler.cycle(1);
  h.cycler.cycle(1);
  h.cycler.cycle(1);
  h.tick();
  assert.deepEqual(h.posted, [{ slide: 1, layout: 'top' }],
    'each write reloads every open browser, so a burst must be one decision');
});

test('moving to another slide flushes the pending pick instead of losing it', () => {
  const h = harness({ sections: [section(), section()] });
  h.cycler.cycle(1);              // slide 1 → centered, pending
  h.to(2);
  h.cycler.cycle(1);              // slide 2 → centered
  assert.deepEqual(h.posted, [{ slide: 1, layout: 'centered' }],
    'slide 1\'s edit was applied on screen — it must reach the file too');
  h.tick();
  assert.deepEqual(h.posted, [{ slide: 1, layout: 'centered' }, { slide: 2, layout: 'centered' }]);
});

test('going back to auto removes the attribute rather than writing "auto" onto the slide', () => {
  const h = harness({ sections: [section({ 'data-layout': 'split-flip' })] });
  h.cycler.cycle(1);
  assert.equal(h.sections[0].hasAttribute('data-layout'), false, 'auto is the absence of the attribute');
  h.tick();
  assert.deepEqual(h.posted, [{ slide: 1, layout: 'auto' }], 'and the file is told so explicitly');
});

test('a split conflict is named at the keypress, not left to a console', () => {
  const h = harness({ conflict: true });
  h.cycler.cycle(1);
  assert.match(h.toasts[0], /fights this slide's own column flexbox/);
});

test('a failed save says the server is gone — the edit is not silently lost', async () => {
  const h = harness({ postFails: true });
  h.cycler.cycle(1);
  h.tick();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(h.toasts.some((t) => /layout save failed/.test(t)));
});
