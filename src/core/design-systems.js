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

/** `base()` is the author server's URL, or null when there is none. */
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
    if (!base()) { toast('design systems are referenced while authoring — decklight author <deck.html>', 3200); return; }
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
