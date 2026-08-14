#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Every shipped theme, against the token contract and the WCAG gates.
// Zero dependencies. Usage: node test/contrast.mjs [themes-dir]
// Exit code 0 = all themes pass; 1 = failures (listed per theme).
//
// The rules themselves live in tools/theme-check.mjs so that they SHIP: a
// theme author outside this repo needs to run the same gates their file will
// be judged by, and `test/` is not in the npm package. This file is the loop
// that applies them to themes/; `decklight theme check` applies them to one
// file. The two can never drift, because there is only one copy of the rules.
//
// Assertions (SPEC THEMING + presentation-quality extras, marked ✦):
//   --fg              on --bg        ≥ 4.5   (gradients: every stop must pass)
//   --muted           on --bg        ≥ 3.0
//   --heading-color   on --bg        ≥ 3.0
//   --link            on --bg        ≥ 3.0   ✦
//   --d-text          on --bg        ≥ 3.0   ✦ (diagram text sits on the canvas)
//   --d-text          on --d-fill-*  ≥ 3.0   ✦ (…and on every panel)
//   --d-muted/-accent on --d-fill-*  ≥ 2.6   ✦ (sublabels + emphasis ink)
//   --accent-contrast on --accent    ≥ 4.5
//   --code-fg         on --code-bg   ≥ 4.5
//   --hl-*            on --code-bg   ≥ 4.5   (--hl-comment ≥ 3.0)
//   --term-fg         on --term-bg   ≥ 3.0
//   --term-prompt     on --term-bg   ≥ 3.0   ✦
//   --ansi-* (16)     on --term-bg   ≥ 3.0

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTheme } from '../tools/theme-check.mjs';

// fileURLToPath, never `.pathname` — the same trap #273 found in `cli/`, with a
// second face on Windows: a URL path is percent-encoded (`/Users/First%20Last/…`)
// AND it keeps a leading slash before the drive letter, so `.pathname` here read
// `D:\D:\a\decklight\themes` and this harness had never run anywhere it could.
const DIR = process.argv[2] ?? fileURLToPath(new URL('../themes/', import.meta.url));

const files = readdirSync(DIR).filter((f) => f.endsWith('.css')).sort();
if (files.length === 0) { console.error(`no theme css found in ${DIR}`); process.exit(1); }

let failures = 0;
const summary = [];

for (const file of files) {
  const name = file.replace(/\.css$/, '');
  const { ok, errors } = validateTheme(readFileSync(join(DIR, file), 'utf8'));
  if (ok) { summary.push(name); continue; }
  failures++;
  console.log(`✘ ${name}`);
  for (const e of errors) console.log(`    ${e}`);
}

console.log(`\n${summary.length}/${files.length} themes pass WCAG + token-contract validation`);
if (failures) { console.log(`${failures} theme(s) FAILED`); process.exit(1); }
