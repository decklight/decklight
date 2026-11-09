// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Moving things within a slide — SPEC PRESENTING_EDITING, Moving.
//
// A slide could be moved in write mode and nothing on one could: putting the
// picture above the bullets meant opening the HTML. Three ways now, one route:
//
//   the element menu's Move up and Move down (greyed at the ends),
//   ⌥↑ / ⌥↓ on a selection, and on a list item while its words are being
//   edited (outliner style: the item moves, the editing goes on),
//   dragging the selection's ⋯ handle, a line showing where it would land.
//
// Each is one `POST /deck/edit/element/move` and one undo entry. The page
// makes the same change in its own DOM at once (no reload: the write is
// quiet), the selection follows the element, and the slide is laid out and
// scanned for builds again, so a build that moved is a step that moved.
// Where the page cannot follow (a design-system slide, whose DOM the template
// built; a slide with something live on it, a terminal or a video) it is the
// ordinary reload, landing on the slide with the element selected.
//
// The notes, sources and rehearsed time stay last: nothing moves onto them or
// past them, here or on the server.

import { boundedFetch } from './devmode.js';
import { authoredTop, fileIndexOf } from './design-system.js';
import { pathFrom } from './colorpicker.js';

/** Children the engine put on a slide: not the file's, never moved, never counted. */
const ENGINE_CHILD = '.slide-bg, .decklight-hero-logo, [data-ds-injected]';
/** What a slide carries rather than shows (DECK_ANATOMY): it stays where it is. */
const CARRIED = 'aside.notes, aside.sources, aside.rehearse, script, style';
/** Nodes the engine put inside an element (a draw build's head and mask): not the file's. */
const INJECTED = '.draw-head, .draw-mask, [data-ds-injected]';
/** Something live on a slide: moved in the DOM it would restart, or lose its place. */
const LIVE = '.terminal, video, audio, iframe, canvas';
const RESELECT_KEY = 'decklight-move-select:' + (typeof location !== 'undefined' ? location.pathname : '');
const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');

/**
 * The slide's authored top-level elements in FILE order: on a design-system
 * slide the ones the template moved (by the index they had in the file), on
 * any other its own children less the engine's.
 */
function authoredList(sec) {
  const marked = [...sec.querySelectorAll('*')].filter((e) => fileIndexOf(e) !== undefined && e.closest('section') === sec);
  if (marked.length) return marked.sort((a, b) => fileIndexOf(a) - fileIndexOf(b));
  return [...sec.children].filter((c) => !c.matches(ENGINE_CHILD));
}
/** What the slide shows, in file order: the elements a move reorders. */
export const contentOf = (sec) => authoredList(sec).filter((c) => !c.matches(CARRIED));
/** An element's raw index among its slide's children in the file: what the element routes address. */
const rawIndexOf = (sec, el) => fileIndexOf(el) ?? authoredList(sec).indexOf(el);
/** Can this slide follow a move in its own DOM? Not one a template built, nor one with something live on it. */
const followsInPlace = (sec, instance) => !!instance.sync && !sec.hasAttribute('data-template') && !sec.querySelector(LIVE);
/** A node's siblings as the file has them (the engine's own left out). */
const fileSiblings = (node) => [...node.parentElement.children].filter((c) => !c.matches(INJECTED));

export function createElementMove({ root, instance, editmode, toast, select = () => {}, debugLog = () => {} }) {
  const keys = { up: IS_MAC ? '⌥↑' : 'Alt+↑', down: IS_MAC ? '⌥↓' : 'Alt+↓' };
  const slideOf = (sec) => instance._sections.indexOf(sec) + 1;

  async function post(body) {
    const p = (async () => {
      const res = await boundedFetch((editmode.base?.() ?? '') + '/deck/edit/element/move', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      editmode.noteHistory?.(j);
      if (!res.ok) throw new Error(j.error || String(res.status));
      return j;
    })();
    editmode.trackWrite?.(p);   // the undo chord waits for it
    return p;
  }

  /** The slide laid out and scanned for builds again, as a reload would have done it. */
  const relayout = (sec) => root.dispatchEvent(new CustomEvent('decklight:content', { detail: { slide: slideOf(sec), el: sec } }));

  /** After a reload: the element selected again, on the slide it moved on. */
  function remember(slide, index) {
    try { sessionStorage.setItem(RESELECT_KEY, JSON.stringify({ slide, index, t: Date.now() })); } catch { /* no storage: the slide is still the one shown */ }
  }
  function reselect() {
    let kept = null;
    try { kept = JSON.parse(sessionStorage.getItem(RESELECT_KEY) || 'null'); sessionStorage.removeItem(RESELECT_KEY); } catch { /* nothing kept */ }
    if (!kept || Date.now() - kept.t > 60_000) return;
    const sec = instance._sections[kept.slide - 1];
    const el = sec && authoredList(sec).find((e) => rawIndexOf(sec, e) === kept.index);
    if (el) select(el);
  }
  editmode.settled?.().then(() => setTimeout(() => { if (editmode.elementEditOn?.()) reselect(); }, 0));

  function refuse() {
    if (editmode.available?.()) return false;
    toast(editmode.cannot?.('moving an element') ?? 'moving an element needs write mode', 3200);
    return true;
  }

  /** Can the selection go one place up (`dir` -1) or down (+1)? The menu greys a row that cannot. */
  function canMove(target, dir) {
    const top = target?.top;
    const sec = top?.closest?.('section');
    if (!sec) return false;
    const content = contentOf(sec);
    const from = content.indexOf(top);
    return from >= 0 && from + dir >= 0 && from + dir < content.length;
  }

  /** Element `top` to place `to` among what its slide shows (file order). */
  async function moveTo(top, to, { said = null } = {}) {
    if (refuse()) return false;
    const sec = top.closest('section');
    const content = contentOf(sec);
    const from = content.indexOf(top);
    if (from < 0) return false;
    if (to === from) return false;
    if (to < 0) { toast('already first on the slide', 1600); return false; }
    if (to >= content.length) { toast('already last on the slide: the notes and sources stay below it', 2200); return false; }
    const slide = slideOf(sec);
    const index = rawIndexOf(sec, top);
    const inPlace = followsInPlace(sec, instance);
    if (!inPlace) remember(slide, rawIndexOf(sec, content[to]));
    const words = said ?? (to < from ? 'moved up' : 'moved down');
    try {
      const j = await post({ slide, index, tag: top.tagName.toLowerCase(), to, ...(inPlace ? { quiet: true, from: editmode.pageId?.() ?? null } : {}) });
      if (j.inPlace) {
        if (to > from) content[to].after(top); else content[to].before(top);
        relayout(sec);
        select(top);
        debugLog('edit', `slide ${slide}: element #${index} moved to ${to}, in place`);
        toast(words, 1200);
      } else {
        remember(slide, Number.isInteger(j.index) ? j.index : rawIndexOf(sec, content[to]));
        toast(`${words} — reloading`, 1600);
      }
      return true;
    } catch (e) {
      try { sessionStorage.removeItem(RESELECT_KEY); } catch { /* fine */ }
      toast(`could not move it: ${String(e.message || e)}`, 6000);
      return false;
    }
  }

  /** The selection one place up (`dir` -1) or down (+1): the menu's rows and ⌥↑ / ⌥↓. */
  function move(target, dir) {
    const top = target?.top;
    const sec = top?.closest?.('section');
    if (!sec) return Promise.resolve(false);
    const from = contentOf(sec).indexOf(top);
    if (from < 0) return Promise.resolve(false);
    return moveTo(top, from + dir);
  }

  /**
   * A node inside an element one place among its OWN siblings: a list item up
   * or down its list (⌥↑ / ⌥↓ while its words are edited). Resolves true once
   * it has moved, here or by the reload a design-system slide needs.
   */
  async function moveItem(node, dir) {
    if (refuse()) return false;
    const sec = node.closest('section');
    const top = sec && authoredTop(sec, node);
    if (!top || top === node) return false;
    const path = pathFrom(top, node);
    if (!path) { toast('that is the engine’s, not the file’s: nothing to move', 2600); return false; }
    const sibs = fileSiblings(node);
    const from = sibs.indexOf(node);
    const to = from + dir;
    const what = node.matches('li') ? 'item' : node.tagName.toLowerCase();
    if (to < 0) { toast(`already the first ${what}`, 1600); return false; }
    if (to >= sibs.length) { toast(`already the last ${what}`, 1600); return false; }
    const slide = slideOf(sec);
    const index = rawIndexOf(sec, top);
    const inPlace = followsInPlace(sec, instance);
    if (!inPlace) remember(slide, index);
    try {
      const j = await post({ slide, index, path, tag: node.tagName.toLowerCase(), to, ...(inPlace ? { quiet: true, from: editmode.pageId?.() ?? null } : {}) });
      if (j.inPlace) {
        if (to > from) sibs[to].after(node); else sibs[to].before(node);
        relayout(sec);
        toast(`${what} moved ${dir < 0 ? 'up' : 'down'}`, 1200);
      } else toast(`${what} moved — reloading`, 1600);
      return true;
    } catch (e) {
      try { sessionStorage.removeItem(RESELECT_KEY); } catch { /* fine */ }
      toast(`could not move it: ${String(e.message || e)}`, 6000);
      return false;
    }
  }

  // ── dragging the ⋯ handle ────────────────────────────────────────────────
  // A press on the handle that travels a few pixels is a drag: a line shows
  // where the element would land, between two of the slide's elements, and
  // letting go moves it there. A press that does not travel is the click that
  // opens the menu, as before. Esc gives the drag up.
  let drag = null;
  let swallowClick = false;
  const box = (el) => el.getBoundingClientRect();
  /** Do two boxes sit side by side (a split layout's columns) rather than one above the other? */
  const sideBySide = (a, b) => a && b && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5 * Math.min(a.height, b.height);

  /** Where a drop at (x, y) would put the element: `{ to, at }`, `at` the line to draw (root coordinates). */
  function dropAt(x, y) {
    const { peers, content, from } = drag;
    let best = null; let bestD = Infinity;
    for (const p of peers) {
      const r = box(p);
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const d = Math.hypot(dx, dy);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return null;
    const i = peers.indexOf(best);
    const r = box(best);
    const prev = i > 0 ? box(peers[i - 1]) : null;
    const next = i + 1 < peers.length ? box(peers[i + 1]) : null;
    const row = sideBySide(r, prev) || sideBySide(r, next);
    const before = row ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
    const slot = content.indexOf(best) + (before ? 0 : 1);
    const to = slot > from ? slot - 1 : slot;
    const base = root.getBoundingClientRect();
    const near = before ? prev : next;
    let at;
    if (row) {
      const edge = before ? (near && sideBySide(r, near) ? (near.right + r.left) / 2 : r.left - 8) : (near && sideBySide(r, near) ? (r.right + near.left) / 2 : r.right + 8);
      at = { left: edge - base.left, top: r.top - base.top, width: 0, height: r.height, row: true };
    } else {
      const edge = before ? (near && !sideBySide(r, near) && near.bottom <= r.top ? (near.bottom + r.top) / 2 : r.top - 8)
        : (near && !sideBySide(r, near) && near.top >= r.bottom ? (r.bottom + near.top) / 2 : r.bottom + 8);
      const lefts = peers.map((p) => box(p).left); const rights = peers.map((p) => box(p).right);
      at = { left: Math.min(...lefts) - base.left, top: edge - base.top, width: Math.max(...rights) - Math.min(...lefts), height: 0, row: false };
    }
    return { to, at };
  }

  function paintLine(d) {
    const line = drag.line;
    if (!d || d.to === drag.from) { line.hidden = true; return; }
    line.hidden = false;
    line.classList.toggle('dl-drop-row', d.at.row);
    Object.assign(line.style, { left: `${d.at.left}px`, top: `${d.at.top}px`, width: d.at.row ? '' : `${d.at.width}px`, height: d.at.row ? `${d.at.height}px` : '' });
  }

  function endDrag() {
    if (!drag) return;
    const { handle, top } = drag;
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    try { handle.releasePointerCapture?.(drag.pointerId); } catch { /* already released */ }
    drag.line?.remove();
    top.classList.remove('dl-move-src');
    root.classList.remove('dl-moving');
    drag = null;
  }
  function onMove(e) {
    if (!drag) return;
    if (!drag.on) {
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
      drag.on = true;
      root.classList.add('dl-moving');
      drag.top.classList.add('dl-move-src');
      drag.line = document.createElement('div');
      drag.line.className = 'dl-drop-line';
      drag.line.setAttribute('aria-hidden', 'true');
      drag.line.hidden = true;
      root.appendChild(drag.line);
    }
    drag.drop = dropAt(e.clientX, e.clientY);
    paintLine(drag.drop);
  }
  function onUp(e) {
    if (!drag) return;
    const was = drag;
    if (!was.on) { endDrag(); return; }   // a click: the menu opens, as it always did
    swallowClick = true;
    const d = dropAt(e.clientX, e.clientY) ?? was.drop;
    endDrag();
    if (d && d.to !== was.from) moveTo(was.top, d.to, { said: 'moved' });
  }
  function onCancel() { if (drag?.on) swallowClick = true; endDrag(); }
  function onKey(e) {
    if (!drag?.on || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    swallowClick = true;
    endDrag();
    toast('move given up', 1200);
  }

  /** A press on the selection's ⋯ handle: the start of a drag, if it travels. */
  function dragFrom(e, target, handle) {
    if (e.button !== 0 || drag || !editmode.available?.()) return;
    const top = target?.top;
    const sec = top?.closest?.('section');
    // a shape picked inside a diagram is not what the slide's order is made of
    if (!sec || (target.node && target.node !== top)) return;
    const content = contentOf(sec);
    const from = content.indexOf(top);
    // the places it could go: what shares its parent (on a template's slide, its slot)
    const peers = content.filter((c) => c.parentElement === top.parentElement);
    if (from < 0 || peers.length < 2) return;
    swallowClick = false;
    drag = { x0: e.clientX, y0: e.clientY, on: false, top, sec, content, peers, from, handle, pointerId: e.pointerId, line: null, drop: null };
    try { handle.setPointerCapture?.(e.pointerId); } catch { /* a synthetic press */ }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  }

  return {
    keys, canMove, move, moveTo, moveItem, dragFrom,
    /** Is a drag of the handle under way? */
    dragging: () => !!drag?.on,
    /** Was the click that just came a drag's end, not a click? Asked once, by the handle. */
    consumeClick: () => { const was = swallowClick; swallowClick = false; return was; },
  };
}
