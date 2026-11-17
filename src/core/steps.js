// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The strip a run of slides shows (SPEC DECK_ANATOMY, PRESENTING_CHROME,
// #1188): the run's groups in order, the one this slide is in lit in the
// accent, the ones done muted, and "3 of 7" when the run numbers its slides.
//
// Drawn by the runtime from what the slides say (tools/steps.mjs), on every
// sync, so a slide inserted, split, moved or hidden renumbers the run with
// nothing to retype; the file holds only the run's groups and each slide's.
// The strip is the engine's, like the background layer and the hero logo: it
// is left out wherever a slide's content is read (ENGINE_MADE), and it takes
// no click (CSS), so the slide under it advances as ever.
//
// Where it sits is the theme's (`--steps-top`, `--steps-bottom`,
// `--steps-inset`, `--steps-align`: in the slide's top padding by default,
// clear of a pinned title and of the corner chrome), or a design system's: a
// slide template with an empty `data-slot="steps"` gets the strip in that
// slot instead.

import { stepRuns, stepLabel } from '../../tools/steps.mjs';

/** The strip's class: what every reader of a slide's content leaves out. */
export const STEPS_CLASS = 'decklight-steps';
/** The authored list form of a run's groups: carried by the slide, never shown on it. */
export const STEPS_LIST = 'nav.steps';

/** What `stepRuns` reads off one `<section>`. */
export function stepSlide(sec) {
  const nav = sec.querySelector(STEPS_LIST);
  return {
    steps: sec.getAttribute('data-steps'),
    list: nav ? [...nav.querySelectorAll('li')].map((li) => li.textContent) : null,
    step: sec.getAttribute('data-step'),
    module: sec.hasAttribute('data-module'),
    end: sec.hasAttribute('data-steps-end'),
    count: sec.hasAttribute('data-steps-count'),
    hidden: sec.hasAttribute('data-hidden'),
  };
}

/** One slide's strip: the groups, this one's place among them, and its count. */
export function stripFor(run, where, doc = document) {
  const el = doc.createElement('div');
  el.className = STEPS_CLASS;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', stepLabel(run, where));
  const groups = doc.createElement('span');
  groups.className = 'steps-groups';
  run.groups.forEach((name, i) => {
    const g = doc.createElement('span');
    g.className = 'steps-group ' + (i < where.group ? 'steps-done' : i === where.group ? 'steps-current' : 'steps-next');
    if (i === where.group) g.setAttribute('aria-current', 'step');
    g.textContent = name;
    groups.appendChild(g);
  });
  el.appendChild(groups);
  if (where.n != null) {
    const count = doc.createElement('span');
    count.className = 'steps-count';
    count.textContent = `${where.n} of ${where.of}`;
    el.appendChild(count);
  }
  return el;
}

/**
 * Draw every run's strip on `sections`, the old ones taken off first, and
 * return what `stepRuns` read (`{ runs, at, unknown }`), which the finder
 * folds by. Idempotent: run it after anything that adds, moves or renames.
 */
export function setupSteps(sections) {
  for (const sec of sections) {
    for (const old of sec.querySelectorAll(`.${STEPS_CLASS}`)) old.remove();
    sec.classList.remove('has-steps');
  }
  const read = stepRuns(sections.map(stepSlide));
  sections.forEach((sec, i) => {
    const where = read.at[i];
    if (!where) return;
    const strip = stripFor(read.runs[where.run], where, sec.ownerDocument);
    // a design system's template may say where it goes: its empty steps slot
    const slot = sec.querySelector('[data-ds-injected][data-slot="steps"]');
    if (slot) {
      strip.classList.add('steps-in-slot');
      slot.replaceChildren(strip);
    } else sec.appendChild(strip);
    sec.classList.add('has-steps');
  });
  return read;
}
