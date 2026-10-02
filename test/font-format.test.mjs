// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The font package format and its admission gate (SPEC FONTS): one passing
// package, and for each rule the same package with one thing broken —
// refused naming the file and the rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFontPackage, fontFaceCss, fontStack, FACE_WARN_BYTES, FONT_API_VERSION } from '../tools/font-format.mjs';
import { readFontPackage, checkFontDir } from '../cli/font.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OK = path.join(here, 'fixtures', 'fonts', 'ok');
const CLI = path.join(here, '..', 'cli', 'decklight.mjs');

const okPkg = () => {
  const { manifest, files } = readFontPackage(OK);
  return { manifest, files: new Map([...files].map(([k, v]) => [k, { ...v }])) };
};
const withManifest = (change) => {
  const pkg = okPkg();
  const m = JSON.parse(pkg.manifest);
  change(m);
  pkg.manifest = JSON.stringify(m, null, 2);
  return pkg;
};
const rules = (r) => r.problems.map((p) => p.rule);

test('the passing package is admitted, and says what it holds', () => {
  const r = checkFontDir(OK);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.summary.family, 'Decklight Sample');
  assert.deepEqual(r.summary.faces.map((f) => [f.file, f.weight, f.style]), [['faces/sample-400.woff2', 400, 'normal'], ['faces/sample-700.woff2', 700, 'normal']]);
  assert.equal(r.manifest.license, 'OFL.txt');
});

test('the manifest: a family a stylesheet can quote, a fallback ending in a generic, faces, and a licence', () => {
  for (const [change, rule, said] of [
    [(m) => { m.family = "Evil'; } body { x: y"; }, 'manifest-field', /family .* letters, digits, spaces/],
    [(m) => { m.fallback = 'Helvetica'; }, 'manifest-field', /must end in a generic family/],
    [(m) => { m.fallback = 'x; } a { b'; }, 'manifest-field', /names, commas and quotes only/],
    [(m) => { m.faces = []; }, 'manifest-field', /faces must be a non-empty array/],
    [(m) => { m.faces[0].weight = 1200; }, 'manifest-field', /outside 1–1000/],
    [(m) => { m.faces[1].weight = 400; }, 'face-twice', /weight 400 normal again/],
    [(m) => { m.faces[0].file = 'faces/sample.ttf'; }, 'face-extension', /a face is woff2 or woff/],
    [(m) => { m.faces[0].file = '../outside.woff2'; }, 'file-outside', /climbs out/],
    [(m) => { delete m.license; }, 'manifest-field', /license must name the licence file/],
    [(m) => { m.license = 'LICENSE.md'; }, 'license-missing', /not in the package — a font travels with its licence/],
    [(m) => { m.apiVersion = FONT_API_VERSION + 1; }, 'api-too-new', /needs a newer decklight/],
    [(m) => { m.role = 'display'; }, 'manifest-field', /role must be one of/],
  ]) {
    const r = checkFontPackage(withManifest(change));
    assert.equal(r.ok, false, String(change));
    assert.ok(rules(r).includes(rule), `${change} → ${rules(r)}`);
    assert.match(r.problems.find((p) => p.rule === rule).msg, said);
  }
  // a variable font's weight range is a weight
  assert.equal(checkFontPackage(withManifest((m) => { m.faces = [{ file: 'faces/sample-400.woff2', weight: '100 900' }]; })).ok, true);
});

test('the files: a face must really be one, nothing else may ride along, and a heavy face is a warning', () => {
  const lying = okPkg();
  lying.files.get('faces/sample-700.woff2').head = '<svg';
  assert.deepEqual(rules(checkFontPackage(lying)), ['face-not-a-font']);
  const extra = okPkg();
  extra.files.set('faces/loader.js', { size: 10, head: 'cons' });
  extra.files.set('README.md', { size: 10 });
  assert.deepEqual(rules(checkFontPackage(extra)), ['file-kind'], 'a script is refused; a README is papers');
  const unused = okPkg();
  unused.files.set('faces/sample-900.woff2', { size: 10, head: 'wOF2' });
  const u = checkFontPackage(unused);
  assert.equal(u.ok, true);
  assert.deepEqual(u.warnings.map((w) => w.rule), ['face-unused']);
  const heavy = okPkg();
  heavy.files.get('faces/sample-400.woff2').size = FACE_WARN_BYTES + 1;
  assert.deepEqual(checkFontPackage(heavy).warnings.map((w) => w.rule), ['face-size']);
});

test('fontFaceCss: one @font-face per face, swap, the url the caller gives — and the stack a theme writes', () => {
  const m = JSON.parse(okPkg().manifest);
  const css = fontFaceCss(m, (file) => `decklight-font/mkt/sample/${file}`);
  assert.equal(css.split('\n').length, 2);
  assert.match(css, /^@font-face \{ font-family: 'Decklight Sample'; src: url\("decklight-font\/mkt\/sample\/faces\/sample-400\.woff2"\) format\("woff2"\); font-weight: 400; font-style: normal; font-display: swap; \}/);
  assert.equal(fontStack(m), "'Decklight Sample', system-ui, sans-serif");
});

test('decklight font check: ✔ and a summary, or ✘ and the rule, exit 1', () => {
  const ok = spawnSync(process.execPath, [CLI, 'font', 'check', OK], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /✔ sample — font 1\.0\.0, api 1/);
  assert.match(ok.stdout, /faces {6}400 · 700 — 2 files/);
  const bad = spawnSync(process.execPath, [CLI, 'font', 'check', here], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /no font\.json at the package root/);
});
