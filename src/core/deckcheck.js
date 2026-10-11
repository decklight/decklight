// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Check deck… (palette): what is wrong with this deck, slide by slide, without
 * leaving it. SPEC PRESENTING.
 *
 * `decklight check` answers that in a terminal, for an agent or a CI job. An
 * author presenting or editing has the deck open and no terminal in front of
 * them, and the deck already knows most of the answers: it lays every slide
 * out, it counts builds and ⟨CLICK⟩ markers, its images either loaded or did
 * not. So this asks the open deck the questions the render half of the CLI
 * asks a headless one, plus the ones only a live page can answer:
 *
 *   overflow          content clipped (measured now, every slide)
 *   dense             crowded past SLIDE_DENSITY (density.js, the same count)
 *   split-conflict    data-layout="split" fighting a flex shell
 *   clicks-vs-builds  ⟨CLICK⟩ markers that do not match the build steps
 *   missing-media     an image or a video that did not load
 *   markdown-slide    a data-markdown slide, which comes up empty
 *
 * What a file can say and a page cannot (an unaccounted script, an asset the
 * page never asked for) stays `decklight check`'s, and the panel says so in
 * its last line rather than pretending to be the whole lint.
 *
 * Each finding is a row; ⏎ or a click goes to that slide and closes the panel.
 * `check()` is exposed on the instance so a headless probe reads the same list.
 */

import { closeOnBackdrop, selectInList, typeaheadKeydown } from './overlay.js';
import { slideDensity } from './density.js';
import { notesSegments } from './speaker.js';

/** One finding, shaped like the CLI's (`--json`), so the two read alike. */
const finding = (level, rule, slide, title, message) => ({ level, rule, slide, title, message });

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function createDeckCheck({ root, overlays, instance, goto, measureOverflow, slideTitle, suggestions = () => [], accept = () => null }) {
  let el = null, sel = 0, rows = [];

  /** Every finding the open deck can answer for, slide order, errors first within a slide. */
  function check() {
    const inst = instance();
    const sections = inst?._sections ?? [];
    const out = [];
    sections.forEach((sec, i) => {
      const n = i + 1;
      const title = slideTitle(sec, i);
      const add = (level, rule, message) => out.push(finding(level, rule, n, title, message));
      if (sec.hasAttribute('data-markdown-removed')) {
        add('error', 'markdown-slide', 'a markdown slide, which comes up empty: data-markdown was removed in 0.3.0');
      }
      if (measureOverflow(sec, n)) add('error', 'overflow', 'content is clipped: the audience never sees the rest');
      for (const m of sec.querySelectorAll('img')) {
        if (m.getAttribute('src') && m.complete && m.naturalWidth === 0) {
          add('error', 'missing-media', `an image did not load: ${m.getAttribute('src')}`);
        }
      }
      for (const v of sec.querySelectorAll('video, audio')) {
        if (v.error) add('error', 'missing-media', `a ${v.tagName.toLowerCase()} did not load: ${v.currentSrc || v.getAttribute('src') || 'its source'}`);
      }
      const dense = slideDensity(sec);
      if (dense.length) add('warn', 'dense', `crowded: ${dense.join(', ')}. Split it rather than shrink it`);
      if (sec.hasAttribute('data-split-conflict')) {
        add('warn', 'split-conflict', 'data-layout="split" is fighting its own column flexbox: drop one');
      }
      const notes = sec.querySelector(':scope > aside.notes');
      const clicks = notes ? notesSegments(notes.innerHTML).length - 1 : 0;
      const steps = inst._records?.[i]?.groups.length ?? 0;
      if (clicks > 0 && clicks !== steps) {
        add('warn', 'clicks-vs-builds', `${plural(clicks, '⟨CLICK⟩', '⟨CLICK⟩s')} in the notes for ${plural(steps, 'build step')}: narration and builds drift apart`);
      }
    });
    // labels that recur in different colours (SVG_DIAGRAMS): a hint, not a
    // fault, listed on the first slide that has one; ⏎ makes it the concept
    for (const s of suggestions()) {
      const sec = sections[s.slides[0] - 1];
      out.push({
        ...finding('hint', 'concept-suggestion', s.slides[0], sec ? slideTitle(sec, s.slides[0] - 1) : '',
          `“${s.label}” is on ${s.slides.length === 1 ? `slide ${s.slides[0]}` : `slides ${s.slides.slice(0, -1).join(', ')} and ${s.slides.at(-1)}`} in ${s.colours} colours: make it the “${s.name}” concept`),
        suggestion: s,
      });
    }
    const rank = { error: 0, warn: 1, hint: 2 };
    return out.map((f, i) => [f, i])
      .sort((a, b) => a[0].slide - b[0].slide || rank[a[0].level] - rank[b[0].level] || a[1] - b[1])
      .map(([f]) => f);
  }

  function open() {
    if (el) return close();
    overlays.opening();
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-deckcheck';
    el.innerHTML = '<div class="narr-card" role="listbox" aria-label="Check deck"></div>';
    closeOnBackdrop(el, close);
    root.appendChild(el);
    paint();
  }

  function paint() {
    const card = el.querySelector('.narr-card');
    card.replaceChildren();
    const found = check();
    const slides = instance()?._sections?.length ?? 0;
    const errors = found.filter((f) => f.level === 'error').length;
    const issues = found.filter((f) => f.level !== 'hint');
    const hints = found.length - issues.length;
    const head = document.createElement('div');
    head.className = 'narr-head';
    head.textContent = (issues.length
      ? `check · ${plural(issues.length, 'issue')} on ${plural(new Set(issues.map((f) => f.slide)).size, 'slide')}`
        + (errors ? ` · ${plural(errors, 'error')}` : '')
      : 'check') + (hints ? ` · ${plural(hints, 'suggestion')}` : '');
    card.appendChild(head);
    rows = found;
    if (!issues.length) {
      const ok = document.createElement('div');
      ok.className = 'narr-row narr-fact dc-clean';
      ok.textContent = `no issues: ${plural(slides, 'slide')} checked`;
      card.appendChild(ok);
    }
    found.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = `narr-row dc-row dc-${f.level}`;
      row.dataset.rule = f.rule;
      const mark = document.createElement('span');
      mark.className = 'dc-mark';
      mark.textContent = f.level === 'error' ? '✗' : f.level === 'hint' ? '+' : '!';
      const where = document.createElement('span');
      where.className = 'dc-where';
      where.textContent = `${f.slide}`;
      where.title = f.title;
      const text = document.createElement('span');
      text.className = 'dc-text';
      const name = document.createElement('span');
      name.className = 'dc-title';
      name.textContent = f.title;
      const msg = document.createElement('span');
      msg.className = 'dc-msg';
      msg.textContent = f.message + (f.suggestion && accept() ? ' · ⏎ makes it' : '');
      text.append(name, msg);
      row.append(mark, where, text);
      row.addEventListener('mouseenter', () => select(i));
      row.addEventListener('click', () => run(i));
      card.appendChild(row);
    });
    // what the open deck cannot see: the file's own half
    const foot = document.createElement('div');
    foot.className = 'narr-foot dc-foot';
    foot.textContent = '⏎ goes to the slide · decklight check <deck> also reads the file: missing files, scripts';
    card.appendChild(foot);
    if (found.length) select(0);
  }

  function select(i) {
    const list = el.querySelectorAll('.dc-row');
    if (list.length) sel = selectInList(list, i, 'narr-sel');
  }
  function run(i) {
    const f = rows[i];
    close();
    if (!f) return;
    goto(f.slide);
    const take = f.suggestion && accept();
    if (take) take(f.suggestion);
  }
  function close() {
    el?.remove();
    el = null;
  }

  overlays.register({
    isOpen: () => !!el,
    close,
    transient: true,
    keydown: (e) => typeaheadKeydown(e, {
      onMove: (d) => select(sel + d),
      onCommit: () => run(sel),
      onClose: close,
    }),
  });

  return { open, close, check, isOpen: () => !!el };
}
