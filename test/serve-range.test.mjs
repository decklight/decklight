// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// staticFiles and media: byte ranges and a declared length.
//
// A browser asks for audio and video with `Range: bytes=…`. The old handler
// answered every request 200, chunked, with no Content-Length — a stream of
// unknown size, which reads as duration=Infinity, cannot seek, and which real
// Chrome (stricter than a bare fetch) can refuse outright. That surfaced in
// 0.7.0 manual testing as "no narration for slide 1" naming a file that was
// sitting right there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers.mjs';

import { staticFiles } from '../cli/serve.mjs';

/** A tiny served root with one "wav" of known bytes. */
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-range-'));
  t.after(() => rmTemp(dir));
  // 1000 recognisable bytes: position i holds i % 251, so any slice is checkable
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  fs.writeFileSync(path.join(dir, 'clip.wav'), bytes);
  const files = staticFiles(dir);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!files(req, res, url)) { res.writeHead(405); res.end(); }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, bytes };
}

test('a plain GET declares its length and advertises ranges', async (t) => {
  const { base, bytes } = await fixture(t);
  const r = await fetch(`${base}/clip.wav`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-length'), String(bytes.length),
    'no Content-Length is how duration becomes Infinity');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal(Buffer.compare(Buffer.from(await r.arrayBuffer()), bytes), 0);
});

test('a media element’s range requests get real 206 slices', async (t) => {
  const { base, bytes } = await fixture(t);

  // the opening probe every media stack sends
  const open = await fetch(`${base}/clip.wav`, { headers: { range: 'bytes=0-' } });
  assert.equal(open.status, 206);
  assert.equal(open.headers.get('content-range'), `bytes 0-999/1000`);
  assert.equal(Buffer.compare(Buffer.from(await open.arrayBuffer()), bytes), 0);

  // a seek: a bounded slice, byte-exact and inclusive at both ends
  const mid = await fetch(`${base}/clip.wav`, { headers: { range: 'bytes=100-199' } });
  assert.equal(mid.status, 206);
  assert.equal(mid.headers.get('content-length'), '100');
  assert.equal(mid.headers.get('content-range'), 'bytes 100-199/1000');
  assert.equal(Buffer.compare(Buffer.from(await mid.arrayBuffer()), bytes.subarray(100, 200)), 0);

  // a suffix range (the tail probe some stacks use for metadata)
  const tail = await fetch(`${base}/clip.wav`, { headers: { range: 'bytes=-100' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-range'), 'bytes 900-999/1000');

  // an end past the file is clamped, per RFC 7233, not refused
  const past = await fetch(`${base}/clip.wav`, { headers: { range: 'bytes=990-2000' } });
  assert.equal(past.status, 206);
  assert.equal(past.headers.get('content-range'), 'bytes 990-999/1000');
});

test('an unsatisfiable range is a 416 naming the size; a malformed one is ignored', async (t) => {
  const { base, bytes } = await fixture(t);
  const off = await fetch(`${base}/clip.wav`, { headers: { range: 'bytes=5000-6000' } });
  assert.equal(off.status, 416);
  assert.equal(off.headers.get('content-range'), 'bytes */1000');

  // RFC 7233: a server MAY ignore Range — a header this code does not
  // understand falls back to the full 200, never an invented refusal
  for (const bad of ['bytes=', 'lines=1-2', 'bytes=abc-def', 'bytes=1-2,5-6']) {
    const r = await fetch(`${base}/clip.wav`, { headers: { range: bad } });
    assert.equal(r.status, 200, `range "${bad}" should fall back to 200`);
    assert.equal(Buffer.compare(Buffer.from(await r.arrayBuffer()), bytes), 0);
  }
});

test('the deck itself still serves whole, ranges and all', async (t) => {
  // the html rewrite path buffers a different body than the file on disk —
  // the length must describe what was SENT, not what was stored
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-range-html-'));
  t.after(() => rmTemp(dir));
  fs.writeFileSync(path.join(dir, 'deck.html'), '<div class="decklight"></div>');
  const files = staticFiles(dir, { html: (txt) => txt + '<!-- injected -->' });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!files(req, res, url)) { res.writeHead(405); res.end(); }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const r = await fetch(`http://127.0.0.1:${server.address().port}/deck.html`);
  const body = await r.text();
  assert.match(body, /injected/);
  assert.equal(r.headers.get('content-length'), String(Buffer.byteLength(body)));
});
