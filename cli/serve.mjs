// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The deck-server core — everything a localhost deck server needs that is not
// an editing endpoint: the loopback/token security classifier, static file
// serving with a traversal guard, SSE fan-out, and port binding with takeover.
//
// Extracted from edit.mjs so `decklight present` (MARKETPLACE.md,
// PRESENT_SERVER) can serve a deck read-only by reusing this core with the
// /edit/* routes ABSENT — not merely refused. Nothing in this module writes a
// file.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { resolvePortConflict } from './port-conflict.mjs';

// ── remote access: the security seam for the phone remote (#39) ────────────
// --remote widens the LISTENER, never the editing surface: off-loopback,
// only /remote/* answers, and only with the per-run token; every /edit/*
// mutation (and the static files) refuses non-loopback callers
// unconditionally, flag or no flag.

/** Loopback caller? IPv4-mapped IPv6 (::ffff:127.0.0.1) counts too. */
export function isLoopback(addr) {
  const a = String(addr ?? '').replace(/^::ffff:/i, '');
  return a === '::1' || /^127\./.test(a);
}

/**
 * Is this `Origin` a loopback WEB origin — a page a localhost server handed
 * out (`http://127.0.0.1:8788`, `http://localhost:5173`, `http://[::1]:…`)? A
 * hostname, not a socket address: this reads the string the browser stamped on
 * the request, which is a different question from `isLoopback` (who is dialing
 * the socket) and the one a CSRF gate has to ask.
 */
export function isLoopbackOrigin(origin) {
  let u;
  try { u = new URL(String(origin)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  // 127.0.0.0/8, and ONLY as a dotted quad. `isLoopback` above is deliberately
  // loose (`/^127\./`) because it reads SOCKET addresses, which are numeric. A
  // hostname is not: `127.0.0.1.evil.example` is a domain an attacker can
  // register and would sail through that prefix test, so the origin check
  // pins all four octets.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return !!m && m[1] === '127' && m.slice(1).every((o) => Number(o) <= 255);
}

/**
 * The CSRF gate for the author server's `/edit/*` surface (#222). The attacker
 * is the user's OWN browser: while `decklight author` runs, any page in any tab
 * can `fetch()` loopback, and a permissive `access-control-allow-origin` is no
 * defense — a "simple" `text/plain` POST is sent with NO preflight, so the
 * agent has already run by the time the browser consults CORS on the way back.
 * The gate therefore runs BEFORE the handler, on the one field a page cannot
 * forge: the `Origin` the browser attaches.
 *
 * Answered YES for:
 *   - a request with no `Origin` at all — the CLI, `curl`, the port-conflict
 *     probe, the test suite: not a browser cross-origin call.
 *   - a loopback web origin — the deck this very server serves (same-origin),
 *     and any other same-machine dev server the author is running.
 *   - `null` — a `file://`-opened deck, the SPEC'd double-click path.
 *
 * Answered NO for every other origin, which is exactly the `https://evil.example`
 * tab the ticket is about. Residual: `null` is also the origin of a sandboxed
 * iframe, so a page that embeds one can still reach here; closing that would
 * cost the `file://` path a token it has no way to receive, and the SPEC keeps
 * the double-click affordance. It is called out in PRESENTING.
 */
export function allowEditRequest(req) {
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  if (origin === 'null') return true;
  return isLoopbackOrigin(origin);
}

/**
 * A STRICTER gate: this exact origin, and nothing else.
 *
 * `allowEditRequest` above admits an absent Origin (curl, a probe) and the
 * literal `null` — and `null` is what a SANDBOXED IFRAME sends. That is exactly
 * what presenter chrome runs in (`injectChrome` mounts every plugin in one), so
 * a gate that admits it would let a plugin reach an action the presenter never
 * asked for. Pinning the port refuses another loopback dev server's page too,
 * which the edit gate admits by design.
 *
 * Used by the one route in `present` that ACTS. The looser gate is right for
 * `/edit/*`, where the server exists to be written to and a curl from the
 * author's own machine is a feature; it is wrong here.
 */
export function isOwnOrigin(req, port) {
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || !origin) return false;
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ].includes(origin);
}

/**
 * Pure request classifier: may this request be answered at all?
 * Loopback: always. Off-loopback: only /remote/* paths carrying the per-run
 * token (?t= query or x-decklight-token header) — everything else, all
 * /edit/* mutations included, is refused regardless of any token. `token`
 * is null when --remote is off, which refuses every off-loopback request
 * (defense in depth behind the 127.0.0.1 binding).
 */
export function allowRemote(req, token) {
  if (isLoopback(req.socket?.remoteAddress)) return true;
  if (!token) return false;
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return false; }
  // new URL() normalizes dot segments, so /remote/../edit/notes is /edit/notes
  if (url.pathname !== '/remote' && !url.pathname.startsWith('/remote/')) return false;
  const sent = Buffer.from(String(url.searchParams.get('t') ?? req.headers?.['x-decklight-token'] ?? ''));
  const want = Buffer.from(token);
  return sent.length === want.length && timingSafeEqual(sent, want);
}

/** The machine's LAN address — what the printed /remote?t= URL should carry. */
export function lanAddress(interfaces = networkInterfaces()) {
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (!a.internal && a.family === 'IPv4') return a.address;
    }
  }
  return null;
}

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

// Re-exported so the server's callers keep one import: the escape itself is
// tools/escape.mjs's, which also covers quotes — this one did not, under a
// name that reads like it covers everything.
export { escapeHtml } from '../tools/escape.mjs';

/**
 * Wrap a request handler so EVERY response it writes carries `headers` —
 * the deck, its assets, error pages, JSON, SSE, all of it. They are set
 * before the handler runs, and writeHead merges them under any headers a
 * route names itself, so a route can sharpen one but can never lose one by
 * not mentioning it. This is the seam the present server's
 * Content-Security-Policy arrives through (PRESENT): "every response
 * carries the header" holds by construction here, instead of by every
 * writeHead in every route remembering.
 */
export function withHeaders(headers, handler) {
  return (req, res) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    return handler(req, res);
  };
}

/**
 * Static files under `root`, GET only: traversal-guarded, MIME-typed,
 * no-cache. `index` is the path "/" serves (the deck). Returns whether the
 * request was handled.
 *
 * `html` rewrites the text of every text/html response on its way out and
 * leaves every other type alone. It is how `present --strict` (PRESENT#STRICT)
 * serves a deck with the unaccounted blocks removed while the file on disk
 * stays exactly as it arrived: the transform sits between the read and the
 * write, so there is no point in this path where the modified bytes could be
 * mistaken for the deck.
 *
 * Dotfiles are refused unconditionally — no path segment may start with `.`,
 * decoded or not. A deck has no business fetching `.env` or `.git/config`,
 * and with `connect-src https:` open (PRESENT), anything a hostile deck can
 * read same-origin it can also send anywhere.
 *
 * `knownTypesOnly` additionally refuses every extension the MIME table does
 * not name. `present` passes it: the table is the set of types a deck can
 * actually use, and a file beside a travelled deck that is none of them —
 * `id_rsa`, a `.pem`, a database — is only ever fetched to be exfiltrated.
 * The author server does not, so an author's exotic asset still serves as
 * octet-stream from their own machine.
 */
export function staticFiles(root, { index = '/index.html', html: rewriteHtml = null, knownTypesOnly = false } = {}) {
  return (req, res, url) => {
    if (req.method !== 'GET') return false;
    const rel = url.pathname === '/' ? index : decodeURIComponent(url.pathname);
    const file = resolve(root, '.' + rel);
    if (!file.startsWith(root + sep) && file !== root) { res.writeHead(403); res.end('forbidden'); return true; }
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return true; }
    // Policy refusals come AFTER the existence check on purpose: a path that
    // is not there stays a plain 404, indistinguishable from any other unknown
    // path — a probe for /edit/ping must not learn anything from the answer.
    const type = MIME[extname(file).toLowerCase()];
    if (rel.split('/').some((s) => s.startsWith('.')) || (knownTypesOnly && !type)) {
      res.writeHead(403); res.end('forbidden'); return true;
    }
    let body = readFileSync(file);
    if (rewriteHtml && type === MIME['.html']) body = Buffer.from(rewriteHtml(body.toString('utf8'), file), 'utf8');
    res.writeHead(200, { 'content-type': type ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
    return true;
  };
}

/**
 * One SSE fan-out. add() takes a response over (headers, greeting comment,
 * cleanup on close) and returns it; broadcast() sends a named event to every
 * subscriber; raw() sends bytes as-is (the deck's unnamed `data: reload`
 * message predates named events and stays byte-identical).
 */
export function sseChannel() {
  const clients = new Set();
  return {
    get size() { return clients.size; },
    add(req, res, headers = {}) {
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return res;
    },
    broadcast(event, data) {
      for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    raw(chunk) {
      for (const res of clients) res.write(chunk);
    },
  };
}

/**
 * Bind `server` to `port` on `host`. On EADDRINUSE, work out who's there
 * (resolvePortConflict) — on a TTY that's an interactive choice, otherwise
 * the port silently bumps — and retry until something binds. Returns the
 * port actually bound (server.address().port, so :0 still reports its
 * OS-assigned port).
 */
export async function listenTakingOverIfNeeded(server, port, host = '127.0.0.1') {
  const tty = process.stdin.isTTY && process.stdout.isTTY;
  let rl;
  const ask = tty ? (q) => (rl ??= createInterface({ input: process.stdin, output: process.stdout })).question(q) : undefined;
  try {
    for (;;) {
      try {
        return await new Promise((res, rej) => {
          const onError = (e) => { server.off('listening', onListening); rej(e); };
          const onListening = () => { server.off('error', onError); res(server.address().port); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, host);
        });
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        port = await resolvePortConflict(port, { ask, log: console.log });
      }
    }
  } finally {
    rl?.close();
  }
}
