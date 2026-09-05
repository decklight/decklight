// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// src/core/prefs.js — the one rule about localStorage: it THROWS, and a deck
// must play anyway. Sixteen hand-rolled try/catches across seven files were
// that rule copied; this is the rule tested once, with the storage that
// actually throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPref, readJson, writePref, writeJson } from '../src/core/prefs.js';

const working = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
};
/** The storage private mode and file:// give you: every call throws. */
const denied = () => ({
  getItem() { throw new Error('SecurityError: denied'); },
  setItem() { throw new Error('SecurityError: denied'); },
  removeItem() { throw new Error('SecurityError: denied'); },
});
const withStorage = (t, s) => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (s === undefined) delete globalThis.localStorage;
  else Object.defineProperty(globalThis, 'localStorage', { value: s, configurable: true, writable: true });
  t.after(() => { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage; });
};

test('a string round-trips, absence is the fallback, and null forgets the key', (t) => {
  const s = working(); withStorage(t, s);
  assert.equal(readPref('theme'), null);
  assert.equal(readPref('theme', 'paper'), 'paper');
  assert.equal(writePref('theme', 'ink'), true);
  assert.equal(readPref('theme'), 'ink');
  assert.equal(writePref('speed', 1.25), true, 'a number is stored as its string');
  assert.equal(readPref('speed'), '1.25');
  assert.equal(writePref('theme', null), true);
  assert.equal(s._map.has('theme'), false, 'null did not remove the key');
});

test('JSON round-trips, and a malformed or empty value is the fallback rather than a throw', (t) => {
  const s = working(); withStorage(t, s);
  assert.equal(writeJson('dock', { mode: 'left', x: 3 }), true);
  assert.deepEqual(readJson('dock'), { mode: 'left', x: 3 });
  s.setItem('dock', '{not json');
  assert.deepEqual(readJson('dock', { mode: 'float' }), { mode: 'float' }, 'malformed JSON reached a caller');
  s.setItem('dock', 'null');
  assert.deepEqual(readJson('dock', {}), {}, 'a stored null is not a preference');
  assert.deepEqual(readJson('never', {}), {});
});

test('a storage that throws — private mode, file:// — is a fallback and a false, never an exception', (t) => {
  withStorage(t, denied());
  // THE RULE. Every one of the sixteen sites this replaced was guarding this,
  // and none of them had a test that made storage actually throw.
  assert.equal(readPref('theme', 'paper'), 'paper');
  assert.equal(readJson('dock', { mode: 'float' }).mode, 'float');
  assert.equal(writePref('theme', 'ink'), false);
  assert.equal(writeJson('dock', {}), false);
  assert.equal(writePref('theme', null), false, 'even forgetting fails quietly');
});

test('no storage object at all is the same as one that throws', (t) => {
  withStorage(t, undefined);
  assert.equal(readPref('k', 'x'), 'x');
  assert.equal(writePref('k', 'v'), false);
});
