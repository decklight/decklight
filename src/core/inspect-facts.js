// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The facts the inspector shows (`I`, PRESENTING), apart from the panel.
 *
 * The arithmetic is here, away from the DOM, so it can be a unit test: a
 * contrast ratio that is wrong in the third decimal says "passes" about text
 * that does not, and nobody looks twice at a number in a panel. What has to
 * touch the page (computed styles, rectangles) takes its inputs as arguments
 * or reads them through one narrow helper each.
 */

/** `[r, g, b, a]` (0–255, alpha 0–1) from `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`; null otherwise. */
export function parseColor(str) {
  const s = String(str ?? '').trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (m) {
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [+m[1], +m[2], +m[3], a];
  }
  if (s === 'transparent') return [0, 0, 0, 0];
  return null;
}

/** `fg` (with its alpha) laid over an opaque `bg`. */
export function blend(fg, bg) {
  const a = fg[3] ?? 1;
  return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a))).concat(1);
}

/** WCAG relative luminance of an sRGB colour. */
export function luminance([r, g, b]) {
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1–21. `fg` may be translucent; `bg` must be opaque. */
export function contrastRatio(fg, bg) {
  const a = luminance(blend(fg, bg)), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** WCAG "large text": 24px, or 18.66px (14pt) bold. Large text needs 3:1, the rest 4.5:1. */
export function isLargeText(px, weight) {
  return px >= 24 || (px >= 18.66 && Number(weight) >= 700);
}

/** The AA floor for text of this size and weight. */
export const aaFloor = (px, weight) => (isLargeText(px, weight) ? 3 : 4.5);

/** `#rrggbb` for an opaque colour, the way an author writes one. */
export function hex([r, g, b]) {
  return '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

/**
 * The theme token whose value is this colour, or null: `--fg` reads better
 * than `#e8e6e3`, and says the colour follows the theme rather than being
 * pinned to one. `tokens` is `[[name, value], …]`; the first match wins, so a
 * caller lists the names people know first.
 */
export function tokenFor(color, tokens) {
  const want = parseColor(color);
  if (!want || want[3] === 0) return null;
  for (const [name, value] of tokens) {
    const c = parseColor(value);
    if (c && c[0] === want[0] && c[1] === want[1] && c[2] === want[2] && Math.abs(c[3] - want[3]) < 0.01) return name;
  }
  return null;
}

/**
 * A rectangle on screen, in the deck's own units: the stage is drawn scaled,
 * so `x 120 · 860×410` has to undo that scale to mean the same thing at every
 * window size. Rounded, because a sub-pixel is noise in a panel.
 */
export function stageBox(rect, stageRect, scale) {
  const s = scale || 1;
  return {
    x: Math.round((rect.left - stageRect.left) / s),
    y: Math.round((rect.top - stageRect.top) / s),
    w: Math.round(rect.width / s),
    h: Math.round(rect.height / s),
  };
}

/** A box's share of the slide, as a whole percent. */
export const shareOf = (box, stageW, stageH) =>
  Math.round((100 * Math.max(0, box.w) * Math.max(0, box.h)) / Math.max(1, stageW * stageH));

/** `Inter 40/1.3 · 600` from a computed style: the family the author named first, size/line-height, weight. */
export function fontLine(cs) {
  const family = String(cs.fontFamily ?? '').split(',')[0].replace(/["']/g, '').trim() || 'inherit';
  const px = parseFloat(cs.fontSize) || 0;
  const lh = parseFloat(cs.lineHeight);
  const ratio = Number.isFinite(lh) && px ? `/${+(lh / px).toFixed(2)}` : '';
  return `${family} ${+px.toFixed(1)}${ratio} · ${cs.fontWeight}`;
}

/** `1:30` — the presenter's clock. */
export function clock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The first colour stop of a CSS gradient (`linear-gradient(rgb(…) …)`), or null. */
export function firstStop(image) {
  const m = String(image ?? '').match(/(rgba?\([^)]*\)|#[0-9a-f]{3,8}\b)/i);
  return m ? parseColor(m[1]) : null;
}

/**
 * The opaque colour behind `node`, composited up the tree until something is
 * opaque, or `fallback` (the theme's canvas) when nothing is. A gradient with
 * no colour under it stands in by its first stop, the way the engine reads
 * the canvas (themes.js updateCanvas), and sets `seen.image`: a ratio
 * against an image or a gradient is an estimate, and the panel says so.
 * `styleOf` is getComputedStyle, passed in so the walk can be tested with
 * plain objects.
 */
export function effectiveBackground(node, { styleOf, stop, fallback = [255, 255, 255, 1], seen = {} }) {
  const layers = [];
  for (let n = node; n && n.nodeType === 1; n = n.parentElement) {
    const cs = styleOf(n);
    let c = parseColor(cs.backgroundColor);
    const image = cs.backgroundImage && cs.backgroundImage !== 'none' ? cs.backgroundImage : null;
    if (image) seen.image = true;
    if ((!c || c[3] === 0) && image) {
      const s = firstStop(image);
      if (s) c = [s[0], s[1], s[2], 1];
    }
    if (c && c[3] > 0) {
      layers.push(c);
      if (c[3] >= 1) break;
    }
    if (n === stop) break;
  }
  let bg = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop() : fallback;
  while (layers.length) bg = blend(layers.pop(), bg);
  return bg;
}
