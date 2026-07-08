// Code highlighting + line stepping — SPEC §6.
// Slim highlight.js registration (13 languages), themed via --hl-* tokens.
// `data-lines` registers a build provider (one step per segment).

import hljs from 'highlight.js/lib/core';
import sql from 'highlight.js/lib/languages/sql';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import json from 'highlight.js/lib/languages/json';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import plaintext from 'highlight.js/lib/languages/plaintext';

hljs.registerLanguage('sql', sql);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('java', java);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerAliases(['js'], { languageName: 'javascript' });
hljs.registerAliases(['ts'], { languageName: 'typescript' });
hljs.registerAliases(['shell', 'sh', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['html'], { languageName: 'xml' });
hljs.registerAliases(['text', 'plain'], { languageName: 'plaintext' });

/**
 * Parse `data-lines` ("1|3-5|all") into 1-based line-number segments.
 * Pure — unit-tested in test/builds.test.mjs.
 */
export function parseLineRanges(spec, totalLines) {
  return spec.split('|').map((seg) => {
    seg = seg.trim();
    if (seg === '' || seg === 'all') {
      return Array.from({ length: totalLines }, (_, i) => i + 1);
    }
    const out = [];
    for (const part of seg.split(',')) {
      const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      const a = parseInt(m[1], 10);
      const b = m[2] ? parseInt(m[2], 10) : a;
      for (let n = a; n <= Math.min(b, totalLines); n++) out.push(n);
    }
    return out;
  });
}

// Split highlighted code into .code-line blocks, re-opening any hljs span
// that crosses a newline (multi-line comments/strings) on each new line.
function wrapLines(codeEl) {
  const lines = [[]];
  (function visit(node, path) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = child.nodeValue.split('\n');
        parts.forEach((t, i) => {
          if (i > 0) lines.push([]);
          if (t) lines[lines.length - 1].push({ path, text: t });
        });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        visit(child, [...path, child]);
      }
    }
  })(codeEl, []);

  while (lines.length && lines[lines.length - 1].length === 0) lines.pop();

  codeEl.textContent = '';
  for (const parts of lines) {
    const lineEl = document.createElement('span');
    lineEl.className = 'code-line';
    for (const { path, text } of parts) {
      let parent = lineEl;
      for (const orig of path) {
        let tail = parent.lastChild;
        if (!(tail && tail.__orig === orig)) {
          tail = orig.cloneNode(false);
          tail.__orig = orig;
          parent.appendChild(tail);
        }
        parent = tail;
      }
      parent.appendChild(document.createTextNode(text));
    }
    codeEl.appendChild(lineEl);
  }
  return codeEl.querySelectorAll(':scope > .code-line');
}

function segmentLabel(seg, totalLines) {
  if (seg.length === totalLines) return 'all lines';
  const sorted = [...seg];
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const n of sorted.slice(1)) {
    if (n === prev + 1) { prev = n; continue; }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = n;
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return `lines ${ranges.join(',')}`;
}

export function initCode(root, registerBuildProvider) {
  root.querySelectorAll('pre > code').forEach((codeEl) => {
    const langClass = [...codeEl.classList].find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.slice('language-'.length) : null;
    const source = codeEl.textContent.replace(/^\n/, '').replace(/\s+$/, '');
    if (lang && hljs.getLanguage(lang)) {
      codeEl.innerHTML = hljs.highlight(source, { language: lang }).value;
    } else {
      codeEl.textContent = source;
    }
    codeEl.classList.add('hljs');

    const pre = codeEl.parentElement;
    const lineEls = wrapLines(codeEl);
    if (pre.hasAttribute('data-lines-numbers')) pre.classList.add('line-numbers');

    const spec = pre.getAttribute('data-lines');
    if (!spec) return;
    const segments = parseLineRanges(spec, lineEls.length);
    pre.classList.add('stepping');

    registerBuildProvider(pre, {
      count: segments.length,
      label: (i) => (i === 0 ? 'code' : segmentLabel(segments[i - 1], lineEls.length)),
      apply(i) {
        lineEls.forEach((l) => l.classList.remove('line-hl', 'line-dim'));
        if (i === 0) return;
        const seg = new Set(segments[i - 1]);
        const highlightAll = seg.size === lineEls.length;
        lineEls.forEach((l, idx) => {
          if (seg.has(idx + 1)) l.classList.add('line-hl');
          else if (!highlightAll) l.classList.add('line-dim');
        });
      },
    });
  });
}
