// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The debug log across a reload (PRESENTING, debug log): the page leaving
// stashes its buffer and the reason the server gave, the page arriving seeds
// its log from it and says the reason first. And the server's side of the
// reason: which write a reload carries, and what it is called.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDebugLog, stashDebug, unstashDebug, reloadLine, debugStashKey, DEBUG_KEEP } from '../src/core/debuglog.js';
import { whatWrote, describeReload, RELOAD_WRITE_WINDOW_MS } from '../cli/edit.mjs';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), size: () => m.size };
};

test('the buffer stashed by one page seeds the next, marked as the page before, and the stash is read once', () => {
  const store = memory();
  const log = createDebugLog({ now: () => 1000 });
  log.log('ready', 'deck up');
  log.log('edit', 'notes card open');
  stashDebug(store, '/talk.html', log.entries, 'notes saved · this tab', () => 5000);
  assert.equal(store.getItem(debugStashKey('/talk.html')) !== null, true);

  const got = unstashDebug(store, '/talk.html', () => 6000);
  assert.deepEqual(got.reason, 'notes saved · this tab');
  assert.equal(got.entries.length, 2);
  assert.equal(store.size(), 0, 'taken: a second page must not see it');

  const next = createDebugLog({ now: () => 9000, seed: got.entries });
  assert.deepEqual(next.entries.map((e) => [e.kind, e.msg, e.prev]), [['ready', 'deck up', true], ['edit', 'notes card open', true]]);
  const fresh = next.log('reload', '↻ reloaded — ' + got.reason);
  assert.equal(fresh.prev, undefined, 'this page\'s own rows are not dimmed');
  assert.equal(fresh.t, '0.000', 'this page\'s clock starts at its own init');
});

test('a stale, missing or malformed stash is nothing, and a seed never exceeds the ring', () => {
  const store = memory();
  assert.equal(unstashDebug(store, '/talk.html'), null);
  stashDebug(store, '/talk.html', [{ t: '1.000', kind: 'x', msg: 'old' }], 'whatever', () => 0);
  assert.equal(unstashDebug(store, '/talk.html', () => 61_000), null, 'older than a minute is another session');
  assert.equal(store.size(), 0, 'a stale stash is cleared on the way');
  store.setItem(debugStashKey('/talk.html'), '{not json');
  assert.equal(unstashDebug(store, '/talk.html'), null);
  store.setItem(debugStashKey('/talk.html'), JSON.stringify({ t: Date.now(), entries: 'nope' }));
  assert.equal(unstashDebug(store, '/talk.html'), null);
  // a stash without a reason: the browser's own reload
  stashDebug(store, '/talk.html', [], null, () => 0);
  assert.equal(unstashDebug(store, '/talk.html', () => 10).reason, null);
  // per deck
  stashDebug(store, '/a.html', [{ t: '0.100', kind: 'x', msg: 'a' }], 'r', () => 0);
  assert.equal(unstashDebug(store, '/b.html', () => 10), null);
  // the ring: a longer seed keeps its newest entries
  const many = Array.from({ length: DEBUG_KEEP + 50 }, (_, i) => ({ t: String(i), kind: 'k', msg: 'm' + i }));
  const log = createDebugLog({ seed: many });
  assert.equal(log.entries.length, DEBUG_KEEP);
  assert.equal(log.entries[0].msg, 'm50');
});

test('the reload line names the write and whose tab it came from; an older server\'s bare reload still reads', () => {
  assert.equal(reloadLine(JSON.stringify({ reload: 'notes saved', from: 'p1' }), 'p1'), 'notes saved · this tab');
  assert.equal(reloadLine(JSON.stringify({ reload: 'notes saved', from: 'p2' }), 'p1'), 'notes saved · another tab');
  assert.equal(reloadLine(JSON.stringify({ reload: 'claude\'s edit', from: null }), 'p1'), 'claude\'s edit');
  assert.equal(reloadLine('reload', 'p1'), 'the file changed');
  assert.equal(reloadLine('{"nope":1}', 'p1'), 'the file changed');
});

test('the server names its writes, and the reason a reload carries is the latest write, the agent, or the disk', () => {
  assert.equal(whatWrote('/deck/edit/slide/notes'), 'notes saved');
  assert.equal(whatWrote('/deck/edit/undo'), 'undo (Z)');
  assert.equal(whatWrote('/deck/upstream/pull'), 'git pull');
  assert.equal(whatWrote('/deck/edit/something/new'), 'something new written', 'an unlisted route still reads');
  assert.equal(whatWrote(undefined), 'the deck written');

  const at = 10_000;
  assert.deepEqual(describeReload({ write: { at, what: 'notes saved', from: 'p1' }, now: at + 300 }), { reload: 'notes saved', from: 'p1' });
  assert.deepEqual(describeReload({ write: { at, what: 'notes saved', from: 'p1' }, now: at + RELOAD_WRITE_WINDOW_MS + 1 }),
    { reload: 'changed on disk — an editor, git, or a tool outside this server', from: null }, 'a write long past is not this reload\'s');
  assert.deepEqual(describeReload({ write: { at, what: 'undo (Z)' }, agent: { agent: 'claude' }, now: at + 100 }), { reload: 'undo (Z)', from: null },
    'the server\'s own write wins over a running agent');
  assert.deepEqual(describeReload({ agent: { agent: 'claude' }, now: at }), { reload: 'claude\'s edit', from: null });
  assert.deepEqual(describeReload({}), { reload: 'changed on disk — an editor, git, or a tool outside this server', from: null });
});
