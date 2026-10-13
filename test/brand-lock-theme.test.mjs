// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The brand lock and the theme a deck opens on (SPEC BRAND_PALETTE,
// DESIGN_SYSTEM_ROLES, #819): `check` warns when a locked deck's configuration
// names a theme outside the brand (the runtime opens it on the brand's first,
// which the engine harness's `brandoffconfig` mode watches), and every role has
// a value even while no brand theme is applied.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticFindings, checkEntry } from '../cli/check.mjs';
import { packageVerdict, brandTags } from '../cli/design-system-refs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROLES = path.join(here, 'fixtures', 'design-systems', 'roles');
const systems = () => new Map([['acme', checkEntry('acme@acme-mkt', packageVerdict(ROLES))]]);
const deck = (cfg) => `<!doctype html><html><head><script type="application/json" data-decklight-config>${JSON.stringify({ decklight: '0.9.0', designSystems: ['acme@acme-mkt'], ...cfg })}</script></head><body><div class="decklight">
  <section><h2>Locked</h2><p style="color: var(--acme-color-text-accent)">a role</p></section>
</div></body></html>`;
const offBrand = (cfg) => staticFindings(deck(cfg), { designSystems: systems }).filter((f) => f.rule === 'theme-off-brand');

test('check warns theme-off-brand when a locked deck is configured on a theme outside its brand', () => {
  const found = offBrand({ theme: 'eclipse' });
  assert.deepEqual(found.map((f) => [f.level, f.slide, f.title]), [['warn', null, 'head']]);
  assert.match(found[0].message, /"theme": "eclipse" is not one of the brand's themes \(acme-dark, acme-light\) — a deck held to its brand opens on acme-dark instead/);
  assert.match(found[0].message, /"brandThemesOnly": false to wear eclipse/, 'it names the way out');
});

test('theme-off-brand stands down on a brand theme, an unlocked deck, a deck that names no theme, and a design system without themes', () => {
  assert.deepEqual(offBrand({ theme: 'acme-light' }), []);
  assert.deepEqual(offBrand({ theme: 'eclipse', brandThemesOnly: false }), [], 'unlocked: the deck may wear anything');
  assert.deepEqual(offBrand({}), [], 'no theme named: it opens on the brand\'s first, which is no one\'s mistake');
  const plain = () => new Map([['acme', { ref: 'acme@acme-mkt', templates: new Map(), components: {} }]]);
  assert.deepEqual(staticFindings(deck({ theme: 'eclipse' }), { designSystems: plain }).filter((f) => f.rule === 'theme-off-brand'), []);
});

test('every role has a value with no brand theme applied: the palette block carries them at the first theme, and each theme block sets them again after it', () => {
  const tags = brandTags('acme', packageVerdict(ROLES));
  const always = /<style data-design-system-palette="acme">([\s\S]*?)<\/style>/.exec(tags[0])?.[1] ?? '';
  assert.doesNotMatch(tags[0], /media=/, 'the palette block is always on');
  for (const role of ['text-heading', 'text-body', 'text-accent', 'surface-card']) assert.match(always, new RegExp(`--acme-color-${role}: var\\(--acme-[a-z]+-\\d+, #[0-9a-f]{6}\\);`), role);
  assert.match(always, /--acme-color-text-accent: var\(--acme-orange-500, #[0-9a-f]{6}\);/, "the first theme's value (acme-dark)");
  const light = tags.findIndex((t) => /data-theme="acme-light"/.test(t));
  assert.ok(light > 0, 'the theme blocks come after it, so the one applied wins');
  assert.match(tags[light], /--acme-color-text-accent: var\(--acme-blue-700, #[0-9a-f]{6}\);/);
});
