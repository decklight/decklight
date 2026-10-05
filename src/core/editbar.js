// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Editing, as one thing you can see — SPEC PRESENTING, author mode.
//
// Author mode could edit a word (double-click), add a picture (drop a file),
// change a layout (L), edit the notes (S), act on an element (E, then a
// right-click), act on the slide (five palette rows), and take it all back
// (Z). Eight doors, each learnt separately, none of them on screen: the only
// way to know editing existed was to already know the keys.
//
// `E` now opens EDITING, and editing has a face:
//
//   THE BAR, along the bottom of the deck: Text, Picture, Layout, Notes,
//   Slide ▾, Undo, Redo, Done — each with the key it stands for, so the keys
//   are learnt by using the bar rather than needed before it.
//
//   SELECTION: a click on an element selects it (outlined, with a ⋯ handle at
//   its corner that opens the element's menu by left-click). With something
//   selected, ⏎ edits it in place when it is text and opens its menu when it
//   is not, ⌫ removes it (Z takes it back), Esc lets it go. The right-click
//   menu and the drop still work exactly as before, and the double-click
//   edits only while editing is on: the bar
//   is a surface over them, not a replacement.
//
// Nothing here writes to the file. Every action goes through the route the
// key or the gesture already used, so each one lands on the same undo stack.

import { authoredTop } from './design-system.js';
import { editableTarget, CODE_EDITABLE } from './authoring.js';

const BUTTONS = [
  { id: 'text', label: 'Text', key: '⏎', title: 'select some text and press Enter, or double-click it' },
  { id: 'picture', label: 'Picture', key: '', title: 'add a picture (or drop one onto the slide)' },
  { id: 'layout', label: 'Layout', key: 'L', title: 'cycle this slide\'s layout (⇧L backwards)' },
  { id: 'notes', label: 'Notes', key: 'S', title: 'edit the speaker notes' },
  { id: 'slide', label: 'Slide ▾', key: '', title: 'new, duplicate, move or delete this slide' },
  { id: 'undo', label: 'Undo', key: 'Z', title: 'take the last edit back' },
  { id: 'redo', label: 'Redo', key: '⇧Z', title: 'put it back' },
  { id: 'done', label: 'Done', key: 'E', title: 'stop editing' },
];

export function createEditBar({
  root, instance, editmode, authoring, toast, debugLog = () => {},
  toggleEditor, cycleLayout, deckHistory, enabled = () => true,
}) {
  let bar = null, handle = null, fileInput = null;
  let selected = null;   // the element target (editmode.elementTargetOf) under the outline
  let hovered = null;    // the top-level element under the pointer

  const on = () => editmode.elementEditOn() && enabled();
  const inOverlay = (node) => !!node?.closest?.('.decklight-narr, .decklight-ctxmenu, .decklight-palette, .decklight-editbar, .decklight-touch-controls, .decklight-controls');

  // ── the bar ───────────────────────────────────────────────────────────────
  function layoutLabel() {
    const sec = instance._sections[instance.state.slide - 1];
    return sec?.getAttribute('data-layout') || 'auto';
  }
  function mount() {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'decklight-editbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Editing');
    for (const b of BUTTONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `eb-btn eb-${b.id}`;
      btn.title = b.title;
      btn.dataset.action = b.id;
      const label = document.createElement('span');
      label.className = 'eb-label';
      label.textContent = b.label;
      btn.append(label);
      if (b.key) {
        const key = document.createElement('kbd');
        key.className = 'eb-key';
        key.textContent = b.key;
        btn.append(key);
      }
      // the pointer down must not steal focus from an inline edit in progress
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => { e.stopPropagation(); run(b.id, btn); });
      bar.append(btn);
    }
    root.appendChild(bar);
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.className = 'eb-file';
    fileInput.setAttribute('aria-label', 'picture to add');
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files ?? []);
      fileInput.value = '';
      if (files.length) authoring.addPictures(files, { afterIndex: selected?.index ?? null });
    });
    bar.append(fileInput);
    refresh();
  }
  function unmount() {
    deselect();
    bar?.remove();
    bar = null;
    fileInput = null;
  }
  /** The bar follows the slide: the layout button names the layout this slide has. */
  function refresh() {
    if (!bar) return;
    const b = bar.querySelector('.eb-layout .eb-label');
    if (b) b.textContent = `Layout · ${layoutLabel()}`;
  }

  function run(id, btn) {
    switch (id) {
      case 'text': {
        const el = selected && textTarget(selected);
        if (el) authoring.editInline(el);
        else toast('double-click any text to edit it — or click it, then press ⏎', 3200);
        break;
      }
      case 'picture': fileInput?.click(); break;
      case 'layout': cycleLayout(1); refresh(); break;
      case 'notes': toggleEditor(); break;
      case 'slide': {
        const r = btn.getBoundingClientRect();
        const target = { sec: instance._sections[instance.state.slide - 1], slide: instance.state.slide, index: null, top: null, clicked: null, fromBar: true };
        editmode.openElementMenuAt(r.left, r.top - 8, target, 'slide', { above: true });
        break;
      }
      case 'undo': deckHistory('undo'); break;
      case 'redo': deckHistory('redo'); break;
      case 'done': editmode.toggleElementEdit(); break;
      default: break;
    }
  }

  // ── selection ─────────────────────────────────────────────────────────────
  /** The text element an Enter would edit: the one clicked when it is text, else the top-level one when it is. */
  function textTarget(target) {
    const code = target.clicked?.closest?.(CODE_EDITABLE);
    if (code && target.sec.contains(code)) return code;
    return editableTarget(target.clicked, target.sec) ?? editableTarget(target.top, target.sec);
  }
  function placeHandle() {
    if (!selected || !handle) return;
    const r = selected.top.getBoundingClientRect();
    const base = root.getBoundingClientRect();
    handle.style.left = `${r.right - base.left - 4}px`;
    handle.style.top = `${r.top - base.top - 10}px`;
  }
  function select(target) {
    deselect();
    selected = target;
    target.top.classList.add('dl-selected');
    handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'dl-handle';
    handle.title = 'what you can do with this element';
    handle.textContent = '⋯';
    handle.addEventListener('mousedown', (e) => e.preventDefault());
    handle.addEventListener('click', (e) => {
      e.stopPropagation();
      editmode.openElementMenuAt(e.clientX, e.clientY, selected);
    });
    root.appendChild(handle);
    placeHandle();
    debugLog('edit', `selected slide ${target.slide} element #${target.index}`);
  }
  function deselect() {
    selected?.top.classList.remove('dl-selected');
    selected = null;
    handle?.remove();
    handle = null;
  }
  function hover(top) {
    if (hovered === top) return;
    hovered?.classList.remove('dl-hover');
    hovered = top;
    hovered?.classList.add('dl-hover');
  }

  root.addEventListener('click', (e) => {
    if (!on() || authoring.editing() || inOverlay(e.target)) return;
    const target = editmode.elementTargetOf(e.target);
    if (target?.top) { if (selected?.top !== target.top) select(target); }
    else deselect();
  });
  root.addEventListener('mousemove', (e) => {
    if (!on() || inOverlay(e.target)) { hover(null); return; }
    const sec = e.target.closest?.('section');
    hover(sec ? authoredTop(sec, e.target) : null);
  });
  root.addEventListener('mouseleave', () => hover(null));
  window.addEventListener('resize', placeHandle);
  // a new slide is a new selection: nothing on it was chosen yet
  instance.on('slide', () => { deselect(); refresh(); });

  /**
   * The keys a selection answers, before the deck's own: ⏎ edits (text) or
   * opens the menu (anything else), ⌫/Delete removes, Esc lets go. True when
   * the key was taken.
   */
  function keydown(e) {
    if (!on() || !selected || authoring.editing()) return false;
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const el = textTarget(selected);
      if (el) { authoring.editInline(el); deselect(); }
      else {
        const r = selected.top.getBoundingClientRect();
        editmode.openElementMenuAt(r.left + 12, r.top + 12, selected);
      }
      return true;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const target = selected;
      deselect();
      editmode.removeElement(target);
      return true;
    }
    if (e.key === 'Escape') { deselect(); return true; }
    return false;
  }

  /** After E: show or hide the bar to match. */
  function sync() {
    if (on()) mount(); else unmount();
    root.classList.toggle('dl-editmode', on());
  }
  editmode.onElementEditChange(sync);

  return { sync, keydown, refresh, selected: () => selected, isOpen: () => !!bar };
}
