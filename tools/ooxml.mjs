// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A small XML reader, for reading Office parts and nothing else.
//
// Regex would do for a flat scrape, and does not do here: a table cell holds
// paragraphs which hold runs, and "the paragraphs of this slide" has to mean
// something different from "the paragraphs inside its table". That is a tree
// question, so this builds a tree.
//
// Deliberately partial. No DTDs, no entities beyond the five predefined plus
// numeric, no namespace resolution (OOXML prefixes are fixed in practice —
// `a:`, `p:`, `r:` — so names are matched as written, which is what the
// documents actually use). Attribute values may be single- or double-quoted.

const NAME = /[A-Za-z_][\w.:-]*/y;

/** `&amp;` and friends — the five predefined entities, plus numeric refs. */
export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body] ?? m;
  });
}

function readAttrs(src, i, end) {
  const attrs = {};
  while (i < end) {
    while (i < end && /\s/.test(src[i])) i += 1;
    if (i >= end) break;
    NAME.lastIndex = i;
    const m = NAME.exec(src);
    if (!m) break;
    i = NAME.lastIndex;
    while (i < end && /\s/.test(src[i])) i += 1;
    if (src[i] !== '=') { attrs[m[0]] = ''; continue; }
    i += 1;
    while (i < end && /\s/.test(src[i])) i += 1;
    const quote = src[i];
    if (quote !== '"' && quote !== "'") break;
    const close = src.indexOf(quote, i + 1);
    if (close < 0) break;
    attrs[m[0]] = decodeEntities(src.slice(i + 1, close));
    i = close + 1;
  }
  return attrs;
}

/**
 * Parse XML into `{ name, attrs, children }` nodes; text becomes a child
 * `{ text }`. The return is a synthetic root holding the document element, so
 * a caller never has to care whether it wanted the document or its top tag.
 */
export function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));

    if (src.startsWith('<!--', lt)) { i = skipTo(lt, '-->'); continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      const stop = end < 0 ? n : end;
      pushText(src.slice(lt + 9, stop), true);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) { i = skipTo(lt, '?>'); continue; }   // <?xml …?>
    if (src.startsWith('<!', lt)) { i = skipTo(lt, '>'); continue; }    // <!DOCTYPE …>

    const gt = src.indexOf('>', lt);
    if (gt < 0) break;

    if (src[lt + 1] === '/') {                                          // </tag>
      const name = src.slice(lt + 2, gt).trim();
      // an unmatched close tag closes nothing rather than unwinding the stack:
      // a malformed part should lose one element, not the whole document
      for (let d = stack.length - 1; d > 0; d -= 1) {
        if (stack[d].name === name) { stack.length = d; break; }
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = src[gt - 1] === '/';
    NAME.lastIndex = lt + 1;
    const m = NAME.exec(src);
    if (!m) { i = gt + 1; continue; }
    const node = {
      name: m[0],
      attrs: readAttrs(src, NAME.lastIndex, selfClosing ? gt - 1 : gt),
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = gt + 1;
  }
  return root;

  function skipTo(from, marker) {
    const end = src.indexOf(marker, from);
    return end < 0 ? n : end + marker.length;
  }
  function pushText(raw, literal = false) {
    if (!raw) return;
    const text = literal ? raw : decodeEntities(raw);
    if (!text) return;
    stack[stack.length - 1].children.push({ text });
  }
}

const kids = (node) => node?.children ?? [];

/** Every descendant with this tag name, in document order. */
export function findAll(node, name, out = []) {
  for (const c of kids(node)) {
    if (c.name === name) out.push(c);
    if (c.children) findAll(c, name, out);
  }
  return out;
}

/** The first descendant with this tag name, or null. */
export function find(node, name) {
  for (const c of kids(node)) {
    if (c.name === name) return c;
    if (c.children) { const hit = find(c, name); if (hit) return hit; }
  }
  return null;
}

/** Direct children with this tag name — "the slide's shapes", not a table's. */
export function children(node, name) {
  return kids(node).filter((c) => c.name === name);
}

/** All text under a node, concatenated. */
export function textOf(node) {
  let out = '';
  for (const c of kids(node)) out += c.text ?? textOf(c);
  return out;
}
