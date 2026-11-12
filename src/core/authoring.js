// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Editing a deck with a mouse — SPEC PRESENTING, write mode.
 *
 * Write mode could edit notes, replace an element's HTML in a textarea, remove
 * an element and give it an effect — every one of them behind a right-click and
 * a menu. The two things a person does most to a slide, fixing a word and
 * adding a picture, had no gesture at all. This module gives them the two
 * gestures every editor has taught: double-click text to change it, drop a
 * file to add it.
 *
 * Both write through the routes that already exist, so `Z` takes either back.
 * An inline edit is saved by fetching the element's SOURCE (never the live
 * DOM, which the engine has decorated), changing the one node that was edited,
 * and posting the whole top-level element back through the content route the
 * HTML editor uses. That keeps the file's own markup intact around the words
 * that changed.
 */

import { authoredTop, authoredIndex } from './design-system.js';
import { boundedFetch } from './devmode.js';
import { pathFrom } from './colorpicker.js';
import { injectedIn } from './pick.js';
import { holdDraft } from './drafts.js';
import { linkTarget, slideSuggestions } from './links.js';
import { slideTitle, slideBody } from './finder.js';
import { createListSessions } from './list-session.js';
import { createEditCommit } from './edit-commit.js';
import { cleanPasted, cleanTyped } from './list-edit.js';
import { labelOf, linesOf, setLines } from './diagram-labels.js';

/** The elements a double-click may edit in place: text containers, nothing generated. */
export const EDITABLE = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, td, th, dt, dd';
/** Where a double-click must NOT edit: generated or structured content the source does not spell out. */
export const NOT_EDITABLE = 'pre, code, svg, .terminal, [data-chart], aside, table[data-chart]';
/**
 * A formula as the runtime typeset it (or the error it shows in its place). A
 * slide marked for math is edited like any slide, but an element that HOLDS
 * one of these is never typed into as it is shown: its DOM is MathML and the
 * TeX lives only in the file, so writing the DOM back would put the MathML in
 * the deck. It opens as its source instead (formulaTarget).
 */
export const FORMULA = 'math, .temml-error';
/**
 * A code block: edited as its SOURCE text, never its rendered DOM. code.js
 * highlights a block into spans and wraps every line, so writing that DOM back
 * would put the spans in the deck. Terminals and asides are left alone.
 */
export const CODE_EDITABLE = 'pre > code';

/**
 * The element-child path from `top` down to `node`: `[2, 0]` is the first
 * child of top's third child. Element children only, so the same path walks
 * the parsed SOURCE of `top`, whose whitespace text nodes differ from the
 * live DOM's.
 */
export function childPath(top, node) {
  const path = [];
  let cur = node;
  while (cur && cur !== top) {
    const parent = cur.parentElement;
    if (!parent) return null;
    const i = Array.prototype.indexOf.call(parent.children, cur);
    if (i < 0) return null;
    path.unshift(i);
    cur = parent;
  }
  return cur === top ? path : null;
}

/**
 * The diagram label under a double-click (SVG_DIAGRAMS), or null: a `<text>`
 * or `<tspan>` in an authored `<svg>` on slide `sec`. A chart draws its own
 * labels from data, and a terminal or an aside is not a diagram, so neither
 * offers one.
 */
export function svgTextTarget(target, sec) {
  const el = target?.closest?.('tspan, text');
  if (!el || !sec?.contains?.(el) || !el.closest('svg')) return null;
  if (el.closest('[data-chart], .terminal, aside, .draw-head, .draw-mask') || injectedIn(el, el.closest('svg'))) return null;
  return el;
}

/** The node `path` names under `top`, or null when the source has no such child. */
export function nodeAtPath(top, path) {
  let cur = top;
  for (const i of path ?? []) {
    cur = cur?.children?.[i];
    if (!cur) return null;
  }
  return cur;
}

/** `alt` for a dropped picture: the filename, without its extension, words apart. */
/**
 * Alt text from a picture's file name: `team-offsite.jpg` says "team
 * offsite". A name that says nothing about the picture says nothing at all:
 * what a pasted screenshot is called (`image.png`), a screenshot tool's or a
 * camera's timestamp or counter, a download's "unnamed". Alt that reads
 * "image" is worse than none, and the picture's Alt text row is where it is written.
 */
export function altFromName(name) {
  const words = String(name ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
  return GENERIC_PICTURE_NAME.test(words) ? '' : words;
}
// image, image 1, image (2), pasted image, clipboard, untitled, unnamed,
// download, photo, picture, blob; Screenshot / Screen Shot / Capture d'écran /
// Bildschirmfoto … at a time (never one with words of its own: "Screenshot of the pricing page"); IMG 1234, DSC01234, PXL 20261112 …; a bare number or hash
const GENERIC_PICTURE_NAME = new RegExp('^(?:'
  + "(?:pasted |copied )?(?:image|img|picture|pic|photo|clipboard|untitled|unnamed|download|blob|file|screenshot|screen shot|capture)(?: ?\\(?\\d+\\)?)?"
  + "|(?:screenshot|screen shot|screen recording|capture d.écran|bildschirmfoto|captura de pantalla|schermata|snímek obrazovky)(?: (?:at |from |à |vom |de |del |\\d).*)?"
  + '|(?:img|dsc|dscn|dcim|pxl|mvimg|photo|vid|gopr|p) ?\\d[\\d ]*.*'
  + '|[\\d ]+|[0-9a-f]{8}(?: ?[0-9a-f]{4}){3} ?[0-9a-f]{12}|[0-9a-f]{16,}'
  + ')$', 'i');

/** The dropped files worth uploading, in order; anything that is not an image is left where it was. */
export function imageFiles(list) {
  return Array.from(list ?? []).filter((f) => /^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/.test(f.type));
}
/** The videos a slide can carry, of `list` (a drop, a chooser): mp4 and webm (DECK_ANATOMY). */
export function videoFiles(list) {
  return Array.from(list ?? []).filter((f) => /^video\/(mp4|webm)$/.test(f.type));
}

/**
 * What a drop says about the files it did not add: not pictures (named, the
 * first few), or, with no edit server behind the deck, that pictures are
 * added in write mode.
 */
export function droppedNotAdded(files, { writeMode = true } = {}) {
  if (!writeMode) return 'dropping a picture adds it in write mode: open the deck with decklight <deck.html>';
  const names = Array.from(files ?? []).map((f) => f.name).filter(Boolean);
  const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
  return `${shown || 'that'} ${names.length > 1 ? 'are not pictures' : 'is not a picture'}: only PNG, JPEG, GIF, WebP, SVG or AVIF can be added, or an mp4 or webm video`;
}

/**
 * The text element under a double-click that may be edited, or null.
 * `sec` is the slide it must belong to; a click on the stage between slides,
 * on an aside, or inside generated content edits nothing.
 */
export function editableTarget(target, sec) {
  const el = target?.closest?.(EDITABLE);
  if (!el || !sec?.contains?.(el)) return null;
  if (el.closest(NOT_EDITABLE)) return null;
  if (el.querySelector?.(FORMULA)) return null;
  return el;
}

/**
 * The text element under `target` that holds a typeset formula, or null: the
 * one editableTarget refuses for that reason alone, which a double-click
 * opens showing what the file has (`$$E = mc^2$$`) rather than the MathML.
 */
export function formulaTarget(target, sec) {
  const el = target?.closest?.(EDITABLE);
  if (!el || !sec?.contains?.(el) || el.closest(NOT_EDITABLE)) return null;
  return el.querySelector?.(FORMULA) ? el : null;
}

/** What a formula that did not parse says, from the error Temml shows in its place. */
export function formulaError(node) {
  const text = node?.textContent ?? '';
  const at = text.lastIndexOf('\n\n');
  return (at >= 0 ? text.slice(at + 2) : text).replace(/^ParseError:\s*/, '').trim() || 'it does not parse';
}

export function createAuthoring({ root, instance, toast, editmode, debugLog = () => {} }) {
  const available = () => editmode.available?.() === true;
  const base = () => editmode.base?.() ?? '';
  // Every read and write here is bounded (boundedFetch): a request the browser
  // queues behind a saturated socket pool never rejects on its own, and the
  // toasts below only speak when something does. A save is written IN PLACE
  // (PRESENTING, edit-commit.js): this page already shows what it typed, so
  // the write is quiet (no reload here) and the engine is told what changed,
  // so the slide is rescanned and laid out again as a reload would have; every
  // other page of the deck is sent the event. A save's flow is tracked whole.
  const commit = createEditCommit(editmode);
  const post = (path, body) => commit.send(path, body);
  /** The slide refreshed around what was saved (a code block highlighted and lined again). */
  // math: a slide marked for it typesets what was typed (a formula the text gained)
  const announce = (slide, el, code = false) => instance.refreshSlide?.(instance._sections?.[slide - 1], { scan: el, code: code ? [el] : [], math: true });
  const sectionOf = (node) => {
    const sec = node?.closest?.('section');
    const slide = sec ? instance._sections.indexOf(sec) + 1 : 0;
    return slide ? { sec, slide } : null;
  };
  // the authored element a click addresses — on a design-system slide, the
  // slot content wherever expansion put it, never the layout's decoration
  const topLevelChild = (sec, target) => authoredTop(sec, target);

  // ── double-click to edit text ─────────────────────────────────────────────
  let editing = null; // { el, original, slide, index, path }

  // ── a save that failed (PRESENTING_EDITING) ───────────────────────────────
  // The words stay where they were typed, marked unsaved, instead of the old
  // ones coming back: the server being away is no reason to lose them. A
  // double-click picks the edit up again, its original still the file's, so
  // ⏎ tries the save again and Esc puts the file's words back. Until then the
  // reload waits for them (drafts.js).
  const stranded = new Map();   // element → the edit whose save failed
  // `el`: what is marked, the edited element, or a whole list or table
  const strand = (cur, el = cur.el) => {
    stranded.set(el, cur);
    el.classList.add('dl-unsaved');
    el.setAttribute('data-dl-unsaved', 'not saved: double-click to try again');
  };
  const unstrand = (el) => {
    stranded.delete(el);
    el.classList.remove('dl-unsaved');
    el.removeAttribute('data-dl-unsaved');
  };
  const notSaved = (what, e) => `${commit.notSaved(what, e)}. Your words stay on the slide, marked: double-click to try again (Esc there puts the old ones back)`;
  const changedNow = (cur) => (cur.list || cur.table ? lists.changed(cur) : cur.svg ? rowsOf(cur.input.value).join('\n') !== rowsOf(cur.was).join('\n')
    : cur.code ? cur.el.textContent.replace(/\n$/, '') !== cur.text
      : cur.el.innerHTML !== cur.original);
  holdDraft(() => {
    if (editing && (stranded.has(editing.el) || changedNow(editing))) return `your edit on slide ${editing.slide}`;
    const left = [...stranded.values()].find((c) => c.el.isConnected);
    return left ? `your unsaved text on slide ${left.slide}` : null;
  });

  async function saveInlineNow() {
    const cur = editing;
    if (!cur) return;
    if (cur.code) return saveCode(cur);
    if (cur.svg) return saveLabel(cur);
    closeLinkBox();
    const changed = cur.formula && changedNow(cur);
    // a list or a table: the whole session, one write (list-session.js)
    const done = cur.list || cur.table ? lists.save(cur) : saveText(cur);
    if (!cur.formula) return done;
    await done;
    typesetAgain(cur, { changed });
  }

  // ── a formula typed as its source (CODE_AND_MATH) ─────────────────────────
  // Its text shows the file's TeX while it is typed; when the typing ends the
  // slide typesets it again, whether it was written (the save's announce has
  // already done it), unchanged, or given up. Words a failed save left marked
  // stay as typed, so a double-click picks them up as they are.
  function typesetAgain(cur, { changed = false } = {}) {
    const sec = instance._sections?.[cur.slide - 1];
    const host = cur.list?.root ?? cur.el;
    if (!sec || host.closest?.('.dl-unsaved')) return;
    instance.refreshSlide?.(sec, { math: true, scan: false });
    const bad = changed ? host.querySelector?.('.temml-error') : null;
    if (bad) toast(`saved, but the formula does not parse: ${formulaError(bad)}`, 6000);
  }
  /** Text holding a typeset formula, opened as what the file has: the TeX, never the MathML. */
  async function beginFormula(el, where, { selectAll = false } = {}) {
    if (editing) await saveInline();
    if (!el.isConnected || !el.querySelector(FORMULA)) {
      // a save just now typeset it differently, or the words are already the source
      if (el.isConnected && editableTarget(el, where.sec)) beginInline(el, where, { selectAll });
      return;
    }
    const top = topLevelChild(where.sec, el);
    if (!top) return;
    const path = childPath(top, el);
    if (path === null) return;
    let html;
    try {
      ({ node: { innerHTML: html } } = await elementSource(where.slide, authoredIndex(where.sec, top), path, 'formula'));
    } catch (err) {
      toast(`could not open the formula: ${String(err.message || err)}`, 6000);
      return;
    }
    el.innerHTML = html;
    beginInline(el, where, { selectAll, formula: true });
  }

  async function saveText(cur) {
    if (editing === cur) editing = null;
    placePill();
    cur.el.removeAttribute('contenteditable');
    cur.el.classList.remove('dl-editing');
    const inner = cur.el.innerHTML;
    // words the file does not have yet (a caption just added, pictures.js):
    // their own one write when the typing ends, whatever they say
    if (cur.provisional) return cur.provisional.save(cur.el);
    if (inner === cur.original) { unstrand(cur.el); return; } // nothing changed: nothing written, no reload
    // what typing left that the file should not get (cleanTyped): the second guard behind the paste's own
    const words = cleanTyped(inner, cur.original);
    if (words !== inner) cur.el.innerHTML = words;   // the page shows what the file gets
    try {
      const src = await boundedFetch(`${base()}/deck/edit/element/source?slide=${cur.slide}&index=${cur.index}`);
      const j = await src.json().catch(() => ({}));
      if (!src.ok || typeof j.html !== 'string') throw new Error(j.error || 'no source for this element');
      // The SOURCE of the top-level element, parsed inertly, so the file's own
      // attributes and siblings survive and only the edited node's content moves.
      const tpl = document.createElement('template');
      tpl.innerHTML = j.html;
      const top = tpl.content.firstElementChild;
      const node = nodeAtPath(top, cur.path);
      if (!node) throw new Error('the source has no element where the click landed');
      node.innerHTML = words;
      await post('/deck/edit/element/content', { slide: cur.slide, index: cur.index, html: top.outerHTML });
      unstrand(cur.el);
      toast('saved', 1200);
      announce(cur.slide, cur.el);
    } catch (e) {
      strand(cur);
      toast(notSaved('the text', e), 7000);
    }
  }

  // Tracked from its FIRST await, not just the POST: the save reads the element's
  // source before it writes, and a Z pressed during that read is exactly the one
  // that used to find "nothing to undo" while the edit landed behind it.
  let lastSave = Promise.resolve();
  function saveInline() {
    const p = saveInlineNow();
    editmode.trackWrite?.(p);
    lastSave = p.catch(() => {});
    return p;
  }

  function cancelInline() {
    const cur = editing;
    if (!cur) return;
    closeLinkBox();
    editing = null;
    placePill();
    if (cur.provisional) {
      cur.el.removeAttribute('contenteditable');
      cur.el.classList.remove('dl-editing');
      cur.provisional.cancel();
      return;
    }
    if (cur.svg) {
      endLabel(cur);
      if (stranded.has(cur.el)) { cur.el.innerHTML = cur.html; unstrand(cur.el); }
      return;
    }
    if (cur.list || cur.table) { lists.cancel(cur); if (cur.formula) typesetAgain(cur); return; }
    unstrand(cur.el);
    if (cur.code) {
      cur.el.removeAttribute('contenteditable');
      cur.el.classList.remove('dl-editing');
      putBack(cur);
      return;
    }
    cur.el.innerHTML = cur.original;
    cur.el.removeAttribute('contenteditable');
    cur.el.classList.remove('dl-editing');
    if (cur.formula) typesetAgain(cur);
  }

  // ── lists and tables, typed in like a document (PRESENTING_EDITING) ──────
  const lists = createListSessions({
    instance, toast, editmode, fetch: boundedFetch, base, post, announce, childPath,
    sectionOf, topLevelChild, authoredIndex, strand, unstrand, notSaved, saveText,
    saveInline: () => saveInline(), lastSave: () => lastSave,
    editing: () => editing,
    setEditing: (v) => { editing = v; placePill(); },
    syncHint: () => syncHint(), placePill: () => placePill(),
  });
  // the element menu's rows for a right-click on a table's cell
  editmode.setTableRows?.((target, close) => lists.tableRows(target, close));

  // ── emphasis while editing in place (PRESENTING) ──────────────────────────
  // ⌘B, ⌘I and ⌘E (Ctrl on Windows and Linux) wrap the selection in <strong>,
  // <em> or <code>, ⌘⇧H in a highlight (<mark>) and ⌘⇧X in a strikethrough
  // (<s>), and take it off again; a pill above any selection offers those and
  // superscript and subscript (<sup>, <sub>) to the mouse. The file gets the
  // semantic tag, never the <b> or <i> a browser's own bold command writes,
  // so every theme's rule for `strong` (the heading colour) and `mark` (its
  // accent, tinted) is what the emphasis looks like.
  const EMPHASIS = { b: 'strong', i: 'em', e: 'code' };
  /** The chords with ⇧: a highlight and a strikethrough. Superscript and subscript are the pill's (⌘, and ⌘. are the browser's). */
  const SHIFTED_EMPHASIS = { h: 'mark', x: 's' };
  /** The pill, in its order: [chord, tag, label, what it is]. */
  const PILL = [
    ['B', 'strong', 'B', 'bold'], ['I', 'em', 'I', 'italic'], ['E', 'code', '‹›', 'code'],
    ['⇧H', 'mark', 'H', 'highlight'], ['⇧X', 's', 'S', 'strikethrough'],
    [null, 'sup', 'x²', 'superscript'], [null, 'sub', 'x₂', 'subscript'],
  ];
  /** ⌘K / Ctrl+K: the link while typing, the palette everywhere else. */
  const isLinkChord = (e) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K');
  const TAGS = ['strong', 'em', 'code', 'mark', 's', 'sup', 'sub'];
  function selectionIn(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    return el.contains(range.commonAncestorContainer) ? range : null;
  }
  /** The `tag` element the selection sits inside, within `el`, or null. */
  function wrappedIn(range, tag, el) {
    let n = range.commonAncestorContainer;
    if (n.nodeType === Node.TEXT_NODE) n = n.parentNode;
    while (n && n !== el) {
      if (n.tagName?.toLowerCase() === tag) return n;
      n = n.parentNode;
    }
    return null;
  }
  function toggleEmphasis(tag) {
    const cur = editing;
    if (!cur || cur.code || cur.svg) return false;
    const range = selectionIn(cur.el);
    if (!range) { toast('select some text first', 1600); return false; }
    const sel = window.getSelection();
    const had = wrappedIn(range, tag, cur.el);
    if (had) {
      // off: the children step out of the tag and stay selected
      const parent = had.parentNode;
      const first = had.firstChild, last = had.lastChild;
      while (had.firstChild) parent.insertBefore(had.firstChild, had);
      parent.removeChild(had);
      if (first && last) {
        const r = document.createRange();
        r.setStartBefore(first); r.setEndAfter(last);
        sel.removeAllRanges(); sel.addRange(r);
      }
    } else {
      // on: the selection, however it cuts across nodes, moves into the tag
      const wrap = document.createElement(tag);
      wrap.appendChild(range.extractContents());
      range.insertNode(wrap);
      const r = document.createRange();
      r.selectNodeContents(wrap);
      sel.removeAllRanges(); sel.addRange(r);
    }
    // a split left nothing behind: no empty <strong></strong> in the file
    for (const e of cur.el.querySelectorAll(TAGS.join(','))) if (!e.textContent) e.remove();
    cur.el.normalize();
    placePill();
    return true;
  }

  // ── links while editing in place (PRESENTING_EDITING) ─────────────────────
  // ⌘K / Ctrl+K, or the pill's link button, opens a small box under the
  // selection: an address, ⏎ to apply, Esc to leave the words as they were.
  // On a link already there it opens filled with its href, with Remove link
  // and Open beside it. What the box accepts is links.js's rule, the one the
  // ingredients label agrees with; the <a> goes into the element as an
  // emphasis tag does, and is written by the same save (⏎, or leaving).
  const LINK_ICON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.4 8.9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/></svg>';
  /** The <a> the caret or the selection sits in, within `el`, or null; a bare caret counts. */
  function linkAround(el) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return null;
    return wrappedIn(range, 'a', el);
  }
  /**
   * The `target` (and its `rel`) the deck's own web links already carry, or
   * null: a new link stays plain unless the deck chose otherwise elsewhere.
   */
  function deckLinkTarget() {
    for (const sec of instance._sections) {
      for (const a of sec.querySelectorAll('a[target][href]')) {
        if (/^https?:/i.test(a.getAttribute('href'))) return { target: a.getAttribute('target'), rel: a.getAttribute('rel') };
      }
    }
    return null;
  }
  let linkBox = null;   // { box, input, why, list, range, link, cur }
  const HL = 'dl-link-target';
  function openLinkBox() {
    const cur = editing;
    if (!cur || cur.code || cur.svg) return false;
    if (linkBox) { closeLinkBox({ restore: true }); return true; }
    const sel = window.getSelection();
    if (!sel?.rangeCount || !cur.el.contains(sel.getRangeAt(0).commonAncestorContainer)) return false;
    const link = linkAround(cur.el);
    let range = sel.getRangeAt(0).cloneRange();
    if (!link && range.collapsed) { toast('select words to link', 1800); return false; }
    const caret = range.collapsed;
    if (link && caret) { range = document.createRange(); range.selectNodeContents(link); }
    const box = document.createElement('div');
    box.className = 'dl-link';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', link ? 'edit the link' : 'add a link');
    const row = document.createElement('div');
    row.className = 'dl-link-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dl-link-url';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.placeholder = 'https://…, a file beside the deck, or #3 for a slide';
    input.setAttribute('aria-label', 'link address');
    input.value = link?.getAttribute('href') ?? '';
    const button = (cls, text, run, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      if (title) b.title = title;
      // the box keeps its caret: the press is not a move of the focus
      b.addEventListener('mousedown', (ev) => ev.preventDefault());
      b.addEventListener('click', (ev) => { ev.stopPropagation(); run(); });
      return b;
    };
    row.append(input, button('dl-link-apply', link ? 'Update' : 'Apply', () => applyLink(input.value), '⏎'));
    box.append(row);
    if (link) {
      const acts = document.createElement('div');
      acts.className = 'dl-link-acts';
      acts.append(
        button('dl-link-open', 'Open ↗', () => openLink(link), 'in a new tab'),
        button('dl-link-remove', 'Remove link', () => removeLink(), 'the words stay'));
      box.append(acts);
    }
    const why = document.createElement('div');
    why.className = 'dl-link-why';
    why.setAttribute('role', 'status');
    why.setAttribute('aria-live', 'polite');
    const list = document.createElement('div');
    list.className = 'dl-link-slides';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'slides of this deck');
    box.append(why, list);
    linkBox = { box, input, why, list, range, link, cur };
    root.appendChild(box);
    // under the words, kept on screen
    const r = range.getBoundingClientRect();
    const w = box.offsetWidth;
    box.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    box.style.top = `${Math.max(8, Math.min(innerHeight - box.offsetHeight - 8, r.bottom + 10))}px`;
    // the words the link is for stay marked while the caret is in the box
    if (globalThis.CSS?.highlights && typeof globalThis.Highlight === 'function') CSS.highlights.set(HL, new Highlight(range));
    input.addEventListener('input', () => { why.textContent = ''; box.classList.remove('refused'); input.removeAttribute('aria-invalid'); suggest(); });
    box.addEventListener('keydown', (e) => {
      // the box's keys are its own: the deck and the element hear none
      e.stopPropagation();
      const k = e.key;
      if (k === 'Escape' || ((e.metaKey || e.ctrlKey) && !e.altKey && (k === 'k' || k === 'K'))) { e.preventDefault(); closeLinkBox({ restore: true }); }
      else if (k === 'Enter' && e.target === input) { e.preventDefault(); enter(); }
      else if ((k === 'ArrowDown' || k === 'ArrowUp') && list.children.length) { e.preventDefault(); moveSuggestion(k === 'ArrowDown' ? 1 : -1); }
    });
    // leaving the box for the page is leaving the edit, as a click away from
    // the words always was; back into the words only closes the box
    box.addEventListener('focusout', (e) => {
      if (linkBox?.box !== box || box.contains(e.relatedTarget)) return;
      closeLinkBox();
      if (editing === cur && e.relatedTarget !== cur.el) saveInline();
    });
    syncHint();
    pill?.remove(); pill = null;
    input.focus();
    input.select();
    suggest();
    return true;
  }
  function closeLinkBox({ restore = false } = {}) {
    const lb = linkBox;
    if (!lb) return;
    linkBox = null;
    lb.box.remove();
    globalThis.CSS?.highlights?.delete?.(HL);
    if (restore && editing === lb.cur) {
      lb.cur.el.focus({ preventScroll: true });
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(lb.range);
    }
    placePill();
  }
  /** The slides offered while `#` or a number is typed: a few rows, one click each. */
  function suggest() {
    const { input, list } = linkBox;
    const titles = instance._sections.map((sec, i) => slideTitle(sec, i, slideBody(sec)));
    list.textContent = '';
    for (const s of slideSuggestions(input.value, titles)) {
      const row = document.createElement('div');
      row.className = 'dl-link-slide';
      row.setAttribute('role', 'option');
      row.dataset.href = s.href;
      const n = document.createElement('b');
      n.textContent = `Slide ${s.slide}`;
      const t = document.createElement('span');
      t.textContent = s.title;
      row.append(n, t);
      row.addEventListener('mousedown', (ev) => { ev.preventDefault(); applyLink(s.href); });
      list.appendChild(row);
    }
  }
  function moveSuggestion(d) {
    const rows = [...linkBox.list.children];
    const at = rows.findIndex((r) => r.classList.contains('on'));
    const next = at < 0 ? (d > 0 ? 0 : rows.length - 1) : (at + d + rows.length) % rows.length;
    rows.forEach((r, i) => { r.classList.toggle('on', i === next); r.setAttribute('aria-selected', String(i === next)); });
  }
  // ⏎: the slide picked with the arrows, else what was typed, else (when what
  // was typed is only the start of a slide link, `#`) the first slide offered
  function enter() {
    const { input, list } = linkBox;
    const picked = list.querySelector('.dl-link-slide.on');
    if (picked) return applyLink(picked.dataset.href);
    const typed = linkTarget(input.value, { slides: instance._sections.length });
    if (!typed.ok && list.firstElementChild) return applyLink(list.firstElementChild.dataset.href);
    return applyLink(input.value);
  }
  /** Put `raw` on the words the box is for, or say in the box why it cannot go there. */
  function applyLink(raw) {
    const lb = linkBox;
    if (!lb) return false;
    const t = linkTarget(raw, { slides: instance._sections.length });
    if (!t.ok) {
      lb.why.textContent = t.why;
      lb.box.classList.add('refused');
      lb.input.setAttribute('aria-invalid', 'true');
      lb.input.focus();
      return false;
    }
    const { cur, link } = lb;
    closeLinkBox({ restore: true });
    const sel = window.getSelection();
    let a = link?.isConnected ? link : null;
    if (a) a.setAttribute('href', t.href);
    else {
      // a new link: links the words carried step out of it (no <a> in an
      // <a>), and one the selection cut through keeps its other half
      const range = sel.getRangeAt(0);
      a = document.createElement('a');
      a.setAttribute('href', t.href);
      const like = t.kind === 'web' ? deckLinkTarget() : null;
      if (like?.target) a.setAttribute('target', like.target);
      if (like?.rel) a.setAttribute('rel', like.rel);
      const frag = range.extractContents();
      for (const inner of frag.querySelectorAll('a')) inner.replaceWith(...inner.childNodes);
      a.appendChild(frag);
      range.insertNode(a);
      for (const e of cur.el.querySelectorAll('a')) if (e !== a && !e.textContent && !e.querySelector('img, svg, picture')) e.remove();
      cur.el.normalize();
    }
    // the caret goes just after the link, as a document editor leaves it:
    // typing carries on outside it, and an Enter in a list starts the next
    // point instead of replacing the words that were just linked
    const r = document.createRange();
    r.setStartAfter(a); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    placePill();
    return true;
  }
  /** Take the link off: its words stay where they were, selected. */
  function removeLink() {
    const lb = linkBox;
    if (!lb?.link) return;
    const a = lb.link;
    closeLinkBox({ restore: true });
    if (!a.isConnected) return;
    const first = a.firstChild, last = a.lastChild;
    a.replaceWith(...a.childNodes);
    const sel = window.getSelection();
    if (first && last) {
      const r = document.createRange();
      r.setStartBefore(first); r.setEndAfter(last);
      sel.removeAllRanges(); sel.addRange(r);
    }
    lb.cur.el.normalize();
    placePill();
  }
  /** Open the link in a new tab: the deck stays where it is. */
  function openLink(a) {
    const href = a.getAttribute('href') ?? '';
    if (!linkTarget(href, { slides: instance._sections.length }).ok) { toast('that link is not one a deck can follow', 2400); return; }
    window.open(new URL(href, location.href).href, '_blank', 'noopener');
  }
  // ── editing has its own look (PRESENTING_EDITING) ───────────────────────
  // "Selected" and "editing its text" looked the same, one accent outline, so
  // nothing said that keys now went into the words. Editing is tinted (CSS
  // .dl-editing) and carries a hint under it naming its two ways out.
  let hint = null;
  const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? '');
  function syncHint() {
    const cur = editing;
    if (!cur) { hint?.remove(); hint = null; return; }
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'dl-edit-hint';
      hint.setAttribute('aria-hidden', 'true');   // the keys are the element's; this only says them
      document.body.appendChild(hint);
    }
    hint.style.display = linkBox ? 'none' : '';
    hint.textContent = lists.hint(cur) ?? (cur.code ? `${IS_MAC ? '⌘⏎' : 'Ctrl+Enter'} keep · Esc cancel` : '⏎ keep · Esc cancel');
    // a list or a table: under the whole of it, clear of the next point
    const r = (cur.svg ? cur.input : lists.anchor(cur) ?? cur.el).getBoundingClientRect();
    hint.style.left = `${r.left + r.width / 2}px`;
    hint.style.top = `${r.bottom + 14}px`;
  }
  window.addEventListener('resize', () => syncHint());
  root.addEventListener('input', () => { if (editing) syncHint(); }, true);

  // ── a paste while typing (PRESENTING_EDITING) ─────────────────────────────
  // Left to the browser, a paste from a web page or a mail writes the other
  // app's font, size and colour into the words (a red 31px Comic Sans span,
  // saved inside the paragraph). Here it brings the words and the editor's
  // own emphasis and links only (cleanPasted), put in where the caret is.
  // Code is plaintext-only, and the browser keeps that text; where it falls
  // back to a plain contenteditable, the paste is put in as text too.
  root.addEventListener('paste', (e) => {
    const el = e.target?.closest?.('[contenteditable]');
    if (!editing || !el || !root.contains(el) || el.getAttribute('contenteditable') === 'plaintext-only') return;
    const data = e.clipboardData;
    if (!data) return;
    e.preventDefault();
    const text = data.getData('text/plain');
    const markup = el.matches(CODE_EDITABLE) ? null : cleanPasted({ html: data.getData('text/html'), text });
    // nothing but a picture on the clipboard: not into the words (Add a picture puts one on the slide)
    if (markup === '' || (markup === null && !text)) return;
    const sel = window.getSelection();
    if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    let frag;
    if (markup === null) frag = document.createTextNode(text);
    else {
      const tpl = document.createElement('template');
      tpl.innerHTML = markup;
      frag = tpl.content;
    }
    const last = frag.nodeType === 11 ? frag.lastChild : frag;
    range.insertNode(frag);
    if (last) { range.setStartAfter(last); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
  }, true);

  let pill = null;
  /** The pill above the selection: there while something is selected in the element being edited, gone otherwise. */
  function placePill() {
    syncHint();
    const cur = editing;
    const range = cur && !cur.code && !cur.svg ? selectionIn(cur.el) : null;
    if (!range) { pill?.remove(); pill = null; return; }
    if (!pill) {
      pill = document.createElement('div');
      pill.className = 'dl-fmt';
      pill.setAttribute('role', 'toolbar');
      pill.setAttribute('aria-label', 'emphasis');
      for (const [key, tag, label, what] of PILL) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `fmt-${tag}`;
        b.dataset.tag = tag;
        b.textContent = label;
        b.title = key ? `${what} — ⌘${key} / Ctrl+${key.replace('⇧', 'Shift+')}` : what;
        b.setAttribute('aria-label', what);
        // mousedown, not click: a click would move the selection the pill is about
        b.addEventListener('mousedown', (ev) => { ev.preventDefault(); toggleEmphasis(tag); });
        pill.appendChild(b);
      }
      // the link: the same box ⌘K opens (below), lit when the selection is in one
      const a = document.createElement('button');
      a.type = 'button';
      a.className = 'fmt-a';
      a.dataset.tag = 'a';
      a.title = 'link — ⌘K / Ctrl+K';
      a.setAttribute('aria-label', 'link');
      a.innerHTML = LINK_ICON;
      a.addEventListener('mousedown', (ev) => { ev.preventDefault(); openLinkBox(); });
      pill.appendChild(a);
      document.body.appendChild(pill);
    }
    const rect = range.getBoundingClientRect();
    pill.style.left = `${Math.max(48, rect.left + rect.width / 2)}px`;
    pill.style.top = `${Math.max(40, rect.top - 8)}px`;
    for (const b of pill.children) b.classList.toggle('on', !!wrappedIn(range, b.dataset.tag, cur.el));
  }
  document.addEventListener('selectionchange', () => { if (editing) placePill(); });

  // ── double-click a code block ─────────────────────────────────────────────
  /** The node at `path` inside a top-level element, parsed from the file's source; `what` names it in a refusal. */
  async function elementSource(slide, index, path, what = 'code block') {
    const src = await boundedFetch(`${base()}/deck/edit/element/source?slide=${slide}&index=${index}`);
    const j = await src.json().catch(() => ({}));
    if (!src.ok || typeof j.html !== 'string') throw new Error(j.error || `no source for this ${what}`);
    const tpl = document.createElement('template');
    tpl.innerHTML = j.html;
    const top = tpl.content.firstElementChild;
    const node = nodeAtPath(top, path);
    if (!node) throw new Error(`the source has no ${what} where the click landed`);
    return { top, node };
  }
  const codeSource = (slide, index, path) => elementSource(slide, index, path);

  // The rendered lines are MOVED aside, not copied as HTML: the data-lines build
  // provider holds references to these very `.code-line` nodes, and an Escape
  // that re-parsed them would leave its steps pointing at nodes no longer shown.
  function putBack(cur) {
    cur.el.textContent = '';
    cur.el.appendChild(cur.kept);
  }

  async function beginCode(codeEl, { sec, slide }, { selectAll = false } = {}) {
    if (editing) await saveInline();
    // a save that failed: the typed text is still in the block, as text
    const was = stranded.get(codeEl);
    if (was) { editing = was; editCode(codeEl); return; }
    const top = topLevelChild(sec, codeEl);
    if (!top) return;
    const index = authoredIndex(sec, top);
    const path = childPath(top, codeEl);
    if (path === null) return;
    let text;
    try {
      const { node } = await codeSource(slide, index, path);
      // exactly what code.js renders from: one leading newline and the trailing
      // whitespace before `</code>` are layout of the file, not code
      text = node.textContent.replace(/^\n/, '').replace(/\s+$/, '');
    } catch (err) {
      toast(`could not edit the code: ${String(err.message || err)}`, 6000);
      return;
    }
    const kept = document.createDocumentFragment();
    while (codeEl.firstChild) kept.appendChild(codeEl.firstChild);
    codeEl.textContent = text;
    editing = { el: codeEl, code: true, kept, text, slide, index, path };
    editCode(codeEl, { selectAll });
    debugLog('info', `editing slide ${slide} element #${index}'s code`);
  }

  function editCode(codeEl, { selectAll = false } = {}) {
    // plaintext-only: typing and pasting stay text, Enter is a real newline
    codeEl.setAttribute('contenteditable', 'plaintext-only');
    if (codeEl.contentEditable !== 'plaintext-only') codeEl.setAttribute('contenteditable', 'true');
    codeEl.spellcheck = false;
    codeEl.classList.add('dl-editing');
    codeEl.focus();
    const range = document.createRange();
    range.selectNodeContents(codeEl);
    if (!selectAll) range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    syncHint();
  }

  async function saveCode(cur) {
    editing = null;
    syncHint();
    const el = cur.el;
    const plain = el.getAttribute('contenteditable') === 'plaintext-only';
    el.removeAttribute('contenteditable');
    el.classList.remove('dl-editing');
    const text = (plain ? el.textContent : el.innerText).replace(/\n$/, '');
    if (text === cur.text) { unstrand(el); putBack(cur); return; }   // nothing changed: nothing written
    try {
      const { top, node } = await codeSource(cur.slide, cur.index, cur.path);
      // keep the file's own layout around the code, and let textContent escape
      // `<`, `>` and `&` on the way out — the attributes are never touched
      const raw = node.textContent;
      node.textContent = (raw.startsWith('\n') ? '\n' : '') + text + raw.match(/\s*$/)[0];
      await post('/deck/edit/element/content', { slide: cur.slide, index: cur.index, html: top.outerHTML });
      toast('saved', 1200);
      // the block is re-rendered from its new source, highlighted and lined
      // as the first render did it: the plain text the author typed into
      // the block is the file's, never what stays on screen
      unstrand(el);
      const fresh = node.closest('pre') ?? node;
      const shown = el.closest('pre') ?? el;
      shown.replaceWith(fresh);
      announce(cur.slide, fresh, true);
    } catch (e) {
      // the typed code stays in the block, as text, until it is saved or given up
      strand(cur);
      toast(notSaved('the code', e), 7000);
    }
  }

  // ── double-click a diagram label (SVG_DIAGRAMS) ───────────────────────────
  // SVG text takes no contenteditable, so the words are typed into a box laid
  // over the label in its own font, size and colour, and the label hides
  // until the box goes. The save names the one node by its path in the file
  // and sends the words alone: the diagram's markup is never re-serialised,
  // so `viewBox`, self-closing shapes and the file's own layout all survive.
  let measure = null;
  // a label that wraps: the diagram's fit and its news of a save (setLabelHooks, shapes.js)
  let labelFit = null; let labelSaved = null;
  function placeLabel(cur, { again = false } = {}) {
    const { input, el } = cur;
    if (again || !cur.at) {
      const cs = getComputedStyle(el);
      const m = el.getScreenCTM?.();
      const px = (parseFloat(cs.fontSize) || 16) * (m ? Math.hypot(m.a, m.b) : 1);
      const r = el.getBoundingClientRect();
      const anchor = cs.textAnchor === 'middle' ? 'middle' : cs.textAnchor === 'end' ? 'end' : 'start';
      const x = anchor === 'middle' ? r.left + r.width / 2 : anchor === 'end' ? r.right : r.left;
      cur.at = { px, anchor, x, y: r.top + r.height / 2, font: `${cs.fontStyle} ${cs.fontWeight} ${px}px ${cs.fontFamily}` };
      Object.assign(input.style, {
        font: cur.at.font, lineHeight: '1.25', textAlign: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
        color: /^rgb/.test(cs.fill) ? cs.fill : '',
      });
    }
    const { px, anchor, x, y, font } = cur.at;
    measure ??= document.createElement('canvas').getContext('2d');
    measure.font = font;
    // as many rows as it has lines (⇧⏎ makes one), as wide as its longest
    const rows = (input.value || ' ').split('\n');
    const w = Math.ceil(Math.max(...rows.map((r) => measure.measureText(r || ' ').width)) + px * 0.6 + 8);
    const h = px * 1.25 * rows.length + 6;
    input.style.width = `${w}px`;
    input.style.height = `${h}px`;
    input.style.left = `${anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w + 4 : x - 4}px`;
    input.style.top = `${y - h / 2}px`;
  }
  window.addEventListener('resize', () => { if (editing?.svg) placeLabel(editing, { again: true }); });

  async function beginLabel(el, { sec, slide }) {
    if (editing) await saveInline();
    // a line of a label is the label: its lines are edited together, one per row
    el = labelOf(el);
    const lines = linesOf(el);
    if (el.firstElementChild && !lines) { toast('this label holds runs of its own: double-click the one to change', 2600); return; }
    const top = topLevelChild(sec, el);
    if (!top) return;
    const index = authoredIndex(sec, top);
    const path = pathFrom(top, el);
    if (path === null) return;
    window.getSelection()?.removeAllRanges();
    // a box that takes several lines: ⇧⏎ starts one, ⏎ saves (SVG_DIAGRAMS, labels that wrap)
    const input = document.createElement('textarea');
    input.rows = 1;
    input.className = 'dl-label-edit';
    input.spellcheck = false;
    input.value = lines ? lines.join('\n') : el.textContent.replace(/\s+/g, ' ').trim();
    input.setAttribute('aria-label', 'diagram label');
    // a label whose save failed shows the typed words; the file still has `was` (its lines, one per row)
    const was = lines ? lines.join('\n') : el.textContent;
    const prior = stranded.get(el);
    const cur = { svg: true, el, input, was: prior?.was ?? was, html: prior?.html ?? el.innerHTML, plain: prior?.plain ?? !el.firstElementChild,
      vis: el.style.visibility, slide, index, path, tag: el.tagName.toLowerCase() };
    editing = cur;
    root.appendChild(input);
    placeLabel(cur);
    el.style.visibility = 'hidden';
    input.addEventListener('input', () => placeLabel(cur));
    // keys typed here are the label's: ⏎ saves, Esc gives up, the deck hears none
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveInline(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelInline(); }
      else if (isLinkChord(e)) { e.preventDefault(); toast('a link goes on words of the slide’s text, not on a diagram’s label', 2200); }
    });
    input.addEventListener('blur', () => { if (editing === cur) saveInline(); });
    input.focus();
    input.select();
    syncHint();
    debugLog('info', `editing slide ${slide} element #${index}'s diagram label at ${path.join('.')}`);
  }

  function endLabel(cur) {
    cur.input.remove();
    cur.el.style.visibility = cur.vis;
  }

  async function saveLabel(cur) {
    editing = null;
    syncHint();
    const typed = rowsOf(cur.input.value);
    endLabel(cur);
    if (!typed.length) { toast('kept the label: an empty one could not be clicked again (remove the shape instead)', 3200); return; }
    // broken to fit the shape it is on (only this page can measure), the breaks typed kept; a line of a run-holding label stays one line
    const fit = cur.tag === 'text' ? labelFit?.(cur.el, typed.join('\n')) : null;
    const lines = cur.tag === 'text' ? (fit?.lines ?? typed) : [typed.join(' ')];
    if (lines.join('\n') === rowsOf(cur.was).join('\n')) { if (stranded.has(cur.el)) { cur.el.innerHTML = cur.html; unstrand(cur.el); } return; } // nothing changed: nothing written
    if (cur.tag === 'text') setLines(cur.el, lines); else cur.el.textContent = lines[0];
    const body = lines.length === 1 && cur.plain
      ? { slide: cur.slide, index: cur.index, path: cur.path, tag: cur.tag, was: cur.was, text: lines[0] }
      : { slide: cur.slide, index: cur.index, path: cur.path, tag: 'text', was: cur.was, lines };
    try {
      await post('/deck/edit/element/text', body);
      unstrand(cur.el);
      toast(fit?.overflow ? 'saved — too long for its shape even wrapped: make the shape bigger or the words fewer' : 'saved', fit?.overflow ? 4200 : 1200);
      announce(cur.slide, cur.el);
    } catch (e) {
      strand(cur);
      toast(notSaved('the label', e), 7000);
    }
    labelSaved?.(cur.el);
  }
  /** A label's typed rows: each one's spaces collapsed, the empty ones gone. */
  const rowsOf = (v) => String(v ?? '').split('\n').map((r) => r.replace(/\s+/g, ' ').trim()).filter(Boolean);

  function beginInline(el, { sec, slide }, { selectAll = false, provisional = null, formula = false } = {}) {
    // another point of the list being edited, another cell of its table: the same session
    if (editing && lists.claim(editing, el)) return;
    if (editing) saveInline();
    const top = topLevelChild(sec, el);
    if (!top) return;
    const index = authoredIndex(sec, top);
    // words the file does not have yet are written their own way (`provisional`): no path into it
    const path = provisional ? [] : childPath(top, el);
    if (path === null) return;
    // a list or table whose save failed: its session, picked up where it was left
    const again = provisional ? null : lists.strandedFor(el, stranded);
    if (again) { editing = again; lists.resume(again, el); syncHint(); return; }
    // picked up again after a save that failed: the file still has the original
    // a formula's text is shown as its source while it is typed, and typeset again after
    const prior = stranded.get(el);
    editing = { el, original: prior?.original ?? el.innerHTML, slide, index, path, provisional, formula: formula || !!prior?.formula };
    // a point of a list, a cell of a table: Enter and Tab work as a document's (list-session.js)
    if (!provisional) lists.begin(editing, top);
    el.setAttribute('contenteditable', 'true');
    el.classList.add('dl-editing');
    el.focus();
    // caret at the end, where a correction usually goes; a placeholder just
    // added (add-content.js) is selected whole, so typing replaces it
    const range = document.createRange();
    range.selectNodeContents(el);
    if (!selectAll) range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    syncHint();
    debugLog('info', `editing slide ${slide} element #${index} inline`);
  }

  root.addEventListener('dblclick', (e) => {
    if (!available()) return;
    const where = sectionOf(e.target);
    if (!where || where.sec.hasAttribute('data-markdown-removed')) return;
    // editing is on whenever the page may write (locked, it is not)
    if (!editmode.elementEditOn?.()) return;
    const code = e.target?.closest?.(CODE_EDITABLE);
    if (code && where.sec.contains(code) && !code.closest('.terminal, aside, [data-chart]')) {
      e.preventDefault();
      beginCode(code, where);
      return;
    }
    const label = svgTextTarget(e.target, where.sec);
    if (label) { e.preventDefault(); beginLabel(label, where); return; }
    const el = editableTarget(e.target, where.sec);
    if (!el) {
      const formula = formulaTarget(e.target, where.sec);
      if (formula) { e.preventDefault(); beginFormula(formula, where); }
      return;
    }
    e.preventDefault();
    beginInline(el, where);
  });
  // Keys typed into the element belong to it: Enter saves (Shift+Enter breaks
  // a line), Escape gives up, and nothing reaches the deck's shortcuts.
  root.addEventListener('keydown', (e) => {
    if (!editing || e.target !== editing.el) return;
    e.stopPropagation();
    if (editing.code) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveInline(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelInline(); }
      else if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
      else if (isLinkChord(e)) { e.preventDefault(); toast('a link goes on words of the slide’s text, not in code', 2200); }
      return;
    }
    if (lists.key(e, editing)) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveInline(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelInline(); }
    // ⌘K / Ctrl+K is the palette's everywhere else; while typing it is the
    // link, on the words selected (or the link the caret is in). With none,
    // it opens neither a link box nor the palette: it says to select words.
    else if (isLinkChord(e)) {
      e.preventDefault();
      openLinkBox();
    }
    else if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.shiftKey ? SHIFTED_EMPHASIS : EMPHASIS)[e.key?.toLowerCase?.()]) {
      e.preventDefault();
      toggleEmphasis((e.shiftKey ? SHIFTED_EMPHASIS : EMPHASIS)[e.key.toLowerCase()]);
    }
  }, true);
  root.addEventListener('focusout', (e) => {
    // into the link box is not leaving: the box ends the edit itself if it is
    // left; nor is the typing moving to the next point or cell of the same session
    if (editing && e.target === editing.el && !linkBox && !lists.moving(editing)) saveInline();
  });
  // a press on another point of the list (another cell of the table) being
  // edited moves the typing there, in the same session
  root.addEventListener('mousedown', (e) => {
    if (!editing || !(editing.list || editing.table) || e.button !== 0) return;
    const el = e.target?.closest?.('li, td, th');
    if (!el || el === editing.el) return;
    // a point or cell holding a typeset formula is not typed into: its page
    // is MathML, and the session would write that into the file
    if (el.querySelector(FORMULA)) { toast('this point holds a formula: double-click it to type it as its source', 3600); return; }
    lists.claim(editing, el);
  }, true);

  // ── a link on a slide does not take the deck away (PRESENTING_EDITING) ────
  // In write mode a click selects and a double-click edits: the first click
  // of either used to follow the link, and the tab left the deck mid-edit.
  // While editing is on, a plain click on a slide's link stays on the deck;
  // ⌘-click (Ctrl+click) still opens it in a new tab, as the browser does.
  // Locked, or presenting without a server, links work as they always did.
  let toldLinks = false;
  root.addEventListener('click', (e) => {
    const a = e.target?.closest?.('a[href]');
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!a.closest('.decklight-stage section') || !available() || !editmode.elementEditOn?.()) return;
    e.preventDefault();
    if (!toldLinks && !editing) {
      toldLinks = true;
      toast(`links do not open while editing: ${IS_MAC ? '⌘-click' : 'Ctrl+click'} opens one in a new tab`, 3200);
    }
  }, true);

  // ── drop a picture onto the slide ─────────────────────────────────────────
  // A file dropped on the deck is ALWAYS caught, picture or not, write mode or
  // not: one the page let through, the browser opened in the deck's place,
  // and the talk was gone from the tab. What is not added is said.
  const carriesFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  root.addEventListener('dragover', (e) => {
    // mid-drag the browser withholds the files themselves; the TYPES say whether
    // any are coming, and the drop below is where images are told from the rest
    if (!carriesFiles(e)) return;
    e.preventDefault();
    if (!available()) { e.dataTransfer.dropEffect = 'none'; return; }
    e.dataTransfer.dropEffect = 'copy';
    root.classList.add('dl-dropping');
  });
  root.addEventListener('dragleave', (e) => {
    if (e.target === root || !root.contains(e.relatedTarget)) root.classList.remove('dl-dropping');
  });
  let videoDrop = null;
  root.addEventListener('drop', async (e) => {
    root.classList.remove('dl-dropping');
    if (!carriesFiles(e)) return;
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (!available()) { toast(droppedNotAdded(dropped, { writeMode: false }), 3600); return; }
    const files = imageFiles(dropped);
    const videos = videoDrop ? videoFiles(dropped) : [];
    const rest = dropped.filter((f) => !files.includes(f) && !videos.includes(f));
    if (rest.length) toast(droppedNotAdded(rest), 4200);
    if (!files.length && !videos.length) return;
    const where = sectionOf(document.elementFromPoint(e.clientX, e.clientY))
      ?? sectionOf(instance._sections[instance.state.slide - 1]);
    if (!where) return;
    const point = document.elementFromPoint(e.clientX, e.clientY);
    const under = topLevelChild(where.sec, point);
    const index = under && !under.matches('aside') ? authoredIndex(where.sec, under) : null;
    // dropped on a column: the server puts it inside, after the block it fell on
    const path = index !== null && point && point !== under && under.contains(point) ? pathFrom(under, point) : null;
    if (files.length) await placePictures(files, where, index, path);
    // a video is Add › Video's to place (add-content.js): copied beside the deck, then put where it fell
    if (videos.length) await videoDrop(videos, { slide: where.slide, sec: where.sec, index, path });
  });
  /**
   * Upload each picture and place it on the slide after element `index`
   * (last on the slide when null) — the drop, and the editing bar's Picture
   * button, which has no cursor to place by.
   */
  async function placePictures(files, where, index, path = null) {
    // Every picture but the last is placed quietly (`more`): the reload a
    // placement causes used to land before the next upload, and a drop of
    // five pictures stopped after the first. The last one reloads, all of them in.
    const job = (async () => { for (const [n, file] of files.entries()) {
      const more = n < files.length - 1;
      try {
        const up = await fetch(base() + '/deck/edit/asset', {
          method: 'POST', headers: { 'content-type': file.type, 'x-decklight-name': file.name }, body: file,
        });
        const j = await up.json().catch(() => ({}));
        if (!up.ok) throw new Error(j.error || String(up.status));
        const placed = await commit.send('/deck/edit/element/image', { slide: where.slide, index, ...(path?.length ? { path } : {}), src: j.src, alt: altFromName(file.name), more }, { quiet: false });
        // a second picture goes after the first, not before it (in the same column, when it went into one)
        if (Number.isInteger(placed.index)) { index = placed.index; path = placed.path?.length ? placed.path : null; }
        toast(`${file.name} added to slide ${where.slide} as ${j.src}${more ? '' : ' — reloading'}`, 2200);
      } catch (err) {
        toast(`could not add ${file.name}: ${String(err.message || err)}`, 6000);
      }
    } })();
    // the whole drop — upload, then place — is one write as far as Z is concerned
    editmode.trackWrite?.(job);
    await job;
  }

  return {
    /** `fn(files, { slide, sec, index, path })` places videos dropped on a slide (add-content.js). */
    setVideoDrop: (fn) => { videoDrop = fn; },
    /** Is an inline edit in progress? The deck's shortcuts stand aside while one is. */
    editing: () => !!editing,
    /**
     * The diagram's half of a label that wraps (shapes.js): `fit(text, words)`
     * breaks words to fit the shape a label is on, `{ lines, overflow }` or
     * null on no shape; `saved(text)` is told once a label is written.
     */
    setLabelHooks({ fit = null, saved = null } = {}) { labelFit = fit; labelSaved = saved; },
    /**
     * Edit `el` in place as a double-click would — text, or a code block as
     * its source. False when it is neither. `selectAll`: its words selected
     * whole, so typing replaces them (a placeholder just added).
     */
    /**
     * Start typing in `el`. `provisional: { save(el), cancel() }` is for words
     * the page shows before the file has them (a caption just added): the
     * typing ending (⏎, or leaving) calls `save` instead of writing the
     * element, Esc calls `cancel`, so the whole gesture is one write.
     */
    editInline(el, { selectAll = false, provisional = null } = {}) {
      if (!available()) return false;
      const where = sectionOf(el);
      if (!where || where.sec.hasAttribute('data-markdown-removed')) return false;
      if (provisional) { beginInline(el, where, { selectAll, provisional }); return editing?.el === el; }
      const code = el.closest?.(CODE_EDITABLE);
      if (code && where.sec.contains(code) && !code.closest('.terminal, aside, [data-chart]')) { beginCode(code, where, { selectAll }); return true; }
      const label = svgTextTarget(el, where.sec);
      if (label) { beginLabel(label, where); return true; }
      const text = editableTarget(el, where.sec);
      if (!text) {
        const formula = formulaTarget(el, where.sec);
        if (formula) beginFormula(formula, where, { selectAll });
        return !!formula;
      }
      beginInline(text, where, { selectAll });
      return true;
    },
    /**
     * Add pictures to the current slide, after element `afterIndex` (last when
     * null), or after the node at `afterPath` inside it — the bar's Picture button.
     */
    addPictures(files, { afterIndex = null, afterPath = null } = {}) {
      if (!available()) return Promise.resolve();
      const list = imageFiles(files);
      if (!list.length) { toast('that is not a picture — PNG, JPEG, GIF, WebP, SVG or AVIF', 3000); return Promise.resolve(); }
      const where = sectionOf(instance._sections[instance.state.slide - 1]);
      return where ? placePictures(list, where, afterIndex, afterPath) : Promise.resolve();
    },
  };
}
