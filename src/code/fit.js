// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Code that fits its space — SPEC CODE_AND_MATH, `data-fit` (#958).
//
// `data-fit` on a `<pre>`, or on an element holding several, sizes the code to
// the room its slide gives it: as large as fits, never larger than the size the
// block has with no `font-size` of its own. Every block under one fit host
// shares one size.
//
// IT MEASURES, IT NEVER ASKS THE GUARDRAIL. A design-system slot can set
// `overflow: hidden`, and a slot that centres its content overflows past its
// TOP as well as its bottom — neither shows up as a scrollHeight. So the test
// is geometry: every in-flow box, from the host up to the section, inside its
// parent's content box, and no block scrolling inside itself.
//
// It runs from checkOverflow (engine.js), so it is redone whenever the
// guardrail's watch hears the slide change shape (a theme, a webfont, a
// resize, an edit) and for every slide in print, which is what `decklight pdf`
// and `video` read. The slide is measured as it stands: pending builds keep
// their space (they are only invisible), and their entrance transforms are
// switched off for the measurement, so a later build never arrives into room
// the code already took.

/** The smallest a fitted block goes, as a share of its own size. */
export const FIT_MIN = 0.3;

/**
 * The largest scale in [min, max] for which `fits(scale)` holds, by bisection.
 *
 * `max` is tried first: short code fits at its own size, and that is the
 * common case, so it costs one measurement. When even `min` does not fit,
 * `min` is the answer — the overflow guardrail then flags the slide, as it
 * would any other that cannot hold its content. Pure, for the unit test.
 */
export function largestFitting(fits, { min = FIT_MIN, max = 1, rounds = 8 } = {}) {
  if (fits(max)) return max;
  let lo = min, hi = max;
  if (!fits(lo)) return min;
  for (let i = 0; i < rounds; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const SKIP = 'aside, script, style, template, .slide-bg';
const TOL = 1;   // CSS px: subpixel layout is not overflow

/** In flow and laid out: the boxes that compete for the container's room. */
function competes(el) {
  if (el.matches(SKIP)) return false;
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed';
}

/** `el`'s content box in viewport px, with the stage's scale applied to its padding. */
function contentBox(el) {
  const r = el.getBoundingClientRect();
  const k = el.offsetWidth ? r.width / el.offsetWidth : 1;
  const cs = getComputedStyle(el);
  const pad = (side) => (parseFloat(cs[`padding${side}`]) || 0) * k;
  return {
    top: r.top + pad('Top'), bottom: r.bottom - pad('Bottom'),
    left: r.left + pad('Left'), right: r.right - pad('Right'), k,
  };
}

/** Does the code, at its current size, sit inside every box between it and the slide? */
function fitsNow(pres, chain) {
  for (const pre of pres) {
    if (pre.scrollWidth > pre.clientWidth + TOL || pre.scrollHeight > pre.clientHeight + TOL) return false;
  }
  for (let i = 0; i < chain.length; i++) {
    const box = contentBox(chain[i]);
    const tol = TOL * box.k;
    const branch = chain[i - 1];
    for (const child of chain[i].children) {
      if (!competes(child)) continue;
      const r = child.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      // Vertically, every box competes: the code growing pushes its siblings.
      if (r.top < box.top - tol || r.bottom > box.bottom + tol) return false;
      // Across, only the path to the code can be pushed out by it.
      if ((child === branch || pres.includes(child))
        && (r.left < box.left - tol || r.right > box.right + tol)) return false;
    }
    const cs = getComputedStyle(chain[i]);
    if (cs.overflowY !== 'visible' && chain[i].scrollHeight > chain[i].clientHeight + TOL) return false;
  }
  return true;
}

/** One fit host: its blocks share the largest size that fits. */
function fitHost(host, section) {
  const pres = host.matches('pre') ? [host] : [...host.querySelectorAll('pre')];
  if (!pres.length) return;
  const container = host.matches('pre') ? host.parentElement : host;
  const chain = [];
  for (let n = container; n; n = n.parentElement) {
    chain.push(n);
    if (n === section) break;
  }
  // The cap: each block's size with no font-size of its own — the author's
  // hand-set size is exactly what data-fit replaces.
  for (const pre of pres) pre.style.removeProperty('font-size');
  const parentPx = pres.map((pre) => parseFloat(getComputedStyle(pre.parentElement).fontSize) || 16);
  const basePx = Math.min(...pres.map((pre) => parseFloat(getComputedStyle(pre).fontSize) || 16));
  const apply = (scale) => pres.forEach((pre, i) => {
    pre.style.setProperty('font-size', `${(basePx * scale / parentPx[i]).toFixed(4)}em`);
  });
  const scale = largestFitting((s) => { apply(s); return fitsNow(pres, chain); });
  if (scale >= 1) for (const pre of pres) pre.style.removeProperty('font-size');
  else apply(scale);
  host.setAttribute('data-fit-scale', scale >= 1 ? '1' : scale.toFixed(3));
}

/**
 * Size every `data-fit` host on `section`. A section that is not laid out
 * (an inactive slide, display:none) has nothing to measure, and is left alone.
 */
export function fitCode(section) {
  if (!section?.offsetWidth) return;
  const hosts = [...section.querySelectorAll('[data-fit]')]
    // a host inside another host is the outer one's business: one size for all
    .filter((h) => !h.parentElement?.closest('[data-fit]'));
  if (!hosts.length) return;
  section.classList.add('dl-fit-measure');
  try {
    for (const host of hosts) fitHost(host, section);
  } finally {
    section.classList.remove('dl-fit-measure');
  }
}
