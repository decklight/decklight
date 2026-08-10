// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The overflow WATCH — when a slide gets measured, not what overflowing means.
//
// This is the half of the guardrail that had never been unit-tested, because
// it lived inside init()'s closure and could only be reached by driving a real
// browser (test/overflow-render.mjs). Both of its shipped bugs were about
// WHEN: #184 latched a single measurement one frame after activation, and #251
// stopped watching nodes that arrived after arming. A render harness catches
// those only if someone thinks to write the exact scenario; these do not need
// a browser at all, because every observer is injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOverflowWatch } from '../src/core/overflow.js';

// ── a DOM small enough to reason about ─────────────────────────────────────
// Only what the watch actually touches: listeners, a subtree, and closest().
function el({ terminal = false, children = [] } = {}) {
  const node = {
    nodeType: 1,
    isConnected: true,
    _terminal: terminal,
    _listeners: [],
    parentElement: null,
    children,
    querySelectorAll: () => descendants(node),
    addEventListener: (t, fn, capture) => node._listeners.push([t, fn, capture]),
    removeEventListener: (t, fn) => {
      const i = node._listeners.findIndex(([lt, lfn]) => lt === t && lfn === fn);
      if (i >= 0) node._listeners.splice(i, 1);
    },
    closest: (sel) => (sel === '.terminal' && node._terminal ? node : null),
    fire: (type) => node._listeners.filter(([t]) => t === type)
      .forEach(([, fn]) => fn({ target: node })),
  };
  for (const c of children) c.parentElement = node;
  return node;
}
const descendants = (n) => n.children.flatMap((c) => [c, ...descendants(c)]);

class FakeObserver {
  constructor(cb) { this.cb = cb; this.observed = []; this.disconnects = 0; }
  observe(n) { this.observed.push(n); }
  disconnect() { this.disconnects++; this.observed = []; }
}

/** A watch whose scheduler and observers are ours, plus the calls it makes. */
function harness({ sections = [] } = {}) {
  const measured = [];
  let pending = null;
  const observers = { resize: null, mutate: null };
  const watch = createOverflowWatch({
    sectionsOf: () => sections,
    checkOverflow: (section, slideNo) => measured.push(slideNo),
    ResizeObs: class extends FakeObserver { constructor(cb) { super(cb); observers.resize = this; } },
    MutationObs: class extends FakeObserver { constructor(cb) { super(cb); observers.mutate = this; } },
    schedule: (fn) => { pending = fn; return 1; },
  });
  return { watch, measured, observers, flush: () => { const f = pending; pending = null; f?.(); } };
}

test('arming is itself the first measurement — not a promise of a later one', () => {
  const a = el(), b = el();
  const h = harness({ sections: [a, b] });
  h.watch.watch([b]);
  assert.deepEqual(h.measured, [], 'nothing measured synchronously');
  h.flush();
  assert.deepEqual(h.measured, [2], 'the watched section, by its slide number');
});

test('a burst of mutations coalesces into one measurement', () => {
  const a = el();
  const h = harness({ sections: [a] });
  h.watch.watch([a]);
  h.observers.mutate.cb([{ target: a, addedNodes: [] }]);
  h.observers.mutate.cb([{ target: a, addedNodes: [] }]);
  h.observers.resize.cb();
  h.flush();
  assert.deepEqual(h.measured, [1], 'one pass, not four — a mount moves many nodes at once');
});

test('a node that arrives after arming joins the resize watch (#251)', () => {
  const a = el();
  const h = harness({ sections: [a] });
  h.watch.watch([a]);
  h.flush();

  const late = el({ children: [el()] });          // an arriving subtree
  h.observers.mutate.cb([{ target: a, addedNodes: [late] }]);
  assert.ok(h.observers.resize.observed.includes(late),
    'the arriving node is watched, or its own later growth reports nothing');
  assert.ok(h.observers.resize.observed.includes(late.children[0]),
    'and so is its subtree — an image decoding inside it moves no box above it');
  h.flush();
  assert.deepEqual(h.measured, [1, 1]);
});

test('late media re-measures without any frame — the headless case', () => {
  // ResizeObserver delivery rides the rendering pipeline, and under
  // --virtual-time-budget there are no more frames once the page goes idle.
  // load/error are plain tasks, which is why they are the third ear.
  const a = el();
  const h = harness({ sections: [a] });
  h.watch.watch([a]);
  h.flush();
  h.measured.length = 0;

  a.fire('load');
  h.flush();
  assert.deepEqual(h.measured, [1], 'a subresource landing re-runs the check');
});

test('terminals are ignored — a playing cast must not re-measure 60× a second', () => {
  const term = el({ terminal: true });
  const a = el({ children: [term] });
  const h = harness({ sections: [a] });
  h.watch.watch([a]);
  h.flush();
  h.measured.length = 0;

  h.observers.mutate.cb([{ target: term, addedNodes: [] }]);
  h.flush();
  assert.deepEqual(h.measured, [], 'a terminal rewriting its screen is not late growth');

  term.fire('load');
  h.flush();
  assert.deepEqual(h.measured, [], 'nor is media inside one');
});

test('re-aiming drops the previous slide entirely, listeners included', () => {
  const a = el(), b = el();
  const h = harness({ sections: [a, b] });
  h.watch.watch([a]);
  h.flush();
  assert.equal(a._listeners.length, 2, 'load + error, captured');

  h.watch.watch([b]);
  h.flush();
  assert.equal(a._listeners.length, 0, 'the old slide is released, not left listening');
  assert.deepEqual(h.watch.watched, [b]);
  assert.equal(h.observers.resize.disconnects, 2, 'every arm starts by dropping the last one');

  h.measured.length = 0;
  a.fire('load');
  h.flush();
  assert.deepEqual(h.measured, [], 'a slide no longer on stage does not re-measure');
});

test('no observers at all (an old engine, a headless shim) still measures on arm', () => {
  const a = el();
  const measured = [];
  let pending = null;
  const watch = createOverflowWatch({
    sectionsOf: () => [a],
    checkOverflow: (_s, n) => measured.push(n),
    ResizeObs: null,
    MutationObs: null,
    schedule: (fn) => { pending = fn; return 1; },
  });
  watch.watch([a]);
  pending();
  assert.deepEqual(measured, [1], 'the guardrail degrades to one measurement, never to none');
});
