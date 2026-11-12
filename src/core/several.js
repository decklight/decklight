// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Several elements selected (PRESENTING_EDITING): what changes one changes all
// of them, in ONE write, so one undo takes it all back. Remove, Duplicate,
// Move up and down, Paste style, and the inspector's Colors and Type picks.
//
// Each is written through the element routes' `items` form (cli/edit.mjs's
// batch transforms) and shown in place: the page makes the same change to its
// own slide and counts the slide's steps again. A slide a template laid out,
// or one with something live on it (a video, a terminal), cannot follow in
// place: its write reloads the page, as a one-element move does there.

import { createEditCommit } from './edit-commit.js';
import { authoredIndex } from './design-system.js';
import { contentOf } from './element-move.js';

/** Something live on a slide: moved or copied in the DOM, it would restart. */
const LIVE = '.terminal, video, audio, iframe, canvas';

export function createSeveral({ instance, editmode, editbar, toast, styleClip = () => null }) {
  const commit = createEditCommit(editmode);
  const inst = () => (typeof instance === 'function' ? instance() : instance);

  /** The batch's `items` in file order, and the slide they are on: null unless they are top-level elements of one slide. */
  function batchOf(targets) {
    const sec = targets[0]?.sec;
    if (!sec || targets.some((t) => t.sec !== sec || !t.top || t.node !== t.top)) return null;
    const slide = inst()._sections.indexOf(sec) + 1;
    const els = [...new Set(targets.map((t) => t.top))].sort((a, b) => authoredIndex(sec, a) - authoredIndex(sec, b));
    return { sec, slide, els, items: els.map((el) => ({ index: authoredIndex(sec, el), tag: el.tagName.toLowerCase() })) };
  }
  const followsInPlace = (sec) => !!inst().refreshSlide && !sec.hasAttribute('data-template') && !sec.querySelector(LIVE);
  const refuse = () => { toast('several are top-level elements of one slide: select them again', 2600); return false; };
  const canWrite = () => {
    if (editmode.available?.()) return true;
    toast(editmode.cannot?.('changing several elements') ?? 'that needs write mode', 3200);
    return false;
  };

  /** The slide's steps counted again, the page laid out again, after a change made in place. */
  function relayout(sec, extra = {}) {
    inst().refreshSlide(sec, { scan: true, ...extra });
  }

  /** Remove them all: one write, one undo. */
  async function remove(targets) {
    const b = batchOf(targets);
    if (!b) return refuse();
    if (!canWrite()) return false;
    const inPlace = followsInPlace(b.sec);
    try {
      await commit.post('/deck/edit/element/remove', { slide: b.slide, items: b.items }, { quiet: inPlace });
    } catch (e) { toast(commit.notSaved(`${b.els.length} elements`, e), 6000); return false; }
    if (!inPlace) { commit.reload(`${b.els.length} elements removed`, { slide: b.slide }); return true; }
    for (const el of b.els) el.remove();
    relayout(b.sec);
    toast(`${b.els.length} elements removed · ${editmode.undoChord?.() ?? 'undo'} takes them back`, 2400);
    return true;
  }

  /** Each copied right after itself: one write; the copies are shown where the file put them, and selected. */
  async function duplicate(targets) {
    const b = batchOf(targets);
    if (!b) return refuse();
    if (!canWrite()) return false;
    const inPlace = followsInPlace(b.sec);
    let j;
    try {
      j = await commit.post('/deck/edit/element/duplicate', { slide: b.slide, items: b.items }, { quiet: inPlace });
    } catch (e) { toast(commit.notSaved('the copies', e), 6000); return false; }
    if (!inPlace || !Array.isArray(j.copies) || j.copies.length !== b.els.length) { commit.reload(`${b.els.length} elements duplicated`, { slide: b.slide }); return true; }
    const copies = b.els.map((el, k) => {
      const tpl = document.createElement('template');
      tpl.innerHTML = j.copies[k].html;
      const copy = tpl.content.firstElementChild;
      el.after(copy);
      return copy;
    });
    relayout(b.sec, { charts: true, svgs: copies, code: copies });
    editbar.selectSeveral?.(copies);
    toast(`${copies.length} elements duplicated`, 1600);
    return true;
  }

  /** One place up (`dir` -1) or down (1), together: one write; each steps past the element beside it that is not selected. */
  async function move(targets, dir) {
    const b = batchOf(targets);
    if (!b) return refuse();
    if (!canWrite()) return false;
    const inPlace = followsInPlace(b.sec);
    try {
      await commit.post('/deck/edit/element/move', { slide: b.slide, items: b.items, dir }, { quiet: inPlace });
    } catch (e) { toast(`could not move them: ${commit.why(e)}`, 4000); return false; }
    if (!inPlace) { commit.reload(`${b.els.length} elements moved`, { slide: b.slide }); return true; }
    // the same steps on the page: each past its neighbour, nearest the end it goes to first
    const order = dir === -1 ? b.els : [...b.els].reverse();
    for (const el of order) {
      const list = contentOf(b.sec);
      const other = list[list.indexOf(el) + dir];
      if (!other) continue;
      if (dir === -1) other.before(el); else other.after(el);
    }
    relayout(b.sec);
    toast(`${b.els.length} elements moved ${dir === -1 ? 'up' : 'down'}`, 1400);
    return true;
  }

  /**
   * Style edits (`[{ prop, value }]`, on the elements themselves) on every one
   * of them: the same for all, or `edits(el)` for each. Shown at once, one
   * write. What the inspector's Colors and Type tabs pick with several
   * selected, and Paste style.
   */
  async function style(targets, edits, said = 'restyled') {
    const b = batchOf(targets);
    if (!b) return refuse();
    if (!canWrite()) return false;
    const each = b.els.map((el) => ({ el, edits: (typeof edits === 'function' ? edits(el) : edits) ?? [] })).filter((x) => x.edits.length);
    if (!each.length) { toast('nothing here takes that style', 2200); return false; }
    const before = each.map(({ el, edits: eds }) => eds.map((ed) => [el, ed.prop, el.style.getPropertyValue(ed.prop), el.style.getPropertyPriority(ed.prop)]));
    for (const { el, edits: eds } of each) for (const ed of eds) { if (ed.value === null) el.style.removeProperty(ed.prop); else el.style.setProperty(ed.prop, ed.value); }
    try {
      await commit.post('/deck/edit/element/style', {
        slide: b.slide,
        items: each.map(({ el, edits: eds }) => ({ index: authoredIndex(b.sec, el), edits: eds.map((ed) => ({ path: [], tag: el.tagName.toLowerCase(), prop: ed.prop, value: ed.value })) })),
      });
    } catch (e) {
      for (const list of before) for (const [el, prop, v, pr] of list) { if (v) el.style.setProperty(prop, v, pr); else el.style.removeProperty(prop); }
      toast(commit.notSaved('the style', e), 6000);
      return false;
    }
    toast(`${each.length} elements ${said}`, 1400);
    return true;
  }

  /** Paste style on all of them: the copied style, worked out for each as a one-element paste would. */
  async function pasteStyle(targets) {
    const clip = styleClip();
    if (!clip?.has?.()) { toast('no style copied yet: copy one from an element first', 2600); return false; }
    const byEl = new Map(targets.map((t) => [t.top, t]));
    return style(targets, (el) => clip.editsFor(byEl.get(el)), 'given the copied style');
  }

  return { remove, duplicate, move, style, pasteStyle };
}
