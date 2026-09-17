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
import { rmTemp, tmp as scratch } from './helpers.mjs';
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
  // --inline: these tests are about the embedded runtime; init links it by default (#517)
  execFileSync('node', [CLI, 'init', 'Old Deck', '--dir', dir, '--no-skill', '--inline', '--themes', themes],
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

const tmp = () => scratch('upgrade');

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
  rmTemp(dir);
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
  rmTemp(dir);
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
  rmTemp(dir);
});

test('a freshly scaffolded deck is marked and already current — data by default, embedded with --inline', () => {
  // the default scaffold is slides plus a configuration block (#520): always
  // current, and the block records the version it was written for
  const dataDir = tmp();
  execFileSync('node', [CLI, 'init', '--dir', dataDir, '--no-skill'], { encoding: 'utf8' });
  const dp = path.join(dataDir, 'deck.html');
  const data = fs.readFileSync(dp, 'utf8');
  assert.match(data, /<script type="application\/json" data-decklight-config>\n\s*\{ "decklight": "[^"]+", "theme": "aurora" \}/);
  assert.doesNotMatch(data, /decklight\.js|Decklight\.init/, 'no runtime, no boot call');
  const dout = execFileSync('node', [CLI, 'upgrade', dp], { encoding: 'utf8' });
  assert.match(dout, /slides and a configuration block, written for decklight .* already current/);
  assert.equal(fs.readFileSync(dp, 'utf8'), data);
  // an older record is refreshed in place — the block's own formatting kept
  fs.writeFileSync(dp, data.replace(/"decklight": "[^"]+"/, '"decklight": "0.1.0"'));
  const dry = execFileSync('node', [CLI, 'upgrade', dp, '--dry-run'], { encoding: 'utf8' });
  assert.match(dry, /would record it as written for decklight .* \(was 0\.1\.0\)/);
  assert.match(fs.readFileSync(dp, 'utf8'), /0\.1\.0/, 'dry run wrote nothing');
  const rec = execFileSync('node', [CLI, 'upgrade', dp], { encoding: 'utf8' });
  assert.match(rec, /now recorded as written for decklight .* \(was 0\.1\.0\)/);
  assert.equal(fs.readFileSync(dp, 'utf8'), data, 'the record is the only byte that moved');
  assert.match(execFileSync('node', [CLI, 'upgrade', dp, '--link'], { encoding: 'utf8' }), /already slides and a configuration block/);
  rmTemp(dataDir);

  const dir = tmp();
  execFileSync('node', [CLI, 'init', '--dir', dir, '--no-skill', '--inline', '--themes', 'aurora'], { encoding: 'utf8' });
  const p = path.join(dir, 'deck.html');
  const deck = fs.readFileSync(p, 'utf8');
  // init marks the blocks it writes from now on
  assert.match(deck, /<style data-decklight-runtime="css">/);
  assert.match(deck, /<script data-decklight-runtime="js">/);

  const out = execFileSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.match(out, /already current/);
  assert.equal(fs.readFileSync(p, 'utf8'), deck);
  rmTemp(dir);
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
  rmTemp(dir);
});

test('a theme added from outside decklight (data-theme-added) gets its own warning — never a fetch (MARKETPLACE.md OPEN 1)', () => {
  const dir = tmp();
  const p = oldDeck(dir);
  let deck = fs.readFileSync(p, 'utf8');
  // The same "not in themes/" situation as a retired theme, but marked the
  // way theme add/Browse mark an installed block (SPEC THEME_DISTRIBUTION) —
  // upgrade has to tell the two apart rather than call this one "retired"
  // when decklight never shipped it in the first place.
  deck = deck.replace('</head>',
    '  <style data-theme="nord-deep" data-theme-added media="not all">.decklight.theme-nord-deep{--bg:#000}</style>\n</head>');
  fs.writeFileSync(p, deck);

  const out = execFileSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.match(out, /warning: theme "nord-deep" was added from outside decklight \(theme add\/Browse\) — not decklight's to refresh; kept as-is/);
  assert.doesNotMatch(out, /no longer ships upstream/, 'an added theme was never "upstream" to begin with');
  const after = fs.readFileSync(p, 'utf8');
  assert.equal(after.includes('.decklight.theme-nord-deep{--bg:#000}'), true, 'kept as-is, byte for byte');
  rmTemp(dir);
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
  rmTemp(dir);
});

// A multi-module deck that has been hand-edited since, with the per-module sources
// long gone, IS the source of truth — and the refusal that used to stand here
// protected a re-merge nobody could do (#483).
const multiModuleDeck = (dir) => {
  const p = oldDeck(dir);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
    .replace('<section data-pin="none">', '<section data-module="Module One" data-pin="none">'));
  return p;
};

test('a multi-module deck upgrades like any other deck', () => {
  const dir = tmp();
  const p = multiModuleDeck(dir);
  const before = fs.readFileSync(p, 'utf8');
  const r = spawnSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const after = fs.readFileSync(p, 'utf8');
  assert.notEqual(after, before, 'the runtime was actually swapped');
  assert.match(after, /data-module="Module One"/, 'and the markers are left alone');
  assert.equal(fs.existsSync(`${p}.bak`), true, 'with the backup every upgrade writes');

  // said, not refused: the information the old refusal carried is still there
  assert.match(r.stdout, /this is a multi-module deck \(bundle --all\)/);
  assert.doesNotMatch(r.stdout, /merged/, 'named for what the file is, not how it was made (#503)');
  assert.match(r.stdout, /overwrites this file/);

  // and everything else behaves as it does for a single deck
  const again = spawnSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already current/);
  rmTemp(dir);
});

test('--dry-run on a multi-module deck previews without writing', () => {
  const dir = tmp();
  const p = multiModuleDeck(dir);
  const before = fs.readFileSync(p, 'utf8');
  const r = spawnSync('node', [CLI, 'upgrade', p, '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'touched nothing');
  assert.equal(fs.existsSync(`${p}.bak`), false);
  rmTemp(dir);
});

test('--all is still refused, as bundle\'s flag rather than a workflow lecture', () => {
  const dir = tmp();
  const p = multiModuleDeck(dir);
  const r = spawnSync('node', [CLI, 'upgrade', p, '--all'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not an upgrade flag/);
  rmTemp(dir);
});

// ── a deck that LINKS the runtime (#517) ─────────────────────────────────
test('a deck that links the runtime is always current — upgrade only records the version it is written for', () => {
  const dir = tmp();
  const p = path.join(dir, 'linked.html');
  const body = `<!doctype html><html><head>
  <link rel="stylesheet" href="decklight/dist/decklight.css">
</head><body><div class="decklight"><section><h1>Hi</h1></section></div>
<script src="decklight/dist/decklight.js"></script>
<script>Decklight.init({})</script>
</body></html>`;
  fs.writeFileSync(p, body);
  // no record of a version: one is written, nothing else moves
  const r = spawnSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /links the runtime — now recorded as written for decklight \d/);
  const after = fs.readFileSync(p, 'utf8');
  assert.match(after, /<script src="decklight\/dist\/decklight\.js" data-decklight-version="[^"]+"><\/script>/);
  assert.equal(after.replace(/ data-decklight-version="[^"]+"/, ''), body, 'byte-for-byte otherwise');
  assert.ok(fs.existsSync(`${p}.bak`));
  // already recorded as this version: nothing to do, and it says so
  const again = spawnSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /links the runtime and is written for decklight .* already current/);
  assert.equal(fs.readFileSync(p, 'utf8'), after);
  // an older record is refreshed — the thing present --check compares
  fs.writeFileSync(p, after.replace(/data-decklight-version="[^"]+"/, 'data-decklight-version="0.1.0"'));
  const dry = spawnSync('node', [CLI, 'upgrade', p, '--dry-run'], { encoding: 'utf8' });
  assert.match(dry.stdout, /would record it as written for decklight .* \(was 0\.1\.0\)/);
  assert.match(fs.readFileSync(p, 'utf8'), /0\.1\.0/, 'dry run wrote nothing');
  rmTemp(dir);
});

test('upgrade --link is the reverse of bundle: the deck becomes slides plus a configuration block, the author’s deck survives byte-for-byte', () => {
  const dir = tmp();
  const p = oldDeck(dir, { themes: 'aurora,graphite' });
  const before = fs.readFileSync(p, 'utf8');
  const r = spawnSync('node', [CLI, 'upgrade', p, '--link'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is now slides and a configuration block, written for decklight/);
  assert.match(r.stdout, /runtime js \(.* → gone; the servers add it\)/);
  assert.match(r.stdout, /theme aurora → the configuration block, 1 embedded theme dropped/);
  assert.match(r.stdout, /the Decklight\.init call → the configuration block/);
  const after = fs.readFileSync(p, 'utf8');
  assert.doesNotMatch(after, /<script src=|<link rel="stylesheet"/, 'nothing referenced either — the servers add the runtime');
  assert.doesNotMatch(after, /data-theme="graphite"|data-theme="aurora"/, 'the embedded themes are gone — the servers link the active one, the picker fetches the rest');
  assert.doesNotMatch(after, /window\.Decklight\s*=|var Decklight|Decklight\.init/, 'no runtime, no boot call left inside');
  // the init argument became the block, as data, with the theme beside it
  const block = /<script type="application\/json" data-decklight-config>\n([\s\S]*?)\n\s*<\/script>/.exec(after);
  assert.ok(block, 'a configuration block');
  const cfg = JSON.parse(block[1]);
  assert.equal(cfg.theme, 'aurora');
  assert.equal(cfg.transition, 'fade', 'the init argument, as data');
  assert.match(cfg.decklight, /^\d+\.\d+\.\d+/);
  // everything the author wrote is still there, untouched
  for (const piece of [SENTINEL, AUTHOR_STYLE, AUTHOR_SCRIPT]) assert.ok(after.includes(piece), `kept: ${piece.slice(0, 40)}`);
  // the fixture's runtime is a stub, so the drop is modest here; a real deck loses ~600 KB
  assert.ok(after.length < before.length / 2, `smaller (${before.length} → ${after.length})`);
  assert.ok(fs.existsSync(`${p}.bak`));
  // and the deck is now always current
  const again = spawnSync('node', [CLI, 'upgrade', p], { encoding: 'utf8' });
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already current/);
  rmTemp(dir);
});

test('upgrade --link keeps a Decklight.init call whose argument is code — the JS API’s escape hatch', () => {
  const dir = tmp();
  const p = oldDeck(dir, { themes: 'aurora' });
  const code = 'Decklight.init({ transition: window.T || "fade" })';
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(INIT_CONFIG, code));
  const r = spawnSync('node', [CLI, 'upgrade', p, '--link'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /warning: the Decklight\.init argument is code, not data — the call stays/);
  const after = fs.readFileSync(p, 'utf8');
  assert.ok(after.includes(code), 'the call is kept verbatim');
  assert.match(after, /data-decklight-config>\n\s*\{ "decklight": "[^"]+", "theme": "aurora" \}/, 'the block carries the version and the theme');
  assert.doesNotMatch(after, /var Decklight|window\.Decklight\s*=/, 'the embedded runtime is gone');
  rmTemp(dir);
});
