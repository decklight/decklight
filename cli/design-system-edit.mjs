// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Editing a slide that uses a slide template (SPEC DESIGN_SYSTEMS).
//
// Two halves, both pure string surgery on the deck's FILE — the engine's
// expansion lives only in the DOM, so nothing here ever writes a template's
// structure into a slide:
//
//   - the guard: an element edit on such a slide may change an element's
//     content, never drop the `data-slot` that puts it in its place;
//   - the template picker's writes (POST /deck/edit/slide/template): put a
//     slide INTO a template (convert), move it to another (switch), take it out
//     (remove), or insert a new slide built from one — each one edit, so one
//     undo — and a report of what went where, in words.
//
// Template definitions (`{ id, slots: [{ name, hint, required, default }] }`)
// come from the deck's design systems as the server resolves them, never
// from the page; they are handed in, so every transform is testable alone.

import { locateSlide, sectionChildRanges, splitOpenTag, readAttrs, writeAttrs, insertSectionsAfter } from '../tools/deck-html.mjs';

/** Elements a slide carries rather than shows — never assigned to a slot. */
const CARRIED = new Set(['aside', 'script', 'style']);

/** The `data-template` slide `n` names in the file, or ''. */
export function slideTemplateOf(html, slide) {
  const { parts, idx } = locateSlide(html, slide);
  const { attrs } = splitOpenTag(parts[idx]);
  return readAttrs(attrs)['data-template'] ?? '';
}

/** An element's open-tag attributes, and the pieces to put it back together. */
function openTag(el) {
  const m = /^<([A-Za-z][\w:-]*)/.exec(el);
  const tag = m?.[1] ?? '';
  const { attrs, close, rest } = splitOpenTag(el.slice(m ? m[0].length : 0));
  return { tag, attrs: readAttrs(attrs), close, rest };
}
const withAttrs = (el, attrs) => {
  const t = openTag(el);
  return `<${t.tag}${writeAttrs(attrs)}${t.close}${t.rest}`;
};

/**
 * Why an element write on a design-system slide is refused, or null. The
 * slot an element fills is its address in the template; an edit that drops it
 * would silently move the content to the unslotted box.
 */
export function slotWriteProblem(html, slide, index, outerHtml) {
  if (!slideTemplateOf(html, slide)) return null;
  const { parts, idx } = locateSlide(html, slide);
  const r = sectionChildRanges(parts[idx])[index];
  if (!r) return null;
  const before = openTag(parts[idx].slice(r.start, r.end)).attrs['data-slot'];
  if (before === undefined) return null;
  const after = openTag(String(outerHtml ?? '').trim()).attrs['data-slot'];
  return after === undefined
    ? `this element fills the "${before}" slot of the slide's template — keep data-slot="${before}" on it (an edit may change what it says, not where it goes)`
    : null;
}

/** A hint (`"h1,h2"`) as the tags it names. */
const hintTags = (hint) => String(hint ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);

/**
 * Put slide `n` into `template` (`{ ref: "acme/divider", id, slots }`), take it
 * out (`template` null), or move it from one template to another. Returns
 * `{ html, mode, moved, lacking }`:
 *   - convert (from a plain slide): children that already carry a data-slot
 *     the template has keep it; the rest are given one by the slots' hints, in
 *     the template's slot order (the first h2 → a slot hinted h1,h2 …);
 *     leftovers carry none and land in the template's default slot (or the
 *     unslotted box) when the engine expands it;
 *   - switch (from another slide template): only the attribute moves;
 *     content stays by slot name, and slots the new template lacks are listed;
 *   - remove: the attribute goes; data-slot attributes stay — harmless on a
 *     plain slide, and what a later convert would read.
 */
export function applySlideTemplate(html, slide, template) {
  const { parts, idx } = locateSlide(html, slide);
  const seg = parts[idx];
  const head = splitOpenTag(seg);
  const sectionAttrs = readAttrs(head.attrs);
  const current = sectionAttrs['data-template'] ?? '';
  const mode = !template ? 'remove' : current ? 'switch' : 'convert';
  const moved = [];
  const lacking = [];
  if (template) sectionAttrs['data-template'] = template.ref;
  else delete sectionAttrs['data-template'];
  let body = head.rest;
  if (mode === 'convert' || mode === 'switch') {
    const names = new Set(template.slots.map((s) => s.name));
    const ranges = sectionChildRanges(seg).map((r) => ({ ...r, start: r.start - (seg.length - head.rest.length), end: r.end - (seg.length - head.rest.length) }));
    const kids = ranges.map((r) => ({ r, tag: r.tag.toLowerCase(), el: body.slice(r.start, r.end) }))
      .filter((k) => !CARRIED.has(k.tag) && !/\bclass\s*=\s*["'][^"']*\bslide-bg\b/.test(k.el));
    const assigned = new Map();   // child → slot
    for (const k of kids) {
      const slot = openTag(k.el).attrs['data-slot'];
      if (slot === undefined) continue;
      if (names.has(slot)) { assigned.set(k, slot); continue; }
      lacking.push(slot);
    }
    if (mode === 'convert') {
      const taken = new Set(assigned.values());
      for (const s of template.slots) {
        if (taken.has(s.name) || s.default) continue;
        const tags = hintTags(s.hint);
        if (!tags.length) continue;
        const k = kids.find((x) => !assigned.has(x) && openTag(x.el).attrs['data-slot'] === undefined && tags.includes(x.tag));
        if (!k) continue;
        assigned.set(k, s.name);
        taken.add(s.name);
        moved.push({ tag: k.tag, slot: s.name, by: `hint ${s.hint}` });
      }
      const fallback = template.slots.find((s) => s.default)?.name ?? null;
      for (const k of kids) {
        if (assigned.has(k) || openTag(k.el).attrs['data-slot'] !== undefined) continue;
        moved.push({ tag: k.tag, slot: fallback, by: fallback ? 'the default slot' : 'the unslotted box' });
      }
      // write the new data-slot attributes back to front, so earlier offsets hold
      const writes = [...assigned].filter(([k, slot]) => openTag(k.el).attrs['data-slot'] !== slot)
        .sort((a, b) => b[0].r.start - a[0].r.start);
      for (const [k, slot] of writes) {
        const attrs = { ...openTag(k.el).attrs, 'data-slot': slot };
        body = body.slice(0, k.r.start) + withAttrs(k.el, attrs) + body.slice(k.r.end);
      }
    }
  }
  // `seg` is what follows the `<section` token: its attributes, then the body
  parts[idx] = writeAttrs(sectionAttrs) + head.close + body;
  return { html: parts.join(''), mode, moved, lacking: [...new Set(lacking)] };
}

/** A tag a hint suggests for a new slide's slot, or `p`. */
const tagFor = (hint) => hintTags(hint).find((t) => /^(h[1-6]|p|ul|ol|blockquote|figure|div)$/.test(t)) ?? 'p';
const titleCase = (name) => name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * A deck with a new slide after slide `after`, in `template`: one element per
 * REQUIRED slot, by its hint, saying the slot's name — every other slot is
 * left to the template's own default content, which the engine shows until
 * the author fills it.
 */
export function insertSlideTemplateSlide(html, after, template) {
  const lines = template.slots.filter((s) => s.required).map((s) => {
    const tag = tagFor(s.hint);
    return `  <${tag} data-slot="${s.name}">${titleCase(s.name)}</${tag}>`;
  });
  const section = `<section data-template="${template.ref}">\n${lines.join('\n')}${lines.length ? '\n' : ''}  <aside class="notes"></aside>\n</section>`;
  return insertSectionsAfter(String(html ?? ''), after, [section]);
}

/** What happened, said for a toast: "title ← h2 (hint h1,h2) · p → the default slot". */
export function describeTemplateChange({ mode, moved, lacking }, ref) {
  const out = [];
  if (mode === 'remove') out.push('back to a plain slide — data-slot attributes stay');
  if (mode === 'switch') out.push(`now ${ref} — content stays by slot name`);
  if (mode === 'convert') out.push(`now ${ref}`);
  for (const m of moved) out.push(m.slot ? `${m.tag} → ${m.slot}${m.by.startsWith('hint') ? ` (${m.by})` : ' (the default slot)'}` : `${m.tag} → ${m.by}`);
  if (lacking.length) out.push(`${ref} has no ${lacking.map((s) => `"${s}"`).join(', ')} slot — that content shows in the unslotted box`);
  return out.join(' · ');
}
