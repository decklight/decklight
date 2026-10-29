// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A change proposed by an agent, reviewed before it lands (SPEC
 * PRESENTING_EDITING, #907).
 *
 * Check deck…'s quick fixes, the script rewrites (PRESENTING_VOICE) and an A
 * ask are held by the edit server as a CANDIDATE (cli/fix-review.mjs): the
 * deck on disk is untouched, nothing is committed, no page reloads. This view
 * shows the deck as it is on the left and as the change would make it on the
 * right, both at the same slide and build step, and walks only the places
 * they differ: every build step of a changed slide whose render differs, an
 * added or a removed slide, and the deck's head (styles, the config) when the
 * change touched it.
 *
 * A SLIDE IS DECIDED, A STEP IS SHOWN. Approve (A) or reject (X, with an
 * optional comment) covers every changed step of that slide, because a slide
 * is what can be taken from the candidate on its own; the head is its own
 * decision. Adjust (E) sends the comment and that slide to the agent, which
 * works on the candidate; the right pane comes back with the new version, the
 * other slides' decisions stay, and the adjusted one is undecided again.
 *
 * THE SLIDE LIST down the left side is every slide the candidate changes,
 * with its state (undecided, approved, rejected, adjusting), and after them
 * the slides the job looked at and LEFT AS THEY WERE (an answer that failed
 * its check, a slide edited while the agent thought), with why: ↑/↓ or a
 * click jumps to a slide, ←/→ still walk the changes in order.
 *
 * TWO MODES, ONE PANEL. A change the slides can show (a layout fix, an ask)
 * opens on the two live renders; a change that is ONLY the notes (a script
 * rewrite: the server marks the unit `notesOnly`) opens in TEXT mode, the
 * slide's whole script with the words that changed marked, the proposed
 * render kept small for context, and P plays the proposed script in the
 * deck's live voice, the one check two identical renders cannot give. D
 * cycles the view — the inline diff, the two scripts side by side, the two
 * slides — in either mode; the text-mode choice is remembered.
 *
 * **Apply validated only** writes the approved slides; **Apply all** writes
 * every change but the rejected ones. Either is one write and one undo entry,
 * and the commit window opens on the page that reloads, its message drafted
 * (`fix: <rule> on slides 24 and 25`, the rejections in the body). Esc
 * discards the candidate, and says the deck was not touched.
 *
 * WHICH STEPS DIFFER is read from the two decks themselves: both panes are
 * this origin's pages, so each slide's build record is right there. A step's
 * render is the slide with the builds not yet revealed taken out, plus that
 * step's caption; two versions differ at a step when those differ.
 */

import { wordDiff, diffCounts } from './worddiff.js';
import { notesSegments } from './speaker.js';
import { readPref, writePref } from './prefs.js';

/** The element's place under `root`, as child indexes. */
const pathOf = (root, el) => {
  const path = [];
  for (let n = el; n && n !== root; n = n.parentElement) {
    if (!n.parentElement) return null;
    path.unshift([...n.parentElement.children].indexOf(n));
  }
  return path;
};
const atPath = (root, path) => path.reduce((n, i) => n?.children[i] ?? null, root);

/** What a slide's section says about itself, the attributes an author writes. */
const AUTHORED = ['data-layout', 'data-template', 'data-hidden', 'data-auto-animate', 'data-bleed'];

/**
 * Slide `n`'s render at each build step, `[step0, step1, …]`, as text two
 * versions can be compared by: the section without the builds not yet shown
 * (nor the engine's own marks), and that step's caption. Null when the deck
 * has no such slide. Pure over the instance it is handed.
 */
export function stepRenders(inst, n) {
  const sec = inst?._sections?.[n - 1];
  if (!sec) return null;
  const rec = inst._records?.[n - 1] ?? { groups: [], steps: [] };
  const groups = rec.groups ?? [];
  const paths = (rec.steps ?? []).map((s) => (s.kind === 'dom' && s.el && sec.contains(s.el) ? pathOf(sec, s.el) : null));
  const aside = sec.querySelector(':scope > aside.notes');
  const segs = aside ? notesSegments(aside.innerHTML) : [];
  const attrs = AUTHORED.map((a) => `${a}=${sec.getAttribute(a) ?? ''}`).join(' ');
  const out = [];
  for (let k = 0; k <= groups.length; k++) {
    const shown = new Set();
    groups.forEach((g, gi) => { if (gi < k) for (const i of g) shown.add(i); });
    const clone = sec.cloneNode(true);
    const hide = paths.map((p, i) => (p && !shown.has(i) ? atPath(clone, p) : null)).filter(Boolean);
    for (const el of hide) el.remove();
    clone.querySelector(':scope > aside.notes')?.remove();
    for (const el of clone.querySelectorAll('[data-build-state]')) el.removeAttribute('data-build-state');
    out.push(`${attrs}\u0000${clone.innerHTML}\u0000${segs[k] ?? ''}`);
  }
  return out;
}

/**
 * The stops of one changed slide: every step `k` where the two renders
 * differ, a version with fewer steps held on its last. At least one stop, at
 * step 0, when nothing measurable differs (a change the renders cannot see).
 */
export function changedSteps(before, after) {
  if (!before || !after) return [0];
  const n = Math.max(before.length, after.length);
  const at = (r, k) => r[Math.min(k, r.length - 1)];
  const out = [];
  for (let k = 0; k < n; k++) if (at(before, k) !== at(after, k)) out.push(k);
  return out.length ? out : [0];
}

/**
 * Which mode a candidate opens in: `text` when every change is a slide whose
 * notes are the whole of it (the server's `notesOnly`), `slide` otherwise —
 * a head, an added or removed slide, or any slide that looks different.
 * Pure.
 */
export function reviewMode(units) {
  return units?.length && units.every((u) => u.kind === 'changed' && u.notesOnly) ? 'text' : 'slide';
}

/** The three views D cycles, from the one on screen. */
export const VIEWS = ['diff', 'side', 'slides'];
export const nextView = (view) => VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];

const PREF = 'decklight-fix-review';
const VIEW_PREF = 'decklight-review-view';

export function createFixReview({
  root, overlays, toast = () => {}, base = () => '', previewQuery = () => '?embedded',
  captionsOn = () => false, toggleCaptions = null, writeFetch = fetch, speak = null,
  // the commit window, opened with a draft, on the page the apply's reload brings up
  commitKey = 'decklight-fix-commit:' + location.pathname,
}) {
  let el = null;
  let cand = null;           // the server's summary: { id, rev, what, kind, units, left, … }
  let decisions = new Map(); // unit key → { state: 'approved' | 'rejected', comment }
  let stops = [];            // { key, kind, left: {slide, step} | null, right: …, steps }
  let at = 0;
  let busy = false;          // an apply or an adjustment on its way
  let adjusting = null;      // the unit key the agent is working on
  let box = null;            // the comment box: { mode: 'reject' | 'adjust', key }
  let loadSeq = 0;
  let mode = 'slide';        // 'text' when the notes are the whole change (reviewMode)
  let view = 'slides';       // what the main area shows: 'diff' | 'side' | 'slides'

  const unitOf = (key) => cand?.units.find((u) => u.key === key) ?? null;
  const node = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const frames = () => (el ? [...el.querySelectorAll('.fr-pane iframe')] : []);
  const srcOf = (side, pos) => `${base()}/deck/edit/candidate/at?id=${encodeURIComponent(cand.id)}&side=${side}&rev=${cand.rev}`
    + `&${previewQuery().replace(/^\?/, '')}${captionsOn() ? '&captions' : ''}#/${pos?.slide ?? 1}/${pos?.step ?? 0}`;

  /** The deck instance inside a pane, once it has booted; null after `ms`. */
  async function instanceOf(frame, ms = 15000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try {
        const inst = frame.contentDocument?.querySelector('.decklight')?.__decklight;
        if (inst?._sections) return inst;
      } catch { return null; }   // not this origin: no steps to compare
      await new Promise((r) => setTimeout(r, 60));
    }
    return null;
  }

  /** Load a pane on a fresh document and wait for its deck. */
  function load(frame, side, pos) {
    return new Promise((done) => {
      frame.addEventListener('load', () => done(instanceOf(frame)), { once: true });
      frame.src = srcOf(side, pos);
    });
  }

  /** Every place the two versions differ, unit by unit, in reading order. */
  function computeStops(left, right) {
    const out = [];
    for (const u of cand.units) {
      if (u.kind === 'head') out.push({ key: u.key, kind: u.kind, left: { slide: 1, step: 0 }, right: { slide: 1, step: 0 }, steps: 0 });
      else if (u.kind === 'added') out.push({ key: u.key, kind: u.kind, left: null, right: { slide: u.slide, step: 0 }, steps: 0 });
      else if (u.kind === 'removed') out.push({ key: u.key, kind: u.kind, left: { slide: u.was, step: 0 }, right: null, steps: 0 });
      else {
        const b = stepRenders(left, u.was), a = stepRenders(right, u.slide);
        const steps = Math.max((b?.length ?? 1), (a?.length ?? 1)) - 1;
        for (const k of changedSteps(b, a)) {
          out.push({
            key: u.key, kind: u.kind, steps,
            left: { slide: u.was, step: Math.min(k, (b?.length ?? 1) - 1) },
            right: { slide: u.slide, step: Math.min(k, (a?.length ?? 1) - 1) },
            step: k,
          });
        }
      }
    }
    return out;
  }

  /** Text mode's stops: one per slide, at its first step — the script is read whole. */
  const textStops = () => cand.units.map((u) => ({
    key: u.key, kind: u.kind, steps: 0, step: 0,
    left: { slide: u.was, step: 0 }, right: { slide: u.slide, step: 0 },
  }));

  /** Open the review of candidate `id` (or whichever the server holds). */
  async function open(id = null) {
    if (el && cand?.id === id) return;
    if (el) teardown();
    let j;
    try {
      const r = await fetch(`${base()}/deck/edit/candidate${id ? `?id=${encodeURIComponent(id)}` : ''}`);
      j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || r.status);
    } catch (e) { toast(`nothing to review — ${String(e.message || e).slice(0, 80)}`, 3000); return; }
    cand = j;
    decisions = new Map();
    adjusting = j.adjusting ?? null;
    at = 0;
    mode = reviewMode(cand.units);
    // text mode remembers how you read a script; the slides are the slides
    view = mode === 'text' ? (readPref(VIEW_PREF) === 'side' ? 'side' : 'diff') : 'slides';
    overlays.opening();
    build();
    await reload({ left: true });
  }

  /**
   * (Re)load the panes — both, or the candidate's alone after an adjustment —
   * then the stops. In text mode the stops are the slides and the script is
   * on screen at once; the panes come up behind it for the thumbnail and D.
   */
  async function reload({ left = false, focus = null } = {}) {
    const seq = ++loadSeq;
    const [lf, rf] = frames();
    const first = cand.units[0];
    const pos = first ? { slide: first.slide ?? first.was ?? 1, step: 0 } : null;
    const land = (list) => {
      if (seq !== loadSeq || !el) return;
      stops = list;
      const i = focus ? stops.findIndex((s) => s.key === focus) : -1;
      show(i >= 0 ? i : Math.min(at, Math.max(0, stops.length - 1)));
    };
    if (mode === 'text') {
      land(textStops());
      Promise.all([left ? load(lf, 'before', pos) : instanceOf(lf), load(rf, 'after', pos)]).then(() => {
        if (seq === loadSeq && el) show(at);   // the panes are up: point them at the slide
      });
      return;
    }
    say('loading both versions…');
    const [li, ri] = await Promise.all([left ? load(lf, 'before', pos) : instanceOf(lf), load(rf, 'after', pos)]);
    if (seq !== loadSeq || !el) return;
    land(computeStops(li, ri));
  }

  function build() {
    el = node('div', 'decklight-fixreview');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Review the change');
    el.dataset.mode = mode;
    el.dataset.view = view;
    const panel = node('div', 'fr-panel');
    const head = node('div', 'fr-head');
    const n = cand.units.length;
    head.append(node('span', 'fr-title', `Review · ${cand.what} · ${n} ${n === 1 ? 'change' : 'changes'}`), node('span', 'fr-pos'));
    const body = node('div', 'fr-body');
    const rail = node('nav', 'fr-rail');
    rail.setAttribute('aria-label', 'Slides');
    const main = node('div', 'fr-main');
    const panes = node('div', 'fr-panes');
    for (const [side, label] of [['before', 'current'], ['after', 'proposed']]) {
      const pane = node('figure', `fr-pane fr-${side}`);
      const cap = node('figcaption', 'fr-label', label);
      const frame = node('iframe');
      frame.title = side === 'before' ? 'The deck as it is' : 'The deck with the change';
      const gone = node('div', 'fr-gone');
      gone.hidden = true;
      pane.append(cap, frame, gone);
      // the small proposed render in text mode: a click brings both slides up
      pane.addEventListener('click', () => { if (view !== 'slides') setView('slides'); });
      panes.append(pane);
    }
    const notes = node('div', 'fr-notes');
    notes.hidden = true;
    main.append(panes, notes);
    body.append(rail, main);
    const bar = node('div', 'fr-bar');
    const btn = (cls, text, title, run) => {
      const b = node('button', `fr-btn ${cls}`, text);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', run);
      return b;
    };
    bar.append(
      btn('fr-prev', '‹', 'previous change (← or [)', () => show(at - 1)),
      btn('fr-next', '›', 'next change (→ or ])', () => show(at + 1)),
      btn('fr-view', '', 'what the review shows: the words that changed, the two scripts side by side, or the two slides (D)', () => setView(nextView(view))),
      ...(toggleCaptions ? [btn('fr-cc', 'CC', 'captions in both panes (C)', flipCaptions)] : []),
      node('span', 'fr-state'),
      btn('fr-approve', 'Approve', 'take this slide from the proposal (A)', () => decide('approved')),
      btn('fr-reject', 'Reject…', 'keep this slide as it is, with a comment if you like (X)', () => openBox('reject')),
      btn('fr-adjust', 'Adjust…', 'ask the agent to change this slide of the proposal (E)', () => openBox('adjust')),
      node('span', 'fr-gap'),
      btn('fr-apply', 'Apply validated only', 'write the approved slides — one undo entry (⇧⏎)', () => apply(false)),
      btn('fr-apply-all fr-primary', 'Apply all', 'write every change but the rejected ones — one undo entry (⌘⏎)', () => apply(true)),
    );
    const boxEl = node('div', 'fr-box');
    boxEl.hidden = true;
    const ta = node('textarea', 'fr-comment');
    ta.rows = 2;
    const boxGo = btn('fr-box-go fr-primary', '', '', () => submitBox());
    const boxNo = btn('fr-box-no', 'cancel', 'Esc', () => closeBox());
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBox(); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); submitBox(); return; }
      e.stopPropagation();
    });
    boxEl.append(ta, boxGo, boxNo);
    const foot = node('div', 'fr-foot', '←/→ changes · ↑/↓ slides · A approve · X reject · E adjust · D view'
      + (speak ? ' · P hear it' : '') + ' · C captions · ⇧⏎ apply validated · ⌘⏎ apply all · Esc discards it all');
    panel.append(head, body, bar, boxEl, foot);
    el.append(panel);
    root.appendChild(el);
    // the keys are the review's: a box left focused under it (the agent
    // panel's, docked open by the ask) would keep them as typing
    el.tabIndex = -1;
    el.focus({ preventScroll: true });
    paintCaptions();
    paintView();
    paintRail();
  }

  function say(text) { const p = el?.querySelector('.fr-pos'); if (p) p.textContent = text; }

  /** Where stop `s` is, in words: `slide 24, build 2`, `slide 5 (added)`, `the deck`. */
  function where(s) {
    if (s.kind === 'head') return 'the deck';
    if (s.kind === 'added') return `slide ${s.right.slide} (added)`;
    if (s.kind === 'removed') return `slide ${s.left.slide} (removed)`;
    return `slide ${s.right.slide}${s.steps ? `, build ${s.step}` : ''}`;
  }

  function show(i) {
    if (!el) return;
    if (!stops.length) { say('the proposal changes nothing the review can show'); paintDecision(); paintRail(); return; }
    at = Math.max(0, Math.min(i, stops.length - 1));
    const s = stops[at];
    const [lf, rf] = frames();
    for (const [frame, pos, why] of [[lf, s.left, 'not in the deck as it is — the proposal adds this slide'], [rf, s.right, 'the proposal removes this slide']]) {
      const gone = frame.parentElement.querySelector('.fr-gone');
      gone.hidden = !!pos;
      gone.textContent = pos ? '' : why;
      frame.style.visibility = pos ? '' : 'hidden';
      if (pos) frame.contentWindow?.postMessage({ __decklightPreview: { goto: [pos.slide, pos.step] } }, '*');
    }
    const u = unitOf(s.key);
    say(mode === 'text' ? `slide ${u?.slide ?? s.right.slide}${u?.title ? ` · ${u.title}` : ''} · ${at + 1} of ${stops.length}`
      : `change ${at + 1} of ${stops.length} · ${where(s)}`);
    paintNotes(s);
    paintDecision();
    paintRail();
  }

  /** The first stop of the unit before / after the one on screen. */
  function stepUnit(dir) {
    const s = stops[at];
    if (!s) return;
    const keys = [...new Set(stops.map((x) => x.key))];
    const k = keys[keys.indexOf(s.key) + dir];
    if (k !== undefined) show(stops.findIndex((x) => x.key === k));
  }

  /**
   * The slides down the left: every unit with its state, then what the job
   * left as it was, with why. The row on screen is marked; a click goes there.
   */
  function paintRail() {
    const rail = el?.querySelector('.fr-rail');
    if (!rail) return;
    rail.replaceChildren();
    const cur = stops[at]?.key ?? null;
    const glyph = { approved: '✓', rejected: '✗', adjusting: '⟲', left: '⊘', open: '' };
    const row = (state, n, title, why, run) => {
      const r = node('div', 'fr-row');
      r.dataset.state = state;
      if (run) { r.tabIndex = -1; r.addEventListener('click', run); }
      r.append(node('span', 'fr-row-state', glyph[state]), node('span', 'fr-row-n', n), node('span', 'fr-row-title', title));
      if (why) { r.title = why; r.append(node('span', 'fr-row-why', why)); }
      return r;
    };
    rail.append(node('div', 'fr-rail-head', 'slides'));
    for (const u of cand.units) {
      const d = decisions.get(u.key);
      const state = adjusting === u.key ? 'adjusting' : d?.state ?? 'open';
      const n = u.kind === 'head' ? '—' : String(u.slide ?? u.was);
      const title = u.kind === 'head' ? 'the deck' : `${u.title ?? ''}${u.kind === 'added' ? ' (added)' : u.kind === 'removed' ? ' (removed)' : ''}`.trim() || `slide ${n}`;
      const r = row(state, n, title, d?.comment || null, () => { const i = stops.findIndex((s) => s.key === u.key); if (i >= 0) show(i); });
      if (u.key === cur) r.setAttribute('aria-current', 'true');
      rail.append(r);
    }
    const left = Array.isArray(cand.left) ? cand.left : [];
    if (left.length) {
      rail.append(node('div', 'fr-rail-head', 'left as they were'));
      for (const l of left) rail.append(row('left', String(l.slide), `slide ${l.slide}`, l.why, () => say(`slide ${l.slide} left as it was — ${l.why}`)));
    }
    rail.querySelector('[aria-current]')?.scrollIntoView?.({ block: 'nearest' });
  }

  /** The view: the panes big or small, the notes as a diff, side by side, or hidden behind the slides. */
  function setView(v) {
    view = v;
    if (mode === 'text' && v !== 'slides') writePref(VIEW_PREF, v === 'side' ? 'side' : null);
    paintView();
    const s = stops[at];
    if (s) paintNotes(s);
  }
  function paintView() {
    if (!el) return;
    el.dataset.view = view;
    const b = el.querySelector('.fr-view');
    if (b) b.textContent = view === 'diff' ? 'words' : view === 'side' ? 'side by side' : 'slides';
  }

  /**
   * Under the panes — or, reading a script, in their place: the notes' word
   * diff when the slide's notes changed, inline or as two columns; for the
   * head (whose slides look alike) the lines of it that changed.
   */
  function paintNotes(s) {
    const box = el.querySelector('.fr-notes');
    const u = unitOf(s.key);
    const n = u?.kind === 'head' ? u.lines : u?.notes;
    box.hidden = !n;
    box.replaceChildren();
    if (!n) return;
    const runs = wordDiff(n.before, n.after);
    const { removed, added } = diffCounts(runs);
    const code = u.kind === 'head' ? ' fr-code' : '';
    // built as nodes: the notes are the deck's text, and the agent wrote half of them
    const mark = (r) => node(r.op === '-' ? 'del' : r.op === '+' ? 'ins' : 'span', '', r.text);
    let body;
    if (view === 'side') {
      body = node('div', `fr-side${code}`);
      const before = node('div', 'fr-side-before'), after = node('div', 'fr-side-after');
      for (const r of runs) { if (r.op !== '+') before.append(mark(r)); if (r.op !== '-') after.append(mark(r)); }
      body.append(before, after);
    } else {
      body = node('div', `fr-notes-body${code}`);
      for (const r of runs) body.append(mark(r));
    }
    const what = u.kind === 'head' ? 'outside the slides' : 'notes';
    const headEl = node('div', 'fr-notes-head');
    headEl.append(node('span', '', `${what} · −${removed} +${added} word${added === 1 ? '' : 's'}`));
    if (speak && u.kind !== 'head' && n.after) {
      const hear = node('button', 'fr-btn fr-hear', '▶ hear the proposed script');
      hear.type = 'button';
      hear.title = 'the proposed notes, in the deck\'s live voice (P)';
      hear.addEventListener('click', () => hearProposed());
      headEl.append(hear);
    }
    box.append(headEl, body);
  }

  /** P: the proposed script of the slide on screen, said in the live voice. */
  function hearProposed() {
    const u = unitOf(stops[at]?.key);
    if (!speak || !u?.notes?.after) return;
    speak(u.notes.after, el?.querySelector('.fr-hear') ?? null);
  }

  function paintDecision() {
    const s = stops[at];
    const d = s ? decisions.get(s.key) : null;
    const state = el.querySelector('.fr-state');
    const counts = { approved: 0, rejected: 0 };
    for (const v of decisions.values()) counts[v.state] += 1;
    const open = (cand?.units.length ?? 0) - counts.approved - counts.rejected;
    state.textContent = (adjusting ? `the agent is adjusting ${placeOf(adjusting)}… · ` : '')
      + (s ? (d ? `${d.state}${d.comment ? ` — “${d.comment}”` : ''}` : 'undecided') : '')
      + ` · ${counts.approved} approved · ${counts.rejected} rejected · ${open} to decide`;
    state.dataset.state = d?.state ?? 'open';
    const lock = busy || !!adjusting;
    for (const b of el.querySelectorAll('.fr-approve, .fr-reject, .fr-adjust')) b.disabled = !s || lock;
    el.querySelector('.fr-adjust').disabled = !s || lock || s.kind === 'removed' || s.kind === 'head';
    el.querySelector('.fr-apply').disabled = lock || !counts.approved;
    el.querySelector('.fr-apply-all').disabled = lock || !cand?.units.length || counts.rejected === cand.units.length;
    el.querySelector('.fr-prev').disabled = at <= 0;
    el.querySelector('.fr-next').disabled = at >= stops.length - 1;
  }
  const placeOf = (key) => {
    const u = unitOf(key);
    return !u ? 'a slide' : u.kind === 'head' ? 'the deck' : `slide ${u.slide ?? u.was}`;
  };

  function decide(state, comment = '') {
    const s = stops[at];
    if (!s || busy || adjusting) return;
    decisions.set(s.key, { state, comment });
    // a decision covers the slide: on to the first stop of the next one
    const next = stops.findIndex((x, i) => i > at && x.key !== s.key);
    if (next >= 0) show(next); else { paintDecision(); paintRail(); }
  }

  function openBox(mode) {
    const s = stops[at];
    if (!s || busy || adjusting) return;
    if (mode === 'adjust' && (s.kind === 'removed' || s.kind === 'head')) return;
    box = { mode, key: s.key };
    const b = el.querySelector('.fr-box');
    const ta = b.querySelector('textarea');
    b.hidden = false;
    b.dataset.mode = mode;
    ta.value = mode === 'reject' ? (decisions.get(s.key)?.comment ?? '') : '';
    ta.placeholder = mode === 'reject' ? `why not ${placeOf(s.key)}? (optional — it goes in the commit message)`
      : `what should the agent change on ${placeOf(s.key)}?`;
    b.querySelector('.fr-box-go').textContent = mode === 'reject' ? 'Reject' : 'Ask the agent';
    ta.focus();
  }
  function closeBox() {
    box = null;
    const b = el?.querySelector('.fr-box');
    if (b) b.hidden = true;
    el?.focus({ preventScroll: true });
  }
  async function submitBox() {
    if (!box) return;
    const text = el.querySelector('.fr-comment').value.trim();
    const { mode: boxMode, key } = box;
    if (boxMode === 'reject') { closeBox(); decide('rejected', text); return; }
    if (!text) { el.querySelector('.fr-comment').focus(); return; }
    closeBox();
    // marked before the ask goes out: a quick agent's `candidate` event can
    // arrive before this request's own answer, and must find it to clear
    adjusting = key;
    paintDecision();
    paintRail();
    try {
      const r = await writeFetch(`${base()}/deck/edit/candidate/adjust`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: cand.id, key, comment: text }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || r.status);
      if (adjusting === key) toast(`🤖 ${j.agent} is adjusting ${placeOf(key)}…`, 2400);
    } catch (e) {
      if (adjusting === key) adjusting = null;
      toast(`could not ask for the change — ${String(e.message || e).slice(0, 100)}`, 4000);
    } finally { if (el) { paintDecision(); paintRail(); } }
  }

  /**
   * The server's word on the candidate (`candidate` events): an adjustment is
   * in. The candidate's pane loads again; the adjusted slide is undecided.
   */
  async function update(d) {
    if (!el || !cand || d?.id !== cand.id) return;
    const key = d.adjusted ?? adjusting;
    adjusting = null;
    if (!d.ok) { toast(`the agent left ${placeOf(key)} as it was`, 3000); paintDecision(); paintRail(); return; }
    try {
      const r = await fetch(`${base()}/deck/edit/candidate?id=${encodeURIComponent(cand.id)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      cand = j;
    } catch { toast('the adjusted proposal could not be read — Esc discards it', 4000); return; }
    decisions.delete(key);
    // a decision on a slide the adjustment took away goes with it
    for (const k of [...decisions.keys()]) if (!unitOf(k)) decisions.delete(k);
    toast(`${placeOf(key)} adjusted — decide on it again`, 2600);
    await reload({ focus: key });
  }

  async function apply(all) {
    if (!cand || busy || adjusting) return;
    const take = cand.units.filter((u) => {
      const d = decisions.get(u.key);
      return all ? d?.state !== 'rejected' : d?.state === 'approved';
    }).map((u) => u.key);
    if (!take.length) { toast(all ? 'every change is rejected — Esc discards it all' : 'nothing approved yet — A approves a slide', 2600); return; }
    const rejected = [...decisions].filter(([, d]) => d.state === 'rejected').map(([key, d]) => ({ key, comment: d.comment }));
    busy = true;
    paintDecision();
    try {
      const r = await writeFetch(`${base()}/deck/edit/candidate/apply`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: cand.id, take, rejected }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || r.status);
      // the write reloads the page: the commit window opens on the one that comes up
      if (j.changed && j.commit) {
        try { sessionStorage.setItem(commitKey, JSON.stringify({ ...j.commit, said: j.said, at: Date.now() })); } catch { /* no storage: no draft */ }
      }
      toast(j.said, 4000);
      cand = null;
      teardown();
    } catch (e) {
      busy = false;
      if (el) paintDecision();
      toast(`could not apply it — ${String(e.message || e).slice(0, 120)}`, 5000);
    }
  }

  /** Esc: the candidate goes, and the deck was never touched. */
  async function discard() {
    const c = cand;
    teardown();
    if (!c) return;
    try {
      await writeFetch(`${base()}/deck/edit/candidate/discard`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: c.id }),
      });
    } catch { /* the next proposal replaces it anyway */ }
    toast('discarded — the deck is unchanged', 2600);
  }

  function teardown() {
    loadSeq += 1;
    el?.remove();
    el = null;
    box = null;
    busy = false;
  }

  function paintCaptions() {
    const b = el?.querySelector('.fr-cc');
    if (b) b.setAttribute('aria-pressed', String(captionsOn()));
  }
  function flipCaptions() {
    if (!toggleCaptions) return;
    toggleCaptions();
    for (const f of frames()) f.contentWindow?.postMessage({ __decklightPreview: { captions: captionsOn() } }, '*');
    paintCaptions();
  }

  function keydown(e) {
    if (box) return false;   // the comment box has its own keys
    if (e.key === 'Enter' && e.shiftKey) { apply(false); return true; }
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    switch (e.key) {
      case 'ArrowLeft': case '[': show(at - 1); return true;
      case 'ArrowRight': case ']': show(at + 1); return true;
      case 'ArrowUp': stepUnit(-1); return true;
      case 'ArrowDown': stepUnit(1); return true;
      case 'Home': show(0); return true;
      case 'End': show(stops.length - 1); return true;
      case 'a': case 'A': decide('approved'); return true;
      case 'x': case 'X': openBox('reject'); return true;
      case 'e': case 'E': openBox('adjust'); return true;
      case 'c': case 'C': flipCaptions(); return true;
      case 'd': case 'D': setView(nextView(view)); return true;
      case 'p': case 'P': hearProposed(); return true;
      case 'Escape': discard(); return true;
      default: return true;   // modal: nothing reaches the deck behind it
    }
  }

  // first: drawn over every panel, it owns the keys while the agent panel stays docked beneath
  // ⌘⏎ reaches an overlay as its `save` (the engine asks before fullscreen takes it)
  overlays.register({ isOpen: () => !!el, close: discard, keydown, modal: true, first: true, save: () => { apply(true); return true; } });

  return {
    open, update, isOpen: () => !!el,
    /** The candidate under review and the decisions so far, for a headless probe. */
    state: () => (cand ? { id: cand.id, units: cand.units, left: cand.left ?? [], stops: stops.map((s) => ({ ...s })), at, decisions: Object.fromEntries(decisions), adjusting, mode, view } : null),
    discard, apply,
  };
}

/**
 * Settings → Review quick fixes, and Review agent asks: each on unless the
 * author turned it off, per browser (how you like to work, not a fact about
 * a deck). Off, the fix or the ask lands at once, as it did before the review
 * existed. A script rewrite has no switch: the review is how it arrives.
 */
export const fixReviewOn = () => readPref(PREF) !== 'off';
export const setFixReview = (on) => writePref(PREF, on ? null : 'off');
const ASK_PREF = 'decklight-ask-review';
export const askReviewOn = () => readPref(ASK_PREF) !== 'off';
export const setAskReview = (on) => writePref(ASK_PREF, on ? null : 'off');
