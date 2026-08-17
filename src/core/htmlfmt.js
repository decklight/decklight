// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Making an element's source readable in the content editor (author mode),
// WITHOUT changing what it renders.
//
// The editor is handed the element's outerHTML sliced out of the deck FILE, so
// it arrives carrying the file's own nesting depth on every line except the
// first — which had its indentation consumed by the slice:
//
//     <aside class="notes">
//             <p>Welcome. …</p>
//           </aside>
//
// That is not the author's formatting, it is an artefact of where the element
// happened to sit. Removing it is the whole job.
//
// WHY THIS IS DEDENT AND NOT PRETTY-PRINTING. Re-indenting HTML in general
// changes what it renders: whitespace between inline elements is a visible
// space, so breaking `<b>a</b><i>b</i>` across lines inserts one that was not
// there. Removing a COMMON prefix from lines that already exist inserts and
// deletes nothing between elements — it only shortens runs of leading
// whitespace, which is collapsed anyway everywhere it is not preserved. The
// exception is where it IS preserved, and that is exactly what `dedentable`
// refuses.
//
// Pure, so the safety argument is checkable without a browser.

/** Elements inside which whitespace is significant and must not be touched. */
const PRESERVES_WHITESPACE = /<\s*(pre|textarea|script|style)\b/i;

/**
 * Can this source be dedented without changing what it renders?
 *
 * A `white-space: pre` element is the case that matters: inside one, the
 * leading spaces on a line ARE the content, and shortening them rewrites the
 * text. The check is the tag rather than the computed style because the source
 * is a string — and it is deliberately blunt: a `<pre>` anywhere in the element
 * disables dedenting for the whole element rather than for part of it. Getting
 * this wrong silently edits somebody's deck, so it errs toward doing nothing.
 */
export const dedentable = (src) => !PRESERVES_WHITESPACE.test(String(src ?? ''));

/**
 * Strip the file's nesting depth from an element's source.
 *
 * The first line is excluded from the measurement — the slice already ate its
 * indentation, so it is flush and would make every common prefix zero. It needs
 * no stripping for the same reason.
 *
 * Blank lines are excluded too: a line of nothing has no indentation to speak
 * of, and counting it as zero would defeat the whole measurement. They are
 * emitted as genuinely empty rather than as their original spaces, since
 * trailing whitespace on a blank line is invisible noise in an editor.
 *
 * Tabs are left alone. Mixing them with spaces makes "how deep is this line"
 * unanswerable without knowing a tab width nobody has told us, and a wrong
 * answer here deletes real characters.
 */
export function dedentHtml(src) {
  const text = String(src ?? '');
  if (!dedentable(text)) return text;
  const lines = text.split('\n');
  if (lines.length < 2) return text;

  let common = Infinity;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    if (/^\s*\t/.test(line)) return text;   // tabs: not ours to measure
    common = Math.min(common, /^ */.exec(line)[0].length);
    if (common === 0) return text;          // already flush; nothing to do
  }
  if (!Number.isFinite(common)) return text;

  return lines
    .map((line, i) => (i === 0 ? line : line.trim() ? line.slice(common) : ''))
    .join('\n');
}
