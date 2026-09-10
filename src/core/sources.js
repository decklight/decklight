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
 * It is hidden on the slide and reachable with `I`, which is the whole
 * difference from notes: notes are for the person talking, and where to read
 * more is for the person listening. It travels in the section, so it survives
 * bundling, publishing, and being taken into somebody else's deck.
 */

import { closeOnBackdrop, selectInList } from './overlay.js';

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

export function createSources({ root, overlays, sectionAt, slideOf, toast, dismissOthers }) {
  let el = null;
  let sel = 0;

  const isOpen = () => !!el;
  const close = () => { el?.remove(); el = null; sel = 0; };

  const read = () => sourcesOf(sectionAt(slideOf()));

  function render() {
    const data = read();
    if (!data) return;
    const at = slideOf();
    if (!el) {
      el = document.createElement('div');
      el.className = 'decklight-narr decklight-sources';
      el.innerHTML = '<div class="narr-card"></div>';
      root.appendChild(el);
      closeOnBackdrop(el, close);
    }
    const card = el.querySelector('.narr-card');
    card.textContent = '';

    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = `sources — slide ${at}`;
    card.append(head);

    if (data.facts.length) {
      const dl = document.createElement('dl');
      dl.className = 'src-facts';
      for (const [k, v] of data.facts) {
        dl.append(Object.assign(document.createElement('dt'), { textContent: k }));
        dl.append(Object.assign(document.createElement('dd'), { textContent: v }));
      }
      card.append(dl);
    }

    data.links.forEach((link, i) => {
      // an <a>, not a div with a click handler: a link people may want to open
      // in a new tab, copy, or middle-click is a link
      const row = document.createElement('a');
      row.className = 'narr-row' + (i === sel ? ' narr-sel' : '');
      row.href = link.href;
      row.target = '_blank';
      row.rel = 'noopener noreferrer';
      const label = document.createElement('span');
      label.className = 'narr-row-label';
      label.textContent = link.title;
      row.append(label);
      if (link.note) row.append(Object.assign(document.createElement('span'), {
        className: 'narr-tag', textContent: link.note,
      }));
      row.append(Object.assign(document.createElement('span'), { className: 'src-go', textContent: '↗' }));
      card.append(row);
    });

    if (data.links.length) {
      const foot = document.createElement('div');
      foot.className = 'narr-head';
      foot.textContent = '⏎ opens it in a new tab · esc closes';
      card.append(foot);
      selectInList([...card.querySelectorAll('.narr-row')], sel, 'narr-sel');
    }
  }

  function open() {
    const data = read();
    if (!data) {
      toast(`slide ${slideOf()} does not say where it got that`, 2600);
      return;
    }
    dismissOthers?.();
    sel = 0;
    render();
  }

  function keydown(e) {
    const data = read();
    const n = data?.links.length ?? 0;
    if (e.key === 'Escape') { close(); return true; }
    if (n) {
      if (e.key === 'ArrowDown') { sel = (sel + 1) % n; render(); return true; }
      if (e.key === 'ArrowUp') { sel = (sel - 1 + n) % n; render(); return true; }
      if (e.key === 'Enter') {
        const link = data.links[sel];
        if (link) window.open(link.href, '_blank', 'noopener,noreferrer');
        return true;
      }
    }
    // every other key closes rather than falling through to the deck: an
    // overlay that swallows → while a talk is running is worse than one that
    // gets out of the way
    close();
    return false;
  }

  overlays.register({ isOpen, close, keydown });
  return { open, close, isOpen, has: () => !!read() };
}
