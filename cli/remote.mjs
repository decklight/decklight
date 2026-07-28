// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The phone remote (#39): the controller page, its QR, and the relay — two
// one-way channels deliberately kept apart from the deck's own SSE stream: a
// phone has no business receiving `reload` or `agent`, and the deck has no
// business receiving position echoes of its own movement.
//
// The relay is mounted by whichever server owns the deck (edit today;
// `present` after PRESENT#REMOTE in MARKETPLACE.md) and never touches the
// deck file: the phone asks the deck to move, it never edits.

import { qrSvg } from './qr.mjs';
import { escapeHtml, sseChannel } from './serve.mjs';

/**
 * The phone controller page (#39): a clicker, NOT a second screen — SPEC NON_GOALS
 * rules out multiplex/follow-along, so this renders no slides, only two big
 * targets and the position readout. Self-contained by necessity: the phone is
 * off-loopback, and every asset it could reference is one more thing the token
 * would have to guard. It carries the token it was opened with into both its
 * POSTs and its SSE subscription.
 */
export function remoteControllerHtml(deckName) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(deckName)} — remote</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; height: 100dvh; display: flex; flex-direction: column;
         font: 600 16px/1.3 system-ui, -apple-system, sans-serif; background: #111; color: #eee; }
  header { padding: .9rem 1rem; text-align: center; border-bottom: 1px solid #333; }
  .deck { font-weight: 400; opacity: .6; font-size: .8rem; }
  .pos { font-size: 1.6rem; font-variant-numeric: tabular-nums; }
  main { flex: 1; display: grid; grid-template-rows: 1fr 1fr; gap: .6rem; padding: .6rem; }
  button { font: inherit; font-size: 2rem; border: 0; border-radius: 1rem; color: #eee;
           background: #26262b; touch-action: manipulation; }
  button:active { background: #3a3a44; }
  footer { padding: .5rem; text-align: center; font-size: .7rem; opacity: .5; }
</style>
</head>
<body>
  <header>
    <div class="deck">${escapeHtml(deckName)}</div>
    <div class="pos" id="pos">—</div>
  </header>
  <main>
    <button id="next" aria-label="next">▼ next</button>
    <button id="prev" aria-label="previous">▲ prev</button>
  </main>
  <footer id="state">connecting…</footer>
<script>
  var t = new URLSearchParams(location.search).get('t') || '';
  var q = t ? '?t=' + encodeURIComponent(t) : '';
  var pos = document.getElementById('pos');
  var state = document.getElementById('state');
  function send(key) {
    return fetch('/remote/key' + q, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key }),
    }).catch(function () { state.textContent = 'offline'; });
  }
  document.getElementById('next').onclick = function () { send('next'); };
  document.getElementById('prev').onclick = function () { send('prev'); };
  var es = new EventSource('/remote/events' + q);
  es.addEventListener('pos', function (e) {
    try { var p = JSON.parse(e.data); pos.textContent = p.i + ' / ' + p.n; } catch (err) {}
  });
  es.onopen = function () { state.textContent = 'connected'; };
  es.onerror = function () { state.textContent = 'reconnecting…'; };
</script>
</body>
</html>`;
}

/**
 * The relay. handle(req, res, url[, body]) answers every /remote/* route and
 * returns whether it did. GET routes need no body; the mounting server hands
 * POST bodies in after its own read. A bad payload throws — the mounting
 * server's error path answers 400, exactly as when this lived inline.
 *
 *   deckName    what the controller page shows
 *   token       the per-run token (null when --remote is off — QR refuses)
 *   remoteUrl   () => the LAN URL the QR encodes (port known only after bind)
 *   relayToDeck (event, data) => broadcast into the deck's own SSE stream
 *   deckCount   () => how many decks are listening (the /remote/key echo)
 *   CORS        the mounting server's CORS headers
 */
export function createRemoteRelay({ deckName, token, remoteUrl, relayToDeck, deckCount, CORS }) {
  const phones = sseChannel();  // phones watching /remote/events
  let lastPos = null;           // the last position the deck reported
  const pushPos = () => { if (lastPos) phones.raw(`event: pos\ndata: ${JSON.stringify(lastPos)}\n\n`); };
  return {
    handle(req, res, url, body) {
      const json = (code, obj) => {
        res.writeHead(code, { ...CORS, 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
        return true;
      };
      if (req.method === 'GET' && url.pathname === '/remote') {
        res.writeHead(200, { ...CORS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(remoteControllerHtml(deckName));
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/remote/qr.svg') {
        // Only meaningful with --remote: without it there is no LAN URL to
        // scan, and a QR encoding 127.0.0.1 would be a lie a phone can't use.
        if (!token) return json(404, { ok: false, error: 'the remote is off — start with --remote' });
        res.writeHead(200, { ...CORS, 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' });
        res.end(qrSvg(remoteUrl()));
        return true;
      }
      if (req.method === 'GET' && url.pathname === '/remote/events') {
        const sub = phones.add(req, res, CORS);
        // a phone joining mid-talk should show the right number immediately,
        // not stay blank until the presenter happens to advance
        if (lastPos) sub.write(`event: pos\ndata: ${JSON.stringify(lastPos)}\n\n`);
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/remote/key') {
        const { key } = JSON.parse(body);
        if (key !== 'next' && key !== 'prev') throw new Error('bad payload');
        // relayed as a named event on the stream the deck ALREADY listens to —
        // no second socket, no WebSockets anywhere in this codebase
        relayToDeck('remote', { key });
        return json(200, { ok: true, key, decks: deckCount() });
      }
      if (req.method === 'POST' && url.pathname === '/remote/pos') {
        const { i, n } = JSON.parse(body);
        if (!Number.isInteger(i) || !Number.isInteger(n)) throw new Error('bad payload');
        lastPos = { i, n };
        pushPos();
        return json(200, { ok: true });
      }
      return false;
    },
  };
}
