// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Slide density: SPEC SLIDE_DENSITY, measured.
 *
 * The overflow guardrail is the LATE failure: it fires once content is already
 * clipped. A slide that fits and is still too crowded to present from renders
 * like every other slide, so nothing caught it and the contract said so ("a rule
 * rather than a check"). This is the check: the same budgets SLIDE_DENSITY
 * states, counted per column, with one grace step past the "~", because a rule
 * of thumb that warns on the fifth bullet is a rule people learn to ignore.
 *
 * One measurement, three readers. The runtime marks a crowded slide
 * `data-dense="<why>"` as it lays the deck out, the way it marks
 * `data-overflow`, so `decklight check` reads it off the rendered print view
 * (a headless probe needs no second implementation to disagree with this
 * one), the deck's own Check deck… panel lists it, and the Inspector's Info
 * tab says it for the slide on screen.
 *
 * Counted, not measured: no layout is read, so it costs nothing on a slide
 * that is not on screen and gives the same answer in every viewport.
 */

/** The budgets, per column. Exported for the tests and the SPEC to agree on. */
export const DENSITY = Object.freeze({
  bullets: 5,          // ~3–4 bullets per column, one of grace: the sixth warns
  paragraphs: 2,       // ~2 short paragraphs per column: the third warns
  paragraphWords: 50,  // past this a paragraph is not short
  words: 80,           // the whole column's prose, headings aside
});

/**
 * What is not prose to read off the slide: the speaker's notes, code (its own
 * scroller and its own reading), diagrams, charts, terminal casts, tables (a
 * grid is scanned, not read), media chrome, and the headings themselves. A
 * subtitle is NOT among them: the engine makes the first paragraph under a
 * title one (.subtitle), and a 60-word subtitle is a paragraph to read like
 * any other. It is only left out of the paragraph COUNT (measureColumn).
 */
const NOT_PROSE = 'aside, script, style, template, pre, svg, canvas, .chart, .terminal, table, '
  + '.slide-bg, .decklight-hero-logo, h1, h2, h3, h4, h5, h6, .pin-title';

const words = (text) => (String(text ?? '').match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? []).length;
const outsideProse = (el, top) => {
  for (let n = el; n && n !== top; n = n.parentElement) if (n.matches?.(NOT_PROSE)) return true;
  return false;
};

/** The words in `el` a reader reads, headings and NOT_PROSE aside. */
function proseWords(el) {
  let n = 0;
  const walk = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    if (!outsideProse(t.parentElement, el.parentElement)) n += words(t.data);
  }
  return n;
}

/** One column's counts: bullets (nested ones too), paragraphs, words. */
function measureColumn(col, halves = 1) {
  const all = (sel) => [...(col.matches(sel) ? [col] : []), ...col.querySelectorAll(sel)]
    .filter((el) => !outsideProse(el, col.parentElement));
  const bullets = Math.ceil(all('li').length / halves);
  const paras = all('p').filter((p) => !p.closest('li'));
  return {
    bullets,
    // the subtitle is the title's second line, not one of the slide's paragraphs
    paragraphs: paras.filter((p) => !p.matches('.subtitle, .pin-subtitle')).length,
    longest: paras.reduce((m, p) => Math.max(m, words(p.textContent)), 0),
    words: Math.ceil(proseWords(col) / halves),
  };
}

/**
 * The columns a slide reads as. A split slide (COMPARISON_SLIDES) is its two
 * sides, and a footer is not a third; a split that is one list in two CSS
 * columns is that list, halved. Anything else is one column: the slide.
 */
function columnsOf(sec) {
  const layout = sec.getAttribute('data-layout') || '';
  if (/^split/.test(layout) && !sec.hasAttribute('data-template')) {
    const list = sec.querySelector(':scope > .split-columns');
    if (list) return [{ el: list, halves: 2 }];
    const sides = [...sec.children].filter((el) => !el.matches('h1, h2, .subtitle, aside, script, style, '
      + '.decklight-hero-logo, .slide-bg, .split-footer, .pin-title, .pin-subtitle'));
    if (sides.length >= 2) return sides.slice(0, 2).map((el) => ({ el, halves: 1 }));
  }
  return [{ el: sec, halves: 1 }];
}

/** `0.85em`, `85%`: a section shrunk below the deck's type. Null when it is not. */
function shrunk(sec) {
  const fs = (sec.style?.fontSize || '').trim();
  const m = /^(\d*\.?\d+)(em|%)$/.exec(fs);
  if (!m) return null;
  const ratio = Number(m[1]) / (m[2] === '%' ? 100 : 1);
  return ratio < 1 ? fs : null;
}

/**
 * Why `sec` is crowded, as short phrases (`7 bullets`, `3 paragraphs`, `a
 * 64-word paragraph`, `110 words`, `type shrunk to 0.85em`), or [] when it
 * is not. `data-dense-ok` on the section opts it out, like `data-scroll-ok`
 * does for the overflow guardrail: a dense reference slide can be meant.
 */
export function slideDensity(sec) {
  if (!sec || sec.hasAttribute('data-dense-ok')) return [];
  const cols = columnsOf(sec);
  const where = cols.length > 1 ? ' in one column' : '';
  const why = [];
  const worst = (key) => Math.max(...cols.map((c) => c.m[key]));
  for (const c of cols) c.m = measureColumn(c.el, c.halves);
  const b = worst('bullets');
  if (b > DENSITY.bullets) why.push(`${b} bullets${where}`);
  const p = worst('paragraphs');
  if (p > DENSITY.paragraphs) why.push(`${p} paragraphs${where}`);
  const l = worst('longest');
  if (l > DENSITY.paragraphWords) why.push(`a ${l}-word paragraph`);
  const w = worst('words');
  if (w > DENSITY.words) why.push(`${w} words${where}`);
  const s = shrunk(sec);
  if (s) why.push(`type shrunk to ${s}`);
  return why;
}

/** Mark each crowded section `data-dense="<why, joined>"`; clear the rest. */
export function markDensity(sections) {
  for (const sec of sections) {
    const why = slideDensity(sec);
    if (why.length) sec.setAttribute('data-dense', why.join(' · '));
    else sec.removeAttribute('data-dense');
  }
}
