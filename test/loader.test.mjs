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
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rmTemp, tmp, cli } from './helpers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveTransform, runTransform, resolveImporter, runImporter,
  resolveEngine, loadEngine, LoaderError,
} from '../cli/loader.mjs';
import { installUnit, unitPath, unitDir, findUnit } from '../cli/units.mjs';
import { TRANSFORM_API_VERSION, IMPORTER_API_VERSION, ENGINE_API_VERSION } from '../cli/marketplace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const DEMO = path.join(ROOT, 'demo/intro.html');


/** The pin a code-carrying catalog entry must carry (SPEC UNIT_PINNING). */
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

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
  const module = body ?? 'export default async function importAdapter(bytes) { return `<section>${bytes.toString("utf8")}</section>`; }\n';
  mkdirSync(path.join(root, '.decklight'), { recursive: true });
  writeFileSync(path.join(root, '.decklight/marketplace.json'), JSON.stringify({
    name: 'cat',
    entries: [{ name, type: 'importer', source, extensions: ['.marp'], apiVersion, sha256: sha256(module) }],
  }, null, 2));
  mkdirSync(path.join(root, source), { recursive: true });
  writeFileSync(path.join(root, source, 'importer.mjs'), module);
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', root],
    { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  return root;
}

/** A local marketplace with one transform entry, registered into `home`. */
function market(home, { apiVersion = TRANSFORM_API_VERSION, name = 'grammar-check', source = 'grammar.mjs', body } = {}) {
  const root = tmp('transform-market');
  const module = body ?? `export default async function transform(html) { return html; }\n`;
  mkdirSync(path.join(root, '.decklight'), { recursive: true });
  writeFileSync(path.join(root, '.decklight/marketplace.json'), JSON.stringify({
    name: 'cat',
    entries: [{ name, type: 'transform', source, apiVersion, sha256: sha256(module) }],
  }, null, 2));
  writeFileSync(path.join(root, source), module);
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', root],
    { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  return root;
}

const run = (args, home, cwd) => cli(args, { home, cwd });

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
  } finally { rmTemp(home); }
});

test('installing does not check apiVersion currency — that is the loader\'s job', async () => {
  const home = tmp('transform-install-ahead');
  try {
    market(home, { apiVersion: TRANSFORM_API_VERSION + 10 });
    const done = await installUnit('transform', 'grammar-check', home);
    assert.equal(done.name, 'grammar-check', 'a catalog written against a newer contract still installs');
  } finally { rmTemp(home); }
});

// ── the loader itself ───────────────────────────────────────────────────────

test('runTransform applies the installed transform and reports it unchecked with no catalog behind it', async () => {
  const home = tmp('transform-load-plain');
  try {
    putTransform(home, 'shout', 'export default async function transform(html) { return html.toUpperCase(); }\n');
    const { html, checked } = await runTransform('shout', '<p>hi</p>', home);
    assert.equal(html, '<P>HI</P>');
    assert.equal(checked, false, 'no cached catalog entry names this transform');
  } finally { rmTemp(home); }
});

test('a matching catalog entry at or under TRANSFORM_API_VERSION runs, and is reported checked', async () => {
  const home = tmp('transform-load-checked');
  try {
    market(home, { apiVersion: TRANSFORM_API_VERSION });
    await installUnit('transform', 'grammar-check', home);
    const { checked } = await runTransform('grammar-check', '<p>hi</p>', home);
    assert.equal(checked, true);
  } finally { rmTemp(home); }
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
  } finally { rmTemp(home); }
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
  } finally { rmTemp(home); }
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
  } finally { rmTemp(home); }
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
  } finally { rmTemp(home); }
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
  } finally { rmTemp(home); }
});

test('resolveTransform surfaces the same install-command error without running anything', () => {
  const home = tmp('transform-resolve-only');
  try {
    assert.throws(() => resolveTransform('nope', home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /decklight transform add nope, decklight transform list/);
      return true;
    });
  } finally { rmTemp(home); }
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
    rmTemp(home);
    rmTemp(path.dirname(out));
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
    rmTemp(home);
    rmTemp(path.dirname(out));
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
    rmTemp(home);
    rmTemp(path.dirname(out));
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
    rmTemp(home);
    rmTemp(path.dirname(out));
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
    rmTemp(home);
    rmTemp(path.dirname(out));
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
  } finally { rmTemp(home); }
});

test('a matching catalog entry at or under IMPORTER_API_VERSION runs, and is reported checked', async () => {
  const home = tmp('importer-load-checked');
  try {
    importerMarket(home, { apiVersion: IMPORTER_API_VERSION });
    await installUnit('importer', 'marp-import', home);
    const { checked } = await runImporter('marp-import', Buffer.from('hi'), home);
    assert.equal(checked, true);
  } finally { rmTemp(home); }
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
  } finally { rmTemp(home); }
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
  } finally { rmTemp(home); }
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
  } finally { rmTemp(home); }
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
  } finally { rmTemp(home); }
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
  } finally { rmTemp(home); }
});

test('resolveImporter surfaces the same install-command error without running anything', () => {
  const home = tmp('importer-resolve-only');
  try {
    assert.throws(() => resolveImporter('nope', home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /decklight importer add nope, decklight importer list/);
      return true;
    });
  } finally { rmTemp(home); }
});

// ── installed speech engines (SPEC ENGINE_UNITS, #267) ─────────────────────
//
// The third code-carrying kind, and the one whose module is a FACTORY rather
// than an (input) => string pass. What it returns is what the bridge speaks
// with, so the shape is checked on the way out of the import — the failure
// this prevents is a missing synth() surfacing as a crash on the first
// sentence of a talk, not at load.

/** Write an engine straight into the library, bypassing install. */
function putEngine(home, name, source) {
  mkdirSync(unitDir('engine', home), { recursive: true });
  writeFileSync(unitPath('engine', name, home), source);
}

const GOOD_ENGINE = 'export default (opts) => ({ name: "azure-tts", model: opts.model ?? "neural",'
  + ' stylable: true, voices: [["Aria", "neural"]],'
  + ' synth: async (t) => ({ wav: Buffer.from("RIFF"), usage: { chars: t.length } }) });\n';

/** A local marketplace with one engine entry, registered into `home`. */
function engineMarket(home, {
  apiVersion = ENGINE_API_VERSION, capability = 'tts',
  name = 'azure-tts', source = 'azure.mjs', body,
} = {}) {
  const root = tmp('engine-market');
  const module = body ?? GOOD_ENGINE;
  mkdirSync(path.join(root, '.decklight'), { recursive: true });
  writeFileSync(path.join(root, '.decklight/marketplace.json'), JSON.stringify({
    name: 'cat',
    entries: [{ name, type: 'engine', source, apiVersion, capability, sha256: sha256(module) }],
  }, null, 2));
  writeFileSync(path.join(root, source), module);
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', root],
    { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  return root;
}

test('an engine installs, lists and removes through the same seam as every other unit', () => {
  const home = tmp('engine-cli');
  try {
    engineMarket(home);
    let { code, out } = run(['engine', 'add', 'azure-tts'], home);
    assert.equal(code, 0, out);
    assert.match(out, /installed azure-tts/);
    assert.ok(existsSync(unitPath('engine', 'azure-tts', home)), 'lands in ~/.decklight/engines/');

    ({ code, out } = run(['engine', 'list'], home));
    assert.equal(code, 0, out);
    assert.match(out, /azure-tts/);

    ({ code, out } = run(['engine', 'remove', 'azure-tts'], home));
    assert.equal(code, 0, out);
    assert.equal(existsSync(unitPath('engine', 'azure-tts', home)), false);
  } finally { rmTemp(home); }
});

test('an installed engine loads and speaks, and reports it was installed', async () => {
  const home = tmp('engine-load');
  try {
    engineMarket(home);
    assert.equal(run(['engine', 'add', 'azure-tts'], home).code, 0);
    const engine = await loadEngine('azure-tts', { model: 'custom' }, home);
    assert.equal(engine.name, 'azure-tts');
    assert.equal(engine.model, 'custom', 'opts reach the factory untouched');
    assert.equal(engine.stylable, true);
    assert.deepEqual(engine.voices, [['Aria', 'neural']]);
    assert.equal(engine.installed, true);
    assert.equal(engine.checked, true, 'a cached catalog entry means apiVersion WAS checked');
    const { usage } = await engine.synth('hello');
    assert.equal(usage.chars, 5);
  } finally { rmTemp(home); }
});

test('an engine is PINNED like every other code-carrying unit (SPEC UNIT_PINNING)', () => {
  const home = tmp('engine-pin');
  try {
    // the catalog's digest does not match the module it points at
    const root = engineMarket(home);
    writeFileSync(path.join(root, 'azure.mjs'), GOOD_ENGINE + '// tampered after publication\n');
    const { code, out } = run(['engine', 'add', 'azure-tts'], home);
    assert.notEqual(code, 0, out);
    assert.match(out, /sha256|digest|pin/i);
    assert.equal(existsSync(unitPath('engine', 'azure-tts', home)), false, 'refused BEFORE any write');
  } finally { rmTemp(home); }
});

test('apiVersion is the loader\'s check, and capability is refused only at load', async () => {
  const ahead = tmp('engine-ahead');
  try {
    engineMarket(ahead, { apiVersion: ENGINE_API_VERSION + 1 });
    // installs fine — the catalog only ever validated the SHAPE
    assert.equal(run(['engine', 'add', 'azure-tts'], ahead).code, 0);
    await assert.rejects(() => loadEngine('azure-tts', {}, ahead), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, new RegExp(`needs apiVersion ${ENGINE_API_VERSION + 1}`));
      assert.match(e.message, /upgrade decklight/);
      return true;
    });
  } finally { rmTemp(ahead); }

  const other = tmp('engine-capability');
  try {
    // a capability this decklight does not run: addable (a catalog written for
    // a newer decklight must not be invalidated), refused when actually loaded.
    // `transcription` is deliberately a kind decklight has no affordance for —
    // `lipsync` stopped being one the moment ENGINES#LIPSYNC landed.
    engineMarket(other, { capability: 'transcription' });
    assert.equal(run(['engine', 'add', 'azure-tts'], other).code, 0, 'still installs');
    assert.throws(() => resolveEngine('azure-tts', other), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /is a transcription engine.*only runs: tts, lipsync/);
      return true;
    });
  } finally { rmTemp(other); }
});

test('every way an engine can be malformed is one clean, engine-naming error', async () => {
  const home = tmp('engine-bad');
  try {
    const cases = [
      ['no-default', 'export const nope = 1;\n', /has no default export function/],
      ['no-synth', 'export default () => ({ name: "x", voices: [] });\n',
        /returned no synth\(\) — there is nothing to speak with/],
      ['no-roster', 'export default () => ({ name: "x", synth: async () => ({}) });\n',
        /neither a voices array nor listVoices\(\)/],
      ['throws', 'export default () => { throw new Error("no API key"); };\n',
        /threw while starting: no API key/],
      ['not-an-object', 'export default () => 42;\n', /must return an engine object \(returned number\)/],
    ];
    for (const [name, body, expected] of cases) {
      putEngine(home, name, body);
      await assert.rejects(() => loadEngine(name, {}, home), (e) => {
        assert.ok(e instanceof LoaderError, `${name} threw ${e.constructor.name}`);
        assert.match(e.message, expected);
        assert.match(e.message, new RegExp(`"${name}"`), 'the refusal names the engine');
        assert.doesNotMatch(e.message, /\n\s+at /, 'never a raw stack');
        return true;
      });
    }
  } finally { rmTemp(home); }
});

test('stylable defaults to FALSE — an engine that does not say gets no tone step', async () => {
  const home = tmp('engine-stylable');
  try {
    // no `stylable` at all: the picker must not offer a delivery instruction
    // to an engine that never claimed a channel for one (SPEC PRESENTING)
    putEngine(home, 'quiet', 'export default () => ({ name: "quiet", voices: [["V", "x"]],'
      + ' synth: async () => ({ wav: Buffer.alloc(0), usage: {} }) });\n');
    const engine = await loadEngine('quiet', {}, home);
    assert.equal(engine.stylable, false);

    // and a truthy-but-not-true value is not enough either
    putEngine(home, 'sloppy', 'export default () => ({ name: "s", stylable: "yes", voices: [],'
      + ' listVoices: async () => [], synth: async () => ({ wav: Buffer.alloc(0), usage: {} }) });\n');
    assert.equal((await loadEngine('sloppy', {}, home)).stylable, false);
  } finally { rmTemp(home); }
});

test('an engine with no cached catalog entry still runs, and says it was unchecked', async () => {
  const home = tmp('engine-uncatalogued');
  try {
    putEngine(home, 'handmade', GOOD_ENGINE);
    const engine = await loadEngine('handmade', {}, home);
    assert.equal(engine.checked, false);
    assert.equal(engine.name, 'azure-tts', 'the factory names itself; the unit name is the fallback');
  } finally { rmTemp(home); }
});

test('resolveEngine surfaces the install command without importing anything', () => {
  const home = tmp('engine-resolve-only');
  try {
    assert.throws(() => resolveEngine('nope', home), (e) => {
      assert.ok(e instanceof LoaderError);
      assert.match(e.message, /decklight engine add nope, decklight engine list/);
      return true;
    });
  } finally { rmTemp(home); }
});
