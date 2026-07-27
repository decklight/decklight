// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The color math the two theme graders (contrast.mjs, palette-rules.mjs) each
// carried a copy of — and the copies had drifted: only one parsed hsl(), only
// one saw the `white`/`black` keywords, and only one resolved var() references
// (so a token written `--accent: var(--brand)` was graded by one grader and
// silently skipped by the other). This is the single, superset implementation.
//
// NOT imported by test/themegen.test.mjs on purpose: that file keeps an
// independent copy of the contrast math so the theme GENERATOR can't grade its
// own homework. The constraint is "not the same code as src/core/themegen.js",
// which sharing this test-only module does not violate — but it is left alone
// to avoid the churn, and its independence is by design.

const NAMED = { white: [255, 255, 255], black: [0, 0, 0] };

/** A CSS color literal → [r,g,b] (0–255), or null. Handles #hex (3/4/6/8),
 *  rgb()/rgba(), hsl()/hsla(), and the white/black keywords. */
export function parseColor(str) {
  str = str.trim();
  if (NAMED[str.toLowerCase()]) return NAMED[str.toLowerCase()];
  let m = str.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  m = str.match(/^rgba?\(([^)]*)\)$/i);
  if (m) return m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat).slice(0, 3);
  m = str.match(/^hsla?\(([^)]*)\)$/i);
  if (m) {
    const p = m[1].split(/[\s,\/]+/).filter(Boolean);
    const h = parseFloat(p[0]), s = parseFloat(p[1]) / 100, l = parseFloat(p[2]) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), mm = l - c / 2;
    const seg = Math.floor(h / 60) % 6;
    const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
    return rgb.map((v) => Math.round((v + mm) * 255));
  }
  return null;
}

/** Every color literal in a value — handles a gradient's every stop, and the
 *  white/black keywords (R6 forbids a pure one). */
export function colorsIn(value) {
  const out = [];
  const re = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|\b(?:white|black)\b/gi;
  for (const m of value.match(re) ?? []) {
    const c = parseColor(m);
    if (c) out.push(c);
  }
  return out;
}

/** WCAG relative luminance of an [r,g,b]. */
export function luminance([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio between two [r,g,b]. */
export function contrast(c1, c2) {
  const [l1, l2] = [luminance(c1), luminance(c2)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** [r,g,b] → { h(0–360), s(0–100), l(0–100), chroma(0–1) }. */
export function rgbToHsl([r, g, b]) {
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

/**
 * Parse a theme's CSS custom properties into { tokens, exceptions }. var()
 * references are resolved (depth-limited) so `--accent: var(--brand)` grades as
 * its target. `exceptions` maps a rule id (R2, …) to the reason a theme file
 * declared with `rule-exception:`.
 */
export function parseTheme(css) {
  const tokens = {};
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of noComments.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens[m[1].toLowerCase()] = m[2].trim();
  }
  const resolve = (v, depth = 0) => {
    if (depth > 5) return v;
    return v.replace(/var\(--([a-z0-9-]+)\)/gi, (_, name) =>
      tokens[name.toLowerCase()] !== undefined ? resolve(tokens[name.toLowerCase()], depth + 1) : _);
  };
  for (const k of Object.keys(tokens)) tokens[k] = resolve(tokens[k]);
  const exceptions = {};
  for (const m of css.matchAll(/rule-exception:\s*(R\d)\s+([^\n*]+)/g)) {
    exceptions[m[1]] = m[2].trim();
  }
  return { tokens, exceptions };
}
