// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// SVG id-namespacing — SPEC SVG_DIAGRAMS. Eliminates the defs-collision bug class:
// every inline <svg> gets a unique prefix on all ids, with url(#…) and
// href="#…" references rewritten within that svg only.
//
// Concept colors — SPEC SVG_DIAGRAMS. `data-concept="agent"` pins a shape (or a
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
    for (const t of targets) {
      // an unfilled outline (fill="none" — a line-chart stroke, a wire shape)
      // carries its concept in the stroke; painting the fill would close it
      const unfilled = t.getAttribute('fill') === 'none' || t.style.fill === 'none';
      t.style.setProperty(unfilled ? 'stroke' : 'fill', fill);
    }
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

// ── nested fills — SPEC SVG_DIAGRAMS (#541) ────────────────────────────────
// A filled shape drawn INSIDE a filled shape (a box on a panel) is painted a
// tone step of its container's slot — `var(--d-fill-N-in)` — so the boxes
// read as the panel's children and two panels of different colours hold two
// visibly different families. Only a shape whose authored fill is a plain
// slot token is touched; `data-concept` wins (a `tools` box inside an `agent`
// panel stays tools-coloured), `data-nest="off"` on a shape or a group opts
// out, `data-nest="on"` takes a shape the bbox test misses (rotated) by its
// centre point, and `fill: var(--d-fill-in)` on a child means "my container's
// nested tone" outright. Containment is geometric — bboxes in the svg's own
// space — and by PAINT ORDER: only a shape painted earlier can be a panel, so
// a big shape drawn last is an overlay, not a container. Two steps deep at
// most (`-in2`). Idempotent: the authored fill is remembered on the shape and
// the pass re-derives from it, so a second `sync()` changes nothing.

const SLOT_RE = /^\s*var\(\s*--d-fill-([1-6])\s*\)\s*$/;
const NEST_RE = /^\s*var\(\s*--d-fill-in\s*\)\s*$/;

/** The fill the author wrote for a shape — the attribute or the inline style, before this pass rewrote it. */
function authoredFill(el) {
  if (el.dataset.nestFill !== undefined) return el.dataset.nestFill;
  return el.style.fill || el.getAttribute('fill') || '';
}

/** The slot a shape resolves to on its own (concept or plain token), or null. */
function ownSlot(el) {
  const holder = el.hasAttribute('data-concept') ? el
    : (el.parentElement?.hasAttribute('data-concept') ? el.parentElement : null);
  if (holder) {
    const m = /var\(--d-fill-(\d)\)/.exec(el.style.fill || '');
    return m ? { slot: Number(m[1]), concept: true } : { slot: null, concept: true };
  }
  const m = SLOT_RE.exec(authoredFill(el));
  return m ? { slot: Number(m[1]), concept: false } : null;
}

/** A shape's bounding box in its svg's viewport space, or null when it has none (not laid out, or empty). */
function boxOf(el) {
  let b;
  try { b = el.getBBox(); } catch { return null; }
  if (!b || !(b.width > 0) || !(b.height > 0)) return null;
  const ctm = el.getCTM();
  if (!ctm) return { x: b.x, y: b.y, w: b.width, h: b.height };
  const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
    .map(([x, y]) => ({ x: ctm.a * x + ctm.c * y + ctm.e, y: ctm.b * x + ctm.d * y + ctm.f }));
  const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
  const x = Math.min(...xs); const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const contains = (outer, inner, eps = 0.5) =>
  inner.x >= outer.x - eps && inner.y >= outer.y - eps
  && inner.x + inner.w <= outer.x + outer.w + eps && inner.y + inner.h <= outer.y + outer.h + eps;
const containsCentre = (outer, inner) => {
  const cx = inner.x + inner.w / 2; const cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
};

/**
 * Paint every nested shape under `scope` its container's tone. Needs layout:
 * run it on a slide that is displayed (activation, print, an overview clone).
 */
export function applyNesting(scope) {
  scope.querySelectorAll('svg').forEach((svg) => {
    if (svg.classList.contains('chart-svg')) return; // a chart's series are slots, never panels
    const shapes = [...svg.querySelectorAll(SHAPES)].filter((el) => !el.closest('[data-nest="off"]'));
    // what each shape resolves to, in paint order — a container's own depth
    // is known by the time its children are looked at
    const resolved = new Map(); // el → { slot, depth }
    const painted = [];         // { el, box, slot, depth } — candidates for containment
    for (const el of shapes) {
      const authored = authoredFill(el);
      const wantsIn = NEST_RE.test(authored);
      const own = ownSlot(el);
      const unfilled = authored === 'none' || el.getAttribute('fill') === 'none';
      if (!own && !wantsIn) { if (!unfilled && !SLOT_RE.test(authored)) painted.push(null); continue; }
      const box = boxOf(el);
      if (!box) continue;
      // the innermost earlier-painted filled shape whose box holds this one
      let panel = null;
      if (!own?.concept) {
        const byCentre = el.getAttribute('data-nest') === 'on';
        for (const c of painted) {
          if (!c || !(byCentre ? containsCentre(c.box, box) : contains(c.box, box))) continue;
          if (c.box.w * c.box.h >= box.w * box.h && (!panel || c.box.w * c.box.h < panel.box.w * panel.box.h)) panel = c;
        }
      }
      if (el.dataset.nestFill === undefined) el.dataset.nestFill = authored;
      let slot = own?.slot ?? null; let depth = 0;
      if (panel && panel.slot) {
        slot = panel.slot;
        depth = Math.min(2, panel.depth + 1);
        el.style.fill = `var(--d-fill-${slot}-in${depth === 2 ? '2' : ''})`;
      } else if (wantsIn) {
        // "my container's tone" with no container found: the first slot's, so the shape still paints
        slot = 1; depth = 1;
        el.style.fill = 'var(--d-fill-1-in)';
      } else if (!own?.concept) {
        el.style.fill = authored;   // back to the authored token — a panel that lost its container
      }
      resolved.set(el, { slot, depth });
      if (!unfilled && slot) painted.push({ el, box, slot, depth });
    }
  });
}
