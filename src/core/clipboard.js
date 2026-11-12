// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The clipboard in write mode (SPEC PRESENTING_EDITING).
//
// ⌘V / Ctrl+V used to be the browser's alone, which pastes nowhere on a
// slide. Here one `paste` listener on the document reads what the system
// clipboard carries (the system one, not a store of our own, because it is
// what crosses from a screenshot tool, a browser, another deck's tab) and
// hands it to whatever takes that kind: a picture goes on the slide as a
// dropped file does, and another app's words become a paragraph, or a list
// when they are several lines (add-content.js). Copying an element or a slide
// comes next, through the same classifier.
//
// The listener stands aside wherever the typing guard does: a box being typed
// in, words being edited (authoring.js cleans that paste itself), a locked
// deck, an embedded or printed one.

import { imageFiles } from './authoring.js';
import { innerPath } from './editbar.js';
import { pastedWords } from './list-edit.js';

/**
 * What a clipboard carries, as one kind the editor acts on:
 *
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
  if (files.length) return { kind: 'pictures', files };
  const html = data.getData?.('text/html') ?? '';
  const text = data.getData?.('text/plain') ?? '';
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

export function createClipboard({ editmode, authoring, editbar, addContent = null }) {
  /** Write mode with editing on and nothing being typed: the only time a paste is the editor's. */
  const ours = (e) => editmode.elementEditOn?.() && editmode.available?.() !== false
    && !authoring.editing() && !typingTarget(e.target);

  function onPaste(e) {
    if (!ours(e)) return;
    const clip = classifyClipboard(e.clipboardData);
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
  return { classify: classifyClipboard, destroy: () => document.removeEventListener('paste', onPaste) };
}
