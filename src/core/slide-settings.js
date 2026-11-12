// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The inspector's Slide tab (PRESENTING_EDITING): what a slide is, set from
 * the editor. With the edit bar on and nothing selected, it sits beside Info,
 * which still reports and never edits.
 *
 * Each field is one `<section>` attribute the vocabulary lists (DECK_ANATOMY),
 * written in its place by `POST /deck/edit/slide/attr`: the page shows the
 * change at once and the write is quiet, so it is one undo and no reload, and
 * every other open page is sent the same edits (applySlideAttrs). Two fields
 * cannot follow in place: a chapter is read when the deck loads (the slide
 * number's chrome, the finder), so a chapter name is written for a reload;
 * and Hidden is the Slide menu's own write (HIDDEN_SLIDES), handed in.
 *
 * The field table is pure, so a unit test holds every attribute it names to
 * the server's allow-list (cli/edit.mjs SLIDE_ATTRS): `src/` cannot import
 * `cli/`.
 */

import { createEditCommit } from './edit-commit.js';

/** The transitions a slide may name (DECK_ANATOMY); '' is the deck's own. */
export const TRANSITIONS = ['none', 'fade', 'slide', 'scale', 'flip'];

/**
 * The fields, in the order the tab shows them. `kind` is how it is typed:
 * `text`, `choice` (`choices: [[value, label]]`, '' taking the attribute
 * off), `toggle`, or `clock` (m:ss, stored as whole seconds). `reload` says
 * why the page cannot show it in place; `route: 'hidden'` is a field written
 * by a route of its own.
 */
export const SLIDE_FIELDS = [
  { key: 'chapter', attr: 'data-module', label: 'Chapter starts here', kind: 'text', placeholder: 'no chapter',
    title: 'a chapter of this name starts on this slide; empty, none does', reload: 'a chapter is read when the deck loads' },
  { key: 'transition', attr: 'data-transition', label: 'Transition', kind: 'choice',
    choices: [['', 'the deck’s'], ...TRANSITIONS.map((t) => [t, t])], title: 'how this slide arrives' },
  { key: 'hidden', attr: 'data-hidden', label: 'Hidden when presenting', kind: 'toggle', route: 'hidden',
    title: 'the audience does not see it; it keeps its number' },
  { key: 'timing', attr: 'data-timing', label: 'Planned time', kind: 'clock', placeholder: 'm:ss',
    title: 'the time this slide is planned to take, for rehearsal; empty, none' },
];

/** Whole seconds as m:ss (90 → `1:30`). */
export const clockText = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * What a typed time says, in whole seconds: `1:30`, `0:45`, `90` (seconds)
 * alike; empty (or nothing at all) is null; anything else is NaN.
 */
export function parseClock(text) {
  const t = String(text ?? '').trim();
  if (t === '') return null;
  const m = /^(?:(\d{1,4}):([0-5]\d)|(\d{1,5}))$/.exec(t);
  if (!m) return NaN;
  const s = m[3] !== undefined ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
  return s === 0 ? null : s <= 99999 ? s : NaN;
}

/** A chapter name the server writes: words on one line, bounded. */
const chapterOk = (v) => v.length <= 120 && !/[\u0000-\u001f\u007f]/.test(v);

/** What a field reads on the slide's `<section>` now: text, a choice's value, true/false, or m:ss. */
export function fieldValue(sec, field) {
  const raw = sec?.getAttribute(field.attr) ?? null;
  if (field.kind === 'toggle') return raw !== null;
  if (field.kind === 'clock') return raw && Number(raw) > 0 ? clockText(raw) : '';
  if (field.kind === 'choice') return raw !== null && field.choices.some(([v]) => v === raw) ? raw : '';
  return raw ?? '';
}

/**
 * The write a field's new input makes: `{ set: { attr: value | null } }`, or
 * `{ error }` in words, or null when it changes nothing.
 */
export function writeFor(field, input, current) {
  if (field.kind === 'toggle') return input === current ? null : { set: { [field.attr]: input ? true : null } };
  if (field.kind === 'clock') {
    const s = parseClock(input);
    if (Number.isNaN(s)) return { error: 'a time is m:ss, like 1:30' };
    const now = parseClock(current);
    return s === now ? null : { set: { [field.attr]: s === null ? null : String(s) } };
  }
  const v = String(input ?? '').trim();
  if (v === String(current ?? '')) return null;
  if (field.kind === 'choice' && v !== '' && !field.choices.some(([c]) => c === v)) return { error: `not a ${field.label.toLowerCase()}: ${v}` };
  if (field.kind === 'text' && !chapterOk(v)) return { error: 'a chapter name is one line of up to 120 characters' };
  return { set: { [field.attr]: v === '' ? null : v } };
}

/** Put `set` (`{ name: value }`, as the server wrote it) on a slide's `<section>`: a string its value, true bare, null off. */
export function applySlideAttrs(sec, set) {
  if (!sec || !set || typeof set !== 'object') return;
  for (const [name, value] of Object.entries(set)) {
    if (!/^data-[a-z-]+$/.test(name)) continue;
    if (value === null) sec.removeAttribute(name);
    else sec.setAttribute(name, value === true ? '' : String(value));
  }
}

/**
 * The Slide tab, for `inspector.addTab`. `setHidden(slide, hidden)` is the
 * engine's own write (the Slide menu's row, HIDDEN_SLIDES).
 */
export function createSlideSettings({ instance, editmode, toast, setHidden }) {
  const commit = createEditCommit(editmode);
  const em = () => editmode();
  const sectionAt = (n) => instance()._sections?.[n - 1] ?? null;
  const editing = () => !!(em()?.available?.() && em()?.elementEditOn?.());

  /** Write one field's new value for slide `slide`, the slide shown at once; false when it did not land. */
  async function save(slide, field, input) {
    const sec = sectionAt(slide);
    if (!sec) return false;
    const w = writeFor(field, input, fieldValue(sec, field));
    if (!w) return true;
    if (w.error) { toast(w.error, 3200); return false; }
    if (field.route === 'hidden') { await setHidden(slide, !!w.set[field.attr]); return true; }
    const before = Object.fromEntries(Object.keys(w.set).map((k) => [k, sec.getAttribute(k)]));
    try {
      if (field.reload) {
        // the file gets it, and the reload every page then makes shows it
        await commit.post('/deck/edit/slide/attr', { slide, set: w.set }, { quiet: false });
        return true;
      }
      applySlideAttrs(sec, w.set);
      await commit.post('/deck/edit/slide/attr', { slide, set: w.set });
      return true;
    } catch (e) {
      applySlideAttrs(sec, before);   // as it was: what it said, or nothing
      toast(commit.notSaved(`slide ${slide}’s ${field.label.toLowerCase()}`, e), 6000);
      return false;
    }
  }

  /** One field's control, filled from the slide; `fill()` reads it again. */
  function control(slide, field, after) {
    const sec = () => sectionAt(slide);
    const keys = (el) => el.addEventListener('keydown', (e) => e.stopPropagation());
    if (field.kind === 'toggle') {
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'ins-check' });
      box.setAttribute('aria-label', field.label);
      keys(box);
      box.addEventListener('change', async () => { box.disabled = true; await save(slide, field, box.checked); box.disabled = false; after(); });
      return { el: box, fill: () => { box.checked = fieldValue(sec(), field); } };
    }
    if (field.kind === 'choice') {
      const pick = Object.assign(document.createElement('select'), { className: 'ins-field ins-select' });
      pick.setAttribute('aria-label', field.label);
      for (const [v, label] of field.choices) pick.append(Object.assign(document.createElement('option'), { value: v, textContent: label }));
      keys(pick);
      pick.addEventListener('change', async () => { pick.disabled = true; await save(slide, field, pick.value); pick.disabled = false; after(); });
      return { el: pick, fill: () => { pick.value = fieldValue(sec(), field); } };
    }
    // text and m:ss: ⏎ or leaving saves, Esc puts the value back
    const input = Object.assign(document.createElement('input'), { type: 'text', className: 'ins-field', placeholder: field.placeholder ?? '' });
    input.setAttribute('aria-label', field.label);
    input.spellcheck = field.kind === 'text';
    let busy = false;
    // what the field last read off the slide: typing makes it differ, and a
    // repaint leaves typing alone until it is saved or put back
    let filled = '';
    const reread = () => { input.value = filled = fieldValue(sec(), field); };
    const commitIt = async () => {
      if (busy || input.value.trim() === fieldValue(sec(), field)) return;
      busy = true;
      input.disabled = true;
      await save(slide, field, input.value);
      input.disabled = false;
      busy = false;
      // saved or refused, the field says what the slide says now: what was
      // typed never stays behind to be written again when the field is left
      reread();
      after();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitIt(); }
      else if (e.key === 'Escape') { e.preventDefault(); reread(); input.blur(); }
    });
    input.addEventListener('blur', () => commitIt());
    return { el: input, fill: () => { if (input.value === filled || document.activeElement !== input) reread(); } };
  }

  /** The tab's pane for slide `slide`: one row a field, read from the slide. */
  function pane({ slide }) {
    const el = document.createElement('div');
    el.className = 'ins-slide-settings';
    const grid = document.createElement('dl');
    grid.className = 'ins-rows ins-settings';
    const controls = [];
    const fill = () => { for (const c of controls) c.fill(); };
    for (const field of SLIDE_FIELDS) {
      const c = control(slide, field, fill);
      controls.push(c);
      const dt = Object.assign(document.createElement('dt'), { textContent: field.label, title: field.title ?? '' });
      const dd = document.createElement('dd');
      dd.dataset.key = field.key;
      dd.append(c.el);
      grid.append(dt, dd);
    }
    el.append(grid);
    fill();
    return { el, destroy() {} };
  }

  const tab = {
    id: 'slide', label: 'Slide', title: 'this slide’s settings: chapter, transition, hidden, planned time',
    showsWithoutSelection: true, showsWithSelection: false,
    shows: () => editing(),
    key: (ctx) => ctx.slide,
    pane,
    foot: 'esc closes',
  };
  return { tab, save };
}
