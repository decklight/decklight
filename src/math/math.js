// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// LaTeX math on `data-math` slides — SPEC CODE_AND_MATH.
// Rendered to MathML Core via bundled Temml (no webfonts, no network, no
// per-deck build step). Delimiters: `$$…$$` display, `\(…\)` inline. Single-`$`
// is deliberately NOT a delimiter — currency false-positives ("$5 to $10")
// would silently eat prose; `\$` escapes a literal dollar.
//
// initMath walks each data-math section's text nodes (code/pre/svg/asides
// skipped) and replaces delimited spans in place. The pure string transform
// (findMathSpans) is exported for node:test; only initMath touches the DOM.

import temml from 'temml';

function renderTex(tex, display) {
  // throwOnError:false → a parse error renders as a visible red span carrying
  // the message, instead of killing the whole init pipeline.
  return temml.renderToString(tex, { displayMode: display, throwOnError: false });
}

/** The next `$$` at or after `from` that is not escaped as `\$$`. */
function closingDollars(text, from) {
  let i = from;
  while ((i = text.indexOf('$$', i)) !== -1) {
    if (text[i - 1] !== '\\') return i;
    i += 1;
  }
  return -1;
}

/**
 * Split plain text into pieces: `{type:'text', value}` and
 * `{type:'math', tex, display}`. Used on DOM text nodes (HTML slides), where
 * code elements are already skipped by the tree walk. `\$` unescapes to a
 * literal `$`; an unterminated delimiter is left as text.
 */
export function findMathSpans(text) {
  const pieces = [];
  let buf = '';
  const flush = () => { if (buf) { pieces.push({ type: 'text', value: buf }); buf = ''; } };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      const d = text[i + 1];
      if (d === '$') { buf += '$'; i += 2; continue; }
      if (d === '(') {
        const close = text.indexOf('\\)', i + 2);
        if (close !== -1) {
          flush();
          pieces.push({ type: 'math', tex: text.slice(i + 2, close), display: false });
          i = close + 2;
          continue;
        }
      }
      // any other backslash pair is plain text — and consuming both chars
      // keeps `\\(` (an escaped backslash) from reading as a `\(` opener
      buf += d === undefined ? c : c + d;
      i += d === undefined ? 1 : 2;
      continue;
    }
    if (c === '$' && text[i + 1] === '$') {
      const close = closingDollars(text, i + 2);
      if (close !== -1) {
        flush();
        pieces.push({ type: 'math', tex: text.slice(i + 2, close), display: true });
        i = close + 2;
        continue;
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return pieces;
}

// Elements whose text never holds deck math: code samples (SPEC CODE_AND_MATH line
// stepping owns them), SVG (MathML can't live in <text>), speaker asides
// (notes are spoken — narration must not read markup), already-rendered math.
const SKIP = 'code, pre, script, style, svg, aside, math';

function renderMathIn(section) {
  const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement && node.parentElement.closest(SKIP)
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue.includes('$') || n.nodeValue.includes('\\(')) nodes.push(n);
  }
  for (const node of nodes) {
    const pieces = findMathSpans(node.nodeValue);
    if (pieces.length === 1 && pieces[0].type === 'text' && pieces[0].value === node.nodeValue) continue;
    const frag = document.createDocumentFragment();
    for (const p of pieces) {
      if (p.type === 'text') {
        frag.appendChild(document.createTextNode(p.value));
      } else {
        const host = document.createElement('span');
        host.innerHTML = renderTex(p.tex, p.display);
        frag.appendChild(host.firstElementChild ?? document.createTextNode(''));
      }
    }
    node.parentNode.replaceChild(frag, node);
  }
}

/**
 * Browser: render math on every `section[data-math]`. Sections without the
 * attribute are never scanned.
 */
export function initMath(root) {
  root.querySelectorAll('section[data-math]').forEach((section) => renderMathIn(section));
}
