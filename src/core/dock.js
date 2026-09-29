// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A panel that sits BESIDE the slide rather than over it.
 *
 * Four placements — a movable float, or docked left, right or bottom — with the
 * stage reflowing away from a docked gutter so the slide stays whole and the
 * deck stays navigable. Remembered per deck, like the clock and the character.
 *
 * This came out of review.js unchanged when a second panel wanted it (`I`,
 * SLIDE_SOURCES). Docking is forty lines of gutter arithmetic, inline-style
 * cleanup and pointer bookkeeping, and every one of them is a place two copies
 * would drift: the bug the review harness pins to the pixel — a docked card
 * left sitting where it last floated, because float's inline `left/top` outrank
 * the stylesheet — is exactly the sort a copy reintroduces quietly.
 *
 * The CSS is shared the same way: `.decklight-dockable[data-dock="…"]` styles
 * the placement, and each panel keeps its own rules for what is INSIDE the card.
 */

import { readJson, writeJson } from './prefs.js';

const GLYPH = { float: '❏', left: '◧', right: '◨', bottom: '⬓' };
const MODES = ['float', 'left', 'right', 'bottom'];

/**
 * `key` names the deck AND the panel, so two dockable panels remember their
 * placements separately — docking comments right should not move sources.
 *
 * `getEl` and `reflow` are both late: the element is created and destroyed as
 * the panel opens and closes, and one of these panels is built before the deck
 * exists — naming it here would read it inside its own dead zone.
 */
export function createDock({ root, reflow, key, getEl, closeLabel = 'close' }) {
  const dock = { mode: 'float', x: null, y: null };
  {
    // first run, or storage denied — either way the default float is fine
    const s = readJson(key);
    if (s?.mode) { dock.mode = s.mode; dock.x = s.x ?? null; dock.y = s.y ?? null; }
  }
  const persist = () => writeJson(key, dock);

  // The gutter a docked panel reserves, in px — the same figure drives the
  // panel's own width/height (CSS var) and the stage's inset (root var), so the
  // slide reflows into exactly what is left. Viewport-relative, re-read on resize.
  const gutter = () => ({
    w: Math.min(360, Math.round(root.clientWidth * 0.32)),
    h: Math.min(320, Math.round(root.clientHeight * 0.40)),
  });

  /** Reserve the stage gutter for the current mode (or clear it for float). */
  function reserveGutter() {
    const el = getEl();
    if (!el) return;
    el.dataset.dock = dock.mode;
    const g = gutter();
    root.style.setProperty('--dock-left', dock.mode === 'left' ? g.w + 'px' : '0px');
    root.style.setProperty('--dock-right', dock.mode === 'right' ? g.w + 'px' : '0px');
    root.style.setProperty('--dock-bottom', dock.mode === 'bottom' ? g.h + 'px' : '0px');
    el.style.setProperty('--dock-size', dock.mode === 'bottom' ? g.h + 'px' : g.w + 'px');
    // Float positions the card with INLINE left/top, and an inline style beats
    // the stylesheet: leaving them set pinned a docked panel to wherever it last
    // floated while the stage dutifully reflowed away from an empty gutter.
    // Docking hands the placement back to the CSS.
    const card = el.querySelector('.narr-card');
    if (card && dock.mode !== 'float') { card.style.left = ''; card.style.top = ''; }
    reflow?.();
    if (dock.mode === 'float') placeCard();
  }

  /** Float only: clamp the card to the viewport at its remembered position. */
  function placeCard() {
    const card = getEl()?.querySelector('.narr-card');
    if (!card || dock.mode !== 'float') return;
    const w = card.offsetWidth || 460, h = card.offsetHeight || 400;
    let x = dock.x, y = dock.y;
    if (x == null || y == null) { x = root.clientWidth - w - 24; y = 24; }
    x = Math.max(8, Math.min(x, root.clientWidth - w - 8));
    y = Math.max(8, Math.min(y, root.clientHeight - h - 8));
    dock.x = x; dock.y = y;
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }

  /** Switch placement from a header button — persist, reflow, no full re-render. */
  function setDock(mode) {
    dock.mode = mode;
    persist();
    reserveGutter();
    const el = getEl();
    el?.querySelectorAll('.dk-btn').forEach(
      (b) => b.classList.toggle('dk-on', b.dataset.mode === mode));
    const head = el?.querySelector('.narr-head');
    if (head) head.style.cursor = mode === 'float' ? 'move' : '';
  }

  /** Drag the float card by its header. Docked modes ignore it. */
  function startDrag(e) {
    const el = getEl();
    if (!el || dock.mode !== 'float' || (e.button != null && e.button !== 0)) return;
    if (e.target.closest('.dk-ctl')) return;   // the buttons, not a drag
    const card = el.querySelector('.narr-card');
    if (!card) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const ox = parseFloat(card.style.left) || 0, oy = parseFloat(card.style.top) || 0;
    const move = (ev) => {
      const w = card.offsetWidth, h = card.offsetHeight;
      dock.x = Math.max(8, Math.min(ox + ev.clientX - sx, root.clientWidth - w - 8));
      dock.y = Math.max(8, Math.min(oy + ev.clientY - sy, root.clientHeight - h - 8));
      card.style.left = dock.x + 'px';
      card.style.top = dock.y + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      persist();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /**
   * The four placement buttons plus a close — the row a panel puts in its
   * header. `onClose` is the panel's own, because closing is the one thing
   * here that is not about placement.
   */
  function controls(onClose, closeHint = closeLabel) {
    const ctl = document.createElement('div');
    ctl.className = 'dk-ctl';
    for (const m of MODES) {
      const b = document.createElement('button');
      b.className = 'dk-btn' + (dock.mode === m ? ' dk-on' : '');
      b.type = 'button';
      b.textContent = GLYPH[m];
      b.dataset.mode = m;
      b.title = m === 'float' ? 'float (movable)' : `dock ${m}`;
      b.setAttribute('aria-label', m === 'float' ? 'float' : `dock ${m}`);
      b.addEventListener('click', () => setDock(m));
      ctl.append(b);
    }
    const x = document.createElement('button');
    x.className = 'dk-btn dk-close';
    x.type = 'button';
    x.textContent = '×';
    x.title = closeHint;
    x.setAttribute('aria-label', 'close');
    x.addEventListener('click', onClose);
    ctl.append(x);
    return ctl;
  }

  /** Give a header the drag handle and the cursor that advertises it. */
  function wireHeader(head) {
    head.style.cursor = dock.mode === 'float' ? 'move' : '';
    head.addEventListener('pointerdown', startDrag);
  }

  /** Let go of the stage when the panel closes, or it reflows around nothing. */
  function release() {
    root.style.setProperty('--dock-left', '0px');
    root.style.setProperty('--dock-right', '0px');
    root.style.setProperty('--dock-bottom', '0px');
    reflow?.();
  }

  return {
    get mode() { return dock.mode; },
    isFloat: () => dock.mode === 'float',
    reserveGutter,
    placeCard,
    setDock,
    controls,
    wireHeader,
    release,
  };
}
