// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Print variants (SPEC §8): ?print=handout groups slides into 3-up portrait
// pages with ruled note-taking lines; ?print=notes gives one page per slide
// with its speaker notes rendered underneath. Plain ?print keeps the flat
// slide-per-page flow and never reaches this module.
//
// The restructure must run AFTER sync() and applyBuildState: sync() selects
// `:scope > section` and would find nothing once the sections are wrapped.
// Print is static (no navigation, no key handler), so it never runs again.
//
// Each slide keeps its 1280×720 design box and transform-scales into a fixed
// slot. The slot carries the `decklight-stage` class so every
// `.decklight-stage > section` rule — pins, splits, layouts, builds — still
// matches the wrapped section; the plain-print stage overrides are scoped to
// the OUTER stage (`.decklight-print > .decklight-stage`) so they skip these.

export const HANDOUT_PER_PAGE = 3;

// Pure pagination: n slides at `per` a page → pages of slide indices,
// ceil(n/per) of them, in order.
export function groupPages(n, per) {
  const pages = [];
  for (let start = 0; start < n; start += per) {
    const page = [];
    for (let i = start; i < n && i < start + per; i++) page.push(i);
    pages.push(page);
  }
  return pages;
}

export function buildPrintPages(stage, sections, variant) {
  const doc = stage.ownerDocument;
  const el = (cls) => {
    const d = doc.createElement('div');
    d.className = cls;
    return d;
  };
  // The slide's fixed 1280×720 mini-stage, scaled by CSS into the slot.
  const slot = (section) => {
    const outer = el('print-slot');
    const inner = el('decklight-stage print-slide');
    inner.appendChild(section);
    outer.appendChild(inner);
    return outer;
  };

  if (variant === 'handout') {
    for (const idxs of groupPages(sections.length, HANDOUT_PER_PAGE)) {
      const page = el('print-page print-handout');
      for (const i of idxs) {
        const row = el('print-row');
        row.appendChild(slot(sections[i]));
        row.appendChild(el('print-notelines'));
        page.appendChild(row);
      }
      stage.appendChild(page);
    }
  } else {
    sections.forEach((section) => {
      const page = el('print-page print-notes-page');
      const notes = el('print-notes');
      // Copy, don't move: the aside stays in the slide (display: none) so
      // anything that reads notes off the section keeps working.
      const aside = section.querySelector('aside.notes');
      if (aside) notes.innerHTML = aside.innerHTML;
      page.appendChild(slot(section));
      page.appendChild(notes);
      stage.appendChild(page);
    });
  }

  // Variant pages are portrait; @page cannot be scoped by selector, so the
  // override over plain print's landscape sheet is injected only here.
  const style = doc.createElement('style');
  style.textContent =
    '@media print { @page { size: 816px 1056px; margin: 0; } html, body { margin: 0; padding: 0; } }';
  doc.head.appendChild(style);
}
