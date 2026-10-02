// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck references a design system, and every server serves it (SPEC
// DESIGN_SYSTEMS, #622): the reference in the config block and its shared
// source, resolution from the checkouts only, the injection every server
// makes, the package's files under decklight-design-system/ — held tight, one
// 404 for every refusal — the CLI, and the author route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, appendFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch, stop } from './helpers.mjs';
import {
  resolveDesignSystemRef, linkDesignSystems, designSystemAsset, setDesignSystem, designSystemRefs,
  marketplaceDesignSystems,
} from '../cli/design-system-refs.mjs';
import { setMarked } from '../cli/theme-refs.mjs';
import { staticFiles } from '../cli/serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const EDIT = path.join(ROOT, 'cli/edit.mjs');
const OK = path.join(here, 'fixtures', 'design-systems', 'ok');
const AURORA = readFileSync(path.join(ROOT, 'themes/aurora.css'), 'utf8');

/**
 * A home with `acme-mkt` registered from a local directory holding the
 * fixture package (`acme`), a theme (`nord`), one design system too new for
 * this decklight, and one whose source is a URL.
 */
function home(t, { extra = [] } = {}) {
  const dir = scratch('ds-refs', t);
  const h = path.join(dir, 'home');
  const repo = path.join(dir, 'mkt');
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  mkdirSync(path.join(repo, 'themes'), { recursive: true });
  cpSync(OK, path.join(repo, 'systems', 'acme'), { recursive: true });
  writeFileSync(path.join(repo, 'themes/nord.css'), AURORA);
  writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({
    name: 'acme-mkt', title: 'Acme', entries: [
      { name: 'acme', type: 'design-system', source: 'systems/acme', version: '1.2.0', apiVersion: 1, description: 'Acme Brand' },
      { name: 'future', type: 'design-system', source: 'systems/acme', apiVersion: 99 },
      { name: 'nord', type: 'theme', source: './themes/nord.css' },
      ...extra,
    ],
  }));
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], { env: { ...process.env, DECKLIGHT_HOME: h }, stdio: 'ignore' });
  return { dir, home: h, repo, pkg: path.join(repo, 'systems', 'acme') };
}

/** Re-register `acme-mkt` as though cloned from a remote, so its source is portable and recorded. */
function asRemote(h, repo, source = 'acme/decklight-marketplace') {
  cpSync(repo, path.join(h, 'marketplaces', 'acme-mkt'), { recursive: true });
  const regPath = path.join(h, 'marketplaces.json');
  const reg = JSON.parse(readFileSync(regPath, 'utf8'));
  reg.marketplaces['acme-mkt'].source = source;
  writeFileSync(regPath, JSON.stringify(reg));
  return path.join(h, 'marketplaces', 'acme-mkt', 'systems', 'acme');
}

const deck = (cfg) => '<!doctype html><html><head><title>T</title>\n'
  + `<script type="application/json" data-decklight-config>${JSON.stringify(cfg)}</script>\n`
  + '</head><body><div class="decklight"><section>a</section></div></body></html>';
const config = (html) => JSON.parse(html.match(/data-decklight-config>([\s\S]*?)<\/script>/)[1]);

// ── resolving ─────────────────────────────────────────────────────────────

test('a reference resolves to its package directory, or says why it cannot — and never by a fetch', (t) => {
  const { home: h, pkg } = home(t);
  const hit = resolveDesignSystemRef('acme@acme-mkt', h);
  assert.equal(hit.dir, path.resolve(pkg));
  assert.equal(hit.entry.version, '1.2.0');
  assert.match(resolveDesignSystemRef('nord@acme-mkt', h).missing, /is a theme, not a design system/);
  assert.match(resolveDesignSystemRef('future@acme-mkt', h).missing, /needs a newer decklight — it is written for design-system format 99/);
  assert.match(resolveDesignSystemRef('acme@elsewhere', h).missing, /not registered on this machine/);
  assert.match(resolveDesignSystemRef('nope', h).missing, /not a design-system reference/);
});

test('the catalog listing: every design system on offer, the ones this machine cannot use named', (t) => {
  const { home: h } = home(t);
  const { systems, stale, unfetched } = marketplaceDesignSystems(h);
  assert.deepEqual(systems.map((s) => s.qualified), ['acme@acme-mkt', 'future@acme-mkt']);
  assert.equal(systems[0].group, 'Acme');
  assert.match(systems[1].missing, /needs a newer decklight/);
  assert.ok(unfetched.includes('decklight'), 'the first-party catalog, registered not fetched, is named as not fetched yet');
  assert.ok(!stale.includes('decklight'), '— not as a catalog that could not be read');
  // a cached catalog that no longer validates is the one that is stale
  writeFileSync(path.join(h, 'marketplaces', 'acme-mkt.json'), '{ not json');
  const broken = marketplaceDesignSystems(h);
  assert.deepEqual([broken.stale, broken.systems.length], [['acme-mkt'], 0]);
});

// ── injection ─────────────────────────────────────────────────────────────

test('every server injects the stylesheet (always on), the meta and the layouts — after the themes, once', (t) => {
  const { home: h } = home(t);
  const html = deck({ decklight: '0.9.0', theme: 'aurora', designSystems: ['acme@acme-mkt'] });
  const out = linkDesignSystems(html, h);
  const link = out.match(/<link[^>]*data-design-system="acme"[^>]*>/)?.[0];
  assert.equal(link, '<link rel="stylesheet" href="decklight-design-system/acme-mkt/acme/design-system.css" data-design-system="acme">');
  assert.doesNotMatch(link, /media=/, 'always on — not an alternative to choose');
  const meta = JSON.parse(out.match(/<script type="application\/json" data-design-system-meta="acme">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual({ name: meta.name, version: meta.version, title: meta.title }, { name: 'acme', version: '1.2.0', title: 'Acme Brand' });
  assert.deepEqual(meta.palette.map((p) => p.token), ['--acme-blue', '--acme-coral', '--acme-ink']);
  assert.deepEqual(meta.layouts.map((l) => l.id), ['section-divider', 'statement']);
  assert.deepEqual(meta.layouts[0].slots.find((s) => s.name === 'title'), { name: 'title', hint: 'h1,h2', required: true, default: false });
  assert.match(out, /<template data-design-system-layouts="acme">\s*<!-- Acme Brand layouts[\s\S]*<template data-layout="statement"[\s\S]*<\/template>\s*<\/template>/);
  assert.ok(out.indexOf('data-design-system="acme"') < out.indexOf('</head>'), 'in the head');
  assert.equal(linkDesignSystems(out, h), out, 'idempotent: a page that has it is left alone');
});

test('a bundle\'s own copy wins; no reference serves byte-identically; an unresolvable one is named', (t) => {
  const { home: h } = home(t);
  const carried = deck({ decklight: '0.9.0', designSystems: ['acme@acme-mkt'] })
    .replace('</head>', '<style data-design-system="acme">.x{}</style></head>');
  assert.equal(linkDesignSystems(carried, h), carried);
  const plain = deck({ decklight: '0.9.0', theme: 'aurora' });
  assert.equal(linkDesignSystems(plain, h), plain);
  const logged = [];
  const out = linkDesignSystems(deck({ decklight: '0.9.0', designSystems: ['future@acme-mkt', 'gone@acme-mkt'] }), h, { log: (m) => logged.push(m) });
  assert.match(out, /<meta name="decklight-design-system-missing" content="future@acme-mkt — future@acme-mkt needs a newer decklight/);
  assert.match(out, /<meta name="decklight-design-system-missing" content="gone@acme-mkt — &quot;gone&quot; is not in acme-mkt any more">/);
  assert.equal(logged.length, 2);
  assert.doesNotMatch(out, /<link[^>]*data-design-system/);
});

test('a package changed after it was added is re-checked where it is used — and refused if it no longer passes', (t) => {
  const { home: h, pkg } = home(t);
  const html = deck({ decklight: '0.9.0', designSystems: ['acme@acme-mkt'] });
  assert.match(linkDesignSystems(html, h), /<link[^>]*data-design-system="acme"/);
  appendFileSync(path.join(pkg, 'layouts.html'), '\n<template data-layout="evil"><img src="x" onerror="alert(1)"></template>\n');
  const out = linkDesignSystems(html, h);
  assert.doesNotMatch(out, /onerror/, 'the unsafe layout never reaches the page');
  assert.match(out, /decklight-design-system-missing" content="acme@acme-mkt — it no longer passes the design-system check — layouts\.html line \d+/);
  assert.equal(designSystemAsset('decklight-design-system/acme-mkt/acme/assets/divider.svg', h), null, 'and none of its files are served');
});

// ── the config block, and the shared source ─────────────────────────────────

test('a reference and its source are one edit; the source goes with the last mark of EITHER kind', () => {
  const html = deck({ decklight: '0.9.0', theme: 'aurora', markedThemes: ['nord@acme-mkt'], themeSources: { 'acme-mkt': 'acme/decklight-marketplace' } });
  const used = setDesignSystem(html, 'acme@acme-mkt', true, { source: 'acme/decklight-marketplace' });
  assert.deepEqual(config(used.html).designSystems, ['acme@acme-mkt']);
  assert.deepEqual(config(used.html).themeSources, { 'acme-mkt': 'acme/decklight-marketplace' }, 'shared, not duplicated');
  assert.equal(setDesignSystem(used.html, 'acme@acme-mkt', true).changed, false, 'idempotent');
  // unmarking the theme keeps the source the design system still needs…
  const themeGone = setMarked(used.html, 'nord@acme-mkt', false);
  assert.deepEqual(config(themeGone.html).themeSources, { 'acme-mkt': 'acme/decklight-marketplace' });
  // …and dropping the design system, now the last mark, takes it
  const allGone = setDesignSystem(themeGone.html, 'acme@acme-mkt', false);
  assert.equal(config(allGone.html).themeSources, undefined);
  assert.equal(config(allGone.html).designSystems, undefined);
  // the other way round: dropping the design system keeps a theme's source
  const dsGone = setDesignSystem(used.html, 'acme@acme-mkt', false);
  assert.deepEqual(config(dsGone.html).themeSources, { 'acme-mkt': 'acme/decklight-marketplace' });
  assert.throws(() => setDesignSystem(used.html, 'acme@other', true), /two design systems called "acme"/);
  assert.throws(() => setDesignSystem(used.html, 'acme', true), /not a design-system reference/);
  assert.deepEqual(designSystemRefs(deck({ designSystems: ['acme@acme-mkt', 'acme@acme-mkt', 'bad ref', 7] })).map((r) => r.ref), ['acme@acme-mkt']);
});

// ── serving the package ───────────────────────────────────────────────────

test('the package\'s files: plain segments, allowlisted, inside the package — fixed MIME, nosniff, script-free SVG', (t) => {
  const { home: h, pkg } = home(t);
  const at = (p) => designSystemAsset(`decklight-design-system/acme-mkt/acme/${p}`, h);
  assert.deepEqual(at('design-system.css').type, 'text/css; charset=utf-8');
  const svg = at('assets/divider.svg');
  assert.equal(svg.type, 'image/svg+xml');
  assert.deepEqual(svg.headers, { 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
  assert.equal(at('assets/fonts/acme-sans.woff2').type, 'font/woff2');
  assert.deepEqual(at('assets/fonts/acme-sans.woff2').headers, { 'x-content-type-options': 'nosniff' });
  for (const refused of ['layouts.html', 'design-system.json', 'README.md', 'assets/x.js', 'assets/../design-system.css',
    '.git/config', 'assets/.hidden.svg', 'assets/missing.svg', 'other.css', 'assets/a b.svg']) {
    assert.equal(at(refused), null, refused);
  }
  assert.equal(designSystemAsset('decklight-design-system/acme-mkt/nope/design-system.css', h), null);
  assert.equal(designSystemAsset('decklight-design-system/acme-mkt/future/design-system.css', h), null, 'too new: unresolvable');
  if (process.platform !== 'win32') {
    writeFileSync(path.join(path.dirname(pkg), 'secret.svg'), '<svg/>');
    symlinkSync(path.join(path.dirname(pkg), 'secret.svg'), path.join(pkg, 'assets', 'link.svg'));
    assert.equal(at('assets/link.svg'), null, 'a symlink cannot reach out — and the package now fails its check');
  }
});

test('served: the namespace is terminal — every refusal is the same 404 a missing path gets', async (t) => {
  const { dir, home: h } = home(t);
  process.env.DECKLIGHT_HOME = h;
  t.after(() => { delete process.env.DECKLIGHT_HOME; });
  const site = path.join(dir, 'site');
  mkdirSync(path.join(site, 'decklight-design-system', 'acme-mkt', 'acme'), { recursive: true });
  // a file a deck folder happens to hold at the same path is never what answers
  writeFileSync(path.join(site, 'decklight-design-system', 'acme-mkt', 'acme', 'evil.js'), 'alert(1)');
  writeFileSync(path.join(site, 'deck.html'), deck({ decklight: '0.9.0', designSystems: ['acme@acme-mkt'] }));
  const handler = staticFiles(site, { index: '/deck.html' });
  const server = createServer((req, res) => handler(req, res, new URL(req.url, 'http://x')) || (res.writeHead(404), res.end()));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /<link rel="stylesheet" href="decklight-design-system\/acme-mkt\/acme\/design-system.css" data-design-system="acme">/);
  const svg = await fetch(`${base}/decklight-design-system/acme-mkt/acme/assets/divider.svg`);
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'");
  assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
  for (const p of ['acme/evil.js', 'acme/.git/config', 'acme/layouts.html', 'acme/%2e%2e/%2e%2e/deck.html', 'nope/design-system.css']) {
    const r = await fetch(`${base}/decklight-design-system/acme-mkt/${p}`);
    assert.equal(r.status, 404, p);
    assert.equal(await r.text(), 'not found', `${p}: indistinguishable`);
  }
});

// ── the command ────────────────────────────────────────────────────────────

const cli = (h, ...args) => spawnSync(process.execPath, [CLI, 'design-system', ...args], { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: h } });

test('design-system add: the check first, then one edit and a ledger record; remove drops it; list and layouts say what there is', (t) => {
  const { dir, home: h, repo } = home(t);
  asRemote(h, repo);
  const deckPath = path.join(dir, 'talk.html');
  writeFileSync(deckPath, deck({ decklight: '0.9.0', theme: 'aurora' }));
  const add = cli(h, 'add', 'acme@acme-mkt', deckPath);
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /now uses acme@acme-mkt 1\.2\.0 — Acme Brand/);
  const cfg = config(readFileSync(deckPath, 'utf8'));
  assert.deepEqual(cfg.designSystems, ['acme@acme-mkt']);
  assert.deepEqual(cfg.themeSources, { 'acme-mkt': 'acme/decklight-marketplace' });
  const ledger = JSON.parse(readFileSync(path.join(h, 'installed.json'), 'utf8')).installs['design-system:acme@acme-mkt'];
  assert.equal(ledger.version, '1.2.0');
  assert.match(cli(h, 'list', deckPath).stdout, /^acme@acme-mkt {2}1\.2\.0 {2}— Acme$/m);
  assert.match(cli(h, 'list').stdout, /^acme@acme-mkt {2}1\.2\.0 — Acme Brand$/m);
  const layouts = cli(h, 'layouts', 'acme@acme-mkt');
  assert.match(layouts.stdout, /acme\/section-divider — Section divider\n {4}kicker {2}— p\n {4}title \(required\) {2}— h1,h2/);
  const remove = cli(h, 'remove', 'acme@acme-mkt', deckPath);
  assert.equal(remove.status, 0, remove.stderr);
  const after = config(readFileSync(deckPath, 'utf8'));
  assert.equal(after.designSystems, undefined);
  assert.equal(after.themeSources, undefined, 'the last mark took its source');
});

test('design-system add refuses a package that fails the check, leaving the deck byte-for-byte as it was', (t) => {
  const { dir, home: h, pkg } = home(t);
  appendFileSync(path.join(pkg, 'design-system.css'), '\n@import url(https://evil.example/x.css);\n');
  const deckPath = path.join(dir, 'talk.html');
  const before = deck({ decklight: '0.9.0', theme: 'aurora' });
  writeFileSync(deckPath, before);
  const r = cli(h, 'add', 'acme@acme-mkt', deckPath);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /@import is refused/);
  assert.match(r.stderr, /acme@acme-mkt was NOT referenced/);
  assert.equal(readFileSync(deckPath, 'utf8'), before);
  assert.match(cli(h, 'add', 'future@acme-mkt', deckPath).stderr, /needs a newer decklight/);
  assert.match(cli(h, 'add', 'nord@acme-mkt', deckPath).stderr, /is a theme, not a design system/);
});

// ── author mode ────────────────────────────────────────────────────────────

async function startAuthor(t, h, body) {
  const dir = scratch('ds-author', t);
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
  return { base, deck: path.join(dir, 'deck.html') };
}
const post = (base, route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('author: browse lists what is on offer and what the deck uses; mark references it as one undo entry', async (t) => {
  const { home: h } = home(t);
  const { base, deck: deckPath } = await startAuthor(t, h, deck({ decklight: '0.9.0', theme: 'aurora' }));
  const before = readFileSync(deckPath, 'utf8');
  let j = await (await fetch(`${base}/edit/design-system/browse`)).json();
  assert.deepEqual(j.systems.map((s) => [s.qualified, s.used]), [['acme@acme-mkt', false], ['future@acme-mkt', false]]);
  const r = await post(base, '/edit/design-system/mark', { ref: 'acme@acme-mkt', used: true });
  const k = await r.json();
  assert.equal(r.status, 200, JSON.stringify(k));
  assert.deepEqual({ ref: k.ref, used: k.used, changed: k.changed }, { ref: 'acme@acme-mkt', used: true, changed: true });
  assert.deepEqual(config(readFileSync(deckPath, 'utf8')).designSystems, ['acme@acme-mkt']);
  j = await (await fetch(`${base}/edit/design-system/browse`)).json();
  assert.equal(j.systems.find((s) => s.qualified === 'acme@acme-mkt').used, true);
  // the served page now carries it
  assert.match(await (await fetch(`${base}/`)).text(), /data-design-system-meta="acme"/);
  await post(base, '/edit/undo', {});
  assert.equal(readFileSync(deckPath, 'utf8'), before, 'Z takes it back');
  assert.equal((await post(base, '/edit/design-system/mark', { ref: 'future@acme-mkt' })).status, 409);
  assert.equal((await post(base, '/edit/design-system/mark', { ref: 'nord@acme-mkt' })).status, 400);
  assert.equal((await post(base, '/edit/design-system/mark', { ref: 'nope@acme-mkt' })).status, 404);
  assert.equal((await post(base, '/edit/design-system/mark', { ref: 'nope' })).status, 400);
  assert.equal(readFileSync(deckPath, 'utf8'), before, 'every refusal leaves the deck as it was');
});
