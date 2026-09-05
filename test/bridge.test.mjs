// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/bridge.mjs — the bits every localhost server repeats. It had no test
// at all, and the cap on readBody is a security property (SPEC PRESENTING's
// phone remote is the one route reachable from off this machine), so it gets
// one before anything else moves onto the shared reader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readBody, corsHeaders } from '../tools/bridge.mjs';

/** A server whose one route reads the body with `opts` and reports what happened. */
async function serve(t, opts) {
  const seen = [];
  const srv = createServer(async (req, res) => {
    try {
      const b = await readBody(req, opts);
      seen.push({ ok: true, size: b.length, text: b.toString() });
      res.end('ok');
    } catch (e) {
      seen.push({ ok: false, code: e.code });
      // the socket is already destroyed on E2BIG — nothing to write
    }
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}/`, seen };
}

test('readBody returns every chunk, in order, as one buffer', async (t) => {
  const { url, seen } = await serve(t);
  const r = await fetch(url, { method: 'POST', body: 'hello ' + 'x'.repeat(10_000) });
  assert.equal(r.status, 200);
  assert.deepEqual(seen, [{ ok: true, size: 10_006, text: 'hello ' + 'x'.repeat(10_000) }]);
});

test('with `max`, a body past it destroys the socket and throws E2BIG — no response is ever sent', async (t) => {
  const { url, seen } = await serve(t, { max: 4096 });
  await assert.rejects(fetch(url, { method: 'POST', body: 'y'.repeat(4097) }), /fetch failed|socket|ECONNRESET/);
  assert.deepEqual(seen, [{ ok: false, code: 'E2BIG' }]);
});

test('a body exactly at `max` is fine — the cap is past, not at', async (t) => {
  const { url, seen } = await serve(t, { max: 4096 });
  const r = await fetch(url, { method: 'POST', body: 'z'.repeat(4096) });
  assert.equal(r.status, 200);
  assert.equal(seen[0].size, 4096);
});

test('corsHeaders opens the origin — file:// decks are origin null — and exposes only what was asked for', () => {
  const h = corsHeaders('x-tts-cost, x-tts-cached');
  assert.equal(h['access-control-allow-origin'], '*');
  assert.equal(h['access-control-allow-methods'], 'GET, POST, OPTIONS');
  assert.equal(h['access-control-expose-headers'], 'x-tts-cost, x-tts-cached');
  // nothing asked for, nothing exposed — an empty expose header is a lie about the API
  assert.equal('access-control-expose-headers' in corsHeaders(), false);
});
