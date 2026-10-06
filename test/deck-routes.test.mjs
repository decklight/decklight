// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The deck's channel is one implementation for both modes (cli/deck-routes.mjs,
// SPEC PRESENTING): the probe's shape is this module's, and a mode adds its
// extras rather than its own copy of the whole.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeckRoutes } from '../cli/deck-routes.mjs';

const review = { ping: () => ({ mode: 'write', git: false, by: 'Me <me@x>', store: 'talk.review.jsonl' }) };

/** A handler's answer, captured. */
function call(handler, extra = {}) {
  let out;
  const json = (code, obj, headers = {}) => { out = { code, obj, headers }; };
  return Promise.resolve(handler({ json, CORS: { 'access-control-allow-origin': 'null' }, ...extra })).then(() => out);
}

test('the probe says the mode, the lock, the review block and then the mode\'s extras, computed per call', async () => {
  let locked = false;
  let n = 0;
  const d = createDeckRoutes('/tmp/talk.html', { readOnly: false, locked: () => locked, review, extras: async () => ({ undo: ++n }) });
  assert.equal(d.name, 'talk.html');
  const first = await call(d.routes.get('GET /deck/ping'));
  assert.equal(first.code, 200);
  assert.deepEqual(first.obj, { ok: true, name: 'talk.html', readOnly: false, locked: false, review: review.ping(), undo: 1 });
  assert.equal(first.headers['access-control-allow-origin'], 'null', 'a deck opened from disk probes cross-origin');
  locked = true;
  const second = await call(d.routes.get('GET /deck/ping'));
  assert.equal(second.obj.locked, true, 'the lock is read when asked, not when the routes were made');
  assert.equal(second.obj.undo, 2, 'and so are the extras');
});

test('read-only answers locked whatever is passed, with its own extras', async () => {
  const d = createDeckRoutes('/x/deck.html', { readOnly: true, review, extras: () => ({ remote: true }) });
  const { obj } = await call(d.routes.get('GET /deck/ping'));
  assert.deepEqual(obj, { ok: true, name: 'deck.html', readOnly: true, locked: true, review: review.ping(), remote: true });
});

test('the stream is the channel every tab joins, and broadcast reaches it', async () => {
  const d = createDeckRoutes('/x/deck.html', { readOnly: true, review });
  const written = [];
  const res = { writeHead: () => {}, write: (c) => written.push(c) };
  const req = { on: () => {} };
  await call(d.routes.get('GET /deck/events'), { req, res });
  assert.equal(d.channel.size, 1);
  d.broadcast('lock', { locked: true });
  assert.ok(written.some((c) => c.includes('event: lock') && c.includes('"locked":true')));
});
