// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Find and replace across a deck (PRESENTING_EDITING): a phrase looked for in
 * the FILE's text, never in the page's DOM, which the engine rewrites (code
 * highlighted into spans, titles pinned, labels namespaced), so what is
 * replaced is exactly what the author wrote.
 *
 * Only the text between tags is read: never a tag, an attribute, a comment, a
 * script or a style. Code (`<pre>`, `<code>`) is left alone unless asked
 * for; the speaker notes (`<aside class="notes">`) are read only when asked
 * for, and other asides (a slide's sources) never. A run's entities are read
 * as the characters they stand for (`Q&amp;A` is found as `Q&A`), and what is
 * written in their place is escaped the one way text is.
 *
 * A match that runs across a tag (`<b>quar</b>ter`) is not found: the panel
 * says so when the page's own text has more matches than the file.
 */

import { sectionBodies, slideRange } from '../tools/deck-html.mjs';

const MAX_FIND = 200;

/** The units of a text run: an entity, or one character; each with what it reads as and where it stands. */
function unitsOf(run) {
  const out = [];
  const re = /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);|[\s\S]/giu;
  for (let m = re.exec(run); m; m = re.exec(run)) {
    let text = m[0];
    if (m[1]) {
      const k = m[1].toLowerCase();
      if (k[0] === '#') {
        const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        text = Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m[0];
      } else {
        text = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k] ?? m[0];
      }
    }
    out.push({ start: m.index, end: m.index + m[0].length, text });
  }
  return out;
}

/** Text as it is written between tags: `&`, `<` and `>` escaped. */
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The text runs of slide markup `seg` (offsets in `seg`), each `{ start, end,
 * notes }`: what lies between tags, outside what is never read.
 */
function textRuns(seg, { notes = false, code = false } = {}) {
  const runs = [];
  // what is skipped whole: comments, scripts, styles, code (unless asked), and asides (the notes read when asked)
  const block = /<!--[\s\S]*?-->|<(script|style|textarea|pre|code|aside)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<[^>]*>/gi;
  let at = 0;
  const text = (from, to, inNotes) => { if (to > from) runs.push({ start: from, end: to, notes: inNotes }); };
  for (let m = block.exec(seg); m; m = block.exec(seg)) {
    text(at, m.index, false);
    at = m.index + m[0].length;
    const tag = m[1]?.toLowerCase();
    if (!tag) continue;
    if ((tag === 'pre' || tag === 'code') && code) {
      // code asked for: its text read as text, its own tags (a highlighted line's spans) skipped
      const innerStart = m.index + m[0].indexOf('>') + 1;
      for (const r of textRuns(m[3], { notes, code })) text(innerStart + r.start, innerStart + r.end, false);
      continue;
    }
    if (tag === 'aside' && notes && /\bclass\s*=\s*["'][^"']*\bnotes\b/i.test(m[2])) {
      const innerStart = m.index + m[0].indexOf('>') + 1;
      for (const r of textRuns(m[3], { notes: false, code })) text(innerStart + r.start, innerStart + r.end, true);
    }
  }
  text(at, seg.length, false);
  return runs;
}

/** The pattern a search is: the phrase as written, any case unless asked, a whole word when asked. */
function patternOf(find, { caseSensitive = false, wholeWord = false } = {}) {
  const f = String(find ?? '');
  if (!f.trim() || f.length > MAX_FIND || /[\u0000-\u001f]/.test(f)) throw new Error(`a phrase to find is one line of up to ${MAX_FIND} characters`);
  const body = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const src = wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
  return new RegExp(src, `gu${caseSensitive ? '' : 'i'}`);
}

/**
 * Every match of `find` in the deck's file, in order: `{ id, slide, notes,
 * start, end, before, text, after }`, `start`/`end` in the file and the three
 * words around it as the slide reads them. `opts`: `{ notes, code,
 * caseSensitive, wholeWord }`.
 */
export function findInDeck(html, find, opts = {}) {
  const src = String(html ?? '');
  const re = patternOf(find, opts);
  const total = sectionBodies(src).length;
  const matches = [];
  for (let n = 1; n <= total; n++) {
    let range;
    try { range = slideRange(src, n); } catch { continue; }
    const seg = src.slice(range.start, range.end);
    for (const run of textRuns(seg, opts)) {
      const units = unitsOf(seg.slice(run.start, run.end));
      if (!units.length) continue;
      // the run as it reads, and which unit each character came from
      let read = '';
      const owner = [];
      units.forEach((u, i) => { read += u.text; for (let k = 0; k < u.text.length; k++) owner.push(i); });
      re.lastIndex = 0;
      for (let m = re.exec(read); m; m = re.exec(read)) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const first = units[owner[m.index]];
        const last = units[owner[m.index + m[0].length - 1]];
        const start = range.start + run.start + first.start;
        const end = range.start + run.start + last.end;
        const squash = (s) => s.replace(/\s+/g, ' ');
        matches.push({
          id: `${n}:${start}`, slide: n, notes: run.notes, start, end,
          before: squash(read.slice(Math.max(0, m.index - 30), m.index)).replace(/^\S*\s/, (w) => (m.index > 30 ? '' : w)),
          text: m[0],
          after: squash(read.slice(m.index + m[0].length, m.index + m[0].length + 30)),
        });
      }
    }
  }
  return matches;
}

/**
 * The deck with `find` replaced by `replace` (escaped as text): every match,
 * or only those whose ids are in `only`. Returns `{ html, count }`.
 */
export function replaceInDeck(html, { find, replace, opts = {}, only = null }) {
  const src = String(html ?? '');
  const by = String(replace ?? '');
  if (by.length > MAX_FIND || /[\u0000-\u0008\u000b-\u001f]/.test(by)) throw new Error(`a replacement is up to ${MAX_FIND} characters of text`);
  const want = only ? new Set(only) : null;
  const hits = findInDeck(src, find, opts).filter((m) => !want || want.has(m.id));
  let out = src;
  for (const m of [...hits].reverse()) out = out.slice(0, m.start) + escapeText(by) + out.slice(m.end);
  return { html: out, count: hits.length };
}
