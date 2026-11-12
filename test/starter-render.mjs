#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `decklight init --starter full` writes the deck an author copies from, so
 * every slide of it has to be one worth copying, in a browser and not only in
 * the file: nothing clipped (PRESENTING_FIT), nothing crowded (SLIDE_DENSITY),
 * no [click] beat out of step with the builds the runtime counted, no split
 * fighting its own layout (COMPARISON_SLIDES), and every word on it readable.
 *
 * The unit test (test/init-starter.test.mjs) runs `decklight check` on it,
 * and that is the authoring loop's own check; this is the one that walks the
 * deck in every shipped theme. The self-contained scaffold carries all of them
 * inline, so one page applies each in turn, lands on every slide fully built
 * and measures: the runtime's own marks, and the contrast of every piece of
 * text against what is actually painted behind it (the canvas, a panel, a
 * diagram box or a chart bar). The floor is 3:1, the lowest a theme's own
 * gates allow text on its canvas or a diagram fill (test/contrast.mjs), so a
 * failure is the slide's doing, never a theme's. The linked scaffold, the
 * default shape, is rendered once on its default theme, the way `decklight`
 * serves it (`linkRuntime`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';
import { linkRuntime } from '../cli/runtime-link.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '..');
const CLI = path.join(pkg, 'cli/decklight.mjs');

const dir = mkdtempSync(path.join(tmpdir(), 'decklight-starter-render-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

function scaffold(name, ...flags) {
  execFileSync(process.execPath, [CLI, 'init', 'Starter', '--dir', path.join(dir, name), '--starter', 'full',
    '--no-git', '--no-skill', '--no-open', '--no-design-system', ...flags],
  { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, DECKLIGHT_HOME: path.join(dir, 'home') } });
  return path.join(dir, name, 'deck.html');
}

// What the page does: every theme the deck carries (or the one it opens on),
// every slide fully built, the runtime's marks and the contrast of each word.
const PROBE = `<pre id="test-sink">running…</pre>
<script>
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message)));
let skipped = 0;
// a table's header cells are --accent on the canvas, the runtime's choice
// (decklight.css), and no theme gate pairs those two: reported, not failed
const runtime = [];
const SETTLE = Number(new URLSearchParams(location.search).get('settle') || 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cv = document.createElement('canvas'); cv.width = cv.height = 1;
const cx = cv.getContext('2d', { willReadFrequently: true });
// any CSS colour (oklch, color-mix, a keyword) as sRGB 0-255 + alpha, by painting it
function rgba(c) {
  cx.clearRect(0, 0, 1, 1); cx.fillStyle = 'rgba(0,0,0,0)'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
  const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255];
}
const over = (top, base) => [0, 1, 2].map((k) => top[k] * top[3] + base[k] * (1 - top[3]));
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const COLOR_FN = /(rgba?\\([^)]*\\)|oklch\\([^)]*\\)|oklab\\([^)]*\\)|lab\\([^)]*\\)|lch\\([^)]*\\)|color\\([^)]*\\)|#[0-9a-f]{3,8}\\b)/gi;
// every colour that can sit behind el: a gradient counts each of its stops
function backdrops(el) {
  const layers = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const cs = getComputedStyle(n);
    const img = cs.backgroundImage;
    const stops = img && img !== 'none' && !/url\\(/.test(img) ? (img.match(COLOR_FN) || []).map(rgba).filter((c) => c[3] > 0) : [];
    layers.push({ col: rgba(cs.backgroundColor), stops });
    if (stops.length || rgba(cs.backgroundColor)[3] >= 0.99) break;
  }
  const last = layers[layers.length - 1];
  let bases = last.stops.length ? last.stops.map((s) => over(s, last.col[3] >= 0.99 ? last.col : [255, 255, 255, 1]))
    : last.col[3] >= 0.99 ? [last.col.slice(0, 3)] : [[255, 255, 255]];
  for (let i = layers.length - 2; i >= 0; i--) if (layers[i].col[3] > 0) bases = bases.map((b) => over(layers[i].col, [...b, 1]));
  return bases;
}
// a build still on its way in, or a code line stepped past; the slide's own
// entrance (the section fading in) is not the words' contrast, so it stops there
const dimmed = (el) => { for (let n = el; n && n.tagName !== 'SECTION'; n = n.parentElement) if (Number(getComputedStyle(n).opacity) < 0.99) return true; return false; };
const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
const FILLED = 'rect, circle, ellipse, path, polygon';
// the filled shape an SVG label sits on: the last one painted under its centre
function under(text) {
  const svg = text.ownerSVGElement; const t = text.getBoundingClientRect();
  const cxp = t.left + t.width / 2, cyp = t.top + t.height / 2;
  let hit = null;
  for (const s of svg.querySelectorAll(FILLED)) {
    if (s.closest('defs, marker') || (s.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
    const cs = getComputedStyle(s);
    if (cs.fill === 'none' || Number(cs.fillOpacity) === 0 || !shown(s)) continue;
    const r = s.getBoundingClientRect();
    if (cxp >= r.left && cxp <= r.right && cyp >= r.top && cyp <= r.bottom) hit = s;
  }
  return hit;
}
function contrastProblems(section, theme, slide) {
  const out = [];
  const seen = new Set();
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || seen.has(el) || el.closest('aside, script, style, .draw-head, .draw-mask')) continue;
    seen.add(el);
    if (!shown(el)) continue;
    if (dimmed(el)) { skipped++; continue; }
    const svgText = el.closest('text');
    const ink = rgba(svgText ? getComputedStyle(svgText).fill : getComputedStyle(el).color);
    let bases;
    if (svgText) {
      const shape = under(svgText);
      const behind = backdrops(svgText.ownerSVGElement);
      bases = shape ? behind.map((b) => over(rgba(getComputedStyle(shape).fill), [...b, 1])) : behind;
    } else bases = backdrops(el);
    for (const b of bases) {
      const r = ratio(over(ink, [...b, 1]), b);
      if (r < 3) { (el.closest('th') ? runtime : out).push(theme + ' slide ' + slide + ': "' + n.textContent.trim().slice(0, 40) + '" at ' + r.toFixed(2) + ':1'); break; }
    }
  }
  return out;
}
setTimeout(async () => {
  const root = document.querySelector('.decklight');
  const api = root && root.__decklight;
  const sections = [...document.querySelectorAll('.decklight-stage > section')];
  const inline = [...document.querySelectorAll('style[data-theme]')].map((s) => s.dataset.theme);
  const themes = inline.length ? inline : [null];
  const marks = [], contrast = [];
  for (const theme of themes) {
    if (theme) { api.theme(theme); await sleep(300); }
    for (let i = 1; i <= sections.length; i++) {
      api.goto(i, 999);
      await sleep(SETTLE);
      const s = sections[i - 1];
      for (const a of ['data-overflow', 'data-dense', 'data-click-mismatch', 'data-split-conflict']) {
        if (s.hasAttribute(a)) marks.push((theme || 'default') + ' slide ' + i + ': ' + a + '=' + s.getAttribute(a));
      }
      contrast.push(...contrastProblems(s, theme || 'default', i));
    }
  }
  const img = document.querySelector('section img');
  document.getElementById('test-sink').textContent = 'DECKLIGHT-STARTER-RESULTS ' + JSON.stringify({
    errors,
    themes: themes.length,
    slides: sections.length,
    notes: sections.filter((s) => s.querySelector('aside.notes')).length,
    chapters: sections.filter((s) => s.hasAttribute('data-module')).length,
    builds: sections.filter((s) => s.querySelector('[data-build], pre[data-lines]')).length,
    chart: !!document.querySelector('.chart svg') && !document.querySelector('.chart-broken'),
    math: !!document.querySelector('section[data-math] math'),
    code: !!document.querySelector('pre code.hljs'),
    picture: !!(img && img.complete && img.naturalWidth > 0),
    // a connector routed by the runtime ends at its box's edge, not where the file put it
    routed: (document.querySelector('path[data-from="server"]')?.getAttribute('d') ?? 'M 400 104 V 190 H 576') !== 'M 400 104 V 190 H 576',
    marks,
    contrast,
    skipped,
    runtime,
  }) + '\\n';
}, 1500);
</script>
`;

// Virtual time: the walk is ~150 ms a slide and ~300 ms a theme, so the inline
// deck's 46 themes need ~105 s of it (a budget far past that makes Chrome's
// teardown watchdog kill the dump before it is read)
function render(file, ctx, budget) {
  const source = linkRuntime(readFileSync(file, 'utf8'));
  const at = source.lastIndexOf('</body>');
  writeFileSync(file, source.slice(0, at) + PROBE + source.slice(at));
  const html = dumpDom(`file://${file}`, { fileAccess: true, budget, maxBuffer: 64 * 1024 * 1024, who: 'starter-render' });
  return resultsFrom(html, 'STARTER', ctx);
}

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` (expected ${JSON.stringify(expected)})`}`);
}

// the linked deck, served the way `decklight` serves it: the runtime referenced in
const linked = scaffold('linked');
for (const [from, to] of [['dist/decklight.js', 'decklight.js'], ['dist/decklight.css', 'decklight.css'], ['themes/aurora.css', 'themes/aurora.css']]) {
  fs.mkdirSync(path.dirname(path.join(dir, 'linked', to)), { recursive: true });
  fs.copyFileSync(path.join(pkg, from), path.join(dir, 'linked', to));
}
const inline = scaffold('inline', '--inline');

// `decklight check`, render half and all, on the self-contained deck before the
// probe goes in: what an author runs, nothing found, not even a hint
{
  const c = spawnSync(process.execPath, [CLI, 'check', inline, '--json'], { encoding: 'utf8' });
  check('inline: decklight check (rendered) exits 0', c.status, 0);
  check('inline: decklight check (rendered) finds nothing', c.status === 0 ? JSON.parse(c.stdout) : c.stdout + c.stderr, []);
}
const themeCount = fs.readdirSync(path.join(pkg, 'themes')).filter((f) => f.endsWith('.css')).length;

for (const [label, file, themes, budget] of [['linked', linked, 1, 30_000], ['inline', inline, themeCount, 150_000]]) {
  const r = render(file, label, budget);
  check(`${label}: no runtime errors`, r.errors, []);
  check(`${label}: themes walked`, r.themes, themes);
  check(`${label}: every slide has notes`, r.notes, r.slides);
  check(`${label}: three chapters`, r.chapters, 3);
  check(`${label}: the chart, the math, the code and the picture render`, [r.chart, r.math, r.code, r.picture], [true, true, true, true]);
  check(`${label}: the elbow connector is routed by the runtime`, r.routed, true);
  check(`${label}: nothing clipped, crowded, out of step or fighting its split`, r.marks, []);
  check(`${label}: every word at 3:1 or better against what is behind it`, r.contrast, []);
  console.log(`     ${label}: ${r.skipped} text element(s) mid-entrance or dimmed, not measured`);
  for (const line of r.runtime) console.log(`     ${label}: table header under 3:1, the theme's --accent on its canvas (ungated): ${line}`);
}

if (failures) { console.error(`starter-render: ${failures} FAILED`); process.exit(1); }
console.log('starter-render: PASS');
