// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The edit server's editing surface: layout write-back, the undo/redo
// history, git autocommit, and the AI-agent roster. Pure functions are
// tested directly; the HTTP endpoints against a real server on an
// ephemeral port with a throwaway deck.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import http from 'node:http';

import {
  setSlideLayout, createHistory, gitAutocommit, inGitRepo, STARTER_GITIGNORE, lanAddress,
  removeSlideElement, setSlideElementHtml, setSlideElementBuild, BUILD_EFFECTS,
} from '../cli/edit.mjs';
import { allowEditRequest, isLoopbackOrigin } from '../cli/serve.mjs';
import { AGENTS, detectAgents, agentCommand } from '../cli/agents.mjs';
import { resolveGitMode, shouldCommit, commitSubject } from '../cli/git.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// The server's entry since `edit` stopped being a dispatcher command: the
// module itself, exactly as `decklight author` spawns it.
const EDIT = path.resolve(here, '../cli/edit.mjs');

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

// ── element edit mode (#112): remove / replace content / build effect ─────

test('removeSlideElement deletes the element at its raw child index (title included)', () => {
  const removed = removeSlideElement(DECK, 1, 0); // index 0 is <h2>Alpha</h2>
  assert.doesNotMatch(removed, /Alpha/);
  assert.match(removed, /<section>\s*<ul><li>one<\/li><\/ul>\s*<\/section>/);

  assert.throws(() => removeSlideElement(DECK, 1, 5), /no element at index 5/);
});

test('setSlideElementHtml replaces just that element\'s outerHTML', () => {
  const edited = setSlideElementHtml(DECK, 1, 0, '<h2>Renamed</h2>');
  assert.match(edited, /<section>\s*<h2>Renamed<\/h2>\s*<ul>/);
  assert.doesNotMatch(edited, /Alpha/);
});

test('setSlideElementBuild writes data-build, "none" is a real value, null strips the attribute', () => {
  const withFade = setSlideElementBuild(DECK, 1, 0, 'fade-up');
  assert.match(withFade, /<h2 data-build="fade-up">Alpha<\/h2>/);

  // 'none' is a real, explicit build step — distinct from having no attribute
  const withNone = setSlideElementBuild(DECK, 1, 0, 'none');
  assert.match(withNone, /<h2 data-build="none">Alpha<\/h2>/);

  // switching effects replaces, it doesn't accumulate
  const switched = setSlideElementBuild(withFade, 1, 0, 'zoom');
  assert.match(switched, /<h2 data-build="zoom">Alpha<\/h2>/);
  assert.equal((switched.match(/data-build/g) || []).length, 1);

  // null is "remove effect": the attribute disappears entirely
  const stripped = setSlideElementBuild(withFade, 1, 0, null);
  assert.match(stripped, /<h2>Alpha<\/h2>/);
  assert.doesNotMatch(stripped, /data-build/);

  assert.throws(() => setSlideElementBuild(DECK, 1, 0, 'sideways'), /unknown build effect/);
  assert.ok(BUILD_EFFECTS.includes('none') && BUILD_EFFECTS.length === 8);
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
  const child = spawn(process.execPath, [EDIT, 'deck.html', '--port', '0', ...extraArgs], {
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
  /**
   * Wait for a line the server prints AFTER the URL.
   *
   * `base` resolves on the loopback URL, which is the first thing printed —
   * so a test that immediately reads the log for anything printed after it is
   * racing the server's own stdout. That race took a PR out of the merge queue
   * despite passing locally and on the PR head.
   */
  const waitFor = (re, ms = 5000) => new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = out.match(re);
      if (m) { clearInterval(scan); clearTimeout(bell); resolve(m); }
    }, 25);
    const bell = setTimeout(() => {
      clearInterval(scan);
      reject(new Error(`timed out waiting for ${re}\n${out}`));
    }, ms);
  });

  return { child, base, log: () => out, waitFor };
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

test('element edit mode: source, content, effect, and remove all land on the undo stack', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });

  // GET source reads fresh from the FILE — index 0 is slide 1's <h2>
  let r = await (await fetch(base + '/edit/element/source?slide=1&index=0')).json();
  assert.deepEqual(r, { ok: true, html: '<h2>Alpha</h2>' });
  assert.equal((await fetch(base + '/edit/element/source?slide=1&index=9')).status, 404);

  // content: replace that element's outerHTML
  r = await (await post(base, '/edit/element/content', { slide: 1, index: 0, html: '<h2>Renamed</h2>' })).json();
  assert.deepEqual({ changed: r.changed, undo: r.undo }, { changed: true, undo: 1 });
  assert.match(readFileSync(deck, 'utf8'), /<h2>Renamed<\/h2>/);

  // effect: writes data-build; 'none' is accepted as a real value
  r = await (await post(base, '/edit/element/effect', { slide: 1, index: 0, effect: 'fade-up' })).json();
  assert.deepEqual({ changed: r.changed, undo: r.undo }, { changed: true, undo: 2 });
  assert.match(readFileSync(deck, 'utf8'), /<h2 data-build="fade-up">Renamed<\/h2>/);

  // effect: null strips it back off — the separate "remove effect" action
  r = await (await post(base, '/edit/element/effect', { slide: 1, index: 0, effect: null })).json();
  assert.equal(r.changed, true);
  assert.doesNotMatch(readFileSync(deck, 'utf8'), /data-build/);

  // remove: the element is gone; Z takes every one of these back in order
  r = await (await post(base, '/edit/element/remove', { slide: 1, index: 0 })).json();
  assert.equal(r.changed, true);
  assert.doesNotMatch(readFileSync(deck, 'utf8'), /Renamed/);
  assert.deepEqual((await (await post(base, '/edit/undo')).json()).undo, 3);
  assert.match(readFileSync(deck, 'utf8'), /Renamed/, 'undo brought the element back');

  // garbage in, 400 out — same contract as /edit/layout
  assert.equal((await post(base, '/edit/element/remove', { slide: 1, index: -1 })).status, 400);
  assert.equal((await post(base, '/edit/element/content', { slide: 1, index: 0, html: 5 })).status, 400);
  assert.equal((await post(base, '/edit/element/effect', { slide: 1, index: 0, effect: 'sideways' })).status, 400);
  assert.equal((await post(base, '/edit/element/remove', { slide: 1, index: 99 })).status, 400);
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

// ── the author server is loopback-only, and has no remote (PRESENT#REMOTE) ─

test('--remote and --host are refused out loud, naming where the remote went', () => {
  // Silently binding loopback would leave someone holding a phone that never
  // connects and no way to find out why. The refusal names the replacement.
  for (const flag of ['--remote', '--host']) {
    const r = spawnSync(process.execPath, [EDIT, 'deck.html', flag, ...(flag === '--host' ? ['0.0.0.0'] : [])],
      { encoding: 'utf8' });
    assert.equal(r.status, 2, flag);
    assert.match(r.stderr, new RegExp(`no longer takes \\${flag}`), flag);
    assert.match(r.stderr, /decklight present .* --remote/, `${flag} names the command that does this now`);
  }
});

test('the author server binds 127.0.0.1 — the LAN cannot even connect', async (t) => {
  const lan = lanAddress();
  if (!lan) return t.skip('no non-loopback IPv4 interface on this machine');
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base, log } = await startEdit(t, dir, { env: { PATH: dir } });
  const port = new URL(base).port;

  assert.doesNotMatch(log(), /remote:/, 'and advertises no LAN URL, because there is none');
  await assert.rejects(
    fetch(`http://${lan}:${port}/edit/ping`, { signal: AbortSignal.timeout(2000) }),
    'the LAN address must not be listening');
});

test('no /remote/* route is registered here at all', async (t) => {
  // The negative space, mirroring present.test.mjs's "no /edit/* route": a
  // clicker must not cost you an editing server, so the two capabilities do not
  // live in one process. Absent, not refused.
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });

  for (const p of ['/remote', '/remote/qr.svg', '/remote/events']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
  // a POST lands as 405 — unknown method on an unknown path, exactly what any
  // other made-up route gets. Not a refusal: there is nothing to have refused.
  assert.equal((await post(base, '/remote/key', { key: 'next' })).status, 405);
  assert.equal((await post(base, '/remote/pos', { i: 1, n: 2 })).status, 405);

  const src = readFileSync(EDIT, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /createRemoteRelay|remoteControllerHtml/,
    'and the module does not import the relay it would need to serve them');
});

// ── CSRF: a foreign web origin cannot drive the author server (#222) ───────
//
// The threat is the user's OWN browser: while `decklight author` runs on
// loopback, any page in any tab can fetch() this port. Binding 127.0.0.1 does
// nothing about it, and the old wildcard `access-control-allow-origin: *`
// waved the browser through. The gate is now the request's Origin.

test('allowEditRequest / isLoopbackOrigin: the Origin allow-list', () => {
  // a browser page a localhost server handed out — the deck this very server
  // serves is one of these (same-origin), and so is any other local dev server
  for (const o of ['http://127.0.0.1:8788', 'http://localhost:5173', 'https://localhost', 'http://[::1]:9000']) {
    assert.equal(isLoopbackOrigin(o), true, o);
    assert.equal(allowEditRequest({ headers: { origin: o } }), true, o);
  }
  // the whole point of the ticket: a foreign site is refused
  for (const o of ['https://evil.example', 'http://attacker.test:1234', 'http://127.0.0.1.evil.example', 'null-ish']) {
    assert.equal(isLoopbackOrigin(o), false, o);
    assert.equal(allowEditRequest({ headers: { origin: o } }), false, o);
  }
  // no Origin header at all → not a browser cross-origin call (curl, the CLI,
  // the port-conflict probe, this test suite): allowed
  assert.equal(allowEditRequest({ headers: {} }), true);
  // `null` → a file://-opened deck, the SPEC'd double-click path: allowed. It
  // is NOT a loopback web origin (that is the residual noted in serve.mjs), so
  // the two helpers deliberately disagree on it.
  assert.equal(isLoopbackOrigin('null'), false);
  assert.equal(allowEditRequest({ headers: { origin: 'null' } }), true);
});

// http.request, not fetch: `Origin` is a browser-forbidden request header and
// undici's fetch drops it, so the one header this whole test turns on could
// never be set through fetch(). A raw client sets it exactly like a browser.
function rawReq(base, { method = 'GET', path = '/edit/ping', headers = {}, body } = {}) {
  const u = new URL(base + path);
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

test('a foreign web origin is refused at every /edit/* route, with no CORS grant', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });
  const EVIL = 'https://evil.example';

  // the RCE vector itself: a POST that runs a coding agent against the deck dir
  const agent = await rawReq(base, {
    method: 'POST', path: '/edit/agent', body: JSON.stringify({ prompt: 'rm the repo' }),
    headers: { origin: EVIL, 'content-type': 'application/json' },
  });
  assert.equal(agent.status, 403, 'the agent endpoint refuses a foreign origin');
  assert.notEqual(agent.headers['access-control-allow-origin'], '*', 'and hands out no wildcard grant');
  assert.notEqual(agent.headers['access-control-allow-origin'], EVIL, 'nor echoes the attacker back');

  // reads leak the deck too — refused the same way
  for (const path_ of ['/edit/ping', '/edit/history']) {
    const r = await rawReq(base, { path: path_, headers: { origin: EVIL } });
    assert.equal(r.status, 403, path_);
  }
  // disk-writing mutations, all refused
  for (const [path_, payload] of [
    ['/edit/notes', { slide: 1, text: 'x' }], ['/edit/restore', { ref: 'HEAD' }],
    ['/edit/element/remove', { slide: 1, index: 0 }],
  ]) {
    const r = await rawReq(base, {
      method: 'POST', path: path_, body: JSON.stringify(payload),
      headers: { origin: EVIL, 'content-type': 'application/json' },
    });
    assert.equal(r.status, 403, path_);
  }
  // and the browser's preflight for such a POST is refused before it is sent
  const pre = await rawReq(base, {
    method: 'OPTIONS', path: '/edit/agent',
    headers: { origin: EVIL, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  assert.equal(pre.status, 403, 'the preflight itself is refused');
  assert.notEqual(pre.headers['access-control-allow-origin'], '*');

  // the deck on disk is untouched by any of it
  assert.equal(readFileSync(path.join(dir, 'deck.html'), 'utf8'), DECK);
});

test('the legitimate callers still get through — loopback, file://, and the CLI', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });

  // the deck this server serves, same-origin (a loopback web origin): echoed,
  // never a wildcard
  const same = await rawReq(base, { path: '/edit/ping', headers: { origin: base } });
  assert.equal(same.status, 200);
  assert.equal(same.headers['access-control-allow-origin'], base, 'the origin is echoed, not *');

  // a file://-opened deck probes with Origin: null — the SPEC'd double-click path
  const file = await rawReq(base, { path: '/edit/ping', headers: { origin: 'null' } });
  assert.equal(file.status, 200);
  assert.equal(file.headers['access-control-allow-origin'], 'null');

  // the CLI / port-conflict probe / curl send no Origin: still answered
  const cli = await rawReq(base, { path: '/edit/ping' });
  assert.equal(cli.status, 200);
  assert.equal(JSON.parse(cli.body).ok, true);
  // a preflight from the served deck is granted, echoing its origin
  const pre = await rawReq(base, {
    method: 'OPTIONS', path: '/edit/notes',
    headers: { origin: base, 'access-control-request-method': 'POST' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], base);
});

// ── when to commit (#128): the policy, and the untrusted message ───────────

test('resolveGitMode: agent by default, and a typo does not cost the safety net', () => {
  // agent is a superset of timer (the cadence still runs), so defaulting to it
  // adds real messages for agent edits without removing anyone's safety net
  assert.equal(resolveGitMode([]), 'agent');
  assert.equal(resolveGitMode(['--git']), 'agent');
  assert.equal(resolveGitMode(['--git-mode', 'timer']), 'timer');
  assert.equal(resolveGitMode(['--no-git']), 'off');
  assert.equal(resolveGitMode(['--git-mode', 'agent']), 'agent');
  assert.equal(resolveGitMode(['--git-mode', 'off']), 'off');
  // unrecognised falls back rather than throwing — losing autocommit to a
  // typo would be a worse outcome than ignoring it
  assert.equal(resolveGitMode(['--git-mode', 'nonsense']), 'agent');
  assert.equal(resolveGitMode(['--git-mode']), 'agent');
  // --no-git wins: it is the explicit "touch nothing"
  assert.equal(resolveGitMode(['--git-mode', 'agent', '--no-git']), 'off');
});

test('shouldCommit: the whole decision table', () => {
  // the cadence is the BACKSTOP and runs in agent mode too: an agent job only
  // sees edits it made, so hand edits (and agents driven from outside the A
  // flow) would otherwise reach git only via the Ctrl-C bookend
  assert.equal(shouldCommit('timer', { kind: 'timer' }), true);
  assert.equal(shouldCommit('agent', { kind: 'timer' }), true);
  assert.equal(shouldCommit('off', { kind: 'timer' }), false);
  // …but never WHILE a job is in flight, or it commits half an agent edit
  assert.equal(shouldCommit('agent', { kind: 'timer', agentBusy: true }), false);
  assert.equal(shouldCommit('timer', { kind: 'timer', agentBusy: true }), false);

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
