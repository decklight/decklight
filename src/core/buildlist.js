// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The Builds panel's rows (PRESENTING_EDITING), pure: what a slide's clicks
// bring, in the order they play, and the notes' beat each one goes with.
//
// The panel (builds-panel.js) reads the slide (scanSlide's record, the notes)
// and says what each step is in words; this turns that into rows, so the
// pairing of clicks and beats has a test of its own. A beat is the notes cut
// at their `[click]` lines (notesparts.js): part 0 is said before any click,
// part k with click k, and a part past the last click is a beat with no step.

import { notesParts } from './notesparts.js';

/** The first `max` words of `text` (markup and runs of space taken out), with … when there were more; '' for none. */
export function firstWords(text, max = 6) {
  const words = String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.length > max ? `${words.slice(0, max).join(' ')}…` : words.join(' ');
}

/**
 * The panel's rows for one slide.
 *   steps   what each step is: `{ label, effect, owner }` (owner: the block a
 *           code line or a stroke's stage belongs to, null for an element)
 *   groups  the clicks, in play order: each the indices of its steps
 *   start   what is there from the start, in words (one label a block)
 *   notes   the slide's notes as written, `[click]` lines and all
 * Returns `{ start, rows, extra, beats, clicks }`: one row a click
 * (`click` from 1, its `items`, its `beat` in first words or null), the beats
 * after the last click (`extra`), how many beats the notes cut into after the
 * opening (`beats`) and how many clicks there are.
 */
export function buildRows({ steps = [], groups = [], start = [], notes = '' } = {}) {
  const parts = notesParts(notes);
  // with no [click] in them the notes are one beat, said whatever is on screen: no click has its own
  const split = parts.length > 1;
  const beatAt = (k) => {
    if (!split || k >= parts.length) return null;
    return firstWords(parts[k]) || null;
  };
  const rows = groups.map((group, g) => ({
    click: g + 1,
    items: group.map((i) => steps[i]).filter(Boolean),
    beat: beatAt(g + 1),
  }));
  const extra = [];
  if (split) for (let k = groups.length + 1; k < parts.length; k++) extra.push({ beat: k, text: firstWords(parts[k]) || '(empty)' });
  return { start: start.filter(Boolean), rows, extra, beats: split ? parts.length - 1 : 0, clicks: groups.length };
}

/** The panel's foot: how the notes and the clicks line up. */
export function beatsLine({ beats, clicks }) {
  const b = `${beats} beat${beats === 1 ? '' : 's'}`;
  const c = `${clicks} click${clicks === 1 ? '' : 's'}`;
  return `notes: ${b} · ${c}`;
}

// ── arranging the clicks (the Builds tab's drag, With previous, On its own click) ──
// `groups` is a slide's clicks as scanSlide counts them: each a list of step
// indices. Each change returns new groups; the slide's order is then written
// from them (orderGroups), so these never touch the page.

/** Click `from` moved so it plays before what is now click `to` (`groups.length`: last). */
export function moveClick(groups, from, to) {
  if (from < 0 || from >= groups.length || to < 0 || to > groups.length || to === from || to === from + 1) return groups.map((g) => g.slice());
  const out = groups.map((g) => g.slice());
  const [moved] = out.splice(from, 1);
  out.splice(to > from ? to - 1 : to, 0, moved);
  return out;
}

/** Click `from`'s steps arrive with click `into` instead: one click fewer. */
export function mergeClick(groups, from, into) {
  if (from === into || !groups[from] || !groups[into]) return groups.map((g) => g.slice());
  const out = groups.map((g) => g.slice());
  out[into] = [...out[into], ...out[from]].sort((a, b) => a - b);
  out.splice(from, 1);
  return out;
}

/** Click `g`'s steps each on a click of its own, where it was, in the order the slide has them. */
export function splitClick(groups, g) {
  if (!groups[g] || groups[g].length < 2) return groups.map((x) => x.slice());
  const out = groups.map((x) => x.slice());
  out.splice(g, 1, ...[...groups[g]].sort((a, b) => a - b).map((i) => [i]));
  return out;
}

/**
 * The groups as the order route takes them: each click the nodes it brings,
 * `steps[i]` being `{ node, count }` (the node that carries a step's order, the
 * number of steps it brings). A node of several steps (a code block's lines, a
 * stroke's stages) is named once, where its first step plays; its steps keep
 * together after it. A click left with nothing of its own is dropped.
 */
export function orderGroups(groups, steps) {
  const named = new Set();
  const out = [];
  for (const g of groups) {
    const nodes = [];
    for (const i of g) {
      const st = steps[i];
      if (!st || named.has(st.node)) continue;
      named.add(st.node);
      nodes.push({ node: st.node, count: st.count ?? 1 });
    }
    if (nodes.length) out.push(nodes);
  }
  return out;
}
