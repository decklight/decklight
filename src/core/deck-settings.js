// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Deck settings… (PRESENTING_EDITING): what belongs to the whole deck and is
 * saved in its file, set from the editor. Its title (the page's `<title>`),
 * its default transition, slide numbers, arrows, title pinning, logo and
 * narration pauses: the keys of its configuration (DECK_ANATOMY), read with
 * `GET /deck/edit/config` and saved with `POST /deck/edit/config`, all of a
 * save's changes in one write and one undo. A value set back to its default
 * takes its key off the file. The runtime reads these when the deck loads, so
 * every page reloads once they are saved.
 *
 * Settings… is a different card: presenting preferences for this browser.
 *
 * A deck whose configuration this editor cannot rewrite (written as code, or
 * booted from a separate script) shows the card read-only, with one sentence
 * saying why, and writes nothing.
 */

import { closeOnBackdrop } from './overlay.js';
import { createEditCommit } from './edit-commit.js';

/** The corners a logo can sit in (DECK_ANATOMY). */
export const LOGO_CORNERS = [['bottom-left', 'bottom left'], ['top-left', 'top left'], ['top-right', 'top right'], ['bottom-right', 'bottom right']];

/**
 * The card's fields, in order: `key` is the configuration key the server
 * writes (cli/runtime-link.mjs DECK_SETTINGS), or `title` for the page's.
 * `kind`: text, choice (`choices: [[value, label]]`), toggle, pin, logo, seconds.
 */
export const DECK_FIELDS = [
  { key: 'title', label: 'Title', kind: 'text', placeholder: 'the page’s title' },
  { key: 'transition', label: 'Transition', kind: 'choice', choices: ['fade', 'none', 'slide', 'scale', 'flip'].map((t) => [t, t]) },
  { key: 'slideNumber', label: 'Slide numbers', kind: 'choice', choices: [[false, 'off'], ['n', '4'], ['n/N', '4 / 12']] },
  { key: 'controls', label: 'Arrows', kind: 'toggle', text: 'show the arrows' },
  { key: 'pinTitles', label: 'Pin titles', kind: 'pin' },
  { key: 'logo', label: 'Logo', kind: 'logo' },
  { key: 'narration.slidePause', label: 'Pause after a slide', kind: 'seconds', group: 'Narration' },
  { key: 'narration.beatPause', label: 'Between beats', kind: 'seconds', group: 'Narration' },
  { key: 'narration.sentencePause', label: 'Between sentences', kind: 'seconds', group: 'Narration' },
];

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What a save writes: `{ set, title }` with only what differs from what the
 * file said (`set` null, `title` undefined when nothing does), or `{ error }`.
 */
export function deckChanges(loaded, draft) {
  const set = {};
  for (const f of DECK_FIELDS) {
    if (f.key === 'title') continue;
    const v = draft.values[f.key];
    if (f.kind === 'seconds' && v !== null && !(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 60)) return { error: `${f.label.toLowerCase()} is a number of seconds, 0 to 60` };
    if (!same(v, loaded.values[f.key])) set[f.key] = v;
  }
  const title = draft.title.trim();
  return { set: Object.keys(set).length ? set : null, title: title !== loaded.title ? title : undefined };
}

/** A logo as the configuration holds it, from the card's four fields: null when it shows no picture. */
export function logoOf({ onLight = '', onDark = '', src = '', height = '', position = '' }) {
  const out = {};
  if (onLight.trim()) out.onLight = onLight.trim();
  if (onDark.trim()) out.onDark = onDark.trim();
  if (src.trim()) out.src = src.trim();
  if (!out.onLight && !out.onDark && !out.src) return null;
  const h = Number(String(height).trim());
  if (String(height).trim() !== '' && Number.isFinite(h)) out.height = Math.round(h);
  if (position && position !== 'bottom-left') out.position = position;
  return out;
}

export function createDeckSettings({ root, overlays, editmode, toast }) {
  const commit = createEditCommit(editmode);
  let el = null;
  let loaded = null;
  let draft = null;
  let busy = false;

  function close() {
    el?.remove();
    el = null;
    loaded = draft = null;
  }

  const base = () => editmode()?.base?.() ?? '';
  async function upload(file) {
    const res = await fetch(base() + '/deck/edit/asset', { method: 'POST', headers: { 'content-type': file.type, 'x-decklight-name': file.name }, body: file });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || String(res.status));
    return j.src;
  }
  // the file chooser: a harness hands in its own
  let chooser = () => new Promise((done) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.click();
  });

  async function open() {
    if (el) { close(); return; }
    if (!editmode()?.available?.()) { toast('Deck settings… is write mode’s: the deck’s file is what it changes', 3600); return; }
    overlays.opening();
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-decksettings';
    el.innerHTML = '<div class="narr-card" role="dialog" aria-label="Deck settings"><div class="narr-head">Deck settings · saved in the deck</div><div class="rec-line">reading the deck…</div></div>';
    closeOnBackdrop(el, close);
    root.appendChild(el);
    try {
      const res = await fetch(base() + '/deck/edit/config');
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || String(res.status));
      if (!el) return;
      loaded = { title: j.title ?? '', values: j.values ?? {}, editable: j.editable !== false, why: j.why ?? null };
      draft = { title: loaded.title, values: { ...loaded.values } };
      paint();
    } catch (e) {
      if (!el) return;
      el.querySelector('.rec-line').textContent = `the deck’s settings could not be read: ${commit.why(e)}`;
    }
  }

  async function save() {
    if (!loaded?.editable || busy) return;
    const c = deckChanges(loaded, draft);
    if (c.error) { toast(c.error, 3600); return; }
    if (!c.set && c.title === undefined) { close(); return; }
    busy = true;
    paintBusy(true);
    try {
      await commit.post('/deck/edit/config', { ...(c.set ? { set: c.set } : {}), ...(c.title !== undefined ? { title: c.title } : {}) }, { quiet: false });
      close();
      toast('deck settings saved: the deck reloads to show them', 3200);
    } catch (e) {
      toast(commit.notSaved('the deck’s settings', e), 6000);
      paintBusy(false);
    } finally { busy = false; }
  }
  function paintBusy(on) { for (const n of el?.querySelectorAll('input, select, button') ?? []) n.disabled = on || !loaded?.editable; }

  /** One field's control, reading and writing the draft. */
  function control(f) {
    const ro = !loaded.editable;
    const keys = (n) => n.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') return;   // the card's: it closes
      e.stopPropagation();
      if (e.key === 'Enter' && n.tagName === 'INPUT' && n.type !== 'checkbox') { e.preventDefault(); n.blur(); save(); }
    });
    const text = (value, placeholder, onInput, cls = 'ins-field') => {
      const i = Object.assign(document.createElement('input'), { type: 'text', className: cls, value: value ?? '', placeholder: placeholder ?? '', disabled: ro });
      i.addEventListener('input', () => onInput(i.value));
      keys(i);
      return i;
    };
    const select = (choices, value, onPick) => {
      const s = Object.assign(document.createElement('select'), { className: 'ins-field ins-select', disabled: ro });
      choices.forEach(([v, label], i) => s.append(Object.assign(document.createElement('option'), { value: String(i), textContent: label, selected: same(v, value) })));
      s.addEventListener('change', () => onPick(choices[Number(s.value)][0]));
      keys(s);
      return s;
    };
    const line = (...nodes) => { const l = Object.assign(document.createElement('span'), { className: 'ins-line' }); l.append(...nodes); return l; };
    const v = f.key === 'title' ? draft.title : draft.values[f.key];
    if (f.key === 'title') return text(v, f.placeholder, (t) => { draft.title = t; });
    if (f.kind === 'choice') return select(f.choices, v, (x) => { draft.values[f.key] = x; });
    if (f.kind === 'toggle') {
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'ins-check', checked: v !== false, disabled: ro });
      box.addEventListener('change', () => { draft.values[f.key] = box.checked; });
      keys(box);
      const label = Object.assign(document.createElement('label'), { className: 'ins-line' });
      label.append(box, Object.assign(document.createElement('span'), { textContent: f.text }));
      return label;
    }
    if (f.kind === 'seconds') {
      return line(text(v ?? '', 's', (t) => { const n = Number(t.trim()); draft.values[f.key] = t.trim() === '' ? null : Number.isFinite(n) ? n : NaN; }, 'ins-field ins-short'),
        Object.assign(document.createElement('span'), { className: 'ins-extra', textContent: 'seconds' }));
    }
    if (f.kind === 'pin') {
      // at the same height (the default), off, or at a height typed
      const mode = v === false ? 'off' : typeof v === 'number' ? 'y' : 'on';
      const y = text(typeof v === 'number' ? String(v) : '', 'height', (t) => { const n = Number(t.trim()); draft.values.pinTitles = t.trim() === '' ? true : Number.isFinite(n) ? n : NaN; }, 'ins-field ins-short');
      y.hidden = mode !== 'y';
      const s = select([['on', 'at the same height'], ['off', 'off'], ['y', 'at a height']], mode, (m) => {
        y.hidden = m !== 'y';
        draft.values.pinTitles = m === 'off' ? false : m === 'on' ? true : (Number.isFinite(Number(y.value)) && y.value.trim() !== '' ? Number(y.value) : 99);
        if (m === 'y' && y.value.trim() === '') y.value = '99';
      });
      return line(s, y);
    }
    if (f.kind === 'logo') {
      // a picture for light themes and one for dark, chosen or typed as a path beside the deck; its height and corner
      const lg = { onLight: v?.onLight ?? '', onDark: v?.onDark ?? '', src: v?.src ?? '', height: v?.height ?? '', position: v?.position ?? 'bottom-left' };
      const put = () => { draft.values.logo = logoOf(lg); };
      const wrap = Object.assign(document.createElement('div'), { className: 'ds-logo' });
      for (const [k, label] of [['onLight', 'light'], ['onDark', 'dark']]) {
        const path = text(lg[k], 'a picture beside the deck', (t) => { lg[k] = t; put(); });
        path.setAttribute('aria-label', `logo for ${label} themes`);
        const pick = Object.assign(document.createElement('button'), { type: 'button', className: 'ins-btn', textContent: 'Choose…', disabled: ro });
        pick.addEventListener('click', async (e) => {
          e.stopPropagation();
          const file = await chooser();
          if (!file) return;
          try { const src = await upload(file); lg[k] = path.value = src; put(); } catch (err) { toast(`the logo was not added: ${commit.why(err)}`, 6000); }
        });
        wrap.append(line(Object.assign(document.createElement('span'), { className: 'ds-sub', textContent: label }), path, pick));
      }
      const h = text(String(lg.height), 'px', (t) => { lg.height = t; put(); }, 'ins-field ins-short');
      h.setAttribute('aria-label', 'logo height');
      const corner = select(LOGO_CORNERS, lg.position, (p) => { lg.position = p; put(); });
      corner.setAttribute('aria-label', 'logo corner');
      wrap.append(line(Object.assign(document.createElement('span'), { className: 'ds-sub', textContent: 'height' }), h,
        Object.assign(document.createElement('span'), { className: 'ds-sub', textContent: 'corner' }), corner));
      return wrap;
    }
    return document.createElement('span');
  }

  function paint() {
    const card = el.querySelector('.narr-card');
    card.replaceChildren();
    card.append(Object.assign(document.createElement('div'), { className: 'narr-head', textContent: 'Deck settings · saved in the deck' }));
    if (!loaded.editable) card.append(Object.assign(document.createElement('div'), { className: 'rec-line ds-why', textContent: `Read-only: ${loaded.why}` }));
    const grid = document.createElement('dl');
    grid.className = 'ins-rows ins-settings ds-rows';
    let group = null;
    for (const f of DECK_FIELDS) {
      if (f.group && f.group !== group) { group = f.group; grid.append(Object.assign(document.createElement('div'), { className: 'ins-group', textContent: group })); }
      const dt = Object.assign(document.createElement('dt'), { textContent: f.label });
      const dd = document.createElement('dd');
      dd.dataset.key = f.key;
      dd.append(control(f));
      grid.append(dt, dd);
    }
    card.append(grid);
    const foot = Object.assign(document.createElement('div'), { className: 'ds-foot' });
    foot.append(Object.assign(document.createElement('span'), { className: 'rec-hint', textContent: 'presenting preferences for this browser are under Settings…' }));
    if (loaded.editable) {
      const ok = Object.assign(document.createElement('button'), { type: 'button', className: 'ins-btn ds-save', textContent: 'Save' });
      ok.addEventListener('click', (e) => { e.stopPropagation(); save(); });
      foot.append(ok);
    }
    card.append(foot);
    card.querySelector('input:not([disabled]), select:not([disabled])')?.focus();
  }

  overlays.register({
    isOpen: () => !!el,
    close,
    keydown(e) {
      if (e.key === 'Escape') { close(); return true; }
      return true;   // a modal card: the deck does not move under it
    },
  });

  return { open, close, isOpen: () => !!el, save, setChooser: (fn) => { chooser = fn; } };
}
