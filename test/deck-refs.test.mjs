// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What a deck references from a marketplace, as one table (cli/deck-refs.mjs):
// the wiring that was written three times — the link chain at each place a
// deck is served, the asset lookups in the static server — written once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { REFERENCE_KINDS, linkReferences, namespacedKind, fallbackReferenceAsset } from '../cli/deck-refs.mjs';
import { linkAddedThemes } from '../cli/theme-refs.mjs';
import { linkDesignSystems } from '../cli/design-system-refs.mjs';
import { linkFonts } from '../cli/font-refs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DECK = '<!doctype html><html><head>'
  + '<script type="application/json" data-decklight-config>{"decklight":"0.9.0","theme":"aurora","markedThemes":["ember"]}</script>'
  + '</head><body><div class="decklight"><section><h2>Hi</h2></section></div></body></html>';

test('the table is the three kinds, in the order the chain nested them', () => {
  assert.deepEqual(REFERENCE_KINDS.map((k) => k.kind), ['theme', 'design-system', 'font']);
});

test('linkReferences serves exactly the bytes the three nested calls did', () => {
  assert.equal(linkReferences(DECK), linkFonts(linkDesignSystems(linkAddedThemes(DECK))));
});

test('design systems and fonts own their URLs; a theme is the fallback', () => {
  assert.equal(namespacedKind('decklight-design-system/acme/brand/logo.svg')?.kind, 'design-system');
  assert.equal(namespacedKind('slides/decklight-font/type/inter/inter.woff2')?.kind, 'font');
  assert.equal(namespacedKind('decklight-theme/acme/nord.css'), null, 'a theme has no terminal namespace');
  assert.equal(namespacedKind('pictures/hero.jpg'), null);
  assert.equal(fallbackReferenceAsset('pictures/hero.jpg'), null, 'nothing answers a path no kind claims');
});

test('no served page chains the three link calls by hand any more', () => {
  for (const f of ['serve.mjs', 'edit.mjs']) {
    const src = readFileSync(path.join(here, '..', 'cli', f), 'utf8');
    assert.doesNotMatch(src, /linkFonts\(linkDesignSystems\(linkAddedThemes\(/, `${f} still chains them`);
  }
});

test('theme has the grammar font and design-system have: add, remove, list, gate', () => {
  const CLI = path.join(here, '..', 'cli', 'decklight.mjs');
  const help = execFileSync(process.execPath, [CLI, 'theme', '--help'], { encoding: 'utf8' });
  assert.match(help, /usage: decklight theme <add\|remove\|list\|gate>/);
  const listed = execFileSync(process.execPath, [CLI, 'theme', 'list', path.join(here, '..', 'demo', 'intro.html')], { encoding: 'utf8' });
  assert.match(listed, /opens on \w+/);
});
