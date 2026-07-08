#!/usr/bin/env node
// Decklight theme validator — WCAG contrast + token-contract presence checks.
// Zero dependencies. Usage: node test/contrast.mjs [themes-dir]
// Exit code 0 = all themes pass; 1 = failures (listed per theme).
//
// Assertions (SPEC §5 + presentation-quality extras, marked ✦):
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

const DIR = process.argv[2] ?? new URL('../themes/', import.meta.url).pathname;

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

// ── color math ───────────────────────────────────────────────────────────────
const NAMED = { white: [255, 255, 255], black: [0, 0, 0] };

function parseColor(str) {
  str = str.trim();
  if (NAMED[str.toLowerCase()]) return NAMED[str.toLowerCase()];
  let m = str.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  }
  m = str.match(/^rgba?\(([^)]*)\)$/i);
  if (m) {
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
    return p.slice(0, 3);
  }
  m = str.match(/^hsla?\(([^)]*)\)$/i);
  if (m) {
    const p = m[1].split(/[\s,\/]+/).filter(Boolean);
    const h = parseFloat(p[0]), s = parseFloat(p[1]) / 100, l = parseFloat(p[2]) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), mm = l - c / 2;
    const seg = Math.floor(h / 60) % 6;
    const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
    return rgb.map(v => Math.round((v + mm) * 255));
  }
  return null;
}

function luminance([r, g, b]) {
  const lin = [r, g, b].map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(c1, c2) {
  const [l1, l2] = [luminance(c1), luminance(c2)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

// extract every color literal in a value (handles gradients → all stops)
function colorsIn(value) {
  const out = [];
  const re = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;
  for (const m of value.match(re) ?? []) {
    const c = parseColor(m);
    if (c) out.push(c);
  }
  return out;
}

// ── theme parsing ────────────────────────────────────────────────────────────
function parseTheme(css) {
  const tokens = {};
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of noComments.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens[m[1].toLowerCase()] = m[2].trim();
  }
  // resolve var() references (depth-limited)
  const resolve = (v, depth = 0) => {
    if (depth > 5) return v;
    return v.replace(/var\(--([a-z0-9-]+)\)/gi, (_, name) =>
      tokens[name.toLowerCase()] !== undefined ? resolve(tokens[name.toLowerCase()], depth + 1) : _);
  };
  for (const k of Object.keys(tokens)) tokens[k] = resolve(tokens[k]);
  return tokens;
}

// min contrast of a fg color against every stop of a (possibly gradient) bg value
function minContrast(fgValue, bgValue) {
  const fg = colorsIn(fgValue)[0];
  const stops = colorsIn(bgValue);
  if (!fg || stops.length === 0) return null;
  return Math.min(...stops.map(s => contrast(fg, s)));
}

// ── run ──────────────────────────────────────────────────────────────────────
const files = readdirSync(DIR).filter(f => f.endsWith('.css')).sort();
if (files.length === 0) { console.error(`no theme css found in ${DIR}`); process.exit(1); }

let failures = 0;
const summary = [];

for (const file of files) {
  const name = file.replace(/\.css$/, '');
  const t = parseTheme(readFileSync(join(DIR, file), 'utf8'));
  const errs = [];

  for (const req of REQUIRED) if (!(req in t)) errs.push(`missing token --${req}`);

  const check = (fgTok, bgTok, min) => {
    if (!(fgTok in t) || !(bgTok in t)) return; // presence error already recorded
    const r = minContrast(t[fgTok], t[bgTok]);
    if (r === null) { errs.push(`--${fgTok} on --${bgTok}: unparseable color`); return; }
    if (r < min) errs.push(`--${fgTok} (${t[fgTok].slice(0, 28)}) on --${bgTok}: ${r.toFixed(2)} < ${min}`);
  };

  check('fg', 'bg', 4.5);
  check('muted', 'bg', 3.0);
  check('heading-color', 'bg', 3.0);
  check('link', 'bg', 3.0);
  check('d-text', 'bg', 3.0);
  // Diagram ink must clear the diagram PANELS, not just the canvas — labels
  // sit on the fills (the gameboy lesson: every canvas gate passed while the
  // boxes were unreadable).
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

  if (errs.length) {
    failures++;
    console.log(`✘ ${name}`);
    for (const e of errs) console.log(`    ${e}`);
  } else {
    summary.push(name);
  }
}

console.log(`\n${summary.length}/${files.length} themes pass WCAG + token-contract validation`);
if (failures) { console.log(`${failures} theme(s) FAILED`); process.exit(1); }
