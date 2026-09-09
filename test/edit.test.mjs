// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The edit server's editing surface: layout write-back, the undo/redo
// history, git autocommit, and the AI-agent roster. Pure functions are
// tested directly; the HTTP endpoints against a real server on an
// ephemeral port with a throwaway deck.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, rmTemp, writeFakeBin, stop } from './helpers.mjs';

import http from 'node:http';

import {
  upsertNarrationTrack, narrationLiteral, initArgument,
  setSlideLayout, setSlideTiming, setSlideHidden, createHistory, gitAutocommit, inGitRepo, STARTER_GITIGNORE, lanAddress,
  removeSlideElement, setSlideElementHtml, setSlideElementBuild, BUILD_EFFECTS,
} from '../cli/edit.mjs';
import { allowEditRequest, isLoopbackOrigin } from '../cli/serve.mjs';
import { AGENTS, detectAgents, agentCommand } from '../cli/agents.mjs';
import { zipEntries } from '../tools/zip.mjs';
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

// ── the recorder's last manual step, removed (PRESENTING) ────────────────
// The recorder writes the files and then asked you to paste a config line into
// the deck by hand. This server already owns the file — notes, layouts, element
// edits all go through applyEdit — so it can take that step too.

const boot = (init) => '<!doctype html><div class="decklight"><section><h1>x</h1></section></div>\n'
  + '<script src="decklight.js"></script>\n<script>' + init + '</script>\n';
/** DECK has no boot call; the narration route needs one to edit. */
const BOOT_DECK = boot;
const initOf = (html) => html.match(/<script>([^<]*)<\/script>/g).pop().replace(/<\/?script>/g, '').trim();
const TRACK = { label: 'Mine', dir: 'voiceover', ext: 'wav', segments: true };

test('the narration config is written into the deck, whatever shape it was in', () => {
  const set = (init) => initOf(upsertNarrationTrack(boot(init), TRACK));
  const want = "narration: { files: [{ label: 'Mine', dir: 'voiceover', ext: 'wav', segments: true }] }";

  // an empty config, and no config at all
  assert.equal(set('Decklight.init({});'), `Decklight.init({ ${want} });`);
  assert.equal(set('Decklight.init();'), `Decklight.init({ ${want} });`);
  // a config with other keys keeps them
  assert.match(set("Decklight.init({ theme: 'midnight' });"), /theme: 'midnight'/);
  // …and the scaffolder's own assigned form
  assert.match(set('const deck = Decklight.init({});'), /^const deck = Decklight/);

  // an existing narration key is EXTENDED, never duplicated and never thrown
  // away — a second voice is exactly when a multi-track deck exists
  const twice = set("Decklight.init({ narration: { files: 'old', ext: 'm4a' }, theme: 'x' });");
  assert.equal(twice.match(/narration:/g).length, 1);
  assert.match(twice, /dir: 'voiceover'/);
  assert.match(twice, /dir: 'old'/, 'the earlier track is kept, as a list entry');
  assert.match(twice, /theme: 'x'/, 'the rest of the config survives');
});

test('the config walker is not fooled by braces and parens inside strings', () => {
  // The reason this is a walker and not a regex. Both of these are things a
  // real deck contains, and a bracket-counting regex reads them as structure —
  // which would splice the config into the middle of somebody's title.
  const set = (init) => initOf(upsertNarrationTrack(boot(init), TRACK));
  assert.match(set("Decklight.init({ title: 'Acme (Inc)' });"), /title: 'Acme \(Inc\)'/);
  assert.match(set("Decklight.init({ title: 'a } b' });"), /title: 'a \} b'/);
  // a `narration:` nested inside another key is not this object's key
  const nested = set("Decklight.init({ character: { narration: 1 }, theme: 'x' });");
  assert.match(nested, /character: \{ narration: 1 \}/, 'the nested key is left alone');
  assert.match(nested, /narration: \{ files: \[\{ label: 'Mine'/, 'and a real top-level one is added');
});

test('the config walker is not fooled by comments either', () => {
  // A commented-out earlier track is exactly what an author leaves behind, and
  // a walker that skips strings but not comments FINDS that key: the splice
  // lands inside the comment, the UI says ✓, and the deck plays nothing.
  const set = (init) => initOf(upsertNarrationTrack(boot(init), TRACK));
  const REAL = /narration: \{ files: \[\{ label: 'Mine'/;

  const block = set("Decklight.init({ theme: 'x', /* narration: { files: 'old' }, */ });");
  assert.match(block, /\/\* narration: \{ files: 'old' \}, \*\//, 'the comment is left exactly as written');
  assert.match(block, REAL, 'the real key is added OUTSIDE it');
  const line = set("Decklight.init({\n  theme: 'x',\n  // narration: { files: 'old' },\n});");
  assert.match(line, /\/\/ narration: \{ files: 'old' \},/, 'the line comment survives');
  assert.match(line, REAL);

  // an unbalanced ')' in a comment must not end the init argument early —
  // a splice into a truncated span lands mid-expression and corrupts the deck
  const paren = set("Decklight.init({ theme: 'x' /* ) */ });");
  assert.match(paren, REAL);
  assert.match(paren, /\/\* \) \*\//, 'the comment is untouched');

  // and a key SUFFIX is not the key: the old prefix guard matched ^ at every
  // slice, so `mynarration:` was found at its own `n`
  const suffix = set("Decklight.init({ mynarration: 1, theme: 'x' });");
  assert.match(suffix, /mynarration: 1/, 'the impostor key is left alone');
  assert.match(suffix, REAL, 'the real key is added beside it');
});

test('a config built outside the init call is refused, never guessed at', () => {
  // `const cfg = {…}; Decklight.init(cfg)` has nothing at the call site to
  // edit. Guessing which `cfg`, in which scope, is how an editor corrupts a
  // file — so this returns null and the card keeps printing the line.
  assert.equal(upsertNarrationTrack(boot('const cfg = { theme: 1 }; Decklight.init(cfg);'), TRACK), null);
  assert.equal(upsertNarrationTrack(boot('Decklight.init(window.CFG);'), TRACK), null);
  // and a deck with no boot call at all
  assert.equal(upsertNarrationTrack('<div class="decklight"></div>', TRACK), null);
  assert.equal(initArgument('<div class="decklight"></div>'), null);
});

test('the literal reads as a person would have typed it', () => {
  // It lands in someone's source file and stays there — JSON.stringify's
  // double quotes and missing spaces would look like a machine had been in.
  assert.equal(narrationLiteral({ files: 'voiceover', ext: 'wav', segments: true }),
    "{ files: 'voiceover', ext: 'wav', segments: true }");
  assert.equal(narrationLiteral({ files: 'voiceover' }), "{ files: 'voiceover' }");
  // undefined keys are omitted rather than written out
  assert.equal(narrationLiteral({ files: 'a', ext: undefined }), "{ files: 'a' }");
  // …and a quote in a folder name cannot end the string early
  assert.equal(narrationLiteral({ files: "it's" }), "{ files: 'it\\'s' }");
});

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
  assert.deepEqual(claude.args.slice(2),
    ['--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose'],
    'acceptEdits plus the stream that narrates the run');

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

/**
 * A temp directory, and the children living in it, cleaned up in that order.
 *
 * The order is the point. `tmp(t)` runs before `startEdit`, so its cleanup hook
 * is registered first and runs first — removing the directory while the server
 * still has it as a cwd. POSIX unlinks it anyway; Windows locks it and the
 * teardown fails EBUSY on a test that passed (26 of them, on the first Windows
 * run to get this far). So the servers are tracked and killed HERE, before the
 * directory goes, and rmTemp retries what a lingering handle still holds.
 */

const kids = new Set();
const gone = (child) => new Promise((done) => {
  if (child.exitCode !== null || child.signalCode !== null) return done();
  const t = setTimeout(done, 5000);
  child.on('exit', () => { clearTimeout(t); done(); });
});

const tmp = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-edit-'));
  t.after(async () => {
    await Promise.all([...kids].map((c) => stop(c)));
    await Promise.all([...kids].map(gone));
    kids.clear();
    rmTemp(dir);
  });
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
    // childEnv, not a spread: Windows spells it `Path`, so `{...process.env,
    // PATH: dir}` hands the child BOTH and the narrowing silently does nothing.
    env: childEnv(env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.add(child);
  child.on('exit', () => kids.delete(child));
  t.after(() => stop(child));
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

/**
 * A POST on a socket of its own.
 *
 * `fetch` pools connections per origin, so two requests fired together can
 * share one socket and run in sequence — which is not what a test about
 * CONCURRENT requests means, and it failed on CI exactly that way while
 * passing locally. node:http with `agent: false` opens a new connection every
 * time, so "at the same time" means it.
 */
const rawPost = (base, ep, body) => new Promise((resolve, reject) => {
  const u = new URL(base + ep);
  const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', agent: false,
    headers: body === undefined ? {} : { 'content-type': 'application/json' } },
    (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
  req.on('error', reject);
  req.end(body === undefined ? undefined : JSON.stringify(body));
});

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
  // A .mjs with a per-OS shim, so the same fake agent runs on Windows too
  // (a `#!/bin/sh` script is not something Windows executes) — and on Windows
  // that shim is a .cmd, which is the whole of #307: decklight has to resolve
  // it back to the .mjs and spawn node, because handing an untrusted prompt to
  // cmd.exe is not an option.
  writeFakeBin(bin, 'claude',
    "import { appendFileSync } from 'node:fs';\nappendFileSync('deck.html', '<!-- agent-was-here -->');\n");
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
  // disk-writing mutations, all refused — including the one that writes a file
  // BESIDE the deck rather than the deck itself
  for (const [path_, payload] of [
    ['/edit/notes', { slide: 1, text: 'x' }], ['/edit/restore', { ref: 'HEAD' }],
    ['/edit/element/remove', { slide: 1, index: 0 }],
    ['/edit/record?slide=1&kind=wav&dir=voiceover', 'RIFF'],
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

  // the deck on disk is untouched by any of it — and nothing was written next
  // to it either
  assert.equal(readFileSync(path.join(dir, 'deck.html'), 'utf8'), DECK);
  assert.deepEqual(readdirSync(dir).sort(), ['deck.html']);
});

// ── ⇧V recordings land next to the deck (PRESENTING) ──────────────────────
// The bug this closes: the player handed every stitched slide to the browser's
// download path, so a recorded deck arrived as thirty slide-NN.wav in the OS
// download folder — never the deck's, which is the only folder `bundle` reads.

test('POST /edit/narration writes the config, undoes like any other edit', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, BOOT_DECK('Decklight.init({});'));
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });

  const r = await (await post(base, '/edit/narration',
    { files: 'voiceover', ext: 'wav', segments: true, label: 'My voice' })).json();
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  // a LIST, always: a deck carries as many tracks as you have voices, and the
  // one-track shape is the case where you happen to have one
  assert.match(readFileSync(deck, 'utf8'),
    /narration: \{ files: \[\{ label: 'My voice', dir: 'voiceover', ext: 'wav', segments: true \}\] \}/);

  // one door for every mutation, so Z takes this back like a notes edit
  assert.equal(r.undo, 1);
  await post(base, '/edit/undo');
  assert.doesNotMatch(readFileSync(deck, 'utf8'), /narration:/);

  // the same three shapes /edit/record refuses for a folder — this one is
  // written INTO the deck, where a bad value is not a failed request but a
  // deck that no longer plays
  for (const bad of [{ files: '/etc' }, { files: '../..' }, { files: 'C:\\x' },
    { files: '' }, { files: 5 }, { files: 'ok', ext: '../x' }, { files: 'ok', segments: 'yes' }]) {
    assert.equal((await post(base, '/edit/narration', bad)).status, 400, JSON.stringify(bad));
  }
});

test('a second voice is ADDED to the deck, never written over the first', async (t) => {
  // The bug this closes, in one test. A deck carrying four cloned voices and
  // the system one had them all replaced the moment somebody recorded a sixth
  // — which is precisely when a multi-track deck exists.
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, BOOT_DECK("Decklight.init({ narration: { files: ["
    + "{ label: 'Rachel · elevenlabs', dir: 'voices/rachel' }, "
    + "{ label: 'Adam · elevenlabs', dir: 'voices/adam' }] } });"));
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });

  await post(base, '/edit/narration',
    { files: 'voices/me', ext: 'wav', segments: true, label: 'My voice' });
  let html = readFileSync(deck, 'utf8');
  assert.match(html, /voices\/rachel/, 'the first cloned voice survives');
  assert.match(html, /voices\/adam/, 'and the second');
  assert.match(html, /label: 'My voice', dir: 'voices\/me'/);

  // …and recording into the same folder again UPDATES it rather than listing
  // it twice — the picker must not show one folder as two rows
  await post(base, '/edit/narration',
    { files: 'voices/me', ext: 'wav', segments: true, label: 'My voice, take 2' });
  html = readFileSync(deck, 'utf8');
  assert.equal(html.match(/dir: 'voices\/me'/g).length, 1);
  assert.match(html, /My voice, take 2/);
  assert.doesNotMatch(html, /label: 'My voice',/);
  assert.equal(html.match(/dir: 'voices\//g).length, 3, 'three tracks, still');
});

test('POST /edit/narration says WHY when a deck builds its config elsewhere', async (t) => {
  // Not a failure of this server — a deck whose config is not a literal at the
  // call site. Naming that is the difference between "paste this line" and
  // "it did not work".
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, BOOT_DECK('const cfg = { theme: 1 }; Decklight.init(cfg);'));
  const before = readFileSync(deck, 'utf8');
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });

  const res = await post(base, '/edit/narration', { files: 'voiceover', ext: 'wav' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /outside the Decklight\.init/);
  assert.equal(readFileSync(deck, 'utf8'), before, 'and it wrote nothing');
});

test('POST /edit/record writes slide-NN.wav into a folder beside the deck', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });

  const wav = Buffer.from('RIFF....WAVEfmt ');
  const r = await (await fetch(base + '/edit/record?slide=7&kind=wav&dir=voiceover', {
    method: 'POST', body: wav,
  })).json();
  assert.deepEqual(r, { ok: true, dir: 'voiceover', file: 'slide-07.wav' });
  // the folder is created on demand, and the bytes arrive intact — a string
  // read would have mangled them
  assert.deepEqual(readFileSync(path.join(dir, 'voiceover', 'slide-07.wav')), wav);

  // the character's sidecar rides the same route under the name bundle looks for
  const tl = JSON.stringify({ frames: [] });
  const v = await (await fetch(base + '/edit/record?slide=7&kind=visemes&dir=voiceover', {
    method: 'POST', body: tl,
  })).json();
  assert.equal(v.file, 'slide-07.visemes.json');
  assert.equal(readFileSync(path.join(dir, 'voiceover', 'slide-07.visemes.json'), 'utf8'), tl);

  // a deck that names its own narration folder records into THAT one
  await fetch(base + '/edit/record?slide=1&kind=wav&dir=audio%2Ftake-2', { method: 'POST', body: wav });
  assert.ok(existsSync(path.join(dir, 'audio', 'take-2', 'slide-01.wav')));
});

// ── ⇧R: one file per ⟨CLICK⟩ beat, which is what steps the builds ─────────
test('POST /edit/record?seg writes slide-NN-KK.wav — and refuses a seg it cannot name', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });
  const wav = Buffer.from('RIFF....WAVEfmt seg');

  const r = await (await fetch(base + '/edit/record?slide=4&kind=wav&seg=2&dir=voiceover', {
    method: 'POST', body: wav,
  })).json();
  // zero-padded on BOTH halves — the name tools/voiceover.mjs writes and the
  // runtime resolves; one unpadded field and the whole track goes missing
  assert.deepEqual(r, { ok: true, dir: 'voiceover', file: 'slide-04-02.wav' });
  assert.deepEqual(readFileSync(path.join(dir, 'voiceover', 'slide-04-02.wav')), wav);

  // the whole-slide file is still its own name — the two live side by side,
  // because every reader that predates segments only knows the short one
  await fetch(base + '/edit/record?slide=4&kind=wav&dir=voiceover', { method: 'POST', body: wav });
  assert.deepEqual(readdirSync(path.join(dir, 'voiceover')).sort(), ['slide-04-02.wav', 'slide-04.wav']);

  const post = (qs) => fetch(`${base}/edit/record?${qs}`, { method: 'POST', body: 'x' });
  // `seg` is half of a filename this server builds, so it is bounded exactly
  // like `slide`
  for (const bad of ['seg=0', 'seg=-1', 'seg=1.5', 'seg=x', 'seg=1000', 'seg=..%2F..%2Fx']) {
    assert.equal((await post(`slide=1&kind=wav&${bad}&dir=voiceover`)).status, 400, bad);
  }
  assert.deepEqual(readdirSync(path.join(dir, 'voiceover')).sort(), ['slide-04-02.wav', 'slide-04.wav']);

  // A viseme sidecar is cut per beat too, for the same reason the audio is:
  // the player plays one beat at a time, so a timeline for the whole slide
  // starts at zero against every one of them.
  const tl = JSON.stringify({ cues: [], duration: 0.4 });
  const v = await (await fetch(base + '/edit/record?slide=4&kind=visemes&seg=2&dir=voiceover', {
    method: 'POST', body: tl,
  })).json();
  assert.equal(v.file, 'slide-04-02.visemes.json');
  assert.equal(readFileSync(path.join(dir, 'voiceover', 'slide-04-02.visemes.json'), 'utf8'), tl);
});

test('POST /edit/record names the folder only — never the file, and never one outside the deck', async (t) => {
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });
  const post = (qs) => fetch(`${base}/edit/record?${qs}`, { method: 'POST', body: 'x' });

  // the file name is built server-side, so the only lever a caller has is the
  // folder — and every way out of the served root is refused
  for (const bad of ['dir=..', 'dir=../..%2Fetc', 'dir=%2Fetc', 'dir=C%3A%5CWindows', 'dir=a%2F..%2F..%2Fb']) {
    assert.equal((await post(`slide=1&kind=wav&${bad}`)).status, 400, bad);
  }
  // and the shape of the request itself is checked before anything is written
  for (const bad of ['slide=0&kind=wav', 'slide=x&kind=wav', 'slide=1&kind=exe', 'slide=1']) {
    assert.equal((await post(bad)).status, 400, bad);
  }
  assert.deepEqual(readdirSync(dir).sort(), ['deck.html']);
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

test('/edit/history carries what each version was and what it changed', async (t) => {
  // The overlay draws a slide count and a +/− pair on every row, and it has no
  // way to compute either: the runtime has zero dependencies and cannot spawn
  // git, so if this route does not send the numbers there are no numbers.
  const dir = gitRepoWithDeck(t);
  const { base } = await startEdit(t, dir, { extraArgs: ['--git'] });

  const { entries } = await (await fetch(base + '/edit/history')).json();
  for (const e of entries) {
    assert.equal(typeof e.slides, 'number', `${e.subject}: no slide count`);
    assert.ok(e.slides > 0, `${e.subject}: a deck with no slides`);
    assert.equal(typeof e.add, 'number', `${e.subject}: no additions`);
    assert.equal(typeof e.del, 'number', `${e.subject}: no deletions`);
  }
  // the commit that created the file added lines and removed none
  const first = entries[entries.length - 1];
  assert.equal(first.del, 0);
  assert.ok(first.add > 0);
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
  // A .mjs with a per-OS shim, so the same fake agent runs on Windows too
  // (a `#!/bin/sh` script is not something Windows executes) — and on Windows
  // that shim is a .cmd, which is the whole of #307: decklight has to resolve
  // it back to the .mjs and spawn node, because handing an untrusted prompt to
  // cmd.exe is not an option.
  writeFakeBin(bin, 'claude',
    "import { appendFileSync } from 'node:fs';\nappendFileSync('deck.html', '<!-- agent-was-here -->');\n");
  // the real PATH too, so git is reachable from the server
  const { base } = await startEdit(t, dir, {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}` },
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


// ── setSlideTiming: a rehearsal, written onto the section ─────────────────

test('setSlideTiming writes whole seconds, replaces, and removes for null or zero', () => {
  const set = setSlideTiming(DECK, 1, 42.4);
  assert.match(set, /<section data-timing="42">\s*<h2>Alpha<\/h2>/);
  const replaced = setSlideTiming(set, 1, 90);
  assert.match(replaced, /<section data-timing="90">/);
  assert.doesNotMatch(replaced, /data-timing="42"/);
  // the other slides are untouched — an attribute on slide 2 is not disturbed
  assert.match(setSlideTiming(DECK, 1, 10), /<section data-layout="centered">\s*<h2>Beta<\/h2>/);
  const removed = setSlideTiming(replaced, 1, 0);
  assert.match(removed, /<section>\s*<h2>Alpha<\/h2>/);
  assert.match(setSlideTiming(replaced, 1, null), /<section>\s*<h2>Alpha<\/h2>/);
  assert.throws(() => setSlideTiming(DECK, 99, 5), /no such slide|slide 99/i);
});


// ── setSlideHidden: a slide kept in the file, taken out of the talk ───────

test('setSlideHidden adds data-hidden once, beside what the section already carries, and removes it cleanly', () => {
  const hidden = setSlideHidden(DECK, 2, true);
  assert.match(hidden, /<section data-layout="centered" data-hidden>\s*<h2>Beta<\/h2>/);
  assert.equal(setSlideHidden(hidden, 2, true), hidden, 'hiding a hidden slide is a no-op, not a second attribute');
  const shown = setSlideHidden(hidden, 2, false);
  assert.equal(shown, DECK, 'unhiding restores the tag byte for byte');
  assert.equal(setSlideHidden(DECK, 1, false), DECK, 'unhiding a shown slide changes nothing');
  // the valued form PowerPoint import never writes, but a hand still might
  const valued = setSlideHidden(DECK.replace('<section data-layout="centered">', '<section data-hidden="" data-layout="centered">'), 2, false);
  assert.equal(valued, DECK);
  // data-hidden-not is not data-hidden
  const lookalike = DECK.replace('<section data-layout="centered">', '<section data-hidden-not data-layout="centered">');
  assert.match(setSlideHidden(lookalike, 2, true), /<section data-hidden-not data-layout="centered" data-hidden>/);
  assert.throws(() => setSlideHidden(DECK, 3, true), /no slide 3 \(deck has 2\)/);
});

test('/edit/hidden hides and unhides one slide through the same undo stack, and refuses a bad payload', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });
  let r = await (await post(base, '/edit/hidden', { slide: 2, hidden: true })).json();
  assert.deepEqual({ changed: r.changed, undo: r.undo }, { changed: true, undo: 1 });
  assert.match(readFileSync(deck, 'utf8'), /<section data-layout="centered" data-hidden>/);
  r = await (await post(base, '/edit/hidden', { slide: 2, hidden: true })).json();
  assert.equal(r.changed, false, 'already hidden — nothing written, nothing to undo');
  r = await (await post(base, '/edit/hidden', { slide: 2, hidden: false })).json();
  assert.deepEqual({ changed: r.changed, undo: r.undo }, { changed: true, undo: 2 });
  assert.equal(readFileSync(deck, 'utf8'), DECK);
  assert.equal((await post(base, '/edit/hidden', { slide: 2, hidden: 'yes' })).status, 400);
  assert.equal((await post(base, '/edit/hidden', { slide: 0, hidden: true })).status, 400);
});

test('/edit/timings writes every slide\'s rehearsed time in ONE edit, and refuses a bad payload', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, DECK);
  const { base } = await startEdit(t, dir, { env: { PATH: dir } });
  const r = await (await post(base, '/edit/timings', { timings: [{ slide: 1, seconds: 42.6 }, { slide: 2, seconds: 90 }] })).json();
  assert.deepEqual({ changed: r.changed, undo: r.undo }, { changed: true, undo: 1 }, 'two slides, one history entry');
  const html = readFileSync(deck, 'utf8');
  assert.match(html, /<section data-timing="43">\s*<h2>Alpha<\/h2>/);
  assert.match(html, /<section data-layout="centered" data-timing="90">\s*<h2>Beta<\/h2>/, 'beside the layout it already had');
  assert.equal((await post(base, '/edit/timings', { timings: [{ slide: 'one', seconds: 5 }] })).status, 400);
  assert.equal((await post(base, '/edit/timings', { timings: 'nope' })).status, 400);
});

// ── /edit/pptx — the palette's export row (PRESENTING) ─────────────────────
//
// The export itself is `decklight pptx`, tested in test/pptx-export.test.mjs
// and run for real in test/pptx-render.mjs. What is under test HERE is the
// three promises the route makes to the session it runs inside: it hands back
// the file it wrote, it refuses a second export rather than pointing two
// browsers at one path, and a failure is a sentence — not a dead author
// server. So Chrome is a stand-in that writes a PNG and exits, which keeps
// these fast and makes them run on a machine with no browser at all.
const FAKE_CHROME = `
import { writeFileSync } from 'node:fs';
// a 1×1 PNG — pptx only asks that the file exist and have bytes
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const shot = process.argv.find((a) => a.startsWith('--screenshot='));
const printed = process.argv.find((a) => a.startsWith('--print-to-pdf='));
if (process.env.FAKE_CHROME_SLOW) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_CHROME_SLOW)));
if (process.env.FAKE_CHROME_BLANK) process.exit(0);        // renders nothing, exits clean
if (shot) writeFileSync(shot.slice('--screenshot='.length), PIXEL);
// Enough of a PDF for the pdf command to accept: it checks the file exists
// and has bytes, and reads a page count out of it if it can. The \\n are
// doubled because this whole script is a template literal — a single one is a
// real newline inside a single-quoted string, which is a syntax error in the
// file that gets written, thirteen lines from where you are reading.
if (printed) writeFileSync(printed.slice('--print-to-pdf='.length), '%PDF-1.4\\n/Count 2\\n%%EOF\\n');
`;

// Windows sits these out: `writeFakeBin` leaves a `.cmd` shim there, and
// `execFile` (which is how the export runs Chrome, deliberately — #452) refuses
// to spawn a .cmd without a shell since Node's spawn hardening. A real Chrome
// is an .exe, so this is the stand-in's limitation and not the route's; the
// browser half of the row runs on every platform in engine-render.
const noFakeChrome = process.platform === 'win32';

test('/edit/export writes the PowerPoint and names the file it wrote', async (t) => {
  if (noFakeChrome) return t.skip('the stand-in Chrome is a script, and execFile will not spawn a .cmd');
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, DECK);
  const chrome = writeFakeBin(dir, 'fake-chrome', FAKE_CHROME);
  const { base, log } = await startEdit(t, dir, { env: { PATH: dir, DECKLIGHT_CHROME: chrome } });

  const r = await (await post(base, '/edit/export', { kind: 'pptx' })).json();
  assert.equal(r.ok, true, `export refused: ${r.error}`);
  assert.equal(r.file, 'deck.pptx', 'the path is relative to where author is running');
  assert.equal(typeof r.seconds, 'number');
  const out = path.join(dir, 'deck.pptx');
  assert.ok(existsSync(out), 'the file landed beside the deck');

  // decklight's own reader, so this asserts a file `decklight import` could
  // open rather than "some bytes were written"
  const buf = readFileSync(out);
  const names = zipEntries(buf).map((e) => e.name);
  assert.equal(names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, 2, 'a slide part per slide');
  assert.equal(names.filter((n) => /^ppt\/media\/slide\d+\.png$/.test(n)).length, 2, 'a picture per slide');
  assert.match(log(), /export: deck\.html → PowerPoint/, 'the terminal says what the palette asked for');

  // the deck FILE is untouched: an export is not an edit, so it takes no
  // history entry and undo has nothing to take back
  assert.equal(readFileSync(deck, 'utf8'), DECK);
  assert.equal((await (await fetch(base + '/edit/ping')).json()).undo, 0);
});

test('/edit/export runs one export at a time, and the deck is told which', async (t) => {
  if (noFakeChrome) return t.skip('the stand-in Chrome is a script, and execFile will not spawn a .cmd');
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const chrome = writeFakeBin(dir, 'fake-chrome', FAKE_CHROME);
  // slow enough that the second request lands while the first still holds Chrome
  const { base, waitFor } = await startEdit(t, dir, { env: { PATH: dir, DECKLIGHT_CHROME: chrome, FAKE_CHROME_SLOW: '1200' } });

  // Not two races fetches: the server ANNOUNCES the export before it starts,
  // so waiting for that line is a fact rather than a guess about scheduling.
  // (Two `Promise.all`ed fetches passed here and failed on CI, where they
  // shared one keep-alive socket and simply ran in sequence.)
  const first = post(base, '/edit/export', { kind: 'pptx' });
  await waitFor(/export: deck\.html → PowerPoint/);
  // its own socket, for the same reason — and a DIFFERENT kind, because the
  // lock is one browser on one machine, not one output path
  const second = await rawPost(base, '/edit/export', { kind: 'pdf' });
  assert.equal(second.status, 409, 'a second export while one is in flight');
  assert.match(second.body, /already running/);

  assert.equal((await first).status, 200, 'the first one still finishes');
  // and once it is done, the row works again
  assert.equal((await post(base, '/edit/export', { kind: 'pptx' })).status, 200);
});

test('an export that fails says so and leaves the author server serving', async (t) => {
  if (noFakeChrome) return t.skip('the stand-in Chrome is a script, and execFile will not spawn a .cmd');
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  writeFileSync(deck, DECK);
  const chrome = writeFakeBin(dir, 'fake-chrome', FAKE_CHROME);
  const { base } = await startEdit(t, dir, { env: { PATH: dir, DECKLIGHT_CHROME: chrome, FAKE_CHROME_BLANK: '1' } });

  const res = await post(base, '/edit/export', { kind: 'pptx' });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /export refused/);
  assert.ok(!existsSync(path.join(dir, 'deck.pptx')), 'nothing half-written was left behind');

  // the point of the whole route: the session survives its own failure
  assert.equal((await (await fetch(base + '/edit/ping')).json()).ok, true);
});

test('/edit/export writes each of the PDFs `decklight pdf` writes, under its own name', async (t) => {
  if (noFakeChrome) return t.skip('the stand-in Chrome is a script, and execFile will not spawn a .cmd');
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const chrome = writeFakeBin(dir, 'fake-chrome', FAKE_CHROME);
  const { base } = await startEdit(t, dir, { env: { PATH: dir, DECKLIGHT_CHROME: chrome } });

  // The variant names are `pdfOut`'s, not this route's — a handout that landed
  // on deck.pdf would quietly replace the slides somebody exported first.
  for (const [kind, file] of [['pdf', 'deck.pdf'], ['pdf-notes', 'deck.notes.pdf'], ['pdf-handout', 'deck.handout.pdf']]) {
    const r = await (await post(base, '/edit/export', { kind })).json();
    assert.equal(r.ok, true, `${kind} refused: ${r.error}`);
    assert.equal(r.file, file);
    assert.ok(existsSync(path.join(dir, file)), `${kind} wrote no ${file}`);
  }
});

test('/edit/export refuses a file it does not write, and still answers the old name', async (t) => {
  if (noFakeChrome) return t.skip('the stand-in Chrome is a script, and execFile will not spawn a .cmd');
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const chrome = writeFakeBin(dir, 'fake-chrome', FAKE_CHROME);
  const { base } = await startEdit(t, dir, { env: { PATH: dir, DECKLIGHT_CHROME: chrome } });

  const bad = await post(base, '/edit/export', { kind: 'keynote' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /not a file this server writes: keynote/);

  // A deck carries its OWN copy of the runtime, so one written by 0.8.1 and
  // opened under this server still posts the name that release used.
  const old = await (await post(base, '/edit/pptx')).json();
  assert.equal(old.ok, true, `the 0.8.1 path stopped working: ${old.error}`);
  assert.equal(old.file, 'deck.pptx');
});

// The shape `decklight init` scaffolds: themes already inline, nothing left
// for the bundler to flatten. It is the common deck to publish, and the one
// `decklight publish` needs --no-bundle for — which the route works out rather
// than handing a presenter a refusal about a flag.
const ONE_FILE_DECK = DECK.replace('<html><body>', '<html><head><style data-theme="ink"></style></head><body>');

/** A repo with a GitHub remote and one commit — what a plan can be made from. */
function repoWithRemote(dir, html = ONE_FILE_DECK, { remote = 'git@github.com:acme/talks.git' } = {}) {
  writeFileSync(path.join(dir, 'deck.html'), html);
  git(['init', '-q', '-b', 'main'], dir);
  if (remote) git(['remote', 'add', 'origin', remote], dir);
  git(['add', 'deck.html'], dir);
  git(['-c', 'user.email=a@b.c', '-c', 'user.name=A', 'commit', '-qm', 'first'], dir);
}

// ── deck templates, into a deck that already exists (UNITS#REST) ───────────

const TEMPLATE_DECK = `<!doctype html><html><body>
<div class="decklight">
  <section>
    <h1>Startup pitch</h1>
  </section>
  <section>
    <h2>Pricing</h2>
    <img src="assets/table.png">
  </section>
  <section data-hidden>
    <h2>Backup</h2>
  </section>
</div>
</body></html>`;

/** An author server whose unit library is this test's own temp directory. */
async function startWithTemplate(t, dir, { install = true } = {}) {
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const home = path.join(dir, 'home');
  if (install) {
    mkdirSync(path.join(home, 'templates'), { recursive: true });
    writeFileSync(path.join(home, 'templates', 'startup-pitch.html'), TEMPLATE_DECK);
  } else {
    mkdirSync(home, { recursive: true });
  }
  return startEdit(t, dir, { env: { DECKLIGHT_HOME: home } });
}

test('/edit/template/list says what is installed here, without reaching the network', async (t) => {
  const dir = tmp(t);
  const { base } = await startWithTemplate(t, dir);
  const j = await (await fetch(base + '/edit/template/list')).json();
  assert.equal(j.ok, true);
  assert.deepEqual(j.installed, ['startup-pitch']);
  assert.equal(j.cacheOnly, true, 'listing is a read of the cache, never a fetch');
  assert.deepEqual(j.offered, [], 'no marketplace registered, so nothing to offer');
});

test('/edit/template/slides reads the template as a numbered list, and names what a slide needs', async (t) => {
  const dir = tmp(t);
  const { base } = await startWithTemplate(t, dir);
  const j = await (await fetch(base + '/edit/template/slides?name=startup-pitch')).json();
  assert.equal(j.ok, true);
  assert.deepEqual(j.slides.map((s) => [s.n, s.title, s.hidden]), [
    [1, 'Startup pitch', false], [2, 'Pricing', false], [3, 'Backup', true],
  ]);
  assert.deepEqual(j.slides[1].needs, ['assets/table.png'],
    'said before the slide is taken, not discovered afterwards');

  const missing = await fetch(base + '/edit/template/slides?name=nope');
  assert.equal(missing.status, 404);
  assert.match((await missing.json()).error, /no template "nope" is installed here/);
});

test('/edit/template/at serves the template itself, so the picker can render it', async (t) => {
  const dir = tmp(t);
  const { base } = await startWithTemplate(t, dir);
  const r = await fetch(base + '/edit/template/at?name=startup-pitch&embedded');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const html = await r.text();
  assert.match(html, /<base href="\/">/, 'served two paths deep — without it every relative ref resolves there');
  assert.match(html, /Startup pitch/);
  assert.match(html, /Backup/, 'the whole template, hidden slides and all — this is a preview, not an export');

  // A template written the ordinary way links a runtime that is not beside it
  // once installed, and this server serves none of its own to point at.
  writeFileSync(path.join(dir, 'home', 'templates', 'linked.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="../dist/decklight.css">'
    + '<link rel="stylesheet" href="../themes/aurora.css"></head><body>'
    + '<div class="decklight"><section><h1>Linked</h1></section></div>'
    + '<script src="../dist/decklight.js"></script></body></html>');
  const linked = await (await fetch(base + '/edit/template/at?name=linked&embedded')).text();
  assert.match(linked, /<style data-decklight-runtime="css">/, 'the preview boots, or it is not a preview');
  assert.match(linked, /<script data-decklight-runtime="js">/);
  assert.match(linked, /<style data-theme="aurora">/);
  assert.doesNotMatch(linked, /\.\.\/dist\/decklight\.js/);

  const missing = await fetch(base + '/edit/template/at?name=nope');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /no template "nope" is installed here/);
});

test('/edit/template/insert puts the chosen slides after a slide, as ONE undo entry', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  const { base } = await startWithTemplate(t, dir);
  const before = readFileSync(deck, 'utf8');

  const r = await (await post(base, '/edit/template/insert',
    { name: 'startup-pitch', slides: [2, 1], after: 1 })).json();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.inserted, 2);
  assert.deepEqual(r.titles, ['Startup pitch', 'Pricing'], 'in the template’s order, not the order asked for');
  assert.deepEqual(r.needs, ['assets/table.png']);

  const after = readFileSync(deck, 'utf8');
  const headings = [...after.matchAll(/<h[12][^>]*>([^<]+)<\/h[12]>/g)].map((m) => m[1]);
  assert.deepEqual(headings.slice(0, 3), ['Alpha', 'Startup pitch', 'Pricing'],
    'after slide 1, in template order');

  // ONE entry: an insert is an ordinary edit, so Z takes the whole thing back
  assert.equal(r.undo, 1);
  assert.equal((await post(base, '/edit/undo')).status, 200);
  assert.equal(readFileSync(deck, 'utf8'), before, 'undo took back all of it');
});

test('/edit/template/insert refuses a slide the template has not, and a position the deck has not', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  const { base } = await startWithTemplate(t, dir);
  const before = readFileSync(deck, 'utf8');

  const noSlide = await post(base, '/edit/template/insert', { name: 'startup-pitch', slides: [9], after: 1 });
  assert.equal(noSlide.status, 400);
  assert.match((await noSlide.json()).error, /has no slide 9 \(it has 3\)/);

  const noSpot = await post(base, '/edit/template/insert', { name: 'startup-pitch', slides: [1], after: 99 });
  assert.equal(noSpot.status, 400);
  assert.match((await noSpot.json()).error, /cannot insert after slide 99/);

  const noTemplate = await post(base, '/edit/template/insert', { name: 'ghost', slides: [1], after: 1 });
  assert.equal(noTemplate.status, 404);

  assert.equal(readFileSync(deck, 'utf8'), before, 'a refused insert wrote nothing');
});

// A template's design is half markup and half stylesheet. Taking only the
// markup lands a slide that is structurally right and looks like nothing.
const STYLED_TEMPLATE = `<!doctype html><html><head>
<style>
  .breaks { gap: 12px }
  .breaks li { padding: 1px }
  .promises { display: flex }
  p { margin: 0 }
</style>
</head><body>
<div class="decklight">
  <section>
    <h2>Failures</h2>
    <ul class="breaks"><li>one</li></ul>
  </section>
  <section>
    <h2>Promises</h2>
    <div class="promises"></div>
  </section>
</div>
</body></html>`;

test('/edit/template/insert brings the rules the taken slide is shaped by', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  const { base } = await startWithTemplate(t, dir);
  writeFileSync(path.join(dir, 'home', 'templates', 'styled.html'), STYLED_TEMPLATE);

  const r = await (await post(base, '/edit/template/insert', { name: 'styled', slides: [1], after: 1 })).json();
  assert.equal(r.ok, true);
  assert.deepEqual(r.styles.carried, ['.breaks']);
  assert.deepEqual(r.styles.clashed, []);

  const after = readFileSync(deck, 'utf8');
  assert.match(after, /<style data-from-template="styled">/);
  assert.match(after, /\.breaks \{ gap: 12px \}/);
  assert.match(after, /\.breaks li \{ padding: 1px \}/);
  assert.doesNotMatch(after, /\.promises/, 'the rule for a slide nobody took stayed behind');
  assert.doesNotMatch(after, /^\s*p \{ margin: 0 \}/m,
    "somebody else's bare `p` rule would restyle every paragraph in this deck");

  // one undo entry: the section and the rules that shape it are one edit
  await post(base, '/edit/undo', {});
  const back = readFileSync(deck, 'utf8');
  assert.doesNotMatch(back, /data-from-template/);
  assert.doesNotMatch(back, /Failures/);
});

test('a class the deck already means something else by keeps the deck’s rules, and is said before it lands', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  // this deck has its OWN .breaks — carrying the template's would restyle a
  // slide the author never touched
  writeFileSync(deck, DECK.replace('<html><body>',
    '<html><head><style>.breaks { gap: 99px }</style></head><body>'));
  const home = path.join(dir, 'home');
  mkdirSync(path.join(home, 'templates'), { recursive: true });
  writeFileSync(path.join(home, 'templates', 'styled.html'), STYLED_TEMPLATE);
  const { base } = await startEdit(t, dir, { env: { DECKLIGHT_HOME: home } });

  // said in the picker, beside `needs`, rather than in the toast afterwards
  const listed = await (await fetch(base + '/edit/template/slides?name=styled')).json();
  assert.deepEqual(listed.slides[0].clashes, ['.breaks']);
  assert.deepEqual(listed.slides[1].clashes, [], 'a slide that does not use the name is not warned about it');

  const r = await (await post(base, '/edit/template/insert', { name: 'styled', slides: [1], after: 1 })).json();
  assert.deepEqual(r.styles.clashed, ['.breaks']);
  assert.deepEqual(r.styles.carried, []);
  const after = readFileSync(deck, 'utf8');
  assert.match(after, /\.breaks \{ gap: 99px \}/, "the deck's own rule is untouched");
  assert.doesNotMatch(after, /gap: 12px/, 'and the template’s was refused, not merged');
});

test('/edit/template/insert takes the whole template when no slides are named', async (t) => {
  const dir = tmp(t);
  const deck = path.join(dir, 'deck.html');
  const { base } = await startWithTemplate(t, dir);

  const r = await (await post(base, '/edit/template/insert', { name: 'startup-pitch', after: 0 })).json();
  assert.equal(r.inserted, 3, 'all of them, hidden slide included — it is still a slide');
  const headings = [...readFileSync(deck, 'utf8').matchAll(/<h[12][^>]*>([^<]+)<\/h[12]>/g)].map((m) => m[1]);
  assert.deepEqual(headings.slice(0, 4), ['Startup pitch', 'Pricing', 'Backup', 'Alpha'],
    'after 0 is before the first slide');
});

test('/edit/publish/plan names where the deck would go, without putting it there', async (t) => {
  const dir = tmp(t);
  repoWithRemote(dir);
  const { base } = await startEdit(t, dir);

  const j = await (await fetch(base + '/edit/publish/plan')).json();
  assert.equal(j.ok, true, j.error);
  assert.equal(j.remote, 'origin');
  assert.equal(j.branch, 'gh-pages');
  // The URL is the point of asking: it is what somebody will be sent, and the
  // deck shows it BEFORE taking a confirmation.
  assert.equal(j.url, 'https://acme.github.io/talks/');
  assert.equal(typeof j.signing, 'boolean');
  // The words a deck would show come from HERE, because the runtime is not
  // allowed to name the signing client at all (test/sign.test.mjs).
  if (!j.signing) assert.match(j.why, /npm install sigstore/);
  assert.equal(j.bundled, false, 'a deck that is already one file would be bundled again');

  // A plan is a read. Nothing was pushed, nothing was committed, nothing moved.
  assert.equal(git(['rev-list', '--count', 'HEAD'], dir), '1');
  assert.equal(git(['branch', '--list', 'gh-pages'], dir), '');
  assert.equal(git(['status', '--porcelain'], dir), '');
});

test('/edit/publish/plan refuses when there is nowhere to publish to', async (t) => {
  const dir = tmp(t);
  repoWithRemote(dir, ONE_FILE_DECK, { remote: null });
  const { base } = await startEdit(t, dir);

  const r = await fetch(base + '/edit/publish/plan');
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /nowhere to publish to/);
});

test('publishing without the client that signs it is a refusal, not an unsigned page', async (t) => {
  const dir = tmp(t);
  repoWithRemote(dir);
  const { base } = await startEdit(t, dir);

  // sigstore is an OPTIONAL dependency and CI installs with --omit=optional,
  // so this is the shape the suite actually runs in — and the one that must
  // never end with a page on the internet that nothing vouches for.
  const { loadClient } = await import('../cli/sign.mjs');
  if (await loadClient()) return t.skip('sigstore is installed here — the refusal cannot be provoked');

  const plan = await (await fetch(base + '/edit/publish/plan')).json();
  assert.equal(plan.signing, false, 'the plan claims it could sign');

  const r = await post(base, '/edit/publish');
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /sign/i);
  assert.equal(git(['branch', '--list', 'gh-pages'], dir), '', 'a branch was written anyway');
});

test('a long export says where it is, slide by slide, on the event stream', async (t) => {
  if (noFakeChrome) return t.skip('the stand-in Chrome is a script, and execFile will not spawn a .cmd');
  const dir = tmp(t);
  writeFileSync(path.join(dir, 'deck.html'), DECK);          // two slides
  const chrome = writeFakeBin(dir, 'fake-chrome', FAKE_CHROME);
  const { base } = await startEdit(t, dir, { env: { PATH: dir, DECKLIGHT_CHROME: chrome } });

  // The deck's own channel, read the way the deck reads it. Without this the
  // progress row can only say "this takes a moment" and then sit there.
  const events = [];
  const res = await fetch(base + '/edit/events');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buf += dec.decode(value, { stream: true });
      for (const m of buf.matchAll(/event: export\ndata: (.*)\n/g)) events.push(JSON.parse(m[1]));
      buf = buf.slice(buf.lastIndexOf('\n\n') + 1);
    }
  })();
  t.after(() => reader.cancel().catch(() => { /* already closed */ }));

  assert.equal((await post(base, '/edit/export', { kind: 'pptx' })).status, 200);
  const stop = Date.now() + 4000;
  while (!events.some((e) => e.state === 'done') && Date.now() < stop) await new Promise((ok) => setTimeout(ok, 25));

  assert.deepEqual(events.map((e) => e.state), ['start', 'slide', 'slide', 'done'], JSON.stringify(events));
  assert.deepEqual(events.filter((e) => e.state === 'slide').map((e) => [e.n, e.of]), [[1, 2], [2, 2]]);
  assert.equal(events.at(-1).file, 'deck.pptx');
});
