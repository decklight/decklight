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

const GLYPH = { float: '❏', left: '◧', right: '◨', bottom: '⬓', window: '⧉' };
const MODES = ['float', 'left', 'right', 'bottom'];
const SIDES = ['left', 'right', 'bottom'];
const DEFAULT_MODE = 'right';   // where every panel opens until one is moved

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
  const dock = { mode: DEFAULT_MODE, x: null, y: null };
  const load = () => {
    // first run, or storage denied — either way the default placement is fine
    const s = readJson(key);
    if (s?.mode) { dock.mode = s.mode; dock.x = s.x ?? null; dock.y = s.y ?? null; }
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
    const g = gutter();
    const side = SIDES.includes(dock.mode) ? dock.mode : null;
    claim(root, token, side, dock.mode === 'bottom' ? g.h : g.w);
    el.style.setProperty('--dock-size', dock.mode === 'bottom' ? g.h + 'px' : g.w + 'px');
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
    el?.querySelectorAll('.dk-btn[data-mode]').forEach(
      (b) => b.classList.toggle('dk-on', b.dataset.mode === now));
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
   * The four placement buttons plus a close — the row a panel puts in its
   * header. `onClose` is the panel's own, because closing is the one thing
   * here that is not about placement.
   */
  function controls(onClose, closeHint = closeLabel) {
    const ctl = document.createElement('div');
    ctl.className = 'dk-ctl';
    const popped = !!popoutOf(root);
    for (const m of MODES) {
      const b = document.createElement('button');
      b.className = 'dk-btn' + (!popped && dock.mode === m ? ' dk-on' : '');
      b.type = 'button';
      b.textContent = GLYPH[m];
      b.dataset.mode = m;
      b.title = m === 'float' ? 'float (movable)' : `dock ${m}`;
      b.setAttribute('aria-label', m === 'float' ? 'float' : `dock ${m}`);
      b.addEventListener('click', () => setDock(m));
      ctl.append(b);
    }
    // the fifth placement: a window of its own (dragging the card out does it too)
    const w = document.createElement('button');
    w.className = 'dk-btn' + (popoutOf(root) ? ' dk-on' : '');
    w.type = 'button';
    w.textContent = GLYPH.window;
    w.dataset.mode = 'window';
    w.title = 'own window (or drag the panel out of the browser)';
    w.setAttribute('aria-label', 'own window');
    w.addEventListener('click', () => setDock('window'));
    ctl.append(w);
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
    head.style.cursor = dock.mode === 'float' && !popoutOf(root) ? 'move' : '';
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
    release,
  };
}
