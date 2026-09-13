// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The live half of SPEC BUILDS. test/builds.test.mjs covers computeGroups —
// the pure sequencer — and stops there; everything the engine does WITH those
// groups had no test at all, because reaching it meant booting a deck in a
// browser: which children a container claims, what state each step is left in
// at step k (SPEC BUILD_SEMANTICS), whether a registered provider is told to
// move twice for the same number, and what the speaker view calls a step
// (SPEC PRESENTING). None of that needs a renderer — it is attributes,
// classes and call counts — so a hand-rolled element carrying only the members
// the module actually touches is enough.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scanSlide, applyBuildState, stepLabels, registerProvider } from '../src/core/builds.js';

// ── the smallest element the module can work on ────────────────────────────
// Members used by builds.js on a non-`draw` slide: tagName, children,
// classList{add,remove,contains,toggle}, get/set/hasAttribute, textContent,
// querySelector/querySelectorAll. `matches`/`dataset` belong to the draw path
// only, which needs getComputedStyle and getTotalLength and so stays out here.

function descendants(node, out = []) {
  for (const c of node.children) { out.push(c); descendants(c, out); }
  return out;
}

// A single compound selector: `tag`, `.cls`, `[attr]`, `[attr="v"]`, or a run
// of those. Enough for every selector builds.js passes.
function matchesSimple(node, sel) {
  const parts = sel.match(/\*|^[a-zA-Z][\w-]*|\[[^\]]+\]|\.[\w-]+/g) ?? [];
  return parts.length > 0 && parts.every((p) => {
    if (p === '*') return true;
    if (p[0] === '.') return node.classList.contains(p.slice(1));
    if (p[0] === '[') {
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(p);
      return m[2] === undefined ? node.hasAttribute(m[1]) : node.getAttribute(m[1]) === m[2];
    }
    return node.tagName.toLowerCase() === p.toLowerCase();
  });
}

function queryAll(node, sel) {
  return String(sel).split(',').flatMap((raw) => {
    const s = raw.trim().replace(/^:scope\s*/, '');
    if (s.startsWith('>')) return node.children.filter((c) => matchesSimple(c, s.slice(1).trim()));
    return descendants(node).filter((c) => matchesSimple(c, s));
  });
}

function el(tag, { attrs = {}, text = '', children = [] } = {}) {
  const a = {};
  for (const [k, v] of Object.entries(attrs)) a[k.toLowerCase()] = String(v);
  const classes = new Set();
  const node = {
    tagName: tag.toUpperCase(),
    children,
    classes,
    classList: {
      add: (c) => { classes.add(c); },
      remove: (c) => { classes.delete(c); },
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    getAttribute: (k) => (k.toLowerCase() in a ? a[k.toLowerCase()] : null),
    setAttribute: (k, v) => { a[k.toLowerCase()] = String(v); },
    removeAttribute: (k) => { delete a[k.toLowerCase()]; },
    hasAttribute: (k) => k.toLowerCase() in a,
    get textContent() { return text + children.map((c) => c.textContent).join(''); },
    querySelectorAll: (sel) => queryAll(node, sel),
    querySelector: (sel) => queryAll(node, sel)[0] ?? null,
  };
  return node;
}

// scanSlide walks with document.createTreeWalker, so `document` and
// `NodeFilter` have to exist at call time. Installed per test and put back.
function installDom(t) {
  const had = { doc: 'document' in globalThis, nf: 'NodeFilter' in globalThis };
  const prev = { doc: globalThis.document, nf: globalThis.NodeFilter };
  globalThis.document = {
    createTreeWalker: (root) => {
      const nodes = descendants(root); // a real walker starts ON the root: it never returns it
      let i = 0;
      return { nextNode: () => (i < nodes.length ? nodes[i++] : null) };
    },
  };
  globalThis.NodeFilter = { SHOW_ELEMENT: 0x1 };
  t.after(() => {
    if (had.doc) globalThis.document = prev.doc; else delete globalThis.document;
    if (had.nf) globalThis.NodeFilter = prev.nf; else delete globalThis.NodeFilter;
  });
}

const states = (els) => els.map((e) => e.getAttribute('data-build-state'));

// ── scanSlide ──────────────────────────────────────────────────────────────

test('a list that opts in yields one step per item, and the list itself is not a step', (t) => {
  installDom(t);
  const items = ['one', 'two', 'three'].map((s) => el('li', { text: s }));
  const ul = el('ul', { attrs: { 'data-build': '' }, children: items });
  const section = el('section', { children: [el('h2', { text: 'Title' }), ul] });

  const record = scanSlide(section);

  assert.equal(record.steps.length, 3, 'the container opts in; the engine claims its children');
  assert.deepEqual(record.groups, [[0], [1], [2]], 'plain items advance one at a time');
  assert.deepEqual(record.steps.map((s) => s.el), items, 'in document order');
  assert.deepEqual(record.steps.map((s) => s.container), [ul, ul, ul],
    'each step remembers its container — that is what the highlight dimming keys on');
  assert.ok(items.every((i) => i.classList.contains('build-step')),
    'the class is what the stylesheet hangs the transition on');
  assert.deepEqual(items.map((i) => i.getAttribute('data-build-style')), ['fade', 'fade', 'fade'],
    'a bare data-build means fade, not an empty style name');
  assert.deepEqual(states(items), ['pending', 'pending', 'pending'],
    'a scanned slide starts fully un-built, before anyone applies a step');
  assert.equal(ul.hasAttribute('data-build-container'), true,
    'the container is marked so CSS can address it without becoming a step');
  assert.equal(ul.classList.contains('build-step'), false, 'the container never animates itself');
});

test('an item may override the container style, and a leaf is its own single step', (t) => {
  installDom(t);
  const loud = el('li', { attrs: { 'data-build': 'highlight' }, text: 'loud' });
  const ul = el('ul', { attrs: { 'data-build': 'fade' }, children: [el('li', { text: 'quiet' }), loud] });
  const p = el('p', { attrs: { 'data-build': 'rise' }, text: 'alone' });
  const section = el('section', { children: [ul, p] });

  const record = scanSlide(section);

  assert.equal(record.steps.length, 3, 'two claimed children plus one leaf');
  assert.equal(loud.getAttribute('data-build-style'), 'highlight', 'the child wins over the container');
  assert.equal(record.steps[2].container, null, 'a leaf has no container to dim');
  assert.equal(p.getAttribute('data-build-style'), 'rise');
});

// ── applyBuildState ────────────────────────────────────────────────────────

function threeStepRecord() {
  const items = ['alpha', 'beta', 'gamma'].map((s) => el('li', { text: s }));
  const ul = el('ul', { attrs: { 'data-build': '' }, children: items });
  return { items, ul, record: scanSlide(el('section', { children: [ul] })) };
}

test('step 0 reveals nothing, and applying it twice changes nothing', (t) => {
  installDom(t);
  const { items, record } = threeStepRecord();

  applyBuildState(record, 0);
  assert.deepEqual(states(items), ['pending', 'pending', 'pending'],
    'arriving on a slide shows none of its builds');
  applyBuildState(record, 0);
  assert.deepEqual(states(items), ['pending', 'pending', 'pending'],
    'idempotence is what lets the engine re-apply on resize, print and reload');
});

test('at step k exactly one group is current and every earlier one is done', (t) => {
  installDom(t);
  const { items, record } = threeStepRecord();

  applyBuildState(record, 1);
  assert.deepEqual(states(items), ['current', 'pending', 'pending'],
    'the step just taken is current — that is the one the animation runs on');
  applyBuildState(record, 2);
  assert.deepEqual(states(items), ['done', 'current', 'pending'],
    'what was current becomes done rather than staying lit');
  applyBuildState(record, 3);
  assert.deepEqual(states(items), ['done', 'done', 'current']);
  applyBuildState(record, 3);
  assert.deepEqual(states(items), ['done', 'done', 'current'], 'still idempotent at the end');
});

test('going backwards un-builds, so a slide re-entered from the right is not stuck revealed', (t) => {
  installDom(t);
  const { items, record } = threeStepRecord();
  applyBuildState(record, 3);
  applyBuildState(record, 0);
  assert.deepEqual(states(items), ['pending', 'pending', 'pending'],
    'stepping back is the same code path as stepping forward');
});

test('a container dims its siblings only while a highlight step is current', (t) => {
  installDom(t);
  const items = ['a', 'b'].map((s) => el('li', { text: s }));
  const ul = el('ul', { attrs: { 'data-build': 'highlight' }, children: items });
  const record = scanSlide(el('section', { children: [ul] }));

  applyBuildState(record, 0);
  assert.equal(ul.classList.contains('has-current-highlight'), false, 'nothing is lit yet');
  applyBuildState(record, 1);
  assert.equal(ul.classList.contains('has-current-highlight'), true,
    'the class is what dims the OTHER rows while one is being read out');
  applyBuildState(record, 2);
  assert.equal(ul.classList.contains('has-current-highlight'), true);
  applyBuildState(record, 0);
  assert.equal(ul.classList.contains('has-current-highlight'), false,
    'the dimming is removed again, not left on the container for the rest of the talk');
});

// ── providers ──────────────────────────────────────────────────────────────

test('a provider contributes one step per unit and is handed its own revealed count', (t) => {
  installDom(t);
  const calls = [];
  const chart = el('div', { children: [el('span', { attrs: { 'data-build': '' }, text: 'inner' })] });
  registerProvider(chart, { count: 3, apply: (k) => calls.push(k) });
  const record = scanSlide(el('section', { children: [chart] }));

  assert.equal(record.steps.length, 3, 'count units, count steps');
  assert.deepEqual(record.steps.map((s) => s.sub), [0, 1, 2]);
  assert.equal(record.providers.length, 1);
  assert.deepEqual(record.providers[0].stepIdxs, [0, 1, 2]);
  assert.deepEqual(calls, [], 'scanning alone must not move anything');

  applyBuildState(record, 2);
  assert.deepEqual(calls, [2], 'the provider is told how many of ITS units are showing, not the slide step');
});

test("a provider's subtree is opaque — its own data-build markup is not also a step", (t) => {
  installDom(t);
  const inner = el('span', { attrs: { 'data-build': '' }, text: 'series' });
  const chart = el('div', { children: [inner] });
  registerProvider(chart, { count: 2, apply: () => {} });
  const record = scanSlide(el('section', { children: [chart] }));

  assert.equal(record.steps.length, 2, 'the provider owns the whole element; nothing inside it is claimed twice');
  assert.ok(record.steps.every((s) => s.kind === 'provider'));
  assert.equal(inner.classList.contains('build-step'), false);
});

test('a provider is applied once per distinct count, never again for the same one', (t) => {
  installDom(t);
  const calls = [];
  const chart = el('div');
  registerProvider(chart, { count: 3, apply: (k) => calls.push(k) });
  const record = scanSlide(el('section', { children: [chart] }));

  applyBuildState(record, 0);
  assert.deepEqual(calls, [0], 'the first apply establishes the zero state');
  applyBuildState(record, 0);
  assert.deepEqual(calls, [0],
    're-applying the same state must not re-run the animation — the _last guard is what makes a resize free');
  applyBuildState(record, 1);
  applyBuildState(record, 1);
  applyBuildState(record, 3);
  assert.deepEqual(calls, [0, 1, 3], 'only genuine changes reach the provider');
  applyBuildState(record, 0);
  assert.deepEqual(calls, [0, 1, 3, 0], 'and stepping back is a change like any other');
});

// ── stepLabels (speaker view) ──────────────────────────────────────────────

test('a step is labelled by its own text, with whitespace collapsed', (t) => {
  installDom(t);
  const ul = el('ul', {
    attrs: { 'data-build': '' },
    children: [el('li', { text: '  the   first\n  point ' })],
  });
  const record = scanSlide(el('section', { children: [ul] }));
  assert.deepEqual(stepLabels(record), ['the first point'],
    'the speaker view is a narrow column — a label wrapped over the file\'s line breaks is unreadable');
});

test('a long label is cut to 60 characters', (t) => {
  installDom(t);
  const long = 'x'.repeat(200);
  const ul = el('ul', { attrs: { 'data-build': '' }, children: [el('li', { text: long })] });
  const record = scanSlide(el('section', { children: [ul] }));
  const [label] = stepLabels(record);
  assert.equal(label.length, 60, 'the cut is at 60, so the next-step line stays one line');
  assert.equal(label, 'x'.repeat(60));
});

test('a step with no text of its own falls back to its tag name', (t) => {
  installDom(t);
  const ul = el('ul', {
    attrs: { 'data-build': '' },
    children: [el('img'), el('li', { text: 'and a real one' })],
  });
  const record = scanSlide(el('section', { children: [ul] }));
  assert.deepEqual(stepLabels(record), ['img', 'and a real one'],
    'an image or a shape still needs a row the presenter can count');
});

test("a provider names its own steps, or the speaker view says 'step'", (t) => {
  installDom(t);
  const named = el('div');
  registerProvider(named, { count: 2, apply: () => {}, label: (n) => `bar ${n}` });
  const anon = el('div');
  registerProvider(anon, { count: 1, apply: () => {} });
  const record = scanSlide(el('section', { children: [named, anon] }));

  assert.deepEqual(stepLabels(record), ['bar 1', 'bar 2', 'step'],
    'a labelled provider is 1-based for a human; an unlabelled one still occupies a row');
});
