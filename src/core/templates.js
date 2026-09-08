// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Taking slides from a deck template, from inside the deck (`UNITS#REST`).
 *
 * A template is somebody's whole deck, and `init --from` is the only thing
 * that ever used one — which means a deck you had already started could not
 * take anything from a template at all. This is the other half: browse what is
 * installed (and what a registered marketplace offers), look inside one, pick
 * the slides you want, and they land after the slide you are on.
 *
 * Author mode only, and ABSENT rather than disabled outside it — the same rule
 * the theme browser keeps, for the same reason: inserting slides writes the
 * deck on disk, and a deck being PRESENTED has no server to write it and no
 * business reaching a marketplace.
 *
 * Two views, because the two questions are separate and the second one is the
 * interesting one: WHICH TEMPLATE, then WHICH SLIDES. The slide view is a
 * multi-select — a template's value is usually three of its slides, not all
 * eight — and it says what each slide points at that this deck will not have,
 * before you take it rather than after.
 */

import { closeOnBackdrop, selectInList, typeaheadKeydown } from './overlay.js';

export function createTemplates({ root, overlays, editmode, deck, toast, dismissOthers }) {
  const base = () => editmode().base();
  const available = () => editmode().available() === true;

  let el = null;
  let view = 'list';          // 'list' | 'slides'
  let sel = 0;
  let filter = '';
  let listing = null;         // { installed, offered, stale } | { error } | null while loading
  let opened = null;          // { name, slides: [{n,title,hidden,needs}] } | { error }
  let chosen = new Set();     // slide numbers ticked in the slides view
  let busy = false;

  const isOpen = () => !!el;

  function close() {
    el?.remove();
    el = null;
    view = 'list';
    sel = 0;
    filter = '';
    chosen = new Set();
  }

  /** The rows the current view offers, as data — render() turns them into DOM. */
  function rows() {
    if (view === 'slides') {
      return (opened?.slides ?? []).map((s) => ({ kind: 'slide', slide: s }));
    }
    const q = filter.trim().toLowerCase();
    const hit = (name) => !q || name.toLowerCase().includes(q);
    const out = [];
    for (const name of listing?.installed ?? []) if (hit(name)) out.push({ kind: 'installed', name });
    for (const e of listing?.offered ?? []) if (hit(e.qualified)) out.push({ kind: 'offered', entry: e });
    return out;
  }

  function render() {
    if (!el) {
      el = document.createElement('div');
      el.className = 'decklight-narr decklight-tmpl';
      el.innerHTML = '<div class="narr-card"></div>';
      root.appendChild(el);
      closeOnBackdrop(el, close);
    }
    const card = el.querySelector('.narr-card');
    card.textContent = '';

    const head = document.createElement('div');
    head.className = 'narr-head';
    const at = deck().state.slide;
    head.textContent = view === 'slides'
      ? `${opened.name} — space picks, ⏎ inserts after slide ${at}`
      : 'insert from a template';
    card.append(head);

    const list = rows();
    if (view === 'list') {
      const f = document.createElement('div');
      f.className = 'narr-head tmpl-filter';
      f.textContent = filter ? `filter: ${filter}` : 'type to filter · ⏎ opens · esc closes';
      card.append(f);
    }

    if (listing?.error || opened?.error) {
      const err = document.createElement('div');
      err.className = 'narr-row narr-blocked';
      err.textContent = listing?.error ?? opened?.error;
      card.append(err);
      return;
    }
    if (!listing && view === 'list') {
      const wait = document.createElement('div');
      wait.className = 'narr-row narr-blocked';
      wait.textContent = 'reading what is installed…';
      card.append(wait);
      return;
    }
    if (!list.length) {
      const none = document.createElement('div');
      none.className = 'narr-row narr-blocked';
      none.textContent = view === 'slides'
        ? 'this template has no slides'
        : 'no deck template installed, and no registered marketplace offers one'
          + ' — decklight marketplace add <owner/repo>';
      card.append(none);
    }

    sel = Math.max(0, Math.min(sel, list.length - 1));
    list.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'narr-row' + (i === sel ? ' narr-sel' : '');
      const label = document.createElement('span');
      label.className = 'narr-row-label';

      if (r.kind === 'slide') {
        const { slide } = r;
        row.append(Object.assign(document.createElement('span'), {
          className: 'tmpl-check', textContent: chosen.has(slide.n) ? '☑' : '☐',
        }));
        label.textContent = `${slide.n}  ${slide.title}`;
        row.append(label);
        if (slide.hidden) row.append(tag('⊘ hidden'));
        // What it points at that this deck does not have. Said HERE, before the
        // slide is taken — the importer's rule, one step earlier.
        if (slide.needs.length) row.append(tag(`⚠ needs ${slide.needs.join(', ')}`));
      } else if (r.kind === 'installed') {
        label.textContent = r.name;
        row.append(label);
      } else {
        label.textContent = r.entry.qualified;
        row.append(label);
        row.append(tag('install'));
        if (r.entry.description) row.append(tag(r.entry.description));
      }
      row.addEventListener('click', () => { sel = i; commit(); });
      card.append(row);
    });

    if (view === 'slides' && list.length) {
      const foot = document.createElement('div');
      foot.className = 'narr-head';
      foot.textContent = `${chosen.size || 'none'} picked · a picks all · esc goes back`;
      card.append(foot);
    }
    const el2 = [...card.querySelectorAll('.narr-row')];
    selectInList(el2, sel, 'narr-sel');
  }

  const tag = (text) => Object.assign(document.createElement('span'), { className: 'narr-tag', textContent: text });

  async function open() {
    if (!available()) { toast('templates install through the author server — decklight author'); return; }
    dismissOthers?.();
    listing = null;
    view = 'list';
    sel = 0;
    render();
    try {
      const r = await fetch(base() + '/edit/template/list');
      const j = await r.json().catch(() => ({}));
      listing = r.ok && j.ok
        ? { installed: j.installed ?? [], offered: j.offered ?? [], stale: j.stale ?? [] }
        : { error: j.error || `the author server said ${r.status}` };
    } catch {
      listing = { error: 'the author server did not answer' };
    }
    if (el) render();
  }

  async function openTemplate(name) {
    opened = null;
    try {
      const r = await fetch(`${base()}/edit/template/slides?name=${encodeURIComponent(name)}`);
      const j = await r.json().catch(() => ({}));
      opened = r.ok && j.ok ? { name, slides: j.slides ?? [] } : { name, error: j.error || `the author server said ${r.status}` };
    } catch {
      opened = { name, error: 'the author server did not answer' };
    }
    if (!el) return;
    view = 'slides';
    sel = 0;
    chosen = new Set();
    render();
  }

  async function install(qualified) {
    if (busy) return;
    busy = true;
    toast(`installing ${qualified}…`);
    try {
      const r = await fetch(base() + '/edit/template/add', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: qualified }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the author server said ${r.status}`);
      toast(`installed ${j.name}`);
      await open();
      await openTemplate(j.name);
    } catch (e) {
      toast(`could not install ${qualified} — ${e.message}`);
    } finally {
      busy = false;
    }
  }

  async function insert() {
    const slides = [...chosen].sort((a, b) => a - b);
    if (!slides.length) return;
    if (busy) return;
    busy = true;
    const after = deck().state.slide;
    try {
      const r = await fetch(base() + '/edit/template/insert', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: opened.name, slides, after }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the author server said ${r.status}`);
      close();
      toast(`${j.inserted} slide${j.inserted === 1 ? '' : 's'} from ${j.name} after slide ${after} — Z takes it back`
        + (j.needs?.length ? `. They point at ${j.needs.join(', ')}, which this deck does not have` : ''), 6000);
    } catch (e) {
      toast(`could not insert — ${e.message}`);
    } finally {
      busy = false;
    }
  }

  /** Enter: open a template, install an offered one, or insert the picked slides. */
  function commit() {
    const list = rows();
    const row = list[sel];
    if (!row) return;
    if (row.kind === 'installed') { openTemplate(row.name); return; }
    if (row.kind === 'offered') { install(row.entry.qualified); return; }
    // a slide row: Enter with nothing ticked takes the one under the cursor,
    // which is what a single-slide trip through this panel looks like
    if (!chosen.size) chosen.add(row.slide.n);
    insert();
  }

  function keydown(e) {
    const list = rows();
    const move = (d) => { sel = (sel + d + list.length) % Math.max(1, list.length); render(); };

    if (view === 'slides') {
      // Not a typeahead: space is the verb here, and a filter would take it.
      if (e.key === 'ArrowDown') { move(1); return true; }
      if (e.key === 'ArrowUp') { move(-1); return true; }
      if (e.key === ' ') {
        const row = list[sel];
        if (row) { chosen.has(row.slide.n) ? chosen.delete(row.slide.n) : chosen.add(row.slide.n); render(); }
        return true;
      }
      if (e.key === 'a' || e.key === 'A') {
        chosen = chosen.size === list.length ? new Set() : new Set(list.map((r) => r.slide.n));
        render();
        return true;
      }
      if (e.key === 'Enter') { commit(); return true; }
      if (e.key === 'Escape' || e.key === 'ArrowLeft') { view = 'list'; sel = 0; render(); return true; }
      return true;
    }

    return typeaheadKeydown(e, {
      query: filter,
      onMove: move,
      onCommit: commit,
      onType: (ch) => { filter += ch; sel = 0; render(); },
      onBackspace: () => { filter = filter.slice(0, -1); sel = 0; render(); },
      onClear: () => { filter = ''; sel = 0; render(); },
      onClose: close,
    }) || true;
  }

  overlays.register({ isOpen, close, keydown });
  return { open, close, isOpen, available };
}
