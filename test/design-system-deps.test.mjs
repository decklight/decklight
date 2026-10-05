// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A design system brings its recommended themes and fonts, and offers its
// look (SPEC DESIGN_SYSTEMS, #642): pulled by default, each through its own
// gate, in one edit; --no-recommended for the design system alone; the look
// applied only when asked (--apply, the prompt, `design-system apply`, the
// author route); a recommendation that cannot come is a warning, never a
// failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch, stop } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const EDIT = path.join(ROOT, 'cli/edit.mjs');
const AURORA = readFileSync(path.join(ROOT, 'themes/aurora.css'), 'utf8');

/**
 * acme-mkt: the design system `acme` (recommending the theme `nord` from its
 * own catalog, the shipped `paper`, and `twin` — which two OTHER catalogs both
 * have — and the font `sample` and the stack `humanist`), `nord`, `sample`.
 */
function home(t, { fontBroken = false } = {}) {
  const dir = scratch('ds-deps', t);
  const h = path.join(dir, 'home');
  const env = { ...process.env, DECKLIGHT_HOME: h };
  const market = (name, entries, fill) => {
    const repo = path.join(dir, name);
    mkdirSync(path.join(repo, '.decklight'), { recursive: true });
    mkdirSync(path.join(repo, 'themes'), { recursive: true });
    fill?.(repo);
    writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({ name, title: name, entries }));
    execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], { env, stdio: 'ignore' });
    return repo;
  };
  const acme = market('acme-mkt', [
    { name: 'acme', type: 'design-system', source: 'systems/acme', version: '1.2.0', apiVersion: 1 },
    { name: 'nord', type: 'theme', source: './themes/nord.css', version: '2.0.0' },
    { name: 'sample', type: 'font', source: 'fonts/sample', version: '1.0.0', apiVersion: 1 },
  ], (repo) => {
    cpSync(path.join(here, 'fixtures/design-systems/ok'), path.join(repo, 'systems/acme'), { recursive: true });
    const m = path.join(repo, 'systems/acme/design-system.json');
    writeFileSync(m, JSON.stringify({ ...JSON.parse(readFileSync(m, 'utf8')), recommendedThemes: ['nord', 'paper', 'twin'], recommendedFonts: ['sample', 'humanist'] }));
    writeFileSync(path.join(repo, 'themes/nord.css'), AURORA);
    cpSync(path.join(here, 'fixtures/fonts/ok'), path.join(repo, 'fonts/sample'), { recursive: true });
    if (fontBroken) writeFileSync(path.join(repo, 'fonts/sample/faces/sample-700.woff2'), 'not a font');
  });
  for (const name of ['left-mkt', 'right-mkt']) {
    market(name, [{ name: 'twin', type: 'theme', source: './themes/twin.css' }], (repo) => writeFileSync(path.join(repo, 'themes/twin.css'), AURORA));
  }
  return { dir, h, env, acme };
}

const deck = (cfg) => '<!doctype html><html><head><title>T</title>\n'
  + `<script type="application/json" data-decklight-config>${JSON.stringify(cfg)}</script>\n`
  + '</head><body><div class="decklight"><section>a</section></div></body></html>';
const config = (file) => JSON.parse(readFileSync(file, 'utf8').match(/data-decklight-config>([\s\S]*?)<\/script>/)[1]);

test('design-system add brings its recommended themes and fonts, in one edit — and suggests the look without applying it', (t) => {
  const { dir, env } = home(t);
  const file = path.join(dir, 'talk.html');
  writeFileSync(file, deck({ decklight: '0.9.0', theme: 'aurora' }));
  const r = spawnSync(process.execPath, [CLI, 'design-system', 'add', 'acme@acme-mkt', file], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const c = config(file);
  assert.deepEqual(c.designSystems, ['acme@acme-mkt']);
  assert.deepEqual(c.markedThemes, ['nord@acme-mkt', 'paper'], 'its own catalog\'s theme, and a shipped one by name');
  assert.deepEqual(c.fonts, ['sample@acme-mkt']);
  assert.equal(c.theme, 'aurora', 'not applied: the look is the author\'s choice');
  assert.equal(c.font, undefined);
  assert.match(r.stdout, /^ {2}\+ theme nord@acme-mkt 2\.0\.0$/m);
  assert.match(r.stdout, /^ {2}\+ theme paper \(shipped\)$/m);
  assert.match(r.stdout, /^ {2}⚠ theme twin — "twin" is a theme in 2 marketplaces — say which: twin@left-mkt, twin@right-mkt$/m, 'ambiguous: refused, with the qualified forms');
  assert.match(r.stdout, /^ {2}\+ font sample@acme-mkt 1\.0\.0$/m);
  assert.match(r.stdout, /^ {2}· font humanist — a picker stack: applied, nothing to carry$/m);
  assert.match(r.stdout, /Acme Brand was drawn for theme nord, font Decklight Sample — add --apply to switch/, 'no TTY: suggested, never asked');
  // again: everything already there, nothing written twice
  const before = readFileSync(file, 'utf8');
  const again = spawnSync(process.execPath, [CLI, 'design-system', 'add', 'acme@acme-mkt', file], { encoding: 'utf8', env });
  assert.match(again.stdout, /= theme nord@acme-mkt — already there/);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('--apply switches the theme and the font in the same edit; --no-recommended is the design system alone', (t) => {
  const { dir, env } = home(t);
  const applied = path.join(dir, 'applied.html');
  writeFileSync(applied, deck({ decklight: '0.9.0', theme: 'aurora' }));
  const r = spawnSync(process.execPath, [CLI, 'design-system', 'add', 'acme@acme-mkt', applied, '--apply'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([config(applied).theme, config(applied).font], ['nord', 'sample']);
  assert.match(r.stdout, /applied Acme Brand's look — theme nord, font Decklight Sample/);
  const alone = path.join(dir, 'alone.html');
  writeFileSync(alone, deck({ decklight: '0.9.0', theme: 'aurora' }));
  const a = spawnSync(process.execPath, [CLI, 'design-system', 'add', 'acme@acme-mkt', alone, '--no-recommended'], { encoding: 'utf8', env });
  assert.equal(a.status, 0, a.stderr);
  const c = config(alone);
  assert.deepEqual([c.designSystems, c.markedThemes, c.fonts, c.theme], [['acme@acme-mkt'], undefined, undefined, 'aurora']);
  assert.match(a.stdout, /--no-recommended: not added — what it recommends:\n {4}theme nord@acme-mkt {2}— decklight theme add nord@acme-mkt/);
  assert.doesNotMatch(a.stdout, /--apply/, '--no-recommended implies --no-apply');
});

test('a recommendation that fails its gate is a warning: the design system and the rest still come, exit 0', (t) => {
  const { dir, env } = home(t, { fontBroken: true });
  const file = path.join(dir, 'talk.html');
  writeFileSync(file, deck({ decklight: '0.9.0', theme: 'aurora' }));
  const r = spawnSync(process.execPath, [CLI, 'design-system', 'add', 'acme@acme-mkt', file], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([config(file).designSystems, config(file).markedThemes, config(file).fonts], [['acme@acme-mkt'], ['nord@acme-mkt', 'paper'], undefined]);
  assert.match(r.stdout, /⚠ font sample — it fails the font check — faces\/sample-700\.woff2: .* is not a woff2 file[^\n]*\n {6}decklight font add sample@acme-mkt <deck>/);
});

test('design-system apply gives a deck the look later; remove leaves the themes, fonts and look, and lists them', (t) => {
  const { dir, env } = home(t);
  const file = path.join(dir, 'talk.html');
  writeFileSync(file, deck({ decklight: '0.9.0', theme: 'aurora' }));
  spawnSync(process.execPath, [CLI, 'design-system', 'add', 'acme@acme-mkt', file, '--no-apply'], { env });
  assert.equal(config(file).theme, 'aurora');
  const ap = spawnSync(process.execPath, [CLI, 'design-system', 'apply', 'acme', file], { encoding: 'utf8', env });
  assert.equal(ap.status, 0, ap.stderr);
  assert.deepEqual([config(file).theme, config(file).font], ['nord', 'sample']);
  assert.match(spawnSync(process.execPath, [CLI, 'design-system', 'apply', 'acme', file], { encoding: 'utf8', env }).stdout, /already wears Acme Brand's look/);
  const rm = spawnSync(process.execPath, [CLI, 'design-system', 'remove', 'acme@acme-mkt', file], { encoding: 'utf8', env });
  assert.equal(rm.status, 0, rm.stderr);
  const c = config(file);
  assert.deepEqual([c.designSystems, c.markedThemes, c.fonts, c.theme, c.font], [undefined, ['nord@acme-mkt', 'paper'], ['sample@acme-mkt'], 'nord', 'sample']);
  assert.match(rm.stdout, /still in the deck .*\n {4}theme nord@acme-mkt {2}— decklight theme remove nord@acme-mkt/);
  assert.match(rm.stdout, /font sample@acme-mkt {2}— decklight font remove sample@acme-mkt/);
});

test('the edit server: mark brings them (⇧ — recommended: false — does not), one undo; apply is its own undo', async (t) => {
  const { dir, h } = home(t);
  writeFileSync(path.join(dir, 'deck.html'), deck({ decklight: '0.9.0', theme: 'aurora' }));
  const file = path.join(dir, 'deck.html');
  const proc = spawn(process.execPath, [EDIT, 'deck.html', '--port', '0', '--no-git'], { cwd: dir, env: { ...process.env, DECKLIGHT_HOME: h }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stop(proc));
  let log = '';
  proc.stdout.on('data', (c) => { log += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => { const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); } }, 25);
    setTimeout(() => { clearInterval(scan); reject(new Error(log)); }, 10000);
  });
  const post = async (route, body) => (await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const original = readFileSync(file, 'utf8');
  const m = await post('/edit/design-system/mark', { ref: 'acme@acme-mkt', used: true });
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.deepEqual(m.pulled.filter((x) => x.status === 'add').map((x) => `${x.kind} ${x.ref}`), ['theme nord@acme-mkt', 'theme paper', 'font sample@acme-mkt']);
  assert.deepEqual({ theme: m.look.theme, font: m.look.font, differs: m.look.differs }, { theme: 'nord', font: 'sample', differs: true });
  assert.deepEqual([config(file).markedThemes, config(file).fonts, config(file).theme], [['nord@acme-mkt', 'paper'], ['sample@acme-mkt'], 'aurora']);
  const ap = await post('/edit/design-system/apply', { ref: 'acme' });
  assert.equal(ap.changed, true);
  assert.deepEqual([config(file).theme, config(file).font], ['nord', 'sample']);
  await post('/edit/undo', {});
  assert.deepEqual([config(file).theme, config(file).designSystems], ['aurora', ['acme@acme-mkt']], 'undo puts the old look back and keeps the design system');
  await post('/edit/undo', {});
  assert.equal(readFileSync(file, 'utf8'), original, 'the add, its themes and fonts: one undo');
  const alone = await post('/edit/design-system/mark', { ref: 'acme@acme-mkt', used: true, recommended: false });
  assert.deepEqual([alone.pulled, config(file).markedThemes, config(file).fonts], [[], undefined, undefined]);
});

// #653: a dependency the deck already has is recorded at the catalog's
// version now — as re-running `theme add` / `font add` would — or
// `marketplace list` keeps calling it out of date though the deck renders it.
const ledger = (h) => JSON.parse(readFileSync(path.join(h, 'installed.json'), 'utf8')).installs;
const versions = (h) => [ledger(h)['theme:nord@acme-mkt']?.version, ledger(h)['font:sample@acme-mkt']?.version];
function bump(acme, env, nord, sample) {
  const m = path.join(acme, '.decklight/marketplace.json');
  const j = JSON.parse(readFileSync(m, 'utf8'));
  for (const e of j.entries) {
    if (e.name === 'nord') e.version = nord;
    if (e.name === 'sample') e.version = sample;
  }
  writeFileSync(m, JSON.stringify(j));
  execFileSync(process.execPath, [CLI, 'marketplace', 'update', 'acme-mkt'], { env, stdio: 'ignore' });
}
/** A deck that already marks nord (and the shipped paper) and references sample, recorded at 2.0.0 / 1.0.0 — then the catalog moves on. */
function marked(t, look = false) {
  const { dir, h, env, acme } = home(t);
  const file = path.join(dir, 'talk.html');
  writeFileSync(file, deck({ decklight: '0.9.0', theme: look ? 'nord' : 'aurora', ...(look ? { font: 'sample' } : {}), markedThemes: ['paper'] }));
  for (const [kind, ref] of [['theme', 'nord@acme-mkt'], ['font', 'sample@acme-mkt']]) {
    const r = spawnSync(process.execPath, [CLI, kind, 'add', ref, file], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(versions(h), ['2.0.0', '1.0.0']);
  bump(acme, env, '3.0.0', '1.1.0');
  return { dir, h, env, acme, file };
}

test('design-system add records a dependency already there at the catalog\'s version now; --no-recommended records none (#653)', (t) => {
  const { dir, h, env, file } = marked(t);
  const alone = path.join(dir, 'alone.html');
  writeFileSync(alone, readFileSync(file, 'utf8'));
  const a = spawnSync(process.execPath, [CLI, 'design-system', 'add', 'acme@acme-mkt', alone, '--no-recommended'], { encoding: 'utf8', env });
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(versions(h), ['2.0.0', '1.0.0'], '--no-recommended records nothing for dependencies');
  const r = spawnSync(process.execPath, [CLI, 'design-system', 'add', 'acme@acme-mkt', file, '--no-apply'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(versions(h), ['3.0.0', '1.1.0']);
  assert.match(r.stdout, /^ {2}= theme nord@acme-mkt — already there, recorded 3\.0\.0$/m);
  assert.match(r.stdout, /^ {2}= font sample@acme-mkt — already there, recorded 1\.1\.0$/m);
  assert.equal(readFileSync(file, 'utf8'), readFileSync(alone, 'utf8'), 'the deck gains the design-system reference and nothing else');
  assert.doesNotMatch(spawnSync(process.execPath, [CLI, 'marketplace', 'list'], { encoding: 'utf8', env }).stdout, /→ (3\.0\.0|1\.1\.0)/);
  // already current: the plain line
  const again = spawnSync(process.execPath, [CLI, 'design-system', 'add', 'acme@acme-mkt', file, '--no-apply'], { encoding: 'utf8', env });
  assert.match(again.stdout, /^ {2}= theme nord@acme-mkt — already there$/m);
});

test('design-system apply records a dependency already there, even when the deck already wears the look (#653)', (t) => {
  const { h, env, file } = marked(t, true);
  spawnSync(process.execPath, [CLI, 'design-system', 'add', 'acme@acme-mkt', file, '--no-recommended'], { env });
  const before = readFileSync(file, 'utf8');
  const ap = spawnSync(process.execPath, [CLI, 'design-system', 'apply', 'acme', file], { encoding: 'utf8', env });
  assert.equal(ap.status, 0, ap.stderr);
  assert.match(ap.stdout, /already wears Acme Brand's look/);
  assert.match(ap.stdout, /= theme nord@acme-mkt — already there, recorded 3\.0\.0/);
  assert.deepEqual(versions(h), ['3.0.0', '1.1.0']);
  assert.equal(readFileSync(file, 'utf8'), before, 'the ledger only: the deck is untouched');
});

test('the edit server records a dependency already there: on mark (not with ⇧), and on an apply that changes nothing (#653)', async (t) => {
  const { dir, h, env, acme, file } = marked(t, true);
  const proc = spawn(process.execPath, [EDIT, 'talk.html', '--port', '0', '--no-git'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => stop(proc));
  let log = '';
  proc.stdout.on('data', (c) => { log += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => { const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); } }, 25);
    setTimeout(() => { clearInterval(scan); reject(new Error(log)); }, 10000);
  });
  const post = async (route, body) => (await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const alone = await post('/edit/design-system/mark', { ref: 'acme@acme-mkt', used: true, recommended: false });
  assert.equal(alone.ok, true, JSON.stringify(alone));
  assert.deepEqual(versions(h), ['2.0.0', '1.0.0'], '⇧: the design system alone, nothing recorded for its dependencies');
  await post('/edit/design-system/mark', { ref: 'acme@acme-mkt', used: false });
  const m = await post('/edit/design-system/mark', { ref: 'acme@acme-mkt', used: true });
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.deepEqual(versions(h), ['3.0.0', '1.1.0']);
  bump(acme, env, '4.0.0', '1.2.0');
  const before = readFileSync(file, 'utf8');
  const ap = await post('/edit/design-system/apply', { ref: 'acme' });
  assert.equal(ap.changed, false, 'the deck already wears the look');
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(versions(h), ['4.0.0', '1.2.0']);
});
