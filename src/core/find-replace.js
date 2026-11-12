// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Find and replace (PRESENTING_EDITING): the palette's *Find and replace…*,
 * a panel docked beside the slide (⌘F stays the browser's). It lists every
 * match in the deck's file with its slide and the words around it; a click
 * goes to the slide, a row's Replace replaces that one, and Replace all every
 * one, in one write and one undo (cli/find-replace.mjs). A replace is refused
 * with a sentence when the deck changed since the search.
 *
 * It looks in the slides' text, and in the notes and in code when asked;
 * never in a tag, an attribute, a script or a style. A match that runs across
 * formatting (`<b>quar</b>ter`) is not found in the file, so the panel says
 * how many the slides show that it cannot reach.
 */

import { createDock } from './dock.js';
import { createEditCommit } from './edit-commit.js';
import { boundedFetch } from './devmode.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : (w.endsWith('ch') ? 'es' : 's')}`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * How many times the slides SHOW `find` across formatting, beyond the text
 * runs the file is searched in: each block's text read whole, against its
 * text nodes one by one. The difference is what a file search cannot reach.
 */
export function acrossFormatting(sections, find, { caseSensitive = false, wholeWord = false, code = false } = {}) {
  if (!find.trim()) return 0;
  const body = escapeRe(find);
  const re = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body, `gu${caseSensitive ? '' : 'i'}`);
  const count = (s) => (s.match(re) ?? []).length;
  const SKIP = `script, style, aside, .slide-bg, .decklight-hero-logo${code ? '' : ', pre, code'}`;
  let more = 0;
  for (const sec of sections) {
    for (const block of sec.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, td, th, figcaption, blockquote, dt, dd, text')) {
      if (block.closest(SKIP) || block.querySelector('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote')) continue;
      const nodes = [];
      const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (!n.parentElement?.closest(SKIP)) nodes.push(n.data);
      more += Math.max(0, count(nodes.join('')) - nodes.reduce((k, t) => k + count(t), 0));
    }
  }
  return more;
}

export function createFindReplace({ root, overlays, toast, instance, editmode }) {
  const commit = createEditCommit(editmode);
  let el = null;
  let onResize = null;
  let timer = 0;
  let asked = 0;           // the latest search, so a slow answer never paints over a newer one
  let state = { find: '', replace: '', opts: { notes: false, code: false, caseSensitive: false, wholeWord: false }, count: 0, matches: [], error: null, busy: false };
  const em = () => editmode();
  const dock = createDock({
    root,
    reflow: () => instance()?._reflow?.(),
    getEl: () => el,
    closeLabel: 'close (esc)',
    defaultMode: 'right',
    name: 'Find',
    open: () => { if (!el) open(); },
    close: () => { if (el) close(); },
  });

  async function search() {
    const n = ++asked;
    const find = state.find;
    if (!find.trim()) { state = { ...state, count: 0, matches: [], error: null }; paint(); return; }
    const o = state.opts;
    const q = new URLSearchParams({ q: find, ...(o.notes ? { notes: '1' } : {}), ...(o.code ? { code: '1' } : {}), ...(o.caseSensitive ? { case: '1' } : {}), ...(o.wholeWord ? { word: '1' } : {}) });
    try {
      const res = await boundedFetch((em()?.base?.() ?? '') + '/deck/edit/find?' + q);
      const j = await res.json().catch(() => ({}));
      if (n !== asked || !el) return;
      if (!res.ok || j.ok === false) throw new Error(j.error || String(res.status));
      state = { ...state, count: j.count, matches: j.matches ?? [], error: null };
    } catch (e) {
      if (n !== asked || !el) return;
      state = { ...state, count: 0, matches: [], error: commit.why(e) };
    }
    paint();
  }
  const searchSoon = () => { clearTimeout(timer); timer = setTimeout(search, 250); };

  /** Replace the matches named (all of them with none named), in one write; the search runs again after. */
  async function replace(only = null) {
    if (state.busy || !state.count) return;
    state.busy = true;
    paint();
    try {
      const j = await commit.post('/deck/edit/replace', {
        find: state.find, replace: state.replace, opts: state.opts, expect: state.count, ...(only ? { only } : {}),
      }, { quiet: false });
      toast(`replaced ${plural(j.count, 'match')}: one undo takes ${j.count === 1 ? 'it' : 'them all'} back`, 3200);
    } catch (e) {
      toast(`nothing replaced: ${commit.why(e)}`, 6000);
    } finally {
      state.busy = false;
      if (el) await search();
    }
  }

  function input(value, placeholder, label, onInput) {
    const i = Object.assign(document.createElement('input'), { type: 'text', className: 'fr-input', value, placeholder });
    i.setAttribute('aria-label', label);
    i.spellcheck = false;
    i.addEventListener('input', () => onInput(i.value));
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); search(); }
    });
    return i;
  }

  function paint() {
    if (!el) return;
    const card = el.querySelector('.narr-card');
    const focused = el.contains(document.activeElement) ? document.activeElement.name || null : null;
    const at = document.activeElement?.selectionStart ?? null;
    card.replaceChildren();
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.append(Object.assign(document.createElement('span'), { className: 'dk-title', textContent: 'Find and replace' }), dock.controls(close));
    dock.wireHeader(head);
    card.append(head);

    const form = Object.assign(document.createElement('div'), { className: 'fr-form' });
    const find = input(state.find, 'find', 'find', (v) => { state.find = v; searchSoon(); });
    find.name = 'fr-find';
    const rep = input(state.replace, 'replace with', 'replace with', (v) => { state.replace = v; });
    rep.name = 'fr-replace';
    form.append(find, rep);
    const opts = Object.assign(document.createElement('div'), { className: 'fr-opts' });
    for (const [k, label] of [['caseSensitive', 'Match case'], ['wholeWord', 'Whole word'], ['notes', 'Notes'], ['code', 'Code']]) {
      const l = document.createElement('label');
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: state.opts[k] });
      box.name = `fr-${k}`;
      box.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
      box.addEventListener('change', () => { state.opts = { ...state.opts, [k]: box.checked }; search(); });
      l.append(box, document.createTextNode(` ${label}`));
      opts.append(l);
    }
    form.append(opts);
    card.append(form);

    const list = Object.assign(document.createElement('div'), { className: 'fr-list' });
    const said = Object.assign(document.createElement('div'), { className: 'fr-said' });
    if (state.error) said.textContent = `not searched: ${state.error}`;
    else if (!state.find.trim()) said.textContent = 'type what to find: the slides’ text, and the notes or code when ticked';
    else {
      const slides = new Set(state.matches.map((m) => m.slide)).size;
      said.textContent = state.count ? `${plural(state.count, 'match')} on ${plural(slides, 'slide')}` : 'no matches';
      const more = acrossFormatting(instance()?._sections ?? [], state.find, state.opts);
      if (more) {
        said.append(Object.assign(document.createElement('span'), { className: 'fr-more',
          textContent: ` · ${more} more on the slides run across bold, a link or other formatting, and are not found here` }));
      }
    }
    list.append(said);
    for (const m of state.matches) {
      const row = Object.assign(document.createElement('div'), { className: 'narr-row fr-row' });
      row.dataset.id = m.id;
      const where = Object.assign(document.createElement('span'), { className: 'fr-where', textContent: `slide ${m.slide}${m.notes ? ' · notes' : ''}` });
      const ctx = Object.assign(document.createElement('span'), { className: 'fr-ctx' });
      ctx.append(document.createTextNode(`…${m.before}`), Object.assign(document.createElement('mark'), { textContent: m.text }), document.createTextNode(`${m.after}…`));
      const one = Object.assign(document.createElement('button'), { type: 'button', className: 'fr-btn', textContent: 'Replace', disabled: state.busy });
      one.addEventListener('click', (e) => { e.stopPropagation(); replace([m.id]); });
      row.append(where, ctx, one);
      row.addEventListener('click', () => instance()?.goto?.(m.slide, 0));
      list.append(row);
    }
    if (state.count > state.matches.length) list.append(Object.assign(document.createElement('div'), { className: 'fr-said', textContent: `and ${state.count - state.matches.length} more` }));
    card.append(list);
    const foot = Object.assign(document.createElement('div'), { className: 'fr-foot' });
    const all = Object.assign(document.createElement('button'), { type: 'button', className: 'fr-btn fr-all',
      textContent: state.count ? `Replace all ${state.count}` : 'Replace all', disabled: state.busy || !state.count });
    all.addEventListener('click', (e) => { e.stopPropagation(); replace(null); });
    foot.append(all);
    card.append(foot, dock.foot('esc closes · ⌘F is the browser’s', 'fr-keys'));
    // the field typed in keeps its caret through the repaint
    const back = focused ? card.querySelector(`[name="${focused}"]`) : null;
    if (back) { back.focus(); if (at !== null) back.setSelectionRange(at, at); }
  }

  function open() {
    if (el) { el.querySelector('[name="fr-find"]')?.focus(); return; }
    if (!em()?.available?.()) { toast('find and replace is write mode’s: it changes the deck’s file', 3200); return; }
    overlays.opening();
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-dockable decklight-findreplace';
    el.innerHTML = '<div class="narr-card" aria-label="Find and replace"></div>';
    el.addEventListener('click', (e) => e.stopPropagation());
    root.appendChild(el);
    dock.reserveGutter();
    onResize = () => dock.reserveGutter();
    window.addEventListener('resize', onResize);
    paint();
    el.querySelector('[name="fr-find"]')?.focus();
    if (state.find) search();
  }
  function close() {
    if (!el) return;
    clearTimeout(timer);
    el.remove();
    el = null;
    if (onResize) { window.removeEventListener('resize', onResize); onResize = null; }
    dock.release();
  }

  overlays.register({
    isOpen: () => !!el,
    close,
    keydown(e) { if (e.key === 'Escape') { close(); return true; } return false; },   // the deck's keys pass: a panel beside the slide
    modal: false,
    panel: true,
  });

  return { open, close, isOpen: () => !!el, search, replace };
}
