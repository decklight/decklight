// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A bundle carries the deck's design systems (SPEC DESIGN_SYSTEMS, #625): the
// stylesheet with every relative url() inlined, byte for byte otherwise; the
// meta and templates exactly as the servers inject them, ahead of the runtime;
// one copy however many modules use it; and a refusal — or, asked for, a
// plain fallback — when this machine cannot read one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch } from './helpers.mjs';
import { inlineDesignSystemCss, linkDesignSystems } from '../cli/design-system-refs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const OK = path.join(here, 'fixtures', 'design-systems', 'ok');

/** A home with `acme-mkt` registered, holding the fixture as `acme` (and, given, a second catalog's `acme`). */
function home(t, { second = null } = {}) {
  const dir = scratch('ds-bundle', t);
  const h = path.join(dir, 'home');
  const market = (name, version, tweak) => {
    const repo = path.join(dir, name);
    mkdirSync(path.join(repo, '.decklight'), { recursive: true });
    cpSync(OK, path.join(repo, 'systems', 'acme'), { recursive: true });
    if (tweak) tweak(path.join(repo, 'systems', 'acme'));
    writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({ name, entries: [
      { name: 'acme', type: 'design-system', source: 'systems/acme', version, apiVersion: 1 },
    ] }));
    execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], { env: { ...process.env, DECKLIGHT_HOME: h }, stdio: 'ignore' });
    return path.join(repo, 'systems', 'acme');
  };
  const pkg = market('acme-mkt', '1.2.0');
  if (second) market('other-mkt', second.version, second.tweak);
  return { dir, home: h, pkg };
}

const deck = (systems, body = '<section data-template="acme/section-divider"><h2 data-slot="title">Hi</h2></section>') =>
  '<!doctype html><html><head><title>T</title>\n'
  + `<script type="application/json" data-decklight-config>${JSON.stringify({ decklight: '0.9.0', theme: 'aurora', ...(systems ? { designSystems: systems } : {}) })}</script>\n`
  + `</head><body><div class="decklight">${body}</div></body></html>\n`;

const bundle = (h, cwd, ...args) => spawnSync(process.execPath, [CLI, 'bundle', ...args], {
  cwd, encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: h },
});

// ── the stylesheet ────────────────────────────────────────────────────────

test('url() inlining: relative and nested, quoted or not, SVG as text and the rest base64 — outside urls left, the rest byte for byte', (t) => {
  const dir = scratch('ds-inline', t);
  mkdirSync(path.join(dir, 'assets/x'), { recursive: true });
  mkdirSync(path.join(dir, 'css'), { recursive: true });
  writeFileSync(path.join(dir, 'assets/x/y.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>');
  writeFileSync(path.join(dir, 'assets/face.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3]));
  const licence = '/*! Acme Sans — SIL Open Font License 1.1, (c) 2026 Acme. Keep this notice. */\n';
  const css = licence
    + '@font-face { src: url("../assets/face.woff2?v=2#iefix") format("woff2"); }\n'
    + '.a { background: url(../assets/x/y.svg) }\n'
    + ".b { mask: url( '../assets/x/y.svg' ) }\n"
    + '.c { background: url(https://cdn.example/x.png), url(data:image/png;base64,AAAA), url(#grad) }\n';
  writeFileSync(path.join(dir, 'css/ds.css'), css);
  const r = inlineDesignSystemCss(css, dir, 'css/ds.css');
  assert.ok(r.css.startsWith(licence), 'the licence header travels, byte for byte');
  assert.match(r.css, /url\("data:font\/woff2;base64,d09GMgABAgM="\) format\("woff2"\)/);
  const svg = 'url("data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Cpath%20d%3D%22M0%200h1%22%2F%3E%3C%2Fsvg%3E")';
  assert.ok(r.css.includes(`.a { background: ${svg} }`), r.css);
  assert.ok(r.css.includes(`.b { mask: ${svg} }`), 'quoted with spaces alike');
  assert.ok(r.css.includes('url(https://cdn.example/x.png), url(data:image/png;base64,AAAA), url(#grad)'), 'outside, data: and #fragment urls untouched');
  assert.deepEqual(r.external, ['https://cdn.example/x.png']);
  assert.equal(r.assets, 2, 'one file counted once, however often it is named');
  // everything that is not a url() is untouched
  assert.equal(r.css.replace(/url\([^)]*\)/g, 'U'), css.replace(/url\([^)]*\)/g, 'U'));
  assert.throws(() => inlineDesignSystemCss('.d { background: url(assets/gone.png) }', dir, 'ds.css'),
    /ds\.css names url\(assets\/gone\.png\), and the design system has no such file/);
  assert.throws(() => inlineDesignSystemCss('.d { background: url(../../etc/x.png) }', dir, 'css/ds.css'), /no such file/,
    'nothing outside the package is read');
});

// ── the bundle ───────────────────────────────────────────────────────────

test('bundle carries a design system: its blocks before the runtime, no link left, said in the summary — and a re-serve links no second copy', (t) => {
  const { dir, home: h } = home(t);
  writeFileSync(path.join(dir, 'talk.html'), deck(['acme@acme-mkt']));
  const r = bundle(h, dir, 'talk.html');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}designs {2}acme 1\.2\.0 \(from acme-mkt\) — stylesheet, 2 assets \(0\.3 KB\), 2 templates$/m);
  const out = readFileSync(path.join(dir, 'talk-standalone.html'), 'utf8');
  assert.match(out, /<style data-design-system="acme" data-design-system-version="1\.2\.0">\n\/\* Acme Brand/);
  assert.match(out, /url\("data:font\/woff2;base64,/);
  assert.match(out, /url\("data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  assert.doesNotMatch(out, /decklight-design-system\//);
  assert.doesNotMatch(out, /url\(assets\//, 'no relative url() from the design system');
  const meta = out.indexOf('data-design-system-meta="acme"');
  const templates = out.indexOf('<template data-design-system-templates="acme">');
  const runtime = out.indexOf('<script data-decklight-runtime="js">');
  assert.ok(meta > 0 && templates > meta && runtime > templates, 'meta and templates are in the document before the engine runs');
  assert.ok(out.indexOf('<style data-design-system=') > out.indexOf('<style data-theme="aurora"'), 'after the themes, as the servers link it');
  assert.match(out, /<template data-design-system-templates="acme">\n<!-- Acme Brand templates[^\n]*\n<template data-template="section-divider"/);
  assert.equal(linkDesignSystems(out, h), out, 'served again, the carried copy is the only one');
});

test('a design system this machine cannot read fails the bundle, saying why — --allow-missing-design-systems bundles it plainly', (t) => {
  const { dir, home: h } = home(t);
  writeFileSync(path.join(dir, 'talk.html'), deck(['acme@nowhere']));
  const r = bundle(h, dir, 'talk.html');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the deck uses the design system acme@nowhere, and this machine cannot read it — marketplace "nowhere" is not registered/);
  assert.match(r.stderr, /--allow-missing-design-systems/);
  assert.throws(() => readFileSync(path.join(dir, 'talk-standalone.html')), 'nothing is written');
  const ok = bundle(h, dir, 'talk.html', '--allow-missing-design-systems');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^ {2}designs {2}acme@nowhere — not carried$/m);
  assert.match(ok.stdout, /note: design system acme@nowhere not carried — .*; the slides that use it render plainly/);
  assert.doesNotMatch(readFileSync(path.join(dir, 'talk-standalone.html'), 'utf8'), /<style data-design-system=|data-design-system-meta="/);
});

test('a url() the package does not have fails the bundle naming the file — the flag does not cover a broken package', (t) => {
  const { dir, home: h, pkg } = home(t);
  rmSync(path.join(pkg, 'assets/divider.svg'));
  writeFileSync(path.join(dir, 'talk.html'), deck(['acme@acme-mkt']));
  for (const args of [[], ['--allow-missing-design-systems']]) {
    const r = bundle(h, dir, 'talk.html', ...args);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /acme@acme-mkt, and it no longer passes the design-system check — design-system\.css line \d+: url\(assets\/divider\.svg\) — no such file in the package/);
  }
});

test('merged, a design system several modules use is carried once; one name at two versions is refused naming both', (t) => {
  const { dir, home: h } = home(t, { second: { version: '2.0.0', tweak: (p) => {
    const m = path.join(p, 'design-system.json');
    writeFileSync(m, readFileSync(m, 'utf8').replace('"1.2.0"', '"2.0.0"'));
  } } });
  writeFileSync(path.join(dir, 'a.html'), deck(['acme@acme-mkt']).replace('<title>T</title>', '<title>Alpha</title>'));
  writeFileSync(path.join(dir, 'b.html'), deck(['acme@acme-mkt']).replace('<title>T</title>', '<title>Beta</title>'));
  writeFileSync(path.join(dir, 'c.html'), deck(['acme@other-mkt']).replace('<title>T</title>', '<title>Gamma</title>'));
  const r = bundle(h, dir, 'a.html', 'b.html', '-o', 'course.html');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(path.join(dir, 'course.html'), 'utf8').match(/<style data-design-system=/g).length, 1);
  const clash = bundle(h, dir, 'a.html', 'c.html', '-o', 'clash.html');
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /two modules use the design system "acme" at different versions — Alpha has 1\.2\.0, Gamma has 2\.0\.0/);
});

test('a deck with no design systems bundles as it always did', (t) => {
  const { dir, home: h } = home(t);
  writeFileSync(path.join(dir, 'talk.html'), deck(null, '<section><h1>plain</h1></section>'));
  const r = bundle(h, dir, 'talk.html');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /designs/);
  assert.doesNotMatch(readFileSync(path.join(dir, 'talk-standalone.html'), 'utf8'), /<style data-design-system=|data-design-system-meta="/);
});
