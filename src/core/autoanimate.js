// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Auto-animate (Magic Move) — SPEC AUTO_ANIMATE. FLIP on data-id matches between two
// adjacent sections, plus opacity/color/background/border-radius/font-size.

import { VISUAL_PROPS, cssDurationMs, flipCss, flipTransform, transitionProps } from './motion.js';

// Derived from VISUAL_PROPS so a prop added there can't silently fail to
// animate because someone forgot to edit a hand-written string.
const TRANSITION_PROPS = transitionProps();

function snapshot(el) {
  const cs = getComputedStyle(el);
  const snap = { rect: el.getBoundingClientRect() };
  for (const p of VISUAL_PROPS) snap[p] = cs[p];
  return snap;
}

// Screen-px → element-local units. SVG children need CTM math (viewBox
// scaling); HTML children just divide by the stage scale.
function localFactor(el, stageScale) {
  if (el.ownerSVGElement) {
    const ctm = el.getScreenCTM?.();
    if (ctm && ctm.a && ctm.d) return { x: ctm.a, y: ctm.d };
  }
  return { x: stageScale, y: stageScale };
}

/**
 * Animate from `fromSection` to `toSection`. Both must be laid out (the
 * engine displays `toSection` with visibility:hidden to measure first).
 * Returns the animation duration in ms.
 */
export function runAutoAnimate(fromSection, toSection, stageScale) {
  // --auto-animate-duration may be authored in ms or s, and the unit has to be
  // read: blind `* 1000` turned "500ms" into 500 seconds, a crawl rather than a
  // move. cssDurationMs is that reading, shared with slide transitions, which
  // had the same bug for longer (SPEC MOTION).
  const duration = cssDurationMs(
    getComputedStyle(toSection).getPropertyValue('--auto-animate-duration'), 500);

  const olds = new Map();
  fromSection.querySelectorAll('[data-id]').forEach((el) => {
    olds.set(el.getAttribute('data-id'), snapshot(el));
  });

  const matched = [];
  toSection.querySelectorAll('[data-id]').forEach((el) => {
    const o = olds.get(el.getAttribute('data-id'));
    if (o) matched.push({ el, o });
  });

  for (const { el, o } of matched) {
    const n = snapshot(el);
    const f = localFactor(el, stageScale);
    const textOnly = el.children.length === 0 && o.fontSize !== n.fontSize;
    const flip = flipTransform(o, n, f, textOnly);

    // Authored inline styles must survive the move — and per-property capture
    // can't do it: `background: var(--accent)` is a pending-substitution
    // shorthand whose longhands read back as '' and which is DROPPED the
    // moment any longhand is set through el.style. Snapshot the whole style
    // attribute, animate toward the COMPUTED target values, and restore the
    // authored attribute verbatim when the move completes.
    const authoredCss = el.getAttribute('style') ?? '';

    el.style.transition = 'none';
    if (el.ownerSVGElement) {
      el.style.transformBox = 'fill-box';
      el.style.transformOrigin = '0 0';
    } else {
      el.style.transformOrigin = '0 0';
    }
    el.style.transform = flipCss(flip);
    for (const p of VISUAL_PROPS) el.style[p] = o[p];

    void el.offsetWidth; // commit "from" state
    el.style.transition = TRANSITION_PROPS.map((p) => `${p} ${duration}ms ease`).join(', ');
    el.style.transform = '';
    for (const p of VISUAL_PROPS) el.style[p] = n[p];

    const cleanup = () => {
      if (authoredCss) el.setAttribute('style', authoredCss);
      else el.removeAttribute('style');
      el.removeEventListener('transitionend', cleanup);
    };
    el.addEventListener('transitionend', cleanup);
    setTimeout(cleanup, duration + 80);
  }

  // Unmatched top-level content fades in.
  const matchedEls = new Set(matched.map((m) => m.el));
  [...toSection.children].forEach((child) => {
    if (child.matches('aside.notes')) return;
    const containsMatch = matchedEls.has(child) ||
      [...matchedEls].some((m) => child.contains(m));
    if (containsMatch) return;
    child.classList.add('aa-fresh');
    requestAnimationFrame(() => requestAnimationFrame(() => child.classList.add('aa-in')));
    setTimeout(() => child.classList.remove('aa-fresh', 'aa-in'), duration + 120);
  });

  return duration;
}
