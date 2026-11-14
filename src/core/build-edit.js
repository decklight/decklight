// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A node's build settings, changed from the page (PRESENTING_EDITING): its
// effect, whether it is there from the start, whether a list is one step or
// one an item, its looping animation. The Builds tab, Build ▸ and Animate ▸
// all come through here.
//
// The change is made on the page first, the slide's steps counted again where
// they stand (no reload), and the slide stepped to show the node; the server
// is asked for the same change, quietly (`POST /deck/edit/element/build`, one
// undo). A refusal puts the page back. A draw build carries more than marks
// (its strokes are prepared, its heads and masks added), so a change that
// gives or takes one is written the old way, and the page reloads.

import { createEditCommit } from './edit-commit.js';
import { authoredTop, authoredIndex } from './design-system.js';
import { pathFrom } from './colorpicker.js';
import { clearBuildMarks, stepShowing } from './builds.js';
import { reselectAfterReload, forgetReselect } from './editbar.js';

/** The attributes each field writes, and how a value reads on the page. */
const FIELDS = {
  effect: { attr: 'data-build', on: (v) => (v === '' ? '' : v) },
  stay: { attr: 'data-build-stay', on: (v) => (v ? '' : null) },
  self: { attr: 'data-build-self', on: (v) => (v ? '' : null) },
  animate: { attr: 'data-animate', on: (v) => v },
  drawStops: { attr: 'data-draw-stops', on: (v) => v },
  drawSpeed: { attr: 'data-draw-speed', on: (v) => (v === null ? null : String(Math.round(v))) },
};

/** Where a node is in the file: its slide, its block's index, the path below it. Null where the file has no such node. */
export function addressOf(instance, node) {
  const sec = node?.closest?.('section');
  const slide = sec ? instance._sections.indexOf(sec) + 1 : 0;
  if (!slide) return null;
  const top = authoredTop(sec, node);
  if (!top) return null;
  const path = node === top ? [] : pathFrom(top, node);
  if (!path) return null;
  return { sec, slide, index: authoredIndex(sec, top), top, path, tag: node.tagName.toLowerCase() };
}

/**
 * The key a diagram's group (`<g data-group>`, SVG_DIAGRAMS) takes when it is
 * made one step: its members' lowest, the click its first member played on,
 * when it has none of its own. Null otherwise.
 */
export function groupKeyOf(node) {
  if (!node?.matches?.('g[data-group]') || node.hasAttribute('data-build-order')) return null;
  const keys = [...node.children].map((c) => Number.parseInt(c.getAttribute('data-build-order') ?? '', 10)).filter(Number.isFinite);
  return keys.length ? String(Math.min(...keys)) : null;
}

export function createBuildEdit({ instance, editmode, toast = () => {} }) {
  const commit = createEditCommit(editmode);
  const inst = () => (typeof instance === 'function' ? instance() : instance);

  /** Does this change give or take a draw build (on the node, or the container it builds in)? */
  const touchesDraw = (node, fields) => fields.effect === 'draw' || 'drawStops' in fields || 'drawSpeed' in fields || node.getAttribute('data-build') === 'draw'
    || node.getAttribute('data-build-style') === 'draw' || node.closest('[data-build="draw"]') !== null;

  /** The slide's steps counted again where they stand, and the slide stepped to show `node` when it now waits. */
  function rescan(sec, node) {
    const it = inst();
    clearBuildMarks(sec);
    it.refreshSlide(sec, { scan: true, relayout: false });
    const slide = it._sections.indexOf(sec) + 1;
    if (it.state.slide !== slide) return;
    const want = node?.isConnected ? stepShowing(it._records[slide - 1], node) : 0;
    if (want > it.state.step) it.goto(slide, want);
  }

  /**
   * Change `node`'s build: `fields` is any of `{ effect, stay, self, animate }`
   * (setElementBuildAttrs' values). `said` is the toast for it. Resolves true
   * when the file has it.
   */
  async function set(node, fields, said) {
    if (!editmode.available?.()) { toast(editmode.cannot?.('changing a build') ?? 'changing a build needs write mode', 3200); return false; }
    const at = addressOf(inst(), node);
    if (!at) { toast('that node is the engine’s, not the file’s: give its block the build', 2600); return false; }
    const body = { slide: at.slide, index: at.index, ...(at.path.length ? { path: at.path, tag: at.tag } : {}), ...fields };
    const animateOnly = Object.keys(fields).every((k) => k === 'animate');
    // a draw build, or a page that cannot follow its slides in place: the write, then the reload
    if (!animateOnly && (touchesDraw(node, fields) || !inst().refreshSlide)) {
      // the page the write reloads selects it again, which steps the slide to it
      reselectAfterReload({ slide: at.slide, index: at.index, path: at.path });
      try {
        const j = await commit.post('/deck/edit/element/build', body, { quiet: false });
        if (j.changed === false) forgetReselect();
        toast(`${said} — reloading`, 1600);
        return true;
      } catch (e) { forgetReselect(); toast(commit.notSaved('the build', e), 6000); return false; }
    }
    // in place: the page first, as the file will be
    const before = Object.fromEntries(Object.keys(fields).map((k) => [k, node.getAttribute(FIELDS[k].attr)]));
    // a diagram's group made one step plays on its first member's click, as the server writes it (setElementBuildAttrs)
    const key = fields.self === true ? groupKeyOf(node) : null;
    const keyWas = node.getAttribute('data-build-order');
    const paint = (vals, k = null) => {
      for (const [f, v] of Object.entries(vals)) {
        const a = FIELDS[f].attr;
        if (v === null || v === undefined) node.removeAttribute(a); else node.setAttribute(a, v);
      }
      if (key !== null) { if (k === null) node.removeAttribute('data-build-order'); else node.setAttribute('data-build-order', k); }
      if (!animateOnly) rescan(at.sec, node);
    };
    paint(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, FIELDS[k].on(v)])), key);
    try {
      await commit.post('/deck/edit/element/build', body);
      toast(said, 1400);
      return true;
    } catch (e) {
      paint(before, keyWas);
      toast(commit.notSaved('the build', e), 6000);
      return false;
    }
  }

  /**
   * Slide `sec`'s build order, as arranged: `groups` is its clicks in play
   * order, each `[{ node, count }]` (buildlist.js's orderGroups). The server
   * stamps every node (`POST /deck/edit/slide/builds`, one undo) and answers
   * each one's order, which the page then wears, its steps counted again where
   * they stand: nothing on the slide moves, and nothing reloads.
   */
  async function order(sec, groups, said) {
    if (!editmode.available?.()) { toast(editmode.cannot?.('changing the build order') ?? 'changing the build order needs write mode', 3200); return false; }
    const it = inst();
    const slide = it._sections.indexOf(sec) + 1;
    const flat = groups.flat();
    const addrs = flat.map(({ node }) => addressOf(it, node));
    if (!slide || addrs.some((a) => !a || a.slide !== slide)) { toast('a step here is the engine’s, not the file’s: its order cannot be written', 3200); return false; }
    let k = 0;
    const body = {
      slide,
      groups: groups.map((g) => g.map(({ count }) => {
        const a = addrs[k++];
        return { index: a.index, ...(a.path.length ? { path: a.path } : {}), tag: a.tag, ...(count > 1 ? { count } : {}) };
      })),
    };
    try {
      const j = await commit.post('/deck/edit/slide/builds', body);
      (j.orders ?? []).forEach((o, i) => {
        const node = flat[i]?.node;
        if (!node) return;
        if (o.order === null) node.removeAttribute('data-build-order'); else node.setAttribute('data-build-order', o.order);
      });
      const step = it.state.slide === slide ? it.state.step : 0;
      clearBuildMarks(sec);
      it.refreshSlide(sec, { scan: true, relayout: false });
      // the click on screen stays on screen, now holding what plays there
      if (it.state.slide === slide && it.state.step !== Math.min(step, it._records[slide - 1]?.groups.length ?? 0)) it.goto(slide, step);
      toast(said, 1400);
      return true;
    } catch (e) {
      toast(commit.notSaved('the build order', e), 6000);
      return false;
    }
  }

  return { set, order, addressOf: (node) => addressOf(inst(), node) };
}
