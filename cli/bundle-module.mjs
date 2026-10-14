// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// One chapter of a deck as a bundle of its own (`bundle --module`, SPEC
// PRESENTING): the sections from a `data-module` marker up to the next one,
// and the narration that goes with them.
//
// The narration is the part that needs care. A track's files are named by
// slide number (`slide-07-02.wav`, `slide-07.visemes.json`) and a manifest is
// indexed by it (`slides[6]`), because the runtime builds those names from the
// slide it is on, counting from 1. Cut a chapter out and its slides are
// numbered from 1 again, so every name is moved down by the chapter's offset
// and anything outside the chapter is left out. Nothing is re-voiced: the
// clips are the same bytes under the number the bundle will ask for.

/** The top-level `<section>`s inside `[contentStart, contentEnd)`, depth-aware. */
function sectionSpans(html, contentStart, contentEnd) {
  const spans = [];
  const re = /<section\b[^>]*>|<\/section\s*>/gi;
  re.lastIndex = contentStart;
  let depth = 0, open = -1, m;
  while ((m = re.exec(html)) && m.index < contentEnd) {
    if (m[0][1] === '/') {
      if (depth > 0 && --depth === 0) spans.push({ start: open, end: m.index + m[0].length, tag: html.slice(open, html.indexOf('>', open) + 1) });
    } else if (depth++ === 0) open = m.index;
  }
  return spans;
}

const unescapeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * The deck's chapters, in order: `{ n, title, offset, count }`, where `offset`
 * is how many slides come before the chapter and `count` how many it holds.
 * Slides before the first marker belong to no chapter.
 */
export function deckModules(html, bounds) {
  const spans = sectionSpans(html, bounds.contentStart, bounds.contentEnd);
  const out = [];
  spans.forEach((s, i) => {
    const m = s.tag.match(/\bdata-module\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!m) return;
    if (out.length) out[out.length - 1].count = i - out[out.length - 1].offset;
    out.push({ n: out.length + 1, title: unescapeAttr(m[1] ?? m[2]).trim(), offset: i, count: spans.length - i });
  });
  return { modules: out, spans };
}

/**
 * The chapter `want` names: its number (1-based) or its title, case and
 * surrounding space ignored. Throws an Error with a sentence that lists the
 * chapters when nothing matches, or says there are none.
 */
export function pickModule(modules, want) {
  if (!modules.length) {
    throw new Error('--module: this deck has no chapters — a chapter starts at a <section data-module="…">');
  }
  const key = String(want).trim();
  const byNumber = /^\d+$/.test(key) ? modules[Number(key) - 1] : null;
  const hit = byNumber ?? modules.find((m) => m.title.toLowerCase() === key.toLowerCase());
  if (hit) return hit;
  throw new Error(`--module: no chapter "${key}" in this deck — its chapters are:\n`
    + modules.map((m) => `    ${m.n}  ${m.title} (${m.count === 1 ? '1 slide' : `${m.count} slides`})`).join('\n'));
}

/** The deck with only `mod`'s sections left inside the container. */
export function sliceModule(html, bounds, spans, mod) {
  const keep = spans.slice(mod.offset, mod.offset + mod.count);
  const inner = keep.map((s) => html.slice(s.start, s.end)).join('\n\n    ');
  return html.slice(0, bounds.contentStart) + '\n\n    ' + inner + '\n\n  ' + html.slice(bounds.contentEnd);
}

/**
 * A track file's name moved into the chapter: `slide-07-02.wav` with an
 * offset of 4 is `slide-03-02.wav`, and a slide outside the chapter is null.
 * Works on a bare stem (`slide-07`) and on a path (`voices/slide-07.m4a`).
 * With no `mod` the name is returned as it is.
 */
export function renumber(name, mod) {
  if (!mod) return name;
  const m = name.match(/^(.*?\bslide-)(\d+)((?:-\d+)?(?:\..*)?)$/);
  if (!m) return name;
  const n = Number(m[2]) - mod.offset;
  if (n < 1 || n > mod.count) return null;
  return `${m[1]}${String(n).padStart(Math.max(2, m[2].length), '0')}${m[3]}`;
}

/** A manifest's `slides` cut to the chapter (entry k is slide k + 1). */
export function sliceManifest(data, mod) {
  if (!mod || !Array.isArray(data?.slides)) return data;
  return { ...data, slides: data.slides.slice(mod.offset, mod.offset + mod.count) };
}

/** "Foundations" → "foundations", for the default file name. */
export const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-') || 'module';
