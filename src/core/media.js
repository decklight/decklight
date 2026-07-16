// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Background media (SPEC §1): a slide carries a full-bleed background image
// or a muted looping background video as data-background-* attributes on its
// <section>. The engine injects an idempotent .slide-bg layer as the
// section's first child — absolutely positioned below the content, so it
// stays out of the overflow guardrail's scroll math and transitions /
// auto-animate carry it for free. parseBackground is pure (node-testable,
// the computeGroups idiom); setupMedia is the DOM pass sync() runs.

const ATTRS = [
  'data-background-image', 'data-background-video', 'data-background-poster',
  'data-background-size', 'data-background-position', 'data-background-dim',
];

/**
 * Parse a slide's data-background-* attributes into a descriptor.
 * `attrs` is a plain { 'data-background-image': '…', … } object — no DOM.
 * Returns null when the slide has no background media. size falls back to
 * 'cover' for anything but 'contain'; dim clamps to [0, 1].
 */
export function parseBackground(attrs) {
  const image = attrs['data-background-image'] || null;
  const video = attrs['data-background-video'] || null;
  if (!image && !video) return null;
  const dim = parseFloat(attrs['data-background-dim']);
  return {
    image,
    video,
    poster: attrs['data-background-poster'] || null,
    size: attrs['data-background-size'] === 'contain' ? 'contain' : 'cover',
    position: attrs['data-background-position'] || 'center',
    dim: Number.isFinite(dim) ? Math.min(Math.max(dim, 0), 1) : 0,
  };
}

// url() with quotes escaped — a background path is author data, not CSS
const cssUrl = (u) => `url("${String(u).replace(/["\\]/g, '\\$&')}")`;

function sectionAttrs(sec) {
  const out = {};
  for (const name of ATTRS) {
    const v = sec.getAttribute(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

/**
 * Inject/refresh each section's .slide-bg layer. Idempotent across sync()
 * runs — a signature check skips untouched slides, so a re-sync never
 * rebuilds (and thereby restarts) a playing background video.
 *
 * In print mode no <video> is ever created (SPEC §8): the poster renders as
 * the background image instead, so PDF output shows a still.
 */
export function setupMedia(sections, { printMode = false } = {}) {
  sections.forEach((sec) => {
    const bg = parseBackground(sectionAttrs(sec));
    let el = sec.querySelector(':scope > .slide-bg');
    if (!bg) { el?.remove(); return; }
    const sig = JSON.stringify(bg) + (printMode ? '·print' : '');
    if (el && el.dataset.sig === sig) {
      if (el !== sec.firstElementChild) sec.prepend(el);
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'slide-bg';
      el.setAttribute('aria-hidden', 'true');
    }
    el.dataset.sig = sig;
    el.textContent = '';
    el.style.backgroundSize = bg.size;
    el.style.backgroundPosition = bg.position;
    const still = bg.image || (printMode ? bg.poster : null);
    el.style.backgroundImage = still ? cssUrl(still) : '';
    if (bg.video && !printMode) {
      const v = document.createElement('video');
      // attributes AND properties: the attributes survive cloning (overview
      // thumbnails) and are what a headless probe asserts on; the muted
      // property is what actually satisfies the autoplay policy.
      v.muted = true;
      v.loop = true;
      v.setAttribute('muted', '');
      v.setAttribute('loop', '');
      v.setAttribute('playsinline', '');
      v.preload = 'auto';
      if (bg.poster) v.poster = bg.poster;
      v.style.objectFit = bg.size;
      v.style.objectPosition = bg.position;
      v.src = bg.video;
      el.appendChild(v);
    }
    if (bg.dim > 0) {
      // canvas-colored wash between the media and the content — after the
      // video in DOM order, so it paints above it
      const dim = document.createElement('div');
      dim.className = 'slide-bg-dim';
      dim.style.opacity = String(bg.dim);
      el.appendChild(dim);
    }
    sec.prepend(el);
  });
}
