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
  if (field.kind === 'range') { const d = Number(raw); return Number.isFinite(d) ? Math.round(Math.min(Math.max(d, 0), 1) * 100) : 0; }
  return raw ?? '';
}

/**
 * The write a field's new input makes: `{ set: { attr: value | null } }`, or
 * `{ error }` in words, or null when it changes nothing. A path emptied takes
 * its attribute off; a slider at 0 does too.
 */
export function writeFor(field, input, current) {
  if (field.kind === 'toggle') return input === current ? null : { set: { [field.attr]: input ? true : null } };
  if (field.kind === 'clock') {
    const s = parseClock(input);
    if (Number.isNaN(s)) return { error: 'a time is m:ss, like 1:30' };
    const now = parseClock(current);
    return s === now ? null : { set: { [field.attr]: s === null ? null : String(s) } };
  }
  if (field.kind === 'range') {
    const v = dimValue(input);
    return v === dimValue(current) ? null : { set: { [field.attr]: v } };
  }
  const v = String(input ?? '').trim();
  if (v === String(current ?? '')) return null;
  if (field.kind === 'path' && v !== '' && !pathOk(v)) return { error: 'a file beside the deck, written as a relative path: media/loop.mp4' };
  if (field.kind === 'choice' && v !== '' && !field.choices.some(([c]) => c === v)) return { error: `not a ${field.label.toLowerCase()}: ${v}` };
  if (field.kind === 'text' && !chapterOk(v)) return { error: 'a chapter name is one line of up to 120 characters' };
  return { set: { [field.attr]: v === '' ? null : v } };
}

/** The nine places a background can sit; '' is the centre, the default. */
export const POSITIONS = ['top left', 'top', 'top right', 'left', '', 'right', 'bottom left', 'bottom', 'bottom right'];
const hasMedia = (sec) => !!(sec?.hasAttribute('data-background-image') || sec?.hasAttribute('data-background-video'));

/**
 * The background's fields (DECK_ANATOMY, background media), shown under the
 * Background heading. Fit, position and dim tune a picture or a video, so
 * they show only once the slide has one. `range` is a 0 to 100% slider,
 * stored 0 to 1; `path` is a file beside the deck.
 */
export const BACKGROUND_FIELDS = [
  { key: 'video', attr: 'data-background-video', label: 'Video', kind: 'path', placeholder: 'a video beside the deck: media/loop.mp4',
    title: 'a muted, looping video behind the slide while it is on' },
  { key: 'poster', attr: 'data-background-poster', label: 'Poster', kind: 'path', placeholder: 'its still, for print: media/loop.jpg',
    title: 'the picture that stands in for the video in a PDF', when: (sec) => sec?.hasAttribute('data-background-video') },
  { key: 'fit', attr: 'data-background-size', label: 'Fit', kind: 'choice', choices: [['', 'fill the slide'], ['contain', 'show it whole']],
    title: 'fill crops to the slide; whole shows all of it', when: hasMedia },
  { key: 'position', attr: 'data-background-position', label: 'Position', kind: 'choice',
    choices: POSITIONS.map((p) => [p, p || 'center']), title: 'where it sits on the slide', when: hasMedia },
  { key: 'dim', attr: 'data-background-dim', label: 'Dim', kind: 'range', title: 'dims it toward the canvas, so text reads over it', when: hasMedia },
];

/** A dim's slider (0 to 100) as the attribute stores it: '0.4'; 0 is none. */
export const dimValue = (pct) => {
  const n = Math.round(Math.min(Math.max(Number(pct) || 0, 0), 100));
  return n === 0 ? null : String(n / 100);
};
/** A path the server takes for a background file: relative, beside the deck. */
const pathOk = (v) => /^(?![a-z][a-z0-9+.-]*:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s"'<>\\?#][^"'<>\\?#]{0,199}$/i.test(v);

/** Put `set` (`{ name: value }`, as the server wrote it) on a slide's `<section>`: a string its value, true bare, null off. */
export function applySlideAttrs(sec, set) {
  if (!sec || !set || typeof set !== 'object') return;
  for (const [name, value] of Object.entries(set)) {
    if (!/^data-[a-z-]+$/.test(name)) continue;
    if (value === null) sec.removeAttribute(name);
    else sec.setAttribute(name, value === true ? '' : String(value));
  }
}

/** How long a slider rests before what it says is written: the chart grid's QUIET_MS. */
export const QUIET_MS = 700;

/**
 * The Slide tab, for `inspector.addTab`. `setHidden(slide, hidden)` is the
 * engine's own write (the Slide menu's row, HIDDEN_SLIDES); `pictures()` the
 * background picture's (pictures.js), so the tab's Picture… and Remove are
 * the Slide menu's rows.
 */
export function createSlideSettings({ instance, editmode, toast, setHidden, pictures = () => null }) {
  const commit = createEditCommit(editmode);
  const em = () => editmode();
  const sectionAt = (n) => instance()._sections?.[n - 1] ?? null;
  const editing = () => !!(em()?.available?.() && em()?.elementEditOn?.());
  const touchesBackground = (set) => Object.keys(set).some((k) => k.startsWith('data-background-'));
  /** The slide shown as its attributes now say: its background layer drawn again when that changed. */
  function show(sec, set) {
    applySlideAttrs(sec, set);
    if (touchesBackground(set)) instance().refreshSlide?.(sec, { background: true, scan: false, relayout: false });
  }

  /**
   * Write `set` for slide `slide`, the slide already showing it; `before` is
   * what it said, put back on a refusal. False when it did not land.
   */
  async function write(slide, set, before, what, { reload = false } = {}) {
    const sec = sectionAt(slide);
    try {
      // a chapter: the file gets it, and the reload every page then makes shows it
      await commit.post('/deck/edit/slide/attr', { slide, set }, { quiet: !reload });
      return true;
    } catch (e) {
      if (sec && !reload) show(sec, before);
      toast(commit.notSaved(`slide ${slide}’s ${what}`, e), 6000);
      return false;
    }
  }
  const beforeOf = (sec, set) => Object.fromEntries(Object.keys(set).map((k) => [k, sec.getAttribute(k)]));

  /** Write one field's new value for slide `slide`, the slide shown at once; false when it did not land. */
  async function save(slide, field, input) {
    const sec = sectionAt(slide);
    if (!sec) return false;
    const w = writeFor(field, input, fieldValue(sec, field));
    if (!w) return true;
    if (w.error) { toast(w.error, 3200); return false; }
    if (field.route === 'hidden') { await setHidden(slide, !!w.set[field.attr]); return true; }
    const before = beforeOf(sec, w.set);
    if (!field.reload) show(sec, w.set);
    return write(slide, w.set, before, field.label.toLowerCase(), { reload: !!field.reload });
  }

  /** Take the background off: the picture through its own route, a video (and its poster and tuning) through this one. */
  async function removeBackground(slide) {
    const sec = sectionAt(slide);
    if (!sec) return;
    if (sec.hasAttribute('data-background-video')) {
      const set = { 'data-background-video': null, 'data-background-poster': null };
      if (!sec.hasAttribute('data-background-image')) for (const f of BACKGROUND_FIELDS) if (f.kind !== 'path') set[f.attr] = null;
      const before = beforeOf(sec, set);
      show(sec, set);
      if (!(await write(slide, set, before, 'background video'))) return;
    }
    if (sec.hasAttribute('data-background-image')) await pictures()?.removeBackground?.(slide);
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
    if (field.kind === 'range') {
      // dragged: the slide follows at once, and what it rests on is written once
      const wrap = Object.assign(document.createElement('span'), { className: 'ins-range' });
      const range = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: '100', step: '5', className: 'ins-slider' });
      range.setAttribute('aria-label', field.label);
      const said = Object.assign(document.createElement('span'), { className: 'ins-range-value' });
      wrap.append(range, said);
      keys(range);
      let from = null;
      let timer = 0;
      const flush = async () => {
        clearTimeout(timer);
        timer = 0;
        if (from === null) return;
        const s = sec();
        const set = { [field.attr]: dimValue(range.value) };
        const before = { [field.attr]: from };
        from = null;
        if (s && set[field.attr] !== before[field.attr]) await write(slide, set, before, field.label.toLowerCase());
        after();
      };
      range.addEventListener('input', () => {
        const s = sec();
        if (!s) return;
        if (from === null) from = s.getAttribute(field.attr);
        show(s, { [field.attr]: dimValue(range.value) });
        said.textContent = `${range.value}%`;
        clearTimeout(timer);
        timer = setTimeout(flush, QUIET_MS);
      });
      range.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(flush, QUIET_MS); });
      return {
        el: wrap,
        fill: () => { if (from !== null) return; const v = fieldValue(sec(), field); range.value = String(v); said.textContent = `${v}%`; },
        flush,
      };
    }
    // text, m:ss and a path: ⏎ or leaving saves, Esc puts the value back
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

  /** A row of the grid: its label, and what goes beside it. */
  function rowOf(grid, key, label, title, ...nodes) {
    const dt = Object.assign(document.createElement('dt'), { textContent: label, title: title ?? '' });
    const dd = document.createElement('dd');
    dd.dataset.key = key;
    dd.append(...nodes);
    grid.append(dt, dd);
    return { dt, dd };
  }
  const button = (label, title, run) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ins-btn', textContent: label, title });
    b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
    return b;
  };

  /**
   * The tab's pane for slide `slide`: one row a field, read from the slide,
   * and read again whenever the slide's attributes change, whoever changed
   * them (the Slide menu's background rows, another page, an undo's reload).
   */
  function pane({ slide }) {
    const el = document.createElement('div');
    el.className = 'ins-slide-settings';
    const grid = document.createElement('dl');
    grid.className = 'ins-rows ins-settings';
    const controls = [];
    const shown = [];   // rows that show only on some slides: [field, row]
    for (const field of SLIDE_FIELDS) {
      const c = control(slide, field, () => fill());
      controls.push(c);
      rowOf(grid, field.key, field.label, field.title, c.el);
    }
    // ── the background: a picture (the Slide menu's rows) or a video beside the deck
    grid.append(Object.assign(document.createElement('div'), { className: 'ins-group', textContent: 'Background' }));
    const file = Object.assign(document.createElement('span'), { className: 'ins-value ins-file' });
    const pick = button('Picture…', 'choose a picture for the background', () => pictures()?.chooseBackground?.(slide));
    const remove = button('Remove', 'take the background off', () => removeBackground(slide));
    const line = Object.assign(document.createElement('span'), { className: 'ins-line' });
    line.append(file, pick, remove);
    rowOf(grid, 'background', 'Picture', 'the picture behind the whole slide', line);
    for (const field of BACKGROUND_FIELDS) {
      const c = control(slide, field, () => fill());
      controls.push(c);
      const row = rowOf(grid, field.key, field.label, field.title, c.el);
      if (field.when) shown.push([field, row]);
    }
    el.append(grid);
    function fill() {
      const sec = sectionAt(slide);
      const image = sec?.getAttribute('data-background-image') ?? null;
      // a file by its name, its path on hover; one written inline is said so, not spelled out
      file.textContent = !image ? 'none' : /^data:/i.test(image) ? 'inline picture' : image.split('/').pop();
      file.title = image && !/^data:/i.test(image) ? image : '';
      pick.textContent = image ? 'Replace…' : 'Picture…';
      pick.hidden = !pictures()?.chooseBackground;
      remove.hidden = !(image || sec?.hasAttribute('data-background-video'));
      for (const [field, row] of shown) row.dt.hidden = row.dd.hidden = !field.when(sec);
      for (const c of controls) c.fill();
    }
    fill();
    const sec = sectionAt(slide);
    const watch = typeof MutationObserver === 'function' && sec ? new MutationObserver(() => fill()) : null;
    watch?.observe(sec, { attributes: true, attributeFilter: [...SLIDE_FIELDS, ...BACKGROUND_FIELDS].map((f) => f.attr).concat('data-background-image') });
    return {
      el,
      destroy() {
        watch?.disconnect();
        // a slider still resting is written as it is left
        for (const c of controls) c.flush?.();
      },
    };
  }

  const tab = {
    id: 'slide', label: 'Slide', title: 'this slide’s settings: chapter, transition, hidden, planned time, background',
    showsWithoutSelection: true, showsWithSelection: false,
    shows: () => editing(),
    key: (ctx) => ctx.slide,
    pane,
    foot: 'esc closes',
  };
  return { tab, save, removeBackground };
}
