// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Shared "the port's taken" resolution for `decklight edit` / `decklight dev`.
// The occupant is usually a PAST decklight edit server (you started one
// yesterday, forgot, and now `init`/`dev` wants the same default port) — so
// rather than guess at a PID, ask it directly: every edit server answers
// GET /edit/ping with the deck it's serving, and POST /edit/shutdown stops it
// as cleanly as its own Ctrl-C (final autocommit included). That makes "kill
// it and take over" a plain HTTP round trip, no lsof/ps, no platform split.
//
// Used two ways: reactively, when edit's own server.listen() hits
// EADDRINUSE, and proactively, by dev BEFORE it spawns the edit child — that
// child's stdin is closed (piped, not a TTY), so it could never ask.

import { createConnection } from 'node:net';

/** Is something listening on `port`? Port 0 ("OS picks one") never conflicts. */
export function isPortOpen(port, host = '127.0.0.1', timeout = 400) {
  if (!port) return Promise.resolve(false);
  return new Promise((done) => {
    const socket = createConnection({ host, port, timeout });
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('timeout', () => { socket.destroy(); done(false); });
    socket.once('error', () => done(false));
  });
}

/** Ask the occupant what it's editing — null if it isn't a decklight edit server at all. */
export async function identifyEditServer(port, host = '127.0.0.1') {
  try {
    const res = await fetch(`http://${host}:${port}/edit/ping`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok ? data : null;
  } catch {
    return null;
  }
}

/** Ask it to stop — it auto-commits and exits, same as its own Ctrl-C. Resolves once the port is free. */
export async function shutdownEditServer(port, host = '127.0.0.1') {
  try {
    await fetch(`http://${host}:${port}/edit/shutdown`, { method: 'POST', signal: AbortSignal.timeout(800) });
  } catch {
    // it may hang up mid-response as it exits — that's the expected shape
  }
  for (let i = 0; i < 30 && (await isPortOpen(port, host)); i++) await new Promise((r) => setTimeout(r, 100));
  return !(await isPortOpen(port, host));
}

/** The next port at or after `port` that nothing is listening on. */
export async function nextFreePort(port, host = '127.0.0.1') {
  let p = port;
  while (await isPortOpen(p, host)) p++;
  return p;
}

/**
 * Pure: what to do about a taken port — testable without a socket or a
 * terminal. Only offers to kill an occupant we can actually identify AND
 * only when something can be asked; anything else just moves to a free port.
 */
export function planPortConflict({ tty = false, identified = null } = {}) {
  return tty && identified ? 'ask' : 'bump';
}

/**
 * The port is already bound. Work out who's there and either take it over or
 * move on. `ask` is `(prompt) => Promise<string>`; its absence means no TTY
 * to ask, so the port just bumps. Returns the port actually free to use.
 */
export async function resolvePortConflict(port, { host = '127.0.0.1', ask, log = () => {} } = {}) {
  const identified = await identifyEditServer(port, host);
  const action = planPortConflict({ tty: Boolean(ask), identified });

  if (action === 'ask') {
    log(`  port ${port} is already in use — decklight is editing "${identified.name}" there`);
    const answer = (await ask('  [k]ill that session and take it over, or use a [d]ifferent port? [k/D] ')).trim().toLowerCase();
    if (answer.startsWith('k')) {
      log(`  stopping the session editing "${identified.name}"…`);
      if (await shutdownEditServer(port, host)) return port;
      log("  it didn't stop in time — using a different port instead");
    }
  } else {
    log(identified
      ? `  port ${port} is already in use — decklight is editing "${identified.name}" there; using a different port`
      : `  port ${port} is already in use; using a different port`);
  }

  const next = await nextFreePort(port + 1, host);
  log(`  → using port ${next}`);
  return next;
}
