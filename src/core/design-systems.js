// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// "Design systems…" — the palette's list of every design system every
// registered marketplace offers, author mode only (SPEC DESIGN_SYSTEMS).
//
// Each row says whether this deck references it — ● uses, ○ does not — and
// Space (or ⏎, or a click) toggles it through the author server
// (POST /edit/design-system/mark): one entry in the deck's config block, one
// undo entry, and the reload that brings the deck back WITH the design system
// linked, since linking is the server's job. Cache-only, like the theme
// picker: a marketplace that could not be read is named with the command that
// fixes it, never silently missing.

import { escapeHtml } from './escape.js';
import { closeOnBackdrop, selectInList } from './overlay.js';
import { pageDesignSystems, setupSystemLayouts, isSystemLayout } from './design-system.js';

/**
 * `base()` is the author server's URL, or null when there is none — and `''`
 * when the deck is served BY the author server, every fetch same-origin, so
 * only `null` means "no server": an empty base is the commonest one.
 */
export function createDesignSystemsPicker({ root, base, toast, debugLog = () => {} }) {
  let el = null, rows = [], sel = 0, busy = false;

  const card = () => el?.querySelector('.narr-card');

  function render(state) {
    const c = card();
    if (!c) return;
    if (state.loading) { c.innerHTML = '<div class="narr-head">design systems</div><div class="rec-line">asking the author server…</div>'; return; }
    if (state.error) { c.innerHTML = `<div class="narr-head">design systems</div><div class="rec-line rec-warn">${escapeHtml(state.error)}</div><div class="rec-hint">Esc to close</div>`; return; }
    const { systems, stale } = state;
    const groups = new Map();
    for (const s of systems) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group).push(s);
    }
    let html = '<div class="narr-head">design systems — ● this deck uses it · Space toggles</div>';
    rows = [];
    for (const [group, list] of groups) {
      html += `<div class="narr-group">${escapeHtml(group)}</div>`;
      for (const s of list) {
        const i = rows.length;
        rows.push(s);
        html += `<div class="narr-row ds-row${s.used ? ' narr-cur' : ''}${s.missing ? ' narr-blocked' : ''}" data-i="${i}">`
          + `<span class="narr-row-label">${s.used ? '●' : '○'} ${escapeHtml(s.qualified)}`
          + `${s.version ? ` <span class="narr-flavor">${escapeHtml(s.version)}</span>` : ''}`
          + `${s.description ? ` <span class="narr-flavor">${escapeHtml(s.description)}</span>` : ''}</span>`
          + `${s.missing ? `<div class="narr-fix">${escapeHtml(s.missing)}</div>` : ''}</div>`;
      }
    }
    if (!systems.length) html += '<div class="rec-line">No registered marketplace offers a design system — decklight marketplace add &lt;owner/repo&gt;</div>';
    for (const m of stale) html += `<div class="rec-line rec-warn">${escapeHtml(m)} could not be read — decklight marketplace update ${escapeHtml(m)}</div>`;
    html += '<div class="rec-hint">↑/↓ · Space or ⏎ toggles · Esc closes</div>';
    c.innerHTML = html;
    c.querySelectorAll('.ds-row').forEach((r) => {
      r.addEventListener('mouseenter', () => select(Number(r.dataset.i)));
      r.addEventListener('click', () => { select(Number(r.dataset.i)); toggle(); });
    });
    select(Math.min(sel, Math.max(0, rows.length - 1)));
  }

  function select(i) {
    sel = i;
    selectInList([...(card()?.querySelectorAll('.ds-row') ?? [])], i, 'narr-sel');
  }

  async function open() {
    if (el) return;
    if (base() === null) { toast('design systems are referenced while authoring — decklight author <deck.html>', 3200); return; }
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-record decklight-design-systems';
    el.innerHTML = '<div class="narr-card" role="listbox" aria-label="Design systems"></div>';
    closeOnBackdrop(el, close);
    root.appendChild(el);
    sel = 0;
    render({ loading: true });
    try {
      const r = await fetch(`${base()}/edit/design-system/browse`);
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error ?? `the author server answered ${r.status}`);
      render({ systems: j.systems ?? [], stale: j.stale ?? [] });
    } catch (e) {
      render({ error: `could not list design systems — ${e.message ?? e}` });
    }
  }

  async function toggle() {
    const s = rows[sel];
    if (!s || busy) return;
    if (s.missing && !s.used) { toast(`${s.qualified}: ${s.missing}`, 6000); return; }
    busy = true;
    try {
      const r = await fetch(`${base()}/edit/design-system/mark`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: s.qualified, used: !s.used }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error([j.error, ...(j.problems ?? []).slice(0, 2)].filter(Boolean).join(' · ') || `the author server answered ${r.status}`);
      debugLog('design-system', `${j.used ? 'referenced' : 'dropped'} ${j.ref}`);
      // the server links it in; the reload the write causes brings it back applied
      toast(j.changed ? `${j.used ? '● this deck now uses' : '○ dropped'} ${j.ref} — Z takes it back` : `${j.ref}: nothing to change`, 3200);
      close();
    } catch (e) {
      toast(`${s.qualified} — ${e.message ?? e}`, 7000);
    } finally {
      busy = false;
    }
  }

  function close() {
    el?.remove();
    el = null;
    rows = [];
  }

  function keydown(e) {
    if (e.key === 'Escape') { close(); return true; }
    if (e.key === 'ArrowDown') { select(Math.min(rows.length - 1, sel + 1)); return true; }
    if (e.key === 'ArrowUp') { select(Math.max(0, sel - 1)); return true; }
    if (e.key === ' ' || e.key === 'Enter') { toggle(); return true; }
    return true;   // the list holds the keyboard while it is open
  }

  return { open, close, keydown, isOpen: () => !!el };
}

// ── Use design-system layout… ───────────────────────────────────────────────
// Put this slide into one of the deck's design-system layouts, move it to
// another, take it out, or insert a new slide in one (SPEC DESIGN_SYSTEMS).
// The layouts listed are the ones the PAGE carries (the meta block the server
// injected); the write goes to the author server, which reads the layout from
// the package on disk, never from here — POST /edit/slide/system-layout, one
// undo entry, and a sentence saying what went where.


export function createSystemLayoutPicker({ root, base, toast, deck, debugLog = () => {} }) {
  let el = null, rows = [], sel = 0, view = 'layouts', chosen = null, busy = false;
  const card = () => el?.querySelector('.narr-card');

  /** The deck's design systems and their layouts, as the page has them. */
  function listed() {
    const out = [];
    for (const meta of document.querySelectorAll('script[type="application/json"][data-design-system-meta]')) {
      let m;
      try { m = JSON.parse(meta.textContent); } catch { continue; }
      for (const l of m.layouts ?? []) out.push({ system: m.name, title: m.title, ref: `${m.name}/${l.id}`, layout: l });
    }
    return out;
  }

  /** A scaled slide in the layout, its slots showing their defaults — what choosing it would look like. */
  function preview(ref) {
    const box = card()?.querySelector('.dsl-preview');
    if (!box) return;
    box.replaceChildren();
    if (!ref) return;
    const sec = document.createElement('section');
    sec.className = 'dsl-preview-slide';
    sec.setAttribute('data-layout', ref);
    box.appendChild(sec);
    setupSystemLayouts([sec], { systems: pageDesignSystems() });
    // a slot with no default content would preview as nothing: name it, faintly
    for (const slot of sec.querySelectorAll('[data-slot]')) {
      if (!slot.textContent.trim() && !slot.children.length) {
        slot.textContent = slot.getAttribute('data-slot');
        slot.classList.add('dsl-placeholder');
      }
    }
  }

  function render() {
    const c = card();
    if (!c) return;
    const slide = deck().state.slide;
    const current = deck()._sections[slide - 1]?.getAttribute('data-layout') ?? '';
    rows = [];
    let html = '';
    if (view === 'layouts') {
      const all = listed();
      html += `<div class="narr-head">use a design-system layout — slide ${slide}${isSystemLayout(current) ? ` is ${escapeHtml(current)}` : ''}</div>`;
      html += '<div class="dsl-split"><div class="dsl-list">';
      if (isSystemLayout(current)) {
        rows.push({ remove: true });
        html += `<div class="narr-row dsl-row" data-i="0"><span class="narr-row-label">↩ Take slide ${slide} out of ${escapeHtml(current)} <span class="narr-flavor">back to a plain slide</span></span></div>`;
      }
      let group = null;
      for (const l of all) {
        if (l.system !== group) { group = l.system; html += `<div class="narr-group">${escapeHtml(l.title ?? l.system)}</div>`; }
        const i = rows.length;
        rows.push(l);
        const slots = l.layout.slots.map((s) => `${s.name}${s.required ? '*' : ''}`).join(' · ');
        html += `<div class="narr-row dsl-row${l.ref === current ? ' narr-cur' : ''}" data-i="${i}"><span class="narr-row-label">${escapeHtml(l.ref)}`
          + ` <span class="narr-flavor">${escapeHtml(slots)}</span></span></div>`;
      }
      if (!all.length) html += '<div class="rec-line">This deck uses no design system — Design systems… adds one.</div>';
      html += '</div><div class="dsl-preview" aria-hidden="true"></div></div>';
      html += '<div class="rec-hint">↑/↓ · ⏎ chooses · Esc closes</div>';
    } else {
      const switching = isSystemLayout(current);
      rows = [{ act: 'apply' }, { act: 'insert' }];
      html += `<div class="narr-head">${escapeHtml(chosen.ref)}</div>`
        + `<div class="narr-row dsl-row" data-i="0"><span class="narr-row-label">${switching ? 'Switch' : 'Put'} slide ${slide} ${switching ? 'to' : 'in'} it`
        + ` <span class="narr-flavor">${switching ? 'content stays by slot name' : 'its content assigned to slots by their hints'}</span></span></div>`
        + `<div class="narr-row dsl-row" data-i="1"><span class="narr-row-label">Insert a new slide in it after slide ${slide}`
        + ' <span class="narr-flavor">its required slots, ready to fill</span></span></div>'
        + '<div class="rec-hint">⏎ does it · Esc back</div>';
    }
    c.innerHTML = html;
    c.querySelectorAll('.dsl-row').forEach((r) => {
      r.addEventListener('mouseenter', () => select(Number(r.dataset.i)));
      r.addEventListener('click', () => { select(Number(r.dataset.i)); choose(); });
    });
    select(Math.min(sel, Math.max(0, rows.length - 1)));
  }

  function select(i) {
    sel = i;
    selectInList([...(card()?.querySelectorAll('.dsl-row') ?? [])], i, 'narr-sel');
    if (view === 'layouts') preview(rows[i]?.ref ?? null);
  }

  async function send(body, what) {
    if (busy) return;
    busy = true;
    try {
      const r = await fetch(`${base()}/edit/slide/system-layout`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error ?? `the author server answered ${r.status}`);
      debugLog('design-system', `slide ${body.slide}: ${j.said}`);
      toast(`${j.said} — Z takes it back`, 6000);
      close();
    } catch (e) {
      toast(`${what}: ${e.message ?? e}`, 7000);
    } finally {
      busy = false;
    }
  }

  function choose() {
    const slide = deck().state.slide;
    const row = rows[sel];
    if (!row) return;
    if (view === 'layouts') {
      if (row.remove) return send({ slide, layout: null }, 'could not take the slide out');
      chosen = row;
      view = 'actions';
      sel = 0;
      return render();
    }
    if (row.act === 'insert') return send({ slide, layout: chosen.ref, insert: true }, 'could not insert the slide');
    return send({ slide, layout: chosen.ref }, 'could not lay the slide out');
  }

  function open() {
    if (el) return;
    if (base() === null) { toast('design-system layouts are chosen while authoring — decklight author <deck.html>', 3200); return; }
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-record decklight-ds-layouts';
    el.innerHTML = '<div class="narr-card" role="listbox" aria-label="Use design-system layout"></div>';
    closeOnBackdrop(el, close);
    root.appendChild(el);
    view = 'layouts';
    sel = 0;
    render();
  }

  function close() { el?.remove(); el = null; rows = []; }

  function keydown(e) {
    if (e.key === 'Escape') {
      if (view === 'actions') { view = 'layouts'; sel = 0; render(); } else close();
      return true;
    }
    if (e.key === 'ArrowDown') { select(Math.min(rows.length - 1, sel + 1)); return true; }
    if (e.key === 'ArrowUp') { select(Math.max(0, sel - 1)); return true; }
    if (e.key === 'Enter') { choose(); return true; }
    return true;
  }

  return { open, close, keydown, isOpen: () => !!el };
}
