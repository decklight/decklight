// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * What a slide is standing on (`SLIDE_SOURCES`).
 *
 * A deck makes claims. Where they came from — the KIP, the paper, the internal
 * doc — and the facts about the slide itself — who owns it, when it was last
 * checked — are worth keeping WITH the slide, and there was nowhere to keep
 * them. Speaker notes are what you SAY, and reviewer comments are what somebody
 * thinks for now: a comment is answered and resolved, a source is true until
 * the source changes.
 *
 * So `<aside class="sources">`, a sibling of the notes aside, holding two
 * ordinary things: a `<dl>` of named facts and a `<ul>` of links. Ordinary,
 * because an agent has to be able to write it and a human has to be able to
 * read it in the file — and because a `<dl>` and a `<ul>` already mean exactly
 * this in HTML, so nothing here invents a syntax to be learned or a parser to
 * go wrong.
 *
 * It is hidden on the slide and READ in the inspector (`I`, inspector.js),
 * which is the whole difference from notes: notes are for the person talking,
 * and where to read more is for the person listening. It travels in the
 * section, so it survives bundling, publishing, and being taken into somebody
 * else's deck. This file keeps the reading of the aside and the editor that
 * writes it back; the inspector's `e` opens the editor.
 */

import { createDock } from './dock.js';

/** The facts and links a section carries, or null when it carries none. */
export function sourcesOf(section) {
  const aside = section?.querySelector?.(':scope > aside.sources');
  if (!aside) return null;
  const facts = [];
  const terms = [...aside.querySelectorAll('dt')];
  for (const dt of terms) {
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === 'DD') facts.push([dt.textContent.trim(), dd.textContent.trim()]);
  }
  const links = [...aside.querySelectorAll('a[href]')].map((a) => {
    // the note is whatever the author wrote after the link inside its own item
    const li = a.closest('li');
    const whole = (li ?? a).textContent.replace(/\s+/g, ' ').trim();
    const title = a.textContent.replace(/\s+/g, ' ').trim();
    return { href: a.getAttribute('href'), title, note: whole.slice(title.length).replace(/^[\s—–-]+/, '') };
  });
  return facts.length || links.length ? { facts, links } : null;
}

export function createSources({ root, overlays, reflow, sectionAt, slideOf, editmode, toast }) {
  // Beside the slide, not over it — the review panel's placement, shared
  // (dock.js). Its own placement, apart from the inspector's: the editor is
  // opened from it, and wants room for a URL.
  const dock = createDock({
    root,
    reflow: () => reflow?.(),
    key: 'decklight-sources-dock:' + location.pathname,
    getEl: () => el,
    closeLabel: 'close (esc)',
  });
  let el = null;
  // The editor is a DRAFT, not the slide: nothing is written until ⏎, so
  // wandering into it and pressing esc leaves the deck exactly as it was.
  let draft = null;
  let busy = false;
  let onResize = null;
  const editing = () => !!draft;
  const canEdit = () => editmode?.()?.available() === true;

  const isOpen = () => !!el;
  const close = () => {
    el?.remove();
    el = null;
    draft = null;
    if (onResize) { window.removeEventListener('resize', onResize); onResize = null; }
    dock.release();   // or the stage keeps reflowing around a gutter nothing sits in
  };

  const read = () => sourcesOf(sectionAt(slideOf()));

  function renderShell() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-dockable decklight-sources';
    el.innerHTML = '<div class="narr-card"></div>';
    root.appendChild(el);
    dock.reserveGutter();
    onResize = () => dock.reserveGutter();
    window.addEventListener('resize', onResize);
  }

  /** The card's header: a title, the placement buttons, and a drag handle. */
  function header(text) {
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.append(Object.assign(document.createElement('span'), {
      className: 'src-heading', textContent: text,
    }));
    head.append(dock.controls(close));
    dock.wireHeader(head);
    return head;
  }

  // ----- the editor ----------------------------------------------------------

  const field = (value, placeholder, onInput, wide = false) => {
    const input = document.createElement('input');
    input.className = 'narr-input src-field' + (wide ? ' src-wide' : '');
    input.value = value ?? '';
    input.placeholder = placeholder;
    input.addEventListener('input', () => onInput(input.value));
    return input;
  };

  const dropper = (onClick) => {
    const b = document.createElement('button');
    b.className = 'src-drop';
    b.type = 'button';
    b.title = 'remove';
    b.textContent = '✕';
    b.addEventListener('click', onClick);
    return b;
  };

  function renderEdit() {
    const card = el.querySelector('.narr-card');
    card.textContent = '';
    card.append(header(`sources — slide ${slideOf()}`));

    const group = (text) => {
      const g = document.createElement('div');
      g.className = 'narr-group';
      g.textContent = text;
      card.append(g);
    };

    group('named facts');
    draft.facts.forEach((pair, i) => {
      const row = document.createElement('div');
      row.className = 'src-edit-row';
      row.append(field(pair[0], 'name', (v) => { pair[0] = v; }));
      row.append(field(pair[1], 'value', (v) => { pair[1] = v; }));
      row.append(dropper(() => { draft.facts.splice(i, 1); renderEdit(); }));
      card.append(row);
    });
    card.append(adder('+ a fact', () => { draft.facts.push(['', '']); renderEdit(); }));

    group('links');
    draft.links.forEach((link, i) => {
      const row = document.createElement('div');
      row.className = 'src-edit-row';
      row.append(field(link.title, 'what it is', (v) => { link.title = v; }));
      // the URL is the longest thing in the row, so it gets the room
      row.append(field(link.href, 'https://…', (v) => { link.href = v; }, true));
      row.append(field(link.note, 'a few words (optional)', (v) => { link.note = v; }));
      row.append(dropper(() => { draft.links.splice(i, 1); renderEdit(); }));
      card.append(row);
    });
    card.append(adder('+ a link', () => { draft.links.push({ title: '', href: '', note: '' }); renderEdit(); }));

    const foot = document.createElement('div');
    foot.className = 'narr-head';
    foot.textContent = '⏎ saves · esc leaves it as it was';
    card.append(foot);
    // the first empty field, so adding a row puts the caret in it
    card.querySelector('.src-field[value=""], .src-field:placeholder-shown')?.focus();
  }

  function adder(text, onClick) {
    const b = document.createElement('button');
    b.className = 'narr-row src-add';
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function startEditing() {
    if (!canEdit()) { toast('sources are written in write mode — decklight <deck.html>'); return; }
    const data = read() ?? { facts: [], links: [] };
    draft = {
      facts: data.facts.map(([k, v]) => [k, v]),
      links: data.links.map((l) => ({ ...l })),
    };
    if (!draft.facts.length && !draft.links.length) draft.links.push({ title: '', href: '', note: '' });
    if (!el) { renderShell(); }
    renderEdit();
  }

  async function save() {
    if (busy) return;
    busy = true;
    const at = slideOf();
    try {
      const r = await fetch(editmode().base() + '/deck/edit/slide/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slide: at, facts: draft.facts, links: draft.links }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `the edit server said ${r.status}`);
      close();
      const refused = j.dropped?.length
        ? `. ${j.dropped.join(', ')} was not written — a reference is a link somebody can follow, not something that runs`
        : '';
      toast((j.changed ? `sources saved on slide ${at} — Z takes it back` : 'nothing changed') + refused,
        refused ? 6000 : 3000);
    } catch (e) {
      toast(`could not save — ${e.message}`);
    } finally {
      busy = false;
    }
  }

  function open() {
    overlays.opening();
    startEditing();
  }

  function keydown(e) {
    // The card owns the keyboard while it is up: `modal` below stops the deck
    // acting on the letters being typed, and everything but ⏎ and esc is
    // returned UNHANDLED so the input that has focus receives it.
    if (e.key === 'Escape') { close(); return true; }
    if (e.key === 'Enter') { save(); return true; }
    return false;
  }

  // Modal: a letter typed into a field must not also reach the deck.
  overlays.register({ isOpen, close, keydown, modal: () => editing() });
  return { edit: open, close, isOpen, has: () => !!read(), canEdit };
}
