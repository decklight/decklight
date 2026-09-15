// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A slide range, picked — for the things that work on PART of a deck: the video
// export, and the two recorders. Both used to reach a range only from the
// command line (`decklight video --slides`, `decklight record --slides`), which
// is exactly where somebody fixing slide 7 of a forty-slide talk is not.
//
// The spelling is the commands' own: '5-9', or '7' for one slide, and null for
// the whole deck. What the picker hands back is what `--slides` takes, so the
// author server passes it straight through and the two can never disagree about
// what a range means.

import { closeOnBackdrop, selectInList } from './overlay.js';

/**
 * '5-9' → { from: 5, to: 9 }, '7' → { from: 7, to: 7 }, null when it is not a
 * range of a deck this long. An en dash reads as the hyphen it was meant to be:
 * it is how the picker itself prints a range.
 */
export function parseRange(s, total) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(s ?? '').trim().replace(/\s*[-–—]\s*/, '-'));
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  return from >= 1 && from <= to && to <= total ? { from, to } : null;
}

/** { from, to } → the `--slides` spelling, or null when it is the whole deck. */
export function rangeArg({ from, to }, total) {
  if (from === 1 && to === total) return null;
  return from === to ? String(from) : `${from}-${to}`;
}

/** How a `--slides` value reads on screen. */
export function rangeLabel(slides) {
  if (!slides) return 'all slides';
  const [a, b] = String(slides).split('-');
  return b ? `slides ${a}–${b}` : `slide ${a}`;
}

/**
 * The ranges worth one keystroke from where you are: the whole deck, this slide,
 * the chapter you are in (a multi-module deck's `data-module` markers), from here to
 * the end, and up to here. A choice that comes out the same as an earlier one is
 * dropped — on slide 1, "from here to the end" IS the whole deck.
 */
export function rangeChoices({ slide, total, chapters = [] }) {
  const out = [];
  const add = (label, from, to) => {
    const slides = rangeArg({ from, to }, total);
    if (!out.some((c) => c.slides === slides)) out.push({ label, slides });
  };
  add(`All slides — 1–${total}`, 1, total);
  add(`This slide — ${slide}`, slide, slide);
  const at = chapters.filter((c) => c.slide <= slide).at(-1);
  if (at) {
    const next = chapters.find((c) => c.slide > at.slide);
    const end = next ? next.slide - 1 : total;
    add(`This chapter — ${at.title} (${at.slide}–${end})`, at.slide, end);
  }
  if (slide < total) add(`From here to the end — ${slide}–${total}`, slide, total);
  if (slide > 1) add(`Up to here — 1–${slide}`, 1, slide);
  return out;
}

/**
 * The picker: the choices above as rows, and a last row with a box for any
 * other range. Built on the narration panel's card, because it opens from
 * inside that panel as often as from the palette and should look like it
 * belongs there.
 *
 * `source`, when given, is a second question asked on the same card — which
 * voice a video carries — as a row at the top that ← and → (or a click) turn
 * through. It is not a step of its own: the answer is usually already right,
 * and a card you have to page past to reach the slides is a card in the way.
 *
 * Register it BEFORE the narration panel: overlays that overlap give the
 * keyboard to the one registered first, and this one opens on top.
 */
export function createRangePicker({ root, overlays }) {
  let el = null, rows = [], rowEls = [], sel = 0, input = null, note = null, want = null, src = null;

  function close() { el?.remove(); el = null; want = null; src = null; }

  function paintSource() {
    const i = rows.findIndex((r) => r.source);
    if (i < 0) return;
    rowEls[i].querySelector('.narr-row-label').firstChild.textContent = src.options[src.index].label;
  }
  function turnSource(by) {
    if (!src || src.options.length < 2) return;
    src.index = (src.index + by + src.options.length) % src.options.length;
    paintSource();
  }

  // Not the `hidden` attribute: .rec-line sets a display of its own, and an
  // author rule beats the attribute's.
  function say(text) {
    note.textContent = text;
    note.style.display = text ? '' : 'none';
  }

  function select(i, { focusBox = true } = {}) {
    sel = selectInList(rowEls, i, 'narr-sel');
    if (rows[sel].custom && focusBox) input.focus();
    else if (!rows[sel].custom && document.activeElement === input) input.blur();
  }

  function pick(i = sel) {
    const row = rows[i];
    if (!row || !want) return;
    if (row.source) { turnSource(1); return; }
    let slides = row.slides;
    if (row.custom) {
      const typed = input.value.trim();
      const r = parseRange(typed, want.total);
      // A range that is not one stays in the box with the reason under it —
      // closing on it would throw away what was typed to say it was wrong.
      if (!r) {
        say(typed ? `${typed} is not a range of this deck — 1 to ${want.total}, like 2-5` : 'type a range first, like 2-5');
        input.focus();
        return;
      }
      slides = rangeArg(r, want.total);
    }
    const { onPick } = want;
    const voice = src ? src.options[src.index].value : undefined;
    close();
    onPick(slides, voice);
  }

  function open({ title, lines = [], total, slide, chapters = [], current = null, source = null, onPick }) {
    if (el) close();
    want = { total, onPick };
    src = source?.options?.length ? { options: source.options, index: Math.max(0, source.index ?? 0) } : null;
    rows = [...(src ? [{ source: true }] : []), ...rangeChoices({ slide, total, chapters }), { label: 'Slides…', custom: true }];
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-range';
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
    const known = rows.some((c) => !c.custom && !c.source && c.slides === current);
    rowEls = rows.map((row, i) => {
      const r = document.createElement('div');
      r.className = 'narr-row' + (row.custom ? ' range-custom' : '') + (row.source ? ' range-source' : '')
        + ((row.source ? false : row.custom ? current && !known : row.slides === current) ? ' narr-cur' : '');
      const label = document.createElement('span');
      label.className = 'narr-row-label';
      label.textContent = row.source ? src.options[src.index].label : row.label;
      if (row.source && src.options.length > 1) {
        const how = document.createElement('span');
        how.className = 'narr-flavor';
        how.textContent = '← → change the voice';
        label.append(how);
      }
      r.append(label);
      if (row.custom) {
        input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.spellcheck = false;
        input.placeholder = `like 2-${Math.min(total, 5)}`;
        input.setAttribute('aria-label', 'slide range');
        if (current && !known) input.value = current;
        input.addEventListener('focus', () => { if (sel !== i) select(i, { focusBox: false }); });
        // The deck's keyboard stops at a text box (engine.js returns early for
        // one), so the box answers the keys that would otherwise go nowhere.
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); pick(i); }
          else if (e.key === 'Escape') { e.preventDefault(); close(); }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            select(sel + (e.key === 'ArrowDown' ? 1 : -1));
          } else say('');
        });
        r.append(input);
      }
      r.addEventListener('mouseenter', () => { if (document.activeElement !== input) select(i, { focusBox: false }); });
      r.addEventListener('click', (e) => {
        if (row.custom) { if (e.target !== input) select(i); return; }
        select(i, { focusBox: false });
        pick(i);
      });
      card.append(r);
      return r;
    });
    note = document.createElement('div');
    note.className = 'rec-line rec-warn';
    say('');
    card.append(note);
    const hint = document.createElement('div');
    hint.className = 'rec-hint';
    hint.textContent = '↑↓ choose · Enter picks · type a range, like 2-5 · Esc closes';
    card.append(hint);
    el.append(card);
    closeOnBackdrop(el, close);
    root.appendChild(el);
    const at = rows.findIndex((c) => !c.custom && !c.source && c.slides === current);
    select(at >= 0 ? at : current ? rows.length - 1 : 0, { focusBox: false });
  }

  overlays.register({
    isOpen: () => !!el,
    close,
    keydown(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        select(sel + (e.key === 'ArrowDown' ? 1 : -1), { focusBox: false });
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') turnSource(e.key === 'ArrowRight' ? 1 : -1);
      else if (e.key === 'Enter') pick();
      else if (e.key === 'Escape') close();
      // A digit starts a range: it lands in the box, and the box has the
      // keyboard from there. Consumed, so the browser does not type it twice.
      else if (/^[0-9-]$/.test(e.key)) {
        select(rows.length - 1, { focusBox: false });
        input.value += e.key;
        input.focus();
        say('');
      }
      return true;
    },
  });

  return { open, close, isOpen: () => !!el };
}
