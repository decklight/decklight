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

/** A stroke cut in `n` even stages, as `data-draw-stops` fractions (`0.333 0.667 1`); null for one draw. */
export function evenStops(n) {
  const k = Math.floor(Number(n));
  if (!(k > 1)) return null;
  return Array.from({ length: k }, (_, i) => (i === k - 1 ? '1' : String(Math.round(((i + 1) / k) * 1000) / 1000))).join(' ');
}

/** How many stages a stroke's `data-draw-stops` cuts it in (1 with none). */
export function stagesOf(attr) {
  const n = String(attr ?? '').trim().split(/[\s,]+/).filter(Boolean).length;
  return n || 1;
}

/**
 * A slide's clicks once the steps that have no place in a written order are
 * given one (a point added to a list after the order was set): `groups` as
 * they play now, `steps[i]` `{ ordered, after }`, `after` the step it comes
 * right after on the slide (the point before it), null when it is the first.
 * Each unordered step gets a click of its own right after its `after`'s
 * click, or, first of its list, right before the click of the step after it
 * (`before`). Every ordered step keeps its click and its order. Returns the
 * new groups, or null when there is nothing to place.
 */
export function placeUnordered(groups, steps) {
  const loose = steps.map((s, i) => (s && !s.ordered ? i : -1)).filter((i) => i >= 0);
  if (!loose.length || loose.length === steps.length) return null;
  const isLoose = new Set(loose);
  // the ordered steps' clicks, as they play
  const out = groups.map((g) => g.filter((i) => !isLoose.has(i))).filter((g) => g.length);
  const clickOf = (i) => out.findIndex((g) => g.includes(i));
  // in slide order, so a run of new points lands in the order they are written
  for (const i of loose) {
    const { after = null, before = null } = steps[i];
    let at = after !== null ? clickOf(after) : -1;
    if (at >= 0) { out.splice(at + 1, 0, [i]); continue; }
    at = before !== null ? clickOf(before) : -1;
    if (at >= 0) out.splice(at, 0, [i]);
    else out.push([i]);
  }
  return out;
}

/**
 * A stroke's stops (`data-draw-stops` fractions) with one more at `f`, a
 * fraction of its length placed by a click on the stroke: sorted, rounded
 * to three places, the last always 1 (the stroke drawn whole), and a stop
 * within 2% of one already there taken as that one. `lengths` are the stops
 * it has, as path lengths (parseDrawStops), and `total` its length. Returns
 * the attribute's new text, or null when `f` adds nothing.
 */
export function stopsWith(lengths, total, f) {
  if (!(total > 0) || !(f > 0) || f > 1) return null;
  const have = (lengths ?? []).map((l) => Math.min(1, Math.max(0, l / total))).filter((x) => x > 0);
  if (!have.length || have.at(-1) < 1) have.push(1);
  if (have.some((x) => Math.abs(x - f) < 0.02)) return null;
  const all = [...have, f].sort((a, b) => a - b).map((x) => (x >= 1 ? 1 : Math.round(x * 1000) / 1000));
  return all.map((x) => (x === 1 ? '1' : String(x))).join(' ');
}
