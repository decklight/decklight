// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Turn into ▸ (PRESENTING_EDITING): a text block made another kind, Text,
 * Heading, Small heading, Quote, Bullets or Numbered, from the element menu.
 *
 * `retagBlock` is pure: the block's SOURCE in, the new markup out. What is
 * inside it (the words, their emphasis, a nested list) is carried as
 * written, byte for byte; only the tags around it change. Bullets to
 * numbered and back is the two tag names swapped (an `<ol>`'s `start`,
 * `type` and `reversed` dropped on the way to `<ul>`). A list made text, a
 * heading or a small heading is one block a point, each carrying the list's
 * attributes, so a build that was one step a point is still one step a
 * point; a list made a quote is one quote, and a build on it one step.
 */

import { parseMarkup, serialize, dropAttrs } from './list-edit.js';

/** The kinds, in the menu's order: `[kind, label, tag]`. */
export const KINDS = [
  ['text', 'Text', 'p'],
  ['heading', 'Heading', 'h2'],
  ['small', 'Small heading', 'h3'],
  ['quote', 'Quote', 'blockquote'],
  ['bullets', 'Bullets', 'ul'],
  ['numbered', 'Numbered', 'ol'],
];
const TAG_OF = Object.fromEntries(KINDS.map(([k, , t]) => [k, t]));
const INLINE = new Set(['p', 'h1', 'h2', 'h3', 'h4']);
const LIST = new Set(['ul', 'ol']);

/** The kind a tag is, or null for a block Turn into does not offer. */
export function kindOf(tag) {
  const t = String(tag ?? '').toLowerCase();
  if (t === 'p') return 'text';
  if (t === 'h1' || t === 'h2') return 'heading';
  if (t === 'h3' || t === 'h4') return 'small';
  if (t === 'blockquote') return 'quote';
  if (t === 'ul') return 'bullets';
  if (t === 'ol') return 'numbered';
  return null;
}

const els = (kids) => kids.filter((k) => k.t === 'el');
const blank = (kids) => kids.every((k) => k.t !== 'el' && !String(k.raw ?? '').trim());
/** `open` (`<tag …>`) as the same tag's attributes on another tag. */
const reopen = (open, tag) => open.replace(/^<[a-zA-Z][\w:-]*/, `<${tag}`);
const trimText = (s) => s.replace(/^\s+|\s+$/g, '');

/** Each point of a list as its words, a nested list's points after their parent's, in order. */
function points(list) {
  const out = [];
  for (const li of els(list.kids)) {
    if (li.tag !== 'li') continue;
    const own = li.kids.filter((k) => !(k.t === 'el' && LIST.has(k.tag)));
    out.push(trimText(serialize(own)));
    for (const sub of els(li.kids)) if (LIST.has(sub.tag)) out.push(...points(sub));
  }
  return out;
}

/** A quote's paragraphs as their words, or its whole inside as one. */
function paragraphs(quote) {
  const ps = els(quote.kids);
  if (ps.length && ps.every((p) => p.tag === 'p') && blank(quote.kids.filter((k) => k.t !== 'el'))) return ps.map((p) => trimText(serialize(p.kids)));
  return [trimText(serialize(quote.kids))];
}

/**
 * `html` (one block's markup) made kind `to`. Returns `{ html, blocks, build }`:
 * `blocks` is how many blocks it is now, `build` what a build on it does
 * now: 'same', or 'one' when a step a point became one step for all of them.
 * Throws for a block or a kind Turn into does not take.
 */
export function retagBlock(html, to) {
  const tag = TAG_OF[to];
  if (!tag) throw new Error(`not a kind a block turns into: ${to}`);
  const nodes = parseMarkup(String(html ?? ''));
  const el = nodes.find((n) => n.t === 'el');
  const from = el ? kindOf(el.tag) : null;
  if (!from) throw new Error('only text, a heading, a quote or a list turns into another kind');
  const before = serialize(nodes.slice(0, nodes.indexOf(el)));
  const after = serialize(nodes.slice(nodes.indexOf(el) + 1));
  const wrap = (s) => ({ ...s, html: before + s.html + after });
  if (from === to) return wrap({ html: serialize([el]), blocks: 1, build: 'same' });
  // the block's own indentation, read off its closing line when it spans several
  const lead = /\n([ \t]*)<\/[a-zA-Z][\w:-]*>\s*$/.exec(serialize([el]))?.[1];
  const nl = lead === undefined ? '' : `\n${lead}`;
  const inner = serialize(el.kids);
  const built = /\sdata-build\b/i.test(el.open);
  const open = (t) => reopen(LIST.has(el.tag) && t === 'ul' ? dropAttrs(el.open, ['start', 'type', 'reversed']) : el.open, t);

  // the same family: only the tag names change, the inside is the bytes it was
  if ((INLINE.has(el.tag) && INLINE.has(tag)) || (LIST.has(el.tag) && LIST.has(tag))) {
    return wrap({ html: open(tag) + inner + `</${tag}>`, blocks: 1, build: 'same' });
  }
  const pieces = LIST.has(el.tag) ? points(el) : el.tag === 'blockquote' ? paragraphs(el) : [trimText(inner)];
  if (!pieces.length) throw new Error('the block has nothing in it to turn into another kind');
  if (LIST.has(tag)) {
    // one point a paragraph; a quote of one paragraph is one point
    const items = pieces.map((p) => `<li>${p}</li>`);
    const body = nl ? `${nl}  ${items.join(`${nl}  `)}${nl}` : items.join('');
    const build = built && el.tag === 'blockquote' && pieces.length > 1 ? 'each' : 'same';
    return wrap({ html: open(tag) + body + `</${tag}>`, blocks: 1, build });
  }
  if (tag === 'blockquote') {
    if (pieces.length === 1) return wrap({ html: open(tag) + pieces[0] + '</blockquote>', blocks: 1, build: 'same' });
    const body = pieces.map((p) => `<p>${p}</p>`);
    return wrap({ html: open(tag) + (nl ? `${nl}  ${body.join(`${nl}  `)}${nl}` : body.join('')) + '</blockquote>', blocks: 1, build: built ? 'one' : 'same' });
  }
  // text, a heading or a small heading: one block a point or a paragraph, each
  // with the block's attributes (an id only on the first, an id being one)
  const one = (p, i) => `${i ? reopen(dropAttrs(el.open, ['id']), tag) : open(tag)}${p}</${tag}>`;
  return wrap({ html: pieces.map(one).join(nl || ''), blocks: pieces.length, build: 'same' });
}

/**
 * The kinds the menu offers a block: every one, its own ticked, and greyed
 * with the reason where the block is the slide's title (a title stays a
 * heading, or the slide has none).
 */
export function kindsFor(tag, { isTitle = false } = {}) {
  const cur = kindOf(tag);
  return KINDS.map(([kind, label]) => ({
    kind, label, current: kind === cur,
    disabled: isTitle && kind !== 'heading' ? 'the slide’s title stays a heading: the slide would have none' : null,
  }));
}

/** What several blocks can be joined into (Turn into ▸ with several selected): one list, or one quote. */
export const JOIN_KINDS = ['bullets', 'numbered', 'quote'];

/**
 * Several blocks (`htmls`, each one block's source, in slide order) joined
 * into ONE of kind `to`: a list with a point for each paragraph, heading or
 * point of theirs, or a quote with a paragraph for each. What is inside each
 * is carried as written. The markup comes back on several lines, indented
 * from its first, for the server to set at the first block's indent.
 * `build` says what a build means now: 'same' when every block built (the
 * list then builds a step a point, as they did), 'one' for a quote they all
 * built (it arrives whole), 'none' when none did, and 'some' when only some
 * did (the joined block takes none, and says so).
 */
export function joinBlocks(htmls, to) {
  if (!JOIN_KINDS.includes(to)) throw new Error(`several blocks join into a list or a quote, not: ${to}`);
  if (!Array.isArray(htmls) || htmls.length < 2) throw new Error('joining takes two blocks or more');
  const pieces = [];
  const builds = [];
  for (const html of htmls) {
    const el = parseMarkup(String(html ?? '')).find((n) => n.t === 'el');
    const kind = el ? kindOf(el.tag) : null;
    if (!kind) throw new Error('only text, headings, quotes and lists join into one');
    builds.push(/\sdata-build\b/i.test(el.open));
    if (LIST.has(el.tag)) pieces.push(...points(el));
    else if (el.tag === 'blockquote') pieces.push(...paragraphs(el));
    else pieces.push(trimText(serialize(el.kids)));
  }
  const kept = pieces.filter((p) => p !== '');
  if (!kept.length) throw new Error('the blocks have nothing in them to join');
  const all = builds.every(Boolean);
  const tag = TAG_OF[to];
  // a list keeps a step a point; a quote that builds arrives whole, one step for all of them
  const build = all ? (tag === 'blockquote' ? 'one' : 'same') : builds.some(Boolean) ? 'some' : 'none';
  const open = `<${tag}${all ? ' data-build' : ''}>`;
  const inner = kept.map((p) => (tag === 'blockquote' ? `<p>${p}</p>` : `<li>${p}</li>`));
  return { html: `${open}\n  ${inner.join('\n  ')}\n</${tag}>`, pieces: kept.length, build };
}
