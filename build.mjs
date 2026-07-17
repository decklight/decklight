// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Build: src/index.js → dist/decklight.js (IIFE, global Decklight) + CSS copy.
// 'virtual:terminal' resolves to src/terminal/player.mjs when it exists so
// the core bundle works before the terminal subsystem lands.

import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const playerPath = resolve(here, 'src/terminal/player.mjs');
const hasTerminal = existsSync(playerPath);

// The runtime's own version (src/index.js) rides the banner: minification
// renames the exported const, so the banner is the one place a tool can read
// an inlined bundle's version (deckRuntimeVersion in cli/init.mjs, upgrade).
const runtimeVersion = /^export const version = '([^']+)';$/m
  .exec(readFileSync(resolve(here, 'src/index.js'), 'utf8'))?.[1];
if (!runtimeVersion) throw new Error('src/index.js: exported version const not found');

// Shipped theme names, baked into the bundle so the theme picker can list
// them without any config (directories aren't listable at runtime on file://).
const shippedThemes = readdirSync(resolve(here, 'themes'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => f.replace(/\.css$/, ''))
  .sort();

// Theme packs (themes/packs.json), baked in with the same rationale. Build
// guardrail: every shipped theme belongs to exactly one pack, and every pack
// entry has a theme file.
const packs = JSON.parse(readFileSync(resolve(here, 'themes/packs.json'), 'utf8'));
{
  const seen = new Map();
  for (const [pack, names] of Object.entries(packs.packs)) {
    for (const n of names) {
      if (seen.has(n)) throw new Error(`packs.json: ${n} is in both ${seen.get(n)} and ${pack}`);
      seen.set(n, pack);
    }
  }
  for (const n of shippedThemes) {
    if (!seen.has(n)) throw new Error(`packs.json: shipped theme ${n} is not in any pack`);
  }
  for (const n of seen.keys()) {
    if (!shippedThemes.includes(n)) throw new Error(`packs.json: ${n} has no theme file`);
  }
}

const virtualTerminal = {
  name: 'virtual-terminal',
  setup(b) {
    b.onResolve({ filter: /^virtual:terminal$/ }, () =>
      hasTerminal
        ? { path: playerPath }
        : { path: 'virtual:terminal', namespace: 'vt-stub' });
    b.onLoad({ filter: /.*/, namespace: 'vt-stub' }, () => ({
      contents: 'export const registerTerminals = null;',
      loader: 'js',
    }));
  },
};

await build({
  entryPoints: [resolve(here, 'src/index.js')],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'iife',
  globalName: 'Decklight',
  outfile: resolve(here, 'dist/decklight.js'),
  banner: { js: `/*! Decklight v${runtimeVersion} — Copyright 2026 Gilles Philippart — SPDX-License-Identifier: Apache-2.0 */` },
  plugins: [virtualTerminal],
  define: {
    __DECKLIGHT_THEMES__: JSON.stringify(shippedThemes),
    __DECKLIGHT_PACKS__: JSON.stringify(packs),
  },
  logLevel: 'info',
});

// dist CSS = core structure + the terminal player's stylesheet (chrome,
// ANSI-16 classes, screen sizing) — the player is bundled into decklight.js,
// so its CSS must ship in decklight.css too.
{
  const core = readFileSync(resolve(here, 'src/decklight.css'), 'utf8');
  const termCss = hasTerminal
    ? '\n\n' + readFileSync(resolve(here, 'src/terminal/terminal.css'), 'utf8') : '';
  writeFileSync(resolve(here, 'dist/decklight.css'), core + termCss);
}

const kb = (f) => (statSync(resolve(here, f)).size / 1024).toFixed(1) + ' KB';
console.log(`decklight.js ${kb('dist/decklight.js')} · decklight.css ${kb('dist/decklight.css')}` +
  (hasTerminal ? ' · terminal: bundled' : ' · terminal: stub (src/terminal/player.mjs absent)'));
