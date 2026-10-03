// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// One answer out of a few, on a card: ↑↓ choose, Enter picks, Esc closes. A row
// can carry a figure on its right (what that answer costs: a size, a time) and
// a quieter note under its name; a row that cannot be picked here is shown
// dimmed with its reason rather than hidden, so the choice it would have been
// stays visible. First used for what a bundle carries of the narration audio.

import { closeOnBackdrop, selectInList } from './overlay.js';

export function createChoiceCard({ root, overlays }) {
  let el = null, rows = [], rowEls = [], sel = 0, want = null;

  function close() {
    el?.remove();
    el = null;
    want = null;
  }
  const pickable = (i) => rows[i] && !rows[i].blocked;
  /** Row `i`, or the next one that can be picked in the direction of travel. */
  function select(i, dir = 1) {
    const n = rows.length;
    const at = (k) => ((k % n) + n) % n;
    for (let step = 0; step < n && !pickable(at(i)); step++) i += dir;
    sel = selectInList(rowEls, at(i), 'narr-sel');
  }
  function pick(i = sel) {
    if (!want || !pickable(i)) return;
    const { onPick } = want;
    const { value } = rows[i];
    close();
    onPick(value);
  }

  /**
   * `rows`: [{ label, value, figure?, note?, blocked? (the reason) }];
   * `current`: the value to start on.
   */
  function open({ title, lines = [], rows: given, current = null, onPick }) {
    if (el) close();
    want = { onPick };
    rows = given;
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-choice';
    const card = document.createElement('div');
    card.className = 'narr-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', title);
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = title;
    card.append(head);
    for (const text of lines) {
      const line = document.createElement('div');
      line.className = 'rec-line';
      line.textContent = text;
      card.append(line);
    }
    rowEls = rows.map((row, i) => {
      const r = document.createElement('div');
      r.className = 'narr-row' + (row.blocked ? ' narr-blocked' : '');
      const label = document.createElement('span');
      label.className = 'narr-row-label';
      label.textContent = row.label;
      if (row.note || row.blocked) {
        const note = document.createElement('span');
        note.className = 'narr-flavor';
        note.textContent = row.blocked || row.note;
        label.append(note);
      }
      r.append(label);
      if (row.figure) {
        const fig = document.createElement('span');
        fig.className = 'choice-figure';
        fig.textContent = row.figure;
        r.append(fig);
      }
      r.addEventListener('mouseenter', () => { if (pickable(i)) sel = selectInList(rowEls, i, 'narr-sel'); });
      r.addEventListener('click', () => pick(i));
      card.append(r);
      return r;
    });
    const hint = document.createElement('div');
    hint.className = 'rec-hint';
    hint.textContent = '↑↓ choose · Enter picks · Esc closes';
    card.append(hint);
    el.append(card);
    closeOnBackdrop(el, close);
    root.appendChild(el);
    const at = rows.findIndex((r) => r.value === current && !r.blocked);
    sel = 0;
    select(at >= 0 ? at : 0);
  }

  overlays.register({
    isOpen: () => !!el,
    close,
    keydown(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { const dir = e.key === 'ArrowDown' ? 1 : -1; select(sel + dir, dir); }
      else if (e.key === 'Enter') pick();
      else if (e.key === 'Escape') close();
      return true;
    },
  });

  return { open, close, isOpen: () => !!el };
}
