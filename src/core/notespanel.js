// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * S — this slide's speaker notes, beside the slide (SPEC PRESENTING).
 *
 * The notes, read-only, in a panel that docks like the sources and comments
 * panels (dock.js): docked right by default, so the slide reflows beside it and
 * the deck stays navigable, and the panel follows along — the slide it is on,
 * and the beat: the `[click]` segment the deck is at is lit, the ones already
 * said dimmed, the way the speaker view lights them. A `[pause]` shows as a
 * cue and an audio tag as a cue of its own, exactly as there — it is the
 * speaker view's own reader (`notesSegments`, speaker.js), so the two can never
 * disagree about where a beat is.
 *
 * It is the notes for a presenter with ONE screen, which is most of them; the
 * speaker view — a second window, timers and thumbnails — moved to ⌥⏎, the
 * key PowerPoint gives its presenter view. Editing stays where it was (the
 * notes editor): when authoring, ✎ opens it for this slide.
 */

import { createDock } from './dock.js';
import { notesSegments } from './speaker.js';

export function createNotesPanel({ root, overlays, getInstance, reflow, editmode, openEditor }) {
  let el = null;
  let onResize = null;
  const dock = createDock({
    root,
    reflow: () => reflow?.(),
    key: 'decklight-notes-panel-dock:' + location.pathname,
    getEl: () => el,
    closeLabel: 'close (S)',
    defaultMode: 'right',
  });

  const isOpen = () => !!el;
  function close() {
    el?.remove();
    el = null;
    if (onResize) { window.removeEventListener('resize', onResize); onResize = null; }
    dock.release();
  }

  // Splitting on [click] can cut through a paragraph, leaving a fragment with
  // an open tag that would swallow what follows — re-serialized, every
  // segment is balanced markup (the speaker view does the same).
  const balanced = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.innerHTML; };

  function render() {
    if (!el) return;
    const instance = getInstance();
    const { slide, step, totalSlides } = instance.state;
    const aside = instance._sections?.[slide - 1]?.querySelector('aside.notes');
    const segs = notesSegments(aside ? aside.innerHTML : '');
    const card = el.querySelector('.narr-card');
    card.textContent = '';
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.append(Object.assign(document.createElement('span'), {
      className: 'np-heading', textContent: `notes — slide ${slide} / ${totalSlides}`,
    }));
    head.append(dock.controls(close));
    dock.wireHeader(head);
    card.append(head);

    const body = document.createElement('div');
    body.className = 'np-body';
    const said = segs.some((s) => s.replace(/<[^>]*>/g, '').trim());
    if (!said) {
      body.classList.add('np-none');
      body.textContent = 'no speaker notes on this slide';
    } else {
      // The deck's own notes markup, as the speaker view shows it — the deck's
      // content, not somebody else's (a presented deck is already under CSP).
      body.innerHTML = segs.map((s, i) => {
        const cls = i < step ? 'said' : i === step ? 'now' : '';
        return `<div class="np-seg ${cls}">${balanced(s)}</div>${i < segs.length - 1 ? '<div class="np-click">click</div>' : ''}`;
      }).join('');
    }
    card.append(body);

    if (editmode?.()?.available()) {
      const actions = document.createElement('div');
      actions.className = 'tr-actions';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'narr-prev-btn';
      edit.textContent = '✎ edit these notes';
      edit.addEventListener('click', () => { close(); openEditor?.(); });
      actions.append(edit);
      card.append(actions);
    }
    // keep the beat being spoken in view as the builds land
    body.querySelector('.np-seg.now')?.scrollIntoView?.({ block: 'nearest' });
  }

  function open() {
    if (el) return;
    overlays.opening();
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-dockable decklight-notes-panel';
    el.innerHTML = '<div class="narr-card"></div>';
    root.appendChild(el);
    dock.reserveGutter();
    onResize = () => dock.reserveGutter();
    window.addEventListener('resize', onResize);
    render();
  }
  const toggle = () => (el ? close() : open());

  // Never modal: the notes are read beside a talk that keeps moving. Esc
  // closes; every other key goes on to the deck (→ advances, and the panel
  // follows).
  function keydown(e) {
    if (e.key === 'Escape') { close(); return true; }
    return false;
  }
  overlays.register({ isOpen, close, keydown, modal: () => false });

  return { open, close, toggle, isOpen, onNavigate: render };
}
