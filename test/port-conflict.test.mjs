// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Port-conflict resolution for `decklight edit` / `decklight dev`: who's on a
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
import { fileURLToPath } from 'node:url';

import {
  isPortOpen, identifyEditServer, nextFreePort, planPortConflict, resolvePortConflict,
} from '../cli/port-conflict.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

const DECK = `<!doctype html>
<html><body><div class="decklight"><section><h2>One</h2></section></div></body></html>
`;

const tmp = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-portconflict-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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

/** Spawn `decklight edit` in its own deck dir, on `port` (0 = OS picks one). */
async function startEdit(t, port = 0, extraArgs = []) {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const child = spawn(process.execPath, [CLI, 'edit', 'deck.html', '--port', String(port), ...extraArgs], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const [, actual] = await waitFor(() => out, /decklight edit on http:\/\/127\.0\.0\.1:(\d+)/);
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

// ── end to end: `decklight edit` itself never crashes on a taken port ──────

test('a second `decklight edit` on the same port bumps and says why (no TTY, no crash)', async (t) => {
  const a = await startEdit(t);
  const b = await startEdit(t, a.port);
  assert.notEqual(b.port, a.port);
  assert.match(b.log(), /already in use/);
  assert.equal(b.child.exitCode, null, 'never crashed');
});

// ── end to end: `decklight dev` resolves the conflict itself — its edit
// child's stdin is piped, not a terminal, so IT could never ask ───────────

test('`decklight dev` bumps the edit port on conflict instead of crashing', async (t) => {
  const a = await startEdit(t);

  const devDir = tmp(t);
  writeFileSync(path.join(devDir, 'deck.html'), DECK);
  const dev = spawn(process.execPath, [
    CLI, 'dev', 'deck.html', '--port', String(a.port), '--no-tts', '--no-lipsync', '--no-git',
  ], { cwd: devDir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { dev.kill('SIGKILL'); } catch { /* already gone */ } });
  let out = '';
  dev.stdout.on('data', (c) => { out += c; });
  dev.stderr.on('data', (c) => { out += c; });

  await waitFor(() => out, /already in use/);
  const [, bumped] = await waitFor(() => out, /decklight edit on http:\/\/127\.0\.0\.1:(\d+)/);
  assert.notEqual(Number(bumped), a.port);
  assert.equal(dev.exitCode, null, 'dev never gave up');
});
