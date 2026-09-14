// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The iframe preview handshake (src/core/preview.js) — one implementation
// behind the slide finder, the theme picker, the template browser and the
// history dialog (SPEC PRESENTING). Four copies of this dance used to live in
// four modules and disagreed about the one case that matters: a request queued
// while the frame was still loading one document, and the cursor moving on to
// another before it finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPreview } from '../src/core/preview.js';

/** The slice of an <iframe> the handshake touches. */
function frame({ connected = true } = {}) {
  const listeners = [];
  const posted = [];
  const f = {
    src: null,
    isConnected: connected,
    addEventListener: (type, fn, opts) => listeners.push({ type, fn, once: !!opts?.once }),
    contentWindow: { postMessage: (msg, origin) => posted.push({ msg, origin }) },
    /** fire the frame's `load` — what the browser does when `src` finished */
    load() {
      const fire = listeners.splice(0);
      for (const l of fire) l.fn({ type: 'load' });
    },
    posted,
    listeners,
  };
  return f;
}

const preview = () => createPreview({
  docOf: (t) => t.doc,
  srcFor: (t) => `${t.doc}#/${t.slide}/0`,
  messageFor: (t) => ({ __decklightPreview: { goto: [t.slide, 0] } }),
});

test('the first request loads the document; the next one, same document, is a message', () => {
  const p = preview();
  const f = frame();
  p.show(f, { doc: 'a.html', slide: 3 });
  assert.equal(f.src, 'a.html#/3/0', 'the document loads at the slide asked for');
  assert.deepEqual(f.posted, [], 'nothing is posted into a frame that has not loaded');
  f.load();
  p.show(f, { doc: 'a.html', slide: 5 });
  assert.equal(f.src, 'a.html#/3/0', 'the same document is never reloaded');
  assert.deepEqual(f.posted.map((m) => m.msg.__decklightPreview.goto), [[5, 0]]);
});

test('a request that arrives mid-load is queued and replayed once, on load', () => {
  const p = preview();
  const f = frame();
  p.show(f, { doc: 'a.html', slide: 1 });
  p.show(f, { doc: 'a.html', slide: 4 });
  p.show(f, { doc: 'a.html', slide: 7 });
  assert.deepEqual(f.posted, [], 'still loading: nothing posted yet');
  f.load();
  assert.deepEqual(f.posted.map((m) => m.msg.__decklightPreview.goto), [[7, 0]],
    'only the LAST queued request is replayed — the ones before it were superseded by the cursor');
});

test('a request queued for the previous document is dropped when the document changes', () => {
  // The bug the finder had: arrow onto module B while module A is loading, and
  // A's queued goto fired when B loaded — reloading the frame back to A.
  const p = preview();
  const f = frame();
  p.show(f, { doc: 'a.html', slide: 1 });
  p.show(f, { doc: 'a.html', slide: 2 });   // queued for a
  p.show(f, { doc: 'b.html', slide: 1 });   // the cursor moved on
  assert.equal(f.src, 'b.html#/1/0');
  f.load();                                 // b loads (a's load listener fires too, and must do nothing)
  assert.equal(f.src, 'b.html#/1/0', 'the frame stayed on b');
  assert.deepEqual(f.posted, [], 'a’s queued goto was not replayed into b');
  p.show(f, { doc: 'b.html', slide: 2 });
  assert.deepEqual(f.posted.map((m) => m.msg.__decklightPreview.goto), [[2, 0]], 'b is ready and takes messages');
});

test('a load that arrives after the panel closed replays nothing', () => {
  const p = preview();
  const f = frame({ connected: false });
  p.show(f, { doc: 'a.html', slide: 1 });
  p.show(f, { doc: 'a.html', slide: 2 });
  f.load();
  assert.deepEqual(f.posted, [], 'a detached frame has nobody looking at it');
});

test('state is per frame: a rebuilt panel starts clean', () => {
  const p = preview();
  const first = frame();
  p.show(first, { doc: 'a.html', slide: 1 });
  first.load();
  const second = frame();
  p.show(second, { doc: 'a.html', slide: 1 });
  assert.equal(second.src, 'a.html#/1/0', 'a new iframe has to load the document even if the last one had it');
});

test('a null frame or target is ignored rather than thrown on', () => {
  const p = preview();
  assert.doesNotThrow(() => p.show(null, { doc: 'a', slide: 1 }));
  assert.doesNotThrow(() => p.show(frame(), null));
});
