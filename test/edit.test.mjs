// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The dev/edit server's editing surface: layout write-back, the undo/redo
// history, git autocommit, and the AI-agent roster. Pure functions are
// tested directly; the HTTP endpoints against a real server on an
// ephemeral port with a throwaway deck.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setSlideLayout, createHistory, gitAutocommit, inGitRepo, STARTER_GITIGNORE, allowRemote, lanAddress } from '../cli/edit.mjs';
import { AGENTS, detectAgents, agentCommand } from '../cli/agents.mjs';
import { resolveGitMode, shouldCommit, commitSubject } from '../cli/git.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

const DECK = `<!doctype html>
<html><body>
  <div class="decklight">
    <section>
      <h2>Alpha</h2>
      <ul><li>one</li></ul>
    </section>
    <section data-layout="centered">
      <h2>Beta</h2>
    </section>
  </div>
</body></html>
`;

// ── setSlideLayout: the file is the source of truth ───────────────────────

test('setSlideLayout writes, replaces, and (for auto) removes data-layout', () => {
  const set = setSlideLayout(DECK, 1, 'split');
  assert.match(set, /<section data-layout="split">\s*<h2>Alpha<\/h2>/);

  const replaced = setSlideLayout(DECK, 2, 'top');
  assert.match(replaced, /<section data-layout="top">\s*<h2>Beta<\/h2>/);
  assert.doesNotMatch(replaced, /centered/);

  const removed = setSlideLayout(DECK, 2, 'auto');
  assert.match(removed, /<section>\s*<h2>Beta<\/h2>/);

  // single-quoted attributes are an author's prerogative
  const single = setSlideLayout(DECK.replace('data-layout="centered"', "data-layout='centered'"), 2, 'pinned');
  assert.match(single, /<section data-layout="pinned">/);
});

test('setSlideLayout is exact about its inputs', () => {
  assert.throws(() => setSlideLayout(DECK, 3, 'top'), /no slide 3 \(deck has 2\)/);
  assert.throws(() => setSlideLayout(DECK, 1, 'sideways'), /unknown layout/);
  // idempotence: same layout in → identical file out (the server skips the write)
  assert.equal(setSlideLayout(DECK, 2, 'centered'), DECK);
});

// ── the history: one stack for every mutation, independent of git ─────────

test('history: record/undo/redo round-trips, external edits are never lost', () => {
  const h = createHistory();
  assert.equal(h.undo('v1'), null, 'empty stack says so');

  h.record('v1'); // v1 → v2
  h.record('v2'); // v2 → v3
  assert.deepEqual(h.counts(), { undo: 2, redo: 0 });

  assert.equal(h.undo('v3'), 'v2');
  assert.equal(h.undo('v2'), 'v1');
  assert.deepEqual(h.counts(), { undo: 0, redo: 2 });
  assert.equal(h.redo('v1'), 'v2');

  // an edit made OUTSIDE the server between undo and redo rides the redo
  // stack instead of vanishing: whatever was current goes on the other side
  assert.equal(h.undo('v2-external'), 'v1');
  assert.equal(h.redo('v1'), 'v2-external');

  // a new edit clears the future
  h.record('v2');
  assert.deepEqual(h.counts(), { undo: 2, redo: 0 });
});

test('history is capped — the oldest snapshots fall off, not the newest', () => {
  const h = createHistory(3);
  for (const v of ['a', 'b', 'c', 'd']) h.record(v);
  assert.deepEqual(h.counts(), { undo: 3, redo: 0 });
  assert.equal(h.undo('e'), 'd');
  assert.equal(h.undo('d'), 'c');
  assert.equal(h.undo('c'), 'b'); // 'a' fell off
  assert.equal(h.undo('b'), null);
});

// ── allowRemote: the security seam for the phone remote (#115) ─────────────
// One pure classifier decides every request: loopback always answers,
// off-loopback only /remote/* with the per-run token — and /edit/* refuses
// non-loopback callers no matter what the request carries.

const reqOf = (addr, url, headers = {}) => ({ socket: { remoteAddress: addr }, url, headers });

test('allowRemote: loopback always answers — token or no token, any path', () => {
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.8.9.10']) {
    assert.equal(allowRemote(reqOf(addr, '/edit/notes'), null), true, addr);
    assert.equal(allowRemote(reqOf(addr, '/edit/undo'), 'tok'), true, addr);
    assert.equal(allowRemote(reqOf(addr, '/deck.html'), 'tok'), true, addr);
  }
});

test('allowRemote: off-loopback, only /remote/* — and only with the right token', () => {
  const LAN = '192.168.1.23';
  // the /remote?t= URL the phone will carry, and its sub-paths
  assert.equal(allowRemote(reqOf(LAN, '/remote?t=tok'), 'tok'), true);
  assert.equal(allowRemote(reqOf(LAN, '/remote/state?t=tok'), 'tok'), true);
  // the token can ride a header too (fetches from the controller page)
  assert.equal(allowRemote(reqOf(LAN, '/remote/state', { 'x-decklight-token': 'tok' }), 'tok'), true);
  // wrong token, missing token: refused
  assert.equal(allowRemote(reqOf(LAN, '/remote/state?t=nope'), 'tok'), false);
  assert.equal(allowRemote(reqOf(LAN, '/remote/state'), 'tok'), false);
  // no --remote (token null): nothing off-loopback answers at all
  assert.equal(allowRemote(reqOf(LAN, '/remote/state?t='), null), false);
  assert.equal(allowRemote(reqOf(LAN, '/remote?t=null'), null), false);
});

test('allowRemote: /edit/* refuses off-loopback UNCONDITIONALLY — token included', () => {
  const LAN = '10.0.0.7';
  for (const p of ['/edit/notes', '/edit/layout', '/edit/undo', '/edit/redo', '/edit/agent', '/edit/shutdown']) {
    assert.equal(allowRemote(reqOf(LAN, `${p}?t=tok`), 'tok'), false, p);
  }
  // static files are not reachable off-loopback either
  assert.equal(allowRemote(reqOf(LAN, '/deck.html?t=tok'), 'tok'), false);
  // path tricks normalize before the check, and a prefix is not a directory
  assert.equal(allowRemote(reqOf(LAN, '/remote/../edit/notes?t=tok'), 'tok'), false);
  assert.equal(allowRemote(reqOf(LAN, '/remotely?t=tok'), 'tok'), false);
});

// ── the agent roster ───────────────────────────────────────────────────────

test('the big three are in the roster — claude, codex, and bob are non-negotiable', () => {
  for (const name of ['claude', 'codex', 'bob']) {
    assert.ok(AGENTS.some((a) => a.name === name), `${name} missing from the roster`);
  }
});

test('detectAgents reports only what the machine can run, in preference order', () => {
  assert.deepEqual(detectAgents({ hasBin: () => false }), []);
  const all = detectAgents({ hasBin: () => true });
  assert.deepEqual(all.slice(0, 3).map((a) => a.name), ['claude', 'codex', 'bob']);

  const some = detectAgents({ hasBin: (bin) => bin === 'codex' });
  assert.deepEqual(some.map((a) => a.name), ['codex']);
});

test('agentCommand builds each agent\'s headless one-shot invocation', () => {
  const claude = agentCommand('claude', 'center slide 2', 'deck.html', { hasBin: () => true });
  assert.equal(claude.bin, 'claude');
  assert.equal(claude.args[0], '-p');
  assert.match(claude.args[1], /deck\.html/, 'the prompt names the file');
  assert.match(claude.args[1], /center slide 2/, 'the prompt carries the instruction');
  assert.deepEqual(claude.args.slice(2), ['--permission-mode', 'acceptEdits']);

  const codex = agentCommand('codex', 'x', 'deck.html', { hasBin: () => true });
  assert.deepEqual(codex.args.slice(0, 2), ['exec', '--full-auto']);

  const bob = agentCommand('bob', 'x', 'deck.html', { hasBin: () => true });
  assert.equal(bob.args[0], '-p');
  assert.ok(bob.args.includes('--accept-license'), 'bob must not hang on the license prompt');

  // no name → the first detected agent; nothing detected → null
  assert.equal(agentCommand(undefined, 'x', 'd', { hasBin: () => true }).name, 'claude');
  assert.equal(agentCommand('claude', 'x', 'd', { hasBin: () => false }), null);
  assert.equal(agentCommand('sideways', 'x', 'd', { hasBin: () => true }), null);
});

// ── git: the durable record ────────────────────────────────────────────────

const tmp = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-edit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('gitAutocommit commits the deck only when it changed', (t) => {
  const dir = tmp(t);
  git(['init', '-q'], dir);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, DECK);

  assert.equal(gitAutocommit(deck, dir), true, 'first sight of the deck is a commit');
  assert.equal(gitAutocommit(deck, dir), false, 'unchanged deck, no commit');
  writeFileSync(deck, DECK + '<!-- more -->');
  assert.equal(gitAutocommit(deck, dir), true);
  assert.equal(git(['rev-list', '--count', 'HEAD'], dir), '2');
  assert.match(git(['log', '-1', '--format=%s'], dir), /decklight: autosave deck\.html/);
});

test('inGitRepo tells a work tree from a plain directory', (t) => {
  const dir = tmp(t);
  assert.equal(inGitRepo(dir), false);
  git(['init', '-q'], dir);
  assert.equal(inGitRepo(dir), true);
});

// ── the HTTP surface, against a real server ────────────────────────────────

async function startEdit(t, dir, { extraArgs = [], env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, 'edit', 'deck.html', '--port', '0', ...extraArgs], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); }
    }, 25);
    child.on('exit', () => { clearInterval(scan); reject(new Error('edit exited early:\n' + out)); });
    setTimeout(() => { clearInterval(scan); reject(new Error('timeout waiting for edit server:\n' + out)); }, 10000);
  });
  return { child, base, log: () => out };
}

const post = (base, ep, body) => fetch(base + ep, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('layout, undo, and redo write the deck FILE — and share one history', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } }); // PATH=dir: no git, no agents

  const ping = await (await fetch(base + '/edit/ping')).json();
  assert.deepEqual(
    { ok: ping.ok, undo: ping.undo, redo: ping.redo, git: ping.git, agents: ping.agents },
    { ok: true, undo: 0, redo: 0, git: false, agents: [] });

  // layout lands in the file
  let r = await (await post(base, '/edit/layout', { slide: 1, layout: 'split' })).json();
  assert.deepEqual({ changed: r.changed, undo: r.undo }, { changed: true, undo: 1 });
  assert.match(readFileSync(deck, 'utf8'), /<section data-layout="split">/);

  // same layout again: no write, no history entry
  r = await (await post(base, '/edit/layout', { slide: 1, layout: 'split' })).json();
  assert.deepEqual({ changed: r.changed, undo: r.undo }, { changed: false, undo: 1 });

  // notes go on the SAME stack
  await post(base, '/edit/notes', { slide: 1, text: 'hello ⟨CLICK⟩ world' });
  assert.match(readFileSync(deck, 'utf8'), /<aside class="notes">/);

  // undo twice: notes off, then layout off — back to the original file
  r = await (await post(base, '/edit/undo')).json();
  assert.deepEqual({ undo: r.undo, redo: r.redo }, { undo: 1, redo: 1 });
  r = await (await post(base, '/edit/undo')).json();
  assert.deepEqual({ undo: r.undo, redo: r.redo }, { undo: 0, redo: 2 });
  assert.equal(readFileSync(deck, 'utf8'), DECK);

  // a third undo is a clean 409, not a crash
  const empty = await post(base, '/edit/undo');
  assert.equal(empty.status, 409);
  assert.match((await empty.json()).error, /nothing to undo/);

  // redo replays the layout
  r = await (await post(base, '/edit/redo')).json();
  assert.deepEqual({ undo: r.undo, redo: r.redo }, { undo: 1, redo: 1 });
  assert.match(readFileSync(deck, 'utf8'), /data-layout="split"/);

  // garbage in, 400 out
  assert.equal((await post(base, '/edit/layout', { slide: 1, layout: 'sideways' })).status, 400);
  assert.equal((await post(base, '/edit/layout', { slide: 'x', layout: 'top' })).status, 400);
});

test('--git auto-commits on a cadence; undo/redo never consume the commits', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, DECK);
  const { base } = await startEdit(t, dir, { extraArgs: ['--git', '--commit-every', '5'] });

  assert.equal((await (await fetch(base + '/edit/ping')).json()).git, true);
  assert.equal(inGitRepo(dir), true, '--git created the repository');
  assert.equal(git(['rev-list', '--count', 'HEAD'], dir), '1', 'the opening commit');

  // a repository decklight created starts with the starter .gitignore
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), STARTER_GITIGNORE);

  // edit + undo + redo through the server: the file churns, git holds still
  await post(base, '/edit/layout', { slide: 1, layout: 'top' });
  await post(base, '/edit/undo');
  await post(base, '/edit/redo');
  assert.equal(git(['rev-list', '--count', 'HEAD'], dir), '1', 'history moves the file, never git');
  assert.match(readFileSync(deck, 'utf8'), /data-layout="top"/);
});

test('a repository decklight did not create never gets ignore rules', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  git(['init', '-q'], dir);
  const { base } = await startEdit(t, dir, { extraArgs: ['--git', '--commit-every', '5'] });

  assert.equal((await (await fetch(base + '/edit/ping')).json()).git, true);
  assert.equal(existsSync(path.join(dir, '.gitignore')), false,
    'the repo-creation moment is the only time decklight touches ignore rules');
});

test('an agent ask runs the detected CLI, and Z takes its edit back', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, DECK);

  // a fake `claude` on PATH: appends to the deck like a real edit would
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'claude'),
    '#!/bin/sh\nprintf \'<!-- agent-was-here -->\' >> deck.html\n');
  chmodSync(path.join(bin, 'claude'), 0o755);
  const { base } = await startEdit(t, dir, { env: { PATH: bin } });

  const ping = await (await fetch(base + '/edit/ping')).json();
  assert.deepEqual(ping.agents, [{ name: 'claude', label: 'Claude Code' }]);

  const started = await (await post(base, '/edit/agent', { prompt: 'sign the deck' })).json();
  assert.deepEqual({ ok: started.ok, agent: started.agent }, { ok: true, agent: 'claude' });

  // the run is async — wait for the edit to land on the undo stack
  for (let i = 0; i < 200; i++) {
    const p = await (await fetch(base + '/edit/ping')).json();
    if (p.undo === 1 && !p.agentBusy) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.match(readFileSync(deck, 'utf8'), /agent-was-here/);

  await post(base, '/edit/undo');
  assert.equal(readFileSync(deck, 'utf8'), DECK, 'undo takes the agent edit back');

  // asking for an agent that isn't there is a clean 400
  const missing = await post(base, '/edit/agent', { prompt: 'x', agent: 'codex' });
  assert.equal(missing.status, 400);
});

// ── --remote: LAN binding, the token, and the gate — end to end ───────────

test('--remote: a LAN-addressed /edit/notes is refused; loopback keeps working', async (t) => {
  const lan = lanAddress();
  if (!lan) return t.skip('no non-loopback IPv4 interface on this machine');
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, DECK);
  const { base, log } = await startEdit(t, dir, { extraArgs: ['--remote'], env: { PATH: dir } });
  const port = new URL(base).port;

  // the per-run token is printed as the LAN /remote?t= URL, IP and all
  const m = log().match(/remote: listening on 0\.0\.0\.0 — http:\/\/([\d.]+):\d+\/remote\?t=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'the remote URL is printed:\n' + log());
  assert.equal(m[1], lan, 'the printed IP comes from os.networkInterfaces()');
  const token = m[2];

  // off-loopback, the editing surface is closed — mutation, ping, and files
  const refused = await post(`http://${lan}:${port}`, '/edit/notes', { slide: 1, text: 'pwned' });
  assert.equal(refused.status, 403);
  assert.doesNotMatch(readFileSync(deck, 'utf8'), /pwned/, 'the refused write never lands');
  assert.equal((await fetch(`http://${lan}:${port}/edit/ping`)).status, 403);
  assert.equal((await fetch(`http://${lan}:${port}/deck.html`)).status, 403);

  // off-loopback /remote/* clears the gate with the token (404 until #39c
  // adds the endpoints — the point is it is not 403), and only with it
  assert.notEqual((await fetch(`http://${lan}:${port}/remote?t=${token}`)).status, 403);
  assert.equal((await fetch(`http://${lan}:${port}/remote?t=wrong`)).status, 403);

  // loopback edits work exactly as before, flag or no flag
  const ok = await post(base, '/edit/notes', { slide: 1, text: 'hello' });
  assert.equal(ok.status, 200);
  assert.match(readFileSync(deck, 'utf8'), /hello/);
});

test('without --remote the server binds 127.0.0.1 only — the LAN cannot even connect', async (t) => {
  const lan = lanAddress();
  if (!lan) return t.skip('no non-loopback IPv4 interface on this machine');
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base, log } = await startEdit(t, dir, { env: { PATH: dir } });
  const port = new URL(base).port;

  assert.doesNotMatch(log(), /remote:/, 'no token, no remote URL without the flag');
  await assert.rejects(
    fetch(`http://${lan}:${port}/edit/ping`, { signal: AbortSignal.timeout(2000) }),
    'the LAN address must not be listening');
});

// ── the phone remote (#39): controller, relay, readout ─────────────────────
// The security seam (which paths answer off-loopback, and on what token) is
// covered above with allowRemote. These cover what the endpoints actually do.

/**
 * Subscribe to an SSE endpoint and wait for text to appear on it. The fetch
 * resolves once the response headers land, which is after the server has
 * registered the client — so a POST issued after this returns cannot be missed.
 */
async function openSse(t, base, ep) {
  const ctl = new AbortController();
  t.after(() => ctl.abort());
  const res = await fetch(base + ep, { signal: ctl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  return {
    // Race every read against the deadline: a server that simply never sends
    // the event would otherwise park in reader.read() forever, and a suite
    // that hangs is worse than one that fails — it says nothing, slowly.
    async until(want, ms = 5000) {
      const deadline = Date.now() + ms;
      while (!buf.includes(want)) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`SSE never carried "${want}"; saw:\n${buf}`);
        let timer;
        const next = await Promise.race([
          reader.read(),
          new Promise((r) => { timer = setTimeout(() => r('timeout'), left); }),
        ]);
        clearTimeout(timer);
        if (next === 'timeout') throw new Error(`SSE never carried "${want}"; saw:\n${buf}`);
        if (next.done) throw new Error(`SSE closed before "${want}"; saw:\n${buf}`);
        buf += dec.decode(next.value, { stream: true });
      }
      return buf;
    },
  };
}

test('the phone controller is a self-contained page — no asset it could not reach', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });

  const res = await fetch(base + '/remote');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /id="next"/);
  assert.match(html, /id="prev"/);
  assert.match(html, /id="pos"/);
  // a phone is off-loopback: anything it fetches from elsewhere is a hole
  assert.doesNotMatch(html, /<link\b/i, 'no external stylesheet');
  assert.doesNotMatch(html, /src\s*=\s*["']https?:/i, 'no external script or image');
  // SPEC §11 — a clicker, not a second screen
  assert.doesNotMatch(html, /class="decklight"/, 'the phone renders no slides');
});

test('a tap on the phone reaches the deck as a remote event on its own stream', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });

  const deck = await openSse(t, base, '/edit/events'); // the deck's stream
  const res = await post(base, '/remote/key', { key: 'next' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).decks, 1, 'the server saw one deck listening');

  const seen = await deck.until('event: remote');
  assert.match(seen, /event: remote\ndata: \{"key":"next"\}/);
});

test("the deck's position reaches the phone's readout", async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });

  const phone = await openSse(t, base, '/remote/events');
  assert.equal((await post(base, '/remote/pos', { i: 3, n: 9 })).status, 200);
  const seen = await phone.until('event: pos');
  assert.match(seen, /event: pos\ndata: \{"i":3,"n":9\}/);
});

test('a phone joining mid-talk is told the position at once', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });

  await post(base, '/remote/pos', { i: 5, n: 12 }); // deck moved before the phone joined
  const phone = await openSse(t, base, '/remote/events');
  assert.match(await phone.until('event: pos'), /\{"i":5,"n":12\}/);
});

test('the remote refuses anything that is not a move', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });

  for (const bad of [{ key: 'delete' }, { key: 1 }, {}]) {
    assert.equal((await post(base, '/remote/key', bad)).status, 400, JSON.stringify(bad));
  }
  for (const bad of [{ i: 'x', n: 2 }, { i: 1 }, {}]) {
    assert.equal((await post(base, '/remote/pos', bad)).status, 400, JSON.stringify(bad));
  }
});

test('the QR is served only when the remote is actually on', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);

  const plain = await startEdit(t, dir, { env: { PATH: dir } });
  assert.equal((await fetch(plain.base + '/remote/qr.svg')).status, 404,
    'without --remote there is no LAN URL worth encoding');

  const dir2 = tmp(t);
  writeFileSync(path.join(dir2, 'deck.html'), DECK);
  const withRemote = await startEdit(t, dir2, { env: { PATH: dir2 }, extraArgs: ['--remote'] });
  const res = await fetch(withRemote.base + '/remote/qr.svg');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  const svg = await res.text();
  assert.match(svg, /^<svg/);
  assert.match(svg, /viewBox=/);
});

// ── when to commit (#128): the policy, and the untrusted message ───────────

test('resolveGitMode: the default is unchanged, and a typo does not cost the safety net', () => {
  assert.equal(resolveGitMode([]), 'timer');
  assert.equal(resolveGitMode(['--git']), 'timer');
  assert.equal(resolveGitMode(['--no-git']), 'off');
  assert.equal(resolveGitMode(['--git-mode', 'agent']), 'agent');
  assert.equal(resolveGitMode(['--git-mode', 'off']), 'off');
  // unrecognised falls back rather than throwing — losing autocommit to a
  // typo would be a worse outcome than ignoring it
  assert.equal(resolveGitMode(['--git-mode', 'nonsense']), 'timer');
  assert.equal(resolveGitMode(['--git-mode']), 'timer');
  // --no-git wins: it is the explicit "touch nothing"
  assert.equal(resolveGitMode(['--git-mode', 'agent', '--no-git']), 'off');
});

test('shouldCommit: the whole decision table', () => {
  // the cadence fires only in timer mode — in agent mode it would double-commit
  assert.equal(shouldCommit('timer', { kind: 'timer' }), true);
  assert.equal(shouldCommit('agent', { kind: 'timer' }), false);
  assert.equal(shouldCommit('off', { kind: 'timer' }), false);

  // an agent edit commits only in agent mode, and only when it worked AND changed something
  assert.equal(shouldCommit('agent', { kind: 'agent', ok: true, changed: true }), true);
  assert.equal(shouldCommit('agent', { kind: 'agent', ok: true, changed: false }), false);
  assert.equal(shouldCommit('agent', { kind: 'agent', ok: false, changed: true }), false);
  assert.equal(shouldCommit('timer', { kind: 'agent', ok: true, changed: true }), false);
  assert.equal(shouldCommit('off', { kind: 'agent', ok: true, changed: true }), false);

  // session bookends still commit in any live mode, and never when off
  assert.equal(shouldCommit('timer', { kind: 'bookend' }), true);
  assert.equal(shouldCommit('agent', { kind: 'bookend' }), true);
  assert.equal(shouldCommit('off', { kind: 'bookend' }), false);
});

test('commitSubject treats an agent message as the untrusted text it is', () => {
  assert.equal(commitSubject('split the video slides', 'fb'), 'split the video slides');
  // a subject is one line by definition
  assert.equal(commitSubject('first line\nsecond line', 'fb'), 'first line second line');
  assert.equal(commitSubject('  padded \t out  ', 'fb'), 'padded out');
  // nothing usable → the caller's fallback
  for (const empty of ['', '   ', '\n', null, undefined]) {
    assert.equal(commitSubject(empty, 'decklight: autosave'), 'decklight: autosave');
  }
  // never let it read as an option
  assert.match(commitSubject('--amend everything', 'fb'), /^agent: --amend/);
  assert.match(commitSubject('-f', 'fb'), /^agent: -f/);
  // capped, and the cap is visible rather than a silent truncation
  const long = commitSubject('x'.repeat(200), 'fb');
  assert.ok(long.length <= 72, `got ${long.length}`);
  assert.match(long, /…$/);
});

test('an agent can mark its own commit boundary, and cannot when git is off', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);

  // no repo and --no-git: the endpoint refuses rather than pretending
  const off = await startEdit(t, dir, { env: { PATH: dir }, extraArgs: ['--no-git'] });
  const refused = await post(off.base, '/edit/commit', { message: 'nope' });
  assert.equal(refused.status, 409);

  // a real repo: the agent's message becomes the subject
  const repo = tmp(t);
  writeFileSync(path.join(repo, 'deck.html'), DECK);
  git(['init', '-q', '.'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  const on = await startEdit(t, repo, { extraArgs: ['--git'] });

  writeFileSync(path.join(repo, 'deck.html'), DECK.replace('Alpha', 'Beta'));
  const res = await post(on.base, '/edit/commit', { message: 'split the crowded slides' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.committed, true);
  assert.equal(body.subject, 'split the crowded slides');
  assert.match(git(['log', '-1', '--format=%s'], repo), /split the crowded slides/);
});

// ── the restore overlay's server side (#129) ───────────────────────────────

const gitRepoWithDeck = (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  git(['init', '-q', '.'], dir);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'first version'], dir);
  writeFileSync(path.join(dir, 'deck.html'), DECK.replace('Alpha', 'Second'));
  git(['commit', '-qam', 'second version'], dir);
  return dir;
};

test('/edit/history lists the deck history, newest first', async (t) => {
  const dir = gitRepoWithDeck(t);
  const { base } = await startEdit(t, dir, { extraArgs: ['--git'] });

  const j = await (await fetch(base + '/edit/history')).json();
  assert.equal(j.ok, true);
  assert.ok(j.entries.length >= 2);
  assert.equal(j.entries[0].subject, 'second version');
  assert.match(j.entries[0].hash, /^[0-9a-f]{7,}$/);
  assert.ok(j.entries[0].when, 'a human-readable age');
});

test('/edit/at previews a version — with a base href so its assets resolve', async (t) => {
  const dir = gitRepoWithDeck(t);
  const { base } = await startEdit(t, dir, { extraArgs: ['--git'] });

  const { entries } = await (await fetch(base + '/edit/history')).json();
  const oldest = entries[entries.length - 1].hash;

  const res = await fetch(`${base}/edit/at?ref=${oldest}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Alpha/, 'the OLD content, not the current file');
  assert.doesNotMatch(html, /Second/);
  // served from /edit/, so relative ../dist paths need a root base to resolve
  assert.match(html, /<base href="\/">/);

  assert.equal((await fetch(base + '/edit/at?ref=nosuchref')).status, 404);
});

test('/edit/restore rides on top and lands on the undo stack', async (t) => {
  const dir = gitRepoWithDeck(t);
  const { base } = await startEdit(t, dir, { extraArgs: ['--git'] });

  const { entries } = await (await fetch(base + '/edit/history')).json();
  const oldest = entries[entries.length - 1].hash;
  const before = git(['log', '--oneline'], dir).split('\n').length;

  const j = await (await post(base, '/edit/restore', { ref: oldest })).json();
  assert.equal(j.ok, true);
  assert.equal(j.changed, true);
  assert.match(readFileSync(path.join(dir, 'deck.html'), 'utf8'), /Alpha/);
  assert.equal(git(['log', '--oneline'], dir).split('\n').length, before + 1, 'a new commit, not a rewrite');
  assert.ok(j.undo >= 1, 'Z can take the restore back');

  assert.equal((await post(base, '/edit/restore', { ref: 'nosuchref' })).status, 400);
  assert.equal((await post(base, '/edit/restore', {})).status, 400);
});

test('the history endpoints refuse when git is off, rather than pretending', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir }, extraArgs: ['--no-git'] });

  assert.equal((await fetch(base + '/edit/history')).status, 409);
  assert.equal((await fetch(base + '/edit/at?ref=HEAD')).status, 409);
  assert.equal((await post(base, '/edit/restore', { ref: 'HEAD' })).status, 409);
});

test('an agent commit contains the agent\'s work only, not what you left uncommitted', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, DECK);
  git(['init', '-q', '.'], dir);
  git(['config', 'user.email', 't@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['add', '-A'], dir);
  git(['commit', '-qm', 'first'], dir);

  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'claude'),
    '#!/bin/sh\nprintf \'<!-- agent-was-here -->\' >> deck.html\n');
  chmodSync(path.join(bin, 'claude'), 0o755);
  // the real PATH too, so git is reachable from the server
  const { base } = await startEdit(t, dir, {
    env: { PATH: `${bin}:${process.env.PATH}` },
    extraArgs: ['--git', '--git-mode', 'agent'],
  });

  // a hand edit the player never committed, made BEFORE asking the agent
  writeFileSync(deck, DECK.replace('Alpha', 'MY OWN EDIT'));
  await post(base, '/edit/agent', { prompt: 'sign the deck', message: 'sign the deck' });

  for (let i = 0; i < 200; i++) {
    const p = await (await fetch(base + '/edit/ping')).json();
    if (!p.agentBusy && /agent-was-here/.test(readFileSync(deck, 'utf8'))) break;
    await new Promise((res) => setTimeout(res, 50));
  }

  const log = git(['log', '--format=%s'], dir).split('\n');
  assert.match(log[0], /sign the deck/, "the agent's commit carries its own message");
  assert.match(log[1], /save before claude edits/, 'the hand edit was committed first, separately');

  // the agent's commit must not contain the player's line
  const agentDiff = git(['show', '--format=', 'HEAD'], dir);
  assert.match(agentDiff, /agent-was-here/);
  assert.doesNotMatch(agentDiff, /MY OWN EDIT/, 'the hand edit is not attributed to the agent');
  // …and the player's own commit is where it actually went
  assert.match(git(['show', '--format=', 'HEAD~1'], dir), /MY OWN EDIT/);
});
