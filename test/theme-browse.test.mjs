// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Theme Browse (MARKETPLACE.md THEME_BROWSE#UI): what the picker's Browse entry
// lists, and what installing one actually does.
//
// The claims worth pinning are the ones that keep this from becoming a second,
// laxer install path: a theme the command line would refuse is refused here by
// the same code, a failed install leaves the deck byte-for-byte unchanged, and
// listing never touches the network — a deck on a plane lists what it has and
// says which catalogs it could not read.
//
// This is the server half plus the source-shape claims about the player. The
// player's BEHAVIOUR — the row appearing only in author mode, the refusal
// keeping the picker up, the install going out as a qualified ref — needs a real
// browser and lives in test/engine.html's `browse` and `nobrowse` modes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const EDIT = path.join(ROOT, 'cli/edit.mjs');

const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-browse-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const DECK = `<!doctype html>
<html><head><title>T</title></head>
<body><div class="decklight"><section><h2>A</h2></section></div>
<script>Decklight.init()</script></body></html>
`;

/** A marketplace whose themes are real files on disk — one valid, one not. */
function marketplace() {
  const repo = tmp();
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  mkdirSync(path.join(repo, 'themes'), { recursive: true });
  // A theme that passes the contract: the shipped aurora, copied verbatim.
  writeFileSync(path.join(repo, 'themes/nord-deep.css'), readFileSync(path.join(ROOT, 'themes/aurora.css')));
  writeFileSync(path.join(repo, 'themes/broken.css'), ':root { --font-body: sans-serif }\n');
  writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({
    name: 'nord-pack',
    entries: [
      { name: 'nord-deep', type: 'theme', source: './themes/nord-deep.css', description: 'deep blues' },
      { name: 'broken', type: 'theme', source: './themes/broken.css' },
      // A non-theme entry, here to prove Browse filters it out. `extensions`
      // is required of an importer since UNITS#REST — it is what lets
      // `decklight import` name an adapter from the cache, offline.
      { name: 'marp', type: 'importer', source: './marp', extensions: ['.marp'], apiVersion: 1 },
    ],
  }, null, 2));
  return repo;
}

function home(repo, { update = true } = {}) {
  const h = tmp();
  const env = { ...process.env, DECKLIGHT_HOME: h };
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  if (update) {
    execFileSync(process.execPath, [CLI, 'marketplace', 'update', 'nord-pack'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  }
  return h;
}

async function startAuthor(t, h) {
  const dir = tmp();
  writeFileSync(path.join(dir, 'deck.html'), DECK);
  const proc = spawn(process.execPath, [EDIT, 'deck.html', '--port', '0', '--no-git'], {
    cwd: dir, env: { ...process.env, DECKLIGHT_HOME: h }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => proc.kill('SIGKILL'));
  let out = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); }
    }, 25);
    proc.on('exit', () => { clearInterval(scan); reject(new Error(`author exited early:\n${out}`)); });
    setTimeout(() => { clearInterval(scan); reject(new Error(`timeout:\n${out}`)); }, 10000);
  });
  const deck = path.join(dir, 'deck.html');
  return { base, deck, log: () => out };
}

// ── what Browse lists ──────────────────────────────────────────────────────

test('Browse lists theme entries, qualified, and nothing that is not a theme', async (t) => {
  const { base } = await startAuthor(t, home(marketplace()));
  const j = await (await fetch(`${base}/edit/theme/browse`)).json();

  assert.equal(j.ok, true);
  assert.deepEqual(j.themes.map((x) => x.qualified).sort(), ['broken@nord-pack', 'nord-deep@nord-pack']);
  assert.equal(j.themes.find((x) => x.name === 'nord-deep').description, 'deep blues');
  assert.ok(!j.themes.some((x) => x.name === 'marp'), 'an importer is not a theme');
});

test('a registered-but-never-fetched marketplace is named, not silently empty', async (t) => {
  // `marketplace add` caches as it registers, so the reachable version of this
  // state is the FIRST-PARTY marketplace: registered on first run, never
  // fetched, by design. An empty list there would be the common case looking
  // like a broken one.
  const { base } = await startAuthor(t, home(marketplace(), { update: false }));
  const j = await (await fetch(`${base}/edit/theme/browse`)).json();
  assert.ok(j.stale.includes('decklight'), 'the first-party one is reported unfetched, honestly');
  assert.ok(!j.themes.some((x) => x.marketplace === 'decklight'), 'and offers nothing it has not read');
  assert.equal(j.cacheOnly, true, 'and listing never fetched anything to find out');
});

// ── what installing does ───────────────────────────────────────────────────

test('installing goes through theme add\'s own path, and lands as an Added block', async (t) => {
  const { base, deck } = await startAuthor(t, home(marketplace()));
  const before = readFileSync(deck, 'utf8');

  const r = await fetch(`${base}/edit/theme/add`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'nord-deep@nord-pack' }),
  });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.name, 'nord-deep');
  assert.equal(j.from, 'nord-deep@nord-pack');
  assert.equal(j.replaced, false);
  assert.ok(j.undo >= 1, 'Z takes it back like any other edit');

  const after = readFileSync(deck, 'utf8');
  assert.notEqual(after, before);
  assert.match(after, /<style data-theme="nord-deep"[^>]*data-theme-added/,
    'the same block shape theme add writes — so the picker treats it identically');
});

test('a theme the command line would refuse is refused here too, deck untouched', async (t) => {
  // Same validator, same gates. A picker that could leave a deck carrying a
  // broken theme would be worse than no picker.
  const { base, deck } = await startAuthor(t, home(marketplace()));
  const before = readFileSync(deck, 'utf8');

  const r = await fetch(`${base}/edit/theme/add`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'broken@nord-pack' }),
  });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.match(j.error, /fails the theme contract/);
  assert.ok(Array.isArray(j.problems) && j.problems.length, 'and says which tokens are missing');
  assert.equal(readFileSync(deck, 'utf8'), before, 'byte-for-byte unchanged');
});

test('the refusals that are not about the theme itself', async (t) => {
  const { base, deck } = await startAuthor(t, home(marketplace()));
  const before = readFileSync(deck, 'utf8');

  const cases = [
    [{ ref: 'ghost' }, 404, /no "ghost" in any registered marketplace/],
    [{ ref: 'marp@nord-pack' }, 400, /is a importer, not a theme/],
    [{ ref: 'nord-deep@nord-pack', name: '../../etc/passwd' }, 400, /not a usable theme name/],
    [{}, 400, /which theme/],
  ];
  for (const [body, status, re] of cases) {
    const r = await fetch(`${base}/edit/theme/add`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(r.status, status, JSON.stringify(body));
    assert.match((await r.json()).error, re, JSON.stringify(body));
  }
  assert.equal(readFileSync(deck, 'utf8'), before, 'nothing was written on any of them');
});

test('re-adding the same name replaces the block rather than stacking a second', async (t) => {
  const { base, deck } = await startAuthor(t, home(marketplace()));
  const add = () => fetch(`${base}/edit/theme/add`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'nord-deep@nord-pack' }),
  });
  await add();
  const second = await (await add()).json();
  assert.equal(second.replaced, true, 're-adding IS the update path (THEME_DISTRIBUTION)');
  const blocks = readFileSync(deck, 'utf8').match(/<style data-theme="nord-deep"/g) ?? [];
  assert.equal(blocks.length, 1);
});

// ── author mode only ───────────────────────────────────────────────────────

test('present has no browse or install surface at all', async () => {
  const src = readFileSync(path.join(ROOT, 'cli/present.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /theme\/browse|theme\/add|installTheme/,
    'installing is a deck edit, and the read-only viewer performs none');
});

test('the player reaches the author server for this and nowhere else', () => {
  // The invariant Browse exists under: a deck never fetches a theme itself.
  // Listing and installing are both requests to the author server, which is the
  // only party allowed to touch a marketplace — so nothing in the picker may
  // name a host, and a manifest's `source` must never reach the player at all.
  const src = readFileSync(path.join(ROOT, 'src/core/themes.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const urls = code.match(/https?:\/\/[^'"`\s]+/g) ?? [];
  assert.deepEqual(urls, [], 'the picker addresses the author server by path, never by origin');

  // Every request it makes is built the same way: the author server's own
  // origin plus a literal path. Nothing a catalog supplied can become a URL
  // here, which is what keeps a manifest's `source` the server's to resolve.
  const fetches = [...code.matchAll(/fetch\(([^\n]*)/g)].map((m) => m[1].trim());
  assert.equal(fetches.length, 2, 'listing and installing, and no third request');
  for (const arg of fetches) {
    assert.match(arg, /^authorBase\(\) \+ '\/edit\//, `built from a literal path: ${arg}`);
  }

  const routes = [...code.matchAll(/'(\/edit\/[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(routes)].sort(), ['/edit/theme/add', '/edit/theme/browse'],
    'and it uses exactly the two routes Browse is made of');
});
