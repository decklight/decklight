// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A design system's roles (SPEC DESIGN_SYSTEM_ROLES): declared in the
// manifest, given a swatch by every theme, read (never defined) by the
// package's stylesheet, the theme contract derived from them, emitted on each
// brand theme so `T` recolours every role, the only colours the Colors tab
// offers on a deck held to the brand, and what `check` and the gate hold
// slides and components to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch } from './helpers.mjs';
import { readScales, expandTheme, offRoleColours, nearestRole, roleToken } from '../tools/brand-palette.mjs';
import { checkDir, reportLines } from '../cli/design-system.mjs';
import { packageVerdict, designSystemMeta, brandTags, bundleDesignSystem } from '../cli/design-system-refs.mjs';
import { staticFindings, checkEntry } from '../cli/check.mjs';
import { rolePalette } from '../src/core/colorpicker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROLES = path.join(here, 'fixtures', 'design-systems', 'roles');
const manifest = () => JSON.parse(readFileSync(path.join(ROLES, 'design-system.json'), 'utf8'));
const cssOf = () => readFileSync(path.join(ROLES, 'design-system.css'), 'utf8');

/** A copy of the roles fixture with its manifest (and optionally its CSS or templates) changed. */
function variant(t, change, { css = null, templates = null } = {}) {
  const dir = path.join(scratch('roles', t), 'acme');
  cpSync(ROLES, dir, { recursive: true });
  const m = manifest();
  change(m);
  writeFileSync(path.join(dir, 'design-system.json'), JSON.stringify(m, null, 2));
  if (css !== null) writeFileSync(path.join(dir, 'design-system.css'), css);
  if (templates !== null) writeFileSync(path.join(dir, 'templates.html'), templates);
  return dir;
}
const rules = (r) => r.problems.map((p) => p.rule);

// ── the manifest ─────────────────────────────────────────────────────────────

test('the roles fixture passes its gate, and the report says what its roles are', () => {
  const r = checkDir(ROLES);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.warnings, [], 'its components read roles only');
  assert.deepEqual(r.summary.brand.roles.map((x) => [x.id, x.group, x.token]), [
    ['text-heading', 'Text', '--acme-color-text-heading'],
    ['text-body', 'Text', '--acme-color-text-body'],
    ['text-accent', 'Text', '--acme-color-text-accent'],
    ['surface-card', 'Surface', '--acme-color-surface-card'],
    ['surface-panel', 'Surface', '--acme-color-surface-panel'],
    ['surface-panel-in', 'Surface', '--acme-color-surface-panel-in'],
  ]);
  const report = reportLines(ROLES, r).join('\n');
  assert.match(report, /roles {16}6 roles — Text 3, Surface 3 · 5 contract tokens read from them/);
  assert.match(report, /acme-dark \(dark\) — 5 tokens stated \(5 through roles\), 57 chosen from the palette, every role set/);
});

test('roles and contract are shaped: a label and a group per role, contract tokens of the theme contract naming declared roles', (t) => {
  const bad = (change) => checkDir(variant(t, change));
  const shape = bad((m) => { m.roles['text-body'] = { group: 'Text' }; });
  assert.ok(shape.problems.some((p) => p.rule === 'manifest-field' && /roles: text-body must be \{ "label"/.test(p.msg)));
  const name = bad((m) => { m.roles.Heading = { label: 'Heading' }; });
  assert.ok(name.problems.some((p) => /a role's name is a lowercase word/.test(p.msg)));
  const long = bad((m) => { m.roles['surface-background-elevated-secondary-hover'] = { label: 'x' }; });
  assert.ok(long.problems.some((p) => /a slide's style names at most 43/.test(p.msg)), 'a token the edit server would refuse is refused here');
  const token = bad((m) => { m.contract['--not-a-token'] = 'text-body'; });
  assert.ok(token.problems.some((p) => /contract: --not-a-token is not a colour token of the theme contract/.test(p.msg)));
  const role = bad((m) => { m.contract['--muted'] = 'text-muted'; });
  assert.ok(role.problems.some((p) => /contract: --muted names "text-muted", which "roles" does not declare/.test(p.msg)));
  assert.equal(role.problems.filter((p) => p.rule === 'theme-role-unknown').length, 0, 'a malformed roles key is said once, not again by every theme');
  const themeless = bad((m) => { delete m.themes; });
  assert.ok(themeless.problems.some((p) => /roles are set by the themes/.test(p.msg)));
});

test('every theme gives every role a swatch: a role left out, an off-palette value, an opacity a gate reads and an undeclared role are refused', (t) => {
  const missing = checkDir(variant(t, (m) => { delete m.themes[1].roles['surface-card']; }));
  assert.deepEqual(rules(missing), ['theme-role-missing']);
  assert.match(missing.problems[0].msg, /themes: acme-light: gives no swatch to the role surface-card/);

  const off = checkDir(variant(t, (m) => { m.themes[0].roles['text-body'] = '#ffffff'; }));
  assert.deepEqual(rules(off), ['theme-off-palette']);
  assert.match(off.problems[0].msg, /role text-body "#ffffff" names no swatch/);

  const gated = checkDir(variant(t, (m) => { m.themes[0].roles['text-accent'] = 'orange-500/50'; }));
  assert.deepEqual(rules(gated), ['theme-off-palette'], '--accent reads text-accent, and a gate reads --accent');
  const card = checkDir(variant(t, (m) => { m.themes[0].roles['surface-card'] = 'slate-800/60'; }));
  assert.deepEqual(rules(card), [], 'an opacity is fine on a role no gate reads');

  const unknown = checkDir(variant(t, (m) => { m.themes[0].roles['text-link'] = 'blue-500'; }));
  assert.deepEqual(rules(unknown), ['theme-role-unknown']);
  const undeclared = checkDir(variant(t, (m) => { delete m.roles; delete m.contract; }));
  assert.deepEqual([...new Set(rules(undeclared))], ['theme-role-unknown'], 'a theme setting roles the manifest never declared');
});

test('the stylesheet reads a role and never defines it (role-redefined)', (t) => {
  const r = checkDir(variant(t, () => {}, { css: `${cssOf()}\n.decklight { --acme-color-text-accent: #ff0000; }\n` }));
  assert.deepEqual(rules(r), ['role-redefined']);
  assert.equal(r.problems[0].file, 'design-system.css');
  assert.equal(r.problems[0].line, cssOf().split('\n').length + 1);
});

test('a package without roles is exactly what it was', () => {
  const brand = checkDir(path.join(here, 'fixtures', 'design-systems', 'brand'));
  assert.equal(brand.ok, true);
  assert.equal(brand.summary.brand.roles, undefined);
  assert.equal(brand.summary.brand.themes[0].roleRefs, undefined);
  assert.doesNotMatch(brand.summary.brand.themes[0].css, /--acme-color-/);
});

// ── each theme ───────────────────────────────────────────────────────────────

test('each theme sets every role token, and the contract is derived from the roles', () => {
  const m = manifest();
  const read = readScales(m.palette);
  const spec = { roles: m.roles, contract: m.contract };
  const dark = expandTheme(read, m.themes[0], '--acme-', spec);
  const light = expandTheme(read, m.themes[1], '--acme-', spec);
  assert.deepEqual(dark.problems, []);
  assert.deepEqual(light.problems, []);
  const orange = read.scales.orange.weights[500];
  const blue = read.scales.blue.weights[700];
  assert.match(dark.css, new RegExp(`--acme-color-text-accent: var\\(--acme-orange-500, ${orange}\\);`));
  assert.match(light.css, new RegExp(`--acme-color-text-accent: var\\(--acme-blue-700, ${blue}\\);`));
  for (const id of Object.keys(m.roles)) assert.match(light.css, new RegExp(`${roleToken('--acme-', id)}: var\\(--acme-`));
  // the contract follows the roles: --accent is the accent role's swatch, in each theme
  assert.equal(dark.refs['--accent'], 'orange-500');
  assert.equal(light.refs['--accent'], 'blue-700');
  assert.equal(dark.refs['--heading-color'], 'slate-100');
  assert.deepEqual(dark.viaRole, { '--heading-color': 'text-heading', '--fg': 'text-body', '--accent': 'text-accent', '--d-fill-1': 'surface-panel', '--d-fill-1-in': 'surface-panel-in' });
  assert.equal(light.refs['--d-fill-1-in'], 'blue-300', 'a diagram fill and its nested tone, through their roles');
  // the gates read the contract alone: no role token in what they read
  assert.doesNotMatch(dark.gateCss, /--acme-color-/);
  // an unmapped contract token is chosen from the palette as before
  assert.ok(dark.chosen.includes('--muted'));
});

test('a token the theme states itself wins over the contract, and a failed gate names the role it came through', () => {
  const m = manifest();
  const read = readScales(m.palette);
  const spec = { roles: m.roles, contract: m.contract };
  const own = expandTheme(read, { ...m.themes[0], tokens: { '--accent': 'amber-500' } }, '--acme-', spec);
  assert.equal(own.refs['--accent'], 'amber-500');
  assert.equal(own.viaRole['--accent'], undefined);
  const dim = expandTheme(read, { ...m.themes[0], roles: { ...m.themes[0].roles, 'text-body': 'slate-900' } }, '--acme-', spec);
  const gate = dim.problems.find((p) => p.rule === 'theme-contrast');
  assert.ok(gate, 'slate-900 body text on the dark page fails its gate');
  assert.match(gate.msg, /--fg slate-900 through the role text-body/);
});

// ── what the page gets ───────────────────────────────────────────────────────

test('every server and bundle emit the role values on each brand theme block, and tell the page the roles', () => {
  const verdict = packageVerdict(ROLES);
  assert.equal(verdict.ok, true);
  const tags = brandTags('acme', verdict).join('\n');
  const dark = /<style data-theme="acme-dark"[^>]*>([\s\S]*?)<\/style>/.exec(tags)[1];
  const light = /<style data-theme="acme-light"[^>]*>([\s\S]*?)<\/style>/.exec(tags)[1];
  assert.match(dark, /--acme-color-text-accent: var\(--acme-orange-500, #[0-9a-f]{6}\);/);
  assert.match(light, /--acme-color-text-accent: var\(--acme-blue-700, #[0-9a-f]{6}\);/);
  assert.equal((dark.match(/--acme-color-/g) ?? []).length, 6, 'every role, on every theme');

  const meta = designSystemMeta(verdict);
  assert.deepEqual(meta.roles.map((r) => r.id), ['text-heading', 'text-body', 'text-accent', 'surface-card', 'surface-panel', 'surface-panel-in']);
  assert.deepEqual(meta.contract, manifest().contract, 'the page is told which contract tokens read which role: a fill role is its diagram slot');
  assert.match(meta.themes[0].roles['text-accent'], /^#[0-9a-f]{6}$/);

  const block = bundleDesignSystem({ dir: ROLES, name: 'acme' }, verdict);
  assert.match(block.tags.join('\n'), /data-theme="acme-light"[\s\S]*--acme-color-surface-card: var\(--acme-slate-200,/);
});

test('the Colors tab on a deck held to the brand lists the roles alone, grouped, at the theme on screen', () => {
  const meta = designSystemMeta(packageVerdict(ROLES));
  const sys = { name: 'acme', title: 'Acme Brand', ...meta };
  const page = { '--acme-color-text-heading': ' #ffffff ' };   // what the page says now wins over the meta
  const groups = rolePalette([sys], (tk) => page[tk] ?? '', 'acme-light');
  assert.deepEqual(groups.map((g) => g.group), ['Acme Brand · Text', 'Acme Brand · Surface']);
  assert.deepEqual(groups[0].items.map((i) => i.label), ['Heading', 'Body', 'Accent']);
  assert.equal(groups[0].items[0].value, '#ffffff');
  assert.equal(groups[0].items[2].value, meta.themes[1].roles['text-accent'].toLowerCase());
  assert.ok(groups.every((g) => g.fallback), 'a pick writes var(--role, #hex)');
  assert.deepEqual(rolePalette([{ name: 'plain', palette: [] }], () => '', 'x'), [], 'no roles: the card is as it was');
});

// ── what is held to them ─────────────────────────────────────────────────────

test('offRoleColours names literals, contract tokens and swatches, never a role or its fallback, and nearestRole names the closest', () => {
  const m = manifest();
  const read = readScales(m.palette);
  const ctx = { prefix: '--acme-', scales: read.scales, roles: m.roles };
  assert.deepEqual(offRoleColours('var(--acme-color-text-accent, #5ec6ff)', ctx), []);
  assert.deepEqual(offRoleColours('1px solid var(--acme-color-surface-card)', ctx), []);
  const off = offRoleColours('linear-gradient(var(--accent), var(--acme-blue-600, #123456)) #abcdef, rgb(1, 2, 3)', ctx);
  assert.deepEqual(off.map((o) => [o.kind, o.name]), [['contract', '--accent'], ['swatch', '--acme-blue-600'], ['literal', '#abcdef'], ['literal', 'rgb(1, 2, 3)']]);
  assert.deepEqual(offRoleColours('var(--acme-divider-pad)', ctx), [], "a component's own token is its business");
  assert.equal(nearestRole({ a: '#000000', b: '#ffffff' }, '#f0f0f0'), 'b');
});

test('design-system gate warns about a component colour that is not a role, naming the file, the line and the nearest role', (t) => {
  const css = `${cssOf()}.decklight .acme-title { color: var(--heading-color); }\n.decklight .acme-tile { border: 1px solid var(--acme-blue-600); background: #101820; }\n`;
  const templates = `${readFileSync(path.join(ROLES, 'templates.html'), 'utf8')}<template data-template="tile" data-title="Tile">\n  <div class="acme-tile" style="color: #ff6600"><div data-slot="body" data-slot-default></div></div>\n</template>\n`;
  const r = checkDir(variant(t, () => {}, { css, templates }));
  assert.deepEqual(r.problems, []);
  const w = r.warnings.filter((x) => x.rule === 'component-off-role');
  const lines = cssOf().split('\n').length;
  assert.deepEqual(w.map((x) => [x.file, x.line]), [['design-system.css', lines], ['design-system.css', lines + 1], ['design-system.css', lines + 1], ['templates.html', 18]],
    'one warning per declaration, the border and the background each');
  assert.match(w[0].msg, /--heading-color \(a theme-contract token\) \(nearest role text-heading\)/, 'a mapped contract token names the role it reads');
  assert.match(w[1].msg, /--acme-blue-600 \(a swatch\) \(nearest role [a-z-]+\)/);
  assert.match(w[2].msg, /#101820 \(nearest role [a-z-]+\)/);
  assert.match(w[3].msg, /#ff6600 \(nearest role text-accent\)/);
});

test('decklight check warns off-role once per slide on a deck held to the brand, and stands down when it is not', () => {
  const systems = () => new Map([['acme', checkEntry('acme@acme-mkt', packageVerdict(ROLES))]]);
  const deck = (cfg) => `<!doctype html><html><head><script type="application/json" data-decklight-config>${JSON.stringify({ decklight: '0.9.0', designSystems: ['acme@acme-mkt'], theme: 'acme-dark', ...cfg })}</script></head><body><div class="decklight">
    <section><h2>On</h2><p>A <b style="color: var(--acme-color-text-accent, #f5a623)">role</b>, <span style="background: var(--acme-color-surface-card)">a card</span></p></section>
    <section><h2>Off</h2><p style="color: var(--accent)">one</p><svg viewBox="0 0 10 10"><rect fill="#3a7d44" stroke="var(--acme-slate-500)" width="5" height="5"/></svg></section>
  </div></body></html>`;
  const found = staticFindings(deck({}), { designSystems: systems }).filter((f) => f.rule === 'off-role');
  assert.deepEqual(found.map((f) => [f.slide, f.level]), [[2, 'warn']], 'roles pass; the slide with three off-role colours is said once');
  assert.match(found[0].message, /--accent \(the theme contract\) \(nearest role text-accent\)/);
  assert.match(found[0].message, /#3a7d44 \(nearest role [a-z-]+\)/);
  assert.match(found[0].message, /--acme-slate-500 \(a swatch\)/);
  assert.equal(staticFindings(deck({}), { designSystems: systems }).filter((f) => f.rule === 'off-palette-literal').length, 0, 'off-role says it; the palette warning does not repeat it');
  assert.equal(staticFindings(deck({ brandThemesOnly: false }), { designSystems: systems }).filter((f) => f.rule === 'off-role').length, 0, 'unlocked: the deck may wear anything');
});
