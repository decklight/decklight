// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck references a font package, and every server serves its faces; a
// bundle carries them (SPEC FONTS): resolution from the checkouts only, the
// @font-face and meta every server injects, the faces under decklight-font/ —
// one 404 for every refusal — the shared themeSources, the CLI, bundle and
// the author routes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch, stop } from './helpers.mjs';
import { resolveFontRef, linkFonts, fontAsset, setFont, fontRefs, marketplaceFonts } from '../cli/font-refs.mjs';
import { setMarked } from '../cli/theme-refs.mjs';
import { setDesignSystem } from '../cli/design-system-refs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const EDIT = path.join(ROOT, 'cli/edit.mjs');
const OK = path.join(here, 'fixtures', 'fonts', 'ok');
const AURORA = readFileSync(path.join(ROOT, 'themes/aurora.css'), 'utf8');

/** A home with `type-mkt` registered from a local directory: the fixture font, a theme and a design system. */
function home(t) {
  const dir = scratch('font-refs', t);
  const h = path.join(dir, 'home');
  const repo = path.join(dir, 'mkt');
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  mkdirSync(path.join(repo, 'themes'), { recursive: true });
  cpSync(OK, path.join(repo, 'fonts', 'sample'), { recursive: true });
  cpSync(path.join(here, 'fixtures', 'design-systems', 'ok'), path.join(repo, 'systems', 'acme'), { recursive: true });
  writeFileSync(path.join(repo, 'themes/nord.css'), AURORA);
  writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({ name: 'type-mkt', title: 'Type', entries: [
    { name: 'sample', type: 'font', source: 'fonts/sample', version: '1.0.0', apiVersion: 1, description: 'A sample' },
    { name: 'acme', type: 'design-system', source: 'systems/acme', version: '1.2.0', apiVersion: 1 },
    { name: 'nord', type: 'theme', source: './themes/nord.css' },
  ] }));
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], { env: { ...process.env, DECKLIGHT_HOME: h }, stdio: 'ignore' });
  return { dir, home: h, repo, pkg: path.join(repo, 'fonts', 'sample') };
}

const deck = (cfg) => '<!doctype html><html><head><title>T</title>\n'
  + `<script type="application/json" data-decklight-config>${JSON.stringify(cfg)}</script>\n`
  + '</head><body><div class="decklight"><section>a</section></div></body></html>';
const config = (html) => JSON.parse(html.match(/data-decklight-config>([\s\S]*?)<\/script>/)[1]);

test('a font reference resolves to its package, or says why it cannot — and a design system is not a font', (t) => {
  const { home: h, pkg } = home(t);
  assert.equal(resolveFontRef('sample@type-mkt', h).dir, path.resolve(pkg));
  assert.match(resolveFontRef('acme@type-mkt', h).missing, /is a design-system, not a font/);
  assert.match(resolveFontRef('sample@nowhere', h).missing, /marketplace "nowhere" is not registered/);
  const { fonts, unfetched } = marketplaceFonts(h);
  assert.deepEqual(fonts.map((f) => [f.qualified, f.family]), [['sample@type-mkt', 'Decklight Sample']]);
  assert.deepEqual(fonts[0].faces.map((f) => f.url), ['decklight-font/type-mkt/sample/faces/sample-400.woff2', 'decklight-font/type-mkt/sample/faces/sample-700.woff2']);
  assert.ok(unfetched.includes('decklight'));
});

test('every server links the faces and the meta; a carried copy is not linked twice; a missing one is named', (t) => {
  const { home: h } = home(t);
  const out = linkFonts(deck({ decklight: '0.9.0', fonts: ['sample@type-mkt'] }), h);
  assert.match(out, /<style data-font="sample" data-font-version="1\.0\.0">\n@font-face \{ font-family: 'Decklight Sample'; src: url\("decklight-font\/type-mkt\/sample\/faces\/sample-400\.woff2"\)/);
  const meta = JSON.parse(out.match(/data-font-meta="sample">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(meta, { name: 'sample', title: 'Decklight Sample', family: 'Decklight Sample', fallback: 'system-ui, sans-serif', stack: "'Decklight Sample', system-ui, sans-serif", role: 'body', version: '1.0.0' });
  assert.equal(linkFonts(out, h), out, 'idempotent: the page already carries it');
  const gone = linkFonts(deck({ decklight: '0.9.0', fonts: ['sample@nowhere'] }), h);
  assert.match(gone, /<meta name="decklight-font-missing" content="sample@nowhere — marketplace &quot;nowhere&quot; is not registered/);
  const plain = deck({ decklight: '0.9.0' });
  assert.equal(linkFonts(plain, h), plain, 'no fonts, nothing touched');
});

test('the faces are served under decklight-font/ — only a face the manifest lists, from inside the package', (t) => {
  const { home: h, pkg } = home(t);
  const hit = fontAsset('decklight-font/type-mkt/sample/faces/sample-400.woff2', h);
  assert.equal(hit.file, realpathSync(path.join(pkg, 'faces/sample-400.woff2')));
  assert.equal(hit.type, 'font/woff2');
  assert.equal(hit.headers['x-content-type-options'], 'nosniff');
  for (const rel of ['decklight-font/type-mkt/sample/OFL.txt', 'decklight-font/type-mkt/sample/font.json',
    'decklight-font/type-mkt/sample/../acme/x.woff2', 'decklight-font/type-mkt/nope/faces/sample-400.woff2',
    'decklight-font/type-mkt/sample/faces/other.woff2', 'decklight-font/type-mkt/sample']) {
    assert.equal(fontAsset(rel, h), null, rel);
  }
});

test('the reference, the default and the shared source: --use makes it the deck font, the last of any kind takes the source', (t) => {
  const html = deck({ decklight: '0.9.0' });
  let r = setFont(html, 'sample@type-mkt', true, { source: 'acme/type', use: true });
  let c = config(r.html);
  assert.deepEqual([c.fonts, c.font, c.themeSources], [['sample@type-mkt'], 'sample', { 'type-mkt': 'acme/type' }]);
  // a theme and a design system from the same marketplace share the source
  r = setMarked(r.html, 'nord@type-mkt', true, { source: 'acme/type' });
  r = setDesignSystem(r.html, 'acme@type-mkt', true, { source: 'acme/type' });
  r = setFont(r.html, 'sample@type-mkt', false);
  c = config(r.html);
  assert.equal(c.fonts, undefined);
  assert.equal(c.font, undefined, 'dropping the default font drops the default');
  assert.deepEqual(c.themeSources, { 'type-mkt': 'acme/type' }, 'the theme and the design system still need it');
  r = setMarked(r.html, 'nord@type-mkt', false);
  assert.deepEqual(config(r.html).themeSources, { 'type-mkt': 'acme/type' }, 'the design system still needs it');
  r = setDesignSystem(r.html, 'acme@type-mkt', false);
  assert.equal(config(r.html).themeSources, undefined, 'gone with the last reference of any kind');
  assert.deepEqual(fontRefs(deck({ fonts: ['a@m', 'a@m', 'not a ref'] })).map((x) => x.ref), ['a@m']);
});

test('decklight font add --use / list / remove — the gate first, the deck byte-for-byte when refused', (t) => {
  const { dir, home: h, pkg } = home(t);
  const env = { ...process.env, DECKLIGHT_HOME: h };
  const deckPath = path.join(dir, 'talk.html');
  writeFileSync(deckPath, deck({ decklight: '0.9.0', theme: 'aurora' }));
  const cli = (...a) => spawnSync(process.execPath, [CLI, 'font', ...a], { encoding: 'utf8', env });
  let r = cli('add', 'sample', deckPath, '--use');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /now uses sample@type-mkt 1\.0\.0 — 'Decklight Sample', 2 faces, and opens in it/);
  assert.deepEqual([config(readFileSync(deckPath, 'utf8')).fonts, config(readFileSync(deckPath, 'utf8')).font], [['sample@type-mkt'], 'sample']);
  assert.match(cli('list', deckPath).stdout, /^sample@type-mkt {2}1\.0\.0 {2}— Type/m);
  assert.match(cli('list').stdout, /^sample@type-mkt {2}1\.0\.0 {2}'Decklight Sample' — A sample$/m);
  r = cli('remove', 'sample@type-mkt', deckPath);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(config(readFileSync(deckPath, 'utf8')).fonts, undefined);
  // a broken package is not referenced
  writeFileSync(path.join(pkg, 'faces/sample-700.woff2'), '<svg onload=alert(1)>');
  const before = readFileSync(deckPath, 'utf8');
  r = cli('add', 'sample@type-mkt', deckPath);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not a woff2 file/);
  assert.match(r.stderr, /was NOT referenced/);
  assert.equal(readFileSync(deckPath, 'utf8'), before);
});

test('bundle carries the faces as data: URIs, says so, and refuses — or, asked, leaves out — a font it cannot read', (t) => {
  const { dir, home: h } = home(t);
  const env = { ...process.env, DECKLIGHT_HOME: h };
  writeFileSync(path.join(dir, 'talk.html'), deck({ decklight: '0.9.0', theme: 'aurora', fonts: ['sample@type-mkt'], font: 'sample' }));
  const r = spawnSync(process.execPath, [CLI, 'bundle', 'talk.html'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}fonts {4}sample 1\.0\.0 \(from type-mkt\) — 'Decklight Sample', 2 faces \(0\.0 KB\)$/m);
  const out = readFileSync(path.join(dir, 'talk-standalone.html'), 'utf8');
  assert.match(out, /src: url\("data:font\/woff2;base64,d09GMg/);
  assert.doesNotMatch(out, /decklight-font\//);
  assert.ok(out.indexOf('data-font-meta="sample"') < out.indexOf('<script data-decklight-runtime="js">'), 'the meta before the engine reads it');
  assert.equal(linkFonts(out, h), out, 'a re-serve links no second copy');
  writeFileSync(path.join(dir, 'lost.html'), deck({ decklight: '0.9.0', theme: 'aurora', fonts: ['sample@nowhere'] }));
  const refused = spawnSync(process.execPath, [CLI, 'bundle', 'lost.html'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the deck uses the font sample@nowhere, and this machine cannot read it/);
  const allowed = spawnSync(process.execPath, [CLI, 'bundle', 'lost.html', '--allow-missing-fonts'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /note: font sample@nowhere not carried — .*the theme's own font stack shows instead/);
});

test('the author server: browse lists what is offered and used; mark references it (quietly), one undo', async (t) => {
  const { dir, home: h } = home(t);
  writeFileSync(path.join(dir, 'deck.html'), deck({ decklight: '0.9.0', theme: 'aurora' }));
  const proc = spawn(process.execPath, [EDIT, 'deck.html', '--port', '0', '--no-git'], { cwd: dir, env: { ...process.env, DECKLIGHT_HOME: h }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stop(proc));
  let log = '';
  proc.stdout.on('data', (c) => { log += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => { const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); } }, 25);
    setTimeout(() => { clearInterval(scan); reject(new Error(log)); }, 10000);
  });
  const browse = async () => (await (await fetch(`${base}/edit/font/browse`)).json());
  let b = await browse();
  assert.deepEqual(b.fonts.map((f) => [f.qualified, f.used]), [['sample@type-mkt', false]]);
  const face = await fetch(`${base}/${b.fonts[0].faces[0].url}`);
  assert.equal(face.status, 200, 'an offered font can be previewed before it is referenced');
  assert.equal(face.headers.get('content-type'), 'font/woff2');
  const mark = await (await fetch(`${base}/edit/font/mark`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: 'sample@type-mkt', used: true, quiet: true }) })).json();
  assert.equal(mark.ok, true, JSON.stringify(mark));
  assert.deepEqual(config(readFileSync(path.join(dir, 'deck.html'), 'utf8')).fonts, ['sample@type-mkt']);
  b = await browse();
  assert.equal(b.fonts[0].used, true);
  assert.match(await (await fetch(`${base}/deck.html`)).text(), /data-font-meta="sample"/, 'served with its faces linked');
  await fetch(`${base}/edit/undo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(config(readFileSync(path.join(dir, 'deck.html'), 'utf8')).fonts, undefined);
  assert.equal((await fetch(`${base}/edit/font/mark`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: 'acme@type-mkt' }) })).status, 400);
});
