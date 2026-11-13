// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The clipboard in write mode (SPEC PRESENTING_EDITING).
//
// ⌘V / Ctrl+V used to be the browser's alone, which pastes nowhere on a
// slide. Here one `paste` listener on the document reads what the system
// clipboard carries (the system one, not a store of our own, because it is
// what crosses from a screenshot tool, a browser, another deck's tab) and
// hands it to whatever takes that kind: a picture goes on the slide as a
// dropped file does, another app's words become a paragraph, or a list when
// they are several lines (add-content.js), and an element copied from a deck
// (this one or another, in any tab) goes after the selection. ⌘C and ⌘X on a
// selected element put it on the clipboard as the FILE has it (its builds,
// colours and classes, never the page the engine decorated), behind a comment
// that marks it as the editor's own, with its words as plain text for any other app.
//
// The listener stands aside wherever the typing guard does: a box being typed
// in, words being edited (authoring.js cleans that paste itself), a locked
// deck, an embedded or printed one.

import { imageFiles } from './authoring.js';
import { innerPath } from './editbar.js';
import { pastedWords } from './list-edit.js';

/** The comment a copied element starts with in the clipboard's html: no new attribute, and a paste knows it is ours. */
export const ELEMENT_MARK = '<!--decklight:element-->';
/** A diagram's shape: copied and pasted inside its own diagram, the way Duplicate does it. */
export const SHAPE_MARK = '<!--decklight:shape-->';
/** A whole slide (Copy slide, ⌘C in the overview): pasted after a slide, here or in another deck. */
export const SLIDE_MARK = '<!--decklight:slide-->';
/**
 * The editor's own clip out of clipboard html, whatever a browser wrapped it
 * in (a `<meta charset>`, `<html><body>`, the fragment markers): `{ mark,
 * html }`, or null for html that is not ours.
 */
export function ownClip(html) {
  const m = /<!--\s*decklight:(element|shape|slide)\s*-->/.exec(String(html ?? ''));
  if (!m) return null;
  const rest = String(html).slice(m.index + m[0].length)
    .replace(/<!--\s*EndFragment\s*-->[\s\S]*$/i, '')
    .replace(/<\/body>\s*<\/html>\s*$/i, '');
  return { mark: m[1], html: rest.trim() };
}

/**
 * What a clipboard carries, as one kind the editor acts on:
 *
 *   { kind: 'element', html, text } an element a deck's editor copied (ELEMENT_MARK)
 *   { kind: 'shape', html, text }   a diagram's shape a deck's editor copied (SHAPE_MARK)
 *   { kind: 'slide', html, text }   a whole slide a deck's editor copied (SLIDE_MARK)
 *   { kind: 'pictures', files }   one or more pictures (a screenshot, "Copy image")
 *   { kind: 'html', html, text }  rich text from another app
 *   { kind: 'text', text }        plain text
 *   { kind: 'none' }              nothing the editor takes (a file that is not a picture)
 *
 * Pictures win: a browser's "Copy image" puts the picture and an `<img>`'s
 * html on the clipboard together, and the picture is what was meant. `data`
 * is a DataTransfer, or anything with `files`, `items` and `getData`.
 */
export function classifyClipboard(data) {
  if (!data) return { kind: 'none' };
  const fromItems = Array.from(data.items ?? []).filter((i) => i.kind === 'file').map((i) => i.getAsFile?.()).filter(Boolean);
  const files = imageFiles(Array.from(data.files ?? []).length ? data.files : fromItems);
  const html = data.getData?.('text/html') ?? '';
  const text = data.getData?.('text/plain') ?? '';
  // the editor's own clip first: a copied element carrying a picture is the element
  const own = ownClip(html);
  if (own?.html) return { kind: own.mark, html: own.html, text };
  if (files.length) return { kind: 'pictures', files };
  if (html.trim()) return { kind: 'html', html, text };
  if (text.trim()) return { kind: 'text', text };
  return { kind: 'none' };
}

/** Is `target` somewhere the browser's own paste belongs: a field, a box being typed in? */
export function typingTarget(target) {
  const el = target?.nodeType === 1 ? target : target?.parentElement;
  if (!el) return false;
  if (/^(input|textarea|select)$/i.test(el.tagName) && !el.readOnly) return true;
  return !!el.isContentEditable || !!el.closest?.('[contenteditable]:not([contenteditable="false"])');
}

/** The words an element says, for a plain text editor: its text, its lines kept, without the engine's own nodes. */
export function wordsOf(el) {
  if (!el) return '';
  const copy = el.cloneNode(true);
  for (const n of copy.querySelectorAll('script, style, .slide-bg, .draw-head, .draw-mask, [data-ds-injected], aside')) n.remove();
  return (copy.innerText ?? copy.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

export function createClipboard({ editmode, authoring, editbar, addContent = null, toast = () => {}, overviewSlide = () => null, currentSlide = () => null, several = null }) {
  /** Write mode with editing on and nothing being typed: the only time a paste is the editor's. */
  const ours = (e) => editmode.elementEditOn?.() && editmode.available?.() !== false
    && !authoring.editing() && !typingTarget(e.target);
  /** Words the reader has selected on the page are theirs to copy, as text. */
  const textSelected = () => { const s = window.getSelection?.(); return !!s && !s.isCollapsed && String(s).trim() !== ''; };

  // A copy event is answered at once, so the selected element's source is
  // read from the file when it is selected, kept until the selection changes.
  let held = null;   // { key, html, shape, count } for the selection
  // several selected (⇧-click): every one of them, in the slide's order
  // several shapes of one diagram (SVG_DIAGRAMS) are not several elements: they share one, the diagram
  const shapesOf = () => editbar.selectedShapes?.() ?? null;
  const allOf = () => {
    if (shapesOf()) return null;
    const all = editbar.selectedAll?.() ?? [];
    return all.length > 1 ? [...all].sort((a, b) => a.index - b.index) : null;
  };
  const keyOf = (t) => {
    const shapes = shapesOf();
    if (shapes) return `${t?.slide}:${t?.index}:shapes:${shapes.map((x) => (innerPath(x) ?? []).join('.')).join(',')}`;
    const many = allOf();
    if (many) return `${t?.slide}:several:${many.map((x) => x.index).join(',')}`;
    return t ? `${t.slide}:${t.index}:${(innerPath(t) ?? []).join('.')}` : '';
  };
  const inDiagram = (t) => !!(t?.node && t.node !== t.top && t.node.closest?.('svg') && t.top.contains(t.node.closest('svg')));
  async function hold(t) {
    held = null;
    if (!t || !Number.isInteger(t.index) || !editmode.available?.()) return;
    const key = keyOf(t);
    const shapes = shapesOf();
    if (shapes) {
      // several shapes: each one's source by its path, back to back; a paste in their diagram duplicates them all
      const mine = { key, html: null, shape: true, count: shapes.length, targets: shapes };
      held = mine;
      try {
        const parts = await Promise.all(shapes.map(async (x) => {
          const q = new URLSearchParams({ slide: String(x.slide), index: String(x.index), path: (innerPath(x) ?? []).join('.'), tag: x.node.tagName.toLowerCase() });
          const res = await fetch(`${editmode.base?.() ?? ''}/deck/edit/element/source?${q}`);
          const j = await res.json().catch(() => ({}));
          if (!res.ok || typeof j.html !== 'string') throw new Error('no source');
          return j.html;
        }));
        if (held === mine) mine.html = parts.join('\n');
      } catch { /* the copy says it is not ready */ }
      return;
    }
    const many = allOf();
    if (many) {
      // several: each one's source, written back to back in the slide's order
      const mine = { key, html: null, shape: false, count: many.length };
      held = mine;
      try {
        const parts = await Promise.all(many.map(async (x) => {
          const res = await fetch(`${editmode.base?.() ?? ''}/deck/edit/element/source?slide=${x.slide}&index=${x.index}`);
          const j = await res.json().catch(() => ({}));
          if (!res.ok || typeof j.html !== 'string') throw new Error('no source');
          return j.html;
        }));
        if (held === mine) mine.html = parts.join('\n');
      } catch { /* the copy says it is not ready */ }
      return;
    }
    const path = innerPath(t);
    const tag = (t.node ?? t.top)?.tagName?.toLowerCase();
    const mine = { key, target: t, html: null, shape: inDiagram(t) };
    held = mine;
    try {
      const q = new URLSearchParams({ slide: String(t.slide), index: String(t.index), ...(path?.length ? { path: path.join('.'), tag } : {}) });
      const res = await fetch(`${editmode.base?.() ?? ''}/deck/edit/element/source?${q}`);
      const j = await res.json().catch(() => ({}));
      if (held === mine && res.ok && typeof j.html === 'string') mine.html = j.html;
    } catch { /* the copy says it is not ready */ }
  }
  editbar.onSelect?.((t) => { hold(t); });

  // A slide's source, read when it is about to be copied (the Slide menu
  // opened, a cell chosen in the overview), for the same reason.
  let slideHeld = null;   // { slide, html }
  let wantSlide = null;   // Copy slide from a menu: the slide the next copy event is for
  async function holdSlide(n) {
    if (!Number.isInteger(n) || !editmode.available?.()) return;
    if (slideHeld?.slide === n && slideHeld.html) return;
    const mine = { slide: n, html: null };
    slideHeld = mine;
    try {
      const res = await fetch(`${editmode.base?.() ?? ''}/deck/edit/slide/source?slide=${n}`);
      const j = await res.json().catch(() => ({}));
      if (slideHeld === mine && res.ok && typeof j.html === 'string') mine.html = j.html;
    } catch { /* the copy says it is not ready */ }
  }
  /** Put slide `n` on `e`'s clipboard; true when it did. */
  function fillSlide(e, n) {
    e.preventDefault();
    if (slideHeld?.slide !== n || !slideHeld.html) { holdSlide(n); toast('still reading the slide from the file: copy again in a moment', 2400); return false; }
    e.clipboardData.setData('text/html', SLIDE_MARK + slideHeld.html);
    const tpl = document.createElement('template');
    tpl.innerHTML = slideHeld.html;
    e.clipboardData.setData('text/plain', wordsOf(tpl.content.querySelector('section')));
    return true;
  }
  /** Every deck that a slide's paste is after: the overview's chosen cell, else the slide on screen. */
  const pasteAfter = () => overviewSlide() ?? currentSlide();

  /** Put the selection on `e`'s clipboard; true when it did. */
  function fill(e, verb) {
    const t = editbar.selected();
    if (!t) return false;
    if (!held || held.key !== keyOf(t) || !held.html) {
      e.preventDefault();
      toast(`still reading it from the file: ${verb} again in a moment`, 2400);
      hold(t);
      return false;
    }
    e.clipboardData.setData('text/html', (held.shape ? SHAPE_MARK : ELEMENT_MARK) + held.html);
    const many = allOf();
    const shapes = shapesOf();
    e.clipboardData.setData('text/plain', shapes ? shapes.map((x) => wordsOf(x.node)).filter(Boolean).join('\n')
      : many ? many.map((x) => wordsOf(x.top)).filter(Boolean).join('\n\n') : wordsOf(t.node ?? t.top));
    e.preventDefault();
    return true;
  }
  function onCopy(e) {
    // a slide: Copy slide from a menu, or ⌘C on a cell of the overview
    const slide = wantSlide ?? overviewSlide();
    wantSlide = null;
    if (slide && editmode.elementEditOn?.() && editmode.available?.() !== false && !typingTarget(e.target)) {
      if (fillSlide(e, slide)) toast(`slide ${slide} copied: ⌘V pastes it after a slide, here or in another deck`, 2400);
      return;
    }
    if (!ours(e) || textSelected()) return;
    if (fill(e, 'copy')) {
      lastShape = held.shape ? (held.targets ?? held.target) : null;
      toast(held.shape ? (held.count > 1 ? `${held.count} shapes copied: paste them in their diagram` : 'shape copied: paste it in its diagram')
        : held.count > 1 ? `${held.count} elements copied: ⌘V pastes them here, on another slide or in another deck`
          : 'copied: ⌘V pastes it here, on another slide or in another deck', 2200);
    }
  }
  function onCut(e) {
    if (!ours(e) || textSelected()) return;
    const t = editbar.selected();
    if (held?.shape || shapesOf()) { e.preventDefault(); toast('a shape is not cut: copy it, or remove it with ⌫', 2600); return; }
    const many = allOf();
    if (!fill(e, 'cut')) return;
    // cut is copy and the remove the menu and ⌫ already make: one undo for the
    // remove, of all of them when several are selected
    if (many && several) setTimeout(() => several.remove(editbar.selectedAll()), 0);
    else setTimeout(() => editmode.removeElement?.(t), 0);
  }

  // the shape last copied in this tab: pasted in its own diagram, it is a duplicate
  let lastShape = null;
  function pasteShape() {
    const t = editbar.selected();
    const svgOf = (x) => x?.node?.closest?.('svg') ?? (x?.top?.matches?.('svg') ? x.top : null);
    const copied = Array.isArray(lastShape) ? lastShape : lastShape ? [lastShape] : [];
    if (!copied.length || !copied.every((x) => x.node?.isConnected) || !t || svgOf(t) !== svgOf(copied[0])) {
      toast('a shape pastes only into its own diagram for now: select something in it, then paste', 3600);
      return;
    }
    // several shapes copied: all of them duplicated in one write, the copies selected (shapes.js)
    if (copied.length > 1 && several) { several.duplicate(copied); return; }
    editmode.duplicateElement?.(copied[0]);
  }

  /** A slide from the clipboard, after the overview's chosen cell or the slide on screen. */
  function pasteSlide(section) {
    const after = pasteAfter();
    if (!after) return;
    editmode.slideOp?.('paste', { slide: after, section }).catch(() => { /* said by slideOp */ });
  }

  function onPaste(e) {
    // a slide pastes in the overview too, where nothing is selected on a slide
    if (overviewSlide() && editmode.elementEditOn?.() && !typingTarget(e.target)) {
      const clip = classifyClipboard(e.clipboardData);
      if (clip.kind === 'slide') { e.preventDefault(); pasteSlide(clip.html); return; }
    }
    if (!ours(e)) return;
    const clip = classifyClipboard(e.clipboardData);
    if (clip.kind === 'element' && addContent) { e.preventDefault(); addContent.paste(clip.html); return; }
    if (clip.kind === 'shape') { e.preventDefault(); pasteShape(); return; }
    if (clip.kind === 'slide') { e.preventDefault(); pasteSlide(clip.html); return; }
    if (clip.kind === 'pictures') {
      e.preventDefault();
      const sel = editbar.selected();
      // the drop's own path from here: uploaded into assets/, placed after the
      // selection (inside its column) or last on the slide, each said in a toast
      authoring.addPictures(clip.files, { afterIndex: sel?.index ?? null, afterPath: innerPath(sel) });
      return;
    }
    // words from another app: a paragraph, or a list of several lines, cleaned
    // as a paste while typing is (list-edit.js), placed where Add places one
    if ((clip.kind === 'html' || clip.kind === 'text') && addContent?.pasteWords) {
      const { kind, words } = pastedWords(clip);
      if (!kind) return;
      e.preventDefault();
      addContent.pasteWords(kind, words);
    }
  }
  document.addEventListener('paste', onPaste);
  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);

  /**
   * The menu's and the palette's Copy, Cut and Paste: the browser's own
   * command, so the same listeners answer (a menu click is a user gesture);
   * Paste reads the system clipboard where the browser lets a page.
   */
  const run = (verb) => { try { return document.execCommand(verb); } catch { return false; } };
  async function pasteFromMenu() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (!item.types.includes('text/html')) continue;
        const own = ownClip(await (await item.getType('text/html')).text());
        if (own?.mark === 'element' && own.html) return addContent?.paste(own.html);
        if (own?.mark === 'shape') return pasteShape();
        if (own?.mark === 'slide' && own.html) return pasteSlide(own.html);
      }
      toast('nothing of an editor’s on the clipboard: ⌘V pastes a picture or text', 3200);
    } catch {
      toast('the browser keeps the clipboard from a menu: press ⌘V to paste', 3200);
    }
  }
  return {
    classify: classifyClipboard,
    copy: () => run('copy'), cut: () => run('cut'), paste: pasteFromMenu,
    /** Copy slide `n` (Slide ▸ Copy slide): its source read already when the menu opened. */
    copySlide: (n) => { wantSlide = n; if (!run('copy')) { wantSlide = null; toast('the browser keeps the clipboard from a menu: choose the slide in the overview and press ⌘C', 3600); } },
    holdSlide,
    slideReady: (n) => slideHeld?.slide === n && !!slideHeld.html,
    /** Is the selection's source read, so a copy can answer at once (a harness waits on it)? */
    ready: () => !!(held?.html && held.key === keyOf(editbar.selected())),
    destroy: () => { document.removeEventListener('paste', onPaste); document.removeEventListener('copy', onCopy); document.removeEventListener('cut', onCut); },
  };
}
