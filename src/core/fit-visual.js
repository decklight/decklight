// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A slide's main visual takes the room it is given (SPEC PRESENTING_FIT, #1183).
//
// A diagram or picture that is a template slot's only block is fitted by CSS
// alone (decklight.css: the slot has a height, so `max-height: 100%` reads).
// One inside the author's own wrapper cannot be: a plain `<div>` round an
// `<svg>` has no height of its own to take a share of, and making every such
// wrapper a flex box would move slides that fit today. So this measures, and
// only a slide that is clipped is touched: a two-line title above a wrapped
// 16:9 diagram, or a tall diagram alone in a split column, shrinks the
// diagram (keeping its aspect ratio) until nothing is cut.
//
// What counts as a main visual: a block of the slide that is an `<svg>`,
// `<img>` or `<picture>`, or a chain of wrappers down to one, each holding
// nothing else (no second element, no words). Something that shares its box
// with text is never resized: its room is the words' too, and the guardrail
// reports it as it would anything else that is cut.
//
// It runs from checkOverflow (engine.js), like data-fit code and a
// conversation, so it follows every change of the slide's shape and is done
// for every slide in print. It never waits on a frame: the headless renders
// `decklight check` and `pdf` read never paint one.

import { largestFitting, fitsNow, chainTo, FIT_MIN } from '../code/fit.js';
import { clipReport } from './overflow.js';

/** Not on the slide, or the engine's own (a logo, a run's steps): never a main visual, nor a wrapper's second child. */
const SKIP = 'aside, script, style, template, source, track, .slide-bg, .decklight-hero-logo, .decklight-steps';
/** Boxes an author wraps a picture in. A component that draws its own picture (a chart) is its own business. */
const WRAPPER = ':is(div, figure, p, a, span, center):not(.chart, .terminal, .conversation, [data-fit], [data-scroll-ok])';

/** The one element in `el`, or null when it holds another, or words beside it. */
function soleChild(el) {
  let one = null;
  for (const n of el.childNodes) {
    if (n.nodeType === 3) {
      if (n.textContent.trim()) return null;
      continue;
    }
    if (n.nodeType !== 1 || n.matches(SKIP)) continue;
    if (one) return null;
    one = n;
  }
  return one;
}

/** The `<svg>` or `<img>` at the end of `block`'s chain of single-child wrappers, or null. */
export function mainVisual(block) {
  let n = block;
  for (let depth = 0; n && depth < 8; depth++) {
    if (n.matches('svg, img')) return n;
    // a picture holds its sources beside the image: the image is what is sized
    if (n.matches('picture')) return n.querySelector(':scope > img');
    if (!n.matches(WRAPPER)) return null;
    n = soleChild(n);
  }
  return null;
}

/** A slide's blocks that compete for its room: in its flow and laid out. */
function blocks(section) {
  return [...section.children].filter((el) => {
    if (el.matches(SKIP) || el.hasAttribute('data-ds-injected')) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.position !== 'absolute' && cs.position !== 'fixed';
  });
}

/**
 * The first box above `v` that is a box: an inline wrapper (a `<picture>`, an
 * `<a>`, a `<span>`) is a line of text's height, not the picture's, so it is
 * the block holding it that must hold the picture.
 */
function boxOf(v, section) {
  let n = v.parentElement;
  while (n && n !== section && /^(inline|contents)$/.test(getComputedStyle(n).display)) n = n.parentElement;
  return n ?? section;
}

/**
 * What the author's own inline style said before this set a height, and what
 * this set: a release puts back only what is still this module's, so a style
 * written since (write mode's Picture > Fit, a resize) is never undone.
 */
const OWN = new WeakMap();

function release(v) {
  const own = OWN.get(v);
  if (!own) return;
  OWN.delete(v);
  if (v.style.maxHeight === own.setMaxHeight) v.style.maxHeight = own.maxHeight;
  if (own.setObjectFit && v.style.objectFit === own.setObjectFit) v.style.objectFit = own.objectFit;
  v.removeAttribute('data-fit-scale');
}

function hold(v, px, scale) {
  let own = OWN.get(v);
  if (!own) OWN.set(v, own = { maxHeight: v.style.maxHeight, objectFit: v.style.objectFit, setMaxHeight: '', setObjectFit: '' });
  v.style.maxHeight = `${Math.max(1, Math.floor(px))}px`;
  own.setMaxHeight = v.style.maxHeight;
  // an image keeps its shape inside a lower box (an svg keeps its own: preserveAspectRatio)
  if (v.matches('img') && !own.setObjectFit && getComputedStyle(v).objectFit === 'fill') {
    v.style.objectFit = 'contain';
    own.setObjectFit = v.style.objectFit;
  }
  v.setAttribute('data-fit-scale', scale.toFixed(3));
}

/**
 * Fit `section`'s main visuals into the room it gives them, when it is
 * clipped: the lowest alone first, then with the next one up sharing its
 * scale, and so on, at the largest scale at which nothing is cut. When even
 * the smallest does not save the slide, they are left at their own size and
 * the guardrail reports the slide as it is. A slide that is not laid out is
 * left alone.
 */
export function fitVisuals(section) {
  if (!section?.offsetWidth) return;
  const visuals = blocks(section).map(mainVisual).filter(Boolean);
  if (!visuals.length) return;
  section.classList.add('dl-fit-measure');
  try {
    // judged at their own size every time: the slide may have room again
    for (const v of visuals) release(v);
    // a picture being resized by hand in write mode is shown at the size the
    // hand gives it; the fit comes back when the drag ends
    if (section.closest('.dl-pic-resizing')) return;
    if (!clipReport(section)) return;
    const k = section.getBoundingClientRect().width / section.offsetWidth || 1;
    // lowest first: the picture running furthest down is the likeliest one cut,
    // and the others are only shrunk when shrinking it alone does not do
    const sized = visuals
      .map((v) => { const r = v.getBoundingClientRect(); return { v, natural: r.height / k, bottom: r.bottom }; })
      .filter((s) => s.natural > 0)   // an image still loading: its load re-runs the check
      .sort((a, b) => b.bottom - a.bottom);
    if (!sized.length) return;
    // Whole: every box from the picture up to the slide holds it, to the px
    // (fitsNow, as data-fit code is judged). Not cut is the guardrail's own
    // test, which lets two px go as rounding: the fallback when a box on the
    // way never comes to hold anything whole (a negative margin, say).
    const chains = sized.map((s) => chainTo(boxOf(s.v, section), section));
    const uncut = () => !clipReport(section);
    const whole = () => uncut() && chains.every((c) => fitsNow([], c));
    for (let m = 1; m <= sized.length; m++) {
      const some = sized.slice(0, m);
      const apply = (scale) => { for (const s of some) hold(s.v, s.natural * scale, scale); };
      for (const test of [whole, uncut]) {
        const scale = largestFitting((s) => { apply(s); return test(); }, { min: FIT_MIN, max: 1 });
        apply(scale);
        if (scale < 1 && test()) return;
      }
      for (const s of some) release(s.v);
    }
  } finally {
    section.classList.remove('dl-fit-measure');
  }
}
