// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A design system's palette of scales, and the themes drawn from it (SPEC
// BRAND_PALETTE): the palette read and widened only where it is narrow, every
// brand theme expanded from swatches alone and held to the shipped themes'
// gates, the check's new rules, and the page every server builds from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch } from './helpers.mjs';
import {
  readScales, expandThemes, expandTheme, parseSwatchRef, nearestSwatch, paletteEntries, WEIGHTS,
} from '../tools/brand-palette.mjs';
import { validateTheme } from '../tools/theme-check.mjs';
import { checkDir } from '../cli/design-system.mjs';
import { linkDesignSystems, setDesignSystem } from '../cli/design-system-refs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const BRAND = path.join(here, 'fixtures', 'design-systems', 'brand');
const manifest = () => JSON.parse(readFileSync(path.join(BRAND, 'design-system.json'), 'utf8'));

/** A copy of the brand fixture with its manifest (and optionally its CSS) changed. */
function variant(t, change, css = null) {
  const dir = path.join(scratch('brand', t), 'acme');
  cpSync(BRAND, dir, { recursive: true });
  const m = manifest();
  change(m);
  writeFileSync(path.join(dir, 'design-system.json'), JSON.stringify(m, null, 2));
  if (css !== null) writeFileSync(path.join(dir, 'design-system.css'), css);
  return dir;
}

test('a full palette is read as it is: twelve colours, ten weights each, nothing derived, its neutral the one it marks', () => {
  const r = readScales(manifest().palette);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.notes, [], 'a palette that is already wide gains nothing');
  assert.equal(Object.keys(r.scales).length, 12);
  assert.equal(r.neutral, 'slate');
  for (const s of Object.values(r.scales)) assert.deepEqual(Object.keys(s.weights).map(Number), WEIGHTS);
});

test('a narrow scale has its missing weights derived between its own, and says which', () => {
  const p = manifest().palette;
  const blue = p.colors.blue.weights;
  p.colors.blue.weights = { 100: blue[100], 500: blue[500], 1000: blue[1000] };
  const r = readScales(p);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.scales.blue.derived, [200, 300, 400, 600, 700, 800, 900]);
  assert.equal(r.scales.blue.weights[500], blue[500], 'what the brand wrote is kept as written');
  assert.match(r.notes.map((n) => n.msg).join('\n'), /blue: 200, 300, 400, 600, 700, 800, 900 derived/);
  assert.equal(r.scales.red.derived.length, 0, 'the other scales are untouched');
});

test('a palette with no neutral gets one derived; one with a chroma-less scale has it taken as the neutral', () => {
  const p = manifest().palette;
  const slate = p.colors.slate;
  delete p.colors.slate;
  const r = readScales(p);
  assert.equal(r.neutral, 'neutral');
  assert.equal(r.scales.neutral.derived.length, 10);
  assert.match(r.notes.map((n) => n.msg).join('\n'), /no neutral scale: "neutral" is derived/);

  const q = manifest().palette;
  delete q.colors.slate.role;
  q.colors.grey = { label: 'Grey', weights: Object.fromEntries(WEIGHTS.map((w, i) => [w, `#${(0xf5 - i * 0x16).toString(16).padStart(2, '0').repeat(3)}`])) };
  delete q.colors.slate;
  const g = readScales(q);
  assert.equal(g.neutral, 'grey', 'no scale is marked, the one without chroma is the neutral');
  assert.ok(!g.scales.neutral);
  void slate;
});

test('a scale out of order, too narrow, or not a hex is refused, naming where', () => {
  const p = manifest().palette;
  [p.colors.red.weights[300], p.colors.red.weights[400]] = [p.colors.red.weights[400], p.colors.red.weights[300]];
  assert.match(readScales(p).problems[0].msg, /red: 400 .* is not darker than 300/);
  const q = manifest().palette;
  q.colors.red.weights = { 100: '#ffeeee', 900: '#330000' };
  assert.equal(readScales(q).problems[0].rule, 'palette-too-narrow');
  const x = manifest().palette;
  x.colors.red.weights[500] = 'red';
  assert.equal(readScales(x).problems[0].rule, 'palette-shape');
});

test('every brand theme is drawn from swatches alone, and passes every gate a shipped theme passes', () => {
  const read = readScales(manifest().palette);
  const { themes, problems } = expandThemes(read, manifest().themes, '--acme-');
  assert.deepEqual(problems, []);
  assert.deepEqual(themes.map((t) => t.name), ['acme-dark', 'acme-light']);
  const swatches = new Set(paletteEntries(read.scales, '--acme-').map((e) => e.hex));
  for (const t of themes) {
    assert.deepEqual(validateTheme(t.gateCss).errors, [], `${t.name} passes the contract and the contrast gates`);
    for (const [token, ref] of Object.entries(t.refs)) {
      for (const one of ref.split(' → ')) assert.ok(parseSwatchRef(one), `${t.name} ${token} = ${ref} is a swatch`);
    }
    for (const [token, v] of Object.entries(t.tokens)) {
      for (const hex of String(v).match(/#[0-9a-f]{6}\b/gi) ?? []) assert.ok(swatches.has(hex.toLowerCase()), `${t.name} ${token} ${hex} is on the palette`);
    }
    assert.equal(t.refs['--accent'], t.name === 'acme-dark' ? 'orange-500' : 'blue-700', 'what the brand stated is what it gets');
    // the page gets tokens, each with its hex: the colour survives the design system going missing
    assert.match(t.css, /--bg: var\(--acme-slate-(100|1000), #[0-9a-f]{6}\);/);
  }
  const dark = themes[0];
  for (let i = 1; i <= 6; i++) {
    const [c, w] = dark.refs[`--d-fill-${i}`].split(/-(?=\d+$)/);
    const [ci, wi] = (dark.refs[`--d-fill-${i}-in`] ?? '').split(/-(?=\d+$)/);
    assert.equal(ci, c, 'a nested box keeps its panel\'s colour');
    assert.ok(Number(wi) < Number(w), 'one weight toward the ink (lighter, on a dark theme)');
  }
  assert.equal(new Set([1, 2, 3, 4, 5, 6].map((i) => dark.refs[`--d-fill-${i}`].split('-')[0])).size, 6, 'six fills, six colours');
});

test('a theme cannot write a colour that is not a swatch, nor an opacity where a gate reads it', () => {
  const read = readScales(manifest().palette);
  const off = expandTheme(read, { name: 'x', mode: 'dark', tokens: { '--accent': '#ff6600' } }, '--acme-');
  assert.equal(off.problems[0].rule, 'theme-off-palette');
  assert.match(off.problems[0].msg, /--accent "#ff6600" names no swatch/);
  assert.equal(expandTheme(read, { name: 'x', mode: 'dark', tokens: { '--accent': 'chartreuse-500' } }, '--acme-').problems[0].rule, 'theme-off-palette');
  assert.match(expandTheme(read, { name: 'x', mode: 'dark', tokens: { '--fg': 'slate-100/50' } }, '--acme-').problems[0].msg, /opaque/);
  const sel = expandTheme(read, { name: 'x', mode: 'dark', tokens: { '--term-selection': 'blue-500/30' } }, '--acme-');
  assert.deepEqual(sel.problems, []);
  assert.match(sel.css, /--term-selection: color-mix\(in srgb, var\(--acme-blue-500, #[0-9a-f]{6}\) 30%, transparent\)/);
  const grad = expandTheme(read, { name: 'x', mode: 'dark', tokens: { '--bg': { gradient: ['blue-1000', 'indigo-1000'], angle: 160 } } }, '--acme-');
  assert.deepEqual(grad.problems, []);
  assert.match(grad.css, /--bg: linear-gradient\(160deg, var\(--acme-blue-1000, #[0-9a-f]{6}\), var\(--acme-indigo-1000, #[0-9a-f]{6}\)\)/);
  assert.equal(expandTheme(read, { name: 'x', mode: 'dark', tokens: { '--wobble': 'blue-500' } }, '--acme-').problems[0].rule, 'theme-token');
});

test('a stated choice that fails a gate is refused, and the message names the choice', () => {
  const read = readScales(manifest().palette);
  const r = expandTheme(read, { name: 'x', mode: 'light', tokens: { '--fg': 'slate-300' } }, '--acme-');
  assert.ok(r.problems.length);
  assert.equal(r.problems[0].rule, 'theme-contrast');
  assert.match(r.problems[0].msg, /--fg .* on --bg: .* < 4\.5 \(stated: --fg slate-300\)/);
});

test('nearestSwatch finds the palette colour a literal stands nearest', () => {
  const read = readScales(manifest().palette);
  const blue700 = read.scales.blue.weights[700];
  assert.deepEqual([nearestSwatch(read.scales, blue700).ref, nearestSwatch(read.scales, blue700).distance], ['blue-700', 0]);
});

test('design-system check admits the brand package and reports its palette and themes; refuses what breaks the rules', (t) => {
  const ok = checkDir(BRAND);
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.equal(ok.summary.palette, '12 colours, 120 swatches');
  assert.deepEqual(ok.summary.brand.themes.map((x) => x.name), ['acme-dark', 'acme-light']);
  const report = execFileSync(process.execPath, [CLI, 'design-system', 'gate', BRAND], { encoding: 'utf8' });
  assert.match(report, /theme {16}acme-dark \(dark\) — 1 token stated, \d+ chosen from the palette/);

  // a swatch redefined in the CSS: the manifest is the one source
  const redefined = checkDir(variant(t, () => {}, '.decklight { --acme-blue-500: #000; }\n'));
  assert.equal(redefined.problems[0].rule, 'palette-redefined');
  // a scale palette at apiVersion 1: an older decklight would refuse it
  assert.match(checkDir(variant(t, (m) => { m.apiVersion = 1; })).problems.map((p) => p.msg).join('\n'), /needs apiVersion 2/);
  // a shipped theme's name
  assert.match(checkDir(variant(t, (m) => { m.themes[0].name = 'aurora'; })).problems.map((p) => p.msg).join('\n'), /"aurora" is a theme decklight ships/);
  // an off-palette colour in a theme
  assert.equal(checkDir(variant(t, (m) => { m.themes[0].tokens['--accent'] = '#ff6600'; })).problems[0].rule, 'theme-off-palette');
  // a recommended shipped theme whose colours are not the brand's is said, not refused
  const rec = checkDir(variant(t, (m) => { m.recommendedThemes = ['aurora']; }));
  assert.equal(rec.ok, true);
  assert.equal(rec.warnings.find((w) => w.rule === 'recommended-off-palette')?.rule, 'recommended-off-palette');
});

test('every server gives the page the swatches as tokens and each brand theme as an added theme, tagged with its design system', (t) => {
  const dir = scratch('brand-serve', t);
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'mkt');
  mkdirSync(path.join(repo, '.decklight'), { recursive: true });
  cpSync(BRAND, path.join(repo, 'systems', 'acme'), { recursive: true });
  writeFileSync(path.join(repo, '.decklight/marketplace.json'), JSON.stringify({
    name: 'acme-mkt', title: 'Acme', entries: [{ name: 'acme', type: 'design-system', source: 'systems/acme', version: '2.0.0', apiVersion: 2 }],
  }));
  execFileSync(process.execPath, [CLI, 'marketplace', 'add', repo], { env: { ...process.env, DECKLIGHT_HOME: home }, stdio: 'ignore' });
  const deck = '<!doctype html><html><head><title>T</title>\n<script type="application/json" data-decklight-config>{"decklight":"0.9.0","theme":"acme-dark"}</script>\n</head><body><div class="decklight"><section>a</section></div></body></html>';
  const using = setDesignSystem(deck, 'acme@acme-mkt', true, { home });
  const page = linkDesignSystems(using.html ?? using, home);
  assert.match(page, /<style data-design-system-palette="acme">\n\.decklight \{\n {2}--acme-slate-100: #[0-9a-f]{6};/);
  assert.equal((page.match(/--acme-[a-z]+-\d+: #/g) ?? []).length, 120);
  assert.match(page, /<style data-theme="acme-dark" data-theme-added data-design-system-theme="acme" data-theme-source="Acme Brand" media="not all">/);
  assert.match(page, /<style data-theme="acme-light" data-theme-added data-design-system-theme="acme"/);
  const meta = JSON.parse(page.match(/data-design-system-meta="acme">([\s\S]*?)<\/script>/)[1]);
  assert.equal(meta.scales, true);
  assert.equal(meta.palette.length, 120);
  assert.deepEqual(meta.palette[0], { group: 'Slate', label: 'Slate 100', short: '100', token: '--acme-slate-100', hex: meta.palette[0].hex, ref: 'slate-100' });
  assert.deepEqual(meta.themes.map((x) => [x.name, x.mode]), [['acme-dark', 'dark'], ['acme-light', 'light']]);
});

test('decklight check warns about a literal colour off the palette, on a deck held to its brand — and only then', async () => {
  const { staticFindings } = await import('../cli/check.mjs');
  const read = readScales(manifest().palette);
  const palette = paletteEntries(read.scales, '--acme-').map((e) => ({ ref: e.ref, hex: e.hex }));
  const systems = () => new Map([['acme', { ref: 'acme@acme-mkt', templates: new Map(), palette, themes: 2 }]]);
  const onBrand = read.scales.blue.weights[700];
  const deck = (cfg) => `<!doctype html><html><head><script type="application/json" data-decklight-config>${JSON.stringify({ decklight: '0.9.0', designSystems: ['acme@acme-mkt'], ...cfg })}</script></head><body><div class="decklight">
    <section><h2>On</h2><svg viewBox="0 0 10 10"><rect fill="${onBrand}" width="5" height="5"/></svg></section>
    <section><h2>Off</h2><svg viewBox="0 0 10 10"><rect style="fill: #3a7d44; stroke: var(--d-stroke)" width="5" height="5"/></svg><p style="color: #ff00ff">hey</p></section>
  </div></body></html>`;
  const found = staticFindings(deck({}), { designSystems: systems }).filter((f) => f.rule === 'off-palette-literal');
  assert.deepEqual(found.map((f) => f.slide), [2], 'the palette colour passes; the slide with two literals is said once');
  assert.match(found[0].message, /#3a7d44 \(nearest [a-z]+-\d+\), #ff00ff \(nearest [a-z]+-\d+\) are not in the brand's palette/);
  assert.equal(staticFindings(deck({ brandThemesOnly: false }), { designSystems: systems }).filter((f) => f.rule === 'off-palette-literal').length, 0, 'unlocked: the deck may wear anything');
  const noThemes = () => new Map([['acme', { ref: 'acme@acme-mkt', templates: new Map(), palette, themes: 0 }]]);
  assert.equal(staticFindings(deck({}), { designSystems: noThemes }).filter((f) => f.rule === 'off-palette-literal').length, 0, 'a palette with no themes holds nothing');
});

test('the brand lock is written as the configuration says it: false written, true taken off', async () => {
  const { setDeckBrandThemesOnly } = await import('../cli/runtime-link.mjs');
  const deck = '<!doctype html><html><head><script type="application/json" data-decklight-config>{ "decklight": "0.9.0", "theme": "acme-dark" }</script></head><body></body></html>';
  const off = setDeckBrandThemesOnly(deck, false);
  assert.match(off, /"theme": "acme-dark", "brandThemesOnly": false/);
  assert.equal(setDeckBrandThemesOnly(off, true), deck);
  assert.equal(setDeckBrandThemesOnly('<html><body></body></html>', false), null, 'no configuration block, nothing to write');
});

test('a bundle carries the swatches and the brand themes in the same tags the servers inject', async () => {
  const { bundleDesignSystem, packageVerdict } = await import('../cli/design-system-refs.mjs');
  const verdict = packageVerdict(BRAND);
  assert.equal(verdict.ok, true);
  const block = bundleDesignSystem({ dir: BRAND, name: 'acme' }, verdict);
  assert.deepEqual(block.brandThemes, ['acme-dark', 'acme-light']);
  const tags = block.tags.join('\n');
  assert.match(tags, /<style data-design-system-palette="acme">/);
  assert.match(tags, /<style data-theme="acme-dark" data-theme-added data-design-system-theme="acme" data-theme-source="Acme Brand" media="not all">/);
  assert.match(tags, /"scales":true/);
});
