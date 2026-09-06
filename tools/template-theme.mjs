// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A PowerPoint template's palette and fonts, as a decklight theme.
 *
 * `decklight import` throws the template's LOOK away on purpose — the deck you
 * get is a decklight deck, not a screenshot of the old one — and every
 * imported corporate deck arrived in `midnight`, to be re-themed by hand. The
 * part of the look that is a THEME rather than a layout was in the file all
 * along: ppt/theme/theme1.xml carries the colour scheme (dk1, lt1, dk2, lt2,
 * accent1–6, hlink) and the font scheme (a heading face and a body face). That
 * is most of what a brand team means by "our template".
 *
 * So this reads those two schemes and derives the full SPEC THEMING token set
 * from them. Derives, not copies: a template has twelve colours and a theme
 * needs fifty-six tokens with contrast gates between them, so the rest is
 * chosen from the twelve and then PUSHED until every gate in
 * tools/theme-check.mjs clears — a link colour that reads on the slide
 * background, six diagram fills a label can be read on, a code palette that
 * is legible on the block. The result is validated by the same function
 * `decklight theme check` runs, and if it cannot be made to pass, that is
 * reported rather than shipped.
 */

import { parseXml, find, findAll } from './ooxml.mjs';
import { parseColor, contrast } from './color.mjs';
import { validateTheme, GATES } from './theme-check.mjs';

const SLOTS = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

/** Windows system colours a theme may name instead of a hex value. */
const SYSTEM = { windowText: '000000', window: 'FFFFFF' };

const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const rgb = (h) => parseColor(h);
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));

/**
 * The scheme, or null when the part is not a theme. Each colour slot resolves
 * `a:srgbClr` or `a:sysClr` (with its lastClr, else the system default).
 */
export function parseTemplateTheme(xml) {
  const doc = parseXml(xml ?? '');
  const scheme = find(doc, 'a:clrScheme');
  if (!scheme) return null;
  const colors = {};
  for (const slot of SLOTS) {
    const node = find(scheme, `a:${slot}`);
    if (!node) continue;
    const srgb = find(node, 'a:srgbClr')?.attrs.val;
    const sys = find(node, 'a:sysClr');
    const val = srgb ?? sys?.attrs.lastClr ?? (sys && SYSTEM[sys.attrs.val]);
    if (val && /^[0-9a-f]{6}$/i.test(val)) colors[slot] = '#' + val.toLowerCase();
  }
  const fonts = find(doc, 'a:fontScheme');
  const face = (which) => find(find(fonts, which) ?? { children: [] }, 'a:latin')?.attrs.typeface ?? null;
  return {
    name: scheme.attrs.name ?? find(doc, 'a:theme')?.attrs.name ?? 'template',
    colors,
    fonts: { heading: fonts ? face('a:majorFont') : null, body: fonts ? face('a:minorFont') : null },
  };
}

/** Nudge `fg` toward black or white — whichever moves it away from `bg` — until the gate clears. */
function pushUntil(fg, bg, min) {
  const dark = contrast(rgb(bg), [0, 0, 0]) > contrast(rgb(bg), [255, 255, 255]);
  const target = dark ? '#000000' : '#ffffff';
  let out = fg;
  for (let t = 0; t <= 1.0001 && contrast(rgb(out), rgb(bg)) < min; t += 0.05) out = mix(fg, target, t);
  return out;
}

/** A font stack around the template's face, with the same fallbacks the shipped themes use. */
const stack = (face, mono = false) => (mono
  ? '"SF Mono", SFMono-Regular, ui-monospace, "Cascadia Code", Menlo, Consolas, monospace'
  : `${face ? `"${face.replace(/"/g, '')}", ` : ''}-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`);

/**
 * The full token set, derived from a scheme and pushed through the gates.
 *
 * Light by construction: PowerPoint templates are lt1-on-dk1 far more often
 * than not, and a slide background that is the template's page colour is what
 * "looks like our template" means. Returns { css, name, ok, errors }; `ok` is
 * theme-check's verdict on the CSS this produced.
 */
export function themeFromTemplate(parsed, { name } = {}) {
  const c = parsed.colors;
  const bg = c.lt1 ?? '#ffffff';
  const fg = c.dk1 ?? '#1a1a1a';
  const accents = [1, 2, 3, 4, 5, 6].map((i) => c[`accent${i}`] ?? mix(fg, bg, 0.3 + i * 0.08));
  const tok = {};
  tok.bg = bg;
  tok['bg-accent'] = mix(bg, c.lt2 ?? accents[0], 0.35);
  tok.fg = pushUntil(fg, bg, 4.5);
  tok.muted = pushUntil(mix(c.dk2 ?? fg, bg, 0.35), bg, 3.0);
  tok['font-body'] = stack(parsed.fonts.body);
  tok['font-heading'] = stack(parsed.fonts.heading ?? parsed.fonts.body);
  tok['font-mono'] = stack(null, true);
  tok['heading-color'] = pushUntil(c.dk2 ?? accents[0], bg, 3.0);
  tok['heading-weight'] = '700';
  tok.link = pushUntil(c.hlink ?? accents[0], bg, 3.0);
  tok.accent = accents[0];
  tok['accent-contrast'] = contrast(rgb(accents[0]), rgb(bg)) >= contrast(rgb(accents[0]), rgb(fg)) ? bg : fg;
  tok['accent-contrast'] = pushUntil(tok['accent-contrast'], accents[0], 4.5);
  tok['block-bg'] = mix(bg, c.lt2 ?? fg, 0.08);
  tok['block-border'] = `1px solid ${mix(bg, fg, 0.18)}`;
  tok['block-radius'] = '10px';
  tok.shadow = '0 10px 32px rgba(0, 0, 0, 0.12)';
  // code: the template's secondary light on the page, ink on it
  tok['code-bg'] = mix(bg, c.lt2 ?? fg, 0.12);
  tok['code-fg'] = pushUntil(fg, tok['code-bg'], 4.5);
  const hl = ['keyword', 'string', 'number', 'function', 'type', 'punct'];
  hl.forEach((h, i) => { tok[`hl-${h}`] = pushUntil(accents[i % 6], tok['code-bg'], 4.5); });
  tok['hl-comment'] = pushUntil(tok.muted, tok['code-bg'], 3.0);
  // diagrams. SPEC CHARTS: the --d-fill panels sit deliberately CLOSE TO THE
  // CANVAS, gated for text on them — so a fill is a pale tint of its accent,
  // not the accent, and the ink on it is the page's ink. Each tint is then
  // pushed toward the page until that ink clears the gate on it.
  const towardBg = (fill, ink, min) => {
    let out = fill;
    for (let t = 0; t <= 1.0001 && contrast(rgb(ink), rgb(out)) < min; t += 0.05) out = mix(fill, bg, t);
    return out;
  };
  tok['d-text'] = tok.fg;
  accents.forEach((a, i) => { tok[`d-fill-${i + 1}`] = towardBg(mix(a, bg, 0.72), tok.fg, 3.0); });
  const fills = [1, 2, 3, 4, 5, 6].map((i) => tok[`d-fill-${i}`]);
  // one muted and one accent ink that read on EVERY fill: push against the hardest one
  const onAllFills = (ink, min) => fills.reduce((out, f) => pushUntil(out, f, min), ink);
  tok['d-muted'] = onAllFills(mix(tok.fg, bg, 0.4), 2.6);
  tok['d-accent'] = onAllFills(accents[0], 2.6);
  tok['d-stroke'] = pushUntil(c.dk2 ?? fg, bg, 3.0);
  // terminal: the template's dark on itself — a terminal on a light theme is still dark
  tok['term-bg'] = c.dk2 ?? mix(fg, '#000000', 0.2);
  tok['term-fg'] = pushUntil(bg, tok['term-bg'], 3.0);
  tok['term-prompt'] = pushUntil(accents[0], tok['term-bg'], 3.0);
  tok['term-cursor'] = tok['term-fg'];
  tok['term-selection'] = mix(tok['term-bg'], tok['term-fg'], 0.3);
  const ansi = { black: mix(tok['term-bg'], tok['term-fg'], 0.45), red: accents[0], green: accents[1], yellow: accents[2], blue: accents[3], magenta: accents[4], cyan: accents[5], white: tok['term-fg'] };
  for (const [k, v] of Object.entries(ansi)) {
    tok[`ansi-${k}`] = pushUntil(v, tok['term-bg'], 3.0);
    tok[`ansi-bright-${k}`] = pushUntil(mix(v, tok['term-fg'], 0.35), tok['term-bg'], 3.0);
  }
  // one last pass over EVERY gate, in case a derived token moved another's background
  for (const [f, b, min] of GATES) {
    if (f.startsWith('d-')) continue;   // settled above, against every fill at once
    if (tok[f] && tok[b] && /^#/.test(tok[f]) && /^#/.test(tok[b]) && contrast(rgb(tok[f]), rgb(tok[b])) < min) tok[f] = pushUntil(tok[f], tok[b], min);
  }
  const themeName = name ?? `template-${String(parsed.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'template'}`;
  const lines = Object.entries(tok).map(([k, v]) => `  --${k}: ${v};`);
  const css = `/* Decklight theme · ${themeName}\n   light · derived from the PowerPoint template's colour and font schemes\n   Token contract: SPEC.md THEMING */\n.decklight {\n${lines.join('\n')}\n}\n`;
  const check = validateTheme(css);
  return { css, name: themeName, ok: check.ok, errors: check.errors ?? [] };
}
