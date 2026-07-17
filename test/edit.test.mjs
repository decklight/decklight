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

import { setSlideLayout, createHistory, gitAutocommit, inGitRepo, STARTER_GITIGNORE } from '../cli/edit.mjs';
import { AGENTS, detectAgents, agentCommand } from '../cli/agents.mjs';

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
