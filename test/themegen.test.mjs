// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Theme generator property tests — every generated theme must satisfy the
// full SPEC §5 token contract and the same WCAG gates test/contrast.mjs
// enforces on shipped themes. The contrast math here is an independent copy
// of the validator's (not imported from themegen) so the generator can't
// grade its own homework.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTheme, tokensToCss } from '../src/core/themegen.js';

// ── independent WCAG math (ported from test/contrast.mjs) ───────────────────
function parseColor(str) {
  str = str.trim();
  if (/^white$/i.test(str)) return [255, 255, 255];
  if (/^black$/i.test(str)) return [0, 0, 0];
  let m = str.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = str.match(/^rgba?\(([^)]*)\)$/i);
  if (m) return m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat).slice(0, 3);
  return null;
}

function luminance([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(c1, c2) {
  const [l1, l2] = [luminance(c1), luminance(c2)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

function colorsIn(value) {
  const out = [];
  const re = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;
  for (const m of value.match(re) ?? []) {
    const c = parseColor(m);
    if (c) out.push(c);
  }
  return out;
}

function minContrast(fgValue, bgValue) {
  const fg = colorsIn(fgValue)[0];
  const stops = colorsIn(bgValue);
  if (!fg || stops.length === 0) return null;
  return Math.min(...stops.map((s) => contrast(fg, s)));
}

// ── the contract (mirrors test/contrast.mjs REQUIRED + gates) ────────────────
const REQUIRED = [
  'bg', 'bg-accent', 'fg', 'muted',
  'font-body', 'font-heading', 'font-mono', 'heading-color', 'heading-weight', 'link',
  'accent', 'accent-contrast',
  'block-bg', 'block-border', 'block-radius', 'shadow',
  'code-bg', 'code-fg', 'hl-keyword', 'hl-string', 'hl-number', 'hl-comment', 'hl-function', 'hl-type', 'hl-punct',
  'd-stroke', 'd-text', 'd-muted', 'd-accent', 'd-fill-1', 'd-fill-2', 'd-fill-3', 'd-fill-4', 'd-fill-5', 'd-fill-6',
  'term-bg', 'term-fg', 'term-prompt', 'term-cursor', 'term-selection',
  'ansi-black', 'ansi-red', 'ansi-green', 'ansi-yellow', 'ansi-blue', 'ansi-magenta', 'ansi-cyan', 'ansi-white',
  'ansi-bright-black', 'ansi-bright-red', 'ansi-bright-green', 'ansi-bright-yellow',
  'ansi-bright-blue', 'ansi-bright-magenta', 'ansi-bright-cyan', 'ansi-bright-white',
];

function gateErrors(tokens) {
  // tokens keyed with the leading `--`; normalize to bare names like the validator
  const t = {};
  for (const [k, v] of Object.entries(tokens)) t[k.replace(/^--/, '')] = v;
  const errs = [];
  for (const req of REQUIRED) if (!(req in t)) errs.push(`missing token --${req}`);
  const check = (fgTok, bgTok, min) => {
    if (!(fgTok in t) || !(bgTok in t)) return;
    const r = minContrast(t[fgTok], t[bgTok]);
    if (r === null) { errs.push(`--${fgTok} on --${bgTok}: unparseable`); return; }
    if (r < min) errs.push(`--${fgTok} (${t[fgTok]}) on --${bgTok} (${t[bgTok]}): ${r.toFixed(2)} < ${min}`);
  };
  check('fg', 'bg', 4.5);
  check('muted', 'bg', 3.0);
  check('heading-color', 'bg', 3.0);
  check('link', 'bg', 3.0);
  check('d-text', 'bg', 3.0);
  for (let i = 1; i <= 6; i++) {
    check('d-text', `d-fill-${i}`, 3.0);
    check('d-muted', `d-fill-${i}`, 2.6);
    check('d-accent', `d-fill-${i}`, 2.6);
  }
  check('accent-contrast', 'accent', 4.5);
  check('code-fg', 'code-bg', 4.5);
  for (const hl of ['keyword', 'string', 'number', 'function', 'type', 'punct']) check(`hl-${hl}`, 'code-bg', 4.5);
  check('hl-comment', 'code-bg', 3.0);
  check('term-fg', 'term-bg', 3.0);
  check('term-prompt', 'term-bg', 3.0);
  for (const a of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
    check(`ansi-${a}`, 'term-bg', 3.0);
    check(`ansi-bright-${a}`, 'term-bg', 3.0);
  }
  return errs;
}

// same parser the validator uses on theme files (round-trip check)
function parseThemeCss(css) {
  const tokens = {};
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of noComments.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens['--' + m[1].toLowerCase()] = m[2].trim();
  }
  return tokens;
}

// ── tests ────────────────────────────────────────────────────────────────────
test('property: 100 seeded generations all satisfy the token contract + WCAG gates', () => {
  let gradients = 0, darks = 0;
  for (let seed = 0; seed < 100; seed++) {
    const { name, tokens } = generateTheme(seed);
    const errs = gateErrors(tokens);
    assert.deepEqual(errs, [], `seed ${seed} (${name}) failed gates:\n  ${errs.join('\n  ')}`);
    assert.match(name, /^gen-[a-z]+-[0-9a-f]{4}$/, `seed ${seed}: bad autoname ${name}`);
    if (tokens['--bg'].includes('gradient')) gradients++;
    if (luminance(colorsIn(tokens['--bg'])[0]) < 0.5) darks++;
  }
  // personality spread sanity: both modes occur, gradients occur but aren't the norm
  assert.ok(darks >= 25 && darks <= 75, `mode balance off: ${darks}/100 dark`);
  assert.ok(gradients >= 8 && gradients <= 45, `gradient share off: ${gradients}/100`);
});

// ── codified palette rules (themegen.js RULES, R1–R8) ───────────────────────
// Independent HSL math again, so the generator can't grade its own homework.
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const c = max - min;
  let h = 0;
  if (c) {
    if (max === r) h = ((g - b) / c) % 6;
    else if (max === g) h = (b - r) / c + 2;
    else h = (r - g) / c + 4;
    h = (h * 60 + 360) % 360;
  }
  const s = c === 0 ? 0 : c / (1 - Math.abs(2 * l - 1));
  return { h, s: s * 100, l: l * 100, chroma: c };
}

const hueDist = (a, b) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

test('property: codified palette rules hold across 200 seeds', () => {
  let gradients = 0;
  for (let seed = 0; seed < 200; seed++) {
    const { name, tokens } = generateTheme(seed);
    const label = `seed ${seed} (${name})`;

    // R2 — quiet dominant areas: every canvas stop stays near-neutral in
    // absolute chroma terms (max−min channel spread), gradient stops included.
    for (const stop of colorsIn(tokens['--bg'])) {
      const { chroma } = rgbToHsl(stop);
      assert.ok(chroma <= 0.09, `${label}: R2 — bg stop chroma ${chroma.toFixed(3)} > 0.09 (canvas too loud)`);
    }

    // R3 — dimmed pastels: the accent never reaches neon saturation.
    const accentHsl = rgbToHsl(colorsIn(tokens['--accent'])[0]);
    assert.ok(accentHsl.s <= 75, `${label}: R3 — accent sat ${accentHsl.s.toFixed(0)} > 75`);

    // R1 — limited palette: accent + link + the five syntax hues collapse
    // into at most 6 hue families (the base hue + ≤5 harmony hues). Colors
    // desaturated below 15% are neutrals — hue is meaningless there.
    const family = ['--accent', '--link', '--hl-keyword', '--hl-string', '--hl-number', '--hl-function', '--hl-type']
      .map((k) => rgbToHsl(colorsIn(tokens[k])[0]))
      .filter((c) => c.s >= 15);
    const clusters = [];
    for (const c of family) {
      if (!clusters.some((h) => hueDist(h, c.h) <= 24)) clusters.push(c.h);
    }
    assert.ok(clusters.length <= 6, `${label}: R1 — ${clusters.length} hue families > 6 (${clusters.map((h) => h.toFixed(0)).join(', ')})`);

    // R4/R5 — one accent band: syntax colors share saturation (hue does the
    // differentiating, not loudness). Wide tolerance covers fitContrast's
    // per-hue desaturation steps and RGB rounding.
    const sats = ['--hl-keyword', '--hl-string', '--hl-number', '--hl-function', '--hl-type']
      .map((k) => rgbToHsl(colorsIn(tokens[k])[0]).s).filter((s) => s >= 15);
    if (sats.length >= 2) {
      const spread = Math.max(...sats) - Math.min(...sats);
      assert.ok(spread <= 45, `${label}: R4 — syntax saturation spread ${spread.toFixed(0)} > 45`);
    }

    // R6 — no pure black or white anywhere in the token set.
    for (const [k, v] of Object.entries(tokens)) {
      if (typeof v !== 'string') continue;
      assert.ok(!/#(?:fff|ffffff|000|000000)\b/i.test(v), `${label}: R6 — ${k} is pure black/white (${v})`);
    }

    if (tokens['--bg'].includes('gradient')) gradients++;
  }
  // R7 — gradients sparingly: ~15% of rolls (deterministic seeds, loose band).
  assert.ok(gradients >= 12 && gradients <= 55, `R7 — gradient share off: ${gradients}/200`);
});

test('determinism: same seed → identical name and tokens', () => {
  const a = generateTheme(42);
  const b = generateTheme(42);
  assert.equal(a.name, b.name);
  assert.deepEqual(a.tokens, b.tokens);
  const c = generateTheme(43);
  assert.notDeepEqual(a.tokens, c.tokens, 'different seeds should differ');
});

test('tokensToCss round-trips through the validator parser and still passes', () => {
  for (const seed of [1, 7, 42, 99]) {
    const { name, tokens } = generateTheme(seed);
    const css = tokensToCss(name, tokens);
    assert.ok(css.includes('generated by Decklight'), 'header comment present');
    assert.ok(css.includes('.decklight {'), 'scoped to .decklight');
    const parsed = parseThemeCss(css);
    for (const [k, v] of Object.entries(tokens)) {
      assert.equal(parsed[k], v, `seed ${seed}: token ${k} lost or altered in CSS round-trip`);
    }
    const errs = gateErrors(parsed);
    assert.deepEqual(errs, [], `seed ${seed}: round-tripped CSS failed gates`);
  }
});
