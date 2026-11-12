// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Resize handles on a selected element (PRESENTING_EDITING): one set at a
 * time, shared by every kind of thing that resizes.
 *
 * - Corner handles (`nw ne sw se`) scale a picture, a diagram or a framed web
 *   page by its width, its height following (pictures.js).
 * - Side handles (`w e`) set how wide a block may be: a chart, text, a list, a
 *   quote, a table, code (block-resize.js).
 *
 * The drag is live: the element takes each width as the pointer moves, a
 * tag says the size, and one write lands on release. A width never passes
 * what the element's container holds, and a slide that fits when the drag
 * starts is kept fitting: past the width at which the slide would clip (wider
 * for a picture, narrower for text that wraps taller), the handle stops at
 * the last width that fit. A double-click on a handle puts the element back
 * to its own size.
 *
 * `mount(el, spec)` takes what differs between the kinds:
 *   handles   the corners or sides to draw
 *   label     what the element is called in a handle's title
 *   apply(el, w | null)   the element at `w` deck units wide, live (null: its own)
 *   snapshot(el) / restore(el, s)   what to put back on a refusal or no change
 *   max(el)   the widest it may be, in deck units
 *   min       the narrowest (default 16)
 *   commit(el, w)   the write on release
 *   reset(el)       the double-click
 */

const NAMES = { nw: 'top left', ne: 'top right', sw: 'bottom left', se: 'bottom right', w: 'left', e: 'right' };
export const CORNERS = ['nw', 'ne', 'sw', 'se'];
export const SIDES = ['w', 'e'];

/** Does the slide's content run past it? The overflow guardrail's own test, on the section (engine.js checkOverflow). */
export const overflows = (sec) => !!sec && sec.scrollHeight > sec.clientHeight + 2;

/**
 * The width a drag means: the pointer's travel along the axis that moved
 * most, in units of width (a corner moves `per` px on screen for each unit),
 * clamped to [min, max]. A side handle has no vertical axis (`perY` null).
 */
export function dragWidth({ w0, dx, dy, perX, perY = null, east, south = false, min = 16, max }) {
  const byX = (east ? dx : -dx) / (perX || 1);
  const byY = perY ? (south ? dy : -dy) / perY : 0;
  const dw = Math.abs(byX) >= Math.abs(byY) ? byX : byY;
  return Math.round(Math.min(Math.max(w0 + dw, min), Math.max(min, max)));
}

/** The widest a block may be inside `parent`: its content box, in deck units. */
export function contentWidth(parent) {
  if (!parent) return Infinity;
  const cs = getComputedStyle(parent);
  return parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

export function createResizeHandles({ root, instance, editmode, toast, say = (w) => `${w} needs write mode` }) {
  let el = null;
  let spec = null;
  let handles = [];
  let sizeTag = null;
  let following = 0;
  let drag = null;
  const scale = () => instance()?._scale || 1;

  function place() {
    if (!el?.isConnected) { unmount(); return; }
    const r = el.getBoundingClientRect();
    const b = root.getBoundingClientRect();
    // on the selection's outline, which stands 4px off the element
    const x = { w: r.left - b.left - 4, e: r.right - b.left + 4 };
    const y = { n: r.top - b.top - 4, s: r.bottom - b.top + 4, m: (r.top + r.bottom) / 2 - b.top };
    for (const h of handles) {
      const c = h.dataset.corner;
      h.style.left = `${x[c.length === 2 ? c[1] : c]}px`;
      h.style.top = `${y[c.length === 2 ? c[0] : 'm']}px`;
    }
    if (sizeTag) {
      sizeTag.style.left = `${(r.left + r.right) / 2 - b.left}px`;
      sizeTag.style.top = `${r.bottom - b.top + 10}px`;
    }
  }
  function follow() {
    cancelAnimationFrame(following);
    let last = '';
    const tick = () => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const box = `${r.left},${r.top},${r.width},${r.height}`;
      if (box !== last) { last = box; place(); }
      following = requestAnimationFrame(tick);
    };
    following = requestAnimationFrame(tick);
  }

  /** Handles on `node`, by `s` (above); none when nothing is given. */
  function mount(node, s) {
    unmount();
    if (!node || !s || !editmode()?.available?.()) return;
    el = node;
    spec = s;
    root.classList.add('dl-pic-handles');
    handles = s.handles.map((c) => {
      const h = document.createElement('button');
      h.type = 'button';
      h.className = `dl-pic-handle dl-pic-${c}`;
      h.dataset.corner = c;
      h.title = `drag to resize · double-click for its own size`;
      h.setAttribute('aria-label', `resize the ${s.label} from its ${NAMES[c]} ${c.length === 2 ? 'corner' : 'side'}`);
      h.addEventListener('mousedown', (e) => e.preventDefault());
      h.addEventListener('click', (e) => e.stopPropagation());
      h.addEventListener('pointerdown', (e) => startDrag(e, c));
      h.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); spec?.reset?.(el); });
      root.appendChild(h);
      return h;
    });
    place();
    follow();
  }
  function unmount() {
    cancelAnimationFrame(following);
    // only what this set put up: another set (a picture's, a block's) may be up
    if (el) root.classList.remove('dl-pic-handles');
    for (const h of handles) h.remove();
    handles = [];
    sizeTag?.remove();
    sizeTag = null;
    el = null;
    spec = null;
  }

  function startDrag(e, corner) {
    if (e.button !== 0 || !el) return;
    e.preventDefault();
    e.stopPropagation();
    if (!editmode()?.available?.()) { toast(say(`resizing the ${spec.label}`), 3200); return; }
    const node = el, s = spec, k = scale();
    const was = s.snapshot(node);
    const r0 = node.getBoundingClientRect();
    const w0 = Math.round(r0.width / k);
    const aspect = r0.height / (r0.width || 1);
    const side = corner.length === 1;
    const east = corner.endsWith('e'), south = corner[0] === 's';
    // how far a unit of width moves this handle on screen: once the scale for
    // an element anchored on the other side, twice for a centred one
    s.apply(node, w0 + 20);
    const r1 = node.getBoundingClientRect();
    s.restore(node, was);
    const perX = Math.max(k * 0.5, Math.abs(east ? r1.right - r0.right : r0.left - r1.left) / 20);
    const perY = side ? null : Math.max(k * 0.5 * aspect, Math.abs(south ? r1.bottom - r0.bottom : r0.top - r1.top) / 20);
    const sec = node.closest('section');
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, w0, w: w0, perX, perY, east, south, max: Math.floor(s.max(node)), min: s.min ?? 16, was, node, s, sec, fits: !overflows(sec), aspect };
    root.classList.add('dl-pic-resizing');
    sizeTag = Object.assign(document.createElement('div'), { className: 'dl-pic-size' });
    root.appendChild(sizeTag);
    sizeTag.textContent = side ? `${w0} wide` : `${w0} × ${Math.round(w0 * aspect)}`;
    place();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    let w = dragWidth({ w0: d.w0, dx: e.clientX - d.x, dy: e.clientY - d.y, perX: d.perX, perY: d.perY, east: d.east, south: d.south, min: d.min, max: d.max });
    if (w === d.w) return;
    d.s.apply(d.node, w);
    if (d.fits && overflows(d.sec)) {
      // the width nearest the pointer that still fits, between the last that did and this one
      let ok = d.w, bad = w;
      while (Math.abs(bad - ok) > 1) {
        const mid = Math.round((ok + bad) / 2);
        d.s.apply(d.node, mid);
        if (overflows(d.sec)) bad = mid; else ok = mid;
      }
      w = ok;
      d.s.apply(d.node, w);
    }
    d.w = w;
    d.moved = true;
    const r = d.node.getBoundingClientRect();
    if (sizeTag) sizeTag.textContent = d.perY === null ? `${w} wide` : `${w} × ${Math.round(r.height / scale())}`;
    place();
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    const d = drag;
    drag = null;
    root.classList.remove('dl-pic-resizing');
    sizeTag?.remove();
    sizeTag = null;
    // a drag released off its handle clicks whatever is under it, which would
    // let go of the element: that one click is the drag's, not the slide's
    if (d.moved) {
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    }
    if (d.w === d.w0) { d.s.restore(d.node, d.was); return; }
    d.s.commit(d.node, d.w, d.was);
  }

  return {
    mount, unmount, place,
    /** The element wearing the handles (a harness reads it), and whether a drag is on. */
    current: () => el,
    dragging: () => !!drag,
  };
}
