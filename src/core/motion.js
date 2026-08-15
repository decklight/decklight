// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The decisions behind SPEC MOTION — SLIDE_TRANSITIONS and AUTO_ANIMATE — as
// pure functions, so they can be checked without a browser.
//
// Everything else in those two features is measurement and paint, which only a
// real engine can testify to (test/render.mjs, test/cross-engine.mjs). What is
// left here is small and it is exactly where the mistakes have been: a duration
// read out of CSS, a transform derived from two rectangles, a list of class
// names. None of that needs a DOM, and none of it was reachable by a test until
// it was lifted out of the functions that use it.

/**
 * A CSS time value in milliseconds — `350ms`, `0.35s`, or a bare number.
 *
 * THE UNIT IS NOT OPTIONAL TO READ. `parseFloat('350ms') * 1000` is 350
 * SECONDS, and both features shipped that bug: auto-animate fixed it in place
 * (a 500ms move became a 500-second crawl) and slide transitions kept it, so
 * every `entering`/`leaving` class sat on a section for five minutes and
 * fifty seconds instead of clearing at 410ms. The classes are how a slide
 * knows it is mid-move, so the deck spent a whole talk believing it was.
 *
 * A bare number is milliseconds, which is what the old code did with one and
 * therefore what any deck relying on it already means. Anything unreadable —
 * empty, `inherit`, a negative — is the caller's fallback rather than a guess:
 * a transition of 0ms is a transition nobody sees, and `NaN` would be worse.
 */
export function cssDurationMs(raw, fallback) {
  const text = String(raw ?? '').trim();
  const n = parseFloat(text);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  // `ms` before `s`, or every `ms` value is read as seconds and multiplied.
  if (text.endsWith('ms')) return n;
  if (text.endsWith('s')) return n * 1000;
  return n;
}

/** The visual properties auto-animate interpolates, in camelCase for `el.style`. */
export const VISUAL_PROPS = ['opacity', 'color', 'backgroundColor', 'borderRadius', 'fontSize'];

/**
 * The `transition` shorthand auto-animate sets, DERIVED from VISUAL_PROPS.
 *
 * Derived rather than hand-written so a property added to the list above cannot
 * silently fail to animate because somebody forgot to edit a string.
 */
export const transitionProps = (props = VISUAL_PROPS) => ['transform',
  ...props.map((p) => p.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`))];

/**
 * The FLIP transform that puts an element back where it came from.
 *
 * `factor` converts screen pixels to the element's own units — the stage scale
 * for HTML, the CTM for anything inside an SVG viewBox. Dividing by it is what
 * keeps a move correct on a stage that is not at 1:1, which is every stage that
 * has been resized.
 *
 * `textOnly` suppresses the SCALE, and that is a deliberate difference rather
 * than an optimisation: a heading whose font-size changes should re-typeset at
 * the new size and animate its font-size, not be stretched like a bitmap.
 */
export function flipTransform(from, to, factor, textOnly = false) {
  const fx = factor?.x || 1;
  const fy = factor?.y || 1;
  const dx = (from.rect.left - to.rect.left) / fx;
  const dy = (from.rect.top - to.rect.top) / fy;
  // A zero-sized destination would make the ratio Infinity or NaN, and a
  // singular matrix is not a move — it is an element that vanishes.
  const sx = textOnly || !to.rect.width ? 1 : from.rect.width / to.rect.width;
  const sy = textOnly || !to.rect.height ? 1 : from.rect.height / to.rect.height;
  return { dx, dy, sx, sy };
}

/** The transform string for a FLIP, or '' when nothing moved or resized. */
export function flipCss({ dx, dy, sx, sy }) {
  if (!dx && !dy && sx === 1 && sy === 1) return '';
  return `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
}

/** Which transition a slide gets: its own `data-transition`, else the deck's. */
export const transitionName = (attr, configured) => (attr || configured || 'fade');

/**
 * The classes a transition puts on the two sections, and takes back off.
 *
 * `none` returns null — the caller does nothing at all rather than adding
 * classes for a transition that has no animation to run and then scheduling a
 * timer to remove them.
 */
export function transitionClasses(name, direction) {
  if (name === 'none') return null;
  const dir = `dir-${direction}`;
  return {
    entering: ['entering', `tr-${name}`, dir],
    leaving: ['leaving', `tr-${name}`, dir, 'active-out'],
  };
}
