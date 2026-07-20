// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Theme generator — SPEC §5/§8. Pure module (no DOM): generates a complete,
// contract-satisfying token set with WCAG-gated color engineering. Every
// token is derived with luminance math and iterated until it passes the same
// gates test/contrast.mjs enforces on shipped themes — generation must never
// emit a failing theme.
//
//   generateTheme(seed?) → { name, seed, tokens: { '--bg': …, … } }
//   tokensToCss(name, tokens) → theme-file-shaped CSS text

// ── seeded PRNG (mulberry32: tiny, deterministic) ───────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── color math (same WCAG formulas as test/contrast.mjs) ────────────────────
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  return rgb.map((v) => Math.round((v + m) * 255));
}

function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function luminance([r, g, b]) {
  const lin = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(c1, c2) {
  const [l1, l2] = [luminance(c1), luminance(c2)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

const minContrastVs = (rgb, stops) => Math.min(...stops.map((s) => contrast(rgb, s)));

/**
 * The workhorse: take a hue/sat wish and walk lightness away from the
 * background until the color clears `min` against EVERY bg stop. Desaturates
 * and retries if lightness alone can't get there; the final fallback is a
 * near-neutral at the extreme, which always clears the contract's ratios
 * against the near-extreme canvases this generator produces.
 */
function fitContrast(h, s, startL, stops, min) {
  const bgLum = stops.reduce((a, c) => a + luminance(c), 0) / stops.length;
  const preferred = bgLum < 0.5 ? 1 : -1; // lighten on dark canvases, darken on light
  const sats = [];
  for (let sat = s; sat > 0; sat -= 15) sats.push(sat);
  sats.push(0);
  for (const dir of [preferred, -preferred]) {
    for (const sat of sats) {
      // L clamped off the poles: L 0/100 is pure black/white whatever the
      // saturation, and neutrals must keep their tint (R6)
      for (let l = startL; l >= 2 && l <= 98; l += dir) {
        const rgb = hslToRgb(h, sat, l);
        if (minContrastVs(rgb, stops) >= min) return rgb;
      }
    }
  }
  // absolute fallback: whichever pole clears the bar better (mid-luminance
  // backgrounds can only be beaten by one of the extremes). Near-poles, not
  // pure #fff/#000 (R6) — but close enough to still clear the gates.
  const white = [253, 253, 254], black = [8, 9, 10];
  return minContrastVs(white, stops) >= minContrastVs(black, stops) ? white : black;
}

// ── personality tables ───────────────────────────────────────────────────────
const ADJECTIVES = [
  'amber', 'boreal', 'cinder', 'coral', 'drift', 'ember', 'fable', 'fjord',
  'gale', 'harbor', 'iris', 'juniper', 'kelp', 'lumen', 'mesa', 'nectar',
  'onyx', 'pluma', 'quartz', 'reef', 'sable', 'tundra', 'umbra', 'verdant',
  'wisp', 'yonder', 'zephyr',
];

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const SANS_ROUNDED = 'ui-rounded, "SF Pro Rounded", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
const MONO = '"SF Mono", SFMono-Regular, ui-monospace, "Cascadia Code", Menlo, Consolas, monospace';

const HEADING_FONTS = [SANS, SANS, SANS_ROUNDED, SERIF]; // serif ~1 in 4
const HEADING_WEIGHTS = [600, 650, 700, 750, 800];
const RADII = ['4px', '6px', '8px', '10px', '12px', '14px', '18px'];

// harmony schemes: offsets (degrees) from the base hue; [accent, spread…]
const HARMONIES = {
  analogous: [30, -30, 60, 15, -15],
  complementary: [180, 150, 210, 30, -30],
  split: [150, 210, 30, 180, -30],
  triadic: [120, 240, 60, 180, 300],
};

// ── codified palette rules ───────────────────────────────────────────────────
// Distilled from the most-loved editor/UI themes (Solarized, Nord, Catppuccin,
// Gruvbox) and classic UI color doctrine (the 60-30-10 rule). Each rule is
// tagged R1–R8 where the generator applies it and property-tested across
// seeds in test/themegen.test.mjs.
//   R1 limited palette — one base hue + the harmony's ≤5 accent hues, REUSED
//      across roles (syntax, links, diagram fills); never a fresh hue per
//      token. (Solarized: 8 fixed accents; Nord: 16 colors total.)
//   R2 quiet dominant areas — the canvas (the 60% of 60-30-10) stays
//      near-neutral; chroma belongs to small accents, not large surfaces.
//   R3 dimmed pastels — accents are muted, never neon: vivid rolls are biased
//      toward muted and saturation is hard-capped. (Nord "dimmed pastels",
//      Catppuccin "not too dull, not too bright".)
//   R4 one accent lightness band — all accent-family colors start from a
//      shared lightness AND saturation, so no color shouts louder than its
//      peers. (Solarized's accents share near-equal CIELAB L*.)
//   R5 selective contrast — syntax roles differ by HUE at similar brightness,
//      not by brightness spikes (Solarized's core idea); R4 is what makes
//      this hold in practice.
//   R6 no pure black or white — every "neutral" carries the base-hue tint
//      (Solarized base03 and Nord Polar Night are tinted, never #000/#fff).
//   R7 gradients sparingly — rare, low-drift, same-family canvas washes only.
//   R8 semantic anchors — terminal red/green/yellow keep their recognizable
//      hue even when muted (Nord Aurora's error/warning/success colors).
const RULES = {
  bgSatMax: { dark: 18, light: 12 }, // R2/R6 (HSL sat; extreme L damps chroma further)
  accentSat: [42, 68],               // R3
  hlSat: [36, 58],                   // R3/R4/R5
  ansiSat: [46, 66],                 // R3/R8
  gradientChance: 0.15,              // R7
  gradientHueDrift: [8, 20],         // R7
};

// ── generator ────────────────────────────────────────────────────────────────
export function generateTheme(seed) {
  seed = (seed ?? Math.floor(Math.random() * 0xffffffff)) >>> 0;
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const range = (lo, hi) => lo + rnd() * (hi - lo);

  const dark = rnd() < 0.5;
  const baseHue = Math.floor(rnd() * 360);
  const harmonyName = pick(Object.keys(HARMONIES));
  const H = HARMONIES[harmonyName];
  const accentHue = baseHue + H[0];
  const vivid = rnd() * rnd();               // 0 muted … 1 vivid — R3: biased muted (mean ≈ ⅓)
  const chroma = (lo, hi) => lo + vivid * (hi - lo);

  // ── canvas ──
  const bgSat = chroma(5, RULES.bgSatMax[dark ? 'dark' : 'light']); // R2 quiet canvas, R6 tinted (floor 5, never grey)
  const bgL = dark ? range(6, 13) : range(94, 97.5);
  const bg1 = hslToRgb(baseHue, bgSat, bgL);
  let bgValue = rgbToHex(bg1);
  let bgStops = [bg1];
  if (rnd() < RULES.gradientChance) { // R7: rare, subtle, same-family wash (validate every stop)
    const bg2 = hslToRgb(baseHue + range(...RULES.gradientHueDrift), bgSat + range(0, 8), bgL + (dark ? range(2.5, 5) : -range(2, 4)));
    const angle = Math.round(range(120, 210));
    bgValue = `linear-gradient(${angle}deg, ${rgbToHex(bg1)} 0%, ${rgbToHex(bg2)} 100%)`;
    bgStops = [bg1, bg2];
  }
  const surface = hslToRgb(baseHue, Math.min(bgSat + 4, 35), dark ? bgL + 4 : bgL - 4);

  // ── ink ──
  const fg = fitContrast(baseHue, 12, dark ? 86 : 18, bgStops, 4.6);
  const muted = fitContrast(baseHue, 10, dark ? 64 : 44, bgStops, 3.1);
  const headingTinted = rnd() < 0.5;
  const heading = headingTinted
    ? fitContrast(accentHue, chroma(20, 55), dark ? 80 : 26, bgStops, 3.2)
    : fitContrast(baseHue, 8, dark ? 92 : 12, bgStops, 4.6);

  // ── accent ──
  const accentSat = chroma(...RULES.accentSat); // R3: pastel ceiling, never neon
  let accentL = dark ? range(55, 68) : range(34, 48);
  let accent = hslToRgb(accentHue, accentSat, accentL);
  // The accent hosts --accent-contrast text: nudge it out of the mid-luminance
  // dead zone where neither near-pole (R6 forbids pure #fff/#000) can reach
  // 4.6:1 on top of it. Mode-consistent direction: dark themes brighten the
  // accent (dark label on bright chip), light themes deepen it (light label).
  while (Math.max(minContrastVs([253, 253, 254], [accent]), minContrastVs([8, 9, 10], [accent])) < 4.7) {
    accentL += dark ? 1 : -1;
    accent = hslToRgb(accentHue, accentSat, accentL);
  }
  const accentContrast = fitContrast(accentHue, 18, luminance(accent) < 0.4 ? 96 : 10, [accent], 4.6);
  // R1: the link reuses a palette hue (accent or second harmony hue) — no fresh hue
  const link = fitContrast(rnd() < 0.5 ? accentHue : baseHue + (H[1] ?? 30), chroma(35, 60), dark ? 70 : 34, bgStops, 3.2);

  // ── blocks ──
  const blockBg = rgbToHex(surface);
  const blockBorder = `1px solid ${rgbToHex(hslToRgb(baseHue, Math.min(bgSat + 6, 40), dark ? bgL + 10 : bgL - 10))}`;
  const radius = pick(RADII);
  const shadow = dark
    ? `0 ${Math.round(range(4, 10))}px ${Math.round(range(18, 30))}px rgba(0, 0, 0, 0.${Math.round(range(35, 55))})`
    : `0 ${Math.round(range(3, 6))}px ${Math.round(range(12, 20))}px rgba(30, 30, 40, 0.${String(Math.round(range(8, 14))).padStart(2, '0')})`;

  // ── code panel ──
  const codeBgRgb = hslToRgb(baseHue, Math.min(bgSat + 2, 28), dark ? Math.max(bgL - 3, 3) : Math.min(bgL - 3, 93));
  const codeStops = [codeBgRgb];
  const codeFg = fitContrast(baseHue, 8, dark ? 85 : 20, codeStops, 4.6);
  // R1: syntax hues come from the harmony palette only. R4/R5: one shared
  // saturation and starting lightness — roles differ by hue, not loudness.
  const hlHueOffsets = { keyword: H[0], string: H[3] ?? 120, number: H[2] ?? 60, function: H[1] ?? 210, type: H[4] ?? 280 };
  const hlSat = chroma(...RULES.hlSat);
  const hlL = dark ? 68 : 36;
  const hl = {};
  for (const [tok, off] of Object.entries(hlHueOffsets)) {
    hl[tok] = fitContrast(baseHue + off, hlSat, hlL, codeStops, 4.6);
  }
  hl.comment = fitContrast(baseHue, 12, dark ? 60 : 46, codeStops, 3.2);
  hl.punct = fitContrast(baseHue, 10, dark ? 74 : 32, codeStops, 4.6);

  // ── diagram ── (R1: fills reuse the harmony hues; R2: low chroma — fills
  // are large areas, so they stay near the canvas, not the accents. Ink must
  // clear BOTH the canvas and every panel: labels sit on the fills.)
  const fillHues = [0, H[0], H[1] ?? 40, H[2] ?? 90, (H[3] ?? 160), (H[4] ?? 230)];
  const dFillsRgb = fillHues.map((off, i) =>
    hslToRgb(baseHue + off, chroma(14, 34), dark ? bgL + 8 + (i % 3) * 2 : bgL - 6 - (i % 3) * 2));
  const dInkStops = [...bgStops, ...dFillsRgb];
  const dStroke = fitContrast(baseHue, 14, dark ? 60 : 42, bgStops, 2.2);
  const dText = fitContrast(baseHue, 10, dark ? 84 : 20, dInkStops, 3.4);
  const dMuted = fitContrast(baseHue, 10, dark ? 62 : 46, dInkStops, 2.7);
  const dAccent = fitContrast(accentHue, accentSat, dark ? 68 : 38, dInkStops, 2.7);
  const dFills = dFillsRgb.map(rgbToHex);

  // ── terminal (dark panel in every theme, matching the shipped set) ──
  const termBgRgb = hslToRgb(baseHue, Math.min(bgSat + 4, 30), dark ? Math.max(bgL - 4, 3) : range(12, 18));
  const termStops = [termBgRgb];
  const termFg = fitContrast(baseHue, 8, 82, termStops, 4.6);
  const termPrompt = fitContrast(accentHue, chroma(...RULES.ansiSat), 66, termStops, 3.2);
  // R8: ANSI colors anchor to their semantic hue (red reads red, green reads
  // green) with only a small base-hue lean; R3/R4: one muted band for all.
  const ansiAnchor = { red: 8, green: 125, yellow: 45, blue: 215, magenta: 290, cyan: 175 };
  const ansi = { black: fitContrast(baseHue, 10, 58, termStops, 3.1), white: fitContrast(baseHue, 6, 88, termStops, 4.6) };
  for (const [nameA, hue] of Object.entries(ansiAnchor)) {
    ansi[nameA] = fitContrast(hue + (baseHue % 16) - 8, chroma(...RULES.ansiSat), 66, termStops, 3.1);
  }
  const bright = (rgb) => {
    // lift toward white, then re-fit to be safe
    const [r, g, b] = rgb.map((v) => Math.min(255, Math.round(v + (255 - v) * 0.35)));
    return minContrastVs([r, g, b], termStops) >= 3.0 ? [r, g, b] : fitContrast(baseHue, 8, 90, termStops, 3.1);
  };

  // ── assemble ──
  const name = `gen-${pick(ADJECTIVES)}-${(seed % 0xffff).toString(16).padStart(4, '0')}`;
  const hx = rgbToHex;
  const tokens = {
    '--bg': bgValue,
    '--bg-accent': rgbToHex(surface),
    '--fg': hx(fg),
    '--muted': hx(muted),
    '--font-body': SANS,
    '--font-heading': pick(HEADING_FONTS),
    '--font-mono': MONO,
    '--heading-color': hx(heading),
    '--heading-weight': String(pick(HEADING_WEIGHTS)),
    '--link': hx(link),
    '--accent': hx(accent),
    '--accent-contrast': hx(accentContrast),
    '--block-bg': blockBg,
    '--block-border': blockBorder,
    '--block-radius': radius,
    '--shadow': shadow,
    '--code-bg': hx(codeBgRgb),
    '--code-fg': hx(codeFg),
    '--hl-keyword': hx(hl.keyword),
    '--hl-string': hx(hl.string),
    '--hl-number': hx(hl.number),
    '--hl-comment': hx(hl.comment),
    '--hl-function': hx(hl.function),
    '--hl-type': hx(hl.type),
    '--hl-punct': hx(hl.punct),
    '--d-stroke': hx(dStroke),
    '--d-text': hx(dText),
    '--d-muted': hx(dMuted),
    '--d-accent': hx(dAccent),
    '--d-fill-1': dFills[0],
    '--d-fill-2': dFills[1],
    '--d-fill-3': dFills[2],
    '--d-fill-4': dFills[3],
    '--d-fill-5': dFills[4],
    '--d-fill-6': dFills[5],
    '--term-bg': hx(termBgRgb),
    '--term-fg': hx(termFg),
    '--term-prompt': hx(termPrompt),
    '--term-cursor': hx(termPrompt),
    '--term-selection': `rgba(${accent[0]}, ${accent[1]}, ${accent[2]}, 0.30)`,
    '--ansi-black': hx(ansi.black),
    '--ansi-red': hx(ansi.red),
    '--ansi-green': hx(ansi.green),
    '--ansi-yellow': hx(ansi.yellow),
    '--ansi-blue': hx(ansi.blue),
    '--ansi-magenta': hx(ansi.magenta),
    '--ansi-cyan': hx(ansi.cyan),
    '--ansi-white': hx(ansi.white),
    '--ansi-bright-black': hx(bright(ansi.black)),
    '--ansi-bright-red': hx(bright(ansi.red)),
    '--ansi-bright-green': hx(bright(ansi.green)),
    '--ansi-bright-yellow': hx(bright(ansi.yellow)),
    '--ansi-bright-blue': hx(bright(ansi.blue)),
    '--ansi-bright-magenta': hx(bright(ansi.magenta)),
    '--ansi-bright-cyan': hx(bright(ansi.cyan)),
    '--ansi-bright-white': hx(fitContrast(baseHue, 6, 97, termStops, 3.1)), // R6: tinted, not #fff
    '--dim-opacity': (0.25 + Math.round(rnd() * 15) / 100).toFixed(2),
  };

  return { name, seed, dark, harmony: harmonyName, tokens };
}

// ── serializer: theme-file-shaped CSS ────────────────────────────────────────
const SECTIONS = [
  ['canvas', ['--bg', '--bg-accent', '--fg', '--muted']],
  ['type', ['--font-body', '--font-heading', '--font-mono', '--heading-color', '--heading-weight', '--link']],
  ['accent', ['--accent', '--accent-contrast']],
  ['blocks', ['--block-bg', '--block-border', '--block-radius', '--shadow']],
  ['code', ['--code-bg', '--code-fg', '--hl-keyword', '--hl-string', '--hl-number', '--hl-comment', '--hl-function', '--hl-type', '--hl-punct']],
  ['diagram', ['--d-stroke', '--d-text', '--d-muted', '--d-accent', '--d-fill-1', '--d-fill-2', '--d-fill-3', '--d-fill-4', '--d-fill-5', '--d-fill-6']],
  ['terminal', ['--term-bg', '--term-fg', '--term-prompt', '--term-cursor', '--term-selection',
    '--ansi-black', '--ansi-red', '--ansi-green', '--ansi-yellow', '--ansi-blue', '--ansi-magenta', '--ansi-cyan', '--ansi-white',
    '--ansi-bright-black', '--ansi-bright-red', '--ansi-bright-green', '--ansi-bright-yellow',
    '--ansi-bright-blue', '--ansi-bright-magenta', '--ansi-bright-cyan', '--ansi-bright-white']],
  ['builds', ['--dim-opacity']],
];

export function tokensToCss(name, tokens) {
  let out = `/* ═══════════════════════════════════════════════════════════════
   Decklight theme · ${name}
   generated by Decklight (⌃T) — token contract: SPEC.md §5
   All values derived with WCAG luminance math; passes test/contrast.mjs
   ═══════════════════════════════════════════════════════════════ */

.decklight {
`;
  for (const [section, keys] of SECTIONS) {
    const present = keys.filter((k) => tokens[k] !== undefined);
    if (!present.length) continue;
    out += `  /* ── ${section} ${'─'.repeat(Math.max(1, 26 - section.length))} */\n`;
    for (const k of present) out += `  ${k}: ${tokens[k]};\n`;
    out += '\n';
  }
  // any tokens outside the known sections (future-proofing)
  const known = new Set(SECTIONS.flatMap(([, ks]) => ks));
  for (const [k, v] of Object.entries(tokens)) {
    if (!known.has(k)) out += `  ${k}: ${v};\n`;
  }
  return out.replace(/\n$/, '') + '}\n';
}
