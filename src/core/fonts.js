// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Fonts (SPEC FONTS, PRESENTING): the `[` / `]` cycle and the Font… picker.
 *
 * What can be picked, in order:
 *   - the nine STACKS — families every machine already has, by kind
 *     (system sans, humanist, slab serif…); "theme default" is the theme's own;
 *   - the deck's FONT PACKAGES — the fonts it references from a marketplace,
 *     whose faces the server linked into the page (`data-font-meta`), or a
 *     bundle carries;
 *   - while AUTHORING, every font the registered marketplaces offer: its faces
 *     are linked into this page on demand so it can be previewed, and Space
 *     references it from the deck (one config entry, one undo).
 *
 * The picker PREVIEWS on the slide: moving the selection sets the font, Enter
 * keeps it, Escape (or a click outside) puts back the one you came with. A
 * design system's `recommendedFonts` are listed first, starred.
 *
 * A pick is a VIEWER preference, as it always was — stored per deck in this
 * browser, by name. The deck's own default is its config's `font` (a font
 * package's name, or a stack's label), applied when the viewer has not chosen.
 */

import { closeOnBackdrop, selectInList } from './overlay.js';
import { readPref, writePref } from './prefs.js';
import { pageDesignSystems } from './design-system.js';
import { STACKS } from '../../tools/font-stacks.mjs';

export { STACKS };

const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const STACK_RE = /^[A-Za-z0-9 ,'"_-]{1,260}$/;
const FACE_URL_RE = /^decklight-font\/[\w.-]+\/[\w.-]+\/[\w./-]+\.(woff2|woff)$/;

/** The deck's font packages, from the meta blocks the server (or a bundle) put in the page. */
export function pageFonts(doc = document) {
  const out = [];
  for (const el of doc.querySelectorAll('script[type="application/json"][data-font-meta]')) {
    let m;
    try { m = JSON.parse(el.textContent); } catch { continue; }
    if (!m || !FAMILY_RE.test(m.family ?? '') || !STACK_RE.test(m.stack ?? '')) continue;
    out.push({ id: el.getAttribute('data-font-meta'), label: m.title || m.family, stack: m.stack, family: m.family, kind: 'deck' });
  }
  return out;
}

/** What the design systems on this page recommend — names, labels or `name@marketplace` — and who said so. */
export function recommendedFonts(systems = pageDesignSystems()) {
  const ids = [];
  const by = [];
  for (const sys of systems.values()) {
    const mine = (sys.recommendedFonts ?? []).map((t) => String(t).split('@')[0]);
    if (mine.length) by.push(sys.title || sys.name);
    for (const n of mine) if (!ids.includes(n)) ids.push(n);
  }
  return { ids, by };
}

export function createFonts({
  root, config, params, toast, debugLog, overlays, editmode, remeasure,
}) {
  const key = 'decklight-font:' + location.pathname;
  const authoring = () => editmode?.()?.available() === true;
  const authorBase = () => editmode?.()?.base() ?? '';
  let offered = [];        // authoring: { id, label, stack, family, faces, qualified, used, kind: 'offered' }
  let offeredState = null; // null · { loading } · { error } · { done }
  const stacks = STACKS.map(([label, stack]) => ({ id: label, label, stack, kind: 'stack' }));

  /** Everything that can be applied right now, in cycle order. */
  function list() {
    const deck = pageFonts();
    const extra = offered.filter((o) => !deck.some((d) => d.id === o.id));
    return [...stacks, ...deck, ...extra];
  }
  let currentId = 'theme default';
  const find = (id) => list().find((f) => f.id === id);

  /** An offered font's faces, linked into THIS page so it can be previewed (the edit server answers them). */
  function ensureFaces(f) {
    if (f.kind !== 'offered' || document.querySelector(`style[data-font-preview="${CSS.escape(f.id)}"]`)) return;
    const rules = (f.faces ?? []).filter((x) => FACE_URL_RE.test(x.url)).map((x) =>
      `@font-face { font-family: '${f.family}'; src: url("${authorBase()}/${x.url}") format("${x.format === 'woff' ? 'woff' : 'woff2'}"); `
      + `font-weight: ${/^\d{1,4}( \d{1,4})?$/.test(String(x.weight)) ? x.weight : 400}; font-style: ${x.style === 'italic' ? 'italic' : 'normal'}; font-display: swap; }`);
    const st = document.createElement('style');
    st.dataset.fontPreview = f.id;
    st.textContent = rules.join('\n');
    document.head.appendChild(st);
  }

  /** Set the font. `persist` stores it as this viewer's pick; a preview does not. */
  function apply(id, { silent = false, persist = true, measure = true } = {}) {
    const f = find(id) ?? stacks[0];
    ensureFaces(f);
    currentId = f.id;
    if (f.stack) {
      root.style.setProperty('--font-body', f.stack);
      root.style.setProperty('--font-heading', f.stack);
    } else {
      root.style.removeProperty('--font-body');
      root.style.removeProperty('--font-heading');
    }
    if (persist && !params.has('embedded')) {
      try { writePref(key, f.kind === 'stack' && !f.stack ? null : f.id); } catch { /* private mode */ }
    }
    if (measure) remeasure();
    if (!silent) toast(`font: ${f.label}`);
    debugLog('font', f.label);
  }
  function cycle(dir) {
    const all = list().filter((f) => f.kind !== 'offered');
    const i = Math.max(0, all.findIndex((f) => f.id === currentId));
    apply(all[(i + dir + all.length) % all.length].id);
  }

  /**
   * Boot: the viewer's pick (a name — or an index, which is how 0.9.0 and
   * earlier stored a stack), else the deck's default, else the theme's own.
   * Before the first sync, so pinned titles measure the real font.
   */
  function restore() {
    let saved = null;
    try { saved = readPref(key); } catch { /* ignore */ }
    const legacy = /^\d+$/.test(String(saved ?? '')) ? STACKS[Number(saved)]?.[0] : null;
    const want = legacy ?? saved ?? (typeof config.font === 'string' ? config.font : null);
    if (want && find(want)) apply(want, { silent: true, persist: false, measure: false });
  }

  // ── the picker ──────────────────────────────────────────────────────────
  let el = null, sel = 0, rows = [], before = null;

  async function loadOffered() {
    if (!authoring() || offeredState) return;
    offeredState = { loading: true };
    try {
      const r = await fetch(authorBase() + '/edit/font/browse');
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the edit server said ${r.status}`);
      offered = (j.fonts ?? []).filter((f) => !f.missing && FAMILY_RE.test(f.family ?? '') && STACK_RE.test(f.stack ?? ''))
        .map((f) => ({ id: f.name, label: f.title || f.family, stack: f.stack, family: f.family, faces: f.faces ?? [], qualified: f.qualified, used: !!f.used, group: f.group, kind: 'offered' }));
      offeredState = { done: true, unfetched: j.unfetched ?? [], stale: j.stale ?? [] };
    } catch (e) {
      offeredState = { error: String(e.message ?? e) };
    }
    if (el) render();
  }

  function render() {
    const card = el.querySelector('.narr-card');
    const all = list();
    const rec = recommendedFonts();
    // in the order the design system gave them — its first choice first
    const rank = (f) => Math.min(...[rec.ids.indexOf(f.id), rec.ids.indexOf(f.label)].filter((i) => i >= 0));
    const starred = all.filter((f) => rec.ids.includes(f.id) || rec.ids.includes(f.label)).sort((a, b) => rank(a) - rank(b));
    rows = [...starred, ...all.filter((f) => !starred.includes(f))];
    card.textContent = '';
    if (starred.length) {
      const h = document.createElement('div');
      h.className = 'narr-group fp-rec';
      h.textContent = `★ recommended by ${rec.by.join(', ')}`;
      card.appendChild(h);
    }
    rows.forEach((f, i) => {
      if (i === starred.length && starred.length) {
        const sep = document.createElement('div');
        sep.className = 'narr-group';
        sep.textContent = 'all fonts';
        card.appendChild(sep);
      }
      const row = document.createElement('div');
      row.className = 'narr-row fp-row' + (f.id === (before ?? currentId) ? ' narr-cur' : '');
      row.dataset.font = f.id;
      const name = document.createElement('span');
      name.className = 'narr-row-label';
      name.textContent = f.label;
      if (f.stack) { ensureFaces(f); name.style.fontFamily = f.stack; }
      row.appendChild(name);
      const tags = [
        starred.includes(f) ? '★' : '',
        f.kind === 'deck' ? (authoring() ? '● in the deck' : 'in the deck') : '',
        f.kind === 'offered' ? `${f.used ? '●' : '○'} ${f.group ?? ''}`.trim() : '',
      ].filter(Boolean).join(' · ');
      if (tags) {
        const t = document.createElement('span');
        t.className = 'fp-tag';
        t.textContent = tags;
        row.appendChild(t);
      }
      row.addEventListener('mouseenter', () => select(i));
      row.addEventListener('click', () => { select(i); commit(); });
      card.appendChild(row);
    });
    const note = !authoring() ? null
      : offeredState?.loading ? 'reading the marketplaces…'
        : offeredState?.error ? `marketplace fonts: ${offeredState.error}`
          : offeredState?.unfetched?.length ? `not listed: ${offeredState.unfetched.join(', ')} — not fetched yet (decklight marketplace update)`
            : null;
    const foot = document.createElement('div');
    foot.className = 'rec-line fp-foot';
    foot.textContent = [note, authoring() ? '↑/↓ previews · ⏎ keeps · Space adds a marketplace font to the deck · Esc puts it back'
      : '↑/↓ previews · ⏎ keeps · Esc puts it back'].filter(Boolean).join(' — ');
    card.appendChild(foot);
    select(Math.max(0, Math.min(sel, rows.length - 1)), { preview: false });
  }

  /** Move the selection — and PREVIEW: the slide shows the font under the cursor. */
  function select(i, { preview = true } = {}) {
    if (!rows.length) return;
    sel = (i + rows.length) % rows.length;
    selectInList([...el.querySelectorAll('.fp-row')], sel, 'narr-sel');
    if (preview) apply(rows[sel].id, { silent: true, persist: false, measure: false });
  }
  function commit() {
    const f = rows[sel];
    if (!f) return;
    before = null;
    apply(f.id);   // persisted, re-measured, said
    shut();
  }
  function shut() {
    el?.remove();
    el = null;
  }
  /** Close WITHOUT keeping: the font you came with, back. */
  function close() {
    if (!el) return;
    if (before !== null && before !== currentId) apply(before, { silent: true, persist: false, measure: false });
    before = null;
    shut();
  }
  function open() {
    if (el) return close();
    overlays.opening();
    before = currentId;
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-font-picker';
    el.innerHTML = '<div class="narr-card" role="listbox" aria-label="Fonts"></div>';
    closeOnBackdrop(el, close);
    root.appendChild(el);
    sel = 0;
    render();
    const at = rows.findIndex((f) => f.id === before);
    select(at < 0 ? 0 : at, { preview: false });
    loadOffered();
  }

  /** Space on a marketplace font: reference it from the deck, or drop it (authoring only). */
  async function toggleRef() {
    const f = rows[sel];
    if (!authoring() || !f || f.kind !== 'offered') return false;
    try {
      const r = await fetch(authorBase() + '/edit/font/mark', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: f.qualified, used: !f.used, quiet: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error([j.error, ...(j.problems ?? []).slice(0, 1)].filter(Boolean).join(' · ') || `the edit server said ${r.status}`);
      f.used = j.used;
      toast(j.used ? `● the deck now uses ${j.ref} — its faces travel with it (bundle carries them) · Z takes it back`
        : `○ dropped ${j.ref}`, 3600);
      if (el) render();
    } catch (e) {
      toast(`${f.qualified} — ${e.message ?? e}`, 6000);
    }
    return true;
  }

  function keydown(e) {
    switch (e.key) {
      case 'ArrowDown': select(sel + 1); return true;
      case 'ArrowUp': select(sel - 1); return true;
      case 'Enter': commit(); return true;
      case 'Escape': close(); return true;
      case ' ': toggleRef(); return true;
      default: return true;   // the list holds the keyboard while it is open
    }
  }

  return { apply, cycle, restore, open, close, isOpen: () => !!el, keydown, list, current: () => currentId };
}
