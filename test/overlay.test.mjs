// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The shared overlay mechanics: wrap-around selection, and the typeahead
// keyboard the palette, the slide finder and the font picker all use.
//
// The keyboard was written out three times inside init(), which is how the
// interesting rule — Escape clears the query before it closes the list — came
// to be a thing three copies had to agree on with nothing checking that they
// did.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectInList, typeaheadKeydown } from '../src/core/overlay.js';

const row = () => ({
  _cls: new Set(),
  classList: {
    toggle(c, on) { if (on) this._owner._cls.add(c); else this._owner._cls.delete(c); },
  },
  scrollIntoView() { this.scrolled = true; },
});
function rows(n) {
  return Array.from({ length: n }, () => {
    const r = row();
    r.classList._owner = r;
    return r;
  });
}

test('selection wraps in both directions and marks exactly one row', () => {
  const list = rows(3);
  assert.equal(selectInList(list, 1, 'sel'), 1);
  assert.deepEqual(list.map((r) => r._cls.has('sel')), [false, true, false]);
  assert.equal(selectInList(list, 3, 'sel'), 0, 'past the end wraps to the top');
  assert.equal(selectInList(list, -1, 'sel'), 2, 'and before the start to the bottom');
  assert.deepEqual(list.map((r) => r._cls.has('sel')), [false, false, true]);
});

test('a list that should not chase its selection is not scrolled', () => {
  const list = rows(2);
  selectInList(list, 1, 'sel', { scroll: false });
  assert.ok(!list[1].scrolled);
});

// ── the typeahead keyboard ─────────────────────────────────────────────────

function harness(query = '') {
  const calls = [];
  const opts = {
    query,
    onMove: (d) => calls.push(`move ${d}`),
    onCommit: () => calls.push('commit'),
    onType: (c) => calls.push(`type ${c}`),
    onBackspace: () => calls.push('backspace'),
    onClear: () => calls.push('clear'),
    onClose: () => calls.push('close'),
  };
  return { calls, press: (key) => typeaheadKeydown({ key }, opts) };
}

test('arrows move, Enter commits, printable characters type', () => {
  const h = harness();
  for (const k of ['ArrowDown', 'ArrowUp', 'Enter', 'a', 'Z', ' ']) assert.equal(h.press(k), true, k);
  assert.deepEqual(h.calls, ['move 1', 'move -1', 'commit', 'type a', 'type Z', 'type  ']);
});

test('Escape clears a query first, and only closes once it is empty', () => {
  // four characters typed into the wrong list should cost four characters,
  // not the list — and the second Escape is pressed without thinking
  const typed = harness('chart');
  assert.equal(typed.press('Escape'), true);
  assert.deepEqual(typed.calls, ['clear']);

  const empty = harness('');
  empty.press('Escape');
  assert.deepEqual(empty.calls, ['close']);
});

test('a list with no query at all takes the movement half and drops the rest', () => {
  // the font picker: nothing to type into
  const calls = [];
  const opts = { onMove: (d) => calls.push(`move ${d}`), onCommit: () => calls.push('commit'), onClose: () => calls.push('close') };
  assert.equal(typeaheadKeydown({ key: 'ArrowDown' }, opts), true);
  assert.equal(typeaheadKeydown({ key: 'x' }, opts), false, 'a printable key is not consumed');
  assert.equal(typeaheadKeydown({ key: 'Backspace' }, opts), false, 'nor is backspace');
  assert.equal(typeaheadKeydown({ key: 'Escape' }, opts), true);
  assert.deepEqual(calls, ['move 1', 'close']);
});

test('an unhandled key is reported as not consumed, so the deck can drop it', () => {
  const h = harness('q');
  assert.equal(h.press('F5'), false);
  assert.equal(h.press('Shift'), false, 'a modifier name is longer than one character');
  assert.deepEqual(h.calls, []);
});
