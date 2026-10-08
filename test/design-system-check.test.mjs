// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight check` on a deck that uses a design system (SPEC DESIGN_SYSTEMS,
// #627): every way a slide can misuse one is a named, per-slide warning —
// against an INJECTED design system for the pure half, and through the real
// command, resolved from a marketplace checkout, for the demo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch } from './helpers.mjs';
import { staticFindings } from '../cli/check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'cli/decklight.mjs');

/** The fixture package's two templates, as the resolver hands them over. */
const ACME = { ref: 'acme@acme-mkt', templates: new Map([
  ['section-divider', [
    { name: 'kicker', hint: 'p' }, { name: 'title', hint: 'h1,h2', required: true },
    { name: 'subtitle', hint: 'p' }, { name: 'body', hint: '', default: true },
  ]],
  ['statement', [{ name: 'title', hint: 'h2', required: true }, { name: 'body', default: true }]],
]) };

const deck = (sections, systems = ['acme@acme-mkt']) => '<!doctype html><html><head><title>T</title>\n'
  + `<script type="application/json" data-decklight-config>${JSON.stringify({ decklight: '0.9.0', theme: 'aurora', ...(systems ? { designSystems: systems } : {}) })}</script>\n`
  + `</head><body><div class="decklight">\n${sections.join('\n')}\n</div></body></html>\n`;

const MISTAKES = [
  '<section data-template="other/divider"><h2 data-slot="title">Unknown system</h2></section>',
  '<section data-template="acme/nope"><h2 data-slot="title">Unknown template</h2></section>',
  '<section data-template="acme/section-divider"><h2 data-slot="titel">Exactly-once, end to end</h2><h2 data-slot="title">t</h2></section>',
  '<section data-template="acme/section-divider"><p data-slot="kicker">A</p><p data-slot="kicker">B</p><h2 data-slot="title">Twice</h2></section>',
  '<section data-template="acme/statement"><p>no title</p></section>',
];
const FIXED = [
  '<section data-template="acme/section-divider"><p data-slot="kicker">Module 01</p><h2 data-slot="title">Fine</h2></section>',
  // the default slot is meant to take several elements
  '<section data-template="acme/statement"><h2 data-slot="title">T</h2><p data-slot="body">a</p><ul data-slot="body"><li>b</li></ul></section>',
];

const run = (html, systems = new Map([['acme', ACME]])) => {
  let asked = 0;
  const found = staticFindings(html, { exists: () => true, designSystems: () => { asked++; return systems; } });
  return { found, asked };
};

test('each design-system mistake is one warning on its slide, naming what the design system offers instead', () => {
  const { found } = run(deck(MISTAKES));
  const ds = found.filter((f) => f.rule.startsWith('ds-'));
  assert.deepEqual(ds.map((f) => [f.slide, f.level, f.rule]), [
    [1, 'warn', 'ds-unknown-system'],
    [2, 'warn', 'ds-unknown-template'],
    [3, 'warn', 'ds-unknown-slot'],
    [4, 'warn', 'ds-slot-twice'],
    [5, 'warn', 'ds-required-empty'],
  ]);
  const said = (rule) => ds.find((f) => f.rule === rule).message;
  assert.match(said('ds-unknown-system'), /the deck uses no design system called "other" \(it uses: acme@acme-mkt\); decklight design-system add other@<marketplace> <deck>/);
  assert.match(said('ds-unknown-template'), /acme@acme-mkt has no template "nope" \(its templates: section-divider, statement\)/);
  assert.equal(said('ds-unknown-slot'), 'data-slot="titel" — the section-divider template has no such slot (its slots: kicker, title*, subtitle, body; * = required)');
  assert.match(said('ds-slot-twice'), /data-slot="kicker" is filled twice/);
  assert.match(said('ds-required-empty'), /the statement template needs its "title" slot filled/);
  assert.equal(ds.find((f) => f.slide === 3).title, 'Exactly-once, end to end', 'named like every finding');
  assert.ok(found.every((f) => f.level !== 'error'), 'warnings only — the engine renders these slides plainly, it loses nothing');
});

test('a correct deck has nothing to say — the default slot may take several elements', () => {
  assert.deepEqual(run(deck(FIXED)).found.filter((f) => f.rule.startsWith('ds-')), []);
});

test('a design system this machine cannot read is said once; its templates and slots are skipped, not guessed', () => {
  const { found } = run(deck(MISTAKES.slice(1)), new Map([['acme', { ref: 'acme@acme-mkt', missing: 'its marketplace is not registered on this machine — decklight marketplace add acme/decklight-marketplace' }]]));
  const ds = found.filter((f) => f.rule.startsWith('ds-'));
  assert.deepEqual(ds.map((f) => [f.slide, f.rule]), [[null, 'ds-unresolved'], [3, 'ds-slot-twice']],
    'only what the file alone decides — a slot filled twice — survives');
  assert.match(ds[0].message, /design system acme@acme-mkt cannot be read on this machine — its marketplace is not registered.*; its slides' templates and slots go unchecked/);
});

test('a deck with no design system resolves nothing and says nothing new', () => {
  const plain = deck(['<section data-layout="split"><h2>A</h2><div>x</div><div>y</div></section>'], null);
  const { found, asked } = run(plain);
  assert.equal(asked, 0, 'no resolution attempted');
  assert.deepEqual(found.filter((f) => f.rule.startsWith('ds-')), []);
  // a slashed template with no design systems configured is still a mistake, decided from the file
  const r = run(deck([MISTAKES[0]], null));
  assert.equal(r.asked, 0);
  assert.match(r.found.find((f) => f.rule === 'ds-unknown-system').message, /\(it uses: none\)/);
});

test('decklight check: one warning per mistake, exit 0 — and the fixed deck reports nothing', (t) => {
  const dir = scratch('ds-check', t);
  const h = path.join(dir, 'home');
  const repo = path.join(dir, 'mkt');
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  cpSync(path.join(here, 'fixtures', 'design-systems', 'ok'), path.join(repo, 'systems', 'acme'), { recursive: true });
  writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({ name: 'acme-mkt', entries: [
    { name: 'acme', type: 'design-system', source: 'systems/acme', version: '1.2.0', apiVersion: 1 },
  ] }));
  const env = { ...process.env, DECKLIGHT_HOME: h };
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], { env, stdio: 'ignore' });
  const check = (file) => spawnSync(process.execPath, [CLI, 'check', file, '--no-render', '--json'], { env, encoding: 'utf8' });
  writeFileSync(path.join(dir, 'broken.html'), deck(MISTAKES));
  const broken = check(path.join(dir, 'broken.html'));
  assert.equal(broken.status, 0, broken.stderr);
  const rules = JSON.parse(broken.stdout).map((f) => f.rule);
  assert.deepEqual(rules.filter((r) => r.startsWith('ds-')), ['ds-unknown-system', 'ds-unknown-template', 'ds-unknown-slot', 'ds-slot-twice', 'ds-required-empty']);
  writeFileSync(path.join(dir, 'fixed.html'), deck(FIXED));
  const fixed = check(path.join(dir, 'fixed.html'));
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.deepEqual(JSON.parse(fixed.stdout).filter((f) => f.rule.startsWith('ds-')), []);
});
