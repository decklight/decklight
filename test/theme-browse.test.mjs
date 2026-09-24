// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Marketplace themes while authoring (MARKETPLACE.md THEME_BROWSE#UI): what
// the overlay lists, and what MARKING one does (SPEC THEME_DISTRIBUTION).
//
// The claims worth pinning are the ones that keep this from becoming a second,
// laxer path into a deck: a theme the command line would refuse is refused
// here by the same code, a refusal leaves the deck byte-for-byte unchanged,
// marking writes a reference and never CSS, and listing never touches the
// network — a deck on a plane lists what it has and says which catalogs it
// could not read.
//
// This is the server half plus the source-shape claims about the player. The
// player's BEHAVIOUR — marketplace rows appearing only in author mode, Space
// marking, a presented deck listing only what it marks — needs a real browser
// and lives in test/engine.html's `browse` and `nobrowse` modes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { writeFileSync, readFileSync, mkdirSync, cpSync } from 'node:fs';
import path from 'node:path';
import { rmTemp, tmp as scratch, stop } from './helpers.mjs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const EDIT = path.join(ROOT, 'cli/edit.mjs');

const tmp = () => scratch('browse');

// A deck as data (#520): slides and a configuration block, which is where a
// marked theme is recorded.
const DECK = `<!doctype html>
<html><head><title>T</title>
<script type="application/json" data-decklight-config>{ "decklight": "0.9.0", "theme": "aurora" }</script>
</head>
<body><div class="decklight"><section><h2>A</h2></section></div></body></html>
`;
// The same deck written by hand, with no block to record anything in.
const HAND_WRITTEN = `<!doctype html>
<html><head><title>T</title></head>
<body><div class="decklight"><section><h2>A</h2></section></div>
<script>Decklight.init()</script></body></html>
`;

/** A marketplace whose themes are real files on disk — one valid, one not. */
function marketplace({ extra = [] } = {}) {
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
      ...extra,
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

async function startAuthor(t, h, { deck: body = DECK } = {}) {
  const dir = tmp();
  writeFileSync(path.join(dir, 'deck.html'), body);
  const proc = spawn(process.execPath, [EDIT, 'deck.html', '--port', '0', '--no-git'], {
    cwd: dir, env: { ...process.env, DECKLIGHT_HOME: h }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => stop(proc));
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

test('a cached catalog whose FILES are not on disk is stale too — not an offer that can only fail', async (t) => {
  // The state an upgrade leaves behind: a manifest cached by a decklight that
  // fetched entries one URL at a time, and no checkout. Since MARKETPLACES#CLONE
  // an entry installs from its marketplace's clone, so listing these themes
  // would put rows in the picker that cannot install. `marketplace update`
  // fixes both halves at once, and that is what `stale` already means.
  const h = home(marketplace());
  const regPath = path.join(h, 'marketplaces.json');
  const reg = JSON.parse(readFileSync(regPath, 'utf8'));
  reg.marketplaces['nord-pack'].source = 'acme/catalog';   // re-registered from a remote
  writeFileSync(regPath, JSON.stringify(reg, null, 2));

  const { base, deck } = await startAuthor(t, h);
  const j = await (await fetch(`${base}/edit/theme/browse`)).json();
  assert.ok(j.stale.includes('nord-pack'), 'reported as needing an update, honestly');
  assert.ok(!j.themes.some((x) => x.marketplace === 'nord-pack'), 'and offered as nothing');

  const before = readFileSync(deck, 'utf8');
  const r = await mark(base, 'nord-deep@nord-pack');
  assert.equal(r.status, 409, 'and asking for one anyway is refused by name');
  assert.match((await r.json()).error, /marketplace update nord-pack/);
  assert.equal(readFileSync(deck, 'utf8'), before, 'byte-for-byte unchanged');
});

// ── what marking does ──────────────────────────────────────────────────────

const mark = (base, ref, marked = true) => fetch(`${base}/edit/theme/mark`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(ref === undefined ? {} : { ref, marked }),
});
const config = (html) => JSON.parse(html.match(/data-decklight-config>([\s\S]*?)<\/script>/)[1]);

test('marking records a reference in the config block — never the CSS — as one undo entry', async (t) => {
  const { base, deck } = await startAuthor(t, home(marketplace()));
  const before = readFileSync(deck, 'utf8');

  const r = await mark(base, 'nord-deep@nord-pack');
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.changed, true);
  assert.ok(j.undo >= 1, 'Z takes it back like any other edit');

  const after = readFileSync(deck, 'utf8');
  assert.deepEqual(config(after).addedThemes, ['nord-deep@nord-pack']);
  assert.doesNotMatch(after, /<style|--bg|--d-fill/, 'no stylesheet went into the deck');
  assert.equal(after.replace(/data-decklight-config>[\s\S]*?<\/script>/, ''),
    before.replace(/data-decklight-config>[\s\S]*?<\/script>/, ''), 'and nothing but the block changed');

  const listed = await (await fetch(`${base}/edit/theme/browse`)).json();
  assert.equal(listed.themes.find((x) => x.name === 'nord-deep').marked, true, 'the listing says so');
});

test('a marked theme is linked into the served page, from the marketplace on disk', async (t) => {
  const { base } = await startAuthor(t, home(marketplace()));
  await mark(base, 'nord-deep@nord-pack');

  const page = await (await fetch(`${base}/deck.html`)).text();
  const link = page.match(/<link[^>]*data-theme="nord-deep"[^>]*>/)?.[0];
  assert.ok(link, 'the picker finds it as an added theme');
  assert.match(link, /data-theme-added/);
  assert.match(link, /data-theme-marketplace="nord-pack"/, 'under its marketplace heading');
  assert.match(link, /media="not all"/, 'and off until chosen');
  assert.match(page, /<link rel="stylesheet" href="themes\/aurora\.css">/, 'the base theme is still linked');

  const href = link.match(/href="([^"]+)"/)[1];
  const css = await fetch(`${base}/${href}`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal(await css.text(), readFileSync(path.join(ROOT, 'themes/aurora.css'), 'utf8'));
});

test('marking from the overlay records where the marketplace comes from', async (t) => {
  // Stand up a marketplace as though cloned from a repo: its checkout where
  // `marketplace add` puts one, its source a repo — no network needed.
  const repo = marketplace();
  const h = home(repo);
  cpSync(repo, path.join(h, 'marketplaces', 'nord-pack'), { recursive: true });
  const regPath = path.join(h, 'marketplaces.json');
  const reg = JSON.parse(readFileSync(regPath, 'utf8'));
  reg.marketplaces['nord-pack'].source = 'https://x-access-token:ghp_secret@github.com/nord/pack.git';
  writeFileSync(regPath, JSON.stringify(reg));

  const { base, deck } = await startAuthor(t, h);
  assert.equal((await mark(base, 'nord-deep@nord-pack')).status, 200);
  const cfg = config(readFileSync(deck, 'utf8'));
  assert.deepEqual(cfg.themeSources, { 'nord-pack': 'nord/pack' }, 'as marketplace add takes it, the token gone');
  assert.doesNotMatch(readFileSync(deck, 'utf8'), /ghp_secret/);

  assert.equal((await mark(base, 'nord-deep@nord-pack', false)).status, 200);
  assert.equal(config(readFileSync(deck, 'utf8')).themeSources, undefined, 'and it leaves with the last theme');
});

test('a theme the command line would refuse is refused here too, deck untouched', async (t) => {
  // Same validator, same gates. A picker that could leave a deck carrying a
  // broken theme would be worse than no picker.
  const { base, deck } = await startAuthor(t, home(marketplace()));
  const before = readFileSync(deck, 'utf8');

  const r = await mark(base, 'broken@nord-pack');
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
    ['ghost@nord-pack', 404, /"ghost" is not in nord-pack/],
    ['nord-deep@nowhere', 404, /"nowhere" is not registered/],
    ['marp@nord-pack', 400, /is a importer, not a theme/],
    ['../../etc/passwd@nord-pack', 400, /which theme/],
    [undefined, 400, /which theme/],
  ];
  for (const [ref, status, re] of cases) {
    const r = await mark(base, ref);
    assert.equal(r.status, status, String(ref));
    assert.match((await r.json()).error, re, String(ref));
  }
  assert.equal(readFileSync(deck, 'utf8'), before, 'nothing was written on any of them');
});

test('marking twice is one reference; unmarking takes it out; the theme the deck opens on stays', async (t) => {
  const { base, deck } = await startAuthor(t, home(marketplace()));
  await mark(base, 'nord-deep@nord-pack');
  const again = await (await mark(base, 'nord-deep@nord-pack')).json();
  assert.equal(again.changed, false, 'marked already — nothing to write');
  assert.deepEqual(config(readFileSync(deck, 'utf8')).addedThemes, ['nord-deep@nord-pack']);

  // the deck opens on it: unmarking would leave it opening on nothing
  writeFileSync(deck, readFileSync(deck, 'utf8').replace('"theme": "aurora"', '"theme": "nord-deep"'));
  const refused = await mark(base, 'nord-deep@nord-pack', false);
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /the theme the deck opens on/);

  writeFileSync(deck, readFileSync(deck, 'utf8').replace('"theme": "nord-deep"', '"theme": "aurora"'));
  const off = await mark(base, 'nord-deep@nord-pack', false);
  assert.equal(off.status, 200);
  assert.equal(config(readFileSync(deck, 'utf8')).addedThemes, undefined, 'an empty list leaves no key behind');
});

test('a hand-written deck with no configuration block is told how to get one', async (t) => {
  const { base, deck } = await startAuthor(t, home(marketplace()), { deck: HAND_WRITTEN });
  const r = await mark(base, 'nord-deep@nord-pack');
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /upgrade --link/);
  assert.equal(readFileSync(deck, 'utf8'), HAND_WRITTEN);
});

test('an entry whose bytes live at a URL is read when marked, and served from the kept copy after', async (t) => {
  // The one kind of entry that is not a file in its marketplace's checkout.
  // Marking is the explicit act that may read it; every server after that
  // links the kept copy and never the URL.
  let hits = 0;
  const css = readFileSync(path.join(ROOT, 'themes/fjord.css'), 'utf8');
  const origin = createServer((req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/css' }); res.end(css); });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  t.after(() => origin.close());
  const url = `http://127.0.0.1:${origin.address().port}/gist/remote.css`;
  const { base } = await startAuthor(t, home(marketplace({ extra: [{ name: 'remote', type: 'theme', source: url }] })));

  const listed = (await (await fetch(`${base}/edit/theme/browse`)).json()).themes.find((x) => x.name === 'remote');
  assert.equal(listed.remote, true, 'listed, and flagged as not on this machine yet');
  assert.equal(hits, 0, 'listing read nothing');

  assert.equal((await mark(base, 'remote@nord-pack')).status, 200);
  assert.equal(hits, 1, 'marking read it once');
  origin.close();

  const page = await (await fetch(`${base}/deck.html`)).text();
  const href = page.match(/<link[^>]*data-theme="remote"[^>]*href="([^"]+)"|<link[^>]*href="([^"]+)"[^>]*data-theme="remote"/);
  const served = await fetch(`${base}/${href[1] ?? href[2]}`);
  assert.equal(await served.text(), css, 'served from the kept copy, with the origin gone');
});

test('exporting in an unmarked marketplace theme asks first, naming it', async (t) => {
  // A file handed over in a theme the deck does not carry would be a file the
  // deck itself cannot reproduce. The card arms on this answer; marking is
  // the next press.
  const { base, deck } = await startAuthor(t, home(marketplace()));
  const before = readFileSync(deck, 'utf8');
  const r = await fetch(`${base}/edit/export`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'pdf', theme: 'nord-deep' }),
  });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).unmarked, 'nord-deep@nord-pack');
  assert.equal(readFileSync(deck, 'utf8'), before, 'asking writes nothing');
});

// ── author mode only ───────────────────────────────────────────────────────

test('present has no browse or mark surface at all', async () => {
  const src = readFileSync(path.join(ROOT, 'cli/present.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /theme\/browse|theme\/add|theme\/mark|setMarked/,
    'marking is a deck edit, and the read-only viewer performs none');
});

test('the player reaches the author server for this and nowhere else', () => {
  // The invariant the listing exists under: a deck never fetches a theme
  // itself. Listing and marking are both requests to the author server, which
  // is the only party allowed to touch a marketplace — so nothing in the
  // picker may name a host, and a manifest's `source` must never reach the
  // player at all.
  const src = readFileSync(path.join(ROOT, 'src/core/themes.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const urls = code.match(/https?:\/\/[^'"`\s]+/g) ?? [];
  assert.deepEqual(urls, [], 'the picker addresses the author server by path, never by origin');

  // Every request it makes is built the same way: the author server's own
  // origin plus a literal path. Nothing a catalog supplied can become a URL
  // here, which is what keeps a manifest's `source` the server's to resolve.
  const fetches = [...code.matchAll(/fetch\(([^\n]*)/g)].map((m) => m[1].trim());
  assert.equal(fetches.length, 2, 'listing and marking, and no third request');
  for (const arg of fetches) {
    assert.match(arg, /^authorBase\(\) \+ '\/edit\//, `built from a literal path: ${arg}`);
  }

  const routes = [...code.matchAll(/'(\/edit\/[^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(routes)].sort(), ['/edit/theme/browse', '/edit/theme/mark'],
    'and it uses exactly the two routes the listing is made of');

  // A theme it looks at is linked by a RELATIVE path built from two names —
  // the same one the server writes for a marked theme — and both names are
  // checked against the one shape a marketplace or theme name can have.
  assert.match(code, /el\.href = `decklight-theme\/\$\{marketplace\}\/\$\{name\}\.css`/);
  assert.match(code, /if \(!\/\^\[\\w-\]\+\$\/\.test\(name \?\? ''\) \|\| !\/\^\[\\w-\]\+\$\/\.test\(marketplace \?\? ''\)\) return null;/);
});
