// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Auto-animate (Magic Move) — SPEC §4.2. FLIP on data-id matches between two
// adjacent sections, plus opacity/color/background/border-radius/font-size.

const VISUAL_PROPS = ['opacity', 'color', 'backgroundColor', 'borderRadius', 'fontSize'];

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
  // --auto-animate-duration may be authored in ms or s — parse the unit
  // (blind `* 1000` turned "500ms" into 500 seconds: a crawl, not a move)
  const raw = getComputedStyle(toSection).getPropertyValue('--auto-animate-duration').trim();
  const duration = (raw.endsWith('ms') ? parseFloat(raw)
    : raw.endsWith('s') ? parseFloat(raw) * 1000
    : parseFloat(raw)) || 500;

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
    const dx = (o.rect.left - n.rect.left) / f.x;
    const dy = (o.rect.top - n.rect.top) / f.y;
    const textOnly = el.children.length === 0 && o.fontSize !== n.fontSize;
    const sx = textOnly ? 1 : (n.rect.width ? o.rect.width / n.rect.width : 1);
    const sy = textOnly ? 1 : (n.rect.height ? o.rect.height / n.rect.height : 1);

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
    el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    for (const p of VISUAL_PROPS) el.style[p] = o[p];

    void el.offsetWidth; // commit "from" state
    el.style.transition =
      `transform ${duration}ms ease, opacity ${duration}ms ease, color ${duration}ms ease, ` +
      `background-color ${duration}ms ease, border-radius ${duration}ms ease, font-size ${duration}ms ease`;
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
