// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// "Concept colors…" — the deck's concepts (SPEC SVG_DIAGRAMS, #718) in one
// list, write mode only: every `data-concept` name a diagram on the deck
// carries, with the slot it resolves to and how many shapes wear it, plus
// any name the deck's configuration pins that no shape uses yet. A slot
// picked here is the deck's — `concepts` in the deck's configuration, written
// in place by the edit server — and every open page recolours at once, no
// reload: the page that picked already shows it, the others are sent a
// `concepts` event. Digits 1–6 pin the selected concept to a slot, 0 (or ⌫)
// takes the pin off and the name falls back to its stable hash.

import { escapeHtml } from './escape.js';
import { closeOnBackdrop, selectInList } from './overlay.js';
import { conceptFill, conceptSlot } from './svg.js';
import { UNDO_CHORD } from './undo-chord.js';
import { injectedIn } from './pick.js';

const NAME = /^[a-z][a-z0-9-]{0,40}$/i;

/** Every concept the deck carries: `[{ name, shapes }]`, document order, names configured but unused last. */
export function conceptsOn(stage, concepts = {}) {
  const seen = new Map();
  stage.querySelectorAll('svg [data-concept]').forEach((el) => {
    const name = el.getAttribute('data-concept');
    if (!name || !NAME.test(name)) return;
    seen.set(name, (seen.get(name) ?? 0) + 1);
  });
  for (const name of Object.keys(concepts)) if (!seen.has(name)) seen.set(name, 0);
  return [...seen].map(([name, shapes]) => ({ name, shapes }));
}

// ── shapes and their labels: what "the same box" means across slides ──────

const SHAPES = 'rect, circle, ellipse, polygon, path';
// not a shape an author drew: SVG plumbing, the draw build's injected pieces,
// and whatever the runtime GENERATES (a chart, a terminal cast), which is
// nowhere in the file to be given an attribute — nor what a slide template
// drew, tested against the svg (a slot container above it holds the author's)
const NOT_A_SHAPE = 'defs, marker, clipPath, mask, pattern, symbol, .draw-head, .draw-mask, .chart, .terminal';

/** Is `el` a shape an author drew, one a concept can be attached to? */
export const isAuthoredShape = (el) => !el.closest(NOT_A_SHAPE) && !injectedIn(el, el.closest('svg'));

/** Every drawn shape in a diagram an author wrote on the deck's slides, document order. */
export function diagramShapes(stage) {
  return [...stage.querySelectorAll(':scope > section svg')].flatMap((svg) => [...svg.querySelectorAll(SHAPES)])
    .filter(isAuthoredShape);
}

/** The element that gives `shape` its concept (itself or a group in its diagram), or null. */
export function conceptHolder(shape) {
  const svg = shape.closest('svg');
  const holder = shape.closest('[data-concept]');
  return holder && holder !== svg && svg?.contains(holder) ? holder : null;
}
export const conceptNameOf = (shape) => conceptHolder(shape)?.getAttribute('data-concept') || null;

const num = (v) => { const n = parseFloat(String(v ?? '').trim().split(/[\s,]+/)[0]); return Number.isFinite(n) ? n : null; };
/** A shape's box from its own attributes: no layout read, so a slide not on screen answers too. */
function attrBox(el) {
  const a = (n) => num(el.getAttribute(n));
  switch (el.tagName.toLowerCase()) {
    case 'rect': return a('width') !== null && a('height') !== null ? { x: a('x') ?? 0, y: a('y') ?? 0, w: a('width'), h: a('height') } : null;
    case 'circle': return a('r') !== null ? { x: (a('cx') ?? 0) - a('r'), y: (a('cy') ?? 0) - a('r'), w: 2 * a('r'), h: 2 * a('r') } : null;
    case 'ellipse': return a('rx') !== null && a('ry') !== null ? { x: (a('cx') ?? 0) - a('rx'), y: (a('cy') ?? 0) - a('ry'), w: 2 * a('rx'), h: 2 * a('ry') } : null;
    default: return null;
  }
}
/** Where a label is written: its x/y, or its first tspan's. */
function textPoint(t) {
  const first = t.querySelector('tspan');
  const x = num(t.getAttribute('x')) ?? num(first?.getAttribute('x'));
  const y = num(t.getAttribute('y')) ?? num(first?.getAttribute('y'));
  return x === null || y === null ? null : { x, y };
}
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * The words written on `shape`, the way a person reads "the Agent box": the
 * text in the shape's own group when it is the group's one shape, else the
 * labels of its diagram whose anchor falls inside its box, else the label
 * written right after it. '' when it carries none.
 */
export function shapeLabel(shape) {
  const parent = shape.parentElement;
  if (!parent) return '';
  const texts = (from) => [...from.children].filter((c) => c.tagName.toLowerCase() === 'text');
  if (parent.tagName.toLowerCase() === 'g' && [...parent.children].filter((c) => c.matches(SHAPES)).length === 1) {
    const words = clean(texts(parent).map((t) => t.textContent).join(' '));
    if (words) return words;
  }
  const box = attrBox(shape);
  if (box) {
    const inside = texts(parent).filter((t) => {
      const p = textPoint(t);
      return p && p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
    });
    if (inside.length) return clean(inside.map((t) => t.textContent).join(' '));
  }
  const next = shape.nextElementSibling;
  return next?.tagName.toLowerCase() === 'text' ? clean(next.textContent) : '';
}
const sameLabel = (a, b) => !!a && a.toLowerCase() === b.toLowerCase();
const slideOf = (el) => {
  const sec = el.closest('section');
  return sec ? [...sec.parentElement.children].filter((c) => c.tagName === 'SECTION').indexOf(sec) + 1 : 0;
};

/**
 * The shapes elsewhere on the deck that read the same as `shape` (its label,
 * whatever the case) and are not already the `name` concept. What "attach the
 * look-alikes too" offers: a concept is a recurring idea, and the way a person
 * sees one recur is by the words on the box.
 */
export function lookAlikes(stage, shape, name) {
  const label = shapeLabel(shape);
  if (!label) return [];
  return diagramShapes(stage).filter((s) => s !== shape && conceptNameOf(s) !== name && sameLabel(shapeLabel(s), label));
}

/** A concept name from a label: `Rate limiter` → `rate-limiter`. Null when nothing usable is left. */
export function conceptNameFor(label) {
  const slug = clean(label).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41).replace(/-+$/, '');
  if (!slug) return null;
  return NAME.test(slug) ? slug : NAME.test(`c-${slug}`.slice(0, 41)) ? `c-${slug}`.slice(0, 41) : null;
}

/**
 * Labels worth a concept (SVG_DIAGRAMS): the same words on boxes on two or
 * more slides, painted in two or more colours, and not all one concept
 * already. `[{ label, name, shapes, slides, colours }]`, the most slides
 * first. `paintOf` reads a shape's fill (the computed one in a page).
 */
export function conceptSuggestions(stage, { paintOf = (el) => getComputedStyle(el).fill } = {}) {
  const by = new Map();
  for (const shape of diagramShapes(stage)) {
    const label = shapeLabel(shape);
    if (!label || label.length > 40 || !/\p{L}/u.test(label)) continue;
    const key = label.toLowerCase();
    if (!by.has(key)) by.set(key, { label, shapes: [] });
    by.get(key).shapes.push(shape);
  }
  const out = [];
  for (const { label, shapes } of by.values()) {
    const slides = [...new Set(shapes.map(slideOf))].filter(Boolean).sort((a, b) => a - b);
    if (slides.length < 2) continue;
    const concepts = new Set(shapes.map(conceptNameOf));
    if (concepts.size === 1 && !concepts.has(null)) continue;      // one concept already
    const colours = new Set(shapes.map((s) => paintOf(s)).filter((c) => c && c !== 'none')).size;
    if (colours < 2) continue;
    const name = [...concepts].find(Boolean) ?? conceptNameFor(label);
    if (!name) continue;
    out.push({ label, name, shapes, slides, colours });
  }
  return out.sort((a, b) => b.slides.length - a.slides.length || a.slides[0] - b.slides[0]);
}

/**
 * The suggestions, stamped on the deck's root for a headless reader (`decklight
 * check` reads the print view's DOM, the way it reads `data-overflow`):
 * `data-concept-hints="<label>~<slides>~<name>~<colours>|…"`, the label
 * URI-encoded so no separator or quote can appear in it.
 */
export function markConceptHints(root, stage) {
  const hints = conceptSuggestions(stage);
  if (!hints.length) { root.removeAttribute('data-concept-hints'); return; }
  root.setAttribute('data-concept-hints', hints.map((h) => [encodeURIComponent(h.label), h.slides.join(','), h.name, h.colours].join('~')).join('|'));
}

/** Boxes drawn over `els` (SVG takes no CSS outline), each where its shape is on screen. */
export function createOutlines(root) {
  let boxes = [];
  return {
    show(els) {
      this.clear();
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const box = Object.assign(document.createElement('div'), { className: 'dl-frame dl-concept-outline' });
        Object.assign(box.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
        root.appendChild(box);
        boxes.push(box);
      }
      return boxes.length;
    },
    clear() { for (const b of boxes) b.remove(); boxes = []; },
  };
}

/**
 * `base()` is the edit server's URL, or null when there is none; `stage()` the
 * deck's stage, read when the list opens. `concepts()` is the deck's live map
 * (the engine's `config.concepts`); `apply(map)` repaints the stage with a new
 * one and keeps it as the page's. `tools()` is concept-tools.js (attaching
 * shapes), `slide()` the slide on screen and `goto(n)` goes to one.
 *
 * Three things beyond pinning a slot (SVG_DIAGRAMS):
 *   - WHERE: the selected concept's shapes on the slide on screen are boxed,
 *     its row names the slides it is on, and ←/→ go to the previous or next
 *     of those slides with the list still open.
 *   - PICK (⏎ on a row): the list steps aside for a one-line bar, and a click
 *     on a shape puts it into the concept, or takes it out when it is already
 *     in; the arrows walk the slides meanwhile. Esc comes back to the list.
 *   - NEW (the last row, or N): a name typed in the list, then straight into
 *     picking its shapes, because a concept is nothing until shapes wear it.
 */
export function createConceptsEditor({
  root, base, toast, stage, concepts, apply, pageId = () => '', debugLog = () => {},
  tools = () => null, slide = () => 1, goto = () => {},
}) {
  let el = null, rows = [], sel = 0, busy = false;
  let picking = null;      // the concept name while pick mode is on
  let naming = false;      // the New concept… row is a text box
  const offered = new Set();   // labels whose look-alikes pick mode has already offered
  const outlines = createOutlines(root);
  const hover = createOutlines(root);
  const card = () => el?.querySelector('.narr-card');
  const sections = () => [...stage().querySelectorAll(':scope > section')];

  const pinOf = (name) => {
    const v = concepts()?.[name];
    if (typeof v === 'number') return { slot: v, how: 'pinned' };
    if (typeof v === 'string') return { slot: null, how: 'custom', css: v };
    return { slot: conceptSlot(name), how: 'auto' };
  };
  /** The slides a concept's shapes are on, in order. */
  const slidesOf = (name) => {
    const secs = sections();
    const at = new Set();
    stage().querySelectorAll(`svg [data-concept="${CSS.escape(name)}"]`).forEach((n) => {
      const i = secs.indexOf(n.closest('section'));
      if (i >= 0) at.add(i + 1);
    });
    return [...at].sort((a, b) => a - b);
  };
  /** The concept's drawn shapes on the slide on screen, for the boxes. */
  const shapesHere = (name) => {
    const sec = sections()[slide() - 1];
    if (!sec || !name) return [];
    return diagramShapes(stage()).filter((s) => s.closest('section') === sec && conceptNameOf(s) === name);
  };
  const said = (slides) => (!slides.length ? 'on no slide yet' : slides.length === 1 ? `slide ${slides[0]}` : `slides ${slides.join(', ')}`);

  function render() {
    const c = card();
    if (!c) return;
    rows = conceptsOn(stage(), concepts());
    let html = '<div class="narr-head">concept colors — one colour per idea, on every slide</div>';
    if (!rows.length) html += '<div class="rec-line">No diagram on this deck names a concept yet. Make one below, then click the shapes that are it.</div>';
    rows.forEach((r, i) => {
      const pin = pinOf(r.name);
      const fill = conceptFill(r.name, concepts());
      const slots = [1, 2, 3, 4, 5, 6].map((n) => `<button type="button" class="cc-slot${pin.slot === n ? ' cc-on' : ''}" data-i="${i}" data-slot="${n}" `
        + `style="background: var(--d-fill-${n})" title="Fill ${n}" aria-label="${escapeHtml(r.name)} → fill ${n}" aria-pressed="${pin.slot === n}"></button>`).join('');
      const how = pin.how === 'pinned' ? `pinned to fill ${pin.slot}` : pin.how === 'custom' ? `custom · ${escapeHtml(pin.css)}` : `fill ${pin.slot} by its name`;
      html += `<div class="narr-row cc-row" data-i="${i}" data-name="${escapeHtml(r.name)}">`
        + `<span class="cc-swatch" style="background: ${escapeHtml(fill)}"></span>`
        + `<span class="narr-row-label">${escapeHtml(r.name)} <span class="narr-flavor">${r.shapes} shape${r.shapes === 1 ? '' : 's'} · ${said(slidesOf(r.name))} · ${how}</span></span>`
        + `<span class="cc-slots">${slots}<button type="button" class="cc-auto${pin.how === 'auto' ? ' cc-on' : ''}" data-i="${i}" title="no pin — the name picks its own slot" aria-pressed="${pin.how === 'auto'}">auto</button>`
        + `<button type="button" class="cc-pick" data-i="${i}" title="click shapes on the slides to put them in “${escapeHtml(r.name)}”, or take them out">pick shapes</button></span>`
        + '</div>';
    });
    html += `<div class="narr-row cc-row cc-new" data-i="${rows.length}">`
      + (naming
        ? '<input class="narr-input cc-new-name" type="text" placeholder="a name — agent, tools, data…" aria-label="New concept name" spellcheck="false">'
        : '<span class="narr-row-label">New concept… <span class="narr-flavor">name it, then click its shapes</span></span>')
      + '</div>';
    html += '<div class="rec-hint">↑/↓ · ⏎ picks shapes · ←/→ the slides it is on · 1–6 pins the slot, 0 takes the pin off · N new · Esc closes</div>';
    c.innerHTML = html;
    c.querySelectorAll('.cc-row').forEach((r) => r.addEventListener('mouseenter', () => select(Number(r.dataset.i))));
    c.querySelectorAll('.cc-slot').forEach((b) => b.addEventListener('click', () => { select(Number(b.dataset.i)); pin(Number(b.dataset.slot)); }));
    c.querySelectorAll('.cc-auto').forEach((b) => b.addEventListener('click', () => { select(Number(b.dataset.i)); pin(null); }));
    c.querySelectorAll('.cc-pick').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); startPicking(rows[Number(b.dataset.i)].name); }));
    c.querySelector('.cc-new')?.addEventListener('click', () => { if (!naming) startNaming(); });
    const input = c.querySelector('.cc-new-name');
    if (input) {
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          const name = input.value.trim();
          if (!NAME.test(name)) { toast('a concept is a name: letters, digits and dashes, starting with a letter', 3200); return; }
          naming = false;
          startPicking(name);
        } else if (e.key === 'Escape') { e.preventDefault(); naming = false; render(); }
      });
      setTimeout(() => input.focus(), 0);
    }
    select(Math.min(sel, rows.length));
  }

  function select(i) {
    sel = Math.max(0, Math.min(i, rows.length));
    selectInList([...(card()?.querySelectorAll('.cc-row') ?? [])], sel, 'narr-sel');
    outlines.show(shapesHere(rows[sel]?.name));
  }

  /** Pin the selected concept to `slot` (1–6), or take its pin off (null). */
  async function pin(slot) {
    const r = rows[sel];
    if (!r || busy) return;
    const was = { ...(concepts() ?? {}) };
    const next = { ...was };
    if (slot === null) delete next[r.name]; else next[r.name] = slot;
    if (JSON.stringify(next) === JSON.stringify(was)) return;
    busy = true;
    apply(next);   // at once: the write below is what makes it the deck's
    render();
    try {
      const res = await fetch(`${base()}/deck/edit/concepts`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ concepts: next, quiet: true, from: pageId() }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || `the edit server answered ${res.status}`);
      debugLog('concepts', `${r.name} → ${slot === null ? 'auto' : `fill ${slot}`}`);
      toast(slot === null ? `${r.name}: pin taken off — fill ${conceptSlot(r.name)} by its name · ${UNDO_CHORD} takes it back` : `${r.name} → fill ${slot}, deck-wide · ${UNDO_CHORD} takes it back`, 2600);
    } catch (e) {
      apply(was);
      render();
      toast(`concept not saved: ${String(e.message || e).slice(0, 90)}`, 3400);
    } finally {
      busy = false;
    }
  }

  /** ←/→: the previous or next slide the selected concept is on, the list kept open. */
  function visit(dir) {
    const name = rows[sel]?.name;
    if (!name) return;
    const at = slidesOf(name);
    if (!at.length) { toast(`“${name}” is on no slide yet — ⏎ to pick its shapes`, 2200); return; }
    const now = slide();
    const to = dir > 0 ? (at.find((n) => n > now) ?? at[0]) : ([...at].reverse().find((n) => n < now) ?? at.at(-1));
    goto(to);
    outlines.clear();
    // the boxes follow once the slide has landed (a transition moves it)
    setTimeout(() => { if (el) select(sel); }, 450);
  }

  function startNaming() {
    naming = true;
    sel = rows.length;
    render();
  }

  // ── pick mode ─────────────────────────────────────────────────────────
  /** The shape a click in a diagram means: the shape itself, or the box a label is written on. */
  function shapeAt(target) {
    const svg = target?.closest?.('svg');
    if (!svg || !svg.closest('section') || !stage().contains(svg)) return null;
    const shapes = diagramShapes(stage());
    const own = target.closest('rect, circle, ellipse, polygon, path');
    if (own && shapes.includes(own)) return own;
    const label = target.closest('text');
    if (!label) return null;
    return shapes.find((s) => s.closest('svg') === svg && shapeLabel(s) && shapeLabel(s) === clean(label.textContent)
      && (s.parentElement === label.parentElement)) ?? null;
  }
  const onPointer = (e) => {
    if (!picking) return;
    const shape = shapeAt(e.target);
    if (shape) hover.show([shape]); else hover.clear();
  };
  const onClick = async (e) => {
    if (!picking || e.target.closest?.('.decklight-concepts')) return;
    const shape = shapeAt(e.target);
    if (!shape) return;
    e.preventDefault();
    e.stopPropagation();
    const name = picking;
    const holder = conceptHolder(shape);
    const out = conceptNameOf(shape) === name;
    const t = tools();
    if (!t) return;
    await t.attach([out ? holder ?? shape : shape], out ? null : name, { offer: false });
    // once per label: the other boxes that say the same, offered
    const label = shapeLabel(shape);
    if (!out && label && !offered.has(label.toLowerCase())) {
      offered.add(label.toLowerCase());
      t.offerLookAlikes(shape, name);
    }
    paintPicking();
  };
  function paintPicking() {
    const c = card();
    if (!c || !picking) return;
    const n = stage().querySelectorAll(`svg [data-concept="${CSS.escape(picking)}"]`).length;
    c.innerHTML = `<div class="cc-pickbar"><span class="cc-swatch" style="background: ${escapeHtml(conceptFill(picking, concepts()))}"></span>`
      + `<span class="cc-pick-text">picking shapes for <b>${escapeHtml(picking)}</b> · ${n} shape${n === 1 ? '' : 's'} · click a shape to put it in, click it again to take it out · ←/→ slides</span>`
      + '<button type="button" class="cc-pick-done">Done</button></div>';
    c.querySelector('.cc-pick-done').addEventListener('click', stopPicking);
    outlines.show(shapesHere(picking));
  }
  function startPicking(name) {
    if (!el) return;
    picking = name;
    el.classList.add('cc-picking');
    document.addEventListener('click', onClick, true);
    document.addEventListener('pointermove', onPointer, true);
    paintPicking();
  }
  function stopPicking() {
    if (!picking) return;
    const name = picking;
    picking = null;
    el?.classList.remove('cc-picking');
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('pointermove', onPointer, true);
    hover.clear();
    if (!el) return;
    render();
    const i = rows.findIndex((r) => r.name === name);
    if (i >= 0) select(i);
  }

  /** Open the list; `select` puts the cursor on that concept's row (the menu's Edit concepts…). */
  function open({ select: name = null } = {}) {
    if (el) { if (name) selectNamed(name); return; }
    if (base() === null) { toast('concept colors are set in write mode — decklight <deck.html>', 3200); return; }
    el = document.createElement('div');
    el.className = 'decklight-narr decklight-record decklight-concepts';
    el.innerHTML = '<div class="narr-card" role="listbox" aria-label="Concept colors"></div>';
    closeOnBackdrop(el, close);
    root.appendChild(el);
    sel = 0;
    naming = false;
    render();
    if (name) selectNamed(name);
  }
  function selectNamed(name) {
    const i = rows.findIndex((r) => r.name === name);
    if (i >= 0) select(i);
  }

  function close() {
    if (picking) stopPicking();
    el?.remove(); el = null; rows = []; naming = false;
    outlines.clear(); hover.clear();
  }

  function keydown(e) {
    if (picking) {
      if (e.key === 'Escape' || e.key === 'Enter') { stopPicking(); return true; }
      // the slides, to pick on another one: the deck has the arrows
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'PageUp' || e.key === 'PageDown' || e.key === ' ') {
        setTimeout(() => { if (picking) paintPicking(); }, 450);
        return false;
      }
      return true;
    }
    if (e.key === 'Escape') { close(); return true; }
    if (e.key === 'ArrowDown') { select(sel + 1); return true; }
    if (e.key === 'ArrowUp') { select(sel - 1); return true; }
    if (e.key === 'ArrowRight') { visit(1); return true; }
    if (e.key === 'ArrowLeft') { visit(-1); return true; }
    if (e.key === 'Enter') { if (sel >= rows.length) startNaming(); else startPicking(rows[sel].name); return true; }
    if (e.key === 'n' || e.key === 'N') { startNaming(); return true; }
    if (/^[1-6]$/.test(e.key)) { pin(Number(e.key)); return true; }
    if (e.key === '0' || e.key === 'Backspace') { pin(null); return true; }
    return true;   // the list holds the keyboard while it is open
  }

  /** The deck's concepts changed (here, or on another page): the list follows. */
  function refresh() { if (!el) return; if (picking) paintPicking(); else if (!naming) render(); }

  return {
    open, close, keydown, refresh, isOpen: () => !!el,
    /** Pick mode lets the deck's own keys through (the arrows walk the slides). */
    modal: () => !picking,
    /** Straight into picking `name`'s shapes, the list opened for it. */
    pick: (name) => { open(); if (el) startPicking(name); },
    picking: () => picking,
  };
}
