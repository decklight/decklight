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
 *
 * Both views are half a panel. The other half is the slide under the cursor,
 * RENDERED, in the picker's own anatomy (`.tp-panel`: a list, a preview, a
 * caption) — the same one the theme picker, the slide finder and the history
 * pane use. A template is a deck somebody designed, and its titles are the
 * least of what you are choosing between; a list of them asks you to pick a
 * slide by name and find out what it looks like afterwards, which is the shape
 * of mistake this panel exists to prevent everywhere else.
 */

import { closeOnBackdrop, selectInList, typeaheadKeydown } from './overlay.js';

/**
 * How long the cursor rests on a row before its preview is fetched.
 *
 * Held down, ↓ walks a list faster than a deck can boot in an iframe, and every
 * row on the way is a document load nobody asked to see. The theme picker
 * debounces its preview for the same reason.
 */
const PREVIEW_SETTLE_MS = 120;

export function createTemplates({ root, overlays, editmode, deck, toast, dismissOthers }) {
  const base = () => editmode().base();
  const available = () => editmode().available() === true;

  let el = null;
  let view = 'list';          // 'list' | 'slides'
  let sel = 0;
  let filter = '';
  let listing = null;         // { installed, offered, stale } | { error } | null while loading
  let opened = null;          // { name, slides } | { name, error } | { name, loading }
  let busy = false;

  // ----- the preview pane ----------------------------------------------------
  // One iframe, reloaded when the DOCUMENT changes and postMessaged when only
  // the slide does — `finderPreviewSwap`'s mechanism exactly, because the
  // finder has the same two cases (a slide of this deck, or another file).
  let frameReady = false;
  let framePending = null;
  let previewTimer = 0;
  // name → { slides } | { error }. Filled by whichever of the two asks first:
  // browsing the list previews a template, which needs its slide list, so by
  // the time ⏎ opens it the slides view usually has nothing left to wait for.
  const slideCache = new Map();

  const isOpen = () => !!el;

  function close() {
    clearTimeout(previewTimer);
    el?.remove();
    el = null;
    view = 'list';
    sel = 0;
    filter = '';
    frameReady = false;
    framePending = null;
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
      // The picker's anatomy with the narration card's ROWS: a template row has
      // a tick column and warning tags, which `.narr-row` already draws and
      // nothing in `.tp-row` does.
      el.className = 'decklight-narr decklight-theme-picker decklight-tmpl';
      el.innerHTML =
        '<div class="tp-panel">'
        + '<div class="tp-side">'
        + '<div class="tp-filter"></div>'
        + '<div class="tp-list" role="listbox" aria-label="Deck templates"></div>'
        + '<div class="tmpl-foot"></div></div>'
        + '<div class="tp-preview"><iframe title="Template preview" hidden></iframe>'
        + '<div class="tp-caption"></div></div>'
        + '</div>';
      root.appendChild(el);
      closeOnBackdrop(el, close);
    }
    const at = deck().state.slide;
    el.querySelector('.tp-filter').textContent = view === 'slides'
      ? `${opened.name} — one slide, two things you can do with it`
      : filter ? `filter: ${filter}` : 'insert from a template — type to filter · ⏎ opens';

    const listEl = el.querySelector('.tp-list');
    listEl.textContent = '';
    const foot = el.querySelector('.tmpl-foot');
    foot.textContent = '';

    const say = (text) => {
      const row = document.createElement('div');
      row.className = 'narr-row narr-blocked';
      row.textContent = text;
      listEl.append(row);
    };

    if (listing?.error || opened?.error) {
      say(listing?.error ?? opened?.error);
      syncPreview();
      return;
    }
    if (!listing && view === 'list') {
      say('reading what is installed…');
      syncPreview();
      return;
    }
    if (opened?.loading && view === 'slides') {
      say(`reading ${opened.name}…`);
      syncPreview();
      return;
    }

    const list = rows();
    if (!list.length) {
      say(view === 'slides'
        ? 'this template has no slides'
        : 'no deck template installed, and no registered marketplace offers one'
          + ' — decklight marketplace add <owner/repo>');
    }

    sel = Math.max(0, Math.min(sel, list.length - 1));
    list.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'narr-row' + (i === sel ? ' narr-sel' : '');
      const label = document.createElement('span');
      label.className = 'narr-row-label';

      if (r.kind === 'slide') {
        const { slide } = r;
        label.textContent = `${slide.n}  ${slide.title}`;
        row.append(label);
        if (slide.hidden) row.append(tag('⊘ hidden'));
        // What it points at that this deck does not have. Said HERE, before the
        // slide is taken — the importer's rule, one step earlier.
        if (slide.needs.length) row.append(tag(`⚠ needs ${slide.needs.join(', ')}`));
        // The template's rules for this slide come with it, except the names
        // this deck already means something else by — those stay yours.
        if (slide.clashes?.length) row.append(tag(`⚠ ${slide.clashes.join(', ')} is this deck's`));
      } else if (r.kind === 'installed') {
        label.textContent = r.name;
        row.append(label);
        const known = slideCache.get(r.name)?.slides?.length;
        if (known) row.append(tag(`${known} slides`));
      } else {
        label.textContent = r.entry.qualified;
        row.append(label);
        row.append(tag('install'));
        if (r.entry.description) row.append(tag(r.entry.description));
      }
      row.addEventListener('click', () => { sel = i; commit(); });
      row.addEventListener('mouseenter', () => { if (sel !== i) { sel = i; render(); } });
      listEl.append(row);
    });

    if (view === 'slides' && list.length) {
      // A legend, one key per line, rather than a run of keys separated by
      // dots: this view's whole content is now two verbs, and the run-on
      // wrapped mid-phrase in a 330px rail — "esc goes / back".
      //
      // Both verbs name the slide they act ON, because neither acts on the
      // highlighted row alone: one lands a slide next to yours, the other
      // changes yours. A key whose target is offscreen has to say what it is.
      for (const [key, what] of [
        ['i', `insert it after slide ${at}`],
        ['l', `give slide ${at} its look`],
        ['esc', 'back to the templates'],
      ]) {
        const line = document.createElement('div');
        line.className = 'tmpl-key';
        line.append(Object.assign(document.createElement('kbd'), { textContent: key }));
        line.append(document.createTextNode(what));
        foot.append(line);
      }
    }
    selectInList([...listEl.querySelectorAll('.narr-row')], sel, 'narr-sel');
    syncPreview();
  }

  const tag = (text) => Object.assign(document.createElement('span'), { className: 'narr-tag', textContent: text });

  // ----- preview -------------------------------------------------------------

  /**
   * What the row under the cursor should show, and what to say under it.
   *
   * An OFFERED row has no `name`: the template is not on this machine, and
   * previewing it would mean fetching it. Registering a marketplace is not
   * fetching from one (`UNITS`), and the theme picker draws exactly this line
   * for exactly this reason — a marketplace row keeps whatever the pane was
   * showing rather than reaching out to fill it.
   */
  function previewTarget() {
    const row = rows()[sel];
    if (!row) return null;
    if (row.kind === 'slide') {
      const { slide } = row;
      return {
        name: opened.name,
        slide: slide.n,
        // The row carries `⚠ needs` as a mark you can scan a list for; it is
        // the caption that has the room to say WHICH files, and the row under
        // the cursor is the only one anybody needs that from.
        caption: `slide ${slide.n} — ${slide.title}`
          + (slide.hidden ? ' · hidden in its own deck' : '')
          + (slide.needs.length ? ` · ⚠ needs ${slide.needs.join(', ')}, which this deck does not have` : '')
          + (slide.clashes?.length
            ? ` · ⚠ ${slide.clashes.join(', ')} already means something else here, so it keeps this deck's rules`
            : ''),
      };
    }
    if (row.kind === 'installed') {
      const n = slideCache.get(row.name)?.slides?.length;
      return { name: row.name, slide: 1, caption: n ? `${row.name} · ${n} slides` : row.name };
    }
    return {
      caption: `${row.entry.qualified} — not installed here yet · ⏎ installs it, then you can look inside`,
    };
  }

  function syncPreview() {
    if (!el) return;
    const target = previewTarget();
    const frame = el.querySelector('iframe');
    el.querySelector('.tp-caption').textContent = target?.caption ?? '';
    clearTimeout(previewTimer);
    if (!target?.name) { frame.hidden = true; return; }
    const { name, slide } = target;
    previewTimer = setTimeout(() => {
      previewSwap(name, slide);
      // the count that finishes the caption comes from the read the slides view
      // needs anyway, so browsing the list is what warms it
      if (!slideCache.has(name)) slidesOf(name).then(() => { if (el) render(); });
    }, PREVIEW_SETTLE_MS);
  }

  function previewSwap(name, slide) {
    const frame = el?.querySelector('iframe');
    if (!frame) return;
    frame.hidden = false;
    // `embedded`: the previewed template is a whole deck, and without it the
    // preview would draw its own progress bar, its own toasts and its own
    // onboarding over the top of somebody else's slide.
    const doc = `${base()}/edit/template/at?name=${encodeURIComponent(name)}&embedded`;
    if (frame.dataset.doc !== doc) {
      frame.dataset.doc = doc;
      frameReady = false;
      framePending = null;
      frame.addEventListener('load', () => {
        frameReady = true;
        if (framePending && el) {
          const p = framePending;
          framePending = null;
          previewSwap(p.name, p.slide);
        }
      }, { once: true });
      frame.src = `${doc}#/${slide}/0`;
      return;
    }
    if (!frameReady) { framePending = { name, slide }; return; }
    frame.contentWindow?.postMessage({ __decklightPreview: { goto: [slide, 0] } }, '*');
  }

  // ----- reading -------------------------------------------------------------

  /** A template's slides, read once and remembered for as long as the panel is open. */
  async function slidesOf(name) {
    if (slideCache.has(name)) return slideCache.get(name);
    let got;
    try {
      const r = await fetch(`${base()}/edit/template/slides?name=${encodeURIComponent(name)}`);
      const j = await r.json().catch(() => ({}));
      got = r.ok && j.ok ? { slides: j.slides ?? [] } : { error: j.error || `the author server said ${r.status}` };
    } catch {
      got = { error: 'the author server did not answer' };
    }
    slideCache.set(name, got);
    return got;
  }

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
    if (!slideCache.has(name) && el) {
      opened = { name, loading: true };
      view = 'slides';
      sel = 0;
      render();
    }
    const got = await slidesOf(name);
    opened = got.error ? { name, error: got.error } : { name, slides: got.slides };
    if (!el) return;
    view = 'slides';
    sel = 0;
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
      slideCache.delete(j.name);
      await open();
      await openTemplate(j.name);
    } catch (e) {
      toast(`could not install ${qualified} — ${e.message}`);
    } finally {
      busy = false;
    }
  }

  async function insert(slide) {
    const slides = [slide.n];
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
      const st = j.styles ?? {};
      toast(`${j.inserted} slide${j.inserted === 1 ? '' : 's'} from ${j.name} after slide ${after} — Z takes it back`
        + (st.carried?.length ? `, with ${st.carried.join(', ')}` : '')
        + (j.needs?.length ? `. They point at ${j.needs.join(', ')}, which this deck does not have` : '')
        + (st.clashed?.length ? `. ${st.clashed.join(', ')} already means something else here, so it kept this deck's rules` : '')
        + (st.dangling?.length ? `. ${st.dangling.join(', ')} was defined outside the slide and did not travel` : ''), 6000);
    } catch (e) {
      toast(`could not insert — ${e.message}`);
    } finally {
      busy = false;
    }
  }

  /**
   * Give the slide you are ON the look of the slide you are LOOKING AT — its
   * layout, its backdrop, its classes — and keep every word of your own.
   *
   * The other verb in this view. `⏎` takes somebody's slide; this takes only
   * the shape of it, which is the more common thing to want from a template
   * once a deck already has its content.
   */
  async function applyLook(slide) {
    if (busy) return;
    busy = true;
    const to = deck().state.slide;
    try {
      const r = await fetch(base() + '/edit/template/apply', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: opened.name, slide: slide.n, to }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the author server said ${r.status}`);
      close();
      const named = Object.keys(j.applied ?? {});
      const st = j.styles ?? {};
      toast(`slide ${j.to} now looks like ${j.name} slide ${j.from} — Z takes it back`
        + (named.length ? `. It took ${named.join(', ')}` : '. That slide has no look of its own, so yours was cleared')
        + (st.carried?.length ? `, with ${st.carried.join(', ')}` : '')
        + (st.clashed?.length ? `. ${st.clashed.join(', ')} already means something else here, so it kept this deck's rules` : ''), 6000);
    } catch (e) {
      toast(`could not apply — ${e.message}`);
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
    insert(row.slide);   // ⏎ is `i`: the obvious thing to do with a slide
  }

  function keydown(e) {
    const list = rows();
    const move = (d) => { sel = (sel + d + list.length) % Math.max(1, list.length); render(); };

    if (view === 'slides') {
      // Not a typeahead: the letters here are verbs, and a filter would take
      // them. Two of them, on the row under the cursor — `i` brings the slide
      // in beside yours, `l` leaves your slide where it is and changes how it
      // looks. Nothing is ticked first, so what a key acts on is always the
      // one row that is highlighted.
      if (e.key === 'ArrowDown') { move(1); return true; }
      if (e.key === 'ArrowUp') { move(-1); return true; }
      if (e.key === 'i' || e.key === 'I' || e.key === 'Enter') {
        const row = list[sel];
        if (row) insert(row.slide);
        return true;
      }
      if (e.key === 'l' || e.key === 'L') {
        const row = list[sel];
        if (row) applyLook(row.slide);
        return true;
      }
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
