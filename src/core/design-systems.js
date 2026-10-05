// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// "Design systems…" — the palette's list of every design system every
// registered marketplace offers, write mode only (SPEC DESIGN_SYSTEMS).
//
// Each row says whether this deck references it — ● uses, ○ does not — and
// Space (or ⏎, or a click) toggles it through the edit server
// (POST /edit/design-system/mark): one entry in the deck's config block, one
// undo entry, and the reload that brings the deck back WITH the design system
// linked, since linking is the server's job. Cache-only, like the theme
// picker: a marketplace that could not be read is named with the command that
// fixes it, never silently missing.

import { escapeHtml } from './escape.js';
import { closeOnBackdrop, selectInList } from './overlay.js';
import { pageDesignSystems, setupSystemLayouts, isSystemLayout } from './design-system.js';

/**
 * `base()` is the edit server's URL, or null when there is none — and `''`
 * when the deck is served BY the edit server, every fetch same-origin, so
 * only `null` means "no server": an empty base is the commonest one.
 */
export function createDesignSystemsPicker({ root, base, toast, debugLog = () => {} }) {
  let el = null, rows = [], sel = 0, busy = false;

  const card = () => el?.querySelector('.narr-card');

  function render(state) {
    const c = card();
    if (!c) return;
    if (state.loading) { c.innerHTML = '<div class="narr-head">design systems</div><div class="rec-line">asking the edit server…</div>'; return; }
    if (state.error) { c.innerHTML = `<div class="narr-head">design systems</div><div class="rec-line rec-warn">${escapeHtml(state.error)}</div><div class="rec-hint">Esc to close</div>`; return; }
    const { systems, stale, unfetched = [] } = state;
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
    // never fetched is not a fault — nothing is fetched unasked — so it is
    // said plainly, and only a cached catalog that no longer reads is a warning
    for (const m of unfetched) html += `<div class="rec-line">${escapeHtml(m)} has not been fetched yet — decklight marketplace update ${escapeHtml(m)}</div>`;
    for (const m of stale) html += `<div class="rec-line rec-warn">${escapeHtml(m)}'s cached catalog could not be read — decklight marketplace update ${escapeHtml(m)}</div>`;
    html += '<div class="rec-hint">↑/↓ · Space or ⏎ toggles — with its recommended themes and fonts (⇧ for the design system alone) · Esc closes</div>';
    c.innerHTML = html;
    c.querySelectorAll('.ds-row').forEach((r) => {
      r.addEventListener('mouseenter', () => select(Number(r.dataset.i)));
      r.addEventListener('click', (e) => { select(Number(r.dataset.i)); toggle(e.shiftKey); });
    });
    select(Math.min(sel, Math.max(0, rows.length - 1)));
  }

  function select(i) {
    sel = i;
    selectInList([...(card()?.querySelectorAll('.ds-row') ?? [])], i, 'narr-sel');
  }

  async function open() {
    if (el) return;
    if (base() === null) { toast('design systems are referenced in write mode — decklight <deck.html>', 3200); return; }
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
      if (!r.ok || !j.ok) throw new Error(j.error ?? `the edit server answered ${r.status}`);
      render({ systems: j.systems ?? [], stale: j.stale ?? [], unfetched: j.unfetched ?? [] });
    } catch (e) {
      render({ error: `could not list design systems — ${e.message ?? e}` });
    }
  }

  async function toggle(alone = false) {
    const s = rows[sel];
    if (!s || busy) return;
    if (s.missing && !s.used) { toast(`${s.qualified}: ${s.missing}`, 6000); return; }
    busy = true;
    try {
      // its recommended themes and fonts come with it unless ⇧ is held — the
      // UI's --no-recommended (SPEC DESIGN_SYSTEMS)
      const r = await fetch(`${base()}/edit/design-system/mark`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: s.qualified, used: !s.used, recommended: !alone }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error([j.error, ...(j.problems ?? []).slice(0, 2)].filter(Boolean).join(' · ') || `the edit server answered ${r.status}`);
      debugLog('design-system', `${j.used ? 'referenced' : 'dropped'} ${j.ref}`);
      // the server links it in; the reload the write causes brings it back applied
      // Referencing changes nothing on screen by itself — a design system styles
      // only the slides that name its layouts — so the toast says what to do next.
      const came = (j.pulled ?? []).filter((x) => x.status === 'add');
      const withIt = came.length ? ` — with ${came.map((x) => `${x.kind} ${x.family ?? x.ref}`).join(', ')}` : '';
      const lost = (j.pulled ?? []).filter((x) => x.status === 'skip');
      toast(!j.changed ? `${j.ref}: nothing to change`
        : j.used ? `● this deck now uses ${j.ref}${withIt}${lost.length ? ` · ⚠ not added: ${lost.map((x) => `${x.rec} (${x.why})`).join('; ')}` : ''}`
          + ' — its layouts are in / → Use design-system layout… · Z takes it back'
          : `○ dropped ${j.ref} — Z takes it back`, j.used && j.changed ? 7000 : 3200);
      // the look it was drawn for is OFFERED after the reload this write brings
      // — by then the page has the theme and font it would switch to
      if (j.used && j.look?.differs) rememberOffer({ ref: j.ref, ...j.look });
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
    if (e.key === ' ' || e.key === 'Enter') { toggle(e.shiftKey); return true; }
    return true;   // the list holds the keyboard while it is open
  }

  return { open, close, keydown, isOpen: () => !!el };
}

// ── the look a design system was drawn for ─────────────────────────────────
// Adding a design system brings its recommended themes and fonts; APPLYING
// them — the deck's theme and font — is offered, never automatic (SPEC
// DESIGN_SYSTEMS): one dialog, the slide previewing the look live behind it,
// ⏎ applies (POST /edit/design-system/apply, one undo), Esc keeps the current
// look. The offer survives the reload the add causes, in sessionStorage.

const OFFER_KEY = () => 'decklight-look-offer:' + location.pathname;
function rememberOffer(offer) {
  try { sessionStorage.setItem(OFFER_KEY(), JSON.stringify(offer)); } catch { /* private mode: no offer */ }
}
function takeOffer() {
  try {
    const raw = sessionStorage.getItem(OFFER_KEY());
    sessionStorage.removeItem(OFFER_KEY());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * `preview(look)` puts the look on screen without keeping it and returns what
 * was there; `restore(was)` puts that back; `keep(look)` makes it the viewer's
 * own pick too, so the screen matches the deck after the write.
 */
export function createLookOffer({ root, base, toast, preview, restore, keep, debugLog = () => {} }) {
  let el = null, offer = null, was = null, busy = false;

  function show(o) {
    if (el || !o || (!o.theme && !o.font)) return;
    offer = o;
    was = preview(o);
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-look-offer';
    const what = o.phrase || [o.themeChanges && `theme ${o.theme}`, o.fontChanges && `font ${o.font}`].filter(Boolean).join(', ');
    el.innerHTML = '<div class="narr-card" role="dialog" aria-label="Apply the design system\'s look">'
      + `<div class="narr-head">apply ${escapeHtml(o.title || o.ref)}'s look?</div>`
      + `<div class="rec-line">${escapeHtml(what)} — the slide shows it now</div>`
      + '<div class="rec-hint">⏎ Apply · Esc Keep current</div></div>';
    closeOnBackdrop(el, decline);
    root.appendChild(el);
  }
  function shut() { el?.remove(); el = null; }
  function decline() {
    if (!el) return;
    restore(was);
    shut();
    toast(`kept the current look — Use design-system layout… offers ${offer.title || offer.ref}'s again`, 3600);
  }
  async function accept() {
    if (!el || busy) return;
    busy = true;
    try {
      const r = await fetch(`${base()}/edit/design-system/apply`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: offer.ref }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the edit server answered ${r.status}`);
      keep(j.look ?? offer);
      shut();
      toast(`${offer.title || offer.ref}'s look applied${j.look?.phrase ? ` — ${j.look.phrase}` : ''} · Z puts the old look back`, 4200);
      debugLog('design-system', `applied ${offer.ref}'s look`);
    } catch (e) {
      restore(was);
      shut();
      toast(`could not apply the look — ${e.message ?? e}`, 6000);
    } finally { busy = false; }
  }
  function keydown(e) {
    if (e.key === 'Enter') { accept(); return true; }
    if (e.key === 'Escape') { decline(); return true; }
    return true;
  }
  /** After a reload: the offer an add left behind, if any. */
  function resume() { const o = takeOffer(); if (o) show(o); }

  return { show, resume, keydown, close: decline, isOpen: () => !!el };
}

// ── Use design-system layout… ───────────────────────────────────────────────
// Put this slide into one of the deck's design-system layouts, move it to
// another, take it out, or insert a new slide in one (SPEC DESIGN_SYSTEMS).
// The layouts listed are the ones the PAGE carries (the meta block the server
// injected); the write goes to the edit server, which reads the layout from
// the package on disk, never from here — POST /edit/slide/system-layout, one
// undo entry, and a sentence saying what went where.


export function createSystemLayoutPicker({ root, base, toast, deck, lookHint = () => null, offerLook = () => {}, debugLog = () => {} }) {
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
      // a design system the deck uses, whose look was declined: one line to offer it again
      const hint = lookHint();
      if (hint) {
        rows.push({ look: hint });
        html += `<div class="narr-row dsl-row dsl-look" data-i="${rows.length - 1}"><span class="narr-row-label">✦ Not in ${escapeHtml(hint.title || hint.ref)}'s look — apply?`
          + ` <span class="narr-flavor">${escapeHtml([hint.themeChanges && `theme ${hint.theme}`, hint.fontChanges && `font ${hint.fontLabel ?? hint.font}`].filter(Boolean).join(' · '))}</span></span></div>`;
      }
      if (isSystemLayout(current)) {
        rows.push({ remove: true });
        html += `<div class="narr-row dsl-row" data-i="${rows.length - 1}"><span class="narr-row-label">↩ Take slide ${slide} out of ${escapeHtml(current)} <span class="narr-flavor">back to a plain slide</span></span></div>`;
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
      if (!r.ok || !j.ok) throw new Error(j.error ?? `the edit server answered ${r.status}`);
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
      if (row.look) { close(); return offerLook(row.look); }
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
    if (base() === null) { toast('design-system layouts are chosen in write mode — decklight <deck.html>', 3200); return; }
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
