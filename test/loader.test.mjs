// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The loader (MARKETPLACE.md `EXTENSIONS#LOADER`) — running an installed
// build-time transform, and `decklight bundle --transform <name>` on top of
// it. Two things get most of the attention:
//
//   THE apiVersion CHECK IS THE LOADER'S, NOT THE CATALOG'S. `marketplace add`
//   only validates apiVersion's SHAPE (test/marketplace.test.mjs); a transform
//   declaring a version ahead of what this decklight implements still
//   installs. Whether it can actually RUN is decided here, at load time.
//
//   A THROW NEVER REACHES THE CALLER AS A STACK TRACE. Every way a transform
//   can misbehave (no default export, a non-function export, a throw, a
//   non-string return) collapses to the same clean, transform-naming error
//   (SPEC EXTENSIONS_TRANSFORMS).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveTransform, runTransform, resolveImporter, runImporter, LoaderError,
} from '../cli/loader.mjs';
import { installUnit, unitPath, unitDir, findUnit } from '../cli/units.mjs';
import { TRANSFORM_API_VERSION, IMPORTER_API_VERSION } from '../cli/marketplace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const DEMO = path.join(ROOT, 'demo/intro.html');

const tmp = (p) => mkdtempSync(path.join(tmpdir(), `decklight-${p}-`));

/** Write a transform straight into the library, bypassing install — for the
 *  loader tests that do not need a catalog behind it at all. */
function putTransform(home, name, source) {
  mkdirSync(unitDir('transform', home), { recursive: true });
  writeFileSync(unitPath('transform', name, home), source);
}

/** Write an import adapter straight into the library, bypassing install —
 *  the importer equivalent of `putTransform`. An importer is a directory unit
 *  (`files: ['importer.mjs']`), unlike a transform's single `.mjs` file. */
function putImporter(home, name, source) {
  const dir = unitPath('importer', name, home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'importer.mjs'), source);
}

/** A local marketplace with one importer entry, registered into `home`. */
function importerMarket(home, { apiVersion = IMPORTER_API_VERSION, name = 'marp-import', source = 'marp', body } = {}) {
  const root = tmp('importer-market');
  mkdirSync(path.join(root, '.decklight'), { recursive: true });
  writeFileSync(path.join(root, '.decklight/marketplace.json'), JSON.stringify({
    name: 'cat',
    entries: [{ name, type: 'importer', source, extensions: ['.marp'], apiVersion }],
  }, null, 2));
  mkdirSync(path.join(root, source), { recursive: true });
  writeFileSync(path.join(root, source, 'importer.mjs'),
    body ?? 'export default async function importAdapter(bytes) { return `<section>${bytes.toString("utf8")}</section>`; }\n');
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', root],
    { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  return root;
}

/** A local marketplace with one transform entry, registered into `home`. */
function market(home, { apiVersion = TRANSFORM_API_VERSION, name = 'grammar-check', source = 'grammar.mjs', body } = {}) {
  const root = tmp('transform-market');
  mkdirSync(path.join(root, '.decklight'), { recursive: true });
  writeFileSync(path.join(root, '.decklight/marketplace.json'), JSON.stringify({
    name: 'cat',
    entries: [{ name, type: 'transform', source, apiVersion }],
  }, null, 2));
  writeFileSync(path.join(root, source), body ?? `export default async function transform(html) { return html; }\n`);
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', root],
    { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  return root;
}

const run = (args, home, cwd) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args],
        { encoding: 'utf8', cwd, env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }),
    };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

// ── decklight transform add/list/remove — the generic install seam ─────────

test('a transform installs, lists and removes through the same seam as every other unit', () => {
  const home = tmp('transform-cli');
  try {
    market(home, { body: 'export default async function transform(html) { return html + "\\n<!-- x -->"; }\n' });
    let { code, out } = run(['transform', 'add', 'grammar-check'], home);
    assert.equal(code, 0, out);
    assert.match(out, /installed grammar-check/);
    assert.ok(existsSync(unitPath('transform', 'grammar-check', home)));

    ({ out } = run(['transform', 'list'], home));
    assert.match(out, /^grammar-check/m);

    ({ code, out } = run(['transform', 'remove', 'grammar-check'], home));
    assert.equal(code, 0, out);
    assert.equal(findUnit('transform', 'grammar-check', home), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('installing does not check apiVersion currency — that is the loader\'s job', async () => {
  const home = tmp('transform-install-ahead');
  try {
    market(home, { apiVersion: TRANSFORM_API_VERSION + 10 });
    const done = await installUnit('transform', 'grammar-check', home);
    assert.equal(done.name, 'grammar-check', 'a catalog written against a newer contract still installs');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── the loader itself ───────────────────────────────────────────────────────

test('runTransform applies the installed transform and reports it unchecked with no catalog behind it', async () => {
  const home = tmp('transform-load-plain');
  try {
    putTransform(home, 'shout', 'export default async function transform(html) { return html.toUpperCase(); }\n');
    const { html, checked } = await runTransform('shout', '<p>hi</p>', home);
    assert.equal(html, '<P>HI</P>');
    assert.equal(checked, false, 'no cached catalog entry names this transform');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a matching catalog entry at or under TRANSFORM_API_VERSION runs, and is reported checked', async () => {
  const home = tmp('transform-load-checked');
  try {
    market(home, { apiVersion: TRANSFORM_API_VERSION });
    await installUnit('transform', 'grammar-check', home);
    const { checked } = await runTransform('grammar-check', '<p>hi</p>', home);
    assert.equal(checked, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an apiVersion ahead of TRANSFORM_API_VERSION refuses to run, naming both numbers', async () => {
  const home = tmp('transform-load-ahead');
  try {
    market(home, { apiVersion: TRANSFORM_API_VERSION + 3 });
    await installUnit('transform', 'grammar-check', home);
    await assert.rejects(() => runTransform('grammar-check', '<p>hi</p>', home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, new RegExp(`needs apiVersion ${TRANSFORM_API_VERSION + 3}`));
      assert.match(e.message, new RegExp(`up to ${TRANSFORM_API_VERSION}`));
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an uninstalled transform names the install command, not a file-not-found error', async () => {
  const home = tmp('transform-missing');
  try {
    await assert.rejects(() => runTransform('nope', '<p>hi</p>', home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /no transform "nope" installed/);
      assert.match(e.message, /decklight transform add nope/);
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a transform with no default export function is refused', async () => {
  const home = tmp('transform-noexport');
  try {
    putTransform(home, 'broken', 'export const transform = () => "x";\n');
    await assert.rejects(() => runTransform('broken', '<p>hi</p>', home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /no default export function/);
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a throwing transform is reported cleanly, naming it — never a raw stack', async () => {
  const home = tmp('transform-throws');
  try {
    putTransform(home, 'boom', 'export default async function transform() { throw new Error("bad regex"); }\n');
    await assert.rejects(() => runTransform('boom', '<p>hi</p>', home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /transform "boom" threw: bad regex/);
      assert.doesNotMatch(e.message, /at Object|at async|\.mjs:\d+:\d+/, 'no stack frame leaks through');
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a transform that returns a non-string is refused', async () => {
  const home = tmp('transform-nonstring');
  try {
    putTransform(home, 'wrong', 'export default async function transform() { return { not: "a string" }; }\n');
    await assert.rejects(() => runTransform('wrong', '<p>hi</p>', home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /must return a string \(returned object\)/);
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('resolveTransform surfaces the same install-command error without running anything', () => {
  const home = tmp('transform-resolve-only');
  try {
    assert.throws(() => resolveTransform('nope', home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /decklight transform add nope, decklight transform list/);
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── bundle --transform, end to end ──────────────────────────────────────────

test('bundle --transform runs the transform on the deck\'s OWN source, before anything is inlined', () => {
  const home = tmp('bundle-transform');
  const out = path.join(tmp('bundle-transform-out'), 'out.html');
  try {
    putTransform(home, 'mark-title',
      'export default async function transform(html) {\n'
      + '  return html.replace("<title>Decklight", "<title>[XFORM] Decklight");\n'
      + '}\n');
    const { code, out: log } = run(['bundle', DEMO, '-o', out, '--transform', 'mark-title'], home);
    assert.equal(code, 0, log);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /<title>\[XFORM\] Decklight/, 'the transform\'s edit survived into the bundle');
    assert.match(log, /note: transform mark-title applied/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('several --transform flags apply in the order given', () => {
  const home = tmp('bundle-transform-order');
  const out = path.join(tmp('bundle-transform-order-out'), 'out.html');
  try {
    putTransform(home, 'add-a', 'export default async function transform(html) { return html.replace("<title>", "<title>[A]"); }\n');
    putTransform(home, 'add-b', 'export default async function transform(html) { return html.replace("<title>", "<title>[B]"); }\n');
    const { code, out: log } = run(['bundle', DEMO, '-o', out, '--transform', 'add-a', '--transform', 'add-b'], home);
    assert.equal(code, 0, log);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /<title>\[B\]\[A\]Decklight/, 'add-a ran first, so add-b\'s replace lands closer to <title>');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('bundle --transform names an uninstalled transform rather than crashing', () => {
  const home = tmp('bundle-transform-missing');
  const out = path.join(tmp('bundle-transform-missing-out'), 'out.html');
  try {
    const { code, out: log } = run(['bundle', DEMO, '-o', out, '--transform', 'nope'], home);
    assert.equal(code, 1);
    assert.match(log, /decklight bundle: no transform "nope" installed/);
    assert.match(log, /decklight transform add nope/);
    assert.ok(!existsSync(out), 'nothing was written');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('bundle --transform surfaces a throw cleanly and writes nothing', () => {
  const home = tmp('bundle-transform-throws');
  const out = path.join(tmp('bundle-transform-throws-out'), 'out.html');
  try {
    putTransform(home, 'boom', 'export default async function transform() { throw new Error("nope"); }\n');
    const { code, out: log } = run(['bundle', DEMO, '-o', out, '--transform', 'boom'], home);
    assert.equal(code, 1);
    assert.match(log, /decklight bundle: transform "boom" threw: nope/);
    assert.ok(!existsSync(out), 'nothing was written');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('bundle --transform refuses an apiVersion this decklight does not implement yet', () => {
  const home = tmp('bundle-transform-ahead');
  const out = path.join(tmp('bundle-transform-ahead-out'), 'out.html');
  try {
    market(home, { apiVersion: TRANSFORM_API_VERSION + 7 });
    execFileSync(process.execPath, [CLI, 'transform', 'add', 'grammar-check'],
      { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    const { code, out: log } = run(['bundle', DEMO, '-o', out, '--transform', 'grammar-check'], home);
    assert.equal(code, 1);
    assert.match(log, new RegExp(`needs apiVersion ${TRANSFORM_API_VERSION + 7}`));
    assert.ok(!existsSync(out), 'nothing was written');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

// ── running an installed import adapter (EXTENSIONS#ADAPTEREXEC) ───────────
// The adapter half of everything above: same loader, same one-clean-error
// collapse, `bytes` in rather than `html`, and its OWN apiVersion ceiling
// (SPEC EXTENSIONS_ADAPTERS) — decklight import's CLI wiring end to end is
// covered separately in test/units.test.mjs, alongside adapterFor/installUnit.

test('runImporter applies the installed adapter to bytes and reports it unchecked with no catalog behind it', async () => {
  const home = tmp('importer-load-plain');
  try {
    putImporter(home, 'shout', 'export default async function importAdapter(bytes) { return bytes.toString("utf8").toUpperCase(); }\n');
    const { html, checked } = await runImporter('shout', Buffer.from('<p>hi</p>'), home);
    assert.equal(html, '<P>HI</P>');
    assert.equal(checked, false, 'no cached catalog entry names this importer');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a matching catalog entry at or under IMPORTER_API_VERSION runs, and is reported checked', async () => {
  const home = tmp('importer-load-checked');
  try {
    importerMarket(home, { apiVersion: IMPORTER_API_VERSION });
    await installUnit('importer', 'marp-import', home);
    const { checked } = await runImporter('marp-import', Buffer.from('hi'), home);
    assert.equal(checked, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an apiVersion ahead of IMPORTER_API_VERSION refuses to run, naming both numbers', async () => {
  const home = tmp('importer-load-ahead');
  try {
    importerMarket(home, { apiVersion: IMPORTER_API_VERSION + 3 });
    await installUnit('importer', 'marp-import', home);
    await assert.rejects(() => runImporter('marp-import', Buffer.from('hi'), home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, new RegExp(`needs apiVersion ${IMPORTER_API_VERSION + 3}`));
      assert.match(e.message, new RegExp(`up to ${IMPORTER_API_VERSION}`));
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an uninstalled importer names the install command, not a file-not-found error', async () => {
  const home = tmp('importer-missing');
  try {
    await assert.rejects(() => runImporter('nope', Buffer.from('hi'), home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /no importer "nope" installed/);
      assert.match(e.message, /decklight importer add nope, decklight importer list/);
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an importer with no default export function is refused, citing EXTENSIONS_ADAPTERS', async () => {
  const home = tmp('importer-noexport');
  try {
    putImporter(home, 'broken', 'export const importAdapter = () => "x";\n');
    await assert.rejects(() => runImporter('broken', Buffer.from('hi'), home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /no default export function/);
      assert.match(e.message, /EXTENSIONS_ADAPTERS/);
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a throwing importer is reported cleanly, naming it — never a raw stack', async () => {
  const home = tmp('importer-throws');
  try {
    putImporter(home, 'boom', 'export default async function importAdapter() { throw new Error("bad markup"); }\n');
    await assert.rejects(() => runImporter('boom', Buffer.from('hi'), home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /importer "boom" threw: bad markup/);
      assert.doesNotMatch(e.message, /at Object|at async|\.mjs:\d+:\d+/, 'no stack frame leaks through');
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an importer that returns a non-string is refused', async () => {
  const home = tmp('importer-nonstring');
  try {
    putImporter(home, 'wrong', 'export default async function importAdapter() { return { not: "a string" }; }\n');
    await assert.rejects(() => runImporter('wrong', Buffer.from('hi'), home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /must return a string \(returned object\)/);
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('resolveImporter surfaces the same install-command error without running anything', () => {
  const home = tmp('importer-resolve-only');
  try {
    assert.throws(() => resolveImporter('nope', home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /decklight importer add nope, decklight importer list/);
      return true;
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
