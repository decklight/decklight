// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * THE panel that sits BESIDE the slide rather than over it.
 *
 * Four placements — a movable float, or docked left, right or bottom — with the
 * stage reflowing away from a docked gutter so the slide stays whole and the
 * deck stays navigable. Remembered per deck, like the clock and the character.
 *
 * ONE slot, ONE placement, tabs between them (ROADMAP section 3). The notes,
 * the inspector, the sources, the comments, the agent and the HTML editor
 * used to be six panels, each remembering its own placement, any number of
 * them open at once on any sides. Now they share one placement per deck
 * (`decklight-panel-dock:`), opening one closes whichever other holds the
 * slot, and every header carries tabs to the others this deck offers, so
 * moving from the notes to the inspector is a click in the same place.
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
const SIDES = ['left', 'right', 'bottom'];

// Every docked panel on a root CLAIMS its side, and the root's gutter on each
// side is the widest claim there. Each panel used to write all three --dock-*
// vars itself: docking the inspector right zeroed the agent's left gutter, and
// closing either one let go of the other's, leaving a panel over the slide.
const claims = new WeakMap();   // root → Map(panel token → { side, px })

// The panels that share a root's slot: token → { name, open, close, isOpen,
// available, tab }. The order of registration is the order of the tabs.
const panels = new WeakMap();   // root → Map(token → panel)
const panelsOf = (root) => { if (!panels.has(root)) panels.set(root, new Map()); return panels.get(root); };

/** Close every OTHER panel holding the root's slot: one panel beside the slide. */
function takeSlot(root, token) {
  for (const [t, p] of panelsOf(root)) {
    if (t !== token && p.isOpen()) p.close();
  }
}

function applyGutters(root) {
  const mine = claims.get(root);
  for (const side of SIDES) {
    let px = 0;
    for (const c of mine?.values() ?? []) if (c.side === side) px = Math.max(px, c.px);
    root.style.setProperty('--dock-' + side, px + 'px');
  }
}

function claim(root, token, side, px) {
  if (!claims.has(root)) claims.set(root, new Map());
  if (side) claims.get(root).set(token, { side, px });
  else claims.get(root).delete(token);
  applyGutters(root);
}

/**
 * `key` names the deck AND the panel, so two dockable panels remember their
 * placements separately — docking comments right should not move sources.
 *
 * `getEl` and `reflow` are both late: the element is created and destroyed as
 * the panel opens and closes, and one of these panels is built before the deck
 * exists — naming it here would read it inside its own dead zone.
 */
export function createDock({
  root, reflow, getEl, closeLabel = 'close', defaultMode = 'float',
  // the slot: what the tab is called, how to open and close this panel, and
  // whether it can be opened at all right now (the agent needs write mode).
  // `tab: false` keeps a panel out of the tabs (the HTML editor opens on an
  // element, so there is nothing for a tab to open it on).
  name = null, open = null, close = null, available = () => true, tab = true,
}) {
  // ONE placement per deck for every panel. `defaultMode` is where a panel
  // opens before anyone has chosen: a drawer (the notes) belongs at the
  // bottom, a tool card afloat.
  const key = 'decklight-panel-dock:' + (typeof location !== 'undefined' ? location.pathname : '');
  const dock = { mode: MODES.includes(defaultMode) ? defaultMode : 'float', x: null, y: null };
  const load = () => {
    // first run, or storage denied — either way the default placement is fine
    const s = readJson(key);
    if (s?.mode) { dock.mode = s.mode; dock.x = s.x ?? null; dock.y = s.y ?? null; }
  };
  load();
  const persist = () => writeJson(key, dock);
  const token = {};   // this panel's claim on the root's gutters, and its place in the slot
  panelsOf(root).set(token, {
    name, tab: tab && !!name && !!open, available,
    open: () => open?.(), close: () => close?.(), isOpen: () => !!getEl(),
  });

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
    // the slot is this panel's now; the placement is the one every panel shares,
    // which another panel may have moved since this one last drew
    takeSlot(root, token);
    load();
    el.dataset.dock = dock.mode;
    const g = gutter();
    const side = SIDES.includes(dock.mode) ? dock.mode : null;
    claim(root, token, side, dock.mode === 'bottom' ? g.h : g.w);
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

  /**
   * The tabs: every panel this deck offers, this one lit, the others a click
   * away in the same place. A row of their own across the top of the header,
   * since a docked panel is narrow and the header already holds a title and
   * the placement buttons. Absent while this is the only panel on offer.
   */
  function tabs() {
    const offered = [...panelsOf(root)].filter(([t, p]) => p.tab && (t === token || p.available()));
    if (!panelsOf(root).get(token)?.tab || offered.length < 2) return null;
    const row = document.createElement('div');
    row.className = 'dk-tabs';
    row.setAttribute('role', 'tablist');
    for (const [t, p] of offered) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dk-tab' + (t === token ? ' dk-tab-on' : '');
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', t === token ? 'true' : 'false');
      b.textContent = p.name;
      if (t !== token) b.addEventListener('click', (e) => { e.stopPropagation(); p.open(); });
      row.append(b);
    }
    return row;
  }

  /** Give a header the drag handle, the cursor that advertises it, and the tabs. */
  function wireHeader(head) {
    head.style.cursor = dock.mode === 'float' ? 'move' : '';
    head.addEventListener('pointerdown', startDrag);
    head.querySelector(':scope > .dk-tabs')?.remove();
    const row = tabs();
    if (row) head.prepend(row);
  }

  /**
   * Let go of the stage when the panel closes, or it reflows around nothing —
   * only THIS panel's gutter: another panel docked elsewhere keeps its own.
   */
  function release() {
    claim(root, token, null);
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
