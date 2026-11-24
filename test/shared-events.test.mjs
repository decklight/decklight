// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// One event stream per profile, shared by every tab of the deck (#1240,
// SPEC PRESENTING_EDITING): one tab leads and holds the real stream, the
// others hear it over a BroadcastChannel, and the next tab leads when it goes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedEventSource } from '../src/core/shared-events.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A browser profile: its locks, its channels, and every EventSource its tabs opened. */
function profile() {
  const sources = [];
  class FakeES {
    constructor(url) { this.url = url; this.handlers = new Map(); this.closed = false; sources.push(this); }
    addEventListener(n, fn) { if (!this.handlers.has(n)) this.handlers.set(n, []); this.handlers.get(n).push(fn); }
    close() { this.closed = true; }
    emit(n, data) { if (n === 'message') { this.onmessage?.({ data, lastEventId: '' }); return; } for (const fn of this.handlers.get(n) ?? []) fn({ data, lastEventId: '' }); }
  }
  const channels = new Set();
  class FakeBC {
    constructor(name) { this.name = name; this.onmessage = null; channels.add(this); }
    postMessage(data) {
      const copy = structuredClone(data);
      for (const c of channels) if (c !== this && c.name === this.name) queueMicrotask(() => c.onmessage?.({ data: copy }));
    }
    close() { channels.delete(this); }
  }
  const queues = new Map();
  const locks = {
    request(name, cb) {
      return new Promise((resolve, reject) => {
        const q = queues.get(name) ?? [];
        queues.set(name, q);
        const run = () => Promise.resolve().then(() => cb({ name })).then((v) => {
          q.shift(); resolve(v); if (q.length) q[0]();
        }, reject);
        q.push(run);
        if (q.length === 1) run();
      });
    },
  };
  const tab = (url = '/deck/events') => sharedEventSource(url, {
    EventSourceCtor: FakeES, BroadcastChannelCtor: FakeBC, locks, origin: 'http://127.0.0.1:8794', href: 'http://127.0.0.1:8794/deck.html',
  });
  return { sources, tab, live: () => sources.filter((s) => !s.closed) };
}

test('eight tabs of one deck hold one stream between them', async () => {
  const p = profile();
  const tabs = Array.from({ length: 8 }, () => p.tab());
  await tick(); await tick();
  assert.equal(p.live().length, 1);
  assert.equal(p.live()[0].url, 'http://127.0.0.1:8794/deck/events');
  assert.equal(tabs.filter((t) => t.leading).length, 1);
});

test('every tab hears the named events it listens for, and the unnamed reload', async () => {
  const p = profile();
  const tabs = Array.from({ length: 3 }, () => p.tab());
  const heard = tabs.map(() => []);
  tabs.forEach((t, i) => {
    t.onmessage = (ev) => heard[i].push(`reload:${ev.data}`);
    t.addEventListener('lock', (ev) => heard[i].push(`lock:${ev.data}`));
  });
  tabs[2].addEventListener('remote', (ev) => heard[2].push(`remote:${ev.data}`));
  await tick(); await tick(); await tick();
  const es = p.live()[0];
  es.emit('message', 'deck.html');
  es.emit('lock', '{"locked":true}');
  es.emit('remote', '{"key":"next"}');
  await tick();
  assert.deepEqual(heard[0], ['reload:deck.html', 'lock:{"locked":true}']);
  assert.deepEqual(heard[1], ['reload:deck.html', 'lock:{"locked":true}']);
  assert.deepEqual(heard[2], ['reload:deck.html', 'lock:{"locked":true}', 'remote:{"key":"next"}']);
});

test('the stream opening and failing reach every tab: the offline banner still works', async () => {
  const p = profile();
  const a = p.tab(), b = p.tab();
  const said = [];
  b.onopen = () => said.push('open');
  b.onerror = () => said.push('error');
  await tick(); await tick();
  p.live()[0].onopen();
  p.live()[0].onerror();
  await tick();
  assert.deepEqual(said, ['open', 'error']);
  assert.equal(b.readyState, 0);
  a.close(); b.close();
});

test('when the leader closes, the next tab opens the stream and asks what everyone listens for', async () => {
  const p = profile();
  const a = p.tab(), b = p.tab(), c = p.tab();
  const heard = [];
  c.addEventListener('theme', (ev) => heard.push(ev.data));
  b.addEventListener('lock', () => {});
  await tick(); await tick();
  assert.equal(a.leading, true);
  a.close();
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(p.live().length, 1);
  assert.equal(b.leading, true);
  p.live()[0].emit('theme', 'dark');
  await tick();
  assert.deepEqual(heard, ['dark']);
});

test('a page with no Web Locks, or an opaque origin, opens its own stream as before', () => {
  const made = [];
  class ES { constructor(u) { made.push(u); } }
  sharedEventSource('/deck/events', { EventSourceCtor: ES, BroadcastChannelCtor: null, locks: null, origin: 'http://x', href: 'http://x/d.html' });
  sharedEventSource('http://127.0.0.1:8080/deck/events', { EventSourceCtor: ES, BroadcastChannelCtor: class {}, locks: { request() {} }, origin: 'null', href: 'file:///d.html' });
  assert.deepEqual(made, ['http://x/deck/events', 'http://127.0.0.1:8080/deck/events']);
});
