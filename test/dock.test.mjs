// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// src/core/dock.js: the slot remembers which panel holds it, and reopens it
// after the reload a save causes. A docked panel that vanished on the HTML
// editor's ⌘⏎ read as ⌘⏎ closing it (#807); the panel was fine, the reload
// was not. No DOM: a panel is its hooks, a root is an object with a style,
// and sessionStorage is a Map that can also be made to throw like file://.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDock, reopenPanel } from '../src/core/dock.js';

/** A sessionStorage that behaves, or one that throws on every call. */
function storage({ throws = false } = {}) {
  const m = new Map();
  const die = () => { throw new Error('SecurityError'); };
  return throws
    ? { getItem: die, setItem: die, removeItem: die }
    : { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

/** A root and the panels that share its slot, each open/closed by flipping its element. */
function harness(t, { store = storage() } = {}) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { value: store, configurable: true, writable: true });
  t.after(() => {
    if (had) Object.defineProperty(globalThis, 'sessionStorage', had);
    else delete globalThis.sessionStorage;
  });
  const root = { style: { setProperty() {} }, clientWidth: 1200, clientHeight: 700 };
  const panel = ({ name, opens = true, available = () => true, tab = true }) => {
    const p = { name, el: null, opened: 0 };
    const el = () => ({ dataset: {}, style: { setProperty() {} }, querySelector: () => null });
    p.dock = createDock({
      root, getEl: () => p.el, name, tab, available,
      open: opens ? () => { p.opened++; p.el = el(); p.dock.reserveGutter(); } : null,
      close: () => { p.el = null; p.dock.release(); },
    });
    p.open = () => { p.el = el(); p.dock.reserveGutter(); };   // opened by hand, as a key does
    p.close = () => { p.el = null; p.dock.release(); };
    return p;
  };
  return { root, panel, store };
}

const KEY = 'decklight-panel-open:';   // no `location` under node: the path is empty

test('the panel that takes the slot is remembered, the one it displaced is forgotten, a close forgets', (t) => {
  const { panel, store } = harness(t);
  const notes = panel({ name: 'Notes' });
  const inspector = panel({ name: 'Inspector' });
  notes.open();
  assert.equal(store.getItem(KEY), 'Notes');
  inspector.open();   // takes the slot: the notes close and forget, the inspector is the one remembered
  assert.equal(notes.el, null, 'one panel beside the slide');
  assert.equal(store.getItem(KEY), 'Inspector');
  inspector.close();
  assert.equal(store.getItem(KEY), null, 'closed on purpose is not reopened later');
});

test('after a reload the remembered panel is opened again, once, through its own open hook', (t) => {
  const { root, panel, store } = harness(t);
  const inspector = panel({ name: 'Inspector' });
  panel({ name: 'Notes' });
  store.setItem(KEY, 'Inspector');   // what the tab held when the page went away
  assert.equal(reopenPanel(root), true);
  assert.equal(inspector.opened, 1);
  assert.ok(inspector.el, 'open');
  assert.equal(store.getItem(KEY), 'Inspector', 'and remembered again, for the next reload');
  assert.equal(reopenPanel(root), false, 'the slot is taken now: nothing more to do');
  assert.equal(inspector.opened, 1);
});

test('a panel that remembered itself in more detail wins: a slot already taken is left alone', (t) => {
  const { root, panel, store } = harness(t);
  const notes = panel({ name: 'Notes' });
  const inspector = panel({ name: 'Inspector' });
  notes.open();   // editmode.js reopened the notes first, caret and all
  store.setItem(KEY, 'Inspector');
  assert.equal(reopenPanel(root), false);
  assert.equal(inspector.opened, 0);
  assert.ok(notes.el);
});

test('a panel with no open hook (the HTML editor) and one not available here are not reopened', (t) => {
  const { root, panel, store } = harness(t);
  const html = panel({ name: 'HTML', opens: false, tab: false });
  const agent = panel({ name: 'Agent', available: () => false });
  store.setItem(KEY, 'HTML');
  assert.equal(reopenPanel(root), false);
  assert.equal(html.el, null);
  store.setItem(KEY, 'Agent');
  assert.equal(reopenPanel(root), false);
  assert.equal(agent.opened, 0);
  store.setItem(KEY, 'Nobody');
  assert.equal(reopenPanel(root), false);
});

test('where sessionStorage throws, the slot forgets quietly and a reload closes the panel as before', (t) => {
  const { root, panel } = harness(t, { store: storage({ throws: true }) });
  const inspector = panel({ name: 'Inspector' });
  assert.doesNotThrow(() => { inspector.open(); inspector.close(); });
  assert.equal(reopenPanel(root), false);
});
