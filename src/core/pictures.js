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
 *   element menu's Picture ▸ Use as slide background, which moves it out
 *   of the content and onto the slide's `data-background-image` in one edit.
 *
 *   CAPTION: Picture ▸ Add caption wraps the picture in a `<figure>` on the
 *   page at once, its `<figcaption>` being typed; the file gets both in ONE
 *   write when the typing ends, so one undo takes the caption back, and Esc
 *   writes nothing.
 *
 *   Picture ▸ also offers Replace… and Reset size (the handles' double-click).
 *
 * Every write is quiet (`quiet: true, from`): this page makes the change
 * itself, at once, and every other page of the deck is told and reloads.
 */

import { pathFrom } from './colorpicker.js';
import { imageFiles } from './authoring.js';
import { createEditCommit } from './edit-commit.js';
import { createResizeHandles, CORNERS, contentWidth, dragWidth as dragAny } from './resize-handles.js';

/** The bounds the server writes a width within (cli/edit.mjs PICTURE_WIDTH), in deck units. */
export const PICTURE_MIN = 16;
export const PICTURE_MAX = 4096;


/** The picture a selection is about: the `<img>` itself, selected or picked inside a figure or a column. */
export function pictureOf(target) {
  const n = target?.node ?? target?.top;
  return n?.tagName === 'IMG' && n.isConnected ? n : null;
}

/**
 * What a selection sizes by its width, with corner handles: a picture, a
 * diagram selected whole (its canvas, not a shape in it), or a framed web
 * page. Null for anything else.
 */
export function sizedOf(target) {
  const n = target?.node ?? target?.top;
  if (!n?.isConnected) return null;
  if (n.tagName === 'IMG' || n.tagName === 'IFRAME') return n;
  return n.tagName === 'svg' && !n.parentElement?.closest('svg') && !n.closest('[data-chart]') ? n : null;
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
  return dragAny({ w0, dx, dy, perX, perY, east, south, min: PICTURE_MIN, max: Math.min(max, PICTURE_MAX) });
}

export function createPictures({
  root, instance, editmode, editbar, authoring, toast, debugLog = () => {}, inspector = () => null,
}) {
  const base = () => editmode.base?.() ?? '';
  const say = (what) => editmode.cannot?.(what) ?? `${what} needs write mode`;
  // one quiet write each, tracked for the undo chord (edit-commit.js)
  const commit = createEditCommit(editmode);
  const post = commit.post;

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
    return path ? { slide: t.slide, index: t.index, path, tag: img.tagName.toLowerCase(), sec: t.sec, top: t.top } : null;
  }

  /** The slide was changed in place: rescanned and laid out again, as a reload would have (engine.js). */
  const announce = (slide, el) => instance.refreshSlide?.(instance._sections?.[slide - 1], { scan: el });
  /** A background is the engine's to draw: its layer again for the one slide, and the bleed when it is on screen. */
  const refreshBackground = (sec) => instance.refreshSlide?.(sec, { background: true, scan: false });

  // ── the handles (resize-handles.js) ──────────────────────────────────────
  // corners on a picture, a diagram or a framed web page, scaling it by its width
  const handles = createResizeHandles({ root, instance: () => instance, editmode: () => editmode, toast, say });
  const LABEL = { IMG: 'picture', svg: 'diagram', IFRAME: 'web page' };
  /** What sizes a picture, a diagram or a frame on the page, as the file will have it: the width alone. */
  const SIZING = {
    handles: CORNERS,
    snapshot: (pic) => sizeOf(pic),
    restore: (pic, s) => putSize(pic, s),
    apply: (pic, w) => setWidth(pic, w),
    // never bigger than the slide's own content box holds, either way
    max: (pic) => {
      const sec = pic.closest('section');
      const r = pic.getBoundingClientRect();
      const aspect = r.height / (r.width || 1);
      const cs = getComputedStyle(sec);
      const innerH = sec.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      return Math.min(contentWidth(sec), innerH / (aspect || 1), PICTURE_MAX);
    },
    min: PICTURE_MIN,
    commit: (pic, w, was) => savePicture(pic, { width: w }, { undo: () => putSize(pic, was), said: `${labelOf(pic)} ${w} wide` }),
    reset: (pic) => naturalSize(pic),
  };
  const labelOf = (pic) => LABEL[pic.tagName] ?? 'picture';
  function mount(pic) {
    // a full-bleed picture covers the slide: there is nothing to resize
    if (!pic || pic.classList.contains('full-bleed')) { handles.unmount(); return; }
    handles.mount(pic, { ...SIZING, label: labelOf(pic) });
  }
  editbar.onSelect?.((t) => { if (!handles.dragging()) mount(sizedOf(t)); });

  /** What the element's size is in the markup, to put back when a write is refused. */
  const sizeOf = (pic) => ({ width: pic.getAttribute('width'), height: pic.getAttribute('height'), sw: pic.style.width, sh: pic.style.height });
  function putSize(pic, s) {
    for (const k of ['width', 'height']) { if (s[k] === null) pic.removeAttribute(k); else pic.setAttribute(k, s[k]); }
    pic.style.width = s.sw; pic.style.height = s.sh;
  }
  /** The element at `w` deck units wide, as the file will have it: the width attribute, nothing fighting it. */
  function setWidth(pic, w) {
    if (w === null) pic.removeAttribute('width'); else pic.setAttribute('width', String(w));
    pic.removeAttribute('height');
    pic.style.removeProperty('width');
    pic.style.removeProperty('height');
  }

  /** Has `pic` a size in the markup (a width, a height, an inline one) for Reset size to take off? */
  const sized = (pic) => { const s = sizeOf(pic); return s.width !== null || s.height !== null || !!s.sw || !!s.sh; };
  /** The picture at its own size again: a double-click on a handle, or Picture ▸ Reset size. */
  function naturalSize(pic = handles.current()) {
    if (!pic) return;
    if (!editmode.available?.()) { toast(say('resizing a picture'), 3200); return; }
    const was = sizeOf(pic);
    if (!sized(pic)) { toast(`the ${labelOf(pic)} is at its own size already`, 2000); return; }
    setWidth(pic, null);
    savePicture(pic, { width: null }, { undo: () => putSize(pic, was), said: `${labelOf(pic)} at its own size` });
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
      toast(`the picture was not changed: ${commit.why(e)}`, 6000);
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
      toast(`could not replace the picture: ${commit.why(e)}`, 6000);
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
      toast(`the background was not set: ${commit.why(e)}`, 6000);
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
      toast(`the background was not removed: ${commit.why(e)}`, 6000);
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
      instance.refreshSlide?.(at.sec, { background: true });
      toast(`the picture is slide ${at.slide}'s background now`, 2200);
    } catch (e) {
      toast(`the picture did not become the background: ${commit.why(e)}`, 6000);
    }
  }

  // ── a caption ───────────────────────────────────────────────────────────
  const inFigure = (pic) => pic.parentElement?.tagName === 'FIGURE';
  async function addCaption(pic) {
    if (!editmode.available?.()) { toast(say('adding a caption'), 3200); return; }
    if (inFigure(pic)) { toast('this picture has a caption already', 2200); return; }
    const at = addressOf(pic);
    if (!at) { toast('that picture is the engine’s, not the file’s', 2600); return; }
    // The figure and its caption are on the page at once, the caption being
    // typed; the file gets them in ONE write when the typing ends (⏎, or
    // leaving), with the words typed, so one undo takes the caption back.
    // Esc, or no words, writes nothing and puts the picture back as it was.
    editbar.deselect?.();
    const fig = document.createElement('figure');
    const cap = Object.assign(document.createElement('figcaption'), { textContent: 'Caption' });
    // the page wraps it as the file will: whatever the <img> carried stays on it
    pic.before(fig);
    fig.append(pic, cap);
    announce(at.slide, fig);
    const unwrap = () => {
      if (!fig.isConnected) return;
      fig.before(pic);
      fig.remove();
      announce(at.slide, pic);
    };
    const provisional = {
      cancel: unwrap,
      async save(el) {
        const words = el.textContent.replace(/\s+/g, ' ').trim();
        if (!words) { unwrap(); return; }
        el.textContent = words;   // what the file gets: one line of words
        try {
          await post('/deck/edit/element/picture', { slide: at.slide, index: at.index, path: at.path, tag: at.tag, caption: words });
          announce(at.slide, fig);
          debugLog('edit', `caption added · slide ${at.slide} #${at.index}`);
        } catch (e) {
          unwrap();
          toast(`no caption added: ${commit.why(e)}`, 6000);
        }
      },
    };
    // straight into its words, all of them selected, so typing replaces them
    if (!authoring?.editInline?.(cap, { selectAll: true, provisional })) {
      unwrap();
      toast('no caption added: this page cannot type into it', 3200);
    }
  }

  return {
    /**
     * Picture ▸'s rows for a target (editmode.js): a picture's own, or none.
     * Always the same four, in order; one that cannot act is `disabled` (a
     * caption it has already, a size that is its own).
     */
    elementRows(target) {
      const pic = pictureOf(target);
      if (!pic || !editmode.available?.()) return [];
      return [
        { label: 'Replace…', run: () => replace(pic) },
        { label: 'Add caption', disabled: inFigure(pic), run: () => addCaption(pic) },
        { label: 'Use as slide background', run: () => toBackground(pic) },
        { label: 'Reset size', disabled: !sized(pic), run: () => naturalSize(pic) },
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
    handled: () => handles.current(),
    /** Stand in for the file chooser (`() => Promise<File|null>`): what a harness does. */
    setChooser: (fn) => { chooser = fn; },
  };
}
