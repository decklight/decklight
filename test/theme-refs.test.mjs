// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck's marked themes, from reference to page (SPEC THEME_DISTRIBUTION):
// resolved from the marketplaces on this machine, linked into every served
// page, answered by every server, named when this machine cannot show one,
// and inlined — never linked — by `bundle`.
//
// The marking itself (the CLI and the author route) is test/theme.test.mjs
// and test/theme-browse.test.mjs; the picker's behaviour is test/engine.html.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp } from './helpers.mjs';

import {
  resolveThemeRef, linkAddedThemes, themeRefAsset, marketplaceThemes, themeCachePath,
  portableSource, setMarked, markedSources, refForDeck,
} from '../cli/theme-refs.mjs';
import { linkRuntime } from '../cli/runtime-link.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const AURORA = readFileSync(path.join(ROOT, 'themes/aurora.css'), 'utf8');

/** A home with `acme` registered from a local directory: nord (a file), gist (a URL). */
function home(t) {
  const dir = tmp('theme-refs', t);
  const h = path.join(dir, 'home');
  const repo = path.join(dir, 'acme');
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  mkdirSync(path.join(repo, 'themes'), { recursive: true });
  writeFileSync(path.join(repo, 'themes/nord.css'), AURORA);
  writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({
    name: 'acme', title: 'Acme', entries: [
      { name: 'nord', type: 'theme', source: './themes/nord.css' },
      { name: 'gist', type: 'theme', source: 'https://example.invalid/gist.css' },
      { name: 'tool', type: 'template', source: './t.html' },
    ],
  }));
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], {
    env: { ...process.env, DECKLIGHT_HOME: h }, stdio: 'ignore',
  });
  return { dir, home: h, repo };
}

const deck = (cfg) => '<!doctype html><html><head><title>T</title>\n'
  + `<script type="application/json" data-decklight-config>${JSON.stringify(cfg)}</script>\n`
  + '</head><body><div class="decklight"><section>a</section></div></body></html>';

// ── resolving ─────────────────────────────────────────────────────────────

test('a reference resolves to the file in its marketplace, or says why it cannot', (t) => {
  const { home: h, repo } = home(t);
  const hit = resolveThemeRef('nord@acme', h);
  assert.equal(hit.file, path.join(repo, 'themes/nord.css'));
  assert.equal(hit.title, 'Acme');

  assert.match(resolveThemeRef('nord@elsewhere', h).missing, /"elsewhere" is not registered on this machine/);
  assert.match(resolveThemeRef('ghost@acme', h).missing, /"ghost" is not in acme/);
  assert.match(resolveThemeRef('tool@acme', h).missing, /is a template, not a theme/);

  const remote = resolveThemeRef('gist@acme', h);
  assert.equal(remote.remote, 'https://example.invalid/gist.css', 'a URL entry is flagged, not fetched');
  assert.ok(!remote.file);
  mkdirSync(path.dirname(themeCachePath(h, 'acme', 'gist')), { recursive: true });
  writeFileSync(themeCachePath(h, 'acme', 'gist'), AURORA);
  assert.equal(resolveThemeRef('gist@acme', h).file, themeCachePath(h, 'acme', 'gist'), 'and once kept, it is a file');
});

test('the listing is every theme of every marketplace, and nothing else', (t) => {
  const { home: h } = home(t);
  const { themes } = marketplaceThemes(h);
  assert.deepEqual(themes.map((x) => x.qualified).sort(), ['gist@acme', 'nord@acme']);
  assert.equal(themes[0].title, 'Acme');
  assert.ok(!themes.some((x) => 'source' in x), "a manifest's source never leaves the server");
});

// ── served ────────────────────────────────────────────────────────────────

test('every server links the marked themes, after the base theme it always linked', (t) => {
  const { home: h } = home(t);
  const out = linkAddedThemes(linkRuntime(deck({ decklight: '0.9.0', theme: 'aurora', addedThemes: ['nord@acme'] })), h);
  assert.match(out, /<link rel="stylesheet" href="themes\/aurora\.css">/);
  assert.match(out, /<link rel="stylesheet" href="decklight-theme\/acme\/nord\.css" data-theme="nord" data-theme-added data-theme-marketplace="acme" data-theme-source="Acme" media="not all">/);
  assert.ok(out.indexOf('decklight-theme/acme/nord.css') < out.indexOf('</head>'));
});

test('a deck that opens on a marked theme still gets a base theme linked', (t) => {
  // `themes/nord.css` is not a file anywhere; the default is linked under it,
  // and the runtime applies the marked one over it from the config block.
  const html = linkRuntime(deck({ decklight: '0.9.0', theme: 'nord', addedThemes: ['nord@acme'] }));
  assert.match(html, /href="themes\/aurora\.css"/);
  assert.doesNotMatch(html, /href="themes\/nord\.css"/);
});

test('an added theme is never mistaken for the deck\'s own', () => {
  // A data deck carrying only an added block (an older `theme add`) or link
  // still needs its base theme linked, or every stock theme would stop applying.
  for (const extra of [
    '<style data-theme="x" data-theme-added media="not all">.decklight{}</style>',
    '<link rel="stylesheet" href="themes/x.css" data-theme="x" data-theme-added media="not all">',
  ]) {
    const html = linkRuntime(deck({ decklight: '0.9.0', theme: 'ember' }).replace('</head>', `${extra}</head>`));
    assert.match(html, /<link rel="stylesheet" href="themes\/ember\.css">/, extra);
  }
});

test('a theme this machine cannot show is named in the page, not silently dropped', (t) => {
  const { home: h } = home(t);
  const logged = [];
  const out = linkAddedThemes(deck({ addedThemes: ['nord@acme', 'dusk@elsewhere'] }), h, { log: (m) => logged.push(m) });
  assert.match(out, /data-theme="nord"/);
  assert.doesNotMatch(out, /data-theme="dusk"/);
  assert.match(out, /<meta name="decklight-theme-missing" content="dusk@elsewhere — marketplace &quot;elsewhere&quot; is not registered on this machine — it was local to whoever marked it, or never recorded where it came from">/,
    'with no recorded source, it cannot say more than that');
  assert.equal(logged.length, 1);
});

test('a bundle\'s own copy of a marked theme is left to it — no second link', (t) => {
  const { home: h } = home(t);
  const bundled = deck({ addedThemes: ['nord@acme'] })
    .replace('</head>', '<style data-theme="nord" data-theme-added media="not all">.decklight{}</style></head>');
  assert.equal(linkAddedThemes(bundled, h), bundled);
});

test('the asset route answers a marketplace theme, and nothing it was not asked for', (t) => {
  const { home: h, repo } = home(t);
  assert.deepEqual(themeRefAsset('/decklight-theme/acme/nord.css', h),
    { file: path.join(repo, 'themes/nord.css'), type: 'text/css; charset=utf-8' });
  assert.ok(themeRefAsset('/slides/decklight-theme/acme/nord.css', h), 'matched on the tail, like packageAsset');
  for (const probe of [
    '/decklight-theme/acme/../../etc/passwd', '/decklight-theme/../acme/nord.css',
    '/decklight-theme/acme/tool.css', '/decklight-theme/acme/gist.css', '/decklight-theme/nowhere/nord.css',
    '/decklight-theme/acme/nord.js',
  ]) {
    assert.equal(themeRefAsset(probe, h), null, probe);
  }
});

// ── bundled ───────────────────────────────────────────────────────────────

test('bundle inlines every marked theme and opens on the one --theme names', (t) => {
  const { dir, home: h } = home(t);
  const deckPath = path.join(dir, 'talk.html');
  writeFileSync(deckPath, deck({ decklight: '0.9.0', theme: 'aurora', addedThemes: ['nord@acme'] }));
  const env = { ...process.env, DECKLIGHT_HOME: h };
  const bundle = (...args) => spawnSync(process.execPath, [CLI, 'bundle', deckPath, ...args], { encoding: 'utf8', env });

  const out = path.join(dir, 'out.html');
  const r = bundle('-o', out, '--theme', 'nord');
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(out, 'utf8');
  assert.match(html, /<style data-theme="nord" data-theme-added data-theme-marketplace="acme" data-theme-source="Acme" media="not all">/,
    'carried as a block, with its heading — a file opened elsewhere has no marketplace to link');
  assert.doesNotMatch(html, /<link[^>]*decklight-theme\//, 'and never linked');
  assert.match(html, /"theme":"nord"|"theme": "nord"/, 'and it opens on it');
  assert.match(html, /<style data-theme="aurora">/, 'with the base theme it was playing with');

  writeFileSync(deckPath, deck({ decklight: '0.9.0', theme: 'aurora', addedThemes: ['nord@acme', 'dusk@elsewhere'] }));
  const refused = bundle('-o', path.join(dir, 'out2.html'));
  assert.notEqual(refused.status, 0, 'a hand-over must not quietly lose a theme the deck marks');
  assert.match(refused.stderr, /dusk@elsewhere/);
});

test('a marked theme that stops passing the contract stops being served — and bundled', (t) => {
  // A marked theme follows its marketplace, and `marketplace update` can change
  // its bytes after it was marked and checked. The deck must never show, nor a
  // bundle carry, what the shipped set could not contain.
  const { dir, home: h, repo } = home(t);
  const html = deck({ decklight: '0.9.0', theme: 'aurora', addedThemes: ['nord@acme'] });
  assert.match(linkAddedThemes(html, h), /data-theme="nord"/, 'passing, it is linked');

  writeFileSync(path.join(repo, 'themes/nord.css'), '.decklight { --bg: #fff; --fg: #fefefe; }');
  const out = linkAddedThemes(html, h);
  assert.doesNotMatch(out, /<link[^>]*data-theme="nord"/);
  assert.match(out, /decklight-theme-missing" content="nord@acme — it no longer passes the theme contract/);
  assert.equal(themeRefAsset('/decklight-theme/acme/nord.css', h), null, 'and its path answers nothing');

  const deckPath = path.join(dir, 'talk.html');
  writeFileSync(deckPath, html);
  const r = spawnSync(process.execPath, [CLI, 'bundle', deckPath, '-o', path.join(dir, 'o.html')],
    { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: h } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no longer passes the theme contract/);
});

// ── where a marketplace comes from ────────────────────────────────────────
//
// A marketplace's registered NAME is this machine's: the same catalog can be
// `acme` here and `acme-themes` there, and two catalogs can share a name. So a
// deck records each marketplace's SOURCE beside its references, and the source
// decides which catalog a reference means.

/**
 * Re-register `acme` as though it had been cloned from a remote: its files in
 * the checkout `marketplace add` would have made, its source a repo — no
 * network needed to stand the state up.
 */
function asRemote(h, repo, { name = 'acme', source = 'acme/decklight-themes' } = {}) {
  cpSync(repo, path.join(h, 'marketplaces', name), { recursive: true });
  const regPath = path.join(h, 'marketplaces.json');
  const reg = JSON.parse(readFileSync(regPath, 'utf8'));
  if (name !== 'acme') {
    reg.marketplaces[name] = reg.marketplaces.acme;
    delete reg.marketplaces.acme;
    cpSync(path.join(h, 'marketplaces', 'acme.json'), path.join(h, 'marketplaces', `${name}.json`));
  }
  reg.marketplaces[name].source = source;
  writeFileSync(regPath, JSON.stringify(reg));
}

test('a source is written the way marketplace add takes it, and never with a secret or a path in it', () => {
  const cases = [
    ['acme/decklight-themes', 'acme/decklight-themes'],
    ['https://github.com/acme/decklight-themes.git', 'acme/decklight-themes'],
    ['https://x-access-token:ghp_secret@github.com/acme/decklight-themes.git', 'acme/decklight-themes'],
    ['https://deploy:s3cret@git.example.com/team/themes.git', 'https://git.example.com/team/themes'],
    ['ssh://git@git.example.com/team/themes.git', 'ssh://git.example.com/team/themes'],
    ['git@github.com:acme/themes.git', 'git@github.com:acme/themes'],
    ['./mkt', null], ['/Users/someone/.decklight/local', null], ['file:///srv/mirror/themes.git', null], ['', null],
  ];
  for (const [given, want] of cases) assert.equal(portableSource(given), want, given);
});

test('marking records where its marketplace comes from, once, and unmarking the last takes it away', () => {
  const html = deck({ decklight: '0.9.0', theme: 'aurora' });
  const one = setMarked(html, 'nord@acme-themes', true, { source: 'acme/decklight-themes' }).html;
  const two = setMarked(one, 'dusk@acme-themes', true, { source: 'acme/decklight-themes' }).html;
  assert.deepEqual(markedSources(two), { 'acme-themes': 'acme/decklight-themes' }, 'once per marketplace');
  const local = setMarked(two, 'house@local', true, { source: null }).html;
  assert.deepEqual(markedSources(local), { 'acme-themes': 'acme/decklight-themes' }, 'a local one records nothing');
  const off = setMarked(setMarked(local, 'nord@acme-themes', false).html, 'dusk@acme-themes', false).html;
  assert.deepEqual(markedSources(off), {}, 'gone with its last theme');
  assert.doesNotMatch(off, /themeSources/);
});

test('the source decides: the same catalog under another name here is the one the deck means', (t) => {
  const { home: h, repo } = home(t);
  asRemote(h, repo, { name: 'acme-here' });
  const html = deck({ decklight: '0.9.0', addedThemes: ['nord@acme'], themeSources: { acme: 'acme/decklight-themes' } });
  const out = linkAddedThemes(html, h);
  const link = out.match(/<link[^>]*data-theme="nord"[^>]*>/)?.[0];
  assert.ok(link, out);
  assert.match(link, /href="decklight-theme\/acme-here\/nord\.css"/, 'served from what this machine calls it');
  assert.match(link, /data-theme-marketplace="acme"/, 'grouped, and toggled, by what the deck calls it');
  assert.equal(refForDeck(html, 'dusk', 'acme-here', 'acme/decklight-themes'), 'dusk@acme',
    'and a second theme from it is recorded under the deck\'s name, not a second one');
});

test('a marketplace that only shares the name is not the one the deck means', (t) => {
  const { home: h, repo } = home(t);
  asRemote(h, repo, { source: 'someone-else/themes' });
  const html = deck({ decklight: '0.9.0', addedThemes: ['nord@acme'], themeSources: { acme: 'acme/decklight-themes' } });
  const out = linkAddedThemes(html, h);
  assert.doesNotMatch(out, /<link[^>]*data-theme="nord"/, 'never linked silently');
  assert.match(out, /nord@acme — &quot;acme&quot; here is a different catalog \(someone-else\/themes\) — the deck's comes from acme\/decklight-themes/);
});

test('a marketplace this machine lacks is named with the command that brings it', (t) => {
  const { home: h } = home(t);
  const html = deck({ decklight: '0.9.0', addedThemes: ['nord@other'], themeSources: { other: 'acme/other-themes' } });
  assert.match(linkAddedThemes(html, h), /nord@other — its marketplace is not registered on this machine — decklight marketplace add acme\/other-themes/);
});

test('marking from the command line records the source it resolved', (t) => {
  const { dir, home: h, repo } = home(t);
  asRemote(h, repo);
  const deckPath = path.join(dir, 'talk.html');
  writeFileSync(deckPath, deck({ decklight: '0.9.0', theme: 'aurora' }));
  const r = spawnSync(process.execPath, [CLI, 'theme', 'add', 'nord@acme', deckPath],
    { encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: h } });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(readFileSync(deckPath, 'utf8').match(/data-decklight-config>([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(cfg.addedThemes, ['nord@acme']);
  assert.deepEqual(cfg.themeSources, { acme: 'acme/decklight-themes' });
});
