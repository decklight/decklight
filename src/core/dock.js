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

// The placements, drawn: a frame, and where in it the panel sits. One stroke
// weight and one box for all five, where the glyphs they replace (❏ ◧ ◨ ⬓ ⧉)
// came from five corners of a font and sat at five sizes.
const svg = (inner) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">${inner}</svg>`;
const FRAME = '<rect x="1.65" y="2.65" width="12.7" height="10.7" rx="2"/>';
const ICON = {
  float: svg(`${FRAME}<rect x="7.5" y="5" width="4.6" height="3.8" rx=".8" fill="currentColor" stroke="none"/>`),
  left: svg(`${FRAME}<path d="M2 4.6a1.6 1.6 0 0 1 1.6-1.6H6v10H3.6A1.6 1.6 0 0 1 2 11.4z" fill="currentColor" stroke="none"/>`),
  right: svg(`${FRAME}<path d="M14 4.6A1.6 1.6 0 0 0 12.4 3H10v10h2.4a1.6 1.6 0 0 0 1.6-1.6z" fill="currentColor" stroke="none"/>`),
  bottom: svg(`${FRAME}<path d="M2 9.5h12v1.9a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 11.4z" fill="currentColor" stroke="none"/>`),
  window: svg('<rect x="1.65" y="5.65" width="8.7" height="7.7" rx="1.6"/><path d="M5.6 3.4V3a1.4 1.4 0 0 1 1.4-1.4H13A1.4 1.4 0 0 1 14.4 3v5a1.4 1.4 0 0 1-1.4 1.4h-.4"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8" stroke-width="1.5" stroke-linecap="round"/>'),
};
const LABEL = { float: 'Float', left: 'Left', right: 'Right', bottom: 'Bottom', window: 'Window' };
const MODES = ['float', 'left', 'right', 'bottom'];
// The tabs in the order of the work, whichever panel was built first: write
// the notes, look at the slide, check the deck, find and replace in it, read
// what was said about it, cite it, ask for help.
const TAB_ORDER = ['Notes', 'Inspector', 'Check', 'Find', 'Comments', 'Sources', 'Agent'];
// what starts a hint and is a key: a chord (⌘⏎, ⇧M, Ctrl+Enter, Ctrl+⇧Enter),
// a named key (Esc, ⏎, ⌫), or one letter (R, e; not the word "a")
const MOD = '(?:Ctrl\\+|Alt\\+|Shift\\+|[⌘⇧⌥⌃])';
const NAMED = '(?:Esc|esc|Enter|Tab|Space|[⏎↵⌫⇥]|↑\\/↓|←\\/→)';
const KEY_RE = new RegExp(`^(${MOD}+(?:${NAMED}|[A-Za-z])|${NAMED}|[A-Zb-z])(?= |$)`);
const tabRank = (name) => { const i = TAB_ORDER.indexOf(name); return i < 0 ? TAB_ORDER.length : i; };
const SIDES = ['left', 'right', 'bottom'];
const DEFAULT_MODE = 'right';   // where every panel opens until one is moved
const MIN_W = 320, MIN_H = 160;  // the least a docked panel is dragged to: its six tabs on one line, a few rows

// Every docked panel on a root CLAIMS its side, and the root's gutter on each
// side is the widest claim there. Each panel used to write all three --dock-*
// vars itself: docking the inspector right zeroed the agent's left gutter, and
// closing either one let go of the other's, leaving a panel over the slide.
const claims = new WeakMap();   // root → Map(panel token → { side, px })

// The panels that share a root's slot: token → { name, open, close, isOpen,
// available, tab }. The order of registration is the order of the tabs.
const panels = new WeakMap();   // root → Map(token → panel)
const panelsOf = (root) => { if (!panels.has(root)) panels.set(root, new Map()); return panels.get(root); };

// The slot survives the reload a save causes. A docked panel open when the
// deck reloaded (the HTML editor's ⌘⏎, a dropped picture, an agent's edit)
// used to be closed by it: the notes and the agent ask remembered themselves
// (editmode.js), the inspector did not, and a docked panel that vanishes on
// ⌘⏎ reads as ⌘⏎ closing it. The slot remembers which panel holds it, per
// TAB (sessionStorage: a preference would reopen the panel on every future
// visit), and `reopenPanel` opens it again once the deck is back up.
const OPEN_KEY = () => 'decklight-panel-open:' + (typeof location !== 'undefined' ? location.pathname : '');
const rememberOpen = (name) => { try { sessionStorage.setItem(OPEN_KEY(), name); } catch { /* no storage: the reload closes it, as before */ } };
const forgetOpen = (name) => { try { if (sessionStorage.getItem(OPEN_KEY()) === name) sessionStorage.removeItem(OPEN_KEY()); } catch { /* no storage */ } };

/**
 * After a reload: the panel that held the slot, open again. Nothing when a
 * panel is already open (one that remembered itself in more detail, like the
 * notes with their caret), when the remembered panel cannot open on its own
 * (the HTML editor needs its element; editmode.js reopens that one) or is
 * not available in this mode. True when a panel was opened here.
 */
export function reopenPanel(root) {
  let name = null;
  try { name = sessionStorage.getItem(OPEN_KEY()); } catch { return false; }
  if (!name) return false;
  const all = [...panelsOf(root).values()];
  if (all.some((p) => p.isOpen())) return false;
  const p = all.find((x) => x.name === name);
  if (!p?.opens || !p.available()) return false;
  p.open();
  return p.isOpen();
}

// The slot can leave the browser: a floating panel dragged past the window's
// edge (or sent by its ⧉ button) moves into a window of its own, which the
// author can put on another screen. The panel's element is MOVED, not copied,
// so every listener and every reference a panel holds keeps working; the
// window is just somewhere else for it to be. One per root, like the slot: a
// tab clicked out there opens its panel out there. Never remembered: a popup
// needs a click to open, so the reload a save causes brings the panel home.
const popouts = new WeakMap();   // root → Window
const popoutOf = (root) => { const w = popouts.get(root); return w && !w.closed ? w : null; };
const editable = (t) => (/^(input|textarea|select)$/i.test(t?.tagName ?? '') && !t.readOnly) || !!t?.isContentEditable;

/**
 * Open the root's panel window at `left/top` (screen px; null lets the
 * browser choose), its size the card's. Null when the browser refused: a
 * popup needs the click that started the drag to be recent.
 */
function openPopout(root, { left, top, width, height }, title) {
  const feats = `popup,width=${Math.round(width)},height=${Math.round(height)}`
    + (left != null ? `,left=${Math.round(left)},top=${Math.round(top)}` : '');
  let win = window.open('', 'decklight-panel', feats);
  if (!win) return null;
  // a window left from before a reload: its page is gone, start a fresh one
  let orphan = false;
  try { orphan = win.document.body ? win.document.body.childNodes.length > 0 : false; } catch { orphan = true; }
  if (orphan) {
    try { win.close(); } catch { /* already gone */ }
    win = window.open('', 'decklight-panel', feats);
    if (!win) return null;
    try { void win.document; } catch { return null; }
  }
  const doc = win.document;
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>');
  doc.close();
  doc.title = title;
  // the deck's stylesheets, and its theme's colours (the card reads --accent)
  for (const n of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    const c = doc.importNode(n, true);
    if (n.href) c.href = n.href;
    doc.head.append(c);
  }
  const cs = getComputedStyle(root);
  for (const prop of cs) if (prop.startsWith('--')) doc.body.style.setProperty(prop, cs.getPropertyValue(prop));
  doc.body.style.margin = '0';
  doc.body.style.background = '#16181d';
  // keys that are not typing are the deck's, as they are in the speaker window:
  // → still moves the slides while the panel has the focus
  doc.addEventListener('keydown', (e) => {
    if (editable(e.target)) return;
    const fwd = new KeyboardEvent('keydown', {
      key: e.key, code: e.code, shiftKey: e.shiftKey, altKey: e.altKey,
      metaKey: e.metaKey, ctrlKey: e.ctrlKey, repeat: e.repeat, bubbles: true, cancelable: true,
    });
    if (!document.dispatchEvent(fwd)) e.preventDefault();
  });
  // closing the window closes the panel in it; the deck going away closes the window
  win.addEventListener('pagehide', () => {
    if (popouts.get(root) !== win) return;
    popouts.delete(root);
    for (const p of panelsOf(root).values()) {
      const el = p.el();
      if (el && el.ownerDocument === doc) p.close();
    }
  });
  const bye = () => { try { win.close(); } catch { /* gone */ } };
  window.addEventListener('pagehide', bye, { once: true });
  popouts.set(root, win);
  return win;
}

/** Close the root's panel window once no panel is left in it (a tab switch moves the next one in first). */
function closeEmptyPopout(root) {
  if (!popoutOf(root)) return;
  setTimeout(() => {
    const win = popoutOf(root);
    if (win && !win.document.querySelector('.decklight-dockable')) {
      popouts.delete(root);
      win.close();
    }
  }, 0);
}

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
  // ONE placement per deck for every panel, and one default before anyone
  // has chosen: docked right, beside the slide (PRESENTING_EDITING). Each
  // panel used to have its own (the notes at the bottom, the inspector and
  // the check on the right, the rest afloat), so switching tabs before a
  // choice was made threw the panel from one place to another. `defaultMode`
  // is kept for a caller that still names one, and no longer read.
  void defaultMode;
  const key = 'decklight-panel-dock:' + (typeof location !== 'undefined' ? location.pathname : '');
  // `w` and `h`: the docked panel's size once it has been dragged (px; a side
  // panel's width, the bottom tray's height). Null is the size it opens at.
  const dock = { mode: DEFAULT_MODE, x: null, y: null, w: null, h: null };
  const size = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const load = () => {
    // first run, or storage denied — either way the default placement is fine
    const s = readJson(key);
    if (s?.mode) {
      dock.mode = s.mode; dock.x = s.x ?? null; dock.y = s.y ?? null;
      dock.w = size(s.w); dock.h = size(s.h);
    }
  };
  load();
  const persist = () => writeJson(key, dock);
  const token = {};   // this panel's claim on the root's gutters, and its place in the slot
  panelsOf(root).set(token, {
    name, tab: tab && !!name && !!open, available, opens: !!open,
    open: () => open?.(), close: () => close?.(), isOpen: () => !!getEl(), el: () => getEl(),
  });

  // The gutter a docked panel reserves, in px — the same figure drives the
  // panel's own width/height (CSS var) and the stage's inset (root var), so the
  // slide reflows into exactly what is left. Viewport-relative, re-read on resize.
  // The size it opens at, and how far a drag of its edge can take it: never
  // narrower than its own header needs, never so wide the slide beside it is
  // a thumbnail. A remembered size is clamped again on every read, so one
  // set in a wide window is still a panel AND a slide in a narrow one.
  const limits = () => {
    const W = root.clientWidth, H = root.clientHeight;
    return {
      w: { open: Math.min(360, Math.round(W * 0.32)), min: Math.min(MIN_W, Math.round(W * 0.32)), max: Math.max(MIN_W, Math.round(Math.min(W * 0.7, W - 320))) },
      h: { open: Math.min(320, Math.round(H * 0.40)), min: Math.min(MIN_H, Math.round(H * 0.40)), max: Math.max(MIN_H, Math.round(Math.min(H * 0.7, H - 200))) },
    };
  };
  const clamp = (v, l) => Math.round(Math.min(Math.max(v, l.min), Math.max(l.min, l.max)));
  const gutter = () => {
    const l = limits();
    return {
      w: dock.w == null ? l.w.open : clamp(dock.w, l.w),
      h: dock.h == null ? l.h.open : clamp(dock.h, l.h),
    };
  };

  /**
   * The docked panel's inner edge, to drag: a side panel wider or narrower, the
   * bottom tray taller or shorter, the slide refitting beside it as it goes.
   * A double-click puts the size it opens at back; the arrows move it from
   * the keyboard. One size per deck, like the placement, for every panel.
   *
   * It lives on the panel's frame, beside the card: a card redraws itself by
   * emptying itself, and would take a handle inside it along.
   */
  function resizer(el) {
    let h = el.querySelector(':scope > .dk-resize');
    if (h) return h;
    // made in the frame's own document; a frame without one has no edge to drag
    const doc = el.ownerDocument;
    if (!doc || !el.append) return null;
    h = doc.createElement('div');
    h.className = 'dk-resize';
    h.setAttribute('role', 'separator');
    h.setAttribute('aria-label', 'resize the panel');
    h.title = 'drag to resize · double-click for the usual size';
    h.tabIndex = 0;
    const axis = () => (dock.mode === 'bottom' ? 'h' : 'w');
    const set = (px) => {
      const a = axis();
      dock[a] = px == null ? null : clamp(px, limits()[a]);
      applySize();
    };
    const move = (e) => {
      const R = root.getBoundingClientRect();
      set(dock.mode === 'bottom' ? R.bottom - e.clientY : dock.mode === 'left' ? e.clientX - R.left : R.right - e.clientX);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      root.classList.remove('dk-resizing');
      h.classList.remove('dk-dragging');
      persist();
    };
    h.addEventListener('pointerdown', (e) => {
      if (!SIDES.includes(dock.mode) || popoutOf(root) || (e.button != null && e.button !== 0)) return;
      e.preventDefault(); e.stopPropagation();
      try { h.setPointerCapture?.(e.pointerId); } catch { /* a synthetic event */ }
      root.classList.add('dk-resizing');
      h.classList.add('dk-dragging');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    h.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); set(null); persist(); });
    // from the keyboard: an arrow towards the slide grows the panel, Home and
    // End are its limits. Stopped here, or the same arrow would turn the slide.
    h.addEventListener('keydown', (e) => {
      if (!SIDES.includes(dock.mode)) return;
      const a = axis(), l = limits()[a], now = gutter()[a];
      const grow = dock.mode === 'bottom' ? 'ArrowUp' : dock.mode === 'left' ? 'ArrowRight' : 'ArrowLeft';
      const shrink = dock.mode === 'bottom' ? 'ArrowDown' : dock.mode === 'left' ? 'ArrowLeft' : 'ArrowRight';
      const step = e.shiftKey ? 64 : 16;
      let to = null;
      if (e.key === grow) to = now + step;
      else if (e.key === shrink) to = now - step;
      else if (e.key === 'Home') to = l.min;
      else if (e.key === 'End') to = l.max;
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); set(null); persist(); return; }
      else return;
      e.preventDefault(); e.stopPropagation();
      set(to); persist();
    });
    el.append(h);
    return h;
  }

  /** The gutter and the card at the size `dock` holds now: what a drag of the edge calls on every frame. */
  function applySize() {
    const el = getEl();
    if (!el || popoutOf(root)) return;
    const side = SIDES.includes(dock.mode) ? dock.mode : null;
    const g = gutter();
    const px = dock.mode === 'bottom' ? g.h : g.w;
    claim(root, token, side, px);
    el.style.setProperty('--dock-size', px + 'px');
    describeResizer(el, px);
    reflow?.();
  }
  /** What the edge is to a screen reader: a separator, which way it moves, where it is between its limits. */
  function describeResizer(el, px) {
    const h = el.querySelector(':scope > .dk-resize');
    if (!h || !SIDES.includes(dock.mode)) return;
    const l = limits()[dock.mode === 'bottom' ? 'h' : 'w'];
    h.setAttribute('aria-orientation', dock.mode === 'bottom' ? 'horizontal' : 'vertical');
    h.setAttribute('aria-valuenow', String(px));
    h.setAttribute('aria-valuemin', String(l.min));
    h.setAttribute('aria-valuemax', String(Math.max(l.min, l.max)));
  }

  /** Reserve the stage gutter for the current mode (or clear it for float). */
  function reserveGutter() {
    const el = getEl();
    if (!el) return;
    // the slot is this panel's now; the placement is the one every panel shares,
    // which another panel may have moved since this one last drew
    takeSlot(root, token);
    if (name) rememberOpen(name);   // after takeSlot: the panels it closed forgot themselves
    load();
    const card = el.querySelector('.narr-card');
    const win = popoutOf(root);
    if (win) {
      // out in its own window: it fills it, and leaves the stage whole
      el.dataset.dock = 'window';
      if (card) { card.style.left = ''; card.style.top = ''; }
      if (el.ownerDocument !== win.document) win.document.body.append(el);
      if (name) win.document.title = `${name} · ${document.title}`;
      claim(root, token, null);
      reflow?.();
      return;
    }
    el.dataset.dock = dock.mode;
    resizer(el);
    const g = gutter();
    const side = SIDES.includes(dock.mode) ? dock.mode : null;
    claim(root, token, side, dock.mode === 'bottom' ? g.h : g.w);
    el.style.setProperty('--dock-size', dock.mode === 'bottom' ? g.h + 'px' : g.w + 'px');
    describeResizer(el, dock.mode === 'bottom' ? g.h : g.w);
    // Float positions the card with INLINE left/top, and an inline style beats
    // the stylesheet: leaving them set pinned a docked panel to wherever it last
    // floated while the stage dutifully reflowed away from an empty gutter.
    // Docking hands the placement back to the CSS.
    if (card && dock.mode !== 'float') { card.style.left = ''; card.style.top = ''; }
    reflow?.();
    if (dock.mode === 'float') placeCard();
  }

  /** Float only: clamp the card to the viewport at its remembered position. */
  function placeCard() {
    const card = getEl()?.querySelector('.narr-card');
    if (!card || dock.mode !== 'float' || popoutOf(root)) return;
    const w = card.offsetWidth || 460, h = card.offsetHeight || 400;
    let x = dock.x, y = dock.y;
    if (x == null || y == null) { x = root.clientWidth - w - 24; y = 24; }
    x = Math.max(8, Math.min(x, root.clientWidth - w - 8));
    y = Math.max(8, Math.min(y, root.clientHeight - h - 8));
    dock.x = x; dock.y = y;
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }

  /** Light the placement buttons and the drag cursor for where the panel is now. */
  function paintControls() {
    const el = getEl();
    const now = popoutOf(root) ? 'window' : dock.mode;
    el?.querySelectorAll('.dk-btn[data-mode]').forEach((b) => {
      b.classList.toggle('dk-on', b.dataset.mode === now);
      b.setAttribute('aria-checked', String(b.dataset.mode === now));
    });
    const place = el?.querySelector('.dk-place-btn');
    if (place) place.innerHTML = ICON[now] ?? ICON.right;
    const head = el?.querySelector('.narr-head');
    if (head) head.style.cursor = now === 'float' ? 'move' : '';
  }

  /**
   * Out of the browser: the panel moves into a window of its own at `at`
   * (screen px), or one the browser places. False when the popup was refused,
   * and the panel stays where it was.
   */
  function popOut(at = {}) {
    const el = getEl();
    const card = el?.querySelector('.narr-card');
    if (!el || !card) return false;
    if (popoutOf(root)) return true;
    const r = card.getBoundingClientRect();
    const win = openPopout(root, {
      left: at.left ?? null, top: at.top ?? null,
      width: Math.max(320, r.width || 460), height: Math.max(240, r.height || 400),
    }, `${name || 'Panel'} · ${document.title}`);
    if (!win) return false;
    reserveGutter();
    paintControls();
    win.focus();
    return true;
  }

  /** Back into the deck: the window closes and the panel takes the placement it had. */
  function popIn() {
    const win = popoutOf(root);
    if (!win) return;
    popouts.delete(root);
    const el = getEl();
    if (el && el.ownerDocument !== document) root.appendChild(el);
    try { win.close(); } catch { /* gone */ }
    window.focus();
  }

  /** Switch placement from a header button — persist, reflow, no full re-render. */
  function setDock(mode) {
    if (mode === 'window') { popOut(); return; }
    popIn();
    dock.mode = mode;
    persist();
    reserveGutter();
    paintControls();
  }

  /**
   * Drag the float card by its header. Docked modes ignore it. Inside the
   * browser the card stays clamped to the deck; let go with the pointer
   * PAST the browser's edge and the panel leaves it for a window of its own,
   * where you dropped it (the card goes faint on the way out to say so).
   */
  function startDrag(e) {
    const el = getEl();
    if (!el || dock.mode !== 'float' || popoutOf(root) || (e.button != null && e.button !== 0)) return;
    if (e.target.closest('.dk-ctl, .dk-tabs')) return;   // the buttons, not a drag
    const card = el.querySelector('.narr-card');
    if (!card) return;
    e.preventDefault();
    // held, so the moves keep coming once the pointer is out of the window
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* a synthetic event */ }
    const sx = e.clientX, sy = e.clientY;
    const ox = parseFloat(card.style.left) || 0, oy = parseFloat(card.style.top) || 0;
    const box = card.getBoundingClientRect();
    const gx = sx - box.left, gy = sy - box.top;   // where on the card it was grabbed
    const outside = (ev) => ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight;
    const move = (ev) => {
      const w = card.offsetWidth, h = card.offsetHeight;
      dock.x = Math.max(8, Math.min(ox + ev.clientX - sx, root.clientWidth - w - 8));
      dock.y = Math.max(8, Math.min(oy + ev.clientY - sy, root.clientHeight - h - 8));
      card.style.left = dock.x + 'px';
      card.style.top = dock.y + 'px';
      card.classList.toggle('dk-leaving', outside(ev));
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      card.classList.remove('dk-leaving');
      if (ev.type === 'pointerup' && outside(ev)) {
        // it comes back where it started, should it ever come back
        dock.x = ox; dock.y = oy;
        card.style.left = ox + 'px';
        card.style.top = oy + 'px';
        persist();
        popOut({ left: ev.screenX - gx, top: ev.screenY - gy });
        return;
      }
      persist();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  /**
   * Where the panel sits, and a close: the two buttons a panel puts at the end
   * of its header. The placement is ONE button, drawn as where the panel is
   * now, which opens the five choices as a labelled strip under the header.
   * It used to be five glyphs side by side in every header, which is five
   * buttons for a choice made once a deck, in the room the title needed.
   * `onClose` is the panel's own, because closing is the one thing here that
   * is not about placement.
   */
  function controls(onClose, closeHint = closeLabel) {
    const ctl = document.createElement('div');
    ctl.className = 'dk-ctl';
    // the placement is every panel's, and another may have moved it since this
    // one last drew: a header built from the stale one drew the wrong place
    load();
    const now = popoutOf(root) ? 'window' : dock.mode;
    const place = document.createElement('button');
    place.className = 'dk-btn dk-place-btn';
    place.type = 'button';
    place.innerHTML = ICON[now] ?? ICON.right;
    place.title = 'move this panel';
    place.setAttribute('aria-label', 'move this panel');
    place.setAttribute('aria-haspopup', 'true');
    place.setAttribute('aria-expanded', 'false');
    // the choices: built here, shown by wireHeader's row under the header
    const menu = document.createElement('div');
    menu.className = 'dk-menu';
    menu.setAttribute('role', 'radiogroup');
    menu.setAttribute('aria-label', 'where the panel sits');
    menu.hidden = true;
    const show = (on) => {
      menu.hidden = !on;
      place.setAttribute('aria-expanded', String(on));
      place.classList.toggle('dk-open', on);
    };
    for (const m of [...MODES, 'window']) {
      const b = document.createElement('button');
      b.className = 'dk-btn dk-opt' + (now === m ? ' dk-on' : '');
      b.type = 'button';
      b.innerHTML = `${ICON[m]}<span>${LABEL[m]}</span>`;
      b.dataset.mode = m;
      b.title = m === 'float' ? 'float (movable)'
        : m === 'window' ? 'own window (or drag the panel out of the browser)' : `dock ${m}`;
      b.setAttribute('aria-label', m === 'float' ? 'float' : m === 'window' ? 'own window' : `dock ${m}`);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(now === m));
      b.addEventListener('click', () => { show(false); setDock(m); });
      menu.append(b);
    }
    place.addEventListener('click', (e) => { e.stopPropagation(); show(menu.hidden); });
    // Esc with the choices open closes them, not the panel
    const esc = (e) => {
      if (e.key !== 'Escape' || menu.hidden) return;
      e.preventDefault(); e.stopPropagation();
      show(false);
      place.focus();
    };
    place.addEventListener('keydown', esc);
    menu.addEventListener('keydown', esc);
    const x = document.createElement('button');
    x.className = 'dk-btn dk-close';
    x.type = 'button';
    x.innerHTML = ICON.close;
    x.title = closeHint;
    x.setAttribute('aria-label', 'close');
    x.addEventListener('click', onClose);
    ctl.append(place, x, menu);
    return ctl;
  }

  /**
   * The tabs: every panel this deck offers, this one lit, the others a click
   * away in the same place. A row of their own across the top of the header,
   * since a docked panel is narrow and the header already holds a title and
   * the placement buttons. Absent while this is the only panel on offer.
   */
  function tabs() {
    const offered = [...panelsOf(root)].filter(([t, p]) => p.tab && (t === token || p.available()))
      .sort(([, a], [, b]) => tabRank(a.name) - tabRank(b.name));
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
    head.classList.add('dk-head');
    head.style.cursor = dock.mode === 'float' && !popoutOf(root) ? 'move' : '';
    head.addEventListener('pointerdown', startDrag);
    head.querySelector(':scope > .dk-tabs')?.remove();
    head.querySelector(':scope > .dk-name')?.remove();
    const row = tabs();
    if (row) head.prepend(row);
    // no tabs to say which panel this is (it is the only one on offer): the
    // header says it itself
    else if (name && panelsOf(root).get(token)?.tab) {
      head.prepend(Object.assign(document.createElement('span'), { className: 'dk-name', textContent: name }));
    }
    // the placement choices open as a row of their own, under the title's
    const menu = head.querySelector('.dk-ctl > .dk-menu');
    if (menu) head.append(menu);
  }

  /**
   * The keys line at the foot of a panel: `a · b · c`, each hint kept whole
   * when the line wraps, and the key that starts one drawn as a key. One look
   * for all of them; they used to be a header here, a paragraph there, small
   * capitals in a third. The text reads as it was written (`textContent`).
   */
  function foot(text, className = '') {
    const el = document.createElement('div');
    el.className = ('dk-foot ' + className).trim();
    String(text).split(' · ').forEach((hint, i) => {
      if (i) el.append(' · ');
      const span = document.createElement('span');
      span.className = 'dk-hint';
      const m = KEY_RE.exec(hint);
      if (m) {
        span.append(Object.assign(document.createElement('kbd'), { textContent: m[1] }), hint.slice(m[1].length));
      } else span.textContent = hint;
      el.append(span);
    });
    return el;
  }

  /**
   * Let go of the stage when the panel closes, or it reflows around nothing —
   * only THIS panel's gutter: another panel docked elsewhere keeps its own.
   */
  function release() {
    if (name) forgetOpen(name);
    claim(root, token, null);
    reflow?.();
    closeEmptyPopout(root);
  }

  return {
    get mode() { return popoutOf(root) ? 'window' : dock.mode; },
    // out in its own window the panel is over nothing: the deck keeps its keys
    isFloat: () => dock.mode === 'float' && !popoutOf(root),
    reserveGutter,
    placeCard,
    setDock,
    popOut,
    popIn,
    controls,
    wireHeader,
    foot,
    release,
  };
}
