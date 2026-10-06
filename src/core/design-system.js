// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Referenced layouts (SPEC DESIGN_SYSTEMS): a slide names a design system's
// layout and supplies only content, one element per named slot —
//
//   <section data-layout="acme/section-divider">
//     <p data-slot="kicker">Module 01</p>
//     <h2 data-slot="title">Flink on Confluent Cloud</h2>
//   </section>
//
// — and the structure comes from the design system at render time. The
// engine expands the slide IN THE DOM, during sync(), never in the file: when
// the design system changes, every slide naming one of its layouts re-lays-out
// on the next load, and the deck's diff shows nothing.
//
// The grammar is the existing `data-layout`, reused: a value with a `/` is
// `<design system>/<layout>`; the built-in ring (auto, centered, pinned, top,
// split, split-flip) has no slash, so the two can never collide.
//
// The design systems themselves arrive in the page from the server (#622):
// a `<script type="application/json" data-design-system-meta="<name>">` with
// the version, and `<template data-design-system-layouts="<name>">` holding
// the package's `<template data-layout>` blocks — or, in a bundle, the same
// two blocks copied in. The layout markup was checked when the package was
// admitted and again when it was served; it is checked a THIRD time here, on
// the clone, because this is the copy that becomes live DOM.

import { NAME_RE, isSystemLayout, parseSystemLayout } from '../../tools/design-system-format.mjs';

export { isSystemLayout, parseSystemLayout };

/** Direct children that stay where they are: what the slide carries, not what it shows. */
const KEEP = 'aside.notes, aside.sources, aside.rehearse, script, style, .slide-bg';

/** Tags a layout clone may never contain, whatever its checks said — the last line. */
const FORBIDDEN = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FOREIGNOBJECT', 'LINK', 'META', 'BASE', 'FRAME', 'FRAMESET']);
const REF_ATTRS = new Set(['src', 'srcset', 'href', 'xlink:href', 'poster', 'action', 'formaction', 'data', 'background', 'srcdoc']);

/**
 * Scrub a cloned layout of anything that could run or load: forbidden
 * elements removed, `on*` handlers, `srcdoc` and every outside reference
 * dropped. Returns how many things it had to take out — 0 for a package that
 * passed its checks, which is the only kind that should ever reach here.
 */
export function scrubLayout(fragment) {
  let removed = 0;
  for (const el of [...fragment.querySelectorAll('*')]) {
    if (FORBIDDEN.has(el.tagName.toUpperCase())) { el.remove(); removed++; continue; }
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || (REF_ATTRS.has(n) && !a.value.trim().startsWith('#'))) { el.removeAttribute(a.name); removed++; }
    }
  }
  return removed;
}

/**
 * The design systems the page carries, by name, in the order the deck uses
 * them: `{ name, version, title, palette, recommendedThemes, recommendedFonts, layouts: Map<id, HTMLTemplateElement> }`. Read from the meta block and the layouts template
 * the server injected (or a bundle copied in). A system whose meta is
 * unreadable is left out, and its slides fall back to plain content.
 */
export function pageDesignSystems(doc = document) {
  const out = new Map();
  for (const meta of doc.querySelectorAll('script[type="application/json"][data-design-system-meta]')) {
    const name = meta.getAttribute('data-design-system-meta');
    let info;
    try { info = JSON.parse(meta.textContent); } catch { continue; }
    const holder = doc.querySelector(`template[data-design-system-layouts="${CSS.escape(name)}"]`);
    const layouts = new Map();
    for (const t of holder?.content.querySelectorAll('template[data-layout]') ?? []) {
      const id = t.getAttribute('data-layout');
      if (NAME_RE.test(id) && !layouts.has(id)) layouts.set(id, t);
    }
    out.set(name, {
      name, version: info?.version ?? '', title: info?.title ?? name,
      palette: Array.isArray(info?.palette) ? info.palette : [],
      recommendedThemes: Array.isArray(info?.recommendedThemes) ? info.recommendedThemes.filter((t) => typeof t === 'string') : [],
      recommendedFonts: Array.isArray(info?.recommendedFonts) ? info.recommendedFonts.filter((t) => typeof t === 'string') : [],
      layouts,
    });
  }
  return out;
}

/** What a slide wrote, by element: its index in the FILE, before expansion reordered the DOM (#624 edits by it). */
const fileIndex = new WeakMap();
/** What a section was expanded from: the key, and the authored elements it moved. */
const expanded = new WeakMap();

/** The element's index among its section's children in the file — what `/deck/edit/element/*` addresses. */
export const fileIndexOf = (el) => fileIndex.get(el);

/**
 * The element a click inside a slide addresses, for editing (SPEC
 * DESIGN_SYSTEMS): the section's direct child it is in — or, on an expanded
 * design-system slide, the AUTHORED element, wherever expansion put it. The
 * layout's own decoration addresses nothing (null): it is not in the file.
 */
export function authoredTop(sec, target) {
  for (let el = target; el && el !== sec; el = el.parentElement) {
    if (fileIndex.has(el)) return el;
    if (el.parentElement === sec) return el.hasAttribute('data-ds-injected') ? null : el;
  }
  return null;
}

/** That element's index among its section's children IN THE FILE — what `/deck/edit/element/*` addresses. */
export const authoredIndex = (sec, el) => fileIndex.get(el) ?? Array.prototype.indexOf.call(sec.children, el);

/** The authored content of an expanded slide that has not moved since — or null if it changed. */
function stillExpanded(sec, key) {
  const was = expanded.get(sec);
  if (!was || was.key !== key || sec.getAttribute('data-ds-expanded') !== key) return false;
  if (!was.authored.every((el) => sec.contains(el))) return false;
  // new authored content arrived as a direct child (a re-render in place)
  return ![...sec.children].some((el) => !el.matches(KEEP) && !el.hasAttribute('data-ds-injected') && !was.authored.includes(el));
}

/**
 * Expand every slide whose `data-layout` names a design-system layout, in
 * place. `systems` is the resolver seam — `pageDesignSystems()` in the page,
 * a fixture in a test. Idempotent: a slide already expanded from the same
 * layout at the same version, whose authored content has not changed, is
 * left alone. Returns the slides it could not expand, as `{ sec, reason }`.
 */
export function setupSystemLayouts(sections, { systems = pageDesignSystems(), warn = () => {} } = {}) {
  const missing = [];
  for (const sec of sections) {
    const value = sec.getAttribute('data-layout');
    if (!isSystemLayout(value)) continue;
    const ref = parseSystemLayout(value);
    const sys = ref ? systems.get(ref.system) : null;
    const tpl = sys?.layouts.get(ref.layout);
    if (!tpl) {
      // the content renders plainly where it was written — nothing is lost
      const reason = !ref ? `"${value}" is not a design-system layout (name/layout)`
        : !sys ? `design system "${ref.system}" is not available on this page`
          : `${ref.system} has no layout "${ref.layout}"`;
      sec.setAttribute('data-ds-missing', reason);
      missing.push({ sec, reason });
      continue;
    }
    const key = `${ref.layout}@${sys.version}`;
    if (stillExpanded(sec, key)) continue;
    sec.removeAttribute('data-ds-missing');

    // What the author wrote, in file order, stamped before anything moves.
    // A re-expansion (new version, new content) gathers what is in the section
    // now — the authored elements wherever the last expansion put them.
    const was = expanded.get(sec);
    let authored;
    if (was) {
      authored = was.authored.filter((el) => sec.contains(el));
      for (const el of [...sec.children]) {
        if (!el.matches(KEEP) && !el.hasAttribute('data-ds-injected') && !authored.includes(el)) authored.push(el);
      }
      for (const el of [...sec.querySelectorAll(':scope > [data-ds-injected]')]) {
        for (const a of authored) if (el.contains(a)) sec.appendChild(a);
        el.remove();
      }
    } else {
      authored = [...sec.children].filter((el) => !el.matches(KEEP));
      [...sec.children].forEach((el, i) => { if (!el.matches(KEEP)) fileIndex.set(el, i); });
    }

    const clone = tpl.content.cloneNode(true);
    const scrubbed = scrubLayout(clone);
    if (scrubbed) warn(`slide layout ${value}: ${scrubbed} unsafe thing(s) removed from the layout — the package should not have passed its check`);
    // The layout's own nodes are decoration the author never wrote: marked so
    // editing (#624) can tell them from content. Slot containers too — they
    // hold content, but are not it.
    for (const node of [...clone.children, ...clone.querySelectorAll('*')]) node.setAttribute('data-ds-injected', '');
    const slots = new Map();
    for (const c of clone.querySelectorAll('[data-slot]')) if (!slots.has(c.getAttribute('data-slot'))) slots.set(c.getAttribute('data-slot'), c);
    const fallback = clone.querySelector('[data-slot-default]');
    const filled = new Set();
    const fill = (container, el) => {
      if (!filled.has(container)) { container.replaceChildren(); filled.add(container); }
      container.appendChild(el);
    };
    let unslotted = null;
    for (const el of authored) {
      const slot = el.getAttribute('data-slot');
      const container = slot ? slots.get(slot) : null;
      if (container) { fill(container, el); continue; }
      if (fallback) { fill(fallback, el); continue; }
      if (!unslotted) {
        unslotted = document.createElement('div');
        unslotted.className = 'ds-unslotted';
        unslotted.setAttribute('data-ds-injected', '');
      }
      unslotted.appendChild(el);
    }
    if (unslotted) clone.appendChild(unslotted);
    const empty = [...clone.querySelectorAll('[data-slot-required]')]
      .filter((c) => !filled.has(c) && !c.textContent.trim() && !c.children.length).map((c) => c.getAttribute('data-slot'));
    if (empty.length) {
      sec.setAttribute('data-ds-required-empty', empty.join(' '));
      warn(`slide layout ${value}: required slot${empty.length === 1 ? '' : 's'} ${empty.join(', ')} left empty`);
    } else sec.removeAttribute('data-ds-required-empty');
    // the layout goes where the content was: after a background, before the asides
    const firstKept = [...sec.children].find((el) => el.matches('aside, script, style'));
    sec.insertBefore(clone, firstKept ?? null);
    sec.setAttribute('data-ds-expanded', key);
    expanded.set(sec, { key, authored });
  }
  return missing;
}
