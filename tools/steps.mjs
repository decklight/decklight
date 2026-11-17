// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A run of slides that shows where it is (SPEC DECK_ANATOMY, #1188): "step 3
// of 7", with the group it belongs to. The author marks the run once, on the
// slide that starts it, and each slide after it says which group it is in, or
// continues the one before:
//
//   <section data-steps="Foundation, Fresh context, Tools, The agent" data-steps-count>
//   <section>                              (still Foundation)
//   <section data-step="Fresh context">
//
// The groups may also be a list, `<nav class="steps"><ol><li>Foundation</li>…`,
// on that first slide. A run ends at the next chapter marker (`data-module`),
// at the next run, or at a slide marked `data-steps-end`, which is the first
// slide after it.
//
// Pure and shared: the runtime draws the strip from it (src/core/steps.js),
// `decklight check` names a `data-step` that is no group of its run, and the
// slide finder folds a run's slides under its group names. One reading, so
// the strip, the finder and the check can never disagree about a slide.

/** The longest group name the strip draws, and the most groups a run takes. */
export const STEP_NAME_MAX = 60;
export const STEP_GROUPS_MAX = 12;

/** Words on one line, as a group is written: inner runs of space made one, trimmed. */
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** A group name as it is compared: case and spacing are no difference. */
export const stepKey = (s) => clean(s).toLowerCase();

/**
 * The groups `data-steps="A, B, C"` names, in order: empty names dropped, a
 * name written twice kept once, at most STEP_GROUPS_MAX of them.
 */
export function parseSteps(text) {
  const out = [];
  for (const part of String(text ?? '').split(',')) {
    const name = clean(part).slice(0, STEP_NAME_MAX);
    if (name && !out.some((g) => stepKey(g) === stepKey(name))) out.push(name);
  }
  return out.slice(0, STEP_GROUPS_MAX);
}

/** The groups a `<nav class="steps">` list holds, its items' words in order (parseSteps' rules). */
export const listSteps = (items) => parseSteps((items ?? []).map((t) => clean(t).replace(/,/g, ' ')).join(','));

/**
 * Every run in a deck, and where each slide stands in its own.
 *
 * `slides` is the deck in order, one `{ steps, list, step, module, end,
 * count, hidden }` a slide: `steps` its `data-steps` (null when absent),
 * `list` the items of its `<nav class="steps">` (null when it has none),
 * `step` its `data-step`, `module` whether it starts a chapter, `end` whether
 * it carries `data-steps-end`, `count` whether it carries `data-steps-count`,
 * `hidden` whether it is hidden when presenting.
 *
 * Returns `{ runs, at, unknown }`:
 *   runs     `[{ start, end, groups, count, slides }]`, slide numbers from 1,
 *            `end` the run's last slide, `slides` how many of them are shown;
 *   at       one entry a slide (index 0 is slide 1): null outside a run, else
 *            `{ run, group, n, of }`, `group` the index of its group, `n` its
 *            place among the run's shown slides (null when it is hidden, or
 *            the run is not counted) and `of` how many there are;
 *   unknown  `[{ slide, step, groups }]`: a `data-step` that names no group of
 *            its run (`groups` null when the slide is in no run at all). Such
 *            a slide continues the group before it, as an absent one does.
 */
export function stepRuns(slides) {
  const list = Array.isArray(slides) ? slides : [];
  const runs = [];
  const at = list.map(() => null);
  const unknown = [];
  let run = null;
  let group = 0;
  list.forEach((s, i) => {
    const slide = i + 1;
    const declared = s?.steps != null ? parseSteps(s.steps) : s?.list ? listSteps(s.list) : null;
    // a chapter, a marked end, or a new run closes the one before
    if (run && (s?.module || s?.end || declared)) run = null;
    if (declared && declared.length) {
      run = { start: slide, end: slide, groups: declared, count: !!s.count, slides: 0 };
      runs.push(run);
      group = 0;
    }
    if (s?.step != null && String(s.step).trim() !== '') {
      const k = run ? run.groups.findIndex((g) => stepKey(g) === stepKey(s.step)) : -1;
      if (k >= 0) group = k;
      else unknown.push({ slide, step: clean(s.step), groups: run ? [...run.groups] : null });
    }
    if (!run) return;
    run.end = slide;
    at[i] = { run: runs.length - 1, group, n: null, of: 0, hidden: !!s?.hidden };
  });
  // numbered over the slides an audience sees: a hidden one keeps its group, not a number
  for (const r of runs) {
    let n = 0;
    for (let i = r.start - 1; i < r.end; i++) if (!at[i].hidden) at[i].n = ++n;
    r.slides = n;
    for (let i = r.start - 1; i < r.end; i++) {
      at[i].of = n;
      if (!r.count) at[i].n = null;
      delete at[i].hidden;
    }
  }
  return { runs, at, unknown };
}

/**
 * The sentence a strip says for one slide, as a screen reader and a tooltip
 * read it: `Step 3 of 7: Fresh context` when the run is counted, else
 * `Fresh context, 2 of 4` (the group's place among the groups).
 */
export function stepLabel(run, where) {
  const name = run.groups[where.group] ?? '';
  return where.n != null ? `Step ${where.n} of ${where.of}: ${name}` : `${name}, ${where.group + 1} of ${run.groups.length}`;
}
