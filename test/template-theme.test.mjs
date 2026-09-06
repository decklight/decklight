// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/template-theme.mjs — a PowerPoint template's colour and font schemes
// as a decklight theme, derived and then pushed through the same gates
// `decklight theme check` runs. The gates are the point: a template has
// twelve colours and a theme needs fifty-six that read against each other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTemplateTheme, themeFromTemplate } from '../tools/template-theme.mjs';
import { validateTheme } from '../tools/theme-check.mjs';
import { unzip } from '../tools/zip.mjs';
import { zipSync } from '../cli/zip.mjs';
import { cli } from './helpers.mjs';

const scheme = (accents, { dk1 = "1F2937", lt1 = "FFFFFF", heading = 'Georgia', body = 'Calibri', name = 'Corporate' } = {}) =>
  `<a:theme xmlns:a="a" name="${name}"><a:themeElements><a:clrScheme name="${name}">`
  + `<a:dk1><a:sysClr val="windowText" lastClr="${dk1}"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="${lt1}"/></a:lt1>`
  + `<a:dk2><a:srgbClr val="0B3D91"/></a:dk2><a:lt2><a:srgbClr val="EEF2F7"/></a:lt2>`
  + accents.map((a, i) => `<a:accent${i + 1}><a:srgbClr val="${a}"/></a:accent${i + 1}>`).join('')
  + `<a:hlink><a:srgbClr val="0B57D0"/></a:hlink><a:folHlink><a:srgbClr val="7B1FA2"/></a:folHlink></a:clrScheme>`
  + `<a:fontScheme name="${name}"><a:majorFont><a:latin typeface="${heading}"/></a:majorFont><a:minorFont><a:latin typeface="${body}"/></a:minorFont></a:fontScheme>`
  + `</a:themeElements></a:theme>`;
const CORP = ['0B57D0', 'E8710A', '1E8E3E', 'D93025', '7B1FA2', '00838F'];

test('the scheme is read: sysClr through its lastClr, srgbClr as is, both fonts', () => {
  const t = parseTemplateTheme(scheme(CORP));
  assert.equal(t.name, 'Corporate');
  assert.equal(t.colors.dk1, '#1f2937', 'a system colour resolves through lastClr');
  assert.equal(t.colors.accent2, '#e8710a');
  assert.equal(t.colors.hlink, '#0b57d0');
  assert.deepEqual(t.fonts, { heading: 'Georgia', body: 'Calibri' });
  assert.equal(parseTemplateTheme('<a:theme/>'), null, 'no colour scheme is not a theme');
  assert.equal(parseTemplateTheme(''), null);
});

test('every derived theme clears every gate theme check runs — four palettes that would each break a naive copy', () => {
  for (const [label, accents, opts] of [
    ['corporate blue', CORP, {}],
    ['pastel accents', ['FFD1DC', 'C1E1C1', 'FFF5BA', 'C6DEF1', 'E2C2FF', 'FDE2C7'], {}],
    ['dark template', ['4FC3F7', 'FFB74D', '81C784', 'E57373', 'BA68C8', '4DD0E1'], { dk1: 'F5F5F5', lt1: '121212' }],
    ['all-black accents', ['000000', '000000', '000000', '000000', '000000', '000000'], {}],
  ]) {
    const t = themeFromTemplate(parseTemplateTheme(scheme(accents, opts)));
    assert.equal(t.ok, true, `${label}: ${t.errors.slice(0, 3).join(' · ')}`);
    assert.equal(validateTheme(t.css).ok, true, `${label}: the CSS itself re-validates`);
  }
});

test('the template\'s faces lead the font stacks, and the theme is named after the template', () => {
  const t = themeFromTemplate(parseTemplateTheme(scheme(CORP, { heading: 'Georgia', body: 'Calibri', name: 'ACME 2026 Brand' })));
  assert.match(t.css, /--font-heading: "Georgia", -apple-system/);
  assert.match(t.css, /--font-body: "Calibri", -apple-system/);
  assert.match(t.css, /--font-mono: "SF Mono"/, 'code stays monospace whatever the template says');
  assert.equal(t.name, 'template-acme-2026-brand');
  assert.match(t.css, /^\/\* Decklight theme · template-acme-2026-brand/);
});

test('the page keeps the template\'s page colour, and a fill is a pale panel of its accent, not the accent', () => {
  const t = themeFromTemplate(parseTemplateTheme(scheme(CORP)));
  assert.match(t.css, /--bg: #ffffff;/);
  assert.match(t.css, /--accent: #0b57d0;/, 'accent1 is the accent, untouched');
  const fill = /--d-fill-1: (#[0-9a-f]{6});/.exec(t.css)[1];
  assert.notEqual(fill, '#0b57d0', 'the fill is a tint');
  assert.ok(parseInt(fill.slice(1, 3), 16) > 0x80, 'a pale tint, close to the canvas');
});

test('decklight import --theme template opens the deck in the derived theme, and says so', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'decklight-tpl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // the fixture, plus the theme part real PowerPoint files always carry
  const fixture = unzip(readFileSync(new URL('./fixtures/sample.pptx', import.meta.url)));
  const entries = [...fixture.entries()].map(([name, data]) => ({ name, data }));
  entries.push({ name: 'ppt/theme/theme1.xml', data: Buffer.from(scheme(CORP, { name: 'Corporate' })) });
  const src = join(dir, 'brand.pptx');
  writeFileSync(src, zipSync(entries));
  const out = join(dir, 'brand.html');
  const r = cli(['import', src, '--theme', 'template', '-o', out]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stderr, /theme: template-corporate — derived from the template's palette and fonts \(Georgia \/ Calibri\)/);
  const html = readFileSync(out, 'utf8');
  assert.match(html, /<style data-theme="template-corporate">/);
  assert.match(html, /--font-heading: "Georgia"/);
  // without the flag, the hint — and the default theme
  const r2 = cli(['import', src, '-o', join(dir, 'plain.html'), '--force']);
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.stderr, /--theme template/);
  assert.match(readFileSync(join(dir, 'plain.html'), 'utf8'), /<style data-theme="midnight">/);
});
