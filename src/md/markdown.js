// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Markdown slides — SPEC §1 + §2.1 (`::: build` directive).
// Pure string transforms are exported for node:test; DOM application is in
// initMarkdown (browser only).

import { marked } from 'marked';
import { extractMath, restoreMath } from '../math/math.js';

marked.setOptions({ gfm: true, breaks: false });

/** Strip the common leading indentation of a template block. */
export function dedent(text) {
  const lines = text.replace(/^\n+/, '').replace(/\s+$/, '').split('\n');
  let indent = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    indent = Math.min(indent, l.match(/^[ \t]*/)[0].length);
  }
  if (!Number.isFinite(indent) || indent === 0) return lines.join('\n');
  return lines.map((l) => l.slice(indent)).join('\n');
}

/**
 * Split body and speaker notes at the first line that is exactly `Note:`.
 * Inside the notes, a line that is exactly `Rehearse:` starts the condensed
 * cue-card variant (SPEC §8 speaker-view rehearse mode) — same ⟨CLICK⟩
 * segmentation as the notes, a few words per segment.
 */
export function splitNotes(md) {
  const m = md.match(/^Note:\s*$/m);
  if (!m) return { body: md, notes: null, rehearse: null };
  const body = md.slice(0, m.index).replace(/\s+$/, '');
  let notes = md.slice(m.index + m[0].length).replace(/^\n/, '');
  let rehearse = null;
  const r = notes.match(/^Rehearse:\s*$/m);
  if (r) {
    rehearse = notes.slice(r.index + r[0].length).replace(/^\n/, '');
    notes = notes.slice(0, r.index).replace(/\s+$/, '');
  }
  return { body, notes, rehearse };
}

// `::: build` … `:::` → an html block wrapping the content in <div data-build>.
// Blank lines around the tags keep CommonMark parsing the inner markdown.
// NB: `[ \t]*` not `\s*` — \s matches newlines and would swallow the blank
// line that terminates the closing HTML block (breaking whatever follows).
export function applyBuildDirective(md) {
  return md
    .replace(/^:::[ \t]*build[ \t]*([\w-]*)[ \t]*$/gm, (m, style) =>
      style ? `<div data-build="${style}">\n` : '<div data-build>\n')
    .replace(/^:::[ \t]*$/gm, '\n</div>');
}

// A `::: build` wrapping exactly one list/table should step that container's
// children, not reveal the wrapper as a single block: hoist the attribute.
export function hoistBuildWrappers(rootEl) {
  rootEl.querySelectorAll('div[data-build]').forEach((div) => {
    const kids = [...div.children];
    if (kids.length !== 1) return;
    const child = kids[0];
    if (!/^(UL|OL|TABLE|DL)$/.test(child.tagName)) return;
    const style = div.getAttribute('data-build');
    if (!child.hasAttribute('data-build')) {
      child.setAttribute('data-build', style || '');
    }
    div.removeAttribute('data-build');
  });
}

/**
 * Full transform: template text → { html, notesHtml, rehearseHtml }.
 * `opts.math` (a `data-math` section, SPEC §6): math spans are extracted
 * before marked.parse — TeX underscores/asterisks would parse as emphasis —
 * and restored, rendered to MathML, after. Notes stay plain: they are spoken.
 */
export function renderMarkdownSlide(template, opts = {}) {
  const { body, notes, rehearse } = splitNotes(dedent(template));
  let html;
  if (opts.math) {
    const { text, spans } = extractMath(body);
    html = restoreMath(marked.parse(applyBuildDirective(text)), spans);
  } else {
    html = marked.parse(applyBuildDirective(body));
  }
  const notesHtml = notes ? marked.parse(notes) : null;
  const rehearseHtml = rehearse ? marked.parse(rehearse) : null;
  return { html, notesHtml, rehearseHtml };
}

/** Browser: expand every `section[data-markdown]` in place. */
export function initMarkdown(root) {
  root.querySelectorAll('section[data-markdown]').forEach((section) => {
    const tpl = section.querySelector('script[type="text/template"]');
    const source = tpl ? tpl.textContent : section.textContent;
    const { html, notesHtml, rehearseHtml } =
      renderMarkdownSlide(source, { math: section.hasAttribute('data-math') });
    section.innerHTML = html;
    hoistBuildWrappers(section);
    for (const [cls, content] of [['notes', notesHtml], ['rehearse', rehearseHtml]]) {
      if (!content) continue;
      const aside = document.createElement('aside');
      aside.className = cls;
      aside.innerHTML = content;
      section.appendChild(aside);
    }
    section.removeAttribute('data-markdown');
    section.setAttribute('data-was-markdown', '');
  });
}
