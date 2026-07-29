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
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

export const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Static files under `root`, GET only: traversal-guarded, MIME-typed,
 * no-cache. `index` is the path "/" serves (the deck). `headers` ride on
 * every 200 — the seam a Content-Security-Policy arrives through (PRESENT).
 * Returns whether the request was handled.
 *
 * `html` rewrites the text of every text/html response on its way out and
 * leaves every other type alone. It is how `present --strict` (PRESENT#STRICT)
 * serves a deck with the unaccounted blocks removed while the file on disk
 * stays exactly as it arrived: the transform sits between the read and the
 * write, so there is no point in this path where the modified bytes could be
 * mistaken for the deck.
 */
export function staticFiles(root, { index = '/index.html', headers = {}, html: rewriteHtml = null } = {}) {
  return (req, res, url) => {
    if (req.method !== 'GET') return false;
    const rel = url.pathname === '/' ? index : decodeURIComponent(url.pathname);
    const file = resolve(root, '.' + rel);
    if (!file.startsWith(root + sep) && file !== root) { res.writeHead(403); res.end('forbidden'); return true; }
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return true; }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    let body = readFileSync(file);
    if (rewriteHtml && type === MIME['.html']) body = Buffer.from(rewriteHtml(body.toString('utf8'), file), 'utf8');
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...headers });
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
