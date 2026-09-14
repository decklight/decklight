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
import { rmTemp, tmp } from './helpers.mjs';

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

// ── big files: what the server must NOT do to answer a seek ────────────────
//
// A deck's background video is a 200 MB file, and a browser plays it as a long
// march of small ranges. Answering each one by reading the whole file is a
// synchronous multi-hundred-megabyte read per seek, on the event loop the SSE
// reload channel and every other request share. The bytes must come off a read
// stream bounded to the range, and the length math off the stat.

/** Serve `dir` on an ephemeral port, closed with the test. */
async function serveDir(t, dir) {
  const files = staticFiles(dir);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!files(req, res, url)) { res.writeHead(405); res.end(); }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('a multi-megabyte file served in two ranges stitches back byte for byte', async (t) => {
  const dir = tmp('range-big', t);
  // 3 MB of a pattern with a long period, so a slice off by one byte — or
  // taken from the wrong offset — cannot compare equal by luck
  const bytes = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + (i >> 13)) & 0xff;
  fs.writeFileSync(path.join(dir, 'bg.mp4'), bytes);
  const base = await serveDir(t, dir);

  const half = bytes.length / 2;
  const head = await fetch(`${base}/bg.mp4`, { headers: { range: `bytes=0-${half - 1}` } });
  const tail = await fetch(`${base}/bg.mp4`, { headers: { range: `bytes=${half}-` } });
  assert.equal(head.status, 206);
  assert.equal(tail.status, 206);
  assert.equal(head.headers.get('content-range'), `bytes 0-${half - 1}/${bytes.length}`);
  assert.equal(tail.headers.get('content-range'), `bytes ${half}-${bytes.length - 1}/${bytes.length}`);
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  const stitched = Buffer.concat([
    Buffer.from(await head.arrayBuffer()),
    Buffer.from(await tail.arrayBuffer()),
  ]);
  assert.equal(Buffer.compare(stitched, bytes), 0, 'the two halves are not the file');
});

test('a range response is as long as the range, not as long as the file', async (t) => {
  // The one thing a caller can see from outside that says the whole file was
  // not held: a 3 MB file answering a 1 KB ask with a 1 KB body and a
  // content-length that describes the SLICE.
  const dir = tmp('range-len', t);
  fs.writeFileSync(path.join(dir, 'bg.mp4'), Buffer.alloc(3 * 1024 * 1024, 7));
  const base = await serveDir(t, dir);
  const r = await fetch(`${base}/bg.mp4`, { headers: { range: 'bytes=1000-1999' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-length'), '1000', 'the length must describe the slice');
  assert.equal(r.headers.get('accept-ranges'), 'bytes', 'the streamed path keeps every header');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal((await r.arrayBuffer()).byteLength, 1000);
});

test('an unsatisfiable range on a big file is a bodiless 416 naming the size', async (t) => {
  const dir = tmp('range-416', t);
  const size = 3 * 1024 * 1024;
  fs.writeFileSync(path.join(dir, 'bg.mp4'), Buffer.alloc(size));
  const base = await serveDir(t, dir);
  const r = await fetch(`${base}/bg.mp4`, { headers: { range: `bytes=${size + 1}-${size + 100}` } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('content-range'), `bytes */${size}`, 'the size is how a client re-asks');
  assert.equal((await r.arrayBuffer()).byteLength, 0, '416 carries no slice');
});

test('a kilobyte out of a hundred megabytes is answered without reading the rest', async (t) => {
  // Behavioural, and no spy needed: a sparse 100 MB file costs nothing to
  // stat and nothing to stream 1 KB out of, and rather a lot to read whole.
  // The budget is deliberately loose — this fails on the shape of the bug
  // (the whole file in memory first), not on a slow machine.
  const dir = tmp('range-sparse', t);
  const file = path.join(dir, 'huge.mp4');
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, 100 * 1024 * 1024);
  fs.closeSync(fd);
  const base = await serveDir(t, dir);

  const t0 = Date.now();
  const r = await fetch(`${base}/huge.mp4`, { headers: { range: 'bytes=0-1023' } });
  const body = Buffer.from(await r.arrayBuffer());
  const ms = Date.now() - t0;
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 0-1023/104857600');
  assert.equal(body.length, 1024);
  assert.ok(ms < 1000, `a 1 KB range took ${ms}ms — the file is being read whole`);
});
