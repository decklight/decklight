// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The theme contract, as a function.
//
// A Decklight theme is one CSS file declaring the SPEC §5 tokens, and whether
// a given file IS one has always been decidable — test/contrast.mjs has
// decided it for the 65 shipped themes since the beginning. What it could not
// do is answer the question for anybody else's file: `test/` does not ship in
// the npm package, so a theme author outside this repo had no way to run the
// gates their theme would be judged by.
//
// So the rules live here, under tools/, which ships. test/contrast.mjs is now
// a loop over this, and `decklight theme check` is the same loop over one file.
//
// There is no version number in a theme, deliberately. Compatibility with a
// runtime IS passing that runtime's check — and when the contract grows a
// token, the report names exactly what an older theme is missing.

import { colorsIn, contrast, parseTheme } from './color.mjs';

/**
 * Every token a theme must declare (SPEC §5). Presence is checked separately
 * from contrast, because a missing token and an unreadable one are different
 * problems with different fixes.
 */
export const REQUIRED = [
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

const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/**
 * Every contrast gate, as data: [foreground, background, minimum].
 *
 * `✦` gates in the original comment are presentation-quality rather than WCAG
 * proper; they are not distinguished here because a theme has to pass all of
 * them either way. Diagram ink is checked against every PANEL and not only the
 * canvas — the gameboy lesson: every canvas gate passed while the boxes were
 * unreadable.
 */
export const GATES = [
  ['fg', 'bg', 4.5],
  ['muted', 'bg', 3.0],
  ['heading-color', 'bg', 3.0],
  ['link', 'bg', 3.0],
  ['d-text', 'bg', 3.0],
  ...[1, 2, 3, 4, 5, 6].flatMap((i) => [
    ['d-text', `d-fill-${i}`, 3.0],
    ['d-muted', `d-fill-${i}`, 2.6],
    ['d-accent', `d-fill-${i}`, 2.6],
  ]),
  ['accent-contrast', 'accent', 4.5],
  ['code-fg', 'code-bg', 4.5],
  ...['keyword', 'string', 'number', 'function', 'type', 'punct'].map((h) => [`hl-${h}`, 'code-bg', 4.5]),
  ['hl-comment', 'code-bg', 3.0],
  ['term-fg', 'term-bg', 3.0],
  ['term-prompt', 'term-bg', 3.0],
  ...ANSI.flatMap((a) => [[`ansi-${a}`, 'term-bg', 3.0], [`ansi-bright-${a}`, 'term-bg', 3.0]]),
];

/**
 * A foreground's contrast against a background that may be a GRADIENT: every
 * stop has to clear the bar, because the text sits over all of them.
 */
export function minContrast(fgValue, bgValue) {
  const fg = colorsIn(fgValue)[0];
  const stops = colorsIn(bgValue);
  if (!fg || stops.length === 0) return null;
  return Math.min(...stops.map((s) => contrast(fg, s)));
}

/**
 * Judge one theme file.
 *
 * Returns `{ ok, tokens, missing, failures, errors }` — `missing` lists absent
 * token names, `failures` the gates that did not clear (each with its measured
 * ratio), and `errors` the human-readable lines. A file with no tokens at all
 * is reported as such rather than as 56 separate missing tokens: it is almost
 * certainly not a theme, and 56 lines would bury that.
 */
export function validateTheme(css) {
  const { tokens, exceptions } = parseTheme(css ?? '');
  const declared = Object.keys(tokens).length;
  const missing = REQUIRED.filter((t) => !(t in tokens));
  const failures = [];
  const errors = [];

  if (declared === 0) {
    return {
      ok: false, tokens, exceptions, missing, failures,
      errors: ['no CSS custom properties found — is this a Decklight theme? '
        + '(a theme declares its tokens on .decklight, see SPEC §5)'],
      empty: true,
    };
  }

  for (const t of missing) errors.push(`missing token --${t}`);

  for (const [fg, bg, min] of GATES) {
    if (!(fg in tokens) || !(bg in tokens)) continue;  // already reported as missing
    const ratio = minContrast(tokens[fg], tokens[bg]);
    if (ratio === null) {
      failures.push({ fg, bg, min, ratio: null });
      errors.push(`--${fg} on --${bg}: unparseable color`);
      continue;
    }
    if (ratio < min) {
      failures.push({ fg, bg, min, ratio });
      errors.push(`--${fg} (${tokens[fg].slice(0, 28)}) on --${bg}: ${ratio.toFixed(2)} < ${min}`);
    }
  }

  return { ok: errors.length === 0, tokens, exceptions, missing, failures, errors, empty: false };
}

/** A theme name from a path or URL: the basename, minus .css. */
export function themeNameFrom(source) {
  const last = String(source ?? '').split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '';
  return last.replace(/\.css$/i, '');
}

/**
 * Whether a name is usable as a theme name.
 *
 * The runtime's applyTheme silently ignores anything outside `[\w-]+`, so a
 * name it would refuse has to be refused HERE, loudly, or the theme installs
 * and then does nothing when picked.
 */
export const validThemeName = (name) => /^[\w-]+$/.test(String(name ?? ''));
