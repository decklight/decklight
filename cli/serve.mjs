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

import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { resolvePortConflict } from './port-conflict.mjs';
import { packageAsset } from './pkg.mjs';
import { linkRuntime } from './runtime-link.mjs';

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
 * The one byte range `header` asks for out of a body of `size`, or null when a
 * full 200 answers it.
 *
 * One range, which is all a media element ever sends. Malformed and multipart
 * ranges read as null and fall through to the plain 200 — RFC 7233 allows
 * ignoring Range entirely, so partial support must never invent a 416 for a
 * request a full response satisfies. `satisfiable` marks the one case that must
 * be refused instead: a range that starts past the end of the body.
 */
function rangeOf(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || !(m[1] || m[2])) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return { start, end, satisfiable: start <= end && start < size };
}

/**
 * Static files under `root`, GET only: traversal-guarded, MIME-typed,
 * no-cache. `index` is the path "/" serves (the deck). Returns whether the
 * request was handled.
 *
 * `html` rewrites the text of every text/html response on its way out and
 * leaves every other type alone; after it, a deck that carries no runtime
 * (#520) has the installed one referenced into its text (`linkRuntime`). It is how `present --strict` (PRESENT#STRICT)
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
 *
 * The runtime a deck LINKS (#517) — `decklight.js`, `decklight.css`,
 * `themes/<name>.css` — is answered from the installed package when the deck
 * ships no such file, and also when the reference reaches outside `root`
 * (`../dist/decklight.js`, the shape every source deck in this repository
 * uses): the deck gets decklight's own file, never anything of the caller's.
 * A copy that IS on disk beside the deck wins, so an author pinning their
 * own build is honoured. Nothing else escapes root or answers for a
 * missing path — a probe still learns nothing from a 404.
 */
export function staticFiles(root, { index = '/index.html', html: rewriteHtml = null, knownTypesOnly = false } = {}) {
  return (req, res, url) => {
    if (req.method !== 'GET') return false;
    const rel = url.pathname === '/' ? index : decodeURIComponent(url.pathname);
    let file = resolve(root, '.' + rel);
    let type;
    const dotted = rel.split('/').some((s) => s.startsWith('.'));
    const escapes = !file.startsWith(root + sep) && file !== root;
    if (escapes || !existsSync(file)) {
      const asset = !dotted && packageAsset(rel);
      if (asset) { file = asset.file; type = asset.type; }
      else if (escapes) { res.writeHead(403); res.end('forbidden'); return true; }
    }
    const stat = existsSync(file) ? statSync(file) : null;
    if (!stat?.isFile()) { res.writeHead(404); res.end('not found'); return true; }
    // Policy refusals come AFTER the existence check on purpose: a path that
    // is not there stays a plain 404, indistinguishable from any other unknown
    // path — a probe for /edit/ping must not learn anything from the answer.
    type ??= MIME[extname(file).toLowerCase()];
    if (dotted || (knownTypesOnly && !type)) {
      res.writeHead(403); res.end('forbidden'); return true;
    }
    const headers = {
      'content-type': type ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      // Media elements are the reason both of these exist. A browser asks for
      // audio and video with `Range: bytes=…`, and a server that answers 200,
      // chunked, with no Content-Length gives the media stack a stream of
      // unknown size: duration reads Infinity, seeking is impossible, and
      // real Chrome — stricter than a bare fetch — can refuse the source
      // outright, which surfaced as "no narration for slide 1" pointing at a
      // file that was sitting right there.
      'accept-ranges': 'bytes',
    };

    // A page's bytes are not the file's: the caller's rewrite (`--strict`,
    // PRESENT#STRICT; a render's driver) runs on the text on its way out, and
    // then a deck that carries no runtime — a deck as data (#520) — gets the
    // engine, its stylesheet and its theme referenced (`linkRuntime`, which
    // leaves every other document exactly as it was). So its length and its
    // ranges have to be measured on what was SENT, which means holding it. It
    // is a page; everything else streams below.
    if (type === MIME['.html']) {
      const text = readFileSync(file).toString('utf8');
      const body = Buffer.from(linkRuntime(rewriteHtml ? rewriteHtml(text, file) : text), 'utf8');
      const want = rangeOf(req.headers.range, body.length);
      if (want && !want.satisfiable) {
        res.writeHead(416, { 'content-range': `bytes */${body.length}` });
        res.end();
        return true;
      }
      if (want) {
        const slice = body.subarray(want.start, want.end + 1);
        res.writeHead(206, {
          ...headers,
          'content-length': slice.length,
          'content-range': `bytes ${want.start}-${want.end}/${body.length}`,
        });
        res.end(slice);
        return true;
      }
      res.writeHead(200, { ...headers, 'content-length': body.length });
      res.end(body);
      return true;
    }

    // Every other type is STREAMED, and the length math comes off the stat
    // rather than a buffer. A deck's background video is a 200 MB file that a
    // browser fetches in a long march of small ranges, and reading all of it
    // synchronously to answer each one froze the event loop — the SSE reload
    // channel and the next request included — once per seek.
    const size = stat.size;
    const want = rangeOf(req.headers.range, size);
    if (want && !want.satisfiable) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return true;
    }
    const start = want ? want.start : 0;
    const end = want ? want.end : size - 1;
    res.writeHead(want ? 206 : 200, {
      ...headers,
      'content-length': end - start + 1,
      ...(want ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (end < start) { res.end(); return true; }   // an empty file: nothing to open
    const stream = createReadStream(file, { start, end });
    // A viewer who seeks away, closes the tab or reloads abandons the response
    // mid-body. Without this the read runs to the end of the range into a
    // socket nobody is holding, and the descriptor goes with it.
    res.on('close', () => stream.destroy());
    stream.on('error', () => {
      // The headers are already out, so there is no status left to report a
      // failed read with and writeHead would throw on top of it. Cutting the
      // connection is what tells the client the body it was promised is short.
      res.destroy();
    });
    stream.pipe(res);
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
          const onListening = () => {
            server.off('error', onError);
            // the bind race is over, but a server with no 'error' listener
            // turns the next one into an uncaught exception
            server.on('error', (e) => console.error(`server error: ${e.message}`));
            res(server.address().port);
          };
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
