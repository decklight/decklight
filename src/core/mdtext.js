// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// An agent's answer, as the markdown it was written in.
//
// The agents decklight drives (claude, codex, bob, …) end a job by saying what
// they did, and they say it in markdown: **bold** names, `code`, a heading, a
// list. Shown as plain text, the panel read `**slide 4**` with the asterisks.
//
// A SMALL subset, built as DOM nodes and never as markup: the text is the
// agent's, the agent read the deck, and the deck may be someone else's. So
// nothing here goes through innerHTML; a tag in the answer stays text. What it
// knows: fenced code blocks, `#` headings, `-`/`*`/`+` and `1.` list items, and
// inline **bold**, __bold__, *italic*, _italic_, `code`, ~~strike~~ and
// [links](https://…) to http(s) only. Anything else is the text it was.

/** The inline tokens, tried left to right; the earliest match wins. */
const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([^*]*?[^\s*])\*|(?<![A-Za-z0-9])_(?=[^\s_])([^_]*?[^\s_])_(?![A-Za-z0-9])|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/;

/**
 * The inline nodes for one run of text: tokens become elements, their insides
 * formatted in turn (bold may hold code), everything between them text nodes.
 */
export function inlineNodes(text, doc = document) {
  const out = [];
  let rest = String(text ?? '');
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out.push(doc.createTextNode(rest)); break; }
    if (m.index) out.push(doc.createTextNode(rest.slice(0, m.index)));
    let el;
    if (m[1]) {
      el = doc.createElement('code');
      el.textContent = m[2].replace(/^ (.*) $/s, '$1');   // `` ` a ` `` keeps its own backtick
    } else if (m[3] != null || m[4] != null) {
      el = doc.createElement('strong');
      el.append(...inlineNodes(m[3] ?? m[4], doc));
    } else if (m[5] != null) {
      el = doc.createElement('s');
      el.append(...inlineNodes(m[5], doc));
    } else if (m[6] != null || m[7] != null) {
      el = doc.createElement('em');
      el.append(...inlineNodes(m[6] ?? m[7], doc));
    } else {
      el = doc.createElement('a');
      el.href = m[9];
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
      el.append(...inlineNodes(m[8], doc));
    }
    out.push(el);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/**
 * The block nodes for a whole answer: one element per line or fence, so the
 * panel's `white-space: pre-wrap` is not needed to keep the lines apart and a
 * blank line is a gap rather than two newlines.
 */
export function markdownNodes(text, doc = document) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body = [];
      while (++i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i]);
      const pre = doc.createElement('pre');
      pre.className = 'md-pre';
      pre.textContent = body.join('\n');
      out.push(pre);
      continue;
    }
    const row = doc.createElement('div');
    const head = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (head) {
      row.className = 'md-h';
      row.append(...inlineNodes(head[2], doc));
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      row.className = 'md-hr';
    } else if (item) {
      row.className = 'md-li';
      row.style.paddingLeft = `${1.2 + Math.floor(item[1].length / 2) * 1.2}em`;
      const mark = doc.createElement('span');
      mark.className = 'md-mark';
      mark.textContent = /\d/.test(item[2]) ? item[2] : '•';
      row.append(mark, ...inlineNodes(item[3], doc));
    } else if (!line.trim()) {
      row.className = 'md-gap';
    } else {
      row.append(...inlineNodes(line.replace(/^\s*>\s?/, ''), doc));
      if (/^\s*>/.test(line)) row.className = 'md-quote';
    }
    out.push(row);
  }
  return out;
}
