// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight author <git url>` (cli/clone-deck.mjs): the URL people paste,
// the clone, the deck found inside it. Every clone here is from a local bare
// repository over file:// — real git, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTemp, stop } from './helpers.mjs';
import { spawn } from 'node:child_process';
import { parseDeckSource, cloneDeck, findDeck } from '../cli/clone-deck.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const DECK = '<!doctype html><div class="decklight"><section><h1>x</h1></section></div>\n<script>Decklight.init({})</script>\n';

test('parseDeckSource: only an explicit git URL counts, and a GitHub file link names branch and deck', () => {
  assert.equal(parseDeckSource('deck.html'), null);
  assert.equal(parseDeckSource('slides/q3.html'), null, 'owner/repo shorthand is a path here, never a clone');
  assert.equal(parseDeckSource('decklight/decklight'), null);
  assert.deepEqual(parseDeckSource('https://github.com/you/talk'), { url: 'https://github.com/you/talk.git', ref: null, deck: null, name: 'talk' });
  assert.deepEqual(parseDeckSource('https://github.com/you/talk.git/'), { url: 'https://github.com/you/talk.git', ref: null, deck: null, name: 'talk' });
  assert.deepEqual(parseDeckSource('https://github.com/you/talk/blob/draft/slides/q3.html'),
    { url: 'https://github.com/you/talk.git', ref: 'draft', deck: 'slides/q3.html', name: 'talk' });
  assert.deepEqual(parseDeckSource('https://github.com/you/talk/tree/v2'), { url: 'https://github.com/you/talk.git', ref: 'v2', deck: null, name: 'talk' });
  assert.deepEqual(parseDeckSource('git@github.com:you/talk.git#deck.html'), { url: 'git@github.com:you/talk.git', ref: null, deck: 'deck.html', name: 'talk' });
  assert.deepEqual(parseDeckSource('file:///srv/decks/talk.git'), { url: 'file:///srv/decks/talk.git', ref: null, deck: null, name: 'talk' });
  // --branch outranks the link; a ref that could be read as an option is refused by name
  assert.equal(parseDeckSource('https://github.com/you/talk/tree/v2', { branch: 'main' }).ref, 'main');
  assert.throws(() => parseDeckSource('https://github.com/you/talk', { branch: '--upload-pack=x' }), /--branch --upload-pack=x is not a branch or tag name/);
});

// ── a bare repository to clone from ──────────────────────────────────────────
const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function bareRepo(root, files, { branch = 'main', head = branch } = {}) {
  const bare = path.join(root, 'talk.git');
  const work = path.join(root, 'seed');
  fs.mkdirSync(work, { recursive: true });
  // -b: the bare repo's HEAD must name the branch that is pushed, whatever
  // this machine's init.defaultBranch is — CI's is `master`, and a clone of a
  // bare repo whose HEAD names a missing branch checks out nothing
  g(['init', '--bare', '-q', '-b', head, bare], root);
  g(['init', '-q', '-b', branch], work);
  g(['config', 'user.email', 't@e.com'], work);
  g(['config', 'user.name', 'T'], work);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
    fs.writeFileSync(path.join(work, name), text);
  }
  g(['add', '-A'], work); g(['commit', '-qm', 'first'], work);
  fs.writeFileSync(path.join(work, 'notes.txt'), 'second');
  g(['add', '-A'], work); g(['commit', '-qm', 'second'], work);
  g(['remote', 'add', 'origin', `file://${bare}`], work);
  g(['push', '-q', 'origin', branch], work);
  return { bare, url: `file://${bare}`, work };
}

test('cloneDeck: a full clone into ./<repo>, a branch when asked, and an existing clone opened as it is', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-clone-'));
  t.after(() => rmTemp(root));
  const { url, work } = bareRepo(root, { 'deck.html': DECK });
  g(['checkout', '-qb', 'draft'], work);
  fs.writeFileSync(path.join(work, 'deck.html'), DECK.replace('x', 'draft'));
  g(['commit', '-qam', 'draft'], work); g(['push', '-q', 'origin', 'draft'], work);
  const cwd = path.join(root, 'here'); fs.mkdirSync(cwd);

  const src = parseDeckSource(url);
  const first = cloneDeck(src, { cwd });
  assert.equal(first.reused, false);
  assert.equal(first.dir, path.join(cwd, 'talk'), 'named after the repository');
  assert.ok(fs.existsSync(path.join(first.dir, '.git')), 'a real clone, with its .git — the history is the point');
  assert.equal(g(['rev-list', '--count', 'HEAD'], first.dir), '2', 'in full, not shallow');
  assert.equal(findDeck(first.dir), path.join(first.dir, 'deck.html'));

  // second time: opened, not re-cloned, and not pulled
  const again = cloneDeck(src, { cwd });
  assert.deepEqual(again, { dir: first.dir, reused: true, ref: null });

  // a branch, somewhere else
  const draft = cloneDeck(parseDeckSource(url, { branch: 'draft' }), { cwd, into: 'talk-draft' });
  assert.equal(draft.ref, 'draft');
  assert.match(fs.readFileSync(path.join(draft.dir, 'deck.html'), 'utf8'), /draft/);

  // a directory that is something else is refused, never written into
  fs.mkdirSync(path.join(cwd, 'mine')); fs.writeFileSync(path.join(cwd, 'mine', 'keep.txt'), 'mine');
  assert.throws(() => cloneDeck(src, { cwd, into: 'mine' }), /already exists and is not a clone of/);
  assert.equal(fs.readFileSync(path.join(cwd, 'mine', 'keep.txt'), 'utf8'), 'mine');
  // …and so is a clone of a DIFFERENT remote under the same name
  const other = bareRepo(path.join(root, 'other'), { 'deck.html': DECK });
  assert.throws(() => cloneDeck(parseDeckSource(other.url), { cwd }), /is not a clone of .*\(its origin is file:/);

  // a repository whose HEAD names a branch that is not there (a renamed default
  // branch) checks out nothing: refused by name, with the branches that exist,
  // and the empty clone removed so a retry with --branch is not "already cloned"
  const renamed = bareRepo(path.join(root, 'renamed'), { 'deck.html': DECK }, { branch: 'main', head: 'master' });
  assert.throws(() => cloneDeck(parseDeckSource(renamed.url), { cwd, into: 'renamed-empty' }), /checked out nothing — its default branch is missing there\. Pass --branch: main/);
  assert.ok(!fs.existsSync(path.join(cwd, 'renamed-empty')), 'the empty clone was removed, so a retry is not "already cloned"');
  const retried = cloneDeck(parseDeckSource(renamed.url, { branch: 'main' }), { cwd, into: 'renamed-ok' });
  assert.ok(fs.existsSync(path.join(retried.dir, 'deck.html')));
  // an unreachable repository is a sentence, not a hang or a prompt
  assert.throws(() => cloneDeck(parseDeckSource(`file://${root}/nowhere.git`), { cwd }), /git clone file:.*nowhere\.git failed/);
});

test('findDeck: the one deck, the named deck, and a refusal that lists the candidates', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-find-'));
  t.after(() => rmTemp(root));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('README.md', '# talk');
  put('node_modules/x/index.html', DECK);                 // never looked at
  put('dist/decklight.html', DECK);                       // nor generated output
  assert.throws(() => findDeck(root), /no decklight deck in .* nothing there calls Decklight\.init/);
  put('slides/q3.html', DECK);
  assert.equal(findDeck(root), path.join(root, 'slides', 'q3.html'), 'one deck, found below the top level');
  put('index.html', '<p>a page that is not a deck</p>');
  assert.equal(findDeck(root), path.join(root, 'slides', 'q3.html'), 'a page without Decklight.init is not a candidate');
  put('slides/q4.html', DECK);
  assert.throws(() => findDeck(root), /2 decks in .* name one: append #<path> to the URL\n  slides\/q3\.html\n  slides\/q4\.html/);
  assert.equal(findDeck(root, 'slides/q4.html'), path.join(root, 'slides', 'q4.html'));
  assert.throws(() => findDeck(root, 'slides/q9.html'), /no slides\/q9\.html in/);
  assert.throws(() => findDeck(root, '../etc/passwd'), /relative to the repository/);
  assert.throws(() => findDeck(root, '/etc/passwd'), /relative to the repository/);
});

test('decklight author <url>: clones, then refuses before any server when it cannot pick the deck', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-author-url-'));
  t.after(() => rmTemp(root));
  const { url } = bareRepo(root, { 'a.html': DECK, 'b.html': DECK });
  const cwd = path.join(root, 'here'); fs.mkdirSync(cwd);
  const r = spawnSync(process.execPath, [CLI, 'author', url], { cwd, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /cloned file:.*talk\.git → talk/, 'it said what it did before it refused');
  assert.match(r.stderr, /2 decks in .* name one: append #<path> to the URL/);
  assert.ok(fs.existsSync(path.join(cwd, 'talk', '.git')), 'the clone is left for the next try');
  // a bad ref is refused before anything is cloned
  const bad = spawnSync(process.execPath, [CLI, 'author', url, '--branch', '--upload-pack=x'], { cwd: path.join(root), encoding: 'utf8', timeout: 60_000 });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /decklight author: --branch --upload-pack=x is not a branch or tag name/);
  assert.ok(!fs.existsSync(path.join(root, 'talk')), 'nothing cloned');
  // a path that does not exist is still just that
  const missing = spawnSync(process.execPath, [CLI, 'author', 'slides/q3.html'], { cwd, encoding: 'utf8' });
  assert.match(missing.stderr, /no such deck: slides\/q3\.html/);
});

test('decklight author <url>: the clone IS the working directory — git runs there, not where author was run from', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-author-url-cwd-'));
  t.after(() => rmTemp(root));
  const { url } = bareRepo(root, { 'deck.html': DECK });
  const cwd = path.join(root, 'here'); fs.mkdirSync(cwd);
  const child = spawn(process.execPath, [CLI, 'author', url, '--no-tts', '--no-lipsync', '--port', '0'],
    { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stop(child));
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => { const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); } }, 50);
    child.on('exit', () => { clearInterval(scan); reject(new Error(`author exited early:\n${out}`)); });
    setTimeout(() => { clearInterval(scan); reject(new Error(`no URL in 20s:\n${out}`)); }, 20_000);
  });
  assert.match(out, /cloned file:.*talk\.git → talk/);
  assert.ok(!fs.existsSync(path.join(cwd, '.git')), 'no repository was created where author was run from');
  const ping = await (await fetch(`${base}/edit/ping`)).json();
  assert.equal(ping.git, true, 'git is on — a clone is a repository, not a question');
  assert.equal(ping.remote?.url, url, "the edit server's git is the clone's, with its origin");
  assert.equal(fs.readdirSync(cwd).join(','), 'talk', 'the only thing author left behind is the clone');
});
