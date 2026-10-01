// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The design-system package format and its admission gate (SPEC
// DESIGN_SYSTEMS, #621): one passing package, and for every rule the same
// package with one thing broken — refused naming the file, the line and the
// rule. The names are invented; decklight never learns a real design system's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmTemp } from './helpers.mjs';
import {
  checkPackage, parseLayouts, layoutProblems, svgProblems, readManifest, DESIGN_SYSTEM_API_VERSION, ASSET_WARN_BYTES,
} from '../tools/design-system-format.mjs';
import { readPackage, checkDir } from '../cli/design-system.mjs';
import { validateManifest, INSTALL_HINT } from '../cli/marketplace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'design-systems');
const CLI = path.join(here, '..', 'cli', 'decklight.mjs');

/** The passing package in memory, to break one thing at a time. */
const okPkg = () => {
  const { manifest, files } = readPackage(path.join(FIX, 'ok'));
  return { manifest, files: new Map([...files].map(([k, v]) => [k, { ...v }])) };
};
const edit = (pkg, file, from, to) => {
  const f = pkg.files.get(file);
  assert.ok(f.text.includes(from), `${file} has ${from}`);
  f.text = f.text.replace(from, to);
  if (file === 'design-system.json') pkg.manifest = f.text;
  return pkg;
};
const rules = (r) => r.problems.map((p) => p.rule);
const only = (r, rule) => {
  assert.equal(r.ok, false, `refused for ${rule}`);
  assert.deepEqual(rules(r), [rule], JSON.stringify(r.problems));
  return r.problems[0];
};

test('the passing package is admitted, and says what it holds', () => {
  const r = checkDir(path.join(FIX, 'ok'));
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(r.summary.name, 'acme');
  assert.equal(r.summary.version, '1.2.0');
  assert.deepEqual(r.summary.tokens.sort(), ['--acme-blue', '--acme-coral', '--acme-divider-pad', '--acme-ink']);
  assert.deepEqual(r.summary.layouts.map((l) => l.id), ['section-divider', 'statement']);
  assert.deepEqual(r.summary.exceptions.map((e) => e.token), ['--heading-weight'], 'a declared exception is reported, not refused');
  assert.deepEqual(r.summary.assets.map((a) => a.path).sort(), ['assets/divider.svg', 'assets/fonts/acme-sans.woff2']);
});

test('layouts as data: ids, titles and slots — required, hinted, and the one that takes unslotted content', () => {
  const html = fs.readFileSync(path.join(FIX, 'ok', 'layouts.html'), 'utf8');
  const [divider, statement] = parseLayouts(html);
  assert.equal(divider.id, 'section-divider');
  assert.equal(divider.title, 'Section divider');
  assert.deepEqual(divider.slots.map((s) => [s.name, s.hint, s.required, s.default]), [
    ['kicker', 'p', false, false], ['title', 'h1,h2', true, false], ['subtitle', 'p', false, false], ['body', '', false, true],
  ]);
  assert.deepEqual(statement.slots.map((s) => s.name), ['title', 'body']);
  assert.deepEqual(layoutProblems(html), []);
});

// ── the named failing fixtures (the demo) ──────────────────────────────────

for (const [dir, file, line, rule] of [
  ['script-in-layout', 'layouts.html', 8, 'layout-forbidden-tag'],
  ['unprefixed-token', 'design-system.css', 12, 'unprefixed-token'],
  ['dotdot-url', 'design-system.css', 18, 'css-url-dotdot'],
  ['svg-onload', 'assets/divider.svg', 1, 'svg-handler'],
]) {
  test(`fixture ${dir}: refused naming ${file} line ${line} and the rule`, () => {
    const p = only(checkDir(path.join(FIX, dir)), rule);
    assert.equal(p.file, file);
    assert.equal(p.line, line);
  });
}

test('fixture import-in-css: the @import is refused — and what it pointed at is not in the package either', () => {
  const r = checkDir(path.join(FIX, 'import-in-css'));
  assert.deepEqual(rules(r), ['css-import', 'css-url-missing']);
  assert.equal(r.problems[0].file, 'design-system.css');
  assert.equal(r.problems[0].line, 3);
});

// ── the manifest ───────────────────────────────────────────────────────────

test('the manifest: valid JSON, a lowercase name, a semver version, a title, and the two files it names', () => {
  assert.equal(only(checkPackage({ ...okPkg(), manifest: '{ "apiVersion": 1,' }), 'manifest-json').file, 'design-system.json');
  for (const [from, to, rule, said] of [
    ['"name": "acme"', '"name": "Acme Brand"', 'manifest-field', /a lowercase word/],
    ['"version": "1.2.0"', '"version": "v1.2"', 'manifest-field', /semver version, major\.minor\.patch \(e\.g\. "1\.2\.0"\), no leading v/],
    ['"title": "Acme Brand"', '"title": ""', 'manifest-field', /title must be/],
    ['"apiVersion": 1', '"apiVersion": "1"', 'manifest-field', /positive integer/],
    ['"apiVersion": 1', `"apiVersion": ${DESIGN_SYSTEM_API_VERSION + 1}`, 'api-too-new', /needs a newer decklight/],
    ['"styles": "design-system.css"', '"styles": "../outside.css"', 'file-outside', /climbs out/],
    ['"styles": "design-system.css"', '"styles": "https://cdn.example/x.css"', 'file-outside', /names a URL/],
    ['"styles": "design-system.css"', '"styles": "missing.css"', 'file-missing', /not in the package/],
  ]) {
    const p = only(checkPackage(edit(okPkg(), 'design-system.json', from, to)), rule);
    assert.match(p.msg, said, `${from} → ${to}`);
    assert.ok(p.line > 1, 'the line of the key, not the top of the file');
  }
  assert.equal(readManifest('{"apiVersion":1}').manifest.apiVersion, 1);
});

test('a palette names tokens the stylesheet defines', () => {
  const p = only(checkPackage(edit(okPkg(), 'design-system.json', '"token": "--acme-ink"', '"token": "--acme-night"')), 'palette-undefined');
  assert.match(p.msg, /--acme-night, which design-system\.css never defines/);
});

// ── the stylesheet ─────────────────────────────────────────────────────────

test('css: no url() outside the package — no scheme, nothing absolute, no .., and every relative one a real file', () => {
  for (const [to, rule] of [
    ['url(https://cdn.example/divider.svg)', 'css-url-scheme'],
    ['url(data:image/svg+xml;base64,AAAA)', 'css-url-scheme'],
    ['url(/assets/divider.svg)', 'css-url-absolute'],
    ['url("assets/../../divider.svg")', 'css-url-dotdot'],
    ['url(assets/nowhere.svg)', 'css-url-missing'],
  ]) only(checkPackage(edit(okPkg(), 'design-system.css', 'url(assets/divider.svg)', to)), rule);
  // a fragment points into the page, a query or fragment on a real file is fine
  assert.equal(checkPackage(edit(okPkg(), 'design-system.css', 'url(assets/divider.svg)', 'url("assets/divider.svg#v2")')).ok, true);
  assert.equal(checkPackage(edit(okPkg(), 'design-system.css', '--acme-ink: #14213d;', '--acme-ink: #14213d; filter: url(#glow);')).ok, true);
});

test('css: a theme-contract token needs a ds-exception, and a declared one is printed, not refused', () => {
  const p = only(checkPackage(edit(okPkg(), 'design-system.css', '/* ds-exception: --heading-weight Acme headings are always semibold */', '')), 'contract-token');
  assert.match(p.msg, /--heading-weight is a theme-contract token .* ds-exception: --heading-weight <reason>/);
  const bg = only(checkPackage(edit(okPkg(), 'design-system.css', '--acme-ink: #14213d;', '--acme-ink: #14213d;\n  --bg: #000;')), 'contract-token');
  assert.match(bg.msg, /^--bg /);
  // a token READ through var() is not a declaration
  assert.equal(checkPackage(edit(okPkg(), 'design-system.css', 'color: #fff;', 'color: var(--fg);')).ok, true);
});

test('css: a custom tokenPrefix is the one held to', () => {
  const pkg = edit(okPkg(), 'design-system.json', '"title": "Acme Brand",', '"title": "Acme Brand",\n  "tokenPrefix": "--ax-",');
  const r = checkPackage(pkg);
  assert.ok(r.problems.every((p) => p.rule === 'unprefixed-token'));
  assert.match(r.problems[0].msg, /tokenPrefix --ax-/);
});

// ── the layouts ────────────────────────────────────────────────────────────

test('layouts: inert structure only — every way to run something is refused, with its line', () => {
  for (const [to, rule] of [
    ['<div data-slot="subtitle" data-slot-hint="p" onclick="go()"></div>', 'layout-forbidden-attr'],
    ['<iframe></iframe><div data-slot="subtitle" data-slot-hint="p"></div>', 'layout-forbidden-tag'],
    ['<a href="&#106;avascript:go()">x</a><div data-slot="subtitle" data-slot-hint="p"></div>', 'layout-javascript-url'],
    ['<style>.x{}</style><div data-slot="subtitle" data-slot-hint="p"></div>', 'layout-forbidden-tag'],
    ['<object data="#x"></object><div data-slot="subtitle" data-slot-hint="p"></div>', 'layout-forbidden-tag'],
    ['<img src="assets/divider.svg"><div data-slot="subtitle" data-slot-hint="p"></div>', 'layout-reference'],
  ]) {
    const p = only(checkPackage(edit(okPkg(), 'layouts.html', '<div data-slot="subtitle" data-slot-hint="p"></div>', to)), rule);
    assert.equal(p.file, 'layouts.html');
    assert.equal(p.line, 6);
  }
  const srcdoc = layoutProblems('<template data-layout="x"><div srcdoc="y"></div></template>');
  assert.deepEqual(srcdoc.map((p) => p.rule), ['layout-forbidden-attr']);
});

test('layouts: everything inside a <template data-layout>, ids unique and plain, slots unique, one default', () => {
  for (const [from, to, rule] of [
    ['<!-- Acme Brand layouts', '<p>stray</p>\n<!-- Acme Brand layouts', 'layout-outside-template'],
    ['<!-- Acme Brand layouts', '</template>\n<!-- Acme Brand layouts', 'layout-outside-template'],
    ['data-layout="statement"', 'data-layout="section-divider"', 'layout-duplicate'],
    ['data-layout="statement"', 'data-layout="Statement Slide"', 'layout-id'],
    ['<div data-slot="subtitle" data-slot-hint="p"></div>', '<div data-slot="kicker"></div>', 'slot-repeated'],
    ['<div data-slot="subtitle" data-slot-hint="p"></div>', '<div data-slot="subtitle" data-slot-default></div>', 'slot-default-twice'],
    ['<div data-slot="subtitle" data-slot-hint="p"></div>', '<div data-slot="Sub Title"></div>', 'slot-name'],
  ]) only(checkPackage(edit(okPkg(), 'layouts.html', from, to)), rule);
});

// ── assets ─────────────────────────────────────────────────────────────────

test('svg: no script, no handlers, nothing outside the file — #fragments stay allowed', () => {
  assert.deepEqual(svgProblems('<svg><use href="#g"/><a xlink:href="#top"/></svg>'), []);
  assert.deepEqual(svgProblems('<svg><script>x</script></svg>').map((p) => p.rule), ['svg-script']);
  assert.deepEqual(svgProblems('<svg><foreignObject/></svg>').map((p) => p.rule), ['svg-script']);
  assert.deepEqual(svgProblems('<svg><image href="https://x.example/a.png"/></svg>').map((p) => p.rule), ['svg-external-href']);
  assert.deepEqual(svgProblems('<svg><use xlink:href="other.svg#g"/></svg>').map((p) => p.rule), ['svg-external-href']);
});

test('assets: the allowlisted kinds only; an oversized one is a warning, not a refusal; papers and dotfiles are not assets', () => {
  const js = okPkg();
  js.files.set('assets/tracker.js', { size: 10 });
  assert.equal(only(checkPackage(js), 'asset-extension').file, 'assets/tracker.js');
  const big = okPkg();
  big.files.set('assets/hero.png', { size: ASSET_WARN_BYTES + 1 });
  const r = checkPackage(big);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings.map((w) => [w.file, w.rule]), [['assets/hero.png', 'asset-size']]);
  const papers = okPkg();
  papers.files.set('LICENSE', { size: 1 });
  papers.files.set('.DS_Store', { size: 1 });
  assert.equal(checkPackage(papers).ok, true);
});

test('a symlink out of the package is refused — nothing outside the directory is ever part of it', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-ds-link-'));
  t.after(() => rmTemp(dir));
  fs.cpSync(path.join(FIX, 'ok'), path.join(dir, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'secret.svg'), '<svg/>');
  fs.symlinkSync(path.join(dir, 'secret.svg'), path.join(dir, 'pkg', 'assets', 'leak.svg'));
  const p = only(checkDir(path.join(dir, 'pkg')), 'file-outside');
  assert.equal(p.file, 'assets/leak.svg');
});

// ── the command ────────────────────────────────────────────────────────────

const run = (...args) => spawnSync(process.execPath, [CLI, 'design-system', ...args], { encoding: 'utf8' });

test('design-system check: ✔ and the summary on a valid package, exit 0', () => {
  const r = run('check', path.join(FIX, 'ok'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^✔ acme — design system 1\.2\.0, api 1$/m);
  assert.match(r.stdout, /section-divider \(kicker, title\*, subtitle, body†\)/);
  assert.match(r.stdout, /ds-exception --heading-weight: Acme headings are always semibold/);
});

test('design-system check: ✘ naming the file, line and rule, exit 1 — never a stack', () => {
  const r = run('check', path.join(FIX, 'unprefixed-token'));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /design-system\.css line 12: --brand-coral does not start with this package's tokenPrefix --acme-  \[unprefixed-token\]/);
  assert.doesNotMatch(r.stdout + r.stderr, /^\s+at /m);
});

test('design-system: --help exits 0, and a missing or wrong path is a refusal that names itself', () => {
  assert.equal(run('--help').status, 0);
  const missing = run('check', path.join(FIX, 'nope'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no such directory/);
  const file = run('check', path.join(FIX, 'ok', 'design-system.json'));
  assert.equal(file.status, 1);
  assert.match(file.stderr, /is a file — a design system is a directory/);
  assert.equal(run('check').status, 1);
  assert.match(run('lint').stderr, /unknown subcommand "lint"/);
});

// ── the catalog ────────────────────────────────────────────────────────────

const catalog = (entry) => JSON.stringify({ name: 'acme-mkt', entries: [{ name: 'acme', type: 'design-system', ...entry }] });

test('a catalog takes design-system entries: apiVersion required, a relative directory source', () => {
  assert.equal(validateManifest(catalog({ source: 'systems/acme', apiVersion: 1, version: '1.2.0' })).ok, true);
  const noApi = validateManifest(catalog({ source: 'systems/acme' }));
  assert.deepEqual(noApi.errors.map((e) => e.field), ['entries[0].apiVersion']);
  for (const [source, said] of [
    ['https://cdn.example/acme', /is a URL — .* no https source/],
    ['/srv/acme', /is absolute/],
    ['systems/../../acme', /climbs out with \.\./],
  ]) {
    const v = validateManifest(catalog({ source, apiVersion: 1 }));
    assert.equal(v.ok, false, source);
    assert.deepEqual(v.errors.map((e) => e.field), ['entries[0].source']);
    assert.match(v.errors[0].msg, said);
  }
  const missing = validateManifest(catalog({ apiVersion: 1 }));
  assert.equal(missing.errors.length, 1, 'a missing source is said once');
  assert.equal(INSTALL_HINT['design-system'], null, 'no install command until a deck can reference one');
});
