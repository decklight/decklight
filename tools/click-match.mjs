// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Do a slide's [click] markers match its build clicks (SPEC BUILD_SEMANTICS)?
 * One rule and one sentence for everything that asks: `decklight check` from
 * the file or from a rendered page, the Check deck… panel, and the recorder
 * before a take (#929). Pure, and here rather than in src/ for the reason
 * tools/build-groups.mjs gives: cli/ never imports src/, src/ may import a tool.
 *
 * The notes want one [click] per build click: the words before the first
 * marker are said on arrival, and each marker reveals the next build. Notes
 * with no marker at all make no claim about the builds and never disagree; a
 * marker on a slide with no builds does, since it waits for a build that never
 * comes.
 *
 * `cause` is the likely reason, when the counting saw one: an EMPTY BUILD
 * GROUP (a build left behind when its content was removed, so a click reveals
 * nothing) or a LEAD CLICK (a marker with nothing said before it, so the first
 * beat is empty). Those two are what put three slides of a real deck out of step.
 */
export const CLICK_CAUSES = ['empty-build', 'lead-click'];

/** `{ markers, clicks, cause }` when the two counts disagree, null when they agree or the notes make no claim. */
export function clickMismatch({ markers = 0, clicks = 0, cause = null } = {}) {
  if (!(markers > 0) || markers === clicks) return null;
  return { markers, clicks, cause: CLICK_CAUSES.includes(cause) ? cause : null };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `5 [click] markers, 6 build clicks`: the two numbers, by the names the author knows them by. */
export function clickCounts(m) {
  return `${plural(m.markers, '[click] marker')}, ${plural(m.clicks, 'build click')}`;
}

/** `2 [click], 4 builds`: the same, short enough for a slide row's status. */
export function clickCountsShort(m) {
  return `${m.markers} [click], ${plural(m.clicks, 'build')}`;
}

/** The likely cause, as a phrase, or ''. */
export function clickCause(m) {
  if (m?.cause === 'empty-build') return 'an empty build group (a data-build with nothing visible in it)';
  if (m?.cause === 'lead-click') return 'a [click] with nothing before it, which makes an empty first beat';
  return '';
}

/**
 * The whole finding: the counts, the tie when `steps` differs from the clicks,
 * what the notes want, and the likely cause.
 */
export function clickMismatchText(m, { steps = null } = {}) {
  const tied = steps != null && steps !== m.clicks ? ` (${plural(steps, 'build step')}, tied by data-build-order)` : '';
  const want = m.clicks
    ? `the notes want ${plural(m.clicks, '[click]')}, one per build click`
    : 'there is no build for a [click] to reveal';
  const cause = clickCause(m);
  return `${clickCounts(m)}${tied}: ${want}, so the narration and the builds drift apart here`
    + (cause ? `; likely ${cause}` : '');
}

/** `5 6 empty-build`: the verdict as the print view stamps it on a section, for `check` to read back. */
export const stampClickMismatch = (m) => `${m.markers} ${m.clicks}${m.cause ? ` ${m.cause}` : ''}`;

/** The stamp back into a verdict, or null. */
export function readClickMismatch(stamp) {
  const [markers, clicks, cause] = String(stamp ?? '').trim().split(/\s+/);
  return clickMismatch({ markers: Number(markers), clicks: Number(clicks), cause });
}
