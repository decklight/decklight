// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Shared "the port's taken" resolution for `decklight author`'s edit server.
// The occupant is usually a PAST edit server (you started one
// yesterday, forgot, and now `init`/`author` wants the same default port) — so
// rather than guess at a PID, ask it directly: every edit server answers
// GET /edit/ping with the deck it's serving, and POST /edit/shutdown stops it
// as cleanly as its own Ctrl-C (final autocommit included). That makes "kill
// it and take over" a plain HTTP round trip, no lsof/ps, no platform split.
//
// Used two ways: reactively, when edit's own server.listen() hits
// EADDRINUSE, and proactively, by author BEFORE it spawns the edit child —
// that child's stdin is closed (piped, not a TTY), so it could never ask.

import { createConnection, createServer } from 'node:net';

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

/** Ask the occupant what it's editing — null if it isn't an edit server at all. */
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

/**
 * Can we actually LISTEN on this port?
 *
 * `isPortOpen` asks a different question — it connects, so it answers "is
 * somebody there". For "may I have this port" that is the wrong question, and
 * on Windows it is wrong in a way that fails: Hyper-V and WinNAT reserve blocks
 * of ephemeral ports (`netsh int ipv4 show excludedportrange`), and a reserved
 * port has NOTHING LISTENING on it. Connect is refused, `isPortOpen` says
 * "free", and the bind that follows gets `EACCES` — a permission error, not
 * `EADDRINUSE`, which is why it read as a crash rather than a busy port (#334).
 *
 * Binding is the only probe that answers the question being asked. It costs one
 * listen/close per candidate, which is cheaper than the connect it replaces.
 */
export function canBind(port, host = '127.0.0.1') {
  return new Promise((done) => {
    const server = createServer();
    // Every reason a bind can fail is a reason to try the next port: taken
    // (EADDRINUSE), reserved or privileged (EACCES), or an address this host
    // does not have (EADDRNOTAVAIL). None of them become usable by waiting.
    server.once('error', () => done(false));
    server.once('listening', () => server.close(() => done(true)));
    try { server.listen(port, host); } catch { done(false); }
  });
}

/**
 * The next port at or after `port` this process can actually bind.
 *
 * Bounded, because the failure it now catches can repeat: a Hyper-V reservation
 * is a BLOCK of ports, often 16 or more, and an unbounded walk through one is
 * indistinguishable from a hang. Giving up returns the original port so the
 * caller fails with the real bind error rather than on a number this function
 * invented.
 */
export async function nextFreePort(port, host = '127.0.0.1', tries = 64) {
  for (let p = port; p < port + tries && p <= 65535; p++) {
    if (await canBind(p, host)) return p;
  }
  return port;
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
