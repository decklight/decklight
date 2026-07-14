// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight upgrade`: swap a self-contained deck's inlined runtime for the
// installed dist/ builds — and nothing else. The "old" decks here are built
// by scaffolding with init, then rewinding: markers stripped (the pre-0.3
// unmarked form) and the runtime payloads replaced by era-appropriate stubs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const scriptSafe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\u0021--');
const DIST_CSS = fs.readFileSync(path.resolve(here, '../dist/decklight.css'), 'utf8');
const DIST_JS = scriptSafe(
  fs.readFileSync(path.resolve(here, '../dist/decklight.js'), 'utf8')
    .replace(/\/\/# sourceMappingURL=.*$/m, ''));

const SENTINEL = `    <section data-pin="none">
      <h2>SENTINEL — the author wrote this</h2>
      <p>weird   spacing,\ttabs, and <em>markup</em> must survive byte-for-byte</p>
      <aside class="notes"><p>sentinel notes ⟨CLICK⟩ segmented</p></aside>
    </section>`;
const AUTHOR_STYLE = '<style>/* author css */ .mine { color: hotpink }</style>';
const AUTHOR_SCRIPT = "<script>/* author js */ window.__mine = 1;</script>";
const INIT_CONFIG = "Decklight.init({ transition: 'fade', slideNumber: 'n/N' })";
const OLD_CSS_STUB = '.decklight { position: fixed; inset: 0; } /* 0.1.x-era structural css */';
const OLD_JS_STUB = 'var Decklight=(()=>({init:()=>({state:{}})}))(); /* 0.1.x-era runtime */';

/** Scaffold with init, then rewind it into an unmarked deck with an old
 *  runtime, a sentinel slide, an author style + script, and a real config. */
function oldDeck(dir, { themes = 'aurora,graphite' } = {}) {
  execFileSync('node', [CLI, 'init', 'Old Deck', '--dir', dir, '--no-skill', '--themes', themes],
    { encoding: 'utf8' });
  const p = path.join(dir, 'deck.html');
  let deck = fs.readFileSync(p, 'utf8');
  deck = deck
    .replace(/<style data-decklight-runtime="css">[\s\S]*?<\/style>/,
      `<style>\n${OLD_CSS_STUB}\n  </style>`)
    .replace(/<script data-decklight-runtime="js">[\s\S]*?<\/script>/,
      `<script>${OLD_JS_STUB}</script>`)
    .replace('Decklight.init({})', INIT_CONFIG)
    .replace('  </div>', SENTINEL + '\n\n  </div>')
    .replace('</head>', `  ${AUTHOR_STYLE}\n</head>`)
    .replace('</body>', `  ${AUTHOR_SCRIPT}\n</body>`);
  assert.doesNotMatch(deck, /data-decklight-runtime/, 'the rewound deck must be unmarked');
  fs.writeFileSync(p, deck);
  return p;
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-upgrade-'));

test('upgrade swaps the unmarked runtime blocks and preserves everything the author wrote', () => {
  const dir = tmp();
  const p = oldDeck(dir);
  const before = fs.readFileSync(p, 'utf8');

  const out = execFileSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.match(out, /upgraded .*deck\.html/);
  const deck = fs.readFileSync(p, 'utf8');

  // the old runtime is gone, the installed dist builds are in, marked
  assert.doesNotMatch(deck, /0\.1\.x-era/);
  assert.equal(deck.includes(`<script data-decklight-runtime="js">${DIST_JS}</script>`), true,
    'runtime js is the installed dist build, marked');
  assert.equal(deck.includes(`<style data-decklight-runtime="css">\n${DIST_CSS}\n  </style>`), true,
    'runtime css is the installed dist build, marked');

  // the author's content survives byte-for-byte
  for (const kept of [SENTINEL, AUTHOR_STYLE, AUTHOR_SCRIPT, INIT_CONFIG]) {
    assert.equal(deck.includes(kept), true, `author content lost: ${kept.slice(0, 40)}…`);
  }

  // backup written first, holding the pre-upgrade bytes
  assert.equal(fs.readFileSync(`${p}.bak`, 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upgrade --dry-run prints the plan and touches nothing', () => {
  const dir = tmp();
  const p = oldDeck(dir);
  const before = fs.readFileSync(p, 'utf8');
  const out = execFileSync('node', [CLI, 'upgrade', p, '--dry-run'], { encoding: 'utf8' });
  assert.match(out, /dry run/);
  assert.match(out, /would update runtime js/);
  assert.match(out, /would update runtime css/);
  assert.equal(fs.readFileSync(p, 'utf8'), before, '--dry-run must not modify the deck');
  assert.equal(fs.existsSync(`${p}.bak`), false, '--dry-run must not write a backup');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upgrade is idempotent: a second run reports already current and changes nothing', () => {
  const dir = tmp();
  const p = oldDeck(dir);
  execFileSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  const upgraded = fs.readFileSync(p, 'utf8');
  fs.rmSync(`${p}.bak`);

  const out = execFileSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.match(out, /already current/);
  assert.equal(fs.readFileSync(p, 'utf8'), upgraded, 'second run must be a byte-level no-op');
  assert.equal(fs.existsSync(`${p}.bak`), false, 'a no-op run must not write a backup');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a freshly scaffolded deck is marked and already current', () => {
  const dir = tmp();
  execFileSync('node', [CLI, 'init', '--dir', dir, '--no-skill', '--themes', 'aurora'], { encoding: 'utf8' });
  const p = path.join(dir, 'deck.html');
  const deck = fs.readFileSync(p, 'utf8');
  // init marks the blocks it writes from now on
  assert.match(deck, /<style data-decklight-runtime="css">/);
  assert.match(deck, /<script data-decklight-runtime="js">/);

  const out = execFileSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.match(out, /already current/);
  assert.equal(fs.readFileSync(p, 'utf8'), deck);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('theme blocks refresh from the installed themes/, active one stays active, orphans kept with a warning', () => {
  const dir = tmp();
  const p = oldDeck(dir); // aurora active, graphite media="not all"
  let deck = fs.readFileSync(p, 'utf8');
  // age both theme blocks, and plant one that no longer ships upstream
  deck = deck
    .replace(/(<style data-theme="aurora">)[\s\S]*?(<\/style>)/, '$1\n.decklight.theme-aurora{--bg:#000}\n  $2')
    .replace(/(<style data-theme="graphite" media="not all">)[\s\S]*?(<\/style>)/, '$1\n.decklight.theme-graphite{--bg:#111}\n  $2')
    .replace('</head>', '  <style data-theme="retired-theme" media="not all">.decklight.theme-retired-theme{--bg:#222}</style>\n</head>');
  fs.writeFileSync(p, deck);

  const out = execFileSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.match(out, /warning: theme "retired-theme" no longer ships upstream — kept as-is/);
  const after = fs.readFileSync(p, 'utf8');

  const aurora = fs.readFileSync(path.resolve(here, '../themes/aurora.css'), 'utf8').trim();
  const graphite = fs.readFileSync(path.resolve(here, '../themes/graphite.css'), 'utf8').trim();
  assert.equal(after.includes(`<style data-theme="aurora">\n${aurora}`), true,
    'aurora refreshed, still active (no media attribute)');
  assert.equal(after.includes(`<style data-theme="graphite" media="not all">\n${graphite}`), true,
    'graphite refreshed, still inactive');
  assert.equal(after.includes('.decklight.theme-retired-theme{--bg:#222}'), true,
    'a theme that no longer ships is kept as-is');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file with no Decklight.init is refused: exit 1, clear message, file untouched', () => {
  const dir = tmp();
  const p = path.join(dir, 'page.html');
  const src = '<!doctype html><html><head><style>.decklight{}</style></head><body><p>hi</p></body></html>';
  fs.writeFileSync(p, src);
  const r = spawnSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a Decklight deck/);
  assert.equal(fs.readFileSync(p, 'utf8'), src);
  assert.equal(fs.existsSync(`${p}.bak`), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a merged multi-module bundle is refused politely', () => {
  const dir = tmp();
  const p = oldDeck(dir);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
    .replace('<section data-pin="none">', '<section data-module="Module One" data-pin="none">'));
  const before = fs.readFileSync(p, 'utf8');
  const r = spawnSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /merged multi-module bundle/);
  assert.equal(fs.readFileSync(p, 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a deck that references the runtime by src= is refused with a pointer to bundle', () => {
  const dir = tmp();
  const p = path.join(dir, 'linked.html');
  fs.writeFileSync(p, `<!doctype html><html><head>
  <link rel="stylesheet" href="decklight/dist/decklight.css">
</head><body><div class="decklight"><section><h1>Hi</h1></section></div>
<script src="decklight/dist/decklight.js"></script>
<script>Decklight.init({})</script>
</body></html>`);
  const r = spawnSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not self-contained/);
  fs.rmSync(dir, { recursive: true, force: true });
});
