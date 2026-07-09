// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// SVG id-namespacing — SPEC §3. Eliminates the defs-collision bug class:
// every inline <svg> gets a unique prefix on all ids, with url(#…) and
// href="#…" references rewritten within that svg only.
//
// Concept colors — SPEC §3. `data-concept="agent"` pins a shape (or a
// group's shapes) to ONE diagram-fill slot deck-wide, so a recurring concept
// never changes color between diagrams. Slot resolution: config.concepts
// override → stable name hash. The indirection targets a slot
// (var(--d-fill-N)), not a color, so it survives every theme.

const SHAPES = 'rect, circle, ellipse, polygon, polyline, path';

// stable across sessions and decks: the same concept name always lands on
// the same slot with zero configuration (djb2 over the name, mod 6)
export function conceptSlot(name) {
  let h = 5381;
  for (const c of String(name)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return 1 + (h % 6);
}

/** name → CSS fill value, honoring config overrides (slot number or raw CSS color). */
export function conceptFill(name, concepts = {}) {
  const conf = concepts[name];
  if (typeof conf === 'number') return `var(--d-fill-${conf})`;
  if (typeof conf === 'string') return conf;
  return `var(--d-fill-${conceptSlot(name)})`;
}

export function applyConcepts(root, concepts = {}) {
  const seen = new Map(); // slot → first concept name (collision warning)
  root.querySelectorAll('svg [data-concept]').forEach((el) => {
    const name = el.getAttribute('data-concept');
    if (!name) return;
    const fill = conceptFill(name, concepts);
    const m = fill.match(/--d-fill-(\d)/);
    if (m) {
      const owner = seen.get(m[1]);
      if (owner && owner !== name) {
        console.warn(`Decklight: concepts "${owner}" and "${name}" share fill slot ${m[1]} — pin one explicitly via init({ concepts: { ${name}: <1-6> } })`);
      } else {
        seen.set(m[1], name);
      }
    }
    // a group recolors its direct-child shapes; text keeps --d-text (fill on
    // SVG text is its ink — concept identity lives in the box, not the label)
    const targets = el.matches(SHAPES) ? [el]
      : [...el.children].filter((c) => c.matches(SHAPES));
    for (const t of targets) t.style.setProperty('fill', fill);
  });
}

const REF_ATTRS = [
  'fill', 'stroke', 'filter', 'clip-path', 'mask',
  'marker-start', 'marker-mid', 'marker-end', 'style',
];

export function namespaceSvgIds(root) {
  root.querySelectorAll('svg').forEach((svg, n) => {
    const prefix = `svg${n}-`;
    const map = new Map();
    svg.querySelectorAll('[id]').forEach((el) => {
      const old = el.id;
      map.set(old, prefix + old);
      el.id = prefix + old;
    });
    if (map.size === 0) return;

    const rewriteUrl = (value) =>
      value.replace(/url\(['"]?#([^'")]+)['"]?\)/g, (m, id) =>
        map.has(id) ? `url(#${map.get(id)})` : m);

    svg.querySelectorAll('*').forEach((el) => {
      for (const attr of REF_ATTRS) {
        const v = el.getAttribute(attr);
        if (v && v.includes('url(#')) el.setAttribute(attr, rewriteUrl(v));
      }
      for (const attr of ['href', 'xlink:href']) {
        const v = el.getAttribute(attr);
        if (v && v.startsWith('#') && map.has(v.slice(1))) {
          el.setAttribute(attr, '#' + map.get(v.slice(1)));
        }
      }
    });
  });
}
