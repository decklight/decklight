// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// One event stream per browser profile, shared by every tab of the deck
// (SPEC PRESENTING_EDITING, "One stream for every tab").
//
// Every tab of a deck listens on `/deck/events` for live reload, the lock, the
// phone remote and the rest. An `EventSource` response never ends, so it pins
// one of the six sockets Chrome gives a plain-HTTP origin, and those six are
// shared by every tab of the profile. Six tabs (the author's, an old one, the
// speaker view, a second window) and every later fetch from any of them queued
// in the browser forever: the layout picker showed "no preview" on every tile
// while the server sat idle.
//
// So one tab, the LEADER, opens the real stream and relays what it hears over a
// `BroadcastChannel`. Which tab leads is a Web Lock: the first tab to ask holds
// it, the others wait in line, and when the leader closes (or is discarded)
// the browser hands the lock to the next tab, which opens the stream in turn.
// However many tabs are open, the profile holds one long-lived connection per
// stream URL.
//
// What a tab gets back is shaped like an `EventSource` (`addEventListener`,
// `onmessage`, `onopen`, `onerror`, `close`), so the code that listens does not
// know whether it leads. An EventSource cannot listen for "every event", so a
// tab says which names it wants, and the leader subscribes to the union; a new
// leader asks every tab again.
//
// Without Web Locks or BroadcastChannel (an old browser, a page from disk with
// an opaque origin), a tab opens its own stream, as before.

/**
 * An EventSource-like object for `url`, shared across the profile's tabs.
 * Everything the browser provides is injectable, for tests.
 */
export function sharedEventSource(url, {
  EventSourceCtor = globalThis.EventSource,
  BroadcastChannelCtor = globalThis.BroadcastChannel,
  locks = globalThis.navigator?.locks,
  origin = globalThis.location?.origin,
  href = globalThis.location?.href,
} = {}) {
  const abs = new URL(url, href).href;
  const shareable = typeof BroadcastChannelCtor === 'function' && typeof locks?.request === 'function'
    && !!origin && origin !== 'null' && /^https?:/.test(abs);
  if (!shareable) return new EventSourceCtor(abs);
  return createShared(abs, { EventSourceCtor, BroadcastChannelCtor, locks });
}

function createShared(url, { EventSourceCtor, BroadcastChannelCtor, locks }) {
  const key = `decklight-events ${url}`;
  const listeners = new Map();   // name → Set(fn), this tab's own
  const wanted = new Set();      // names any tab wants (kept by the leader)
  let es = null;                 // the real stream, while this tab leads
  let release = null;            // lets go of the lock
  let closed = false;
  let open = false;              // as far as this tab knows, the stream is up
  const bc = new BroadcastChannelCtor(key);

  const target = {
    url,
    onmessage: null, onopen: null, onerror: null,
    get readyState() { return closed ? 2 : open ? 1 : 0; },
    get leading() { return !!es; },
    addEventListener(name, fn) {
      if (typeof fn !== 'function') return;
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      want([name]);
    },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    close,
  };

  /** Hand an event to this tab's own listeners. */
  function deliver(name, data, lastEventId = '') {
    const ev = { type: name, data, lastEventId };
    const prop = name === 'message' ? target.onmessage : name === 'open' ? target.onopen : name === 'error' ? target.onerror : null;
    if (typeof prop === 'function') { try { prop.call(target, ev); } catch (e) { setTimeout(() => { throw e; }); } }
    for (const fn of listeners.get(name) ?? []) { try { fn.call(target, ev); } catch (e) { setTimeout(() => { throw e; }); } }
  }

  /** A state change (the stream opened or failed), here and in every follower. */
  function state(name) {
    open = name === 'open';
    deliver(name);
    if (!closed) bc.postMessage({ t: 'state', name });
  }

  /** The leader listens for `names` on the real stream; a follower asks the leader to. */
  function want(names) {
    if (closed) return;
    const fresh = names.filter((n) => n !== 'open' && n !== 'error' && !wanted.has(n));
    if (!fresh.length) return;
    if (es) { for (const n of fresh) subscribe(n); } else bc.postMessage({ t: 'want', names: fresh });
  }

  function subscribe(name) {
    if (wanted.has(name) || !es) return;
    wanted.add(name);
    const relay = (ev) => {
      deliver(name, ev.data, ev.lastEventId);
      bc.postMessage({ t: 'ev', name, data: ev.data, lastEventId: ev.lastEventId });
    };
    // the unnamed event through the property, as a page without the relay took it
    if (name === 'message') es.onmessage = relay;
    else es.addEventListener(name, relay);
  }

  bc.onmessage = ({ data: m }) => {
    if (closed || !m || typeof m !== 'object') return;
    if (m.t === 'ev') { if (!es) deliver(m.name, m.data, m.lastEventId); return; }
    if (m.t === 'state') { if (!es) { open = m.name === 'open'; deliver(m.name); } return; }
    if (m.t === 'want') { if (es && Array.isArray(m.names)) for (const n of m.names) subscribe(String(n)); return; }
    // a new leader asks what every tab listens for; a new follower asks whether the stream is up
    if (m.t === 'hello') { if (!es) bc.postMessage({ t: 'want', names: [...listeners.keys()] }); return; }
    if (m.t === 'join') { if (es && open) bc.postMessage({ t: 'state', name: 'open' }); }
  };

  function lead() {
    es = new EventSourceCtor(url);
    es.onopen = () => state('open');
    es.onerror = () => state('error');
    // the unnamed event always: a tab's `onmessage` is a property, never announced
    subscribe('message');
    for (const n of listeners.keys()) if (n !== 'open' && n !== 'error') subscribe(n);
    bc.postMessage({ t: 'hello' });
  }

  function close() {
    if (closed) return;
    closed = true;
    open = false;
    es?.close();
    es = null;
    try { bc.close(); } catch { /* already */ }
    release?.();
  }

  // Waits in line behind the current leader; held for as long as this tab is
  // open. The browser lets go of it when the page goes, and the next tab leads.
  locks.request(key, () => {
    if (closed) return undefined;
    lead();
    return new Promise((resolve) => { release = resolve; });
  }).catch(() => {
    // no lock for us after all (the page is going away, or the browser refused):
    // listen on our own stream rather than not at all
    if (!closed && !es) lead();
  });
  bc.postMessage({ t: 'join' });

  return target;
}
