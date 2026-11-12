// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Where a write-mode edit lands in the deck FILE, and how one attribute or
// one node is changed there (PRESENTING_EDITING). Every element transform in
// cli/edit.mjs addresses its target the same way, so the way lives here once:
//
//   a slide's top-level element is its raw index among the `<section>`'s
//   direct children (title included, sectionChildRanges);
//   a node inside one is a `path` of element-child indices below it, counted
//   over the FILE's elements (the live DOM is not the file: the engine adds
//   nodes of its own), plus the `tag` the page saw there. A path the file
//   does not have, or one that lands on another tag, is STALE (a 409), never
//   a guess.
//
// Every change is textual: one open tag's attribute rewritten where it
// stands, or one node's text spliced, so the author's bytes and indentation
// around it survive.

import { locateSlide, sectionChildRanges, elementChildRanges, splitOpenTag } from '../tools/deck-html.mjs';
import { escapeHtml } from '../tools/escape.mjs';

/** The page and the file disagree about what is where: a 409, not a bad request. */
export const stale = (message) => Object.assign(new Error(message), { code: 'STALE' });

/** `path` if it is one (`nested`: below the element, never the element itself), or a 400. */
export function checkPath(path, { nested = false } = {}) {
  if (!Array.isArray(path) || (nested && !path.length) || path.length > 16 || path.some((n) => !Number.isInteger(n) || n < 0)) throw new Error('bad path');
  return path;
}

/** Look up element `index` (raw child position) on slide `slide`, or throw. */
export function locateElement(html, slide, index) {
  const { parts, idx } = locateSlide(html, slide);
  const seg = parts[idx];
  const ranges = sectionChildRanges(seg);
  const r = ranges[index];
  if (!r) throw new Error(`slide ${slide}: no element at index ${index} (has ${ranges.length})`);
  return { parts, idx, seg, r };
}

const tagAt = (s) => /^<([a-zA-Z][\w:-]*)/.exec(s)?.[1]?.toLowerCase() ?? null;

/**
 * The node at `path` below `el` (a slide element's source): its offsets in
 * `el`, its tag, and the nodes on the way down (`el` first, its parent last),
 * so a caller can ask whether it sits in a diagram and what holds it. A path
 * the file does not have, or one that lands on another tag than the page saw,
 * is stale.
 */
export function nodeAt(el, path, { slide, index, tag = null }) {
  checkPath(path);
  let start = 0; let end = el.length;
  const chain = [];
  for (const n of path) {
    chain.push({ start, end, tag: tagAt(el.slice(start, end)) });
    const kid = elementChildRanges(el.slice(start, end))[n];
    if (!kid) throw stale(`slide ${slide} #${index}: the file has no element at ${path.join('.')} — the engine drew this one, or the deck changed; reload and try again`);
    end = start + kid.end; start += kid.start;
  }
  const found = tagAt(el.slice(start, end));
  if (tag && found !== String(tag).toLowerCase()) {
    throw stale(`slide ${slide} #${index}: the page found <${tag}> at ${path.join('.') || 'the element'}, the file has <${found}> — reload and try again`);
  }
  const svgAt = chain.map((c) => c.tag).lastIndexOf('svg');
  return { start, end, found, chain, parent: chain.at(-1) ?? null, svg: svgAt < 0 ? null : chain[svgAt], inSvg: svgAt >= 0 };
}

/**
 * Slide N's element `index`, open for an edit: `el` is its source, changed
 * through `splice` and `edit`, and `html()` is the deck with it put back.
 *
 *   at(path, tag)        the node there (nodeAt), offsets into `el` as it is now
 *   src(at)              that node's source
 *   splice(s, e, text)   `el` with [s, e) replaced
 *   edit(path, tag, fn)  that node's open tag made `fn(attrs, at)`, the rest kept
 *   lead(at)             what stands before the node on its line, read in the
 *                        slide (the node may be the element itself): only
 *                        spaces when it begins the line
 */
export function openElement(html, slide, index) {
  const { parts, idx, seg, r } = locateElement(html, slide, index);
  const e = {
    el: seg.slice(r.start, r.end),
    at: (path, tag = null) => nodeAt(e.el, path, { slide, index, tag }),
    src: (at) => e.el.slice(at.start, at.end),
    splice(start, end, text) { e.el = e.el.slice(0, start) + text + e.el.slice(end); },
    edit(path, tag, fn) {
      const at = e.at(path, tag);
      const { attrs, close, rest } = splitOpenTag(e.src(at));
      e.splice(at.start, at.end, fn(attrs, at) + close + rest);
      return at;
    },
    lead(at) {
      const abs = r.start + at.start;
      return seg.slice(seg.lastIndexOf('\n', abs - 1) + 1, abs);
    },
    html() { parts[idx] = seg.slice(0, r.start) + e.el + seg.slice(r.end); return parts.join(''); },
  };
  return e;
}

// ── one attribute on an open tag ───────────────────────────────────────────

/** The text a run of markup reads as: the entities a label or an attribute is likely to carry, decoded. */
export const decodeText = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k];
});

/** The attributes of an open tag's text (`<rect x="1" …`, no `>`), each with where it stands, so one can be changed in place. */
export function attrList(attrs) {
  const out = [];
  const head = /^<[a-zA-Z][\w:-]*/.exec(attrs);
  const re = /(\s+)([^\s=/>"']+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>"']+))?/y;
  re.lastIndex = head ? head[0].length : 0;
  for (let m = re.exec(attrs); m; m = re.exec(attrs)) {
    const raw = m[3] ?? null;
    out.push({ name: m[2].toLowerCase(), written: m[2], lead: m[1], start: m.index, end: re.lastIndex, raw,
      value: raw === null ? '' : /^["']/.test(raw) ? raw.slice(1, -1) : raw });
  }
  return out;
}

/** What attribute `name` says on an open tag's text, its entities read (`a&amp;b.png` is `a&b.png`), or null. */
export function attrOf(attrs, name) {
  const a = attrList(attrs).find((x) => x.name === name);
  return a ? decodeText(a.value) : null;
}

/**
 * An open tag's text with attribute `name` set to `value` where it stands (its
 * quote and the space before it kept), or added last; null takes it off. The
 * value is escaped the one way every attribute is (escapeHtml: `&`, `<`, `>`
 * and `"`; a `'` too inside single quotes), so what attrOf reads back is what
 * was set: alt text with an ampersand, a name, a number alike. `true` writes
 * the attribute bare (`data-build-stay`, `controls`), its value dropped if it
 * had one, its spelling and the space before it kept.
 */
export function withAttr(attrs, name, value) {
  const a = attrList(attrs).find((x) => x.name === name);
  if (value === null) return a ? attrs.slice(0, a.start) + attrs.slice(a.end) : attrs;
  if (value === true) {
    if (a) return attrs.slice(0, a.start) + `${a.lead}${a.written}` + attrs.slice(a.end);
    const tail = /\s*$/.exec(attrs)[0];
    return `${attrs.slice(0, attrs.length - tail.length)} ${name}${tail}`;
  }
  const q = a?.raw?.[0] === "'" ? "'" : '"';
  let v = escapeHtml(value);
  if (q === "'") v = v.replace(/'/g, '&#39;');
  if (a) return attrs.slice(0, a.start) + `${a.lead}${a.written}=${q}${v}${q}` + attrs.slice(a.end);
  const tail = /\s*$/.exec(attrs)[0];
  return `${attrs.slice(0, attrs.length - tail.length)} ${name}="${v}"${tail}`;
}

/** `style` text with `prop` set to `value` (null: taken off) — its old declaration replaced, the rest kept in order. */
export function withStyleProp(style, prop, value) {
  const kept = String(style ?? '').split(';').map((d) => d.trim()).filter(Boolean)
    .filter((d) => d.slice(0, d.indexOf(':')).trim().toLowerCase() !== prop);
  return (value === null ? kept : [...kept, `${prop}: ${value}`]).join('; ');
}

/** An open tag's text with one declaration of its `style` set (null: taken off), and a `style` left empty gone. */
export const withStyle = (attrs, prop, value) => withAttr(attrs, 'style', withStyleProp(attrOf(attrs, 'style'), prop, value) || null);

// ── one node out ────────────────────────────────────────────────────────────

/**
 * `text` without the nodes at `ranges` (`[[start, end]…]`): each with its line
 * when it stood alone on one, so the file is left without a blank one. The
 * last goes first, so the offsets before it hold.
 */
export function withoutNodes(text, ranges) {
  let out = text;
  for (let [s, e] of [...ranges].sort((a, b) => b[0] - a[0])) {
    const lineStart = out.lastIndexOf('\n', s - 1) + 1;
    const nl = out.indexOf('\n', e);
    const lineEnd = nl < 0 ? out.length : nl;
    if (/^[ \t]*$/.test(out.slice(lineStart, s)) && /^[ \t]*$/.test(out.slice(e, lineEnd)) && nl >= 0) { s = lineStart; e = nl + 1; }
    out = out.slice(0, s) + out.slice(e);
  }
  return out;
}
