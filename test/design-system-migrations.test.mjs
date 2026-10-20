// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A design system's major versions (SPEC DESIGN_SYSTEM_MIGRATIONS): a deck
// records the version it took, a package declares what each major renamed,
// the gate holds those names to the package, `check` says "migrate" once
// instead of an off-role per slide, and `design-system migrate` applies the
// renames to the deck and the stylesheets it links.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch } from './helpers.mjs';
import {
  composeRenames, applyRenames, findRenamed, pendingMigrations, migrationsOf, migrationShapeProblems,
} from '../tools/design-system-migrations.mjs';
import { checkDir, reportLines } from '../cli/design-system.mjs';
import {
  packageVerdict, migrationStatus, behindMessage, setDesignSystem, setDesignSystemVersion, deckDesignSystemVersions, linkDesignSystems,
} from '../cli/design-system-refs.mjs';
import { staticFindings, checkEntry } from '../cli/check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const ROLES = path.join(here, 'fixtures', 'design-systems', 'roles');

// the roles fixture is acme 3.0.0; this is what 3.0.0 renamed
const MIGRATIONS = {
  '3.0.0': {
    skill: 'acme-migrate',
    roles: { 'text-main': 'text-body', 'text-lead': 'text-heading' },
    tokens: { '--acme-pad': '--acme-divider-pad' },
    classes: { 'acme-tile': 'acme-card' },
    themes: { 'acme-night': 'acme-dark' },
  },
};

/** A copy of the roles fixture, its manifest changed. */
function pkg(t, change = (m) => { m.migrations = MIGRATIONS; }) {
  const dir = path.join(scratch('ds-mig', t), 'acme');
  cpSync(ROLES, dir, { recursive: true });
  const file = path.join(dir, 'design-system.json');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  change(m);
  writeFileSync(file, JSON.stringify(m, null, 2));
  return dir;
}

const deck = (cfg, slides) => '<!doctype html><html><head><title>T</title>\n'
  + `<script type="application/json" data-decklight-config>${JSON.stringify({ decklight: '0.9.0', designSystems: ['acme@acme-mkt'], theme: 'acme-dark', ...cfg })}</script>\n`
  + `</head><body><div class="decklight">${slides}</div></body></html>`;
const OLD_SLIDES = [1, 2, 3].map((n) => `<section><h2>S${n}</h2><p style="color: var(--acme-color-text-main)">x</p></section>`).join('');

// ── the pure half ───────────────────────────────────────────────────────────

test('renames compose in version order: a name renamed twice goes straight to the last one', () => {
  const r = composeRenames(migrationsOf({ version: '6.0.0', migrations: {
    '6.0.0': { roles: { b: 'c' } },
    '5.0.0': { roles: { a: 'b' } },
  } }));
  assert.deepEqual(r.roles, { a: { to: 'c', version: '6.0.0' }, b: { to: 'c', version: '6.0.0' } });
  const since5 = pendingMigrations({ version: '6.0.0', migrations: { '5.0.0': {}, '6.0.0': {} } }, '5.0.0');
  assert.deepEqual(since5.map((m) => m.version), ['6.0.0'], 'only what came after the version the deck took');
});

test('renames are whole names: roles as their token, classes in class attributes and selectors, the configured theme', () => {
  const renames = composeRenames(migrationsOf({ version: '3.0.0', migrations: MIGRATIONS }));
  const html = '<script type="application/json" data-decklight-config>{ "theme": "acme-night" }</script>'
    + '<style>.acme-tile { color: var(--acme-color-text-main) } .acme-tiles {}</style>'
    + '<p class="x acme-tile" style="color: var(--acme-color-text-main); --x: var(--acme-color-text-mainly)">acme-tile</p>';
  const { text, count } = applyRenames(html, renames, '--acme-', { config: true });
  assert.match(text, /"theme": "acme-dark"/);
  assert.match(text, /\.acme-card \{ color: var\(--acme-color-text-body\) \} \.acme-tiles \{\}/, 'a longer class is another class');
  assert.match(text, /class="x acme-card"/);
  assert.match(text, /var\(--acme-color-text-mainly\)/, 'a longer token is another token');
  assert.match(text, />acme-tile<\/p>/, 'words on a slide are not a class');
  assert.equal(count, 5);
  assert.deepEqual(findRenamed([text], renames, '--acme-'), [], 'nothing left to find once applied');
  assert.deepEqual(findRenamed([html], renames, '--acme-').map((f) => `${f.kind}:${f.from}`), ['roles:text-main', 'classes:acme-tile', 'themes:acme-night']);
});

test('a malformed migrations block is refused by its shape', () => {
  const msgs = (migrations) => migrationShapeProblems({ version: '3.0.0', migrations }).map((p) => p.msg).join('\n');
  assert.match(msgs([]), /migrations must be/);
  assert.match(msgs({ v6: {} }), /"v6" is not a semver version/);
  assert.match(msgs({ '4.0.0': {} }), /4\.0\.0 is later than this package's version 3\.0\.0/);
  assert.match(msgs({ '3.0.0': { colours: {} } }), /has "colours"/);
  assert.match(msgs({ '3.0.0': { roles: { a: 'A B' } } }), /each side is a role id/);
  assert.match(msgs({ '3.0.0': { tokens: { '--a': '--a' } } }), /renames "--a" to itself/);
  assert.equal(msgs(MIGRATIONS), '');
});

// ── the gate ────────────────────────────────────────────────────────────────

test('the gate admits a package whose migrations hold, and its report says so', (t) => {
  const r = checkDir(pkg(t));
  assert.deepEqual(r.problems, []);
  assert.match(reportLines('acme', r).join('\n'), /migration {12}3\.0\.0 — 5 renames · skill acme-migrate/);
});

test('the gate refuses an old name the package still defines, and a new name it does not', (t) => {
  const still = checkDir(pkg(t, (m) => { m.migrations = { '3.0.0': { roles: { 'text-heading': 'text-body' }, classes: { 'acme-card': 'acme-box' } } }; }));
  const msgs = still.problems.filter((p) => p.rule === 'migration').map((p) => p.msg);
  assert.ok(msgs.some((m) => /renames role "text-heading", which this version still defines/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /renames class "acme-card" to "acme-box", which this version does not define/.test(m)), msgs.join('\n'));
  const chained = checkDir(pkg(t, (m) => { m.migrations = { '2.0.0': { tokens: { '--acme-a': '--acme-b' } }, '3.0.0': { tokens: { '--acme-b': '--acme-divider-pad' } } }; }));
  assert.deepEqual(chained.problems, [], 'a successor renamed again later need not exist');
});

// ── the deck records its version ────────────────────────────────────────────

test('a reference brings its version with it, and takes it away again', () => {
  const html = deck({ designSystems: undefined }, '');
  const on = setDesignSystem(html, 'acme@acme-mkt', true, { version: '3.0.0' }).html;
  assert.deepEqual(deckDesignSystemVersions(on), { 'acme@acme-mkt': '3.0.0' });
  const off = setDesignSystem(on, 'acme@acme-mkt', false).html;
  assert.deepEqual(deckDesignSystemVersions(off), {});
  assert.doesNotMatch(off, /designSystemVersions/);
});

// ── said once: check, the page ──────────────────────────────────────────────

test('check: a deck behind is ONE finding naming the renames and the skill, not an off-role per slide', (t) => {
  const v = packageVerdict(pkg(t));
  const systems = () => new Map([['acme', checkEntry('acme@acme-mkt', v)]]);
  const html = deck({ designSystemVersions: { 'acme@acme-mkt': '2.0.0' } }, OLD_SLIDES);
  const found = staticFindings(html, { designSystems: systems, stylesheets: () => [], deck: 'talk.html' });
  const behind = found.filter((f) => f.rule === 'ds-behind');
  assert.equal(behind.length, 1);
  assert.equal(behind[0].slide, null, 'at the head');
  assert.match(behind[0].message, /written for acme 2\.0\.0, this machine serves 3\.0\.0: 1 renamed name \(text-main → text-body\)/);
  assert.match(behind[0].message, /Migrate with the acme-migrate skill, or decklight design-system migrate acme@acme-mkt talk\.html/);
  assert.equal(found.filter((f) => f.rule === 'off-role').length, 0, 'the renamed role is not said again, three times');

  // a stylesheet the deck links counts too
  const clean = deck({ designSystemVersions: { 'acme@acme-mkt': '2.0.0' } }, '<section><p class="acme-card">x</p></section>');
  const viaCss = staticFindings(clean, { designSystems: systems, stylesheets: () => [{ text: '.acme-tile { padding: var(--acme-pad) }' }] });
  assert.match(viaCss.find((f) => f.rule === 'ds-behind').message, /2 renamed names \(--acme-pad → --acme-divider-pad, acme-tile → acme-card\)/);

  // on the current version, an old name is off-role — and named for its successor
  const current = staticFindings(deck({ designSystemVersions: { 'acme@acme-mkt': '3.0.0' } }, OLD_SLIDES), { designSystems: systems, stylesheets: () => [] });
  assert.equal(current.filter((f) => f.rule === 'ds-behind').length, 0);
  assert.match(current.find((f) => f.rule === 'off-role').message, /--acme-color-text-main \(was renamed text-body in 3\.0\.0\)/);

  // a major behind a package that declares no migrations is still said
  const plain = () => new Map([['acme', checkEntry('acme@acme-mkt', packageVerdict(ROLES))]]);
  const major = staticFindings(deck({ designSystemVersions: { 'acme@acme-mkt': '2.0.0' } }, '<section>a</section>'), { designSystems: plain, stylesheets: () => [] });
  assert.match(major.find((f) => f.rule === 'ds-behind').message, /written for acme 2\.0\.0, this machine serves 3\.0\.0, a new major version/);
});

test('a major behind with nothing renamed is still said; a deck on the version says nothing', () => {
  const m = { name: 'acme', version: '6.0.0', migrations: { '6.0.0': { skill: 'acme-migrate', roles: { a: 'b' } } } };
  const status = migrationStatus(m, '5.1.0', ['<p>nothing renamed here</p>']);
  assert.equal(status.behind, true);
  assert.match(behindMessage('acme', status), /^written for acme 5\.1\.0, this machine serves 6\.0\.0, a new major version\. Migrate with the acme-migrate skill/);
  assert.equal(migrationStatus(m, '6.0.0', ['var(--acme-color-a)']).behind, false, 'a name from before its version is not a migration it missed');
  assert.equal(migrationStatus({ name: 'acme', version: '6.0.0' }, null, ['x']).behind, false, 'no version recorded, no migrations: nothing to say');
});

test('the servers tell the page, in a meta the runtime toasts while authoring', (t) => {
  const h = path.join(scratch('ds-mig-home', t), 'home');
  const { env } = market(t, h);
  const html = deck({ designSystemVersions: { 'acme@acme-mkt': '2.0.0' } }, OLD_SLIDES);
  const prev = process.env.DECKLIGHT_HOME;
  process.env.DECKLIGHT_HOME = env.DECKLIGHT_HOME;
  try {
    const out = linkDesignSystems(html, env.DECKLIGHT_HOME);
    assert.match(out, /<meta name="decklight-design-system-behind" content="Acme Brand: written for acme 2\.0\.0, this machine serves 3\.0\.0/);
    const now = linkDesignSystems(setDesignSystemVersion(html.replace(/text-main/g, 'text-body'), 'acme@acme-mkt', '3.0.0'), env.DECKLIGHT_HOME);
    assert.doesNotMatch(now, /decklight-design-system-behind/);
  } finally {
    if (prev === undefined) delete process.env.DECKLIGHT_HOME; else process.env.DECKLIGHT_HOME = prev;
  }
});

// ── the commands ────────────────────────────────────────────────────────────

/** acme-mkt with the roles fixture (and its migrations) as `acme`, registered into `h`. */
function market(t, h) {
  const repo = path.join(path.dirname(h), 'acme-mkt');
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  cpSync(pkg(t), path.join(repo, 'systems/acme'), { recursive: true });
  writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({
    name: 'acme-mkt', entries: [{ name: 'acme', type: 'design-system', source: 'systems/acme', version: '3.0.0', apiVersion: 2 }],
  }));
  const env = { ...process.env, DECKLIGHT_HOME: h };
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], { env, stdio: 'ignore' });
  return { env, repo };
}
const run = (args, env) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });

test('design-system add records the version; list compares the deck\'s, and says when a major means migrate', (t) => {
  const dir = scratch('ds-mig-cli', t);
  const { env } = market(t, path.join(dir, 'home'));
  const file = path.join(dir, 'talk.html');
  writeFileSync(file, deck({ designSystems: undefined }, '<section>a</section>'));
  assert.equal(run(['design-system', 'add', 'acme@acme-mkt', file, '--no-recommended'], env).status, 0);
  assert.deepEqual(deckDesignSystemVersions(readFileSync(file, 'utf8')), { 'acme@acme-mkt': '3.0.0' });
  assert.match(run(['design-system', 'list', file], env).stdout, /^acme@acme-mkt {2}3\.0\.0$/m);

  writeFileSync(file, setDesignSystemVersion(readFileSync(file, 'utf8'), 'acme@acme-mkt', '2.4.0'));
  assert.match(run(['design-system', 'list', file], env).stdout, /^acme@acme-mkt {2}2\.4\.0 → 3\.0\.0 \(major: migrate\)/m);
});

test('design-system migrate renames in the deck and the stylesheet it links, then records the version', (t) => {
  const dir = scratch('ds-mig-run', t);
  const { env } = market(t, path.join(dir, 'home'));
  const file = path.join(dir, 'talk.html');
  const css = path.join(dir, 'course.css');
  writeFileSync(css, '.acme-tile { padding: var(--acme-pad); }\n');
  writeFileSync(file, deck({ theme: 'acme-night', designSystemVersions: { 'acme@acme-mkt': '2.0.0' } },
    `${OLD_SLIDES}<section><p class="acme-tile">t</p></section>`).replace('</head>', '<link rel="stylesheet" href="course.css">\n</head>'));

  const before = run(['check', file, '--no-render', '--json'], env);
  const rules = JSON.parse(before.stdout).map((f) => f.rule);
  assert.equal(rules.filter((r) => r === 'ds-behind').length, 1, before.stdout);

  const r = run(['design-system', 'migrate', 'acme@acme-mkt', file], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /acme@acme-mkt 2\.0\.0 → 3\.0\.0/);
  assert.match(r.stdout, /roles {4}text-main → text-body/);
  assert.match(r.stdout, /the acme-migrate skill's: decklight library add skill acme-migrate/);
  const out = readFileSync(file, 'utf8');
  assert.doesNotMatch(out, /text-main|acme-tile|acme-night/);
  assert.match(out, /"theme":"acme-dark"|"theme": "acme-dark"/);
  assert.deepEqual(deckDesignSystemVersions(out), { 'acme@acme-mkt': '3.0.0' });
  assert.equal(readFileSync(css, 'utf8'), '.acme-card { padding: var(--acme-divider-pad); }\n');

  const after = JSON.parse(run(['check', file, '--no-render', '--json'], env).stdout).map((f) => f.rule);
  assert.ok(!after.includes('ds-behind') && !after.includes('off-role'), after.join(', '));
  const again = run(['design-system', 'migrate', 'acme@acme-mkt', file], env);
  assert.match(again.stdout, /already on acme@acme-mkt 3\.0\.0 — nothing to migrate/);
  assert.equal(readFileSync(file, 'utf8'), out, 'byte for byte');
});

test('apply records the version of a deck that has none — unless it still uses a renamed name', (t) => {
  const dir = scratch('ds-mig-apply', t);
  const { env } = market(t, path.join(dir, 'home'));
  const file = path.join(dir, 'talk.html');
  writeFileSync(file, deck({}, OLD_SLIDES));
  run(['design-system', 'apply', 'acme@acme-mkt', file], env);
  assert.deepEqual(deckDesignSystemVersions(readFileSync(file, 'utf8')), {}, 'recording 3.0.0 would hide that it is behind');
  writeFileSync(file, deck({}, '<section>a</section>'));
  run(['design-system', 'apply', 'acme@acme-mkt', file], env);
  assert.deepEqual(deckDesignSystemVersions(readFileSync(file, 'utf8')), { 'acme@acme-mkt': '3.0.0' });
});
