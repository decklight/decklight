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
    _qsa: 0,                                   // how often the subtree was walked
    parentElement: null,
    children,
    querySelectorAll: () => { node._qsa++; return descendants(node); },
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
  unobserve(n) { const i = this.observed.indexOf(n); if (i >= 0) this.observed.splice(i, 1); }
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
  assert.deepEqual(h.observers.resize.observed, [b], 'and a is off the resize watch, node by node');
  assert.equal(h.observers.resize.disconnects, 0,
    'the observers outlive every navigation — only their targets change');

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

// ── arming is a diff, not a rebuild ────────────────────────────────────────
//
// Every navigation used to disconnect both observers and recruit the incoming
// slide from scratch: `querySelectorAll('*')` plus a `.closest('.terminal')`
// walk per node, for a subtree that was the same subtree it was the last time
// that slide was on stage. These pin the cheaper shape — the observers live as
// long as the watch does, and a section keeps what it already had.

test('re-arming the same slide costs nothing — sync() after an in-place re-render', () => {
  const a = el({ children: [el(), el()] });
  const h = harness({ sections: [a] });
  h.watch.watch([a]);
  assert.equal(h.observers.resize.observed.length, 3, 'the section and its two descendants');
  const first = h.observers.resize.observed.slice();

  h.watch.watch([a]);      // what sync() does on every rescan
  assert.deepEqual(h.observers.resize.observed, first,
    'observe() ran a second time for nodes that never left the watch');
  assert.equal(a._qsa, 1, 'and the subtree was walked again to work out what to observe');
  assert.equal(h.observers.resize.disconnects, 0, 'nothing was torn down to do it');
  h.flush();
  assert.deepEqual(h.measured, [1], 'arming is still the measurement, every time');
});

test('going to the next slide and back does not re-derive the first one', () => {
  // The descendant list is cached per section, so the return trip is an
  // observe() per node and nothing else — no second walk of the subtree.
  const a = el({ children: [el()] }), b = el();
  const h = harness({ sections: [a, b] });
  h.watch.watch([a]);
  h.watch.watch([b]);
  h.watch.watch([a]);
  assert.equal(a._qsa, 1, 'coming back walked a’s subtree a second time');
  assert.equal(b._qsa, 1);
  assert.equal(h.observers.resize.disconnects, 0, 'the observers outlive the whole trip');
  assert.deepEqual(h.observers.resize.observed, [a, a.children[0]],
    'exactly what is on stage is on watch — no more, and no less');
  assert.deepEqual(h.watch.watched, [a]);
});

test('a childList mutation drops the cached list, so the next arming sees the new node', () => {
  const a = el();
  const h = harness({ sections: [a] });
  h.watch.watch([a]);
  h.flush();
  assert.equal(a._qsa, 1);

  const late = el();                       // content arriving into the slide
  a.children.push(late);
  late.parentElement = a;
  h.observers.mutate.cb([{ type: 'childList', target: a, addedNodes: [late] }]);
  assert.ok(h.observers.resize.observed.includes(late), 'the arriving node joins immediately');

  h.watch.watch([]);                       // off stage…
  h.watch.watch([a]);                      // …and back
  assert.equal(a._qsa, 2, 'a stale cache survived a DOM change under the section');
  assert.ok(h.observers.resize.observed.includes(late),
    'the late node must be re-armed with the rest, not dropped on the way back');
});

test('a mutation under a slide that left the stage is somebody else’s business', () => {
  // A MutationObserver has no `unobserve`, so the departed slide is still
  // registered. The filter is what makes that harmless.
  const a = el(), b = el();
  const h = harness({ sections: [a, b] });
  h.watch.watch([a]);
  h.watch.watch([b]);
  h.flush();
  h.measured.length = 0;

  h.observers.mutate.cb([{ type: 'childList', target: a, addedNodes: [el()] }]);
  h.flush();
  assert.deepEqual(h.measured, [], 'an off-stage slide re-measured the one on it');
  assert.deepEqual(h.observers.resize.observed, [b], 'and recruited its nodes into the watch');
});

test('a slide re-rendered in place is re-armed, not left holding what left', () => {
  // Dev mode replaces a slide's content under a deck that never navigates off
  // it. The nodes that went must come off the resize watch with the re-render
  // that removed them, or an authoring session accumulates registrations for
  // DOM that is long gone.
  const gone = el();
  const a = el({ children: [gone] });
  const h = harness({ sections: [a] });
  h.watch.watch([a]);
  assert.deepEqual(h.observers.resize.observed, [a, gone]);

  const fresh = el();
  a.children.length = 0;
  a.children.push(fresh);
  fresh.parentElement = a;
  gone.parentElement = null;
  h.observers.mutate.cb([{ type: 'childList', target: a, addedNodes: [fresh] }]);
  h.watch.watch([a]);                      // what sync() does after a re-render
  assert.deepEqual(h.observers.resize.observed, [a, fresh],
    'the replaced node is still on the resize watch');
  assert.equal(h.observers.resize.disconnects, 0, 'and it took no teardown to drop it');
  assert.equal(a._listeners.length, 2, 'load + error, not doubled by the re-arm');
});
