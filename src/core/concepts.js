// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// "Concept colors…" — the deck's concepts (SPEC SVG_DIAGRAMS, #718) in one
// list, write mode only: every `data-concept` name a diagram on the deck
// carries, with the slot it resolves to and how many shapes wear it, plus
// any name the deck's configuration pins that no shape uses yet. A slot
// picked here is the deck's — `concepts` in the deck's configuration, written
// in place by the edit server — and every open page recolours at once, no
// reload: the page that picked already shows it, the others are sent a
// `concepts` event. Digits 1–6 pin the selected concept to a slot, 0 (or ⌫)
// takes the pin off and the name falls back to its stable hash.

import { escapeHtml } from './escape.js';
import { closeOnBackdrop, selectInList } from './overlay.js';
import { conceptFill, conceptSlot } from './svg.js';

const NAME = /^[a-z][a-z0-9-]{0,40}$/i;

/** Every concept the deck carries: `[{ name, shapes }]`, document order, names configured but unused last. */
export function conceptsOn(stage, concepts = {}) {
  const seen = new Map();
  stage.querySelectorAll('svg [data-concept]').forEach((el) => {
    const name = el.getAttribute('data-concept');
    if (!name || !NAME.test(name)) return;
    seen.set(name, (seen.get(name) ?? 0) + 1);
  });
  for (const name of Object.keys(concepts)) if (!seen.has(name)) seen.set(name, 0);
  return [...seen].map(([name, shapes]) => ({ name, shapes }));
}

/**
 * `base()` is the edit server's URL, or null when there is none; `stage()` the
 * deck's stage, read when the list opens. `concepts()`
 * is the deck's live map (the engine's `config.concepts`); `apply(map)` is
 * what repaints the stage with a new one and keeps it as the page's.
 */
export function createConceptsEditor({ root, base, toast, stage, concepts, apply, pageId = () => '', debugLog = () => {} }) {
  let el = null, rows = [], sel = 0, busy = false;
  const card = () => el?.querySelector('.narr-card');

  const pinOf = (name) => {
    const v = concepts()?.[name];
    if (typeof v === 'number') return { slot: v, how: 'pinned' };
    if (typeof v === 'string') return { slot: null, how: 'custom', css: v };
    return { slot: conceptSlot(name), how: 'auto' };
  };

  function render() {
    const c = card();
    if (!c) return;
    rows = conceptsOn(stage(), concepts());
    let html = '<div class="narr-head">concept colors — one slot per concept, deck-wide</div>';
    if (!rows.length) html += '<div class="rec-line">No diagram on this deck names a concept yet — right-click a shape → Concept ▸ gives it one</div>';
    rows.forEach((r, i) => {
      const pin = pinOf(r.name);
      const fill = conceptFill(r.name, concepts());
      const slots = [1, 2, 3, 4, 5, 6].map((n) => `<button type="button" class="cc-slot${pin.slot === n ? ' cc-on' : ''}" data-i="${i}" data-slot="${n}" `
        + `style="background: var(--d-fill-${n})" title="Fill ${n}" aria-label="${escapeHtml(r.name)} → fill ${n}" aria-pressed="${pin.slot === n}"></button>`).join('');
      const how = pin.how === 'pinned' ? `pinned to fill ${pin.slot}` : pin.how === 'custom' ? `custom · ${escapeHtml(pin.css)}` : `fill ${pin.slot} by its name`;
      html += `<div class="narr-row cc-row" data-i="${i}" data-name="${escapeHtml(r.name)}">`
        + `<span class="cc-swatch" style="background: ${escapeHtml(fill)}"></span>`
        + `<span class="narr-row-label">${escapeHtml(r.name)} <span class="narr-flavor">${r.shapes} shape${r.shapes === 1 ? '' : 's'} · ${how}</span></span>`
        + `<span class="cc-slots">${slots}<button type="button" class="cc-auto${pin.how === 'auto' ? ' cc-on' : ''}" data-i="${i}" title="no pin — the name picks its own slot" aria-pressed="${pin.how === 'auto'}">auto</button></span>`
        + '</div>';
    });
    html += '<div class="rec-hint">↑/↓ · 1–6 pins the slot, 0 takes the pin off · written to the deck, every page follows · Esc closes</div>';
    c.innerHTML = html;
    c.querySelectorAll('.cc-row').forEach((r) => r.addEventListener('mouseenter', () => select(Number(r.dataset.i))));
    c.querySelectorAll('.cc-slot').forEach((b) => b.addEventListener('click', () => { select(Number(b.dataset.i)); pin(Number(b.dataset.slot)); }));
    c.querySelectorAll('.cc-auto').forEach((b) => b.addEventListener('click', () => { select(Number(b.dataset.i)); pin(null); }));
    select(Math.min(sel, Math.max(0, rows.length - 1)));
  }

  function select(i) {
    sel = i;
    selectInList([...(card()?.querySelectorAll('.cc-row') ?? [])], i, 'narr-sel');
  }

  /** Pin the selected concept to `slot` (1–6), or take its pin off (null). */
  async function pin(slot) {
    const r = rows[sel];
    if (!r || busy) return;
    const was = { ...(concepts() ?? {}) };
    const next = { ...was };
    if (slot === null) delete next[r.name]; else next[r.name] = slot;
    if (JSON.stringify(next) === JSON.stringify(was)) return;
    busy = true;
    apply(next);   // at once: the write below is what makes it the deck's
    render();
    try {
      const res = await fetch(`${base()}/deck/edit/concepts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ concepts: next, quiet: true, from: pageId() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || `the edit server answered ${res.status}`);
      debugLog('concepts', `${r.name} → ${slot === null ? 'auto' : `fill ${slot}`}`);
      toast(slot === null ? `${r.name}: pin taken off — fill ${conceptSlot(r.name)} by its name · Z takes it back` : `${r.name} → fill ${slot}, deck-wide · Z takes it back`, 2600);
    } catch (e) {
      apply(was);
      render();
      toast(`concept not saved: ${String(e.message || e).slice(0, 90)}`, 3400);
    } finally {
      busy = false;
    }
  }

  function open() {
    if (el) return;
    if (base() === null) { toast('concept colors are set in write mode — decklight <deck.html>', 3200); return; }
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-record decklight-concepts';
    el.innerHTML = '<div class="narr-card" role="listbox" aria-label="Concept colors"></div>';
    closeOnBackdrop(el, close);
    root.appendChild(el);
    sel = 0;
    render();
  }

  function close() { el?.remove(); el = null; rows = []; }

  function keydown(e) {
    if (e.key === 'Escape') { close(); return true; }
    if (e.key === 'ArrowDown') { select(Math.min(rows.length - 1, sel + 1)); return true; }
    if (e.key === 'ArrowUp') { select(Math.max(0, sel - 1)); return true; }
    if (/^[1-6]$/.test(e.key)) { pin(Number(e.key)); return true; }
    if (e.key === '0' || e.key === 'Backspace') { pin(null); return true; }
    return true;   // the list holds the keyboard while it is open
  }

  /** The deck's concepts changed on another page: the list follows. */
  function refresh() { if (el) render(); }

  return { open, close, keydown, refresh, isOpen: () => !!el };
}
