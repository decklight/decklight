// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Port-conflict resolution for `decklight author`'s edit server: who's on a
// taken port, and the two ways out — take it over (POST /edit/shutdown) or
// move to the next free port. planPortConflict() is pure and unit-tested
// directly; identify/shutdown/bump are exercised against a real edit server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers.mjs';
import { fileURLToPath } from 'node:url';

import { isPortOpen, identifyEditServer, nextFreePort, planPortConflict, resolvePortConflict, canBind } from '../cli/port-conflict.mjs';
import { DECK_URL_RE } from '../cli/banner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const EDIT = path.resolve(here, '../cli/edit.mjs');

const DECK = `<!doctype html>
<html><body><div class="decklight"><section><h2>One</h2></section></div></body></html>
`;

const tmp = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-portconflict-'));
  t.after(() => rmTemp(dir));
  return dir;
};

function waitFor(getText, pattern, timeoutMs = 10000) {
  return new Promise((resolveWait, rejectWait) => {
    const start = Date.now();
    const scan = setInterval(() => {
      const m = getText().match(pattern);
      if (m) { clearInterval(scan); resolveWait(m); return; }
      if (Date.now() - start > timeoutMs) { clearInterval(scan); rejectWait(new Error(`timed out waiting for ${pattern}\n${getText()}`)); }
    }, 25);
  });
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('timed out waiting for exit')), timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolveExit(code); });
  });
}

/** Spawn the edit server (through its module, as `author` does) in its own deck dir, on `port` (0 = OS picks one). */
async function startEdit(t, port = 0, extraArgs = []) {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const child = spawn(process.execPath, [EDIT, 'deck.html', '--port', String(port), ...extraArgs], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  // NOT the banner's DECK_URL_RE: this is the edit server run bare, the way
  // `decklight edit` runs it, and a bare child still prints its own sentence.
  // The banner only exists when author is the one doing the printing.
  const [, actual] = await waitFor(() => out, /decklight author on http:\/\/127\.0\.0\.1:(\d+)/);
  return { child, dir, port: Number(actual), log: () => out };
}

// ── planPortConflict: pure decision table ──────────────────────────────────

test('planPortConflict: only asks when there is a TTY AND an identified decklight server', () => {
  assert.equal(planPortConflict({ tty: false, identified: null }), 'bump');
  assert.equal(planPortConflict({ tty: false, identified: { name: 'x.html' } }), 'bump');
  assert.equal(planPortConflict({ tty: true, identified: null }), 'bump');
  assert.equal(planPortConflict({ tty: true, identified: { name: 'x.html' } }), 'ask');
});

// ── isPortOpen / nextFreePort: work against ANY occupant, not just decklight ──

test('isPortOpen and nextFreePort see a plain TCP listener, not just decklight', async (t) => {
  const srv = createTcpServer(() => {});
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  t.after(() => srv.close());

  assert.equal(await isPortOpen(port), true);
  assert.equal(await isPortOpen(0), false, 'port 0 never conflicts');

  const free = await nextFreePort(port);
  assert.ok(free > port, 'skipped past the occupied port');
  assert.equal(await isPortOpen(free), false);
});

test('identifyEditServer is null for a non-decklight occupant', async (t) => {
  const srv = createTcpServer((sock) => sock.end());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  t.after(() => srv.close());
  assert.equal(await identifyEditServer(port), null);
});

// ── resolvePortConflict: the two ways out, against a REAL edit server ─────

test('no TTY to ask: the port silently bumps, and A is left running', async (t) => {
  const a = await startEdit(t);
  const logs = [];
  const next = await resolvePortConflict(a.port, { log: (s) => logs.push(s) }); // no `ask` — not a TTY
  assert.ok(next > a.port);
  assert.equal(await isPortOpen(next), false);
  assert.match(logs.join('\n'), /already in use.*using a different port/s);
  assert.equal((await identifyEditServer(a.port))?.name, 'deck.html', 'A was never asked to shut down');
});

test('a TTY that answers "different port": still bumps, A stays up', async (t) => {
  const a = await startEdit(t);
  const next = await resolvePortConflict(a.port, { ask: async () => 'd' });
  assert.ok(next > a.port);
  assert.equal((await identifyEditServer(a.port))?.name, 'deck.html');
});

test('a TTY that answers "kill": takes over the SAME port — A actually exits', async (t) => {
  const a = await startEdit(t);
  const questions = [];
  const next = await resolvePortConflict(a.port, {
    ask: async (q) => { questions.push(q); return 'k'; },
    log: () => {},
  });
  assert.equal(next, a.port, 'took over the same port, no bump');
  assert.match(questions[0], /\[k\]ill/);
  await waitForExit(a.child);
  assert.equal(await isPortOpen(a.port), false);
});

// ── the probe: can I BIND, not is anyone THERE ────────────────────────────
//
// These two questions have different answers on Windows, and the difference is
// #334. Hyper-V and WinNAT reserve blocks of ephemeral ports; a reserved port
// has NOTHING LISTENING on it, so a connect probe calls it free and the bind
// that follows fails `EACCES` — a permission error rather than `EADDRINUSE`,
// which is why it surfaced as a crash instead of a busy port.

test('canBind answers about binding, where isPortOpen answers about listening', async () => {
  const srv = createTcpServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const taken = srv.address().port;
  try {
    assert.equal(await canBind(taken), false, 'a port in use was reported bindable');
    assert.equal(await isPortOpen(taken), true, 'and the connect probe agrees it is occupied');
  } finally { await new Promise((r) => srv.close(r)); }
  // once released, both agree the other way
  assert.equal(await canBind(taken), true);
  assert.equal(await isPortOpen(taken), false);
});

test('canBind refuses a port this process may not have, without throwing', async (t) => {
  // Port 1 is privileged: binding it as an ordinary user is EACCES — the same
  // class of failure a Windows reservation produces, and the one the old
  // connect probe could not see at all. Skipped where the runner IS root,
  // because there it is bindable and the assertion would be about privilege
  // rather than about the probe.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return t.skip('running as root — port 1 is bindable here');
  }
  if (process.platform === 'win32') return t.skip('Windows privilege model differs');
  assert.equal(await canBind(1), false);
});

test('nextFreePort walks past a whole block of unavailable ports', async () => {
  // A reservation is a BLOCK, often sixteen or more — the case that turns a
  // single bad candidate into a run of them. Occupied here with real servers,
  // which is the closest a test can get to a reserved range portably.
  const srvs = [];
  const RUN = 6;
  // A random base so parallel runs do not collide, and a band chosen so the
  // whole run stays inside the port range: `51000 + random*2000*8` reached
  // 66992 and Node refused the listen with ERR_SOCKET_BAD_PORT on a Windows
  // runner — arithmetic that happens to land low enough on the machine you
  // wrote it on is the shape of bug this whole file is about.
  const first = 49200 + Math.floor(Math.random() * 200) * 8;
  assert.ok(first + RUN < 65536, `base ${first} would run past the port range`);
  for (let p = first; p < first + RUN; p++) {
    const s = createTcpServer();
    // a port that was already taken by something else just makes the run
    // shorter — the assertion below is about the ANSWER, not the length
    await new Promise((r) => { s.once('error', r); s.listen(p, '127.0.0.1', r); });
    srvs.push(s);
  }
  try {
    const free = await nextFreePort(first);
    assert.ok(free >= first, 'went backwards');
    // THE property: the answer walked past every port this test holds. That
    // is what nextFreePort promises, and it is checkable without a race.
    // only the servers that actually LISTEN hold a port: one whose listen
    // failed (the port was already somebody else's) sits in srvs with no
    // address — the Windows runner had exactly one of those
    const held = new Set(srvs.map((s) => s.address()?.port).filter(Boolean));
    assert.equal(held.has(free), false, `nextFreePort returned ${free}, a port this test still holds`);
    // The old assertion re-bound `free` immediately and failed three times on
    // Windows CI: nextFreePort's probe binds and closes the socket, and
    // Windows can hold a just-closed port for a beat — so "cannot be bound"
    // was the runner's socket teardown, not a wrong answer. A brief retry
    // separates the two: a port genuinely taken by another process stays
    // taken, a port mid-teardown frees in milliseconds. (The function's
    // contract is inherently look-then-bind; its callers bind at once and
    // handle a loss themselves — listenTakingOverIfNeeded.)
    let bindable = false;
    for (let i = 0; i < 10 && !bindable; i++) {
      bindable = await canBind(free);
      if (!bindable) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(bindable, true, `nextFreePort returned ${free}, which stayed unbindable for 500ms`);
  } finally {
    for (const s of srvs) await new Promise((r) => s.close(r));
  }
});

test('nextFreePort gives up rather than walking forever', async () => {
  // An unbounded walk through a reserved block is indistinguishable from a
  // hang. Giving up returns the ORIGINAL port, so the caller fails with the
  // real bind error rather than on a number this function invented.
  const nothingIsFree = await nextFreePort(50000, '127.0.0.1', 0);
  assert.equal(nothingIsFree, 50000);
});

// ── end to end: the edit server itself never crashes on a taken port ──────

test('a second edit server on the same port bumps and says why (no TTY, no crash)', async (t) => {
  const a = await startEdit(t);
  const b = await startEdit(t, a.port);
  assert.notEqual(b.port, a.port);
  assert.match(b.log(), /already in use/);
  assert.equal(b.child.exitCode, null, 'never crashed');
});

// ── end to end: `decklight author` resolves the conflict itself — its edit
// child's stdin is piped, not a terminal, so IT could never ask ───────────

test('`decklight author` bumps the edit port on conflict instead of crashing', async (t) => {
  const a = await startEdit(t);

  const devDir = tmp(t);
  writeFileSync(path.join(devDir, 'deck.html'), DECK);
  const dev = spawn(process.execPath, [
    CLI, 'author', 'deck.html', '--port', String(a.port), '--no-tts', '--no-lipsync', '--no-git',
  ], { cwd: devDir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { dev.kill('SIGKILL'); } catch { /* already gone */ } });
  let out = '';
  dev.stdout.on('data', (c) => { out += c; });
  dev.stderr.on('data', (c) => { out += c; });

  await waitFor(() => out, /already in use/);
  const [, bumped] = await waitFor(() => out, DECK_URL_RE);
  assert.notEqual(Number(bumped), a.port);
  assert.equal(dev.exitCode, null, 'author never gave up');
});
