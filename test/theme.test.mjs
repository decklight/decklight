// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight theme` — the gates a third-party theme has to clear, and what
// MARKING one does to a deck (SPEC THEME_DISTRIBUTION).
//
// The gates themselves are the ones the shipped themes already pass
// (test/contrast.mjs runs the same function over themes/), so what is worth
// pinning here is the other direction: that a BROKEN file is refused, that it
// is refused with the reason, and that refusing it leaves the deck alone. And
// that marking a good one puts a reference in the deck — never its CSS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmTemp } from './helpers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateTheme, themeNameFrom, validThemeName, REQUIRED } from '../tools/theme-check.mjs';
import { reportLines } from '../cli/theme.mjs';
import { addedThemeLink, addedThemeStyle, setMarked, markedRefs, parseRef } from '../cli/theme-refs.mjs';
import { MarketplaceError } from '../cli/marketplace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const AURORA = path.resolve(here, '../themes/aurora.css');

/** A theme that passes everything — the shipped one, so the bar is the real bar. */
const good = () => readFileSync(AURORA, 'utf8');

test('a shipped theme satisfies its own contract', () => {
  const r = validateTheme(good());
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.missing.length, 0);
  assert.equal(REQUIRED.length, 56, 'the contract is 56 tokens (SPEC THEMING)');
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

// ── the reference, and the elements it becomes ───────────────────────────

const DATA_DECK = (cfg = '{ "decklight": "0.9.0", "theme": "aurora" }') => '<!doctype html><html><head><title>T</title>\n'
  + `  <script type="application/json" data-decklight-config>\n  ${cfg}\n  </script>\n`
  + '</head><body><div class="decklight"><section>a</section></div></body></html>';
const cfgOf = (html) => JSON.parse(html.match(/data-decklight-config>([\s\S]*?)<\/script>/)[1]);

test('a reference is name@marketplace, and nothing else passes for one', () => {
  assert.deepEqual(parseRef('nord-deep@acme-themes'), { name: 'nord-deep', marketplace: 'acme-themes', ref: 'nord-deep@acme-themes' });
  for (const bad of ['nord-deep', '@acme', 'a@b@c', '../x@m', 'x@../m', 'a b@m', '']) {
    assert.equal(parseRef(bad), null, bad);
  }
});

test('marking edits only the list, in the block\'s own layout', () => {
  const one = setMarked(DATA_DECK(), 'nord@acme', true);
  assert.equal(one.changed, true);
  assert.match(one.html, /\{ "decklight": "0\.9\.0", "theme": "aurora", "addedThemes": \["nord@acme"\] \}/,
    'a one-line block stays on one line');
  const two = setMarked(one.html, 'dusk@acme', true);
  assert.deepEqual(cfgOf(two.html).addedThemes, ['nord@acme', 'dusk@acme']);
  assert.equal(setMarked(two.html, 'dusk@acme', true).changed, false, 'marked already');

  const pretty = DATA_DECK('{\n    "decklight": "0.9.0",\n    "theme": "aurora"\n  }');
  const p = setMarked(pretty, 'nord@acme', true).html;
  assert.match(p, /"theme": "aurora",\n {4}"addedThemes": \["nord@acme"\]\n/, 'a pretty one gets a line of its own');

  const off = setMarked(setMarked(two.html, 'nord@acme', false).html, 'dusk@acme', false).html;
  assert.equal(cfgOf(off).addedThemes, undefined, 'unmarking the last leaves no empty key behind');
  assert.equal(off, DATA_DECK(), 'and the deck is what it was');
});

test('the marks that would make the list ambiguous are refused', () => {
  const refused = (fn, re) => assert.throws(fn, (e) => e instanceof MarketplaceError && re.test(e.message));
  refused(() => setMarked(DATA_DECK(), 'aurora@acme', true), /a theme decklight ships/);
  const marked = setMarked(DATA_DECK(), 'nord@acme', true).html;
  refused(() => setMarked(marked, 'nord@other', true), /already marks nord@acme/);
  const opensOnIt = setMarked(DATA_DECK('{ "decklight": "0.9.0", "theme": "nord" }'), 'nord@acme', true).html;
  refused(() => setMarked(opensOnIt, 'nord@acme', false), /the theme the deck opens on/);
  refused(() => setMarked('<html><head></head><body><div class="decklight"></div></body></html>', 'nord@acme', true),
    /upgrade --link/);
});

test('markedRefs drops what is not a reference rather than guessing at it', () => {
  const html = DATA_DECK('{ "decklight": "0.9.0", "addedThemes": ["nord@acme", "loose", 7, "x@../y"] }');
  assert.deepEqual(markedRefs(html).map((r) => r.ref), ['nord@acme']);
});

test('a marked theme is linked inert, under its marketplace', () => {
  const link = addedThemeLink({ name: 'nord-deep', marketplace: 'acme-themes', title: 'Acme' });
  assert.match(link, /^<link rel="stylesheet" href="decklight-theme\/acme-themes\/nord-deep\.css"/);
  assert.match(link, /data-theme="nord-deep" data-theme-added/, 'an added theme, so the picker groups it');
  assert.match(link, /data-theme-marketplace="acme-themes" data-theme-source="Acme"/);
  assert.match(link, /media="not all">$/, 'and inert — marking a theme must not change what is on screen');
});

test('a bundle carries a marked theme as a block that cannot close itself', () => {
  // a downloaded file is somebody else's, which is exactly when to check
  const block = addedThemeStyle({ name: 'x', marketplace: 'm' }, '/* </style><script>alert(1)</script> */ .decklight { --bg: #000; }');
  assert.equal(/<\/style>/i.test(block.slice(0, -'</style>'.length)), false);
  assert.match(block, /<\\\/style>/);
  assert.match(block, /^<style data-theme="x" data-theme-added data-theme-marketplace="m" media="not all">/);
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
  } finally { rmTemp(dir); }
});

/** A decklight home with one local marketplace, `acme`, holding a passing theme and a broken one. */
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-theme-'));
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'acme');
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  mkdirSync(path.join(repo, 'themes'), { recursive: true });
  writeFileSync(path.join(repo, 'themes/nord.css'), good());
  writeFileSync(path.join(repo, 'themes/broken.css'), '.decklight { --bg: #ffffff; --fg: #fefefe; }');
  writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({
    name: 'acme', title: 'Acme', entries: [
      { name: 'nord', type: 'theme', source: 'themes/nord.css' },
      { name: 'broken', type: 'theme', source: 'themes/broken.css' },
    ],
  }));
  const env = { ...process.env, DECKLIGHT_HOME: home };
  execFileSync('node', [CLI, 'marketplace', 'add', repo], { env, stdio: 'ignore' });
  const deckPath = path.join(dir, 'talk.html');
  writeFileSync(deckPath, DATA_DECK());
  const run = (...args) => spawnSync('node', [CLI, 'theme', ...args], { encoding: 'utf8', env, cwd: dir });
  return { dir, home, deckPath, run };
}

test('a theme that fails the gates is not marked, and the deck is untouched', () => {
  const { dir, deckPath, run } = sandbox();
  try {
    for (const src of ['broken@acme', (writeFileSync(path.join(dir, 'b.css'), '.decklight { --bg: #fff; }'), path.join(dir, 'b.css'))]) {
      const r = run('add', src, deckPath);
      assert.equal(r.status, 1, src);
      assert.match(r.stderr, /was NOT marked/);
      assert.equal(readFileSync(deckPath, 'utf8'), DATA_DECK(), 'the deck is byte-for-byte what it was');
    }
  } finally { rmTemp(dir); }
});

test('theme add marks a marketplace theme — a reference, never its CSS', () => {
  const { dir, deckPath, run } = sandbox();
  try {
    const dry = run('add', 'nord@acme', deckPath, '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would mark nord@acme/);
    assert.equal(readFileSync(deckPath, 'utf8'), DATA_DECK());

    const add = run('add', 'nord', deckPath); // a bare name one marketplace alone has
    assert.equal(add.status, 0, add.stderr);
    assert.match(add.stdout, /marked nord@acme in .* look under "Acme"/);
    const after = readFileSync(deckPath, 'utf8');
    assert.deepEqual(cfgOf(after).addedThemes, ['nord@acme']);
    assert.doesNotMatch(after, /<style|--bg/, 'the theme stayed in its marketplace');

    assert.match(run('add', 'nord@acme', deckPath).stdout, /already marked/);
    const named = run('add', 'nord@acme', deckPath, '--name', 'x');
    assert.equal(named.status, 1, 'a marketplace theme is marked under its own name');
  } finally { rmTemp(dir); }
});

test('a file is copied into the personal marketplace, registered once, and marked there', () => {
  const { dir, home, deckPath, run } = sandbox();
  try {
    const shipped = run('add', AURORA, deckPath);
    assert.equal(shipped.status, 1, 'aurora would sit beside the shipped aurora');
    assert.match(shipped.stderr, /a theme decklight ships.*--name/);
    assert.ok(!existsSync(path.join(home, 'local')), 'and a refusal copies nothing');

    const add = run('add', AURORA, deckPath, '--name', 'house');
    assert.equal(add.status, 0, add.stderr);
    assert.match(add.stdout, /registered your personal marketplace "local"/);
    assert.equal(readFileSync(path.join(home, 'local/themes/house.css'), 'utf8'), good());
    assert.deepEqual(cfgOf(readFileSync(deckPath, 'utf8')).addedThemes, ['house@local']);

    const again = run('add', AURORA, deckPath, '--name', 'house');
    assert.doesNotMatch(again.stdout, /registered/, 'once');
    assert.match(again.stdout, /replaced house/, 're-adding a file IS its update path');
    const reg = JSON.parse(readFileSync(path.join(home, 'marketplaces.json'), 'utf8'));
    assert.equal(reg.marketplaces.local.source, path.join(home, 'local'));
    assert.ok(!path.join(home, 'local').startsWith(path.join(home, 'marketplaces')),
      'outside the clones, so `marketplace remove local` cannot delete your themes');
  } finally { rmTemp(dir); }
});

test('theme remove unmarks, and will not take the theme the deck opens on', () => {
  const { dir, deckPath, run } = sandbox();
  try {
    run('add', 'nord@acme', deckPath);
    const missing = run('remove', 'dusk', deckPath);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /not marked .* it marks nord@acme/);

    writeFileSync(deckPath, readFileSync(deckPath, 'utf8').replace('"theme": "aurora"', '"theme": "nord"'));
    const opens = run('remove', 'nord', deckPath);
    assert.equal(opens.status, 1);
    assert.match(opens.stderr, /the theme the deck opens on/);

    writeFileSync(deckPath, readFileSync(deckPath, 'utf8').replace('"theme": "nord"', '"theme": "aurora"'));
    const off = run('remove', 'nord@acme', deckPath);
    assert.equal(off.status, 0, off.stderr);
    assert.equal(readFileSync(deckPath, 'utf8'), DATA_DECK(), 'back to what it was');
  } finally { rmTemp(dir); }
});

test('theme is routed and documented by the dispatcher', () => {
  const help = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help, /^  theme {4}/m);

  const own = execFileSync('node', [CLI, 'theme', '--help'], { encoding: 'utf8' });
  assert.match(own, /decklight theme check/);
  assert.match(own, /decklight theme add/);

  assert.match(own, /decklight theme remove/);

  const unknown = spawnSync('node', [CLI, 'theme', 'install'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown subcommand "install"/);

  const noArgs = spawnSync('node', [CLI, 'theme', 'check'], { encoding: 'utf8' });
  assert.equal(noArgs.status, 1);
  assert.match(noArgs.stderr, /needs a theme file or url/);
});

// ── provenance: where a marked theme came from (#339) ─────────────────────
//
// The picker used to group every runtime install under one "Added" bucket,
// whatever catalog it came from. The heading has to survive the deck
// TRAVELLING: a bundled deck opened on another machine has no
// ~/.decklight/marketplaces.json to look a catalog up in, so it is written onto
// the link a server serves and the block a bundle carries, or it is not
// available at all.

test('a theme from a catalog carries its identity AND its label', () => {
  // Two attributes because they are two different things: the kebab name is
  // what a later dedup or upgrade keys on, the title is what a human reads.
  for (const el of [
    addedThemeLink({ name: 'confluent', marketplace: 'decklight-confluent', title: 'Confluent' }),
    addedThemeStyle({ name: 'confluent', marketplace: 'decklight-confluent', title: 'Confluent' }, 'body{}'),
  ]) {
    assert.match(el, /data-theme-marketplace="decklight-confluent"/);
    assert.match(el, /data-theme-source="Confluent"/);
    assert.match(el, /data-theme-added/, 'and it is still an added theme');
  }
});

test('a catalog with no title carries only its name — nothing is invented', () => {
  // Deriving "Acme" from "acme-themes" breaks on `confluent-decklight` and puts
  // decklight in the business of naming other people's catalogs.
  for (const el of [addedThemeLink({ name: 'x', marketplace: 'acme-themes' }),
    addedThemeStyle({ name: 'x', marketplace: 'acme-themes' }, 'body{}')]) {
    assert.match(el, /data-theme-marketplace="acme-themes"/);
    assert.ok(!el.includes('data-theme-source'), 'no label rather than a guessed one');
  }
});

test('a hostile title cannot escape its attribute', () => {
  // The title is free text out of a manifest somebody else wrote, and it lands
  // in a double-quoted attribute in a served page and in a bundle.
  for (const el of [
    addedThemeLink({ name: 'x', marketplace: 'm', title: '"><script>alert(1)</script>' }),
    addedThemeStyle({ name: 'x', marketplace: 'm', title: '"><script>alert(1)</script>' }, 'body{}'),
  ]) {
    assert.ok(!el.includes('<script>'), 'the tag did not survive');
    assert.ok(!/data-theme-source="[^"]*"[^ >]/.test(el), 'the attribute did not break out');
    assert.match(el, /&quot;&gt;&lt;script&gt;/);
  }
});
