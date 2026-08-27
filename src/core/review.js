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

import { selectInList } from './overlay.js';
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
  let armed = null;        // the comment id a second R would resolve
  let armedSubmit = false; // S pressed once — the next S pushes the review
  let armedTake = null;    // the branch a second T would take into the sidecar
  let armedAnchor = null;  // the comment id a second A would move to this slide
  let incomingNow = [];    // the waiting reviews as last rendered — T's targets
  let context = null;      // {id, data} — an orphan's "what it said", unfolded
  let probed = null;       // the review server's base, '' for same-origin, null for none
  let composeSlide = 1;    // the slide a new comment lands on — follows the deck
                           // while the box is empty, locks once you start typing
  let engaged = false;     // last surface the user touched: the panel, or the deck
  let onSlide = null;      // the slide-change subscription held while open
  let onResize = null;     // the viewport listener that re-sizes the gutter
  let onSurface = null;    // pointerdown/focusin router for `engaged`

  // Where the panel sits. A movable float (default) or docked to an edge so the
  // slide you are commenting on stays in view and navigable. Remembered per deck,
  // exactly like the clock and the character (hud.js / character.js).
  const dockKey = 'decklight-review-dock:' + location.pathname;
  const dock = { mode: 'float', x: null, y: null };
  try {
    const s = JSON.parse(localStorage.getItem(dockKey));
    if (s?.mode) { dock.mode = s.mode; dock.x = s.x ?? null; dock.y = s.y ?? null; }
  } catch { /* first run, or storage denied — the default float is fine */ }
  const persistDock = () => {
    try { localStorage.setItem(dockKey, JSON.stringify(dock)); } catch { /* ignore */ }
  };
  const DOCK_GLYPH = { float: '❏', left: '◧', right: '◨', bottom: '⬓' };

  // The gutter a docked panel reserves, in px — the same figure drives the
  // panel's own width/height (CSS var) and the stage's inset (root var), so the
  // slide reflows into exactly what is left. Viewport-relative, re-read on resize.
  const gutter = () => ({
    w: Math.min(360, Math.round(root.clientWidth * 0.32)),
    h: Math.min(320, Math.round(root.clientHeight * 0.40)),
  });

  /** Reserve the stage gutter for the current mode (or clear it for float). */
  function reserveGutter() {
    if (!el) return;
    el.dataset.dock = dock.mode;
    const g = gutter();
    root.style.setProperty('--dock-left', dock.mode === 'left' ? g.w + 'px' : '0px');
    root.style.setProperty('--dock-right', dock.mode === 'right' ? g.w + 'px' : '0px');
    root.style.setProperty('--dock-bottom', dock.mode === 'bottom' ? g.h + 'px' : '0px');
    el.style.setProperty('--dock-size',
      dock.mode === 'bottom' ? g.h + 'px' : g.w + 'px');
    instance._reflow?.();
    if (dock.mode === 'float') placeCard();
  }

  /** Float only: clamp the card to the viewport at its remembered position. */
  function placeCard() {
    const card = el?.querySelector('.narr-card');
    if (!card || dock.mode !== 'float') return;
    const w = card.offsetWidth || 460, h = card.offsetHeight || 400;
    let x = dock.x, y = dock.y;
    if (x == null || y == null) { x = root.clientWidth - w - 24; y = 24; }
    x = Math.max(8, Math.min(x, root.clientWidth - w - 8));
    y = Math.max(8, Math.min(y, root.clientHeight - h - 8));
    dock.x = x; dock.y = y;
    card.style.left = x + 'px';
    card.style.top = y + 'px';
  }

  /** Switch placement from a header button — persist, reflow, no full re-render. */
  function setDock(mode) {
    dock.mode = mode;
    persistDock();
    reserveGutter();
    el?.querySelectorAll('.rv-dock-btn').forEach(
      (b) => b.classList.toggle('rv-dock-on', b.dataset.mode === mode));
    const head = el?.querySelector('.narr-head');
    if (head) head.style.cursor = mode === 'float' ? 'move' : '';
  }

  /** Drag the float card by its header. Docked modes ignore it. */
  function startDrag(e, head) {
    if (dock.mode !== 'float' || e.button != null && e.button !== 0) return;
    if (e.target.closest('.rv-dock-ctl')) return;   // the buttons, not a drag
    const card = el.querySelector('.narr-card');
    if (!card) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const ox = parseFloat(card.style.left) || 0, oy = parseFloat(card.style.top) || 0;
    const move = (ev) => {
      const w = card.offsetWidth, h = card.offsetHeight;
      dock.x = Math.max(8, Math.min(ox + ev.clientX - sx, root.clientWidth - w - 8));
      dock.y = Math.max(8, Math.min(oy + ev.clientY - sy, root.clientHeight - h - 8));
      card.style.left = dock.x + 'px';
      card.style.top = dock.y + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      persistDock();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** The compose target's label — names the slide, and flags a locked target. */
  function composeLabel() {
    const slides = slidesNow();
    const t = slides[composeSlide - 1]?.title;
    const here = instance.state.slide;
    const base = `on slide ${composeSlide}${t ? ` · ${t}` : ''}`;
    return here === composeSlide ? base : `${base} · viewing ${here}`;
  }

  /** Slide changed under an open panel: follow it if the box is empty. */
  function updateComposeTarget() {
    if (!el) return;
    const input = el.querySelector('.rv-input');
    if (input && !input.value.trim()) composeSlide = instance.state.slide;
    const on = el.querySelector('.rv-on');
    if (on) on.textContent = composeLabel();
  }

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
      const state = { records: j.records ?? [], skipped: j.skipped ?? 0, can: base !== null ? 'comment' : 'resolve' };
      // The author also hears what reviews are WAITING on the remote — rows
      // the server reads on demand, behind this very keypress, and remembers
      // for a minute. A reviewer's overlay has no author server and skips it.
      if (state.can === 'resolve') {
        try {
          const ir = await fetch(`${authorBase() ?? ''}/edit/review/incoming`);
          const ij = await ir.json();
          if (ij?.ok) state.incoming = ij;
        } catch { /* the section simply is not there */ }
      }
      return state;
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

  /**
   * One comment as a row — the same anatomy for a local comment and an
   * incoming one, because they are the same thing at different distances.
   * Registers the row for arrow/⏎ selection and returns the node.
   */
  function commentRow(c, slides, { branch = null } = {}) {
    const anchor = resolveAnchor(c, slides);
    const row = el_('div', `rv-row${c.resolved ? ' rv-resolved' : ''}${branch ? ' rv-inc' : ''}`);
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
    // An orphan, unfolded: what the slide SAID when the comment was written.
    // The objection back under the prose it was about — most orphans dissolve
    // right here, into a resolve.
    if (context?.id === c.id) {
      const d = context.data;
      row.append(el_('div', 'rv-then', d.known
        ? `what it said — slide ${d.slide}${d.title ? ` · ${d.title}` : ''}${d.deck ? ` · @${d.deck}` : ''}:\n${d.text || '(nothing)'}`
        : `cannot show what it said — ${d.why}`));
    }
    if (armed === c.id) {
      row.append(el_('div', 'rv-arm', 'resolve this comment? ⏎ again to confirm · Esc to back out'));
    }
    if (armedAnchor === c.id) {
      row.append(el_('div', 'rv-arm',
        `move this comment to slide ${instance.state.slide} (the one on screen)? A again to confirm · Esc backs out`));
    }
    const entry = { id: c.id, slide: anchor.slide, node: row, resolved: !!c.resolved, branch };
    row.addEventListener('click', () => { select(rows.indexOf(entry)); jump(); });
    rows.push(entry);
    return row;
  }

  function render(state) {
    const card = el.querySelector('.narr-card');
    card.replaceChildren();
    const slides = slidesNow();
    const here = instance.state.slide;
    rows = [];
    incomingNow = (state.incoming?.state === 'ok' && state.incoming.reviews) || [];

    const head = el_('div', 'narr-head');
    head.append(el_('span', 'rv-heading', state.can === 'comment' ? 'review' : 'review comments'));
    const ctl = el_('div', 'rv-dock-ctl');
    for (const m of ['float', 'left', 'right', 'bottom']) {
      const b = el_('button', 'rv-dock-btn' + (dock.mode === m ? ' rv-dock-on' : ''), DOCK_GLYPH[m]);
      b.dataset.mode = m;
      b.title = m === 'float' ? 'float (movable)' : `dock ${m}`;
      b.setAttribute('aria-label', m === 'float' ? 'float' : `dock ${m}`);
      b.addEventListener('click', () => setDock(m));
      ctl.append(b);
    }
    const x = el_('button', 'rv-dock-btn rv-close', '×');
    x.title = 'close (M)';
    x.setAttribute('aria-label', 'close');
    x.addEventListener('click', close);
    ctl.append(x);
    head.append(ctl);
    head.style.cursor = dock.mode === 'float' ? 'move' : '';
    head.addEventListener('pointerdown', (e) => startDrag(e, head));
    card.append(head);

    // The composer, when there is somewhere to send it. On the slide you are
    // looking at, because that is the one you are talking about.
    if (state.can === 'comment') {
      composeSlide = here;
      const box = el_('div', 'rv-compose');
      box.append(el_('div', 'rv-on', composeLabel()));
      const input = el_('textarea', 'narr-input rv-input');
      input.placeholder = 'what you want the author to know…';
      input.rows = 3;
      const send = el_('div', 'narr-row narr-sel rv-send', 'Leave this comment');
      send.setAttribute('role', 'button');
      send.tabIndex = 0;
      // The target is read at SEND time, not render time: while you type it is
      // locked to composeSlide, and you may have walked the deck to other slides.
      const post = () => submit(input.value, composeSlide, slidesNow()[composeSlide - 1]);
      send.addEventListener('click', post);
      input.addEventListener('keydown', (e) => {
        // ⌘/⌃⏎ posts, which is what every composer in every tool does; a bare
        // ⏎ is a newline, because a comment is prose and often more than a line
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); }
        e.stopPropagation();   // the deck must not advance while somebody types
      });
      // Clearing the box hands the target back to whatever slide is on screen.
      input.addEventListener('input', () => { if (!input.value.trim()) updateComposeTarget(); });
      box.append(input, send);
      card.append(box);
      // Float pops up to be written in, so it takes focus; a docked panel sits
      // beside the deck for browsing, so it leaves the keyboard on the slides.
      if (dock.mode === 'float') setTimeout(() => input.focus(), 0);
    }

    // What reviewers have SENT that is not taken in yet — before the local
    // list, because it is the thing the author does not already know. Not a
    // count and a git command: the COMMENTS themselves, anchored against the
    // deck as it is now, walkable like any others. T takes a whole review
    // into the deck's own sidecar — a by-id merge, so twice changes nothing —
    // and nobody is asked to run git (the merge/PR path still works; it is
    // simply not the doorway any more).
    if (state.incoming) {
      const inc = state.incoming;
      if (inc.state === 'ok' && inc.reviews?.length) {
        const boxI = el_('div', 'rv-incoming');
        for (const v of inc.reviews) {
          const armedHere = armedTake === v.branch;
          boxI.append(el_('div', `rv-inc-row${armedHere ? ' rv-arm' : ''}`, armedHere
            ? `take ${v.who}’s review into the deck’s comments? T again to confirm · Esc backs out`
            : `↓ ${v.who} · ${v.comments} comment${v.comments === 1 ? '' : 's'} waiting · ${v.branch} — T takes it in`));
          for (const c of foldReview(v.records ?? [])) {
            // what is WAITING is what is still open in that review
            if (c.resolved) continue;
            boxI.append(commentRow(c, slides, { branch: v.branch }));
          }
        }
        card.append(boxI);
      } else if (inc.state && !['ok', 'none', 'no-repo', 'untracked', 'no-remote', 'suppressed'].includes(inc.state)) {
        // a FAILED check is said out loud — never rendered as "none waiting"
        card.append(el_('div', 'rv-inc-how', `incoming reviews: not checked — ${inc.state}`));
      }
    }

    const list = el_('div', 'rv-list');
    list.setAttribute('role', 'listbox');
    const comments = foldReview(state.records);
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
    for (const c of order) list.append(commentRow(c, slides));
    card.append(list);

    // The way out of the room. A review that stays on the reviewer's laptop is
    // a review that did not happen — so the door to sending it lives in the
    // same overlay the comments were written in.
    if (state.can === 'comment') {
      const row = el_('div', `rv-submit${armedSubmit ? ' rv-arm' : ''}`, armedSubmit
        ? 'push this review to the author? S again to confirm · Esc backs out'
        : 'S sends this review to the author (a review/… branch on the remote)');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.addEventListener('click', () => submitAll());
      card.append(row);
    }

    card.append(el_('div', 'rec-hint', state.can === 'resolve'
      ? (incomingNow.length
        ? '⏎ jumps (on a gone slide: shows what it said) · R resolves · A moves here · T takes a review in · Esc closes'
        : '⏎ jumps (on a gone slide: shows what it said) · R resolves · A moves here · Esc closes')
      : state.can === 'comment'
        ? '⏎ jumps to the slide · S submits the review · Esc closes'
        : '⏎ jumps to the slide · Esc closes'));
    select(Math.min(sel, Math.max(0, rows.length - 1)));
    // The card's height just changed; a floating one re-clamps into view.
    placeCard();
  }

  function select(i) {
    if (!rows.length) return;
    sel = selectInList(rows.map((r) => r.node), i, 'rv-sel');
  }
  function jump() {
    const r = rows[sel];
    if (!r) return;
    // An orphan has nowhere to jump TO — so ⏎ shows where it pointed: the
    // slide's content at the commit the comment was written against.
    if (!r.slide) { toggleContext(r); return; }
    instance.goto(r.slide, 0, { force: true });
    close();
  }

  /** Unfold (or fold) an orphan's "what it said", from the author server. */
  async function toggleContext(r) {
    if (context?.id === r.id) { context = null; render(await load()); return; }
    const base = authorBase();
    if (base == null) { toast('only the author server can look that far back'); return; }
    try {
      const res = await fetch(`${base}/edit/review/at?id=${encodeURIComponent(r.id)}`);
      const j = await res.json();
      if (!j?.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      context = { id: r.id, data: j };
    } catch (e) {
      context = { id: r.id, data: { known: false, why: String(e.message || e) } };
    }
    render(await load());
  }

  /**
   * A — move the selected comment to the slide ON SCREEN, armed then
   * confirmed. The reconciliation for a slide deleted or rewritten past what
   * fingerprint + title can find: an append-only `anchor` op, so the
   * reviewer's original line is never edited and a union merge stays safe.
   */
  async function anchorHere() {
    const r = rows[sel];
    if (!r || r.resolved) return;
    const base = authorBase();
    if (base == null) return;
    if (armedAnchor !== r.id) { armedAnchor = r.id; armed = null; render(await load()); return; }
    armedAnchor = null;
    // an incoming comment is taken in BY acting on it, same as resolve
    if (r.branch && !(await postTake(r.branch))) { render(await load()); return; }
    const here = instance.state.slide;
    const at = slidesNow()[here - 1];
    try {
      const res = await fetch(`${base}/edit/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'anchor', re: r.id, slide: here, title: at?.title, fp: at?.fp }),
      });
      if (!(await res.json())?.ok) throw new Error('refused');
      toast(`moved to slide ${here}`);
      context = null;
    } catch (e) { toast(`could not move that — ${String(e.message || e)}`); }
    render(await load());
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

  /** POST one review's intake; true on success. Toasts either way. */
  async function postTake(branch) {
    try {
      const r = await fetch(`${authorBase() ?? ''}/edit/review/take`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branch }),
      });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast(`took in ${j.added} record${j.added === 1 ? '' : 's'} — they are the deck's comments now`);
      debugLog('review', `took in ${branch} (+${j.added})`);
      return true;
    } catch (e) {
      toast(`could not take that review in — ${String(e.message || e)}`);
      return false;
    }
  }

  /**
   * T — take a waiting review into the deck's sidecar, armed then confirmed.
   *
   * The target is the review the SELECTED row belongs to; with nothing
   * incoming selected and exactly one review waiting, that one. Writing is
   * outward-visible (a commit), so it gets the same two-step everything else
   * that writes gets.
   */
  async function takeReview() {
    const branch = rows[sel]?.branch ?? (incomingNow.length === 1 ? incomingNow[0].branch : null);
    if (!branch) {
      if (incomingNow.length) toast('select a comment in the review you want to take in');
      return;
    }
    if (armedTake !== branch) { armedTake = branch; render(await load()); return; }
    armedTake = null;
    await postTake(branch);
    render(await load());
  }

  /** Resolve, armed then confirmed — the house rule for anything that writes. */
  async function resolve() {
    const r = rows[sel];
    if (!r || r.resolved) return;
    if (armed !== r.id) { armed = r.id; render(await load()); return; }
    armed = null;
    const base = authorBase();
    if (base == null) return;
    // An incoming comment is taken in BY acting on it: a resolve written
    // against a record that lives only on a remote branch would be an answer
    // to a question the local file never asked.
    if (r.branch && !(await postTake(r.branch))) { render(await load()); return; }
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

  /** Push the review — armed, then confirmed, then the SERVER does the git. */
  async function submitAll() {
    const base = await reviewBase();
    if (base === null) { toast('nothing here can submit — run: decklight review <deck>'); return; }
    if (!armedSubmit) { armedSubmit = true; render(await load()); return; }
    armedSubmit = false;
    try {
      const r = await fetch(`${base}/review/submit`, { method: 'POST' });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      toast(`review pushed → ${j.branch}`);
      debugLog('review', `submitted ${j.comments} comment(s) to ${j.branch}`);
    } catch (e) {
      // The server's refusal carries the way forward (no remote, nothing to
      // send) — the toast is where the reviewer is looking.
      toast(`could not submit — ${String(e.message || e)}`);
    }
    render(await load());
  }

  async function open() {
    if (el) return close();
    dismissOthers();
    armed = null;
    armedSubmit = false;
    armedTake = null;
    armedAnchor = null;
    context = null;
    sel = 0;
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-review';
    el.dataset.dock = dock.mode;
    el.innerHTML = '<div class="narr-card" role="dialog" aria-label="Review comments"></div>';
    root.appendChild(el);
    // Which surface the keyboard belongs to follows the last thing you touched:
    // a click (or focus) inside the panel makes its list keys live; one on the
    // deck hands the arrows back to the slides. Float opens focused, so start
    // engaged there; a docked panel opens with the deck still in charge.
    engaged = dock.mode === 'float';
    onSurface = (e2) => { engaged = !!el && el.contains(e2.target); };
    document.addEventListener('pointerdown', onSurface, true);
    document.addEventListener('focusin', onSurface, true);
    onSlide = () => updateComposeTarget();
    instance.on?.('slide', onSlide);
    onResize = () => reserveGutter();
    window.addEventListener('resize', onResize);
    reserveGutter();
    render({ records: [], skipped: 0, can: 'none' });
    await authorReady();
    if (el) render(await load());
  }
  function close() {
    el?.remove();
    el = null;
    armed = null;
    armedSubmit = false;
    armedTake = null;
    armedAnchor = null;
    context = null;
    engaged = false;
    // Hand the stage its full width back and refit the slide.
    root.style.removeProperty('--dock-left');
    root.style.removeProperty('--dock-right');
    root.style.removeProperty('--dock-bottom');
    instance._reflow?.();
    if (onSlide) instance.off?.('slide', onSlide), onSlide = null;
    if (onResize) window.removeEventListener('resize', onResize), onResize = null;
    if (onSurface) {
      document.removeEventListener('pointerdown', onSurface, true);
      document.removeEventListener('focusin', onSurface, true);
      onSurface = null;
    }
  }

  overlays.register({
    isOpen: () => !!el,
    close,
    // Modal only while you are working IN the panel — then it owns the keyboard
    // like any dialog. When your last touch was the deck it goes transparent, so
    // arrows walk the slides beside it (see the dispatch in engine.js).
    modal: () => engaged,
    keydown(e) {
      const typing = /^(input|textarea)$/i.test(e.target?.tagName ?? '');
      // Esc and M always answer; every other key is the panel's only while it is
      // the engaged surface — otherwise it falls through to the deck.
      if (e.key !== 'Escape' && !(e.key === 'm' || e.key === 'M') && !engaged) return false;
      if (e.key === 'Escape') {
        // Escape backs out of an arm before it closes the overlay — the same
        // two-step every other confirming surface here uses.
        if (armed || armedSubmit || armedTake || armedAnchor) {
          armed = null; armedSubmit = false; armedTake = null; armedAnchor = null;
          load().then((s) => el && render(s));
          return true;
        }
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
        case 's': case 'S': submitAll(); break;
        case 't': case 'T': takeReview(); break;
        case 'a': case 'A': anchorHere(); break;
        case 'm': case 'M': close(); break;
        default: return false;
      }
      return true;
    },
  });

  // `?review` — `decklight review` opened this deck, so the reason it did is
  // the first thing that should be on screen.
  if (params?.has?.('review')) setTimeout(() => { if (!overlays.active()) open(); }, 700);

  // `submit` opens the overlay with the send row already armed — the palette's
  // "Submit review…" is a statement of intent, so the only question left is
  // the confirmation.
  return {
    open,
    close,
    isOpen: () => !!el,
    submit: async () => { if (!el) await open(); armedSubmit = true; if (el) render(await load()); },
  };
}
