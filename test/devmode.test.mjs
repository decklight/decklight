// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The "needs dev mode" message every dev-gated action shares (SPEC PRESENTING). The
// point of the helper is that a deck opened by double-clicking it — the common
// case — gets told the folder to run from, and that every action says the same
// thing. The toasts themselves are DOM; this covers the text they carry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsDevMode } from '../src/core/devmode.js';

const FILE = { protocol: 'file:', pathname: '/Users/gp/decks/talk.html' };
const HTTP = { protocol: 'https:', pathname: '/talks/talk.html' };

test('file:// names the containing folder and the deck', () => {
  const msg = needsDevMode('layout', FILE);
  assert.match(msg, /^layout needs dev mode: /);
  assert.match(msg, /from \/Users\/gp\/decks, /);
  assert.match(msg, /run npx decklight dev talk\.html/);
  assert.match(msg, /then reopen the URL it prints$/);
});

test('an http(s) origin gets the command but never a claimed folder', () => {
  const msg = needsDevMode('layout', HTTP);
  assert.match(msg, /run npx decklight dev talk\.html/);
  assert.doesNotMatch(msg, /from \//, 'a URL path is not a filesystem path');
});

test('every action shares the one phrasing, and it is always `dev`', () => {
  for (const action of ['layout', 'undo', 'redo', 'asking an agent', 'editing notes']) {
    for (const loc of [FILE, HTTP, {}]) {
      const msg = needsDevMode(action, loc);
      assert.ok(msg.startsWith(`${action} needs dev mode: `), `${action}: ${msg}`);
      assert.match(msg, /npx decklight dev /);
      // the inconsistency this replaced: the notes editor said `decklight edit`
      assert.doesNotMatch(msg, /decklight edit/, `${action} must not say "edit"`);
    }
  }
});

test('percent-escapes in a file path are decoded for display', () => {
  const msg = needsDevMode('layout', { protocol: 'file:', pathname: '/Users/gp/my%20decks/q3%20review.html' });
  assert.match(msg, /from \/Users\/gp\/my decks, /);
  assert.match(msg, /run npx decklight dev q3 review\.html/);
});

test('a Windows file URL drops the URL-syntax leading slash', () => {
  const msg = needsDevMode('undo', { protocol: 'file:', pathname: '/C:/decks/talk.html' });
  assert.match(msg, /from C:\/decks, /);
});

test('an unreadable location still gives the command, with a placeholder deck', () => {
  for (const loc of [{}, { protocol: 'file:', pathname: '' }, { protocol: 'file:', pathname: '/talk' }]) {
    const msg = needsDevMode('layout', loc);
    assert.match(msg, /run npx decklight dev /);
    assert.ok(!msg.includes('undefined'), msg);
  }
  assert.match(needsDevMode('layout', {}), /<deck\.html>/);
});
