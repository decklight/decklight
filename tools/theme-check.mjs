// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The theme contract, as a function.
//
// A Decklight theme is one CSS file declaring the SPEC THEMING tokens, and whether
// a given file IS one has always been decidable — test/contrast.mjs has
// decided it for the 65 shipped themes since the beginning. What it could not
// do is answer the question for anybody else's file: `test/` does not ship in
// the npm package, so a theme author outside this repo had no way to run the
// gates their theme would be judged by.
//
// So the rules live here, under tools/, which ships. test/contrast.mjs is now
// a loop over this, and `decklight theme gate` is the same loop over one file.
//
// There is no version number in a theme, deliberately. Compatibility with a
// runtime IS passing that runtime's check — and when the contract grows a
// token, the report names exactly what an older theme is missing.

import { colorsIn, contrast, parseTheme, nestedTone, toOklab } from './color.mjs';

/**
 * Every token a theme must declare (SPEC THEMING). Presence is checked separately
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
        + '(a theme declares its tokens on .decklight, see SPEC THEMING)'],
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

  // Fill on fill (SVG_DIAGRAMS, #541): a box nested in a panel is painted the
  // panel's nested tone — `--d-fill-N-in`, the theme's own or the runtime's
  // default mix toward the ink — and it has to be a step the eye reads AND
  // still carry the ink. A theme can pass every ink gate while its nested
  // boxes vanish into their panels; this is the gate for that.
  const ink = colorsIn(tokens['d-text'] ?? '')[0];
  for (let i = 1; i <= 6; i++) {
    const fill = colorsIn(tokens[`d-fill-${i}`] ?? '')[0];
    if (!ink || !fill) continue;   // missing or unparseable: already reported above
    const own = tokens[`d-fill-${i}-in`];
    const tone = own ? colorsIn(own)[0] : nestedTone(fill, ink);
    if (!tone) { failures.push({ fg: `d-fill-${i}-in`, bg: `d-fill-${i}`, min: NESTED_MIN_DL, ratio: null }); errors.push(`--d-fill-${i}-in: unparseable color`); continue; }
    const dL = Math.abs(toOklab(tone)[0] - toOklab(fill)[0]);
    if (dL < NESTED_MIN_DL) {
      failures.push({ fg: `d-fill-${i}-in`, bg: `d-fill-${i}`, min: NESTED_MIN_DL, ratio: dL });
      errors.push(`--d-fill-${i}-in on --d-fill-${i}: ΔL ${dL.toFixed(3)} < ${NESTED_MIN_DL} — a box nested in this panel would vanish into it`);
    }
    const r = contrast(ink, tone);
    if (r < 3.0) {
      failures.push({ fg: 'd-text', bg: `d-fill-${i}-in`, min: 3.0, ratio: r });
      errors.push(`--d-text on --d-fill-${i}-in${own ? '' : ' (derived)'}: ${r.toFixed(2)} < 3`);
    }
  }

  // A highlight (`<mark>`, PRESENTING_EDITING): words marked while typing sit
  // on the theme's accent tinted over the slide, `--mark-bg`, by default
  // `--mark-tint` (25%) of the accent; a theme may set the tint, or its own
  // `--mark-bg` and `--mark-fg`. Over every background stop the marked words
  // must stay as readable as body text, headings and muted words, and the
  // mark must show. These are WARNINGS: a theme written before highlights
  // existed (a marketplace's, a deck's own) still applies, and `theme gate`
  // names what to set. The shipped themes are held to them (test/contrast.mjs).
  // A line walk's callout (CODE_AND_MATH, #1182) draws its bracket in
  // `--callout-ink`, the accent unless the theme says otherwise, on the code's
  // ground: a warning too, for the same reason. So is a figure's value
  // (DECK_ANATOMY), `--figure-ink`, else the accent, on the slide, and a
  // run's current group in its strip, `--steps-ink`, else the accent; and a
  // conversation's bubbles (DECK_ANATOMY), `--turn-*`, else the block's
  // ground and the body ink, and the accent and its contrast for the user.
  const warnings = [...markGates(tokens), ...calloutGates(tokens), ...figureGates(tokens), ...stepsGates(tokens), ...turnGates(tokens)].map((m) => m.message);

  return { ok: errors.length === 0, tokens, exceptions, missing, failures, errors, warnings, empty: false };
}

/** The accent's share in a highlight when the theme says nothing: `color-mix(in srgb, var(--accent) 25%, transparent)`. */
export const MARK_TINT = 0.25;
/** How far a highlight must stand from the slide behind it, in OKLab distance, to read as one. */
export const MARK_MIN_DISTANCE = 0.05;

/**
 * What a theme made from a palette (a PowerPoint template, a brand) adds so
 * its highlight passes: nothing when the default tint does, else the
 * nearest `--mark-tint` that does (lighter first, down to 6%, then stronger,
 * up to 70%, for an accent too pale to show), else a highlight of its own
 * (`--mark-bg`, the accent at 12% over the first background stop, and
 * `--mark-fg`, whichever of fg and heading-color reads best on it). Tokens
 * without the `--`, as `markGates` takes them.
 */
export function settleMark(tokens) {
  if (!markGates(tokens).length) return {};
  // lighter first (the words lose their edge on a strong tint), then stronger (a pale accent does not show)
  const tints = [22, 20, 18, 16, 14, 12, 10, 8, 6, 30, 35, 40, 45, 50, 60, 70];
  for (const pct of tints) {
    const add = { 'mark-tint': `${pct}%` };
    if (!markGates({ ...tokens, ...add }).length) return add;
  }
  const accent = colorsIn(tokens.accent ?? '')[0];
  const stop = colorsIn(tokens.bg ?? '')[0];
  if (!accent || !stop) return {};
  const tone = tintOver(accent, stop, 0.12);
  const inks = ['fg', 'heading-color'].map((k) => colorsIn(tokens[k] ?? '')[0]).filter(Boolean);
  const ink = inks.sort((a, b) => contrast(b, tone) - contrast(a, tone))[0];
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  return ink ? { 'mark-bg': hex(tone), 'mark-fg': hex(ink) } : {};
}

/** `tint` over `bg`, as the page composites a translucent accent: in sRGB, by alpha. */
const tintOver = (tint, bg, alpha) => tint.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha)));

/**
 * The highlight's gates for a theme's tokens, as failures (none: it passes).
 * The mark behind the words is the theme's opaque `--mark-bg` when it sets
 * one, else its accent at `--mark-tint` over each background stop.
 */
export function markGates(tokens) {
  const out = [];
  const accent = colorsIn(tokens.accent ?? '')[0];
  const stops = colorsIn(tokens.bg ?? '');
  if (!accent || !stops.length) return out;   // missing or unparseable: already reported
  const own = tokens['mark-bg'] ? colorsIn(tokens['mark-bg'])[0] : null;
  const pct = /^\s*([\d.]+)%\s*$/.exec(tokens['mark-tint'] ?? '');
  const alpha = pct ? Number(pct[1]) / 100 : MARK_TINT;
  const ink = (name) => colorsIn(tokens['mark-fg'] ?? tokens[name] ?? '')[0];
  // body text as body text; a heading as a heading; a subtitle's muted words as a diagram's sublabels
  const gates = [['fg', 4.5], ['heading-color', 3.0], ['muted', 2.6]];
  for (const stop of stops) {
    const tone = own ?? tintOver(accent, stop, alpha);
    for (const [name, min] of gates) {
      const fg = ink(name);
      if (!fg) continue;
      const ratio = contrast(fg, tone);
      if (ratio < min) {
        out.push({ fg: tokens['mark-fg'] ? 'mark-fg' : name, bg: 'mark-bg', min, ratio,
          message: `--${tokens['mark-fg'] ? 'mark-fg' : name} on a highlight (--mark-bg${own ? '' : `, the accent at ${Math.round(alpha * 100)}%`}): ${ratio.toFixed(2)} < ${min} — lower --mark-tint, or set --mark-bg and --mark-fg` });
      }
    }
    const [a, b] = [toOklab(tone), toOklab(stop)];
    const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (distance < MARK_MIN_DISTANCE) {
      out.push({ fg: 'mark-bg', bg: 'bg', min: MARK_MIN_DISTANCE, ratio: distance,
        message: `--mark-bg on --bg: OKLab distance ${distance.toFixed(3)} < ${MARK_MIN_DISTANCE} — a highlight would not show` });
    }
  }
  return out;
}

/** How far a callout's bracket stands from the code's ground: a graphic, not words (WCAG 1.4.11). */
export const CALLOUT_MIN = 3.0;

/**
 * The callout bracket's gate (CODE_AND_MATH, #1182) for a theme's tokens, as
 * failures (none: it passes): `--callout-ink`, else `--accent`, on every stop
 * of `--code-bg`. The label itself is `--code-fg`, which the contract gates.
 */
export function calloutGates(tokens) {
  const name = tokens['callout-ink'] ? 'callout-ink' : 'accent';
  if (!tokens[name] || !tokens['code-bg']) return [];   // missing: already reported
  const ratio = minContrast(tokens[name], tokens['code-bg']);
  if (ratio === null || ratio >= CALLOUT_MIN) return [];
  return [{ fg: name, bg: 'code-bg', min: CALLOUT_MIN, ratio,
    message: `--${name} on --code-bg: ${ratio.toFixed(2)} < ${CALLOUT_MIN} — a code callout's bracket would not show: set --callout-ink` }];
}

/** How far a figure's value stands from the slide: large type, WCAG 1.4.3's 3:1. */
export const FIGURE_MIN = 3.0;

/**
 * A figure's gate (DECK_ANATOMY) for a theme's tokens, as failures (none: it
 * passes): its value, `--figure-ink`, else `--accent`, on every stop of
 * `--bg`. The value is set several times the body size, so large text's 3:1.
 */
export function figureGates(tokens) {
  const name = tokens['figure-ink'] ? 'figure-ink' : 'accent';
  if (!tokens[name] || !tokens.bg) return [];   // missing: already reported
  const ratio = minContrast(tokens[name], tokens.bg);
  if (ratio === null || ratio >= FIGURE_MIN) return [];
  return [{ fg: name, bg: 'bg', min: FIGURE_MIN, ratio,
    message: `--${name} on --bg: ${ratio.toFixed(2)} < ${FIGURE_MIN} — a figure's value would not read: set --figure-ink` }];
}

/** How far a run's current group stands from the slide: bold type at 19 design px, WCAG 1.4.3's large-text 3:1. */
export const STEPS_MIN = 3.0;

/**
 * A run's strip's gate (DECK_ANATOMY, #1188) for a theme's tokens, as
 * failures (none: it passes): the group the slide is in, `--steps-ink`, else
 * `--accent`, on every stop of `--bg`. The other groups and the count are
 * `--fg` and `--muted`, which the contract gates.
 */
export function stepsGates(tokens) {
  const name = tokens['steps-ink'] ? 'steps-ink' : 'accent';
  if (!tokens[name] || !tokens.bg) return [];   // missing: already reported
  const ratio = minContrast(tokens[name], tokens.bg);
  if (ratio === null || ratio >= STEPS_MIN) return [];
  return [{ fg: name, bg: 'bg', min: STEPS_MIN, ratio,
    message: `--${name} on --bg: ${ratio.toFixed(2)} < ${STEPS_MIN} — a run's current step would not read: set --steps-ink` }];
}

/** A conversation's words on their bubble are body text: WCAG 1.4.3's 4.5:1. */
export const TURN_MIN = 4.5;

/** A colour literal's alpha (rgba(), hsla(), #rrggbbaa, #rgba), 1 when it has none. */
function alphaOf(value) {
  const v = String(value ?? '').trim();
  const fn = /^(?:rgb|hsl)a?\(([^)]*)\)$/i.exec(v);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 4) return 1;
    const a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    return Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1;
  }
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(v);
  if (hex) return parseInt(hex[1].length === 4 ? hex[1][3].repeat(2) : hex[1].slice(6), 16) / 255;
  return 1;
}

/**
 * A conversation's gates (DECK_ANATOMY, #1179) for a theme's tokens, as
 * failures (none: it passes). An agent's, a tool's or a system's bubble is
 * `--turn-bg`, else `--block-bg` (a translucent one over every stop of
 * `--bg`), its words `--turn-ink`, else `--fg`; the user's is `--turn-user-bg`,
 * else `--accent`, its words `--turn-user-ink`, else `--accent-contrast`. Both
 * are read as body text. A thought is `--muted` on the slide and a tool's turn
 * the code's ink on the code's ground, which the contract gates.
 */
export function turnGates(tokens) {
  const out = [];
  const bgName = tokens['turn-bg'] ? 'turn-bg' : 'block-bg';
  const inkName = tokens['turn-ink'] ? 'turn-ink' : 'fg';
  const ink = colorsIn(tokens[inkName] ?? '')[0];
  const ground = colorsIn(tokens[bgName] ?? '')[0];
  const stops = colorsIn(tokens.bg ?? '');
  if (ink && ground && stops.length) {
    const alpha = alphaOf(tokens[bgName]);
    const ratio = Math.min(...stops.map((s) => contrast(ink, tintOver(ground, s, alpha))));
    if (ratio < TURN_MIN) {
      out.push({ fg: inkName, bg: bgName, min: TURN_MIN, ratio,
        message: `--${inkName} on --${bgName}: ${ratio.toFixed(2)} < ${TURN_MIN} — a conversation's turn would not read: set --turn-bg and --turn-ink` });
    }
  }
  const userBg = tokens['turn-user-bg'] ? 'turn-user-bg' : 'accent';
  const userInk = tokens['turn-user-ink'] ? 'turn-user-ink' : 'accent-contrast';
  if (tokens[userBg] && tokens[userInk]) {
    const ratio = minContrast(tokens[userInk], tokens[userBg]);
    if (ratio !== null && ratio < TURN_MIN) {
      out.push({ fg: userInk, bg: userBg, min: TURN_MIN, ratio,
        message: `--${userInk} on --${userBg}: ${ratio.toFixed(2)} < ${TURN_MIN} — a user's turn would not read: set --turn-user-bg and --turn-user-ink` });
    }
  }
  return out;
}

/** The least OKLab lightness step between a panel and the tone of a box nested in it. */
export const NESTED_MIN_DL = 0.06;

/** A theme name from a path or URL: the basename, minus .css. */
export function themeNameFrom(source) {
  // Both separators, because `source` is either a URL (always `/`) or a local
  // path (`\` on Windows). Splitting on `/` alone made the whole path the
  // name there — `decklight theme gate C:\themes\aurora.css` reported
  // `✔ C:\themes\aurora`, and `theme add` would then have tried to install
  // under a name validThemeName refuses, from a file that was perfectly fine.
  const last = String(source ?? '').split(/[?#]/)[0].split(/[/\\]/).filter(Boolean).pop() ?? '';
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
