// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight theme` — the gates a third-party theme has to clear, and what
// installing one does to a deck.
//
// The gates themselves are the ones the 62 shipped themes already pass
// (test/contrast.mjs runs the same function over themes/), so what is worth
// pinning here is the other direction: that a BROKEN file is refused, that it
// is refused with the reason, and that refusing it leaves the deck alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateTheme, themeNameFrom, validThemeName, REQUIRED } from '../tools/theme-check.mjs';
import { themeStyleBlock, findThemeBlock, installTheme, reportLines } from '../cli/theme.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const AURORA = path.resolve(here, '../themes/aurora.css');

/** A theme that passes everything — the shipped one, so the bar is the real bar. */
const good = () => readFileSync(AURORA, 'utf8');

test('a shipped theme satisfies its own contract', () => {
  const r = validateTheme(good());
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.missing.length, 0);
  assert.equal(REQUIRED.length, 56, 'the contract is 56 tokens (SPEC §5)');
});

test('a missing token is named, and counted against the contract', () => {
  const r = validateTheme(good().replace(/--ansi-bright-cyan:[^;]+;/, ''));
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['ansi-bright-cyan']);
  assert.ok(r.errors.some((e) => e === 'missing token --ansi-bright-cyan'));
  // this is what an old theme meeting a grown contract looks like, so the
  // report has to say how far off it is rather than just listing lines
  assert.ok(reportLines('x', r).some((l) => /1 of 56 tokens missing/.test(l)));
});

test('an unreadable pairing is named with the ratio it actually got', () => {
  const r = validateTheme(good().replace(/--fg:[^;]+;/, '--fg: #0b0f24;'));
  assert.equal(r.ok, false);
  const line = r.errors.find((e) => e.startsWith('--fg on --bg') || e.startsWith('--fg ('));
  assert.ok(line, r.errors.join('\n'));
  assert.match(line, /< 4\.5$/, 'the gate it missed');
  assert.match(line, /\d\.\d\d/, 'and the number it got');
});

test('a gradient canvas is judged at every stop, not just the first', () => {
  // aurora's --bg is a three-stop gradient; text readable over the first stop
  // and invisible over the last is not a readable theme
  const css = good().replace(/--bg:[^;]+;/,
    '--bg: linear-gradient(160deg, #05060a 0%, #e8eefc 100%);');
  const r = validateTheme(css);
  assert.equal(r.ok, false, 'the light stop must fail the light --fg');
  assert.ok(r.failures.some((f) => f.fg === 'fg' && f.bg === 'bg'));
});

test('a file that is not a theme says so once, not 56 times', () => {
  const r = validateTheme('body { color: red; }');
  assert.equal(r.ok, false);
  assert.equal(r.empty, true);
  assert.equal(r.errors.length, 1, 'one clear line beats 56 missing-token lines');
  assert.match(r.errors[0], /is this a Decklight theme/);
});

test('the theme name comes from the file, however it was addressed', () => {
  assert.equal(themeNameFrom('nord-deep.css'), 'nord-deep');
  assert.equal(themeNameFrom('/a/b/nord-deep.css'), 'nord-deep');
  assert.equal(themeNameFrom('https://gist.github.com/u/x/raw/abc/nord-deep.css?v=2'), 'nord-deep');
  assert.equal(themeNameFrom('https://example.com/themes/Nord_Deep.CSS'), 'Nord_Deep');
});

test('a name the runtime would silently ignore is refused instead', () => {
  // applyTheme only resolves [\w-]+ — a name outside it installs fine and then
  // does nothing when picked, which is the worst of both
  assert.equal(validThemeName('nord-deep'), true);
  assert.equal(validThemeName('nord deep'), false);
  assert.equal(validThemeName('nord.deep'), false);
  assert.equal(validThemeName(''), false);
});

test('an installed theme is inert until it is picked', () => {
  const block = themeStyleBlock('nord-deep', '.decklight { --bg: #101; }');
  assert.match(block, /data-theme="nord-deep"/);
  assert.match(block, /data-theme-added/, 'marked, so the picker can group it under Added');
  assert.match(block, /media="not all"/, 'and inert — adding a theme must not change the deck');
});

test('a theme cannot close its own style block', () => {
  // a downloaded file is somebody else's, which is exactly when to check
  const block = themeStyleBlock('x', '/* </style><script>alert(1)</script> */ .decklight { --bg: #000; }');
  assert.equal(/<\/style>/i.test(block.slice(0, -'</style>'.length)), false);
  assert.match(block, /<\\\/style>/);
});

test('install puts the theme last in <head>, where it can win the cascade', () => {
  const deck = '<!doctype html><html><head><link rel="stylesheet" href="themes/eclipse.css">'
    + '</head><body><div class="decklight"></div></body></html>';
  const { html, replaced } = installTheme(deck, 'nord-deep', '.decklight { --bg: #101; }');
  assert.equal(replaced, false);
  assert.ok(html.indexOf('data-theme="nord-deep"') > html.indexOf('themes/eclipse.css'),
    'after the deck’s own theme, or it could never override it');
  assert.ok(html.indexOf('data-theme="nord-deep"') < html.indexOf('</head>'));
});

test('re-adding a theme replaces it — that IS the update path', () => {
  // there is no auto-update and no version number; you re-run add
  const deck = '<!doctype html><html><head></head><body></body></html>';
  const once = installTheme(deck, 'nord-deep', '.decklight { --bg: #101; }').html;
  const { html: twice, replaced } = installTheme(once, 'nord-deep', '.decklight { --bg: #202; }');
  assert.equal(replaced, true);
  assert.equal((twice.match(/data-theme="nord-deep"/g) ?? []).length, 1, 'one block, not two');
  assert.match(twice, /--bg: #202/);
  assert.doesNotMatch(twice, /--bg: #101/);
});

test('a deck with no </head> is reported, not corrupted', () => {
  assert.equal(installTheme('<div class="decklight"></div>', 'x', '.decklight{}').html, null);
});

test('findThemeBlock ignores a different theme with a similar name', () => {
  const html = themeStyleBlock('nord', '.decklight{--bg:#1;}') + themeStyleBlock('nord-deep', '.decklight{--bg:#2;}');
  const hit = findThemeBlock(html, 'nord-deep');
  assert.ok(hit);
  assert.match(hit.text, /--bg:#2/);
});

test('theme check passes a shipped theme and fails a broken one', () => {
  const ok = spawnSync('node', [CLI, 'theme', 'check', AURORA], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /✔ aurora/);
  assert.match(ok.stdout, /56 tokens present/);

  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-theme-'));
  try {
    const broken = path.join(dir, 'broken.css');
    writeFileSync(broken, '.decklight { --bg: #ffffff; --fg: #fefefe; }');
    const bad = spawnSync('node', [CLI, 'theme', 'check', broken], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /✘ broken/);
    assert.match(bad.stdout, /missing token/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a theme that fails the gates is not installed, and the deck is untouched', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-theme-'));
  try {
    const deckPath = path.join(dir, 'talk.html');
    const original = '<!doctype html><html><head></head><body><div class="decklight"><section>a</section></div></body></html>';
    writeFileSync(deckPath, original);
    const broken = path.join(dir, 'broken.css');
    writeFileSync(broken, '.decklight { --bg: #ffffff; --fg: #fefefe; }');

    const r = spawnSync('node', [CLI, 'theme', 'add', broken, deckPath], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /was NOT installed/);
    assert.equal(readFileSync(deckPath, 'utf8'), original, 'the deck is byte-for-byte what it was');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('theme add installs a good theme, and --dry-run installs nothing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-theme-'));
  try {
    const deckPath = path.join(dir, 'talk.html');
    const original = '<!doctype html><html><head></head><body><div class="decklight"><section>a</section></div></body></html>';
    writeFileSync(deckPath, original);

    const dry = spawnSync('node', [CLI, 'theme', 'add', AURORA, deckPath, '--dry-run'], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would install aurora/);
    assert.equal(readFileSync(deckPath, 'utf8'), original);

    const add = spawnSync('node', [CLI, 'theme', 'add', AURORA, deckPath], { encoding: 'utf8' });
    assert.equal(add.status, 0, add.stderr);
    assert.match(add.stdout, /installed aurora/);
    const after = readFileSync(deckPath, 'utf8');
    assert.match(after, /<style data-theme="aurora" data-theme-added media="not all">/);
    assert.match(after, /--bg: linear-gradient/, 'the theme’s own CSS came along');

    // --name renames on the way in
    const named = spawnSync('node', [CLI, 'theme', 'add', AURORA, deckPath, '--name', 'house-style'], { encoding: 'utf8' });
    assert.equal(named.status, 0, named.stderr);
    assert.match(readFileSync(deckPath, 'utf8'), /data-theme="house-style"/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('theme is routed and documented by the dispatcher', () => {
  const help = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help, /^  theme {4}/m);

  const own = execFileSync('node', [CLI, 'theme', '--help'], { encoding: 'utf8' });
  assert.match(own, /decklight theme check/);
  assert.match(own, /decklight theme add/);

  const unknown = spawnSync('node', [CLI, 'theme', 'remove'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown subcommand "remove"/);

  const noArgs = spawnSync('node', [CLI, 'theme', 'check'], { encoding: 'utf8' });
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr, /needs a theme file or url/);
});
