// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Pictures after the drop (PRESENTING_EDITING, write mode).
 *
 * A dropped or chosen picture became an `<img>`, and from then on the HTML was
 * the only way to change it. Here is what can be done to it instead:
 *
 *   RESIZE: a selected picture wears four corner handles. Dragging one
 *   resizes it live, its aspect kept, and one write lands on release: its
 *   `width` in deck units (the stage is a fixed design size scaled to the
 *   window, so a size in screen pixels would mean another size on another
 *   screen), which survives a theme change because every theme's
 *   `max-width: 100%` still caps it. A double-click on a handle is the
 *   picture's own size again. A drag never makes the picture bigger than the
 *   slide, and on a slide that fits it stops where the rest of the slide's
 *   content would start to clip; the overflow guardrail still judges after.
 *
 *   ALT AND REPLACE: the inspector's Info tab edits the alt text in place
 *   and offers Replace…, which uploads a new file and points the same
 *   `<img>` at it, its size and alt kept.
 *
 *   BACKGROUND: Slide ▸ Background picture… and Remove background, and the
 *   element menu's Use as slide background on a picture, which moves it out
 *   of the content and onto the slide's `data-background-image` in one edit.
 *
 *   CAPTION: Add caption wraps the picture in a `<figure>` whose
 *   `<figcaption>` goes straight into inline editing.
 *
 * Every write is quiet (`quiet: true, from`): this page makes the change
 * itself, at once, and every other page of the deck is told and reloads.
 */

import { boundedFetch } from './devmode.js';
import { pathFrom } from './colorpicker.js';
import { imageFiles } from './authoring.js';

/** The bounds the server writes a width within (cli/edit.mjs PICTURE_WIDTH), in deck units. */
export const PICTURE_MIN = 16;
export const PICTURE_MAX = 4096;
const CORNERS = ['nw', 'ne', 'sw', 'se'];

/** Does the slide's content run past it? The overflow guardrail's own test, on the section (engine.js checkOverflow). */
const overflows = (sec) => sec.scrollHeight > sec.clientHeight + 2;

/** The picture a selection is about: the `<img>` itself, selected or picked inside a figure or a column. */
export function pictureOf(target) {
  const n = target?.node ?? target?.top;
  return n?.tagName === 'IMG' && n.isConnected ? n : null;
}

/**
 * The width a corner drag asks for, in deck units: from where it started
 * (`w0`), how far the pointer went (`dx`, `dy`, screen px), how far a unit of
 * width moves that corner on screen (`perX`, `perY`, screen px per deck unit:
 * the stage scale for a picture held at its other side, half of it for a
 * centred one, which grows on both sides), and which way the corner faces. The axis the pointer moved further
 * along wins; the answer is whole and inside `[PICTURE_MIN, max]`.
 */
export function dragWidth({ w0, dx, dy, perX, perY, east, south, max }) {
  const byX = (east ? dx : -dx) / (perX || 1);
  const byY = (south ? dy : -dy) / (perY || 1);
  const dw = Math.abs(byX) >= Math.abs(byY) ? byX : byY;
  return Math.round(Math.min(Math.max(w0 + dw, PICTURE_MIN), Math.max(PICTURE_MIN, Math.min(max, PICTURE_MAX))));
}

export function createPictures({
  root, instance, editmode, editbar, authoring, toast, debugLog = () => {},
  refreshBackground = () => {}, inspector = () => null,
}) {
  const base = () => editmode.base?.() ?? '';
  const pageId = () => editmode.pageId?.() ?? null;
  const say = (what) => editmode.cannot?.(what) ?? `${what} needs write mode`;

  /** One write, tracked for the undo chord, its counts noted for the bar. */
  function post(path, body) {
    const p = (async () => {
      const res = await boundedFetch(base() + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, quiet: true, from: pageId() }),
      });
      const j = await res.json().catch(() => ({}));
      editmode.noteHistory?.(j);
      if (!res.ok || j.ok === false) throw new Error(j.error || `the edit server answered ${res.status}`);
      return j;
    })();
    editmode.trackWrite?.(p);
    return p;
  }

  /** A picture file to the deck's assets/, through the drop's own route: its path beside the deck. */
  async function upload(file) {
    if (!imageFiles([file]).length) throw new Error('that is not a picture: PNG, JPEG, GIF, WebP, SVG or AVIF');
    const res = await fetch(base() + '/deck/edit/asset', {
      method: 'POST', headers: { 'content-type': file.type, 'x-decklight-name': file.name }, body: file,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || String(res.status));
    return j.src;
  }

  // The file chooser: a fresh input each time, so choosing the same file twice
  // still says so. A harness hands in its own (`setChooser`).
  let chooser = () => new Promise((done) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', className: 'eb-file' });
    input.setAttribute('aria-label', 'picture');
    input.addEventListener('change', () => { done(input.files?.[0] ?? null); input.remove(); });
    input.addEventListener('cancel', () => { done(null); input.remove(); });
    root.appendChild(input);
    input.click();
  });

  /** Where `img` is in the FILE: `{ slide, index, path, tag, sec, top }`, or null when the file has no such node. */
  function addressOf(img) {
    const t = editmode.elementTargetOf?.(img);
    if (!t?.top || t.index === null || t.index < 0) return null;
    const path = t.top === img ? [] : pathFrom(t.top, img);
    return path ? { slide: t.slide, index: t.index, path, tag: 'img', sec: t.sec, top: t.top } : null;
  }

  /** The slide was changed in place: rescanned and laid out again, as a reload would have (engine.js). */
  const announce = (slide, el) => root.dispatchEvent(new CustomEvent('decklight:content', { detail: { slide, el } }));

  // ── the handles ─────────────────────────────────────────────────────────
  let img = null;        // the picture wearing them
  let handles = [];
  let sizeTag = null;    // the size, said while a drag is on
  let following = 0;
  let drag = null;

  function place() {
    if (!img?.isConnected) { unmount(); return; }
    const r = img.getBoundingClientRect();
    const b = root.getBoundingClientRect();
    // on the selection's outline, which stands 4px off the picture
    const x = { w: r.left - b.left - 4, e: r.right - b.left + 4 };
    const y = { n: r.top - b.top - 4, s: r.bottom - b.top + 4 };
    for (const h of handles) {
      const c = h.dataset.corner;
      h.style.left = `${x[c[1]]}px`;
      h.style.top = `${y[c[0]]}px`;
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
      if (!img) return;
      const r = img.getBoundingClientRect();
      const box = `${r.left},${r.top},${r.width},${r.height}`;
      if (box !== last) { last = box; place(); }
      following = requestAnimationFrame(tick);
    };
    following = requestAnimationFrame(tick);
  }
  function mount(pic) {
    unmount();
    // a full-bleed picture covers the slide: there is nothing to resize
    if (!pic || pic.classList.contains('full-bleed') || !editmode.available?.()) return;
    img = pic;
    root.classList.add('dl-pic-handles');
    handles = CORNERS.map((c) => {
      const h = document.createElement('button');
      h.type = 'button';
      h.className = `dl-pic-handle dl-pic-${c}`;
      h.dataset.corner = c;
      h.title = 'drag to resize · double-click for its own size';
      h.setAttribute('aria-label', `resize the picture from its ${{ nw: 'top left', ne: 'top right', sw: 'bottom left', se: 'bottom right' }[c]} corner`);
      h.addEventListener('mousedown', (e) => e.preventDefault());
      h.addEventListener('click', (e) => e.stopPropagation());
      h.addEventListener('pointerdown', (e) => startDrag(e, c));
      h.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); naturalSize(); });
      root.appendChild(h);
      return h;
    });
    place();
    follow();
  }
  function unmount() {
    cancelAnimationFrame(following);
    for (const h of handles) h.remove();
    handles = [];
    sizeTag?.remove();
    sizeTag = null;
    root.classList.remove('dl-pic-handles');
    img = null;
  }
  editbar.onSelect?.((t) => { if (!drag) mount(pictureOf(t)); });

  /** What the picture's size is in the markup, to put back when a write is refused. */
  const sizeOf = (pic) => ({ width: pic.getAttribute('width'), height: pic.getAttribute('height'), sw: pic.style.width, sh: pic.style.height });
  function putSize(pic, s) {
    for (const k of ['width', 'height']) { if (s[k] === null) pic.removeAttribute(k); else pic.setAttribute(k, s[k]); }
    pic.style.width = s.sw; pic.style.height = s.sh;
  }
  /** The picture at `w` deck units wide, as the file will have it: the width attribute, nothing fighting it. */
  function setWidth(pic, w) {
    if (w === null) pic.removeAttribute('width'); else pic.setAttribute('width', String(w));
    pic.removeAttribute('height');
    pic.style.removeProperty('width');
    pic.style.removeProperty('height');
  }

  function startDrag(e, corner) {
    if (e.button !== 0 || !img) return;
    e.preventDefault();
    e.stopPropagation();
    if (!editmode.available?.()) { toast(say('resizing a picture'), 3200); return; }
    const pic = img;
    const scale = instance._scale || 1;
    const was = sizeOf(pic);
    const r0 = pic.getBoundingClientRect();
    const w0 = Math.round(r0.width / scale);
    const aspect = r0.height / (r0.width || 1);
    // how far a unit of width moves this corner on screen: once the scale for
    // a picture anchored on the other side, twice for a centred one
    const east = corner[1] === 'e', south = corner[0] === 's';
    setWidth(pic, w0 + 20);
    const r1 = pic.getBoundingClientRect();
    putSize(pic, was);
    const perX = Math.max(scale * 0.5, Math.abs(east ? r1.right - r0.right : r0.left - r1.left) / 20);
    const perY = Math.max(scale * 0.5 * aspect, Math.abs(south ? r1.bottom - r0.bottom : r0.top - r1.top) / 20);
    // never bigger than the slide's own content box holds
    const sec = pic.closest('section');
    const cs = getComputedStyle(sec);
    const innerW = sec.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const innerH = sec.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const max = Math.floor(Math.min(innerW, innerH / (aspect || 1)));
    // a slide that fits when the drag starts is kept fitting: the picture
    // grows only as far as the room the rest of the slide leaves it
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, w0, w: w0, perX, perY, east, south, max, was, pic, sec, fits: !overflows(sec) };
    root.classList.add('dl-pic-resizing');
    sizeTag = Object.assign(document.createElement('div'), { className: 'dl-pic-size' });
    root.appendChild(sizeTag);
    sizeTag.textContent = `${w0} × ${Math.round(w0 * aspect)}`;
    place();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    let w = dragWidth({ w0: drag.w0, dx: e.clientX - drag.x, dy: e.clientY - drag.y, perX: drag.perX, perY: drag.perY, east: drag.east, south: drag.south, max: drag.max });
    if (w === drag.w) return;
    setWidth(drag.pic, w);
    if (drag.fits && w > drag.w && overflows(drag.sec)) {
      // the widest that still fits, between the last that did and this one
      let lo = drag.w, hi = w;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        setWidth(drag.pic, mid);
        if (overflows(drag.sec)) hi = mid; else lo = mid;
      }
      w = lo;
      setWidth(drag.pic, w);
    }
    drag.w = w;
    drag.moved = true;
    const r = drag.pic.getBoundingClientRect();
    if (sizeTag) sizeTag.textContent = `${w} × ${Math.round(r.height / (instance._scale || 1))}`;
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
    // let go of the picture: that one click is the drag's, not the slide's
    if (d.moved) {
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    }
    if (d.w === d.w0) { putSize(d.pic, d.was); return; }
    savePicture(d.pic, { width: d.w }, { undo: () => putSize(d.pic, d.was), said: `picture ${d.w} wide` });
  }
  function naturalSize() {
    const pic = img;
    if (!pic) return;
    if (!editmode.available?.()) { toast(say('resizing a picture'), 3200); return; }
    const was = sizeOf(pic);
    if (was.width === null && was.height === null && !was.sw && !was.sh) { toast('the picture is at its own size already', 2000); return; }
    setWidth(pic, null);
    savePicture(pic, { width: null }, { undo: () => putSize(pic, was), said: 'picture at its own size' });
  }

  /**
   * One picture write, the page already showing it: `fields` to the server,
   * the slide laid out again on success, `undo()` putting the page back on a
   * refusal. Resolves to the server's answer, or null when it was refused.
   */
  async function savePicture(pic, fields, { undo = () => {}, said = 'picture saved' } = {}) {
    const at = addressOf(pic);
    if (!at) { undo(); toast('that picture is the engine’s, not the file’s: nothing to change', 2600); return null; }
    try {
      const j = await post('/deck/edit/element/picture', { slide: at.slide, index: at.index, path: at.path, tag: at.tag, ...fields });
      announce(at.slide, pic);
      inspector()?.refresh?.();
      debugLog('edit', `${said} · slide ${at.slide} #${at.index}${at.path.length ? ` › ${at.path.join('.')}` : ''}`);
      return j;
    } catch (e) {
      undo();
      toast(`the picture was not changed: ${String(e.message || e)}`, 6000);
      return null;
    }
  }

  // ── alt text and replace (the inspector's Info tab) ─────────────────────
  async function setAlt(pic, text) {
    if (!editmode.available?.()) { toast(say('changing alt text'), 3200); return false; }
    const alt = String(text ?? '').replace(/\s+/g, ' ').trim();
    const had = pic.getAttribute('alt');
    if (had === alt) return true;
    pic.setAttribute('alt', alt);
    const j = await savePicture(pic, { alt }, { undo: () => { if (had === null) pic.removeAttribute('alt'); else pic.setAttribute('alt', had); }, said: 'alt text saved' });
    if (j) toast(alt ? 'alt text saved' : 'alt text cleared: the picture reads as decoration', 1800);
    return !!j;
  }
  async function replace(pic) {
    if (!editmode.available?.()) { toast(say('replacing a picture'), 3200); return; }
    const file = await chooser();
    if (!file) return;
    try {
      const src = await upload(file);
      const was = pic.getAttribute('src');
      pic.setAttribute('src', src);
      const j = await savePicture(pic, { src }, { undo: () => pic.setAttribute('src', was), said: `picture replaced by ${src}` });
      if (j) {
        toast(`replaced by ${src}`, 2000);
        // the new file has its own shape: laid out again once it is decoded
        pic.decode?.().then(() => { announce(addressOf(pic)?.slide ?? instance.state.slide, pic); inspector()?.refresh?.(); }, () => {});
      }
    } catch (e) {
      toast(`could not replace the picture: ${String(e.message || e)}`, 6000);
    }
  }

  // ── the slide's background ──────────────────────────────────────────────
  const TUNING = ['data-background-size', 'data-background-position', 'data-background-dim'];
  const sectionAt = (slide) => instance._sections[slide - 1];
  async function chooseBackground(slide = instance.state.slide) {
    if (!editmode.available?.()) { toast(say('setting a background'), 3200); return; }
    const file = await chooser();
    if (!file) return;
    try {
      const src = await upload(file);
      await post('/deck/edit/slide/background', { slide, src });
      const sec = sectionAt(slide);
      sec?.setAttribute('data-background-image', src);
      if (sec) refreshBackground(sec);
      toast(`slide ${slide}'s background is ${src}`, 2000);
    } catch (e) {
      toast(`the background was not set: ${String(e.message || e)}`, 6000);
    }
  }
  async function removeBackground(slide = instance.state.slide) {
    if (!editmode.available?.()) { toast(say('removing a background'), 3200); return; }
    try {
      await post('/deck/edit/slide/background', { slide, src: null });
      const sec = sectionAt(slide);
      if (!sec) return;
      sec.removeAttribute('data-background-image');
      if (!sec.hasAttribute('data-background-video')) for (const a of TUNING) sec.removeAttribute(a);
      refreshBackground(sec);
      toast(`slide ${slide}'s background removed`, 1800);
    } catch (e) {
      toast(`the background was not removed: ${String(e.message || e)}`, 6000);
    }
  }
  async function toBackground(pic) {
    if (!editmode.available?.()) { toast(say('setting a background'), 3200); return; }
    const at = addressOf(pic);
    if (!at) { toast('that picture is the engine’s, not the file’s', 2600); return; }
    try {
      const j = await post('/deck/edit/slide/background', { slide: at.slide, take: { index: at.index, path: at.path, tag: at.tag } });
      editbar.deselect?.();
      // what the file lost, the page loses: the picture, or the figure it emptied
      (Array.isArray(j.removed) && j.removed.length < at.path.length ? pic.parentElement : pic).remove();
      at.sec.setAttribute('data-background-image', j.src);
      refreshBackground(at.sec);
      announce(at.slide, at.sec);
      toast(`the picture is slide ${at.slide}'s background now`, 2200);
    } catch (e) {
      toast(`the picture did not become the background: ${String(e.message || e)}`, 6000);
    }
  }

  // ── a caption ───────────────────────────────────────────────────────────
  const inFigure = (pic) => pic.parentElement?.tagName === 'FIGURE';
  async function addCaption(pic) {
    if (!editmode.available?.()) { toast(say('adding a caption'), 3200); return; }
    if (inFigure(pic)) { toast('this picture has a caption already', 2200); return; }
    const at = addressOf(pic);
    if (!at) { toast('that picture is the engine’s, not the file’s', 2600); return; }
    const words = 'Caption';
    try {
      await post('/deck/edit/element/picture', { slide: at.slide, index: at.index, path: at.path, tag: at.tag, caption: words });
      editbar.deselect?.();
      const fig = document.createElement('figure');
      const cap = Object.assign(document.createElement('figcaption'), { textContent: words });
      // the page wraps it as the file did: whatever the <img> carried stays on it
      pic.before(fig);
      fig.append(pic, cap);
      announce(at.slide, fig);
      // straight into its words, all of them selected, so typing replaces them
      if (authoring?.editInline?.(cap)) {
        const range = document.createRange();
        range.selectNodeContents(cap);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e) {
      toast(`no caption added: ${String(e.message || e)}`, 6000);
    }
  }

  return {
    /** The element menu's rows for a target (editmode.js): a picture's own, or none. */
    elementRows(target) {
      const pic = pictureOf(target);
      if (!pic || !editmode.available?.()) return [];
      return [
        { label: 'Use as slide background', run: () => toBackground(pic) },
        ...(inFigure(pic) ? [] : [{ label: 'Add caption', run: () => addCaption(pic) }]),
      ];
    },
    /** Slide ▸'s rows: a background picture to choose, and one to take off when the slide has one. */
    slideRows(slide = instance.state.slide) {
      if (!editmode.available?.()) return [];
      const sec = sectionAt(slide);
      return [
        { label: sec?.hasAttribute('data-background-image') ? 'Change background picture…' : 'Background picture…', run: () => chooseBackground(slide) },
        ...(sec?.hasAttribute('data-background-image') ? [{ label: 'Remove background', run: () => removeBackground(slide) }] : []),
      ];
    },
    setAlt, replace, chooseBackground, removeBackground, toBackground, addCaption,
    /** Can this page change pictures? The inspector shows its alt field and Replace… only then. */
    editable: () => editmode.available?.() === true,
    /** The picture wearing the handles (a harness reads it). */
    handled: () => img,
    /** Stand in for the file chooser (`() => Promise<File|null>`): what a harness does. */
    setChooser: (fn) => { chooser = fn; },
  };
}
