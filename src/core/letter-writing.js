// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// LETTER_BY_LETTER: the visual characters have no text nodes. The original
// sentence is the only text the accessible tree, finder or an editor reads.
import { cssDurationMs } from './motion.js';

const TARGET = '[data-write], [data-ds-injected][data-slot][data-write] > *';
const SLOT = '[data-ds-injected][data-slot][data-write]';
const SOURCE = ':scope > .dl-write-source';
const EXCLUDE = 'aside, svg, pre, code, script, style, textarea, select, [contenteditable]:not([contenteditable="false"]), .dl-unsaved';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const unspaced = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

function mode(el) {
  return el.getAttribute('data-write') ?? (el.parentElement?.matches(SLOT) ? el.parentElement.getAttribute('data-write') : null);
}

export function writesPlainText(el) {
  const setting = mode(el);
  return setting !== null && setting !== 'off' && (!el.children.length || !!el.querySelector(SOURCE));
}

function targets(section) {
  if (section.getAttribute('data-write') === 'off') return [];
  return [...section.querySelectorAll(TARGET)]
    .filter((el) => writesPlainText(el) && !el.closest(EXCLUDE) && el.textContent.trim());
}

export const hasWrittenText = (section) => !!section && targets(section).length > 0;

/** Bring back the text nodes before an inline edit reads or serializes the element. */
export function plainWriting(scope) {
  const sources = scope?.querySelectorAll('.dl-write-source') ?? [];
  for (const source of sources) {
    const el = source.parentElement;
    el.replaceChildren(...source.childNodes);
  }
  return sources.length > 0;
}

function wordParts(text, lang) {
  let words;
  if (unspaced.test(text)) {
    try { words = new Intl.Segmenter(lang || undefined, { granularity: 'word' }); }
    catch { words = new Intl.Segmenter(undefined, { granularity: 'word' }); }
  }
  return text.split(/([ \t\r\n\f]+)/).filter(Boolean).flatMap((part) => words && unspaced.test(part)
    ? Array.from(words.segment(part), ({ segment }) => segment) : [part]);
}

function draw(el) {
  const doc = el.ownerDocument;
  const source = doc.createElement('span');
  source.className = 'dl-write-source';
  const visual = doc.createElement('span');
  visual.className = 'dl-write-visual';
  visual.setAttribute('aria-hidden', 'true');
  visual.classList.toggle('dl-write-out', mode(el) === 'out');
  let length = 0;
  let last = null;
  const lang = el.closest('[lang]')?.getAttribute('lang');
  const text = el.textContent.replace(/[ \t\r\n\f]+/g, ' ').replace(/^ | $/g, '');
  for (const part of wordParts(text, lang)) {
    if (part === ' ') {
      length++;
      const gap = doc.createElement('span');
      gap.className = 'dl-write-gap';
      gap.setAttribute('data-dl-write-glyph', part);
      visual.append(gap);
      continue;
    }
    const word = doc.createElement('span');
    word.className = 'dl-write-word';
    for (const { segment } of graphemes.segment(part)) {
      const char = doc.createElement('span');
      char.className = 'dl-write-letter';
      char.setAttribute('data-dl-write-glyph', segment);
      char.style.setProperty('--dl-write-index', String(length++));
      word.append(char);
      last = char;
    }
    visual.append(word);
  }
  visual.style.setProperty('--dl-write-length', String(length));
  source.append(...el.childNodes);
  el.append(source, visual);
  return last;
}

/** Restart on entry, and after an edit that has just left authored text in the DOM. */
export function playWriting(section, { restart = true } = {}) {
  if (!section) return;
  const writers = targets(section);
  if (!restart && writers.length && writers.every((el) => el.querySelector(SOURCE))) return;
  const followers = section.querySelectorAll('[data-write-after]');
  for (const el of followers) {
    if (!el.classList.contains('dl-write-follows')) continue;
    el.classList.remove('dl-write-follows');
    // Resolve the removal before adding it back, so the CSS delay starts over.
    el.getAnimations();
  }
  plainWriting(section);
  const ends = writers.map(draw).filter(Boolean)
    .map((last) => cssDurationMs(getComputedStyle(last).animationDelay, 0));
  const end = ends.length ? Math.max(...ends) : null;
  for (const el of followers) {
    el.classList.toggle('dl-write-follows', end !== null);
    if (end !== null) el.style.setProperty('--dl-write-start', `${end}ms`);
    else el.style.removeProperty('--dl-write-start');
  }
}
