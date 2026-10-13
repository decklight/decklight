// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A design system's palette, and the themes drawn from it (SPEC BRAND_PALETTE).
//
// The palette is the brand: a dozen or so named colours, each in weights from
// 100 to 1000. A theme is one way of wearing it — dark, light, a projector's
// high contrast — and may use nothing BUT its swatches, so a brand theme is on
// brand by construction: an off-palette colour cannot be written down at all.
//
// PURE, like tools/design-system-format.mjs beside it: texts and objects in,
// objects out, nothing read from disk. `design-system gate` runs it on a
// package; the servers and `bundle` read what the check already worked out.
//
// What is derived is only what the palette lacks. A palette with a neutral
// scale gets no neutral; a scale with all ten weights gets no weight. What a
// THEME leaves unstated is chosen among swatches — never mixed — by the same
// roles the theme generator fills (THEMING R1–R8), and every expanded theme
// answers the shipped themes' contrast gates (tools/theme-check.mjs).

import { contrast, parseColor, toOklab, fromOklab, rgbToHex } from './color.mjs';
import { validateTheme, NESTED_MIN_DL } from './theme-check.mjs';

/** The weights a scale may define: 100, 200 … 1000. */
export const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

/** A colour's (and a theme's) name: what a theme writes, so it stays plain. */
export const SWATCH_NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Below this OKLCH chroma everywhere, a scale reads as a neutral. */
export const NEUTRAL_CHROMA = 0.03;

/** The chroma of a derived neutral: a trace of the brand's hue (THEMING R6). */
const DERIVED_NEUTRAL_CHROMA = 0.012;

/** A scale needs at least this many weights before the rest can be derived from it. */
export const MIN_WEIGHTS = 3;

/** A swatch nearer than this (OKLab distance) to a palette colour counts as that colour. */
export const ON_PALETTE_DISTANCE = 0.02;

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const lab = (hex) => toOklab(parseColor(hex));
const lightness = (hex) => lab(hex)[0];
const chromaOf = ([, a, b]) => Math.hypot(a, b);
const hueOf = ([, a, b]) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
const hueGap = (x, y) => { const d = Math.abs(x - y) % 360; return d > 180 ? 360 - d : d; };
const hexOf = (labValue) => rgbToHex(fromOklab(labValue));
const labDistance = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const ratio = (fg, bg) => contrast(parseColor(fg), parseColor(bg));

// ── the palette ─────────────────────────────────────────────────────────────

/**
 * Read a manifest's scale palette: `{ colors: { <name>: { label, role?,
 * weights: { "100": "#hex", … } } } }`.
 *
 * Returns `{ scales, neutral, problems, notes }`. `scales` maps each colour
 * name to `{ name, label, role, weights: { 100: '#hex', … }, derived: [w…] }`
 * with every weight 100–1000 present — the ones the manifest left out derived
 * (OKLab interpolation between its own neighbours; at the ends, its own hue
 * and chroma at the lightness the palette's other scales have there) — plus a
 * derived `neutral` scale when the palette has none. `problems` refuse the
 * package; `notes` are what the engine made up, said so a brand reviewer sees
 * it. Each is `{ rule, msg }`.
 */
export function readScales(palette) {
  const problems = [];
  const notes = [];
  const scales = {};
  const colors = palette?.colors;
  if (!colors || typeof colors !== 'object' || Array.isArray(colors) || !Object.keys(colors).length) {
    problems.push({ rule: 'palette-shape', msg: 'palette must be { colors: { <name>: { label, weights: { "100": "#hex", … "1000": "#hex" } } } }' });
    return { scales, neutral: null, problems, notes };
  }
  for (const [name, c] of Object.entries(colors)) {
    const where = `palette.colors.${name}`;
    if (!SWATCH_NAME_RE.test(name)) { problems.push({ rule: 'palette-shape', msg: `${where}: a colour's name is a lowercase word (letters, digits and -), e.g. "blue"` }); continue; }
    if (!c || typeof c !== 'object' || typeof c.label !== 'string' || !c.label.trim() || !c.weights || typeof c.weights !== 'object') {
      problems.push({ rule: 'palette-shape', msg: `${where} must be { label, weights: { "100": "#hex", … } }` });
      continue;
    }
    if (c.role !== undefined && c.role !== 'neutral') problems.push({ rule: 'palette-shape', msg: `${where}.role ${JSON.stringify(c.role)} — the one role a colour can have is "neutral"` });
    const weights = {};
    let bad = false;
    for (const [k, v] of Object.entries(c.weights)) {
      const w = Number(k);
      if (!WEIGHTS.includes(w) || String(w) !== k) { problems.push({ rule: 'palette-shape', msg: `${where}: weight "${k}" — weights are 100, 200 … 1000` }); bad = true; continue; }
      if (typeof v !== 'string' || !HEX_RE.test(v)) { problems.push({ rule: 'palette-shape', msg: `${where}.${k}: ${JSON.stringify(v)} is not a hex colour (#rgb or #rrggbb)` }); bad = true; continue; }
      weights[w] = v.toLowerCase();
    }
    if (bad) continue;
    const have = WEIGHTS.filter((w) => weights[w]);
    if (have.length < MIN_WEIGHTS) {
      problems.push({ rule: 'palette-too-narrow', msg: `${where} defines ${have.length} weight${have.length === 1 ? '' : 's'} — a scale needs at least ${MIN_WEIGHTS} before the rest can be derived from it` });
      continue;
    }
    for (let i = 1; i < have.length; i++) {
      const [a, b] = [have[i - 1], have[i]];
      if (!(lightness(weights[b]) < lightness(weights[a]))) {
        problems.push({ rule: 'palette-order', msg: `${where}: ${b} (${weights[b]}) is not darker than ${a} (${weights[a]}) — weights run from 100, the lightest, to 1000, the darkest` });
        bad = true;
        break;
      }
    }
    if (bad) continue;
    scales[name] = { name, label: c.label.trim(), role: c.role === 'neutral' ? 'neutral' : null, weights, derived: [] };
  }
  if (problems.length) return { scales, neutral: null, problems, notes };

  // the lightness the palette has at each weight: where a scale's own ends are extrapolated to
  const meanL = {};
  for (const w of WEIGHTS) {
    const ls = Object.values(scales).map((s) => s.weights[w]).filter(Boolean).map(lightness);
    meanL[w] = ls.length ? ls.reduce((x, y) => x + y, 0) / ls.length : null;
  }
  // a weight no scale defines at all: between its neighbours' means, or the far ends of the range
  for (const w of WEIGHTS) {
    if (meanL[w] !== null) continue;
    const below = WEIGHTS.filter((v) => v < w && meanL[v] !== null).pop();
    const above = WEIGHTS.find((v) => v > w && meanL[v] !== null);
    meanL[w] = below && above ? meanL[below] + ((meanL[above] - meanL[below]) * (w - below)) / (above - below)
      : below ? Math.max(0.12, meanL[below] - ((w - below) / 100) * 0.08) : Math.min(0.98, meanL[above] + ((above - w) / 100) * 0.03);
  }

  for (const s of Object.values(scales)) {
    const have = WEIGHTS.filter((w) => s.weights[w]);
    for (const w of WEIGHTS) {
      if (s.weights[w]) continue;
      const below = have.filter((v) => v < w).pop();
      const above = have.find((v) => v > w);
      let value;
      if (below && above) {
        const [p, q] = [lab(s.weights[below]), lab(s.weights[above])];
        const t = (w - below) / (above - below);
        value = hexOf(p.map((v, i) => v + (q[i] - v) * t));
      } else {
        // an end: the nearest weight's hue and chroma, at the palette's lightness there
        const near = lab(s.weights[below ?? above]);
        const c = chromaOf(near); const h = (hueOf(near) * Math.PI) / 180;
        const L = below ? Math.min(meanL[w], lightness(s.weights[below]) - 0.03) : Math.max(meanL[w], lightness(s.weights[above]) + 0.03);
        value = hexOf([L, c * Math.cos(h), c * Math.sin(h)]);
      }
      s.weights[w] = value;
      s.derived.push(w);
    }
    if (s.derived.length) {
      notes.push({ rule: 'palette-derived-weight', msg: `${s.name}: ${s.derived.join(', ')} derived from the weights it defines` });
    }
  }

  // the neutral scale: the one marked, else the one with no chroma, else derived
  let neutral = Object.values(scales).find((s) => s.role === 'neutral')?.name ?? null;
  if (!neutral) {
    const grey = Object.values(scales).find((s) => WEIGHTS.every((w) => chromaOf(lab(s.weights[w])) < NEUTRAL_CHROMA));
    if (grey) {
      neutral = grey.name;
      notes.push({ rule: 'palette-neutral', msg: `${grey.name} is taken as the neutral scale (no chroma); mark it "role": "neutral" to say so` });
    }
  }
  if (!neutral) {
    const first = Object.values(scales)[0];
    const h = (hueOf(lab(first.weights[500])) * Math.PI) / 180;
    const name = scales.neutral ? 'neutral-derived' : 'neutral';
    const weights = {};
    for (const w of WEIGHTS) weights[w] = hexOf([meanL[w], DERIVED_NEUTRAL_CHROMA * Math.cos(h), DERIVED_NEUTRAL_CHROMA * Math.sin(h)]);
    scales[name] = { name, label: 'Neutral', role: 'neutral', weights, derived: [...WEIGHTS], generated: true };
    neutral = name;
    notes.push({ rule: 'palette-derived-neutral', msg: `the palette has no neutral scale: "${name}" is derived, tinted with a trace of ${first.name}` });
  }
  return { scales, neutral, problems, notes };
}

/** The token a swatch is: `--<prefix><colour>-<weight>`. */
export const swatchToken = (prefix, color, weight) => `${prefix}${color}-${weight}`;

/**
 * The stylesheet that defines every swatch as a token, on `.decklight`: what a
 * server serves beside the design system's own stylesheet, and `bundle`
 * inlines. The manifest is the one source of these values.
 */
export function paletteCss(scales, prefix) {
  const lines = [];
  for (const s of Object.values(scales)) for (const w of WEIGHTS) lines.push(`  ${swatchToken(prefix, s.name, w)}: ${s.weights[w]};`);
  return `.decklight {\n${lines.join('\n')}\n}\n`;
}

/**
 * The palette as the page is told it (the design-system meta): one entry per
 * swatch, `{ group, label, short, token, hex, derived }`, a colour's ten in
 * weight order — what the Colors tab draws as one row per colour.
 */
export function paletteEntries(scales, prefix) {
  const out = [];
  for (const s of Object.values(scales)) {
    for (const w of WEIGHTS) {
      out.push({ group: s.label, label: `${s.label} ${w}`, short: String(w), token: swatchToken(prefix, s.name, w), hex: s.weights[w], derived: s.derived.includes(w) || undefined, ref: `${s.name}-${w}` });
    }
  }
  return out;
}

/** The token a role is: `--<prefix>color-<role>` (SPEC DESIGN_SYSTEM_ROLES). */
export const roleToken = (prefix, id) => `${prefix}color-${id}`;

/** `blue-700` or `blue-700/40` → `{ color, weight, alpha }`, or null for anything else. */
export function parseSwatchRef(ref) {
  const m = /^([a-z][a-z0-9-]*)-(\d{3,4})(?:\/(\d{1,3}))?$/.exec(String(ref ?? ''));
  if (!m) return null;
  const weight = Number(m[2]);
  const alpha = m[3] === undefined ? null : Number(m[3]);
  if (!WEIGHTS.includes(weight) || (alpha !== null && (alpha < 1 || alpha > 99))) return null;
  return { color: m[1], weight, alpha };
}

/** The swatch nearest `hex` (OKLab), as `{ ref, color, weight, hex, distance }`. */
export function nearestSwatch(scales, hex) {
  const target = lab(hex);
  let best = null;
  for (const s of Object.values(scales)) {
    for (const w of WEIGHTS) {
      const d = labDistance(target, lab(s.weights[w]));
      if (!best || d < best.distance) best = { ref: `${s.name}-${w}`, color: s.name, weight: w, hex: s.weights[w], distance: d };
    }
  }
  return best;
}

// ── themes ──────────────────────────────────────────────────────────────────

/** The theme contract's colour tokens: what a brand theme may give only a swatch. */
export const COLOUR_TOKENS = new Set([
  '--bg', '--bg-accent', '--fg', '--muted', '--heading-color', '--link', '--accent', '--accent-contrast',
  '--block-bg', '--block-border', '--code-bg', '--code-fg',
  '--hl-keyword', '--hl-string', '--hl-number', '--hl-comment', '--hl-function', '--hl-type', '--hl-punct',
  '--d-stroke', '--d-text', '--d-muted', '--d-accent',
  ...[1, 2, 3, 4, 5, 6].flatMap((i) => [`--d-fill-${i}`, `--d-fill-${i}-in`]),
  '--term-bg', '--term-fg', '--term-prompt', '--term-cursor', '--term-selection',
  ...['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].flatMap((a) => [`--ansi-${a}`, `--ansi-bright-${a}`]),
]);
/** …and the ones a brand theme states as plain values, as a theme file would. */
const PLAIN_TOKENS = {
  '--font-body': /^[^{};<>]{1,200}$/,
  '--font-heading': /^[^{};<>]{1,200}$/,
  '--font-mono': /^[^{};<>]{1,200}$/,
  '--heading-weight': /^[1-9]00$/,
  '--block-radius': /^\d{1,2}(?:\.\d)?px$/,
  '--build-duration': /^\d{2,4}ms$/,
  '--dim-opacity': /^(?:0(?:\.\d{1,2})?|1)$/,
  '--shadow': /^none$/,
};
/** Colour tokens a contrast gate reads: these must be opaque. */
export const GATED = new Set([
  '--bg', '--fg', '--muted', '--heading-color', '--link', '--accent', '--accent-contrast', '--code-bg', '--code-fg',
  '--hl-keyword', '--hl-string', '--hl-number', '--hl-comment', '--hl-function', '--hl-type', '--hl-punct',
  '--d-text', '--d-muted', '--d-accent', ...[1, 2, 3, 4, 5, 6].flatMap((i) => [`--d-fill-${i}`, `--d-fill-${i}-in`]),
  '--term-bg', '--term-fg', '--term-prompt',
  ...['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'].flatMap((a) => [`--ansi-${a}`, `--ansi-bright-${a}`]),
]);

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO = '"SF Mono", SFMono-Regular, ui-monospace, "Cascadia Code", Menlo, Consolas, monospace';

// The hue each syntax and terminal role is recognised by (OKLCH degrees): R8,
// terminal red stays red. A role takes the palette colour nearest its hue.
const ROLE_HUES = {
  '--hl-keyword': 305, '--hl-string': 145, '--hl-number': 60, '--hl-function': 255, '--hl-type': 195,
  red: 28, green: 145, yellow: 100, blue: 255, magenta: 330, cyan: 205,
};
/** Past this hue gap the nearest colour is said to be a stand-in. */
const ROLE_REACH = 40;

/**
 * Expand one brand theme: `{ name, title, mode, tokens }` from the manifest
 * against the palette. Returns `{ name, title, mode, css, gateCss, tokens,
 * stated, chosen, problems, notes }`: `css` is the theme as a page applies it
 * (each swatch `var(--acme-blue-700, #hex)`, so it keeps its colours if the
 * design system's stylesheet is missing), `gateCss` the same in plain colours
 * — what the contrast gates read — and `tokens` the plain-colour map.
 */
export function expandTheme(read, theme, prefix, { roles = null, contract = null } = {}) {
  const { scales, neutral } = read;
  const problems = [];
  const notes = [];
  const where = `themes: ${theme?.name ?? '?'}`;
  const out = { name: theme?.name, title: theme?.title, mode: theme?.mode, css: '', gateCss: '', tokens: {}, refs: {}, stated: [], chosen: [], roleRefs: {}, roleValues: {}, viaRole: {}, problems, notes };
  const N = scales[neutral];
  const colours = Object.values(scales).filter((s) => s.name !== neutral);
  const hexOfRef = (r) => scales[r.color]?.weights[r.weight];
  // every value: the plain colour (gates), and what the page gets
  const plain = {}; const live = {};
  const swatchCss = (color, weight) => `var(${swatchToken(prefix, color, weight)}, ${scales[color].weights[weight]})`;
  const rgba = (hex, a) => { const [r, g, b] = parseColor(hex); return `rgba(${r}, ${g}, ${b}, ${a / 100})`; };
  const set = (token, color, weight, alpha = null) => {
    const hex = scales[color].weights[weight];
    plain[token] = alpha === null ? hex : rgba(hex, alpha);
    live[token] = alpha === null ? swatchCss(color, weight) : `color-mix(in srgb, ${swatchCss(color, weight)} ${alpha}%, transparent)`;
    out.refs[token] = `${color}-${weight}${alpha === null ? '' : `/${alpha}`}`;
  };

  // ── the design system's roles (SPEC DESIGN_SYSTEM_ROLES): every one a swatch, in every theme
  const roleLive = {};
  const themeRoles = theme?.roles && typeof theme.roles === 'object' && !Array.isArray(theme.roles) ? theme.roles : null;
  if (roles) {
    const gatedRole = new Set(Object.entries(contract ?? {}).filter(([t]) => GATED.has(t)).map(([, r]) => r));
    for (const id of Object.keys(roles)) {
      const value = themeRoles?.[id];
      if (value === undefined) {
        problems.push({ rule: 'theme-role-missing', msg: `${where}: gives no swatch to the role ${id} — every theme sets every role, "roles": { "${id}": "<colour>-<weight>" }` });
        continue;
      }
      const r = parseSwatchRef(value);
      if (!r || !hexOfRef(r)) {
        problems.push({ rule: 'theme-off-palette', msg: `${where}: role ${id} ${JSON.stringify(value)} names no swatch — a role is a swatch of the palette, "<colour>-<weight>" or "<colour>-<weight>/<opacity>"` });
        continue;
      }
      if (r.alpha !== null && gatedRole.has(id)) {
        problems.push({ rule: 'theme-off-palette', msg: `${where}: role ${id} ${value} — the contract reads it for a colour a contrast gate checks, so it is opaque` });
        continue;
      }
      const hex = scales[r.color].weights[r.weight];
      out.roleRefs[id] = value;
      out.roleValues[id] = r.alpha === null ? hex : rgba(hex, r.alpha);
      roleLive[roleToken(prefix, id)] = r.alpha === null ? swatchCss(r.color, r.weight) : `color-mix(in srgb, ${swatchCss(r.color, r.weight)} ${r.alpha}%, transparent)`;
    }
    for (const id of Object.keys(themeRoles ?? {})) {
      if (!Object.hasOwn(roles, id)) problems.push({ rule: 'theme-role-unknown', msg: `${where}: sets the role ${id}, which the manifest's "roles" does not declare` });
    }
  } else if (themeRoles && roles !== false) {
    problems.push({ rule: 'theme-role-unknown', msg: `${where}: sets "roles", but the manifest declares none — declare them in a top-level "roles"` });
  }
  if (problems.length) return out;

  // ── what the brand stated: the contract's roles first, then the theme's own tokens, which win
  const own = theme?.tokens && typeof theme.tokens === 'object' && !Array.isArray(theme.tokens) ? theme.tokens : {};
  const fromRoles = {};
  for (const [token, id] of Object.entries(roles ? contract ?? {} : {})) {
    if (Object.hasOwn(own, token) || out.roleRefs[id] === undefined) continue;
    fromRoles[token] = out.roleRefs[id];
    out.viaRole[token] = id;
  }
  const stated = { ...fromRoles, ...own };
  for (const [token, value] of Object.entries(stated)) {
    if (COLOUR_TOKENS.has(token)) {
      if (token === '--bg' && value && typeof value === 'object' && !Array.isArray(value)) {
        const stops = Array.isArray(value.gradient) ? value.gradient.map(parseSwatchRef) : [];
        const angle = value.angle ?? 180;
        if (stops.length < 2 || stops.some((r) => !r || r.alpha !== null || !hexOfRef(r)) || !Number.isFinite(angle)) {
          problems.push({ rule: 'theme-off-palette', msg: `${where}: --bg gradient must be { "gradient": ["<swatch>", "<swatch>"…], "angle": <deg> }, every stop a swatch of the palette` });
          continue;
        }
        plain[token] = `linear-gradient(${angle}deg, ${stops.map(hexOfRef).join(', ')})`;
        live[token] = `linear-gradient(${angle}deg, ${stops.map((r) => swatchCss(r.color, r.weight)).join(', ')})`;
        out.refs[token] = stops.map((r) => `${r.color}-${r.weight}`).join(' → ');
        out.stated.push(token);
        continue;
      }
      const r = parseSwatchRef(value);
      if (!r || !hexOfRef(r)) {
        problems.push({ rule: 'theme-off-palette', msg: `${where}: ${token} ${JSON.stringify(value)} names no swatch — a brand theme's colours are swatches of its palette, "<colour>-<weight>" (e.g. "blue-700"), or "<colour>-<weight>/<opacity>"` });
        continue;
      }
      if (r.alpha !== null && GATED.has(token)) {
        problems.push({ rule: 'theme-off-palette', msg: `${where}: ${token} ${value} — a colour a contrast gate reads is opaque; an opacity is for a shadow, a selection or a block` });
        continue;
      }
      set(token, r.color, r.weight, r.alpha);
      out.stated.push(token);
    } else if (PLAIN_TOKENS[token]) {
      if (typeof value !== 'string' || !PLAIN_TOKENS[token].test(value.trim())) {
        problems.push({ rule: 'theme-token', msg: `${where}: ${token} ${JSON.stringify(value)} is not a value this token takes` });
        continue;
      }
      plain[token] = live[token] = value.trim();
      out.stated.push(token);
    } else {
      problems.push({ rule: 'theme-token', msg: `${where}: ${token} is not a token of the theme contract (SPEC THEMING)` });
    }
  }
  if (problems.length) return out;

  // ── what it left out, chosen among swatches
  const dark = theme.mode === 'dark';
  const inkward = dark ? [...WEIGHTS] : [...WEIGHTS].reverse();       // the most extreme ink first
  const bgward = [...inkward].reverse();                              // the canvas end first
  const has = (t) => plain[t] !== undefined;
  const colourOf = (t) => (out.refs[t] ?? '').replace(/-\d+(?:\/\d+)?$/, '') || null;
  const weightOf = (t) => Number(/-(\d+)(?:\/\d+)?$/.exec(out.refs[t] ?? '')?.[1] ?? NaN);
  const choose = (token, color, weight, alpha = null) => { set(token, color, weight, alpha); out.chosen.push(token); };
  const firstHex = (v) => (/#[0-9a-f]{6}/i.exec(v)?.[0] ?? null);
  const bgHex = () => firstHex(plain['--bg']);
  // the step next to `w` toward the ink (or back toward the canvas), clamped
  const step = (w, n) => { const i = WEIGHTS.indexOf(w) + (dark ? -n : n); return WEIGHTS[Math.max(0, Math.min(WEIGHTS.length - 1, i))]; };
  /** The weight of `scale`, in `order`, whose colour clears `min` against every `against`; `softest` takes the passing one nearest the canvas. */
  const pass = (scale, order, against, min, { softest = false } = {}) => {
    const ok = order.filter((w) => against.every((bg) => ratio(scale.weights[w], bg) >= min));
    if (!ok.length) return null;
    return softest ? ok[ok.length - 1] : ok[0];
  };

  if (!has('--bg')) choose('--bg', N.name, dark ? 1000 : 100);
  const bg = bgHex();
  const ink = (min, softest = true) => pass(N, inkward, [bg], min, { softest });
  // body text one step in from the scale's end, headings at the end: strong, and still the brand's neutral
  const strong = (min) => [inkward[1], inkward[0], inkward[2]].find((w) => ratio(N.weights[w], bg) >= min);
  if (!has('--fg')) choose('--fg', N.name, strong(7) ?? strong(4.5) ?? inkward[0]);
  if (!has('--heading-color')) choose('--heading-color', N.name, ratio(N.weights[inkward[0]], bg) >= 3 ? inkward[0] : weightOf('--fg'));
  if (!has('--muted')) choose('--muted', N.name, ink(4) ?? ink(3) ?? inkward[0]);
  const bgW = colourOf('--bg') === N.name ? weightOf('--bg') : (dark ? 1000 : 100);
  if (!has('--bg-accent')) choose('--bg-accent', N.name, step(bgW, 1));
  if (!has('--block-bg')) choose('--block-bg', N.name, step(bgW, 1));
  if (!has('--block-border')) choose('--block-border', N.name, step(bgW, 2));
  if (!has('--shadow')) { const shade = N.weights[1000]; plain['--shadow'] = live['--shadow'] = `0 8px 24px ${rgba(shade, dark ? 50 : 18)}`; out.chosen.push('--shadow'); }

  // the accent: stated, else the brand's first colour, mid-scale, readable on the canvas
  const mid = dark ? [500, 400, 600, 300, 700, 200, 800] : [600, 500, 700, 400, 800, 300, 900];
  const accentScale = scales[colourOf('--accent')] ?? colours[0] ?? N;
  if (!has('--accent')) {
    const w = mid.find((v) => ratio(accentScale.weights[v], bg) >= 3) ?? mid[0];
    choose('--accent', accentScale.name, w);
  }
  const accentHex = plain['--accent'];
  if (!has('--accent-contrast')) {
    // the neutral's end that reads on the accent; failing that, whichever swatch reads best on it
    const ends = [100, 1000].map((w) => ({ color: N.name, w, r: ratio(N.weights[w], accentHex) })).sort((x, y) => y.r - x.r);
    let best = ends[0];
    if (best.r < 4.5) {
      for (const sc of Object.values(scales)) for (const w of WEIGHTS) {
        const r = ratio(sc.weights[w], accentHex);
        if (r > best.r) best = { color: sc.name, w, r };
      }
    }
    choose('--accent-contrast', best.color, best.w);
  }
  if (!has('--link')) {
    const order = [...mid, ...inkward];
    const w = order.find((v) => ratio(accentScale.weights[v], bg) >= 4.5) ?? order.find((v) => ratio(accentScale.weights[v], bg) >= 3) ?? mid[0];
    choose('--link', accentScale.name, w);
  }

  // code: a block one step off the canvas, its ink and its six roles
  if (!has('--code-bg')) choose('--code-bg', N.name, step(bgW, 1));
  const codeBg = plain['--code-bg'];
  const onCode = (min) => pass(N, inkward, [codeBg], min, { softest: true });
  const strongOn = (against, min) => [inkward[1], inkward[0], inkward[2]].find((w) => ratio(N.weights[w], against) >= min);
  if (!has('--code-fg')) choose('--code-fg', N.name, strongOn(codeBg, 7) ?? onCode(4.5) ?? inkward[0]);
  if (!has('--hl-punct')) choose('--hl-punct', N.name, onCode(4.5) ?? inkward[0]);
  if (!has('--hl-comment')) choose('--hl-comment', N.name, onCode(3) ?? inkward[0]);
  /** The colour nearest `hue` that has a weight clearing `min` on every `against`, at its softest such weight. */
  const byHue = (token, hue, against, min) => {
    const ranked = colours.map((s) => ({ s, gap: hueGap(hueOf(lab(s.weights[500])), hue) })).sort((x, y) => x.gap - y.gap);
    for (const { s, gap } of ranked) {
      const w = pass(s, inkward, against, min + 0.3, { softest: true }) ?? pass(s, inkward, against, min, { softest: true });
      if (w === null) continue;
      if (gap > ROLE_REACH) notes.push({ rule: 'theme-nearest-role', msg: `${where}: ${token} wants a hue near ${hue}° and the palette's nearest is ${s.name} (${Math.round(gap)}° away)` });
      return { color: s.name, weight: w };
    }
    return null;
  };
  for (const role of ['--hl-keyword', '--hl-string', '--hl-number', '--hl-function', '--hl-type']) {
    if (has(role)) continue;
    const pick = byHue(role, ROLE_HUES[role], [codeBg], 4.5);
    if (pick) choose(role, pick.color, pick.weight);
    else choose(role, N.name, onCode(4.5) ?? inkward[0]);
  }

  // diagrams: the ink, six fills on six colours, each fill's nested tone the next weight toward the ink
  if (!has('--d-text')) choose('--d-text', N.name, ink(7, false) ?? inkward[0]);
  const dText = plain['--d-text'];
  const fillOrder = [accentScale, ...colours.filter((s) => s !== accentScale)];
  const fillWeights = dark ? [800, 900, 700, 600] : [200, 100, 300, 400];
  // six fills, six colours where the palette has them: a colour already used waits for the second pass
  const usedRefs = new Set(); const usedColours = new Set();
  for (let i = 1; i <= 6; i++) if (has(`--d-fill-${i}`)) { usedRefs.add(out.refs[`--d-fill-${i}`]); usedColours.add(colourOf(`--d-fill-${i}`)); }
  const fillFits = (s, w) => {
    const nw = step(w, 1);
    return ratio(dText, s.weights[w]) >= 3.6 && ratio(dText, s.weights[nw]) >= 3
      && Math.abs(lightness(s.weights[nw]) - lightness(s.weights[w])) >= NESTED_MIN_DL;
  };
  for (let i = 1; i <= 6; i++) {
    const t = `--d-fill-${i}`;
    if (has(t)) continue;
    let picked = null;
    for (const fresh of [true, false]) {
      for (const s of fillOrder) {
        if (fresh && usedColours.has(s.name)) continue;
        const w = fillWeights.find((v) => !usedRefs.has(`${s.name}-${v}`) && fillFits(s, v));
        if (w !== undefined) { picked = { s, w }; break; }
      }
      if (picked) break;
    }
    // nothing fits: the gates will say which pair, against the brand's stated ink
    picked ??= { s: fillOrder[(i - 1) % fillOrder.length], w: fillWeights[0] };
    usedRefs.add(`${picked.s.name}-${picked.w}`); usedColours.add(picked.s.name);
    choose(t, picked.s.name, picked.w);
  }
  for (let i = 1; i <= 6; i++) {
    const t = `--d-fill-${i}-in`;
    if (has(t)) continue;
    const c = colourOf(`--d-fill-${i}`); const w = weightOf(`--d-fill-${i}`);
    if (!scales[c] || !Number.isFinite(w)) continue;
    // the next weight toward the ink that is a step the eye reads and still carries the ink
    let nw = null;
    for (let n = 1; n <= 3; n++) {
      const cand = step(w, n);
      if (cand === w) break;
      if (Math.abs(lightness(scales[c].weights[cand]) - lightness(scales[c].weights[w])) >= NESTED_MIN_DL && ratio(dText, scales[c].weights[cand]) >= 3) { nw = cand; break; }
    }
    if (nw !== null) choose(t, c, nw);
  }
  const fills = [1, 2, 3, 4, 5, 6].map((i) => plain[`--d-fill-${i}`]).filter(Boolean);
  if (!has('--d-muted')) choose('--d-muted', N.name, pass(N, inkward, fills, 2.9, { softest: true }) ?? pass(N, inkward, fills, 2.6, { softest: true }) ?? inkward[0]);
  if (!has('--d-accent')) {
    const order = [...mid, ...inkward];
    const w = order.find((v) => fills.every((f) => ratio(accentScale.weights[v], f) >= 2.9)) ?? order.find((v) => fills.every((f) => ratio(accentScale.weights[v], f) >= 2.6));
    if (w) choose('--d-accent', accentScale.name, w);
    else choose('--d-accent', N.name, pass(N, inkward, fills, 2.6) ?? inkward[0]);
  }
  if (!has('--d-stroke')) choose('--d-stroke', N.name, ink(3) ?? inkward[0]);

  // the terminal: on the code block, its prompt in the accent, ANSI by hue
  if (!has('--term-bg')) { const r = parseSwatchRef(out.refs['--code-bg']); choose('--term-bg', r.color, r.weight); }
  const termBg = plain['--term-bg'];
  const onTerm = (min, softest = true) => pass(N, inkward, [termBg], min, { softest });
  if (!has('--term-fg')) choose('--term-fg', N.name, strongOn(termBg, 7) ?? onTerm(4.5) ?? inkward[0]);
  if (!has('--term-prompt')) {
    const w = [...mid, ...inkward].find((v) => ratio(accentScale.weights[v], termBg) >= 3.5) ?? null;
    if (w) choose('--term-prompt', accentScale.name, w); else choose('--term-prompt', N.name, onTerm(3.5) ?? inkward[0]);
  }
  if (!has('--term-cursor')) { const r = parseSwatchRef(out.refs['--term-prompt']); choose('--term-cursor', r.color, r.weight); }
  if (!has('--term-selection')) choose('--term-selection', accentScale.name, mid[0], 30);
  if (!has('--ansi-black')) choose('--ansi-black', N.name, onTerm(3.3) ?? inkward[0]);
  if (!has('--ansi-bright-black')) choose('--ansi-bright-black', N.name, onTerm(4.5) ?? inkward[0]);
  if (!has('--ansi-white')) choose('--ansi-white', N.name, onTerm(7, false) ?? inkward[0]);
  if (!has('--ansi-bright-white')) choose('--ansi-bright-white', N.name, inkward[0]);
  for (const a of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']) {
    const t = `--ansi-${a}`; const tb = `--ansi-bright-${a}`;
    if (!has(t)) {
      const pick = byHue(t, ROLE_HUES[a], [termBg], 3);
      if (pick) choose(t, pick.color, pick.weight); else choose(t, N.name, onTerm(3) ?? inkward[0]);
    }
    if (!has(tb)) {
      const c = colourOf(t); const w = weightOf(t);
      const nw = step(w, 1);
      choose(tb, c, ratio(scales[c].weights[nw], termBg) >= 3 ? nw : w);
    }
  }

  // the type: the stated stacks, else the system's
  for (const [t, v] of [['--font-body', SANS], ['--font-heading', SANS], ['--font-mono', MONO], ['--heading-weight', '700'], ['--block-radius', '10px']]) {
    if (!has(t)) { plain[t] = live[t] = v; out.chosen.push(t); }
  }

  out.tokens = plain;
  out.gateCss = themeCss(theme.name, plain);
  // the roles ride on the theme block, so switching theme recolours every role;
  // the gates read the contract alone
  out.css = themeCss(theme.title || theme.name, { ...live, ...roleLive });
  const verdict = validateTheme(out.gateCss);
  for (const e of verdict.errors) problems.push({ rule: 'theme-contrast', msg: `${where}: ${e}${blame(e, out)}` });
  return out;
}

/**
 * A theme's tokens as the stylesheet a page applies: one `.decklight` block,
 * in the contract's order (what `themegen.js` writes for a generated theme,
 * kept here because `tools/` ships and `src/` is the runtime's).
 */
function themeCss(title, tokens) {
  const label = String(title ?? '').replace(/\*\//g, '* /');
  const lines = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`);
  return `/* ${label} · a brand theme (SPEC BRAND_PALETTE): every colour a swatch of its palette */\n.decklight {\n${lines.join('\n')}\n}\n`;
}

/** Which of a failing pair the brand stated, so the message points at the choice to change. */
function blame(error, out) {
  const named = [...error.matchAll(/--([a-z0-9-]+)/g)].map((m) => `--${m[1]}`).filter((t) => out.stated.includes(t));
  return named.length ? ` (stated: ${named.map((t) => `${t} ${out.refs[t]}${out.viaRole[t] ? ` through the role ${out.viaRole[t]}` : ''}`).join(', ')})` : ' (chosen from the palette: no weight of it clears the gate — state this token, or widen the scale)';
}

/**
 * Every theme of a manifest, expanded. Returns `{ themes, problems, notes }`;
 * a theme with a problem is left out of `themes`.
 */
export function expandThemes(read, themes, prefix, roleSpec = {}) {
  const problems = [];
  const notes = [];
  const out = [];
  const seen = new Set();
  for (const [i, t] of (Array.isArray(themes) ? themes : []).entries()) {
    if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(t.name)) {
      problems.push({ rule: 'theme-name', msg: `themes[${i}].name ${JSON.stringify(t?.name)} — a theme's name is a lowercase word (letters, digits and -), e.g. "acme-dark"` });
      continue;
    }
    if (seen.has(t.name)) { problems.push({ rule: 'theme-name', msg: `themes: "${t.name}" is named twice` }); continue; }
    seen.add(t.name);
    if (t.mode !== 'dark' && t.mode !== 'light') { problems.push({ rule: 'theme-shape', msg: `themes: ${t.name} — "mode" is "dark" or "light"` }); continue; }
    if (t.title !== undefined && (typeof t.title !== 'string' || !t.title.trim())) { problems.push({ rule: 'theme-shape', msg: `themes: ${t.name} — "title" is the name a person reads` }); continue; }
    const e = expandTheme(read, t, prefix, roleSpec);
    problems.push(...e.problems);
    notes.push(...e.notes);
    if (!e.problems.length) out.push(e);
  }
  return { themes: out, problems, notes };
}

/**
 * Is every colour in a theme's tokens a palette colour? Returns the tokens
 * that are not (`[{ token, value, nearest }]`) — `recommended-off-palette`.
 */
export function offPaletteTokens(scales, tokens) {
  const out = [];
  for (const [k, v] of Object.entries(tokens ?? {})) {
    if (!COLOUR_TOKENS.has(`--${k}`) && !COLOUR_TOKENS.has(k)) continue;
    for (const hex of String(v).match(/#[0-9a-f]{3,8}\b/gi) ?? []) {
      const n = nearestSwatch(scales, hex.length > 7 ? hex.slice(0, 7) : hex);
      if (n && n.distance > ON_PALETTE_DISTANCE) { out.push({ token: k.startsWith('--') ? k : `--${k}`, value: hex, nearest: n.ref }); break; }
    }
  }
  return out;
}

// ── roles (SPEC DESIGN_SYSTEM_ROLES) ──────────────────────────────────────────

/** A colour written as a value: hex, or a colour function (color-mix is a recipe, not a colour). */
const LITERAL_COLOUR = /#[0-9a-f]{8}\b|#[0-9a-f]{6}\b|#[0-9a-f]{3,4}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/gi;
/** `var(--x)` or `var(--x, fallback)`, a fallback holding at most one level of parentheses. */
const VAR_REF = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,(?:[^()]|\([^()]*\))*)?\)/g;

/**
 * Every colour a CSS value names that is not one of the design system's roles:
 * `[{ kind: 'literal' | 'contract' | 'swatch', name, hex }]`. A role read with
 * a fallback (`var(--acme-color-text, #fff)`, what the Colors tab writes) is a
 * role; a swatch or contract token is reported by its name, never again by its
 * fallback's literal. Other custom properties (a component's own) are left be.
 * `hex` is the colour it stands for where that is known, for naming the
 * nearest role: `contractHex` maps a contract token to its value in a theme.
 */
export function offRoleColours(value, { prefix, scales, roles, contractHex = {} }) {
  const out = [];
  const seen = new Set();
  const add = (kind, name, hex) => { if (!seen.has(name)) { seen.add(name); out.push({ kind, name, hex: hex ?? null }); } };
  const roleNames = new Set(Object.keys(roles ?? {}).map((id) => roleToken(prefix, id)));
  const swatchRe = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([a-z][a-z0-9-]*)-(\\d{3,4})$`);
  const rest = String(value ?? '').replace(VAR_REF, (whole, token) => {
    if (roleNames.has(token)) return ' ';
    const sw = swatchRe.exec(token);
    if (sw && scales[sw[1]]?.weights[Number(sw[2])]) { add('swatch', token, scales[sw[1]].weights[Number(sw[2])]); return ' '; }
    if (COLOUR_TOKENS.has(token)) { add('contract', token, contractHex[token]); return ' '; }
    return whole;
  });
  for (const lit of rest.match(LITERAL_COLOUR) ?? []) {
    const c = parseColor(lit);
    add('literal', lit, c ? rgbToHex(c.slice(0, 3)) : null);
  }
  return out;
}

/** The role whose value (in one theme) is nearest `hex`, by OKLab; `roleValues` is `{ id: '#hex' | 'rgba(…)' }`. */
export function nearestRole(roleValues, hex) {
  if (!hex) return null;
  const c = parseColor(hex);
  if (!c) return null;
  const target = toOklab(c.slice(0, 3));
  let best = null;
  for (const [id, v] of Object.entries(roleValues ?? {})) {
    const rc = parseColor(v);
    if (!rc) continue;
    const d = labDistance(target, toOklab(rc.slice(0, 3)));
    if (!best || d < best.d) best = { id, d };
  }
  return best?.id ?? null;
}
