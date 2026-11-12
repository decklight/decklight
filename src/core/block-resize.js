// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * How wide a block may be (PRESENTING_EDITING): a selected chart, text,
 * quote, list, table or code block has a handle on each side, and dragging
 * one sets its `max-width` in deck px through `POST /deck/edit/element/style`
 * (one write, one undo); a double-click takes it off, back to automatic. The
 * handles are the pictures' (resize-handles.js): the slide never clips past
 * where it fit, a block in a column is never wider than the column, and one
 * that is half of a split slide never wider than its half.
 */

import { createResizeHandles, SIDES, contentWidth } from './resize-handles.js';
import { sizedOf } from './pictures.js';
import { pathFrom } from './colorpicker.js';
import { createEditCommit } from './edit-commit.js';

/** The blocks a side handle sizes, most specific first: a point means its list, a cell its table. */
const KINDS = [
  ['[data-chart]', 'chart'], ['table', 'table'], ['pre', 'code block'],
  ['ul, ol', 'list'], ['blockquote', 'quote'], ['p', 'text'],
];
const MIN = 40;

/** The block a selection sizes by its sides, and what to call it; null for anything else. */
export function blockOf(target) {
  const n = target?.node ?? target?.top;
  if (!n?.isConnected || !target.top?.contains(n) || sizedOf(target)) return null;
  if (n.closest('svg:not([data-chart] svg), aside, .slide-bg')) return null;
  for (const [sel, label] of KINDS) {
    const b = n.closest(sel);
    if (b && target.top.contains(b)) return { el: b, label };
  }
  return null;
}

/**
 * The widest a block may be: what its container holds, and, a direct half
 * of a split slide, its half (the layout's 48%).
 */
export function widestFor(el) {
  const parent = el.parentElement;
  const room = contentWidth(parent);
  return parent?.matches?.('section[data-layout|="split"]') ? Math.floor(room * 0.48) : Math.floor(room);
}

export function createBlockResize({ root, instance, editmode, editbar, toast }) {
  const em = () => editmode();
  const commit = createEditCommit({ base: () => em()?.base?.() ?? '', pageId: () => em()?.pageId?.(), offline: () => em()?.offline?.(),
    noteHistory: (j) => em()?.noteHistory?.(j), trackWrite: (p) => em()?.trackWrite?.(p) });
  const say = (what) => em()?.cannot?.(what) ?? `${what} needs write mode`;
  const handles = createResizeHandles({ root, instance, editmode, toast, say });
  const k = () => instance()?._scale || 1;

  /** The block laid out again for its new width: a fitted code block measured again (SPEC CODE_AND_MATH). */
  const relayout = (el) => { const sec = el.closest('section'); if (sec) instance()?.refreshSlide?.(sec, { scan: false }); };

  /** One write of the block's `max-width` (null: off), the page already showing it; `undo` on a refusal. */
  async function save(el, w, undo) {
    const t = em()?.elementTargetOf?.(el);
    const path = t?.top ? (t.top === el ? [] : pathFrom(t.top, el)) : null;
    if (!t || t.index == null || t.index < 0 || !path) { undo(); toast('that block is the engine’s, not the file’s: nothing to change', 2600); return false; }
    try {
      await commit.post('/deck/edit/element/style', { slide: t.slide, index: t.index, edits: [{ path, tag: el.tagName.toLowerCase(), prop: 'max-width', value: w === null ? null : `${w}px` }] });
      relayout(el);
      return true;
    } catch (e) {
      undo();
      toast(commit.notSaved('the width', e), 6000);
      return false;
    }
  }

  const SPEC = {
    handles: SIDES,
    min: MIN,
    snapshot: (el) => el.style.maxWidth,
    restore: (el, s) => { el.style.maxWidth = s; },
    apply: (el, w) => { el.style.maxWidth = w === null ? '' : `${w}px`; },
    max: (el) => widestFor(el),
    commit: (el, w, was) => save(el, w, () => { el.style.maxWidth = was; }),
    reset: (el) => {
      if (!el.style.maxWidth) { toast('it is as wide as it is by itself already', 2000); return; }
      const was = el.style.maxWidth;
      el.style.maxWidth = '';
      save(el, null, () => { el.style.maxWidth = was; });
    },
  };

  editbar()?.onSelect?.((t) => {
    if (handles.dragging()) return;
    const b = em()?.elementEditOn?.() === false ? null : blockOf(t);
    if (b) handles.mount(b.el, { ...SPEC, label: b.label }); else handles.unmount();
  });

  return { handled: () => handles.current(), blockOf, widest: widestFor, width: (el) => Math.round(el.getBoundingClientRect().width / k()) };
}
