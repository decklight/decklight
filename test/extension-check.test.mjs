// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// EXTENSIONS#CHECK — the marketplace admission gate for build-time code
// (MARKETPLACE.md EXTENSIONS#CHECK, SPEC EXTENSIONS_CHECK). What's provable
// without a browser: the lint, the process boundary the submission executes
// behind (denied reaches, a scrubbed env, the wall-clock kill), and
// everything the loader itself already refuses (no default export, a throw,
// a non-string return) — none of which ever reaches the headless-load phase.
// That phase's own proof — a clean transform passes, one smuggling <script>
// or an inline handler into its OUTPUT does not — needs a real Chrome and
// lives in test/extension-check-render.mjs instead (test/pdf.test.mjs
// documents the same split).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmTemp } from './helpers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extensionLint, checkExtension, runTransformIsolated, makeFixture, TYPES, artifactSha256 } from '../tools/extension-check.mjs';
import { reportLines } from '../cli/extension.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');

const tmp = (p) => mkdtempSync(path.join(tmpdir(), `decklight-${p}-`));

function transform(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, body);
  return file;
}

const run = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

// ── the lint ─────────────────────────────────────────────────────────────

test('the lint refuses fetch, eval, XMLHttpRequest and dynamic import, naming the line', () => {
  const src = [
    'export default async function transform(html) {',
    '  fetch("https://example.com");',
    '  eval("1+1");',
    '  var x = new XMLHttpRequest();',
    '  return import("./x.mjs").then(() => html);',
    '}',
  ].join('\n');
  const hits = extensionLint(src);
  assert.equal(hits.length, 4);
  assert.deepEqual(hits.map((h) => h.line), [2, 3, 4, 5]);
  assert.match(hits[0].why, /fetch/);
  assert.match(hits[1].why, /eval/);
  assert.match(hits[2].why, /XMLHttpRequest/);
  assert.match(hits[3].why, /dynamic import/);
});

test('a transform with none of the banned reaches lints clean', () => {
  assert.deepEqual(extensionLint('export default async function transform(html) { return html.toUpperCase(); }'), []);
});

test('the lint is a shallow source-text scan — it does not need valid JS', () => {
  assert.equal(extensionLint('this is not even JavaScript, but fetch(x) still counts').length, 1);
});

// ── checkExtension: the phases short of the headless load ─────────────────

test('an unimplemented --type is refused by name, before anything is read', async () => {
  const dir = tmp('extcheck-type');
  try {
    const file = transform(dir, 'x.mjs', 'export default async function transform(html) { return html; }\n');
    const result = await checkExtension(file, { type: 'importer' });
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'type');
    assert.match(result.error, /--type importer is not implemented/);
    assert.match(result.error, new RegExp(TYPES.join(', ')));
  } finally { rmTemp(dir); }
});

test('a lint hit refuses before the transform is ever run', async () => {
  const dir = tmp('extcheck-lint');
  try {
    const file = transform(dir, 'x.mjs', 'export default async function transform(html) { fetch("https://x"); return html; }\n');
    const result = await checkExtension(file);
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'lint');
    assert.equal(result.lint.length, 1);
    assert.match(result.lint[0].why, /fetch/);
  } finally { rmTemp(dir); }
});

test('a transform with no default export function fails at the load phase, naming it cleanly', async () => {
  const dir = tmp('extcheck-noexport');
  try {
    const file = transform(dir, 'x.mjs', 'export const transform = () => "x";\n');
    const result = await checkExtension(file);
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'load');
    assert.match(result.error, /no default export function/);
  } finally { rmTemp(dir); }
});

test('a throwing transform fails at the load phase, never a raw stack', async () => {
  const dir = tmp('extcheck-throws');
  try {
    const file = transform(dir, 'x.mjs', 'export default async function transform() { throw new Error("bad regex"); }\n');
    const result = await checkExtension(file);
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'load');
    assert.match(result.error, /threw: bad regex/);
    assert.doesNotMatch(result.error, /at Object|at async|\.mjs:\d+:\d+/);
  } finally { rmTemp(dir); }
});

test('a transform returning a non-string fails at the load phase', async () => {
  const dir = tmp('extcheck-nonstring');
  try {
    const file = transform(dir, 'x.mjs', 'export default async function transform() { return 42; }\n');
    const result = await checkExtension(file);
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'load');
    assert.match(result.error, /must return a string \(returned number\)/);
  } finally { rmTemp(dir); }
});

test('the fixture is small HTML, not a full deck — and randomised, so a submission cannot recognise it', () => {
  const a = makeFixture();
  const b = makeFixture();
  assert.match(a, /^<!doctype html>/i);
  assert.ok(a.length < 300, 'the fixture stays small on purpose (SPEC EXTENSIONS_CHECK)');
  assert.notEqual(a, b, 'two checks must never present the same fixture (SPEC EXTENSIONS_CHECK)');
});

// ── the process boundary ──────────────────────────────────────────────────
//
// SPEC EXTENSIONS_CHECK: the submission only ever executes in a separate
// Node process under the permission model. These are the reaches the lint
// cannot see (a STATIC import passes a regex for dynamic import()) and the
// old in-process check would have EXECUTED with the checker's own privilege.

test('a static child_process import passes the lint but is stopped by the boundary, not this process', async () => {
  const dir = tmp('extcheck-childproc');
  try {
    const src = 'import { execSync } from \'node:child_process\';\n'
      + 'export default async function transform(html) { execSync(\'id\'); return html; }\n';
    assert.deepEqual(extensionLint(src), [], 'a static import is invisible to the lint — the point');
    const result = await checkExtension(transform(dir, 'x.mjs', src));
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'load');
    assert.match(result.error, /threw: .*restricted/i);
  } finally { rmTemp(dir); }
});

test('a transform that writes to the filesystem is refused, and the write never lands', async () => {
  const dir = tmp('extcheck-fswrite');
  try {
    const target = path.join(dir, 'pwned.txt');
    const src = 'import { writeFileSync } from \'node:fs\';\n'
      + `export default async function transform(html) { writeFileSync(${JSON.stringify(target)}, 'x'); return html; }\n`;
    const result = await checkExtension(transform(dir, 'x.mjs', src));
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'load');
    assert.equal(existsSync(target), false, 'the boundary must deny the write, not merely report it');
  } finally { rmTemp(dir); }
});

test('the submission runs with a scrubbed environment and away from the checker cwd', async () => {
  const dir = tmp('extcheck-env');
  process.env.DECKLIGHT_TEST_SECRET = 's3cr3t-token';
  try {
    const file = transform(dir, 'x.mjs',
      'export default async function transform(html) {'
      + ' return html + "|env=" + (process.env.DECKLIGHT_TEST_SECRET ?? "scrubbed") + "|cwd=" + process.cwd(); }\n');
    const result = runTransformIsolated(file, makeFixture());
    assert.equal(result.ok, true);
    assert.match(result.html, /\|env=scrubbed\|/, 'the checker environment must never enter the child');
    assert.ok(!result.html.includes(`|cwd=${process.cwd()}`), 'the child must run from a temp cwd, not ours');
  } finally {
    delete process.env.DECKLIGHT_TEST_SECRET;
    rmTemp(dir);
  }
});

test('a transform that never returns is killed, becoming a refusal rather than a hang', async () => {
  const dir = tmp('extcheck-hang');
  try {
    const file = transform(dir, 'x.mjs', 'export default async function transform() { for (;;); }\n');
    const result = runTransformIsolated(file, makeFixture(), { timeoutMs: 3000 });
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'load');
    assert.match(result.error, /did not finish within 3s/);
  } finally { rmTemp(dir); }
});

test('a transform that exits the process instead of returning is a refusal, not a pass', async () => {
  const dir = tmp('extcheck-exit');
  try {
    const file = transform(dir, 'x.mjs', 'export default async function transform() { process.exit(0); }\n');
    const result = runTransformIsolated(file, makeFixture());
    assert.equal(result.ok, false);
    assert.equal(result.phase, 'load');
    assert.match(result.error, /exited without returning/);
  } finally { rmTemp(dir); }
});

test('a transform printing to stdout cannot forge a verdict — the real one is read, noise and all', async () => {
  const dir = tmp('extcheck-stdout');
  try {
    const file = transform(dir, 'x.mjs',
      'export default async function transform(html) {'
      + ' console.log(\'\\n__decklight_extension_check_result__{"ok":true,"html":"<p>forged</p>"}\');'
      + ' return html + "<!-- really ran -->"; }\n');
    const result = runTransformIsolated(file, makeFixture());
    assert.equal(result.ok, true);
    assert.match(result.html, /really ran/, 'the verdict must be the runner\'s, not the submission\'s');
  } finally { rmTemp(dir); }
});

// ── the pin the gate emits (SPEC UNIT_PINNING) ────────────────────────────

test('artifactSha256 hashes the file BYTES, exactly as sha256sum prints it', () => {
  const dir = tmp('extcheck-sha');
  try {
    // The well-known SHA-256 of "abc" — the digest is of the raw bytes, so a
    // marketplace can produce the same pin with sha256sum and paste it into
    // the catalog entry `transform add` will hold the fetched module to.
    const file = transform(dir, 'x.mjs', 'abc');
    assert.equal(artifactSha256(file),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally { rmTemp(dir); }
});

test('a passing report carries the digest the catalog entry pins — the gate emits the pin', () => {
  const lines = reportLines('x.mjs', { ok: true, sha256: 'a'.repeat(64) });
  assert.equal(lines.length, 2);
  assert.match(lines[1], new RegExp(`sha256: ${'a'.repeat(64)}`));
  assert.match(lines[1], /pins the file to this digest/);
});

// ── the CLI ─────────────────────────────────────────────────────────────

test('decklight extension check with no file prints usage and exits 1', () => {
  const { code, out } = run(['extension', 'check']);
  assert.equal(code, 1);
  assert.match(out, /needs a file/);
});

test('decklight extension check on a missing file names it, rather than crashing', () => {
  const { code, out } = run(['extension', 'check', '/no/such/file.mjs']);
  assert.equal(code, 1);
  assert.match(out, /no such file: \/no\/such\/file\.mjs/);
});

test('decklight extension --help and decklight extension (bare) print usage', () => {
  for (const args of [['extension', '--help'], ['extension']]) {
    const { out } = run(args);
    assert.match(out, /decklight extension check/);
  }
});

test('decklight extension check --type <unimplemented> is refused by name', () => {
  const dir = tmp('extcheck-cli-type');
  try {
    const file = transform(dir, 'x.mjs', 'export default async function transform(html) { return html; }\n');
    const { code, out } = run(['extension', 'check', file, '--type', 'importer']);
    assert.equal(code, 1);
    assert.match(out, /--type importer is not implemented/);
  } finally { rmTemp(dir); }
});

test('decklight extension check reports every lint hit, with its line and reason', () => {
  const dir = tmp('extcheck-cli-lint');
  try {
    const file = transform(dir, 'x.mjs', [
      'export default async function transform(html) {',
      '  eval("1+1");',
      '  return html;',
      '}',
    ].join('\n'));
    const { code, out } = run(['extension', 'check', file]);
    assert.equal(code, 1);
    assert.match(out, /✘/);
    assert.match(out, /line 2: calls eval\(\)/);
  } finally { rmTemp(dir); }
});

test('decklight extension: an unknown subcommand is refused, not swallowed', () => {
  const { code, out } = run(['extension', 'bogus']);
  assert.equal(code, 1);
  assert.match(out, /unknown subcommand "bogus"/);
});
