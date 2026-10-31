// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The notes card's per-build view (SPEC PRESENTING): a slide's notes cut at
 * their `[click]` lines, one part per build, the part before the first click
 * spoken while nothing is built yet. The card shows the part for the build on
 * screen and writes it back into its place, every `[click]` around it kept.
 *
 * Pure, on the notes as the editor holds them (`notesDraft`, the ⟨CLICK⟩
 * form, or the `[click]` form `writtenMarks` gives the box). A click cuts
 * wherever it is written, the way the narration reads it (`notesSegsOf`).
 */

const CLICK_ANY = /\[\s*click\s*\]|⟨\s*click\s*⟩|<\s*click\s*\/?\s*>/i;
const SEP = '\n\n[click]\n\n';

/** The notes cut at their click lines: one trimmed part per build, the first spoken before any. */
export function notesParts(text) {
  return String(text ?? '').split(new RegExp(CLICK_ANY.source, 'gi')).map((p) => p.trim());
}

/** The parts written back as one script, a `[click]` line between each. */
export function joinParts(parts) {
  return parts.map((p) => String(p ?? '').trim()).join(SEP).trim();
}

/** `parts` with part `i` replaced by `text`: the script the card saves. */
export function withPart(parts, i, text) {
  const next = parts.slice();
  next[i] = text;
  return joinParts(next);
}

/** Does `text` hold a click mark of its own (a split the part view cannot show)? */
export const hasClick = (text) => CLICK_ANY.test(String(text ?? ''));

/**
 * Which part the per-build view shows on build `step` of a slide with
 * `builds` build steps whose notes cut into `count` parts:
 * `{ part }` (an index), or `{ part: null, why }` when the whole slide is
 * shown instead: `none` (no builds to follow), `unsplit` (builds but
 * no `[click]`), `past` (a build the notes have no part for).
 */
export function partFor(step, builds, count) {
  if (!builds) return { part: null, why: 'none' };
  if (count <= 1) return { part: null, why: 'unsplit' };
  if (step < count) return { part: step };
  return { part: null, why: 'past' };
}

/** How the heading names part `i` of `count`. */
export function partLabel(i, count) {
  return i === 0 ? 'before the first build' : `build ${i} of ${count - 1}`;
}

/** Why the whole slide shows in the per-build view, for the heading; '' when there is nothing to say. */
export function wholeWhy(why, { step = 0, builds = 0, count = 1 } = {}) {
  if (why === 'unsplit') return `${builds} build${builds === 1 ? '' : 's'}, no [click] to split the notes`;
  if (why === 'past') return `build ${step} has no part: ${count - 1} [click] for ${builds} build${builds === 1 ? '' : 's'}`;
  return '';
}
