// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The Writing picker: one home for the writing tools (SPEC PRESENTING_VOICE).
 *
 * The tools used to be reached three ways that each looked different: two
 * buttons in the notes editor, a row and two views in the V panel, six palette
 * rows. Now every entry point opens this one card, which asks two things in
 * turn: which tool, then which slides. The scopes are the same everywhere,
 * this slide, its module (only when the deck has chapters), the whole deck,
 * with the counts the notes editor used to show.
 *
 * A tool is `{ id, group, label, flavor, kind }`; the groups are `script` (the
 * speaker notes: audio tags, written for the ear) and, later, `text` (the
 * slide's own words). Picking a tool moves to the scope rows; picking a scope
 * closes the card and runs the tool. What a run does with its answer is the
 * caller's: a script rewrite is held for review (cli/enhance.mjs, #907).
 *
 * Keys: ↑/↓ choose, ⏎ picks, ← (or Esc on the scope rows) goes back to the
 * tools, Esc closes. A click on a row picks it.
 */

import { closeOnBackdrop, selectInList } from './overlay.js';

/** The tools, in the order the card lists them. */
export const WRITING_TOOLS = [
  { id: 'tags', group: 'script', label: '✨ add audio tags', flavor: 'same words, the tags ElevenLabs v4 performs', kind: 'tags' },
  { id: 'spoken', group: 'script', label: '🗣 write it for the ear', flavor: 'terse notes as sentences a person would say', kind: 'spoken' },
];
const GROUPS = { script: 'script — the speaker notes', text: 'slide text — the words on the slide' };

/**
 * The scope rows for slide `n` of `total`, given the module it is in (or
 * null): `[{ scope, label, flavor }]`. Pure.
 */
export function scopeRows(n, total, mod) {
  const rows = [{ scope: 'slide', label: `this slide · ${n}`, flavor: 'its notes' }];
  if (mod) rows.push({ scope: 'module', label: `module “${mod.title}” · ${mod.to - mod.from + 1}`, flavor: `slides ${mod.from}–${mod.to}` });
  rows.push({ scope: 'all', label: `whole deck · ${total}`, flavor: 'every slide with notes — the agent is asked once per slide' });
  return rows;
}

/**
 * `tools()` answers the tools on offer (WRITING_TOOLS, or fewer); `where()`
 * answers `{ slide, total, module }` for the scope rows; `agent()` the agent
 * that will be asked, `{ label, model? }` or null; `run(tool, scope)` does it.
 */
export function createWritingPicker({ root, overlays, toast = () => {}, tools = () => WRITING_TOOLS, where, agent = () => null, run }) {
  let el = null, rows = [], rowEls = [], sel = 0;
  let tool = null;      // the tool picked; null while the tools are listed
  let before = null;    // what the caller wants done first (the notes box saved)

  const node = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function close() {
    el?.remove();
    el = null;
    tool = null;
    before = null;
  }

  /** The card, rebuilt for the step it is on. */
  function render() {
    const card = el.querySelector('.narr-card');
    card.replaceChildren();
    rows = [];
    rowEls = [];
    const head = node('div', 'narr-head', tool ? `${tool.label} — which slides?` : 'writing');
    card.append(head);
    const row = (r, cls = '') => {
      const x = node('div', `narr-row ${cls}`.trim());
      x.setAttribute('role', 'option');
      const text = node('div', 'narr-text', r.label);
      x.append(text);
      if (r.flavor) x.append(node('div', 'narr-flavor', r.flavor));
      x.addEventListener('mouseenter', () => { sel = selectInList(rowEls, rows.length ? rowEls.indexOf(x) : 0, 'narr-sel'); });
      x.addEventListener('click', () => { sel = rowEls.indexOf(x); pick(); });
      rows.push(r);
      rowEls.push(x);
      card.append(x);
    };
    if (!tool) {
      let group = null;
      for (const t of tools()) {
        if (t.group !== group) { group = t.group; card.append(node('div', 'narr-group', GROUPS[group] ?? group)); }
        row(t);
      }
    } else {
      const w = where();
      for (const r of scopeRows(w.slide, w.total, w.module)) row(r);
    }
    const a = agent();
    const foot = node('div', 'narr-foot', tool
      ? `↑↓ pick · ⏎ runs it · ← back · Esc close${a ? ` · ${a.label}${a.model ? ` · ${a.model}` : ''} is asked, read-only; the notes go to it` : ''}`
      : `↑↓ pick · ⏎ choose which slides · Esc close${a ? ` · ${a.label}${a.model ? ` · ${a.model}` : ''}` : ''}`);
    card.append(foot);
    sel = selectInList(rowEls, Math.min(sel, Math.max(0, rowEls.length - 1)), 'narr-sel');
  }

  async function pick() {
    const r = rows[sel];
    if (!r) return;
    if (!tool) { tool = r; sel = 0; render(); return; }
    const t = tool, scope = r.scope, first = before;
    close();
    if (first && (await first()) === false) return;
    run(t, scope);
  }

  function back() {
    if (!tool) { close(); return; }
    const was = tool;
    tool = null;
    sel = Math.max(0, tools().indexOf(was));
    render();
  }

  /**
   * Open on the tools (or, given `tool`, an id, straight on its scope rows;
   * given `group`, selected on that group's first tool). `before()` runs
   * when a scope is picked, before the tool, and may answer false to stop.
   */
  function open({ tool: id = null, group = null, before: first = null } = {}) {
    if (el) close();
    overlays.opening();
    const list = tools();
    if (!list.length) { toast('no writing tool here — they need write mode and an agent CLI on the dev machine', 3200); return; }
    before = first;
    tool = id ? list.find((t) => t.id === id) ?? null : null;
    sel = group && !tool ? Math.max(0, list.findIndex((t) => t.group === group)) : 0;
    el = node('div', 'decklight-narr decklight-writing');
    const card = node('div', 'narr-card');
    card.setAttribute('role', 'listbox');
    card.setAttribute('aria-label', 'Writing');
    el.append(card);
    closeOnBackdrop(el, close);
    root.appendChild(el);
    // the keys are the picker's: a notes box left focused under it would
    // keep them as typing
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
    render();
  }

  function keydown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case 'ArrowDown': sel = selectInList(rowEls, sel + 1, 'narr-sel'); return true;
      case 'ArrowUp': sel = selectInList(rowEls, sel - 1, 'narr-sel'); return true;
      case 'Enter': pick(); return true;
      case 'ArrowLeft': back(); return true;
      case 'Escape': if (tool) back(); else close(); return true;
      default: return true;   // modal: a letter typed here reaches no deck key
    }
  }

  // first: opened over a docked panel (the notes card), it owns the keys
  overlays.register({ isOpen: () => !!el, close, keydown, modal: true, transient: true, first: true });

  return { open, close, isOpen: () => !!el, state: () => ({ tool: tool?.id ?? null, rows: rows.map((r) => r.label), sel }) };
}
