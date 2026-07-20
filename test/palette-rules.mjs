#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Decklight theme palette-rule grader — the codified R-rules (SPEC §5,
// src/core/themegen.js) applied to the SHIPPED themes. Zero dependencies.
// Usage: node test/palette-rules.mjs [themes-dir]
// Exit 0 = every theme passes or carries a declared exception; 1 = violations.
//
// Machine-checkable subset (R5 is implied by R4; R7 is graded on the
// collection, not per theme):
//   R1  ≤6 hue families among accent/link/hl-* (sat ≥ 15%, 24° clusters)
//   R2  every --bg stop near-neutral: absolute chroma (max−min)/255 ≤ 0.09
//   R3  --accent saturation ≤ 75
//   R4  hl-{keyword,string,number,function,type} saturation spread ≤ 45
//   R6  no token is pure #fff/#ffffff/#000/#000000 (or white/black keywords)
//   R8  ansi red/green/yellow (+bright) hues stay in their semantic bands
//   R7  (collection) gradient canvases ≤ 30% of the shipped set
//
// Declared exceptions: a theme may opt out of a rule where conformance would
// break its identity — official brand colors, an intentional duotone canvas.
// Annotate IN THE THEME FILE, one per line, with a reason:
//   rule-exception: R2 official brand gradient canvas is the identity
// Undeclared violations fail; exceptions are printed so they stay reviewable.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { colorsIn, rgbToHsl, parseTheme } from './color.mjs';

const DIR = process.argv[2] ?? new URL('../themes/', import.meta.url).pathname;

// ── color math ───────────────────────────────────────────────────────────────
const hueDist = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

// hue must sit within a semantic band (circular)
const inBand = (h, lo, hi) => (lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi);

// ── per-theme rules ───────────────────────────────────────────────────────────
function grade(name, tokens, exceptions) {
  const errs = [], waived = [];
  const check = (rule, ok, msg) => {
    if (ok) return;
    if (exceptions[rule]) waived.push(`${rule} waived — ${exceptions[rule]}`);
    else errs.push(`${rule}: ${msg}`);
  };
  const hslOf = (tok) => {
    const c = colorsIn(tokens[tok] ?? '')[0];
    return c ? rgbToHsl(c) : null;
  };

  // R2 — quiet canvas: every stop of --bg near-neutral in absolute chroma
  const bgStops = colorsIn(tokens.bg ?? '');
  const loud = bgStops.filter((s) => rgbToHsl(s).chroma > 0.09);
  check('R2', loud.length === 0,
    `canvas stop chroma ${loud.map((s) => rgbToHsl(s).chroma.toFixed(2)).join('/')} > 0.09 (--bg too loud)`);

  // R3 — dimmed accent
  const acc = hslOf('accent');
  check('R3', !acc || acc.s <= 75, `--accent saturation ${acc?.s.toFixed(0)} > 75`);

  // R1 — limited palette: accent + link + syntax hues ≤ 6 families
  const family = ['accent', 'link', 'hl-keyword', 'hl-string', 'hl-number', 'hl-function', 'hl-type']
    .map(hslOf).filter((c) => c && c.s >= 15);
  const clusters = [];
  for (const c of family) {
    if (!clusters.some((h) => hueDist(h, c.h) <= 24)) clusters.push(c.h);
  }
  check('R1', clusters.length <= 6,
    `${clusters.length} hue families among accent/link/syntax (${clusters.map((h) => h.toFixed(0)).join(', ')}) > 6`);

  // R4 — one loudness band for syntax colors
  const sats = ['hl-keyword', 'hl-string', 'hl-number', 'hl-function', 'hl-type']
    .map(hslOf).filter((c) => c && c.s >= 15).map((c) => c.s);
  const spread = sats.length >= 2 ? Math.max(...sats) - Math.min(...sats) : 0;
  check('R4', spread <= 45, `syntax saturation spread ${spread.toFixed(0)} > 45`);

  // R6 — no pure black/white anywhere
  const pure = [];
  for (const [k, v] of Object.entries(tokens)) {
    if (/#(?:fff|ffffff|000|000000)\b/i.test(v) || /(?:^|\s)(white|black)(?:\s|$)/i.test(v)) pure.push('--' + k);
  }
  check('R6', pure.length === 0, `pure black/white in ${pure.join(', ')}`);

  // R8 — semantic terminal anchors (sat ≥ 15 required so the color reads at
  // all). The green band admits olive: the canon itself lives there
  // (Solarized green h68, Gruvbox h63).
  const bands = { red: [330, 40], green: [60, 170], yellow: [35, 70] };
  const off = [];
  for (const [anchor, [lo, hi]] of Object.entries(bands)) {
    for (const tok of [`ansi-${anchor}`, `ansi-bright-${anchor}`]) {
      const c = hslOf(tok);
      if (!c) continue;
      if (c.s < 15 || !inBand(c.h, lo, hi)) off.push(`--${tok} (h${c.h.toFixed(0)}/s${c.s.toFixed(0)})`);
    }
  }
  check('R8', off.length === 0, `off-anchor terminal colors: ${off.join(', ')}`);

  return { errs, waived };
}

// ── run ──────────────────────────────────────────────────────────────────────
const files = readdirSync(DIR).filter((f) => f.endsWith('.css')).sort();
let failures = 0, gradientCanvases = 0;
for (const f of files) {
  const css = readFileSync(join(DIR, f), 'utf8');
  const { tokens, exceptions } = parseTheme(css);
  if (!tokens.bg) continue; // not a theme file
  if ((tokens.bg ?? '').includes('gradient')) gradientCanvases++;
  const { errs, waived } = grade(f.replace(/\.css$/, ''), tokens, exceptions);
  if (errs.length) {
    failures++;
    console.log(`✖ ${f}`);
    for (const e of errs) console.log(`    ${e}`);
  } else if (waived.length) {
    console.log(`○ ${f}`);
    for (const w of waived) console.log(`    ${w}`);
  } else {
    console.log(`✔ ${f}`);
  }
}
// R7 on the collection: gradients stay the exception, not the norm
const share = gradientCanvases / Math.max(1, files.length);
console.log(`\nR7 (collection): ${gradientCanvases} gradient canvases / ${files.length} themes (${Math.round(share * 100)}%)`);
if (share > 0.3) { failures++; console.log('✖ R7: gradient canvases exceed 30% of the set'); }
console.log(failures ? `\n${failures} theme(s) violate palette rules` : '\nall themes conform (or carry declared exceptions)');
process.exit(failures ? 1 : 0);
