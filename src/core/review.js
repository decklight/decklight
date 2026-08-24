// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Review comments — SPEC REVIEW.
//
// A reviewer's remarks on a deck, anchored to slides, stored in
// `<deck>.review.jsonl` beside it (cli/review-store.mjs) and carried by git.
//
// This file is the browser half, and it is two things that do not know about
// each other: a pure anchor resolver (below, unit-tested with no DOM) and the
// overlay that shows what it resolved.
//
// NOT "annotations". That word is taken in this codebase, and taken by the
// deliberate opposite: ink (src/core/annotate.js) is cleared on every slide
// change and never persisted, because it belongs to the moment somebody is
// talking. A review comment belongs to a different actor at a different time —
// somebody reading the deck before the talk, writing to its author — so it
// persists, and the two must not be confused in the vocabulary either.

import { closeOnBackdrop, selectInList } from './overlay.js';
// The anchor lives in tools/ because the CLI needs it too and src/ is not in
// the published package. Re-exported here so a browser-side caller has one
// place to look, and inlined by esbuild like any other import.
export {
  fingerprint, resolveAnchor, VERDICT_NOTE, indexSlides, foldReview,
} from '../../tools/review-anchor.mjs';
import {
  resolveAnchor, VERDICT_NOTE, indexSlides, foldReview,
} from '../../tools/review-anchor.mjs';

// ── anchoring ─────────────────────────────────────────────────────────────
//
// A slide has NO stable identity. `locateSlide` (tools/deck-html.mjs) is
// `parts[2 * n]` over a string split on `<section`, and `data-slide-index` is
// written by the engine from array position at every load. So a comment stored
// as `{ slide: 12 }` re-attaches to whatever is twelfth after somebody inserts
// a slide at 3 — silently, and pointing at prose that never said the thing the
// comment is about.
//
// A comment therefore records three facts, and resolution walks them in
// descending order of confidence, REPORTING which one answered. That last part
// is the point: the same three-valued honesty the ingredients label uses, where
// "unchecked is its own answer and never a pass".

// ── the overlay (M) ───────────────────────────────────────────────────────
//
// ONE overlay, and what it can do depends on which server answered — because a
// reviewer wants to read what others said before adding to it, and an author
// wants to read the same list. Splitting them into two overlays would have made
// the common half twice.
//
//   a review server  → the composer is there: say something about this slide
//   an author server → rows can be resolved
//   neither          → the list still reads, and says where comments come from
//
// Rows are built as NODES, never innerHTML. A comment is somebody else's text
// arriving over git — the same reasoning the history overlay records for commit
// subjects, and here the text has travelled further.

export function createReview({
  root, params, overlays, instance, toast, debugLog, dismissOthers = () => {},
  sections = () => [], titleOf, bodyOf, authorBase = () => null, authorReady = () => Promise.resolve(),
}) {
  let el = null;
  let rows = [];
  let sel = 0;
  let armed = null;        // the comment id a second ⏎ would resolve
  let probed = null;       // the review server's base, '' for same-origin, null for none

  const slidesNow = () => indexSlides(sections(), { titleOf, bodyOf });

  /**
   * Is a review server answering? Asked once, lazily.
   *
   * Its own probe rather than editmode's: `?review` is answered by neither
   * /edit/ping nor /present/ping, and a deck that never reviews should not pay
   * a request for the possibility.
   */
  async function reviewBase() {
    if (probed !== null) return probed || (probed === '' ? '' : null);
    try {
      const r = await fetch('/review/ping');
      const j = r.ok ? await r.json() : null;
      probed = j?.ok && j.review ? '' : false;
    } catch { probed = false; }
    return probed === false ? null : probed;
  }

  async function load() {
    const base = await reviewBase();
    const from = base !== null ? `${base}/review/comments` : `${authorBase() ?? ''}/edit/review`;
    if (base === null && authorBase() == null) return { records: [], skipped: 0, can: 'none' };
    try {
      const r = await fetch(from);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || 'unreadable');
      return { records: j.records ?? [], skipped: j.skipped ?? 0, can: base !== null ? 'comment' : 'resolve' };
    } catch (e) {
      debugLog('review', `could not read comments: ${String(e.message || e)}`);
      return { records: [], skipped: 0, can: 'none', error: String(e.message || e) };
    }
  }

  const el_ = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // never innerHTML — see above
    return n;
  };
  const who = (r) => (r.by ? r.by.replace(/\s*<[^>]*>$/, '') : 'someone');

  function render(state) {
    const card = el.querySelector('.narr-card');
    card.replaceChildren();
    const slides = slidesNow();
    const here = instance.state.slide;

    card.append(el_('div', 'narr-head',
      state.can === 'comment' ? 'review · M closes' : 'review comments · M closes'));

    // The composer, when there is somewhere to send it. On the slide you are
    // looking at, because that is the one you are talking about.
    if (state.can === 'comment') {
      const box = el_('div', 'rv-compose');
      box.append(el_('div', 'rv-on', `on slide ${here}${slides[here - 1]?.title ? ` · ${slides[here - 1].title}` : ''}`));
      const input = el_('textarea', 'narr-input rv-input');
      input.placeholder = 'what you want the author to know…';
      input.rows = 3;
      const send = el_('div', 'narr-row narr-sel rv-send', 'Leave this comment');
      send.setAttribute('role', 'button');
      send.tabIndex = 0;
      const post = () => submit(input.value, here, slides[here - 1]);
      send.addEventListener('click', post);
      input.addEventListener('keydown', (e) => {
        // ⌘/⌃⏎ posts, which is what every composer in every tool does; a bare
        // ⏎ is a newline, because a comment is prose and often more than a line
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); }
        e.stopPropagation();   // the deck must not advance while somebody types
      });
      box.append(input, send);
      card.append(box);
      setTimeout(() => input.focus(), 0);
    }

    const list = el_('div', 'rv-list');
    list.setAttribute('role', 'listbox');
    const comments = foldReview(state.records);
    rows = [];
    if (state.error) {
      list.append(el_('div', 'rv-none', `could not read the comments — ${state.error}`));
    } else if (!comments.length) {
      list.append(el_('div', 'rv-none', state.can === 'none'
        ? 'no comments, and nothing here can take one — a reviewer leaves them with: decklight review <deck>'
        : 'no comments yet'));
    }
    if (state.skipped) {
      list.append(el_('div', 'rv-skipped', `${state.skipped} line(s) could not be read and were skipped`));
    }

    // open first, then resolved — the ones still asking something are the ones
    // somebody has to do something about
    const order = [...comments].sort((a, b) => Number(!!a.resolved) - Number(!!b.resolved));
    for (const c of order) {
      const anchor = resolveAnchor(c, slides);
      const row = el_('div', `rv-row${c.resolved ? ' rv-resolved' : ''}`);
      row.setAttribute('role', 'option');
      const head = el_('div', 'rv-head');
      head.append(el_('span', 'rv-slide', anchor.slide ? `slide ${anchor.slide}` : 'slide gone'));
      head.append(el_('span', 'rv-who', who(c)));
      // WHICH VERSION this was written against. The anchor answers whether the
      // SLIDE is still the slide; this answers which deck they were reading,
      // and neither implies the other — a slide can be untouched in a deck that
      // has moved a long way since somebody looked at it.
      if (c.deck) head.append(el_('span', 'rv-at', `@${c.deck}`));
      if (anchor.movedFrom) head.append(el_('span', 'rv-moved', `was ${anchor.movedFrom}`));
      if (c.resolved) head.append(el_('span', 'rv-tick', '✓'));
      row.append(head);
      row.append(el_('div', 'rv-body', c.body ?? ''));
      const note = VERDICT_NOTE[anchor.verdict];
      if (note) row.append(el_('div', 'rv-note', `⚠ ${note}`));
      for (const r of c.replies) {
        row.append(el_('div', 'rv-reply', `↳ ${who(r)}: ${r.body ?? ''}`));
      }
      if (armed === c.id) {
        row.append(el_('div', 'rv-arm', 'resolve this comment? ⏎ again to confirm · Esc to back out'));
      }
      row.addEventListener('click', () => { select(rows.indexOf(entry)); jump(); });
      const entry = { id: c.id, slide: anchor.slide, node: row, resolved: !!c.resolved };
      rows.push(entry);
      list.append(row);
    }
    card.append(list);
    card.append(el_('div', 'rec-hint', state.can === 'resolve'
      ? '⏎ jumps to the slide · R resolves · Esc closes'
      : '⏎ jumps to the slide · Esc closes'));
    select(Math.min(sel, Math.max(0, rows.length - 1)));
  }

  function select(i) {
    if (!rows.length) return;
    sel = selectInList(rows.map((r) => r.node), i, 'rv-sel');
  }
  function jump() {
    const r = rows[sel];
    if (!r?.slide) return;
    instance.goto(r.slide, 0, { force: true });
    close();
  }

  async function submit(text, slide, anchor) {
    const body = String(text ?? '').trim();
    if (!body) return;
    const base = await reviewBase();
    if (base === null) return;
    try {
      const r = await fetch(`${base}/review/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slide, title: anchor?.title, fp: anchor?.fp, body }),
      });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast(`comment left on slide ${slide}`);
      debugLog('review', `comment ${j.id} on slide ${slide}`);
      render(await load());
    } catch (e) {
      toast(`could not leave that comment — ${String(e.message || e)}`);
    }
  }

  /** Resolve, armed then confirmed — the house rule for anything that writes. */
  async function resolve() {
    const r = rows[sel];
    if (!r || r.resolved) return;
    if (armed !== r.id) { armed = r.id; render(await load()); return; }
    armed = null;
    const base = authorBase();
    if (base == null) return;
    try {
      const res = await fetch(`${base}/edit/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'resolve', re: r.id }),
      });
      if (!(await res.json())?.ok) throw new Error('refused');
      toast('resolved');
    } catch (e) { toast(`could not resolve that — ${String(e.message || e)}`); }
    render(await load());
  }

  async function open() {
    if (el) return close();
    dismissOthers();
    armed = null;
    sel = 0;
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-review';
    el.innerHTML = '<div class="narr-card" role="dialog" aria-label="Review comments"></div>';
    closeOnBackdrop(el, close);
    root.appendChild(el);
    render({ records: [], skipped: 0, can: 'none' });
    await authorReady();
    if (el) render(await load());
  }
  function close() {
    el?.remove();
    el = null;
    armed = null;
  }

  overlays.register({
    isOpen: () => !!el,
    close,
    keydown(e) {
      const typing = /^(input|textarea)$/i.test(e.target?.tagName ?? '');
      if (e.key === 'Escape') {
        // Escape backs out of an arm before it closes the overlay — the same
        // two-step every other confirming surface here uses.
        if (armed) { armed = null; load().then((s) => el && render(s)); return true; }
        close();
        return true;
      }
      if (typing) return false;
      switch (e.key) {
        case 'ArrowDown': select(sel + 1); break;
        case 'ArrowUp': select(sel - 1); break;
        // Armed on the row you are on, ⏎ CONFIRMS — the promise the arm text
        // makes, and the same key restore's two-step confirms with. Anywhere
        // else it jumps, which is what the hint says it does.
        case 'Enter': (armed && rows[sel]?.id === armed) ? resolve() : jump(); break;
        case 'r': case 'R': resolve(); break;
        case 'm': case 'M': close(); break;
        default: return false;
      }
      return true;
    },
  });

  // `?review` — `decklight review` opened this deck, so the reason it did is
  // the first thing that should be on screen.
  if (params?.has?.('review')) setTimeout(() => { if (!overlays.active()) open(); }, 700);

  return { open, close, isOpen: () => !!el };
}
