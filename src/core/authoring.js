// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Editing a deck with a mouse — SPEC PRESENTING, author mode.
 *
 * Author mode could edit notes, replace an element's HTML in a textarea, remove
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

/** The elements a double-click may edit in place: text containers, nothing generated. */
export const EDITABLE = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, td, th, dt, dd';
/** Where a double-click must NOT edit: generated or structured content the source does not spell out. */
export const NOT_EDITABLE = 'pre, code, svg, .terminal, [data-chart], [data-math], aside, table[data-chart]';
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
export function altFromName(name) {
  return String(name ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').trim();
}

/** The dropped files worth uploading, in order; anything that is not an image is left where it was. */
export function imageFiles(list) {
  return Array.from(list ?? []).filter((f) => /^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/.test(f.type));
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
  return el;
}

export function createAuthoring({ root, instance, toast, editmode, debugLog = () => {} }) {
  const available = () => editmode.available?.() === true;
  const base = () => editmode.base?.() ?? '';
  const post = async (path, body) => {
    const res = await fetch(base() + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || String(res.status));
    return j;
  };
  const sectionOf = (node) => {
    const sec = node?.closest?.('section');
    const slide = sec ? instance._sections.indexOf(sec) + 1 : 0;
    return slide ? { sec, slide } : null;
  };
  const topLevelChild = (sec, target) => {
    let el = target;
    while (el && el !== sec && el.parentElement !== sec) el = el.parentElement;
    return el && el !== sec ? el : null;
  };

  // ── double-click to edit text ─────────────────────────────────────────────
  let editing = null; // { el, original, slide, index, path }

  async function saveInlineNow() {
    const cur = editing;
    if (!cur) return;
    if (cur.code) return saveCode(cur);
    editing = null;
    cur.el.removeAttribute('contenteditable');
    cur.el.classList.remove('dl-editing');
    const inner = cur.el.innerHTML;
    if (inner === cur.original) return; // nothing changed: nothing written, no reload
    try {
      const src = await fetch(`${base()}/edit/element/source?slide=${cur.slide}&index=${cur.index}`);
      const j = await src.json().catch(() => ({}));
      if (!src.ok || typeof j.html !== 'string') throw new Error(j.error || 'no source for this element');
      // The SOURCE of the top-level element, parsed inertly, so the file's own
      // attributes and siblings survive and only the edited node's content moves.
      const tpl = document.createElement('template');
      tpl.innerHTML = j.html;
      const top = tpl.content.firstElementChild;
      const node = nodeAtPath(top, cur.path);
      if (!node) throw new Error('the source has no element where the click landed');
      node.innerHTML = inner;
      await post('/edit/element/content', { slide: cur.slide, index: cur.index, html: top.outerHTML });
      toast('saved — reloading', 1400);
    } catch (e) {
      cur.el.innerHTML = cur.original;
      toast(`could not save the text: ${String(e.message || e).slice(0, 80)}`, 3000);
    }
  }

  // Tracked from its FIRST await, not just the POST: the save reads the element's
  // source before it writes, and a Z pressed during that read is exactly the one
  // that used to find "nothing to undo" while the edit landed behind it.
  function saveInline() {
    const p = saveInlineNow();
    editmode.trackWrite?.(p);
    return p;
  }

  function cancelInline() {
    const cur = editing;
    if (!cur) return;
    editing = null;
    if (cur.code) {
      cur.el.removeAttribute('contenteditable');
      cur.el.classList.remove('dl-editing');
      putBack(cur);
      return;
    }
    cur.el.innerHTML = cur.original;
    cur.el.removeAttribute('contenteditable');
    cur.el.classList.remove('dl-editing');
  }

  // ── double-click a code block ─────────────────────────────────────────────
  /** The source text of the `<code>` at `path` inside a top-level element, straight from the file. */
  async function codeSource(slide, index, path) {
    const src = await fetch(`${base()}/edit/element/source?slide=${slide}&index=${index}`);
    const j = await src.json().catch(() => ({}));
    if (!src.ok || typeof j.html !== 'string') throw new Error(j.error || 'no source for this code block');
    const tpl = document.createElement('template');
    tpl.innerHTML = j.html;
    const top = tpl.content.firstElementChild;
    const node = nodeAtPath(top, path);
    if (!node) throw new Error('the source has no code block where the click landed');
    return { top, node };
  }

  // The rendered lines are MOVED aside, not copied as HTML: the data-lines build
  // provider holds references to these very `.code-line` nodes, and an Escape
  // that re-parsed them would leave its steps pointing at nodes no longer shown.
  function putBack(cur) {
    cur.el.textContent = '';
    cur.el.appendChild(cur.kept);
  }

  async function beginCode(codeEl, { sec, slide }) {
    if (editing) await saveInline();
    const top = topLevelChild(sec, codeEl);
    if (!top) return;
    const index = Array.prototype.indexOf.call(sec.children, top);
    const path = childPath(top, codeEl);
    if (path === null) return;
    let text;
    try {
      const { node } = await codeSource(slide, index, path);
      // exactly what code.js renders from: one leading newline and the trailing
      // whitespace before `</code>` are layout of the file, not code
      text = node.textContent.replace(/^\n/, '').replace(/\s+$/, '');
    } catch (err) {
      toast(`could not edit the code: ${String(err.message || err).slice(0, 80)}`, 3000);
      return;
    }
    const kept = document.createDocumentFragment();
    while (codeEl.firstChild) kept.appendChild(codeEl.firstChild);
    codeEl.textContent = text;
    editing = { el: codeEl, code: true, kept, text, slide, index, path };
    // plaintext-only: typing and pasting stay text, Enter is a real newline
    codeEl.setAttribute('contenteditable', 'plaintext-only');
    if (codeEl.contentEditable !== 'plaintext-only') codeEl.setAttribute('contenteditable', 'true');
    codeEl.spellcheck = false;
    codeEl.classList.add('dl-editing');
    codeEl.focus();
    const range = document.createRange();
    range.selectNodeContents(codeEl);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    debugLog('info', `editing slide ${slide} element #${index}'s code`);
  }

  async function saveCode(cur) {
    editing = null;
    const el = cur.el;
    const plain = el.getAttribute('contenteditable') === 'plaintext-only';
    el.removeAttribute('contenteditable');
    el.classList.remove('dl-editing');
    const text = (plain ? el.textContent : el.innerText).replace(/\n$/, '');
    if (text === cur.text) { putBack(cur); return; }   // nothing changed: nothing written
    try {
      const { top, node } = await codeSource(cur.slide, cur.index, cur.path);
      // keep the file's own layout around the code, and let textContent escape
      // `<`, `>` and `&` on the way out — the attributes are never touched
      const raw = node.textContent;
      node.textContent = (raw.startsWith('\n') ? '\n' : '') + text + raw.match(/\s*$/)[0];
      await post('/edit/element/content', { slide: cur.slide, index: cur.index, html: top.outerHTML });
      toast('saved — reloading', 1400);
    } catch (e) {
      putBack(cur);
      toast(`could not save the code: ${String(e.message || e).slice(0, 80)}`, 3000);
    }
  }

  function beginInline(el, { sec, slide }) {
    if (editing) saveInline();
    const top = topLevelChild(sec, el);
    if (!top) return;
    const index = Array.prototype.indexOf.call(sec.children, top);
    const path = childPath(top, el);
    if (path === null) return;
    editing = { el, original: el.innerHTML, slide, index, path };
    el.setAttribute('contenteditable', 'true');
    el.classList.add('dl-editing');
    el.focus();
    // caret at the end, where a correction usually goes
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    debugLog('info', `editing slide ${slide} element #${index} inline`);
  }

  root.addEventListener('dblclick', (e) => {
    if (!available()) return;
    const where = sectionOf(e.target);
    if (!where || where.sec.hasAttribute('data-markdown-removed')) return;
    const code = e.target?.closest?.(CODE_EDITABLE);
    if (code && where.sec.contains(code) && !code.closest('.terminal, aside, [data-chart]')) {
      e.preventDefault();
      beginCode(code, where);
      return;
    }
    const el = editableTarget(e.target, where.sec);
    if (!el) return;
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
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveInline(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelInline(); }
  }, true);
  root.addEventListener('focusout', (e) => {
    if (editing && e.target === editing.el) saveInline();
  });

  // ── drop a picture onto the slide ─────────────────────────────────────────
  root.addEventListener('dragover', (e) => {
    // mid-drag the browser withholds the files themselves; the TYPES say whether
    // any are coming, and the drop below is where images are told from the rest
    if (!available() || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    root.classList.add('dl-dropping');
  });
  root.addEventListener('dragleave', (e) => {
    if (e.target === root || !root.contains(e.relatedTarget)) root.classList.remove('dl-dropping');
  });
  root.addEventListener('drop', async (e) => {
    root.classList.remove('dl-dropping');
    if (!available()) return;
    const files = imageFiles(e.dataTransfer?.files);
    if (!files.length) return;
    e.preventDefault();
    const where = sectionOf(document.elementFromPoint(e.clientX, e.clientY))
      ?? sectionOf(instance._sections[instance.state.slide - 1]);
    if (!where) return;
    const under = topLevelChild(where.sec, document.elementFromPoint(e.clientX, e.clientY));
    let index = under && !under.matches('aside') ? Array.prototype.indexOf.call(where.sec.children, under) : null;
    const job = (async () => { for (const file of files) {
      try {
        const up = await fetch(base() + '/edit/asset', {
          method: 'POST', headers: { 'content-type': file.type, 'x-decklight-name': file.name }, body: file,
        });
        const j = await up.json().catch(() => ({}));
        if (!up.ok) throw new Error(j.error || String(up.status));
        const placed = await post('/edit/image', { slide: where.slide, index, src: j.src, alt: altFromName(file.name) });
        // a second picture goes after the first, not before it
        if (Number.isInteger(placed.index)) index = placed.index;
        toast(`${file.name} added to slide ${where.slide} as ${j.src} — reloading`, 2200);
      } catch (err) {
        toast(`could not add ${file.name}: ${String(err.message || err).slice(0, 80)}`, 3200);
      }
    } })();
    // the whole drop — upload, then place — is one write as far as Z is concerned
    editmode.trackWrite?.(job);
    await job;
  });

  return {
    /** Is an inline edit in progress? The deck's shortcuts stand aside while one is. */
    editing: () => !!editing,
  };
}
