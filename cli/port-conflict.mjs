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
import { execFileSync } from 'node:child_process';

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

/**
 * The same question for a BRIDGE — the voice and lip-sync servers answer
 * `/ping`, not `/edit/ping`, so an edit-server probe reports them as strangers
 * and the offer to take the port over never appears.
 *
 * Returns the same shape the caller already handles: something with a `name`
 * to put in a sentence.
 */
export async function identifyBridge(port, host = '127.0.0.1') {
  try {
    const res = await fetch(`http://${host}:${port}/ping`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    const d = await res.json();
    if (!d?.ok) return null;
    // tts answers with an engine, lipsync with its own shape; either way the
    // point is that a decklight bridge is there and can be asked to stop.
    return { ...d, bridge: true, name: d.engine ? `the ${d.engine} voice bridge` : 'a decklight bridge' };
  } catch {
    return null;
  }
}

/**
 * Who holds this port, when it is NOT one of ours.
 *
 * This file's whole premise was "ask it over HTTP, never guess at a PID — no
 * lsof, no platform split", and that is still right for anything decklight can
 * stop cleanly. But it left the commonest real case mute: a stranger's process
 * on the port produced a bare "using a different port", or — for the bridges,
 * which never called any of this — a raw EADDRINUSE stack trace.
 *
 * So a stranger gets NAMED, best effort, and only to put in a question. `lsof`
 * is macOS/Linux; Windows and a missing lsof simply return null and the caller
 * falls back to moving ports, which is what it did before.
 */
export function identifyStranger(port, { exec = null } = {}) {
  if (process.platform === 'win32') return null;
  try {
    const run = exec ?? ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000 }));
    const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pc']);
    // `-F pc` prints `p<pid>` and `c<command>` on their own lines
    const pid = /^p(\d+)$/m.exec(out)?.[1];
    const command = /^c(.+)$/m.exec(out)?.[1];
    return pid ? { pid: Number(pid), command: command ?? 'an unknown process' } : null;
  } catch {
    return null;   // no lsof, no permission, nothing listening — all "we cannot say"
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
 * only when something can be asked.
 *
 * A BRIDGE MAY NEVER MOVE, and that is the whole reason `kind` exists. The
 * two servers fail differently because only one of them gets to announce
 * where it landed:
 *
 *   the EDIT server hands its address to a human. It prints the URL it
 *   actually bound and you open that one, so bumping costs nothing.
 *
 *   a BRIDGE hands its address to nobody. The deck does not discover the
 *   bridge, it ASSUMES it: `src/core/narration.js` hardcodes
 *   `http://127.0.0.1:8787/tts` (and derives /ping, /engines, /voices from
 *   it), `src/core/character.js` hardcodes `:8789`, and the only override is
 *   a `liveUrl`/`bridgeUrl` written into the deck itself. author passes
 *   `--tts-port` to the bridge process and never tells the deck — it could
 *   not tell it anyway, since the deck is served verbatim and is as often
 *   opened over `file://`. The two sides agree only because both default to
 *   the same literal.
 *
 * So a bridge that bumps is a bridge nobody is talking to: the deck keeps
 * knocking on 8787, reaches whatever squats there, and reports no live voice
 * with nothing on screen to explain it. That is strictly worse than the
 * EADDRINUSE crash this replaced — the crash at least said something. A
 * bridge therefore either takes ITS port, or stands aside for the bridge
 * already serving it (`reuse`), or declines to start and says why
 * (`refuse`).
 */
export function planPortConflict({ tty = false, identified = null, stranger = null, kind = 'edit' } = {}) {
  // What happens with no terminal — and what a DECLINED offer falls back to.
  const fallback = kind !== 'bridge' ? 'bump'    // an edit server announces itself
    : identified ? 'reuse'                       // ours, already answering: use it
    : 'refuse';                                  // a bridge off its port is a lie
  if (!tty) return fallback;                     // never kill anything unattended
  if (identified) return 'ask';                  // ours: offer a CLEAN shutdown
  if (stranger) return 'ask-stranger';           // somebody else's: offer, never assume
  return fallback;                               // nothing we can name
}

/**
 * The port is already bound. Work out who's there and either take it over or
 * step aside. `ask` is `(prompt) => Promise<string>`; its absence means no
 * TTY to ask on, and nothing is ever killed without one.
 *
 * Returns the port to bind, or **null meaning "do not listen at all"** — a
 * bridge whose port is spoken for, which cannot just move (see
 * planPortConflict). `kind: 'edit'` never returns null, so the two existing
 * callers are unaffected.
 */
export async function resolvePortConflict(port, {
  host = '127.0.0.1', ask, log = () => {}, kind = 'edit', stranger = identifyStranger,
  identify = null,
} = {}) {
  // Ours, whichever kind: an edit server answers /edit/ping, a bridge answers
  // /ping. Asking only the first reported every bridge as a stranger.
  //
  // Injectable for the same reason `stranger` is: this REALLY CONNECTS to the
  // port, so a test naming a plausible number is at the mercy of whatever the
  // developer happens to be running. That is not hypothetical — the refusal
  // test named 8787, and passed everywhere except on a machine with a live
  // voice bridge on it, which is every machine this feature is for.
  const whoIsThere = identify ?? ((p, h) => (kind === 'bridge'
    ? identifyBridge(p, h)
    : identifyEditServer(p, h).then((e) => e ?? identifyBridge(p, h))));
  const identified = await whoIsThere(port, host);
  const other = identified ? null : stranger(port);
  const action = planPortConflict({ tty: Boolean(ask), identified, stranger: other, kind });

  // Somebody ELSE's process. decklight cannot ask it to stop the way it asks
  // its own — there is no endpoint to POST to — so the only lever is a signal,
  // and a signal is not something to send on decklight's own judgement: that
  // process may be a dev server with unsaved work in it. Named, offered, and
  // DEFAULTED TO THE HARMLESS ANSWER, so the destructive one is only ever
  // reached by typing it.
  let named = false;   // the occupant is worth naming once, not once per branch
  if (action === 'ask-stranger') {
    log(`  port ${port} is held by ${other.command} (pid ${other.pid}) — not a decklight server`);
    named = true;
    // The alternative to killing is NOT the same for both kinds, so it must not
    // be worded the same: an edit server moves, a bridge does not get to.
    const or = kind === 'bridge' ? '[c]arry on without this bridge? [k/C]' : 'use a [d]ifferent port? [k/D]';
    const answer = (await ask(`  [k]ill pid ${other.pid} and take the port, or ${or} `)).trim().toLowerCase();
    if (answer.startsWith('k')) {
      try {
        process.kill(other.pid, 'SIGTERM');
        for (let i = 0; i < 30 && (await isPortOpen(port, host)); i++) await new Promise((r) => setTimeout(r, 100));
        if (!(await isPortOpen(port, host))) { log(`  stopped pid ${other.pid}`); return port; }
        log('  it did not stop in time — using a different port instead');
      } catch (e) {
        log(`  could not stop pid ${other.pid} (${e.code ?? e.message}) — using a different port instead`);
      }
    }
  } else if (action === 'ask') {
    log(identified.bridge
      ? `  port ${port} is already in use — ${identified.name} is running there`
      : `  port ${port} is already in use — decklight is editing "${identified.name}" there`);
    const answer = (await ask('  [k]ill that session and take it over, or use a [d]ifferent port? [k/D] ')).trim().toLowerCase();
    if (answer.startsWith('k')) {
      log(`  stopping ${identified.bridge ? identified.name : `the session editing "${identified.name}"`}…`);
      // An edit server is asked to stop, because it has a final autocommit to
      // make and losing that would be losing work. A BRIDGE has no such
      // endpoint and nothing to lose — it is a stateless synthesiser — so it
      // gets a signal, using the pid the stranger lookup finds. Without a pid
      // (Windows, no lsof) there is nothing to do but move ports, which is
      // exactly what happens.
      if (!identified.bridge) {
        if (await shutdownEditServer(port, host)) return port;
      } else {
        const who = stranger(port);
        if (who) {
          try {
            process.kill(who.pid, 'SIGTERM');
            for (let i = 0; i < 30 && (await isPortOpen(port, host)); i++) await new Promise((r) => setTimeout(r, 100));
            if (!(await isPortOpen(port, host))) return port;
          } catch { /* fall through to the bump */ }
        }
      }
      log("  it didn't stop in time — using a different port instead");
    }
  }

  // Whatever was offered was declined, or there was nobody to ask. How that
  // ends is the caller's kind, not this function's mood.
  const ending = planPortConflict({ tty: false, identified, stranger: other, kind });

  // Ours, and already doing the job. A second bridge would bind a port the
  // deck never calls, so the useful move is to stand aside and say so: null
  // means "do not listen", and the one on `port` serves the deck as before.
  if (ending === 'reuse') {
    log(`  port ${port} already has ${identified.name} on it — using that one rather than starting a second`);
    return null;
  }

  // Somebody else's, and a bridge cannot work anywhere but here. Say who has
  // it and both ways out, then decline: author reports the bridge as gone and
  // the deck degrades honestly, which beats a live voice that fails silently.
  if (ending === 'refuse') {
    if (!named) {
      log(other
        ? `  port ${port} is held by ${other.command} (pid ${other.pid}) — not a decklight bridge`
        : `  port ${port} is already in use`);
    }
    log(`  the deck asks for this bridge on ${port} and nowhere else, so it will not start.`);
    log(`  free the port (kill ${other ? other.pid : 'the process holding it'}), or move BOTH sides:`);
    log(`  run with --port N and set narration.liveUrl in the deck to match.`);
    return null;
  }

  log(identified
    ? `  port ${port} is already in use — ${identified.bridge ? identified.name : `decklight is editing "${identified.name}"`} there; using a different port`
    : `  port ${port} is already in use; using a different port`);
  const next = await nextFreePort(port + 1, host);
  log(`  → using port ${next}`);
  return next;
}
