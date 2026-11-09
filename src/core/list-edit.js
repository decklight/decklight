// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Lists and tables, edited like a document (PRESENTING_EDITING).
 *
 * While a bullet is edited in place, Enter makes the next point, Backspace at
 * the start of one joins it to the one before, Tab and Shift-Tab nest it and
 * take it out again; in a table Tab walks the cells and a menu adds and
 * deletes rows and columns. Every one of those changes is made HERE, on the
 * element's SOURCE markup, never on what the browser's contenteditable made
 * of it: the file gets the author's own tags and attributes, and nothing a
 * browser writes on its own (`<div>`, `<br>`, `&nbsp;`, `style=`).
 *
 * Pure: no DOM. The markup is read into a small tree whose every node keeps
 * its own bytes (an element its open and close tag as written, a text node
 * its raw text, entities and all), so serialising an untouched part gives
 * back exactly what was read. authoring.js does the page's half: the caret,
 * the live list, the one write at the end of the session.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const OPAQUE = new Set(['script', 'style', 'textarea', 'title']);
/** What may not sit in a list item's words: a block, which a split or a join cannot honestly cut. */
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
  'li', 'dd', 'dt', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'caption', 'colgroup']);
/** Inline content with no words of its own a caret could stand inside: never cut. */
const ATOMIC = new Set(['img', 'svg', 'math', 'video', 'audio', 'canvas', 'iframe', 'object', 'embed', 'picture', 'input', 'br', 'wbr']);
const LISTS = new Set(['ul', 'ol']);

// ── the tree ────────────────────────────────────────────────────────────────

/** An element node: `open` and `close` are its tags as written; a void one has no close. */
export const mkEl = (tag, open = `<${tag}>`, close = VOID.has(tag) ? '' : `</${tag}>`, kids = []) => ({ t: 'el', tag, open, close, kids });
const mkText = (raw) => ({ t: 'text', raw });
const isEl = (n, tag) => n?.t === 'el' && (tag === undefined || (typeof tag === 'string' ? n.tag === tag : tag.has(n.tag)));
const isWs = (n) => n?.t === 'text' && /^[ \t\n\r\f]*$/.test(n.raw);

function tagEnd(s, at) {
  let q = null;
  for (let j = at + 1; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') return j;
  }
  return s.length - 1;
}

/**
 * `html` as a list of nodes. Forgiving where markup is (a stray close tag is
 * text, an unclosed element ends at the end), exact where it is not: every
 * byte read lands in exactly one node, so `serialize(parseMarkup(s)) === s`.
 */
export function parseMarkup(html) {
  const s = String(html ?? '');
  let i = 0;
  // `above`: the tags still open above, so a close tag for one of them ends
  // everything inside it (`<li>` never closed before `</ul>`)
  function readKids(closeTag, above = []) {
    const kids = [];
    let text = '';
    const flush = () => { if (text) { kids.push(mkText(text)); text = ''; } };
    while (i < s.length) {
      if (s[i] !== '<') { text += s[i++]; continue; }
      if (s.startsWith('<!--', i)) {
        flush();
        const e = s.indexOf('-->', i + 4);
        const end = e < 0 ? s.length : e + 3;
        kids.push({ t: 'comment', raw: s.slice(i, end) });
        i = end;
        continue;
      }
      if (s[i + 1] === '/') {
        const m = /^<\/([a-zA-Z][\w:-]*)\s*>/.exec(s.slice(i));
        if (m && closeTag && m[1].toLowerCase() === closeTag) { flush(); i += m[0].length; return { kids, close: m[0] }; }
        if (m && above.includes(m[1].toLowerCase())) { flush(); return { kids, close: '' }; }
        text += s[i++];
        continue;
      }
      const m = /^<([a-zA-Z][\w:-]*)/.exec(s.slice(i));
      if (!m) { text += s[i++]; continue; }
      flush();
      const tag = m[1].toLowerCase();
      const end = tagEnd(s, i);
      const open = s.slice(i, end + 1);
      i = end + 1;
      if (VOID.has(tag) || open.endsWith('/>')) { kids.push(mkEl(tag, open, '')); continue; }
      if (OPAQUE.has(tag)) {
        const at = s.toLowerCase().indexOf(`</${tag}`, i);
        const stop = at < 0 ? s.length : at;
        const close = at < 0 ? '' : s.slice(at, tagEnd(s, at) + 1);
        kids.push(mkEl(tag, open, close, stop > i ? [mkText(s.slice(i, stop))] : []));
        i = stop + close.length;
        continue;
      }
      const inner = readKids(tag, closeTag ? [...above, closeTag] : above);
      kids.push(mkEl(tag, open, inner.close ?? '', inner.kids));
    }
    flush();
    return { kids, close: null };
  }
  return readKids(null).kids;
}

/** The nodes back as markup: exactly the bytes read, for whatever an edit did not touch. */
export function serialize(nodes) {
  let out = '';
  for (const n of nodes ?? []) out += n.t === 'el' ? n.open + serialize(n.kids) + n.close : n.raw;
  return out;
}

const clone = (n) => (n.t === 'el' ? { ...n, kids: n.kids.map(clone) } : { ...n });

/** `open` without the attributes named: a copy of a tag never carries the original's `id`. */
export function dropAttrs(open, names) {
  const drop = new Set(names);
  return open.replace(/\s+([^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g, (m, name) => (drop.has(name.toLowerCase()) ? '' : m));
}
const attrOf = (open, name) => {
  const m = new RegExp(`\\s${name}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+)))?`, 'i').exec(open);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
};

// ── words: length, cut, join, trim ──────────────────────────────────────────

const ENTITY = /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi;
/** The characters a raw text stands for, as the page's text counts them: an entity is one. */
const rawLength = (raw) => raw.replace(ENTITY, '_').length;
/** The raw text cut at character `at` (an entity is never split). */
function cutRaw(raw, at) {
  let n = 0;
  for (let i = 0; i < raw.length;) {
    if (n === at) return [raw.slice(0, i), raw.slice(i)];
    if (raw[i] === '&') {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(raw);
      if (m && m.index === i) { i += m[0].length; n++; continue; }
    }
    i++; n++;
  }
  return [raw, ''];
}

/** How many characters of words the nodes hold (what a caret offset counts). */
export function textLength(nodes) {
  let n = 0;
  for (const k of nodes ?? []) n += k.t === 'text' ? rawLength(k.raw) : k.t === 'el' && !ATOMIC.has(k.tag) ? textLength(k.kids) : 0;
  return n;
}
const hasAtomic = (nodes) => (nodes ?? []).some((k) => isEl(k) && (ATOMIC.has(k.tag) && k.tag !== 'br' ? true : hasAtomic(k.kids)));

/**
 * The inline nodes cut at character `offset`: `[before, after]`. An element
 * the cut falls inside is split into two of the same tag, attributes and all,
 * so `<strong>bo|ld</strong>` gives `<strong>bo</strong>` and
 * `<strong>ld</strong>`; one the cut only touches stays whole on its side.
 */
export function splitInline(nodes, offset) {
  const before = [], after = [];
  let at = 0;
  for (const n of nodes ?? []) {
    const len = n.t === 'text' ? rawLength(n.raw) : isEl(n) && !ATOMIC.has(n.tag) ? textLength(n.kids) : 0;
    if (n.t === 'comment') { (offset > at ? before : after).push(clone(n)); continue; }
    // a node the cut only touches stays whole: before the cut goes after it
    if (offset <= at) { after.push(clone(n)); at += len; continue; }
    if (offset >= at + len) { before.push(clone(n)); at += len; continue; }
    if (n.t === 'text') {
      const [a, b] = cutRaw(n.raw, offset - at);
      before.push(mkText(a)); after.push(mkText(b));
    } else {
      const [a, b] = splitInline(n.kids, offset - at);
      before.push({ ...n, kids: a }); after.push({ ...n, kids: b });
    }
    at += len;
  }
  return [before, after];
}

/**
 * `a` then `b`, as one run of words: where the seam has the same element on
 * both sides (a split's two halves of one `<strong>`) the two become one
 * again, and two texts meeting become one text.
 */
export function joinInline(a, b) {
  const out = (a ?? []).map(clone);
  for (const n of (b ?? []).map(clone)) {
    const last = out[out.length - 1];
    if (n.t === 'text' && last?.t === 'text') last.raw += n.raw;
    else if (isEl(n) && isEl(last) && n.open === last.open && n.close && last.close && !ATOMIC.has(n.tag)) last.kids = joinInline(last.kids, n.kids);
    else out.push(n);
  }
  return out;
}

const WS_END = /(?:[ \t\n\r\f]|&nbsp;| )+$/;
const WS_START = /^(?:[ \t\n\r\f]|&nbsp;| )+/;
/** The nodes without the white space at one end, reaching into elements that end (or start) with it. */
export function trimInline(nodes, side = 'both') {
  let out = (nodes ?? []).map(clone);
  const one = (list, end) => {
    while (list.length) {
      const i = end ? list.length - 1 : 0;
      const n = list[i];
      if (n.t === 'text') {
        n.raw = n.raw.replace(end ? WS_END : WS_START, '');
        if (n.raw) return list;
        list.splice(i, 1);
        continue;
      }
      if (isEl(n, 'br')) { list.splice(i, 1); continue; }
      if (isEl(n) && !ATOMIC.has(n.tag) && n.close) {
        const was = n.kids.length;
        one(n.kids, end);
        if (!n.kids.length && was) { list.splice(i, 1); continue; }
      }
      return list;
    }
    return list;
  };
  if (side !== 'start') out = one(out, true);
  if (side !== 'end') out = one(out, false);
  return out;
}

const EMPHASIS = new Set(['strong', 'em', 'code', 'b', 'i', 'u', 's', 'mark', 'span', 'font', 'small', 'sub', 'sup']);
/**
 * What the browser made of an item's words, as the file should have them.
 * contenteditable writes its own furniture: a `<br>` to hold an empty line
 * open, a `<div>` round a pasted line, a `<span style>` or `<font>` when two
 * runs of different look meet, `&nbsp;` for a space it feared would
 * collapse. All of it goes, the author's own tags stay; a `style=` stays
 * only when the item had one in the file. A `<b>` or `<i>` is the author's:
 * the browser never writes one here, since ⌘B and ⌘I write `<strong>` and
 * `<em>` themselves (authoring.js), and a deck written with `<b>` keeps it.
 */
export function cleanInline(html, { keepStyle = false } = {}) {
  const walk = (nodes) => {
    const out = [];
    for (const n of nodes) {
      if (n.t === 'text') {
        // a run of spaces the browser kept open with &nbsp; is one space; a
        // single &nbsp; at a run's edge was a space before a tag
        let raw = n.raw.replace(/(?:&nbsp;| | ){2,}/g, (m) => (/&nbsp;| /.test(m) ? ' ' : m));
        raw = raw.replace(/^(?:&nbsp;| )/, ' ').replace(/(?:&nbsp;| )$/, ' ');
        out.push(mkText(raw));
        continue;
      }
      if (n.t !== 'el') { out.push(n); continue; }
      let el = { ...n, kids: walk(n.kids) };
      if (!keepStyle) el.open = dropAttrs(el.open, ['style']);
      const bare = /^<[\w:-]+\s*\/?>$/.test(el.open);
      if (el.tag === 'div' || el.tag === 'p' || el.tag === 'font' || (el.tag === 'span' && bare)) { out.push(...el.kids); continue; }
      // an emptied emphasis is nothing the author wrote: `<strong></strong>`
      if (EMPHASIS.has(el.tag) && bare && !el.kids.length) continue;
      out.push(el);
    }
    return out;
  };
  const nodes = trimInline(walk(parseMarkup(html)));
  // an item that holds only a line break holds nothing
  return textLength(nodes) === 0 && !hasAtomic(nodes) ? '' : serialize(nodes);
}

// ── lists ───────────────────────────────────────────────────────────────────

const itemsOf = (list) => list.kids.filter((k) => isEl(k, 'li'));
/** A list item's two halves: the words (white space before a sublist left out) and its sublist, or null. */
export function liParts(li) {
  const k = li.kids.findIndex((n) => isEl(n, LISTS));
  if (k < 0) return { inline: li.kids, sub: null };
  return { inline: trimInline(li.kids.slice(0, k), 'end'), sub: li.kids[k] };
}
const setLiParts = (li, inline, sub) => { li.kids = [...inline, ...(sub ? [sub] : [])]; };

/** Is the list one this editor can cut and join: items of words, each with at most one sublist after them? */
function simple(list) {
  for (const k of list.kids) {
    if (isWs(k) || k.t === 'comment') continue;
    if (!isEl(k, 'li')) return false;
    const at = k.kids.findIndex((n) => isEl(n, LISTS));
    const inline = at < 0 ? k.kids : k.kids.slice(0, at);
    const deep = (nodes) => nodes.every((n) => !isEl(n) || (!BLOCK.has(n.tag) && (ATOMIC.has(n.tag) || deep(n.kids))));
    if (!deep(inline)) return false;
    if (at >= 0) {
      const rest = k.kids.slice(at + 1);
      if (!rest.every((n) => isWs(n) || n.t === 'comment')) return false;
      if (!simple(k.kids[at])) return false;
    }
  }
  return true;
}

/**
 * A `<ul>`/`<ol>`'s source, ready to edit: `{ root, ... }` with a `key` on
 * every list and item (numbered in document order, so reading the same
 * source twice numbers it the same), or null when the list is not one this
 * editor can honestly cut (an item holding a paragraph, a table, a second
 * sublist): there the old edit stands, Enter keeping the words.
 */
export function listDoc(html) {
  const nodes = parseMarkup(String(html ?? '').trim());
  const root = nodes.find((n) => n.t === 'el');
  if (!isEl(root, LISTS) || !simple(root)) return null;
  let next = 0;
  const number = (n) => { if (isEl(n, LISTS) || isEl(n, 'li')) n.key = ++next; if (isEl(n)) n.kids.forEach(number); };
  number(root);
  // the file's own layout, to lay out what an edit moves the same way
  const multiline = (function any(list) {
    return list.kids.some((k) => (isWs(k) && k.raw.includes('\n')) || (isEl(k, 'li') && (() => { const s = liParts(k).sub; return s && any(s); })()));
  })(root);
  const lastWs = isWs(root.kids[root.kids.length - 1]) ? root.kids[root.kids.length - 1].raw : '';
  const base = multiline ? lastWs.slice(lastWs.lastIndexOf('\n') + 1) : '';
  const first = root.kids.findIndex((k) => isEl(k, 'li'));
  const lead = first > 0 && isWs(root.kids[first - 1]) ? root.kids[first - 1].raw : '';
  const liIndent = lead.slice(lead.lastIndexOf('\n') + 1);
  const step = multiline && liIndent.length > base.length && liIndent.startsWith(base) ? liIndent.slice(base.length) : '  ';
  return { root, next, multiline, base, step };
}

/** The item `key` names, with its list, the item holding that list (null at the top) and its place. */
export function findItem(doc, key) {
  const walk = (list, parentLi) => {
    for (const li of itemsOf(list)) {
      if (li.key === key) return { li, list, parentLi };
      const { sub } = liParts(li);
      const hit = sub && walk(sub, li);
      if (hit) return hit;
    }
    return null;
  };
  return walk(doc.root, null);
}

/** The list that holds `list` as some item's sublist, with that item. */
function parentOf(doc, list) {
  const walk = (l) => {
    for (const li of itemsOf(l)) {
      const { sub } = liParts(li);
      if (sub === list) return { list: l, li };
      const hit = sub && walk(sub);
      if (hit) return hit;
    }
    return null;
  };
  return walk(doc.root);
}

/** Lay the list out again, the file's way: one item a line indented by depth, or all on one line as it was. */
function layout(doc) {
  const put = (list, depth) => {
    const ind = (d) => doc.base + doc.step.repeat(d);
    const out = [];
    for (const k of list.kids) {
      if (isWs(k)) continue;
      if (doc.multiline) out.push(mkText(`\n${ind(depth + 1)}`));
      out.push(k);
      if (isEl(k, 'li')) {
        const { inline, sub } = liParts(k);
        if (sub) {
          put(sub, depth + 2);
          k.kids = doc.multiline ? [...inline, mkText(`\n${ind(depth + 2)}`), sub, mkText(`\n${ind(depth + 1)}`)] : [...inline, sub];
        } else {
          k.kids = inline;
        }
      }
    }
    if (doc.multiline) out.push(mkText(`\n${ind(depth)}`));
    list.kids = out;
  };
  put(doc.root, 0);
}

const removeKid = (parent, node) => { parent.kids = parent.kids.filter((k) => k !== node); };
const insertAfter = (parent, ref, ...nodes) => { const i = parent.kids.indexOf(ref); parent.kids.splice(i + 1, 0, ...nodes); };
const newKey = (doc) => ++doc.next;
const freshList = (doc, tag) => Object.assign(mkEl(tag), { key: newKey(doc) });

/** What an item is, for the keys to decide on: empty, last in its list, at the top, the list's only one. */
export function itemFacts(doc, key) {
  const f = findItem(doc, key);
  if (!f) return null;
  const { inline } = liParts(f.li);
  const items = itemsOf(f.list);
  return {
    empty: textLength(inline) === 0 && !hasAtomic(inline),
    last: items[items.length - 1] === f.li,
    first: items[0] === f.li,
    top: f.list === doc.root,
    only: f.list === doc.root && items.length === 1,
    length: textLength(inline),
  };
}

/**
 * Enter: item `key` cut at character `offset`, the words after it moving to a
 * new item after it (its sublist going with them, as the lines under it do
 * in a document). The new item is a copy of the old one's tag, less the
 * `id` and the `data-build-order` that would make two of one. Returns where
 * the caret goes: `{ key, offset }`.
 */
export function splitItem(doc, key, offset, { words = null, clean = null } = {}) {
  const f = findItem(doc, key);
  if (!f) return null;
  const { inline, sub } = liParts(f.li);
  // `words`: the item's words as the page has them now (what was typed), cut
  // where its caret is, each half then `clean`ed for the file
  const cut = words === null ? inline : parseMarkup(words);
  const [a, b] = splitInline(cut, Math.max(0, Math.min(offset, textLength(cut))));
  const tidy = (half, side) => (clean ? parseMarkup(clean(serialize(half))) : trimInline(half, side));
  const li = Object.assign(mkEl('li', dropAttrs(f.li.open, ['id', 'data-build-order']), f.li.close || '</li>'), { key: newKey(doc) });
  setLiParts(f.li, tidy(a, 'end'), null);
  setLiParts(li, tidy(b, 'start'), sub);
  insertAfter(f.list, f.li, li);
  layout(doc);
  return { key: li.key, offset: 0 };
}

/** The item a caret at the start of `key` goes back to: the one above it as it reads, or null at the very top. */
function itemAbove(doc, f) {
  const items = itemsOf(f.list);
  const i = items.indexOf(f.li);
  if (i > 0) {
    let p = items[i - 1];
    for (let s = liParts(p).sub; s && itemsOf(s).length; s = liParts(p).sub) p = itemsOf(s)[itemsOf(s).length - 1];
    return { above: p, sibling: items[i - 1] };
  }
  return f.parentLi ? { above: f.parentLi, sibling: null } : null;
}

/**
 * Backspace at the start of item `key`: its words join the end of the item
 * above it (an empty item simply goes), and its own sublist stays where it
 * read, under that item. Null when there is nothing above to join.
 */
export function mergeItem(doc, key) {
  const f = findItem(doc, key);
  if (!f) return null;
  const up = itemAbove(doc, f);
  if (!up) return null;
  const { above, sibling } = up;
  const was = liParts(above);
  const at = textLength(was.inline);
  const mine = liParts(f.li);
  setLiParts(above, joinInline(was.inline, mine.inline), was.sub);
  const kids = mine.sub ? itemsOf(mine.sub) : [];
  if (sibling) {
    removeKid(f.list, f.li);
    if (kids.length) {
      const s = liParts(sibling);
      if (s.sub) s.sub.kids.push(...kids);
      else setLiParts(sibling, s.inline, mine.sub);
    }
  } else {
    // the first of a sublist: its sublist's items take its place
    const i = f.list.kids.indexOf(f.li);
    f.list.kids.splice(i, 1, ...kids);
  }
  dropEmpty(doc, f.list);
  layout(doc);
  return { key: above.key, offset: at };
}

/** A sublist left with no items goes, rather than stay as an empty `<ul></ul>`. */
function dropEmpty(doc, list) {
  if (list === doc.root || itemsOf(list).length) return;
  const p = parentOf(doc, list);
  if (p) setLiParts(p.li, liParts(p.li).inline, null);
}

/** Item `key` out of the list, its sublist with it. */
export function removeItem(doc, key) {
  const f = findItem(doc, key);
  if (!f) return null;
  removeKid(f.list, f.li);
  dropEmpty(doc, f.list);
  layout(doc);
  return true;
}

/**
 * Tab: item `key` goes under the item before it, last in that item's
 * sublist, or in a new one of its own list's type. Its own sublist goes
 * with it. Null for the first item of a list, which has nothing to go under.
 */
export function indentItem(doc, key) {
  const f = findItem(doc, key);
  if (!f) return null;
  const items = itemsOf(f.list);
  const i = items.indexOf(f.li);
  if (i < 1) return null;
  const prev = items[i - 1];
  removeKid(f.list, f.li);
  const p = liParts(prev);
  if (p.sub) p.sub.kids.push(f.li);
  else {
    const sub = freshList(doc, f.list.tag);
    sub.kids = [f.li];
    setLiParts(prev, p.inline, sub);
  }
  layout(doc);
  return { key };
}

/**
 * Shift-Tab: item `key` comes out of its sublist to sit after the item that
 * held it; the items that followed it there become its own sublist, so the
 * list still reads in the same order. Null at the top level.
 */
export function outdentItem(doc, key) {
  const f = findItem(doc, key);
  if (!f || !f.parentLi) return null;
  const grand = parentOf(doc, f.list)?.list ?? doc.root;
  const items = itemsOf(f.list);
  const after = items.slice(items.indexOf(f.li) + 1);
  for (const n of [f.li, ...after]) removeKid(f.list, n);
  if (after.length) {
    const mine = liParts(f.li);
    if (mine.sub) mine.sub.kids.push(...after);
    else {
      const sub = Object.assign(mkEl(f.list.tag, f.list.open, f.list.close), { key: newKey(doc) });
      sub.kids = after;
      setLiParts(f.li, mine.inline, sub);
    }
  }
  insertAfter(grand, f.parentLi, f.li);
  dropEmpty(doc, f.list);
  layout(doc);
  return { key };
}

/** Item `key`'s words replaced by `html` (what was typed, cleaned). */
export function setItemWords(doc, key, html) {
  const f = findItem(doc, key);
  if (!f) return false;
  setLiParts(f.li, parseMarkup(html), liParts(f.li).sub);
  return true;
}

/** The list's markup as the file should have it. */
export const listHtml = (doc) => serialize([doc.root]);

/** Every list and item of the doc in reading order, for the page to lay its own list out by. */
export function listShape(doc) {
  const walk = (list) => ({
    key: list.key, tag: list.tag, open: list.open,
    items: itemsOf(list).map((li) => {
      const { inline, sub } = liParts(li);
      return { key: li.key, open: li.open, html: serialize(inline), sub: sub ? walk(sub) : null };
    }),
  });
  return walk(doc.root);
}

// ── tables ──────────────────────────────────────────────────────────────────

const SECTIONS = new Set(['thead', 'tbody', 'tfoot']);
const CELLS = new Set(['td', 'th']);
const cellsOf = (tr) => tr.kids.filter((k) => isEl(k, CELLS));
/** A table's rows in reading order, each with the element that holds it: `[{ tr, parent }]`. */
function rowsOf(table) {
  const out = [];
  for (const k of table.kids) {
    if (isEl(k, 'tr')) out.push({ tr: k, parent: table });
    else if (isEl(k, SECTIONS)) for (const r of k.kids) if (isEl(r, 'tr')) out.push({ tr: r, parent: k });
  }
  return out;
}
function tableOf(html) {
  const nodes = parseMarkup(String(html ?? '').trim());
  const table = nodes.find((n) => n.t === 'el');
  if (!isEl(table, 'table')) throw new Error('that is not a table');
  return { nodes, table };
}
const spans = (table) => rowsOf(table).some(({ tr }) => cellsOf(tr).some((c) => Number(attrOf(c.open, 'colspan') ?? 1) > 1 || Number(attrOf(c.open, 'rowspan') ?? 1) > 1));

/** How many cells each row of a table has: the page checks the file's table is the one it shows. */
export function tableShape(html) {
  return rowsOf(tableOf(html).table).map(({ tr }) => cellsOf(tr).length);
}

/** A node put next to `ref` in `parent`, with the white space that stands before `ref`, so the file keeps its layout. */
function placeBeside(parent, ref, node, after) {
  const i = parent.kids.indexOf(ref);
  const ws = isWs(parent.kids[i - 1]) ? mkText(parent.kids[i - 1].raw) : null;
  if (after) parent.kids.splice(i + 1, 0, ...(ws ? [ws] : []), node);
  else parent.kids.splice(i, 0, node, ...(ws ? [ws] : []));
}
/** A node out of `parent`, with the white space before it (after it, for the first). */
function takeOut(parent, node) {
  const i = parent.kids.indexOf(node);
  if (i < 0) return;
  if (isWs(parent.kids[i - 1])) parent.kids.splice(i - 1, 2);
  else if (isWs(parent.kids[i + 1]) && parent.kids.slice(0, i).every((k) => !isEl(k))) parent.kids.splice(i, 2);
  else parent.kids.splice(i, 1);
}
const emptyCell = (c) => mkEl(c.tag, dropAttrs(c.open, ['id']), c.close || `</${c.tag}>`);
/** A row like `tr`, every cell empty: the same cell tags in the same places, the file's white space between them. */
const emptyRow = (tr) => ({ ...tr, open: dropAttrs(tr.open, ['id']), kids: tr.kids.filter((k) => isWs(k) || isEl(k, CELLS)).map((k) => (isEl(k) ? emptyCell(k) : mkText(k.raw))) });

/**
 * One of the table menu's six changes, on the table's source: `row-above`,
 * `row-below`, `col-left`, `col-right`, `row-delete`, `col-delete`, at the
 * cell in row `row` (reading order, header rows included) and column `col`.
 * A new row copies the cell tags of the one it is put beside (a row added
 * below the header is a body row); a new column copies, in every row, the
 * cell it is put beside, so a header keeps a `<th>`. A table that merges
 * cells (`colspan`, `rowspan`) is refused: which column a merged cell is in
 * has no one answer. Returns the table's new markup.
 */
export function tableOp(html, op, row, col) {
  const { nodes, table } = tableOf(html);
  if (spans(table)) throw new Error('this table merges cells (colspan or rowspan): change it in Edit content (HTML)');
  const rows = rowsOf(table);
  const at = rows[row];
  if (!at) throw new Error(`the table has no row ${row + 1}`);
  if (op === 'row-above' || op === 'row-below') {
    // below a header row, the new row is the body's first, shaped like it
    const body = rows.find((r) => r.parent !== at.parent && r.parent.tag === 'tbody');
    if (op === 'row-below' && at.parent.tag === 'thead' && body && rows.indexOf(body) === row + 1) placeBeside(body.parent, body.tr, emptyRow(body.tr), false);
    else placeBeside(at.parent, at.tr, emptyRow(at.tr), op === 'row-below');
  } else if (op === 'row-delete') {
    if (rows.length < 2) throw new Error('a table keeps at least one row: remove the table instead');
    takeOut(at.parent, at.tr);
    if (at.parent !== table && !at.parent.kids.some((k) => isEl(k, 'tr'))) takeOut(table, at.parent);
  } else if (op === 'col-left' || op === 'col-right' || op === 'col-delete') {
    const width = Math.max(...rows.map((r) => cellsOf(r.tr).length));
    if (col < 0 || col >= width) throw new Error(`the table has no column ${col + 1}`);
    if (op === 'col-delete' && width < 2) throw new Error('a table keeps at least one column: remove the table instead');
    for (const { tr } of rows) {
      const cells = cellsOf(tr);
      const c = cells[Math.min(col, cells.length - 1)];
      if (!c) continue;
      if (op === 'col-delete') { if (cells[col]) takeOut(tr, cells[col]); } else placeBeside(tr, c, emptyCell(c), op === 'col-right' || col >= cells.length);
    }
    // a <colgroup> that names every column keeps naming every column
    for (const g of table.kids.filter((k) => isEl(k, 'colgroup'))) {
      const cols = g.kids.filter((k) => isEl(k, 'col'));
      if (cols.length !== width) continue;
      if (op === 'col-delete') takeOut(g, cols[col]);
      else placeBeside(g, cols[col], mkEl('col', dropAttrs(cols[col].open, ['id']), ''), op === 'col-right');
    }
  } else {
    throw new Error(`no such table change: ${op}`);
  }
  return serialize(nodes);
}

/**
 * A table editing session's changes, in one go: `append` rows added at the
 * end (Tab in the last cell), shaped like the last row, then each cell's new
 * words (`{ row, col, html }`, already cleaned). Returns the new markup.
 */
export function tableEdit(html, { append = 0, cells = [] } = {}) {
  let out = String(html ?? '').trim();
  for (let n = 0; n < append; n++) {
    const { nodes, table } = tableOf(out);
    const rows = rowsOf(table);
    const last = rows[rows.length - 1];
    placeBeside(last.parent, last.tr, emptyRow(last.tr), true);
    out = serialize(nodes);
  }
  const { nodes, table } = tableOf(out);
  const rows = rowsOf(table);
  for (const { row, col, html: words } of cells) {
    const c = rows[row] && cellsOf(rows[row].tr)[col];
    if (!c) throw new Error(`the table has no cell at row ${row + 1}, column ${col + 1}`);
    c.kids = parseMarkup(words);
  }
  return serialize(nodes);
}

// ── where in the element ────────────────────────────────────────────────────

/**
 * The node `path` names inside the top-level element `html` (element
 * children, counted as the page counts them), when it is a `tag`:
 * `{ html, replace }`, its markup as the file has it and the top element's
 * markup with it replaced. Null when the path lands elsewhere: a stale path
 * is a refusal, never a guess. Everything outside the node keeps its bytes.
 */
export function elementAt(html, path, tag = null) {
  const nodes = parseMarkup(html);
  const top = nodes.find((n) => n.t === 'el');
  let cur = top, parent = null;
  for (const i of path ?? []) {
    parent = cur;
    cur = cur?.kids.filter((k) => k.t === 'el')[i];
  }
  if (!cur || (tag && cur.tag !== tag)) return null;
  return {
    html: serialize([cur]),
    replace(markup) {
      const fresh = parseMarkup(markup);
      if (!parent) return serialize(nodes.flatMap((n) => (n === cur ? fresh : [n])));
      parent.kids = parent.kids.flatMap((k) => (k === cur ? fresh : [k]));
      return serialize(nodes);
    },
  };
}
