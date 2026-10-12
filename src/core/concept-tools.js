// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Putting shapes into a concept (SPEC SVG_DIAGRAMS, #718), from anywhere.
 *
 * One door for every way a shape gets its concept: the right-click menu's
 * Concept ▸, the Inspector's Colors tab, a click in the concept list's pick
 * mode, a Check deck… suggestion. Each used to be a write and a reload of its
 * own; through here it is one write for any number of shapes, in place (this
 * page repaints, every other page reloads), and `Z` takes the batch back.
 *
 * And after a single shape is attached, the rest of its kind are offered: a
 * concept is a recurring idea, and a person sees one recur by the words on the
 * box. "Agent" on slide 3 becoming the agent concept asks about the other
 * boxes that say "Agent", wherever they are, instead of leaving the author to
 * find them one right-click at a time.
 */

import { conceptSuggestions, lookAlikes, shapeLabel } from './concepts.js';
import { UNDO_CHORD } from './undo-chord.js';

const SHAPES = 'rect, circle, ellipse, polygon, path';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const slidesSaid = (slides) => (slides.length === 1 ? `slide ${slides[0]}` : `slides ${slides.slice(0, -1).join(', ')} and ${slides.at(-1)}`);

/** The paint a concept put on `el` (applyConcepts), taken off when its concept goes. */
function unpaint(el) {
  const shapes = el.matches(SHAPES) ? [el] : [...el.children].filter((c) => c.matches(SHAPES));
  for (const t of shapes) {
    const unfilled = t.getAttribute('fill') === 'none';
    t.style.removeProperty(unfilled ? 'stroke' : 'fill');
  }
}

export function createConceptTools({ stage, editmode, choiceCard, toast, repaint, debugLog = () => {} }) {
  const slideOf = (el) => {
    const sec = el.closest('section');
    return sec ? [...stage().querySelectorAll(':scope > section')].indexOf(sec) + 1 : 0;
  };

  /**
   * Put `els` (shapes, or the groups that hold their concept) into `name`, or
   * out of their concept with `null`. One write, in place. After a single
   * shape joins a concept, its look-alikes are offered (`offer: false` is how
   * accepting that offer avoids asking again).
   */
  async function attach(els, name, { offer = true } = {}) {
    const em = editmode();
    if (!em?.available?.()) { toast('concepts are set in write mode — decklight <deck.html>', 3200); return 0; }
    const seen = new Set();
    const targets = els.map((el) => em.conceptTarget(el)).filter((t) => t && !seen.has(t.el) && seen.add(t.el))
      .filter((t) => t.name !== name);
    if (!targets.length) { toast(name ? `already the “${name}” concept` : 'no concept to take off', 2200); return 0; }
    try {
      await em.writeConcepts(targets, name);
    } catch (e) {
      toast(`concept not saved: ${String(e.message || e).slice(0, 90)}`, 3400);
      return 0;
    }
    for (const t of targets) {
      if (name) t.el.setAttribute('data-concept', name);
      else { t.el.removeAttribute('data-concept'); unpaint(t.el); }
    }
    repaint();
    const slides = [...new Set(targets.map((t) => t.slide))].sort((a, b) => a - b);
    debugLog('concepts', `${plural(targets.length, 'shape')} on ${slidesSaid(slides)} → ${name ?? '(detached)'}`);
    // one shape picked by hand is "now"; a batch (look-alikes, a suggestion, a pick) says how many
    const who = targets.length === 1 && offer ? 'now' : `${plural(targets.length, 'shape')} now`;
    toast(name
      ? `${who} the “${name}” concept · ${UNDO_CHORD} takes it back`
      : `${targets.length === 1 ? 'detached from its concept' : `${targets.length} shapes detached`} · ${UNDO_CHORD} takes it back`, 2600);
    if (name && offer && els.length === 1) offerLookAlikes(els[0], name);
    return targets.length;
  }

  /** "Also the other boxes that say Agent?" — asked once, after one shape joins `name`. */
  function offerLookAlikes(shape, name) {
    const box = shape.matches(SHAPES) ? shape : shape.querySelector(SHAPES);
    if (!box) return false;
    const more = lookAlikes(stage(), box, name);
    if (!more.length) return false;
    const label = shapeLabel(box);
    const slides = [...new Set(more.map(slideOf))].filter(Boolean).sort((a, b) => a - b);
    choiceCard.open({
      title: `the other “${label}” boxes`,
      lines: [`${plural(more.length, 'other shape')} on ${slidesSaid(slides)} ${more.length === 1 ? 'says' : 'say'} “${label}” too.`],
      rows: [
        { label: `Make ${more.length === 1 ? 'it' : `all ${more.length}`} the “${name}” concept`, value: 'all', note: `one write · ${UNDO_CHORD} takes it back` },
        { label: 'Just this one', value: 'one' },
      ],
      onPick: (v) => { if (v === 'all') attach(more, name, { offer: false }); },
    });
    return true;
  }

  return {
    attach,
    offerLookAlikes,
    /** Labels that recur in different colours, worth a concept (concepts.js). */
    suggestions: () => conceptSuggestions(stage()),
    /** A suggestion accepted: every shape that says it, into its concept. */
    accept: (s) => attach(s.shapes, s.name, { offer: false }),
  };
}
