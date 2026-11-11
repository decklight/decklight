// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The deck changed on disk under write mode, by a hand this server never saw:
 * the author's editor, git, a tool (PRESENTING_EDITING, outside edits). What
 * changed, said in a few words, and what the pages do about it.
 *
 * Every page used to reload for any change, and the hash kept the slide
 * NUMBER: a change to slide 14 left the author on slide 3, a section put in
 * above moved everyone onto the wrong content, and the reload flashed and
 * remounted the docked panels. So the old and the new bytes are compared slide
 * by slide:
 *
 *  - only slides' own markup changed, the same slides in the same order and
 *    nothing around them touched: the pages are sent those slides' new markup
 *    and swap them in place (`patch`);
 *  - anything else reloads, and carries where each slide went (`land`), so a
 *    page lands on its content rather than on its number.
 *
 * Pure: the server (cli/edit.mjs) reads the bytes and sends the message.
 */

import { slideOpsOf, slideRenumberOf } from './commit-split.mjs';
import { indexOfCI, sectionChildRanges, splitOpenTag, readAttrs } from '../tools/deck-html.mjs';

/** Past this many bytes of new slide markup, a patch is a reload: one message is no place for megabytes of data URIs. */
export const PATCH_MAX_BYTES = 1_000_000;

/**
 * The deck's top-level `<section>`s, its slides, as `{ start, end }` offsets
 * into `html` (end past `</section>`). Script, style and comment bodies are
 * blanked first, offsets kept, so a runtime inlined in the page or a slide that
 * SHOWS markup does not open or close a slide; a section inside a section is
 * part of its slide, as the runtime counts them. Pure.
 */
export function topSections(html) {
  const src = String(html ?? '');
  const blanked = src.replace(
    /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi,
    (m) => ' '.repeat(m.length),
  );
  const out = [];
  let depth = 0;
  let open = -1;
  for (const m of blanked.matchAll(/<section\b|<\/section\s*>/gi)) {
    if (m[0][1] !== '/') {
      if (depth === 0) open = m.index;
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0) out.push({ start: open, end: m.index + m[0].length });
    }
  }
  return out;
}

/** The deck cut into its slides' markup and everything around them (`frame`, each slide a marker). */
function cut(html) {
  const src = String(html ?? '');
  const ranges = topSections(src);
  const slides = ranges.map((r) => src.slice(r.start, r.end));
  let frame = '';
  let at = 0;
  for (const r of ranges) { frame += `${src.slice(at, r.start)}\u0000`; at = r.end; }
  frame += src.slice(at);
  // the spacing between two slides is not the page's: a slide put in or taken out moves it
  return { slides, frame: frame.replace(/\s*(?:\u0000\s*)+/g, '\u0000') };
}

/** A slide as the alignment compares it: whitespace at line ends ignored (as cli/commit-split.mjs reads slides). */
const source = (sec) => sec.split('\n').map((l) => l.trim()).join('\n');

// What a slide's part is called, by its tag (and a class for an aside or a
// chart): the definite name for a part that changed or went, the indefinite
// one for a part that was put in.
const PARTS = [
  [/^h[12]$/, 'the title', 'a title'],
  [/^h[3-6]$/, 'a heading', 'a heading'],
  [/^ul$/, 'the bullet list', 'a bullet list'],
  [/^ol$/, 'the numbered list', 'a numbered list'],
  [/^(p|span)$/, 'the text', 'some text'],
  [/^(img|picture)$/, 'the picture', 'a picture'],
  [/^svg$/, 'the diagram', 'a diagram'],
  [/^pre$/, 'the code', 'a code block'],
  [/^table$/, 'the table', 'a table'],
  [/^blockquote$/, 'the quote', 'a quote'],
  [/^(video|audio)$/, 'the media', 'a video'],
  [/^script$/, 'the script', 'a script'],
  [/^style$/, 'the style', 'a style'],
];
function partName(tag, markup) {
  if (tag === 'aside') {
    const cls = /^<aside\b[^>]*\bclass\s*=\s*["']([^"']*)["']/i.exec(markup)?.[1] ?? '';
    if (/\bnotes\b/.test(cls)) return ['the notes', 'notes'];
    if (/\bsources\b/.test(cls)) return ['the sources', 'sources'];
    if (/\brehearse\b/.test(cls)) return ['the rehearsal notes', 'rehearsal notes'];
  }
  if (/^<\w+\b[^>]*(\bclass\s*=\s*["'][^"']*\bchart\b|\bdata-chart\b)/i.test(markup)) return ['the chart', 'a chart'];
  if (tag === 'figure' && /<img\b/i.test(markup)) return ['the picture', 'a picture'];
  for (const [re, the, a] of PARTS) if (re.test(tag)) return [the, a];
  return ['the content', 'some content'];
}

/**
 * What changed inside one slide, in a few words ("the bullet list", "the
 * title and the notes", "a picture added"), or '' when it cannot be named (a
 * change only of spacing, or of text between the elements). Each top-level
 * element is matched by its markup: one gone and one come of the same kind is
 * that part changed; the rest were added or removed. Pure.
 */
export function slidePartsSaid(was, now) {
  const parts = (sec) => {
    try { return sectionChildRanges(sec).map((r) => ({ tag: r.tag, markup: sec.slice(r.start, r.end) })); } catch { return []; }
  };
  const a = parts(was), b = parts(now);
  const said = [];
  const say = (s) => { if (!said.includes(s)) said.push(s); };
  const attrsOf = (sec) => readAttrs(splitOpenTag(sec.replace(/^<section\b/i, '')).attrs);
  const oa = attrsOf(was), ob = attrsOf(now);
  const keys = new Set([...Object.keys(oa), ...Object.keys(ob)]);
  const differs = [...keys].filter((k) => oa[k] !== ob[k]);
  if (differs.includes('data-layout')) say('the layout');
  else if (differs.length) say("the slide's attributes");
  const left = a.filter((p) => !b.some((q) => q.markup.trim() === p.markup.trim()));
  const came = b.filter((q) => !a.some((p) => p.markup.trim() === q.markup.trim()));
  for (const p of left) {
    const [the] = partName(p.tag, p.markup);
    const k = came.findIndex((q) => partName(q.tag, q.markup)[0] === the);
    if (k !== -1) { came.splice(k, 1); say(the); } else say(`${the} removed`);
  }
  for (const q of came) say(`${partName(q.tag, q.markup)[1]} added`);
  if (said.length > 2) return `${said.length} parts`;
  return said.join(' and ');
}

/** "3", "3 and 9", "3, 5 and 9", or how many past four. */
function numbers(ns) {
  const list = [...ns].sort((x, y) => x - y);
  if (list.length > 4) return null;
  return list.length === 1 ? String(list[0]) : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
}
function slidesPhrase(ns, verb) {
  if (!ns.length) return null;
  const listed = numbers(ns);
  if (ns.length === 1) return `slide ${listed} ${verb}`;
  return listed ? `slides ${listed} ${verb}` : `${ns.length} slides ${verb}`;
}
/** Clauses joined, at most three of them. */
function clauses(list) {
  const c = list.filter(Boolean);
  if (c.length > 3) return `${c.slice(0, 3).join(', ')} and more`;
  return c.join(', ');
}

/** What changed around the slides: the head (styles, settings, the theme) or the rest of the page. */
function frameSaid(before, after) {
  const head = (s) => {
    const i = indexOfCI(s, '<head');
    const j = indexOfCI(s, '</head>');
    return i === -1 || j === -1 ? '' : s.slice(i, j);
  };
  return head(before) !== head(after) ? "the deck's head changed" : 'the deck changed outside its slides';
}

/**
 * An outside edit, old bytes against new: null when nothing a page shows
 * changed (the same bytes, or only the spacing between two slides); else
 *
 *   { said,                       a few plain words: "slide 9 changed: the bullet list",
 *                                 "slide 4 added", "slides 7 and 8 swapped"
 *     patch?: { total, slides: [{ slide, html }] },
 *                                 present when the pages can swap the slides in place:
 *                                 the same slides in the same order, nothing around them
 *                                 changed, no script in a changed slide, not too big
 *     land: { go, moves, was, total } }
 *
 * `go` is the slide an author goes to (the first slide changed, added or
 * moved, numbered in the new deck; after a removal only, the slide that now
 * stands in the first one's place; null when no slide changed). `moves` is
 * where each old slide went, `[[was, now | null]]` for every one whose number
 * changed or that is gone (slideRenumber's pairs), so a page that is not
 * following the change stays on its content. `was` and `total` are the two
 * slide counts. Pure.
 */
export function outsideEdit(before, after, { maxPatch = PATCH_MAX_BYTES } = {}) {
  const old = String(before ?? ''), now = String(after ?? '');
  if (old === now) return null;
  const A = cut(old), B = cut(now);
  const a = A.slides.map(source), b = B.slides.map(source);
  const moves = slideRenumberOf(a, b);
  const total = B.slides.length;
  const land = { go: null, moves, was: A.slides.length, total };
  const frameChanged = A.frame !== B.frame;

  // the same slides, in the same order: each one that differs is that slide edited
  if (!moves.length && A.slides.length === B.slides.length) {
    const touched = [];
    B.slides.forEach((sec, i) => { if (sec !== A.slides[i]) touched.push(i + 1); });
    // only the spacing between slides moved: nothing a page shows changed
    if (!touched.length && !frameChanged) return null;
    land.go = touched[0] ?? null;
    const detail = touched.length === 1 ? slidePartsSaid(A.slides[touched[0] - 1], B.slides[touched[0] - 1]) : '';
    const slides = slidesPhrase(touched, 'changed');
    const said = clauses([frameChanged && frameSaid(old, now), slides && (detail ? `${slides}: ${detail}` : slides)]);
    const html = touched.map((n) => B.slides[n - 1]);
    const inPlace = !frameChanged && touched.length > 0
      && touched.every((n) => !/<script\b|\sdata-markdown\b/i.test(A.slides[n - 1] + B.slides[n - 1]))
      && html.reduce((sum, h) => sum + h.length, 0) <= maxPatch;
    return {
      said: said || 'the deck changed on disk',
      ...(inPlace ? { patch: { total, slides: touched.map((n, i) => ({ slide: n, html: html[i] })) } } : {}),
      land,
    };
  }

  // Slides went, came or moved: read off the alignment. A removed slide that
  // reappears word for word was moved; one the renumbering still pairs with a
  // slide of the new deck was rewritten in its place, so it changed.
  const ops = slideOpsOf(a, b);
  const to = new Map(moves);
  const target = (was) => (to.has(was) ? to.get(was) : was);
  const pairs = ops.filter((o) => o.kind === 'changed').map((o) => [o.was, o.slide]);
  const moved = [];
  const removed = [];
  const taken = new Set();
  for (const o of ops.filter((x) => x.kind === 'removed')) {
    const n = target(o.was);
    if (n === null) { removed.push(o.was); continue; }
    taken.add(n);
    if (a[o.was - 1] === b[n - 1]) moved.push([o.was, n]); else pairs.push([o.was, n]);
  }
  const changed = pairs.map(([, n]) => n);
  const added = ops.filter((o) => o.kind === 'added' && !taken.has(o.slide)).map((o) => o.slide);
  // a slide moved by one place swapped places with its neighbour
  const movedSaid = moved.map(([w, n]) => (Math.abs(w - n) === 1 ? `slides ${Math.min(w, n)} and ${Math.max(w, n)} swapped` : `slide ${w} moved to ${n}`));
  const detail = pairs.length === 1 && !added.length && !removed.length && !moved.length
    ? slidePartsSaid(A.slides[pairs[0][0] - 1], B.slides[pairs[0][1] - 1]) : '';
  const changedSaid = slidesPhrase(changed, 'changed');
  const said = clauses([
    frameChanged && frameSaid(old, now),
    slidesPhrase(added, 'added'),
    slidesPhrase(removed, 'removed'),
    ...movedSaid,
    changedSaid && (detail ? `${changedSaid}: ${detail}` : changedSaid),
  ]);
  // a swap touched both places; a longer move, the place the slide went to
  const firsts = [...changed, ...added, ...moved.flatMap(([w, n]) => (Math.abs(w - n) === 1 ? [w, n] : [n]))];
  if (firsts.length) land.go = Math.min(...firsts);
  else if (removed.length) {
    // the slide that now stands where the first removed one was
    let n = null;
    for (let k = Math.min(...removed) + 1; k <= A.slides.length && n === null; k++) n = target(k);
    land.go = n ?? (total || null);
  }
  return { said: said || 'the deck changed on disk', land };
}
