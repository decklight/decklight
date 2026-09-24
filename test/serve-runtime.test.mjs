// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck that LINKS the runtime instead of carrying it (#517): every server
// answers `decklight.js`, `decklight.css` and `themes/<name>.css` from the
// installed package when nothing is on disk — and nothing else changes: a copy
// beside the deck still wins, any other missing file is still a 404, a dotted
// path is still a 403.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers.mjs';
import { staticFiles } from '../cli/serve.mjs';
import { PKG_ROOT, packageAsset } from '../cli/pkg.mjs';

const DECK = '<!doctype html><link rel="stylesheet" href="decklight.css"><link rel="stylesheet" href="themes/midnight.css">'
  + '<div class="decklight"><section><h1>linked</h1></section></div><script src="decklight.js"></script><script>Decklight.init({})</script>\n';

async function served(t, { knownTypesOnly = false, sibling = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-linked-'));
  t.after(() => rmTemp(dir));
  fs.writeFileSync(path.join(dir, 'deck.html'), DECK);
  if (sibling) fs.writeFileSync(path.join(dir, 'decklight.js'), sibling);
  const files = staticFiles(dir, { index: '/deck.html', knownTypesOnly });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!files(req, res, url)) { res.writeHead(405); res.end(); }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  return { dir, base: `http://127.0.0.1:${server.address().port}` };
}
const installed = (rel) => fs.readFileSync(path.join(PKG_ROOT, rel), 'utf8');

test('packageAsset: the three shapes a deck links, matched on the path’s tail, and nothing else', () => {
  assert.equal(packageAsset('/decklight.js').file, path.join(PKG_ROOT, 'dist', 'decklight.js'));
  assert.equal(packageAsset('/slides/q3/decklight.css').file, path.join(PKG_ROOT, 'dist', 'decklight.css'));
  assert.equal(packageAsset('/dist/decklight.js').file, path.join(PKG_ROOT, 'dist', 'decklight.js'), 'a source deck reaching ../dist');
  assert.equal(packageAsset('/themes/midnight.css').file, path.join(PKG_ROOT, 'themes', 'midnight.css'));
  assert.equal(packageAsset('/themes/nope.css'), null, 'a theme that is not shipped is a missing file');
  assert.equal(packageAsset('/other.js'), null);
  assert.equal(packageAsset('/decklight.js.map'), null);
  assert.equal(packageAsset('/mythemes/midnight.css'), null, 'only a themes/ directory, not any name ending so');
});

test('a linked deck is served whole: the runtime, its stylesheet and its theme come from the installed package', async (t) => {
  const { base } = await served(t);
  const js = await fetch(`${base}/decklight.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal(await js.text(), installed('dist/decklight.js'), 'byte for byte the installed build');
  const css = await fetch(`${base}/decklight.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.equal(await css.text(), installed('dist/decklight.css'));
  const theme = await fetch(`${base}/themes/midnight.css`);
  assert.equal(theme.status, 200);
  assert.equal(await theme.text(), installed('themes/midnight.css'));
  // the shape every source deck in this repository uses: the browser resolves
  // `../dist/decklight.js` against `/deck.html` to `/dist/decklight.js`
  assert.equal((await fetch(`${base}/dist/decklight.js`)).status, 200);
  // and the deck itself is untouched — it still says what it linked
  assert.match(await (await fetch(`${base}/`)).text(), /<script src="decklight\.js">/);
});

test('nothing else changes: other missing files 404, dotted paths 403, an unshipped theme 404', async (t) => {
  const { base } = await served(t);
  assert.equal((await fetch(`${base}/other.js`)).status, 404);
  assert.equal((await fetch(`${base}/themes/nope.css`)).status, 404);
  // a dotted path that is not there stays a plain 404 (a probe learns nothing) —
  // what matters is that the fallback never answered it
  const dotted = await fetch(`${base}/.hidden/decklight.js`);
  assert.equal(dotted.status, 404);
  assert.doesNotMatch(await dotted.text(), /Decklight/, 'no runtime through a dotted path');
  assert.equal((await fetch(`${base}/decklight.js.map`)).status, 404, 'the source map does not travel');
});

test('a copy beside the deck wins over the package — an author pinning their own build is honoured', async (t) => {
  const { base } = await served(t, { sibling: 'window.Decklight = { pinned: true };\n' });
  assert.equal(await (await fetch(`${base}/decklight.js`)).text(), 'window.Decklight = { pinned: true };\n');
});

test('present’s knownTypesOnly policy still lets the linked runtime through', async (t) => {
  const { base } = await served(t, { knownTypesOnly: true });
  assert.equal((await fetch(`${base}/decklight.js`)).status, 200);
  assert.equal((await fetch(`${base}/themes/midnight.css`)).status, 200);
});

// ── a deck as data (#520): the server references the runtime on the way out ──
const DATA_DECK = '<!doctype html><html><head><meta charset="utf-8"><title>d</title>\n'
  + '<script type="application/json" data-decklight-config>{ "decklight": "0.8.1", "theme": "midnight" }</script>\n'
  + '</head><body><div class="decklight"><section><h1>data</h1></section></div>\n</body></html>\n';

test('a deck that carries no runtime is served with the engine, its stylesheet and its theme referenced — and the file untouched', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-data-'));
  t.after(() => rmTemp(dir));
  fs.writeFileSync(path.join(dir, 'deck.html'), DATA_DECK);
  fs.writeFileSync(path.join(dir, 'other.html'), '<!doctype html><h1>not a deck</h1><script>1</script>');
  const files = staticFiles(dir, { index: '/deck.html', html: (txt) => txt.replace('</body>', '<script>window.probe = 1</script></body>') });
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!files(req, res, url)) { res.writeHead(405); res.end(); }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /<link rel="stylesheet" href="decklight\.css" data-decklight-runtime="css">\n<link rel="stylesheet" href="themes\/midnight\.css">\n<\/head>/, 'the stylesheet and the block’s theme, at the end of head');
  assert.match(page, /<script src="decklight\.js" data-decklight-runtime="js"><\/script>\n<script>window\.probe = 1<\/script>/, 'the engine goes in front of the first script that executes — the caller’s rewrite ran first');
  assert.equal((page.match(/decklight\.js/g) || []).length, 1, 'once');
  assert.equal(fs.readFileSync(path.join(dir, 'deck.html'), 'utf8'), DATA_DECK, 'the file is what it was');
  // the references it now carries are answered from the package
  assert.equal(await (await fetch(`${base}/decklight.js`)).text(), installed('dist/decklight.js'));
  assert.equal(await (await fetch(`${base}/themes/midnight.css`)).text(), installed('themes/midnight.css'));
  // a page that is not a deck is left alone; so is a deck that brought its own
  assert.doesNotMatch(await (await fetch(`${base}/other.html`)).text(), /decklight\.js/);
  const linked = await (await fetch(`${base}/`)).text();
  fs.writeFileSync(path.join(dir, 'deck.html'), linked);
  assert.equal(await (await fetch(`${base}/`)).text(), linked.replace('</body>', '<script>window.probe = 1</script></body>').replace('<script>window.probe = 1</script>\n<script>window.probe = 1</script>', '<script>window.probe = 1</script>'), 'idempotent: a linked deck passes through');
});

test('a data deck carrying a theme `theme add` pasted in keeps its own theme — served and bundled', async () => {
  // Before 0.9.0, `theme add` pasted a theme into the deck as a
  // <style data-theme-added> block. That block is an EXTRA over the deck's
  // base theme, never the base itself: taken for one, a served data deck got
  // no theme link at all, and a bundle carried somebody else's theme as its
  // only one.
  const { linkRuntime } = await import('../cli/runtime-link.mjs');
  const { execFileSync } = await import('node:child_process');
  const deck = '<!doctype html><html><head><title>T</title>\n'
    + '<script type="application/json" data-decklight-config>{ "decklight": "0.9.0", "theme": "ember" }</script>\n'
    + '<style data-theme="nord-deep" data-theme-added media="not all">.decklight { --bg: #101018; }</style>\n'
    + '</head><body><div class="decklight"><section>a</section></div></body></html>';
  assert.match(linkRuntime(deck), /<link rel="stylesheet" href="themes\/ember\.css">/, 'served with its own theme linked');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-added-'));
  try {
    fs.writeFileSync(path.join(dir, 'deck.html'), deck);
    execFileSync(process.execPath, [path.join(PKG_ROOT, 'cli/decklight.mjs'), 'bundle', 'deck.html', '-o', 'out.html'],
      { cwd: dir, stdio: 'pipe' });
    const out = fs.readFileSync(path.join(dir, 'out.html'), 'utf8');
    assert.match(out, /<style data-theme="ember">/, 'bundled with its own theme, active');
    assert.match(out, /<style data-theme="nord-deep" data-theme-added media="not all">/, 'and the added one still an extra');
  } finally { rmTemp(dir); }
});
