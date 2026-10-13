// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Copy style, paste style (PRESENTING, write mode): one shape's look put on
 * another, the format painter every slide tool has.
 *
 * What a style IS here is what the inspector's Colors and Type tabs write
 * (colorpicker.js), and nothing else, so a paste is the same closed set of
 * declarations a pick would make and the server refuses the same things:
 * the fill, the border and its width, the text's colour, and its type (size,
 * weight, font role, italic, alignment). Copied by ROLE, not by property, so
 * a diagram box pastes onto a CSS box: its fill becomes a background, its
 * stroke a border, its label's ink the text colour, `middle` becomes
 * `center`.
 *
 * A colour the source has written in its markup is copied as written, a
 * theme token by reference, so the paste stays theme-aware. A colour it only
 * inherits (the theme's, a class's) is copied as what it looks like: the
 * paste first tries taking the target's own value off, and keeps that when
 * the target then looks the same, else writes the hex. Type is copied only
 * where the source sets it, and a size only between two of the same kind
 * (a diagram's px are its viewBox's, not the slide's). A shape in a concept
 * (SVG_DIAGRAMS) pastes its CONCEPT onto a diagram shape, not the concept's
 * colour, and a pasted plain colour takes the target out of its concept,
 * since a concept would paint over it.
 *
 * The clip is remembered per browser, so it outlives the reload another
 * edit causes and reaches a second deck in another tab.
 */

import { colorTargets, resolveColor, rgbToHex } from './colorpicker.js';
import { readJson, writePref } from './prefs.js';
import { asSlotFill } from './svg.js';
import { IS_MAC, UNDO_CHORD } from './undo-chord.js';

const KEY = 'decklight-style-clip';

// the chords as this machine spells them: ⌥⌘ on a Mac, Ctrl+Alt elsewhere
const MAC = IS_MAC;   // undo-chord.js: one check for the whole runtime
export const STYLE_KEYS = Object.freeze({ copy: MAC ? '⌥⌘C' : 'Ctrl+Alt+C', paste: MAC ? '⌥⌘V' : 'Ctrl+Alt+V' });

// the server's value shapes (cli/edit.mjs STYLE_VALUE, WIDTH_VALUE, TYPE_VALUES): a
// value it would refuse is never copied
const COLOUR = /^(?:var\(--[a-z][a-z0-9-]{0,40}(?:,\s?#[0-9a-f]{3,8})?\)|#[0-9a-f]{3,8})$/i;
const TYPE = {
  'font-size': /^(?:[1-9]\d{0,2}(?:\.\d)?)px$/,
  'font-weight': /^[1-9]00$/,
  'font-family': /^var\(--font-(?:heading|body|mono)\)$/,
  'font-style': /^(?:normal|italic)$/,
};
const COLOUR_PROPS = new Set(['fill', 'color', 'background-color', 'stroke', 'border-color']);
const TO_ANCHOR = { left: 'start', center: 'middle', right: 'end', start: 'start', middle: 'middle', end: 'end' };
const TO_ALIGN = { start: 'left', middle: 'center', end: 'right', left: 'left', center: 'center', right: 'right' };

const isSvg = (t) => typeof SVGElement !== 'undefined' && t.el instanceof SVGElement;
// what the markup says, not what the engine painted since: a diagram shape's
// fill is repainted with its panel's nested tone (svg.js applyNesting), and
// the fill the author wrote is kept aside on the shape as `data-nest-fill`
const authored = (el, prop) => (prop === 'fill' && el.dataset?.nestFill !== undefined && !el.closest('[data-concept]')
  ? el.dataset.nestFill : el.style.getPropertyValue(prop)).trim();
const computed = (el, prop) => getComputedStyle(el).getPropertyValue(prop).trim();
const same = (a, b) => !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b;

/** One colour role of `t`: as written (a token or a hex), and as it shows. */
function colourOf(t) {
  if (!t) return null;
  const own = authored(t.el, t.prop);
  // a literal the markup wrote as `#fff` reads back as `rgb(255, 255, 255)`: still the markup's, said in hex
  const literal = own && !own.startsWith('var(') ? resolveColor(own) : null;
  return { token: COLOUR.test(own) ? own : literal ? rgbToHex(literal) : null, rgb: resolveColor(computed(t.el, t.prop)) };
}

/**
 * The style of what a target names (editmode's `{ top, clicked }`), as a
 * clip: `{ kind, what, concept, fill, stroke, width, text, type }`, or null
 * when there is nothing there to take a style from.
 */
export function copyStyle(target) {
  const tg = target?.top && colorTargets(target.top, target.clicked ?? target.node ?? target.top);
  if (!tg) return null;
  const any = tg.fill[0] ?? tg.text[0];
  const kind = isSvg(any) ? 'svg' : 'html';
  const stroke = tg.stroke?.[0];
  const widthProp = kind === 'svg' ? 'stroke-width' : 'border-width';
  const width = stroke ? parseFloat(computed(stroke.el, widthProp)) : NaN;
  const t = tg.text[0];
  const type = {};
  if (t) {
    for (const [prop, shape] of Object.entries(TYPE)) {
      const v = authored(t.el, prop);
      if (shape.test(v)) type[prop] = v;
    }
    const a = authored(t.el, isSvg(t) ? 'text-anchor' : 'text-align');
    if (TO_ANCHOR[a]) type.align = TO_ANCHOR[a];
  }
  return {
    kind,
    what: tg.what,
    concept: tg.concept?.name ?? null,
    fill: colourOf(tg.fill[0]),
    stroke: colourOf(stroke),
    width: Number.isFinite(width) ? String(Math.round(width * 100) / 100) : null,
    text: colourOf(t),
    type,
  };
}

/**
 * What pasting `clip` onto a target writes: `{ changes, concept }`, where a
 * change is `{ t, prop, value }` (colorTargets' target; value null takes the
 * declaration off) and `concept` is `{ at, value }` or null. Nothing on the
 * page is left changed: each "would taking it off look the same?" is tried
 * and put back.
 */
export function pasteChanges(clip, target, { snap = null } = {}) {
  const tg = target?.top && colorTargets(target.top, target.clicked ?? target.node ?? target.top);
  if (!clip || !tg) return null;
  const changes = [];
  // a deck held to its brand (SPEC BRAND_PALETTE) takes no literal colour: one
  // is put on the palette swatch nearest it, and the paste says which
  const snapped = [];
  const onBrand = (v) => {
    // a design system's roles (SPEC DESIGN_SYSTEM_ROLES) take no other token either
    if (!snap || !v || (v.startsWith('var(') && !snap.roles)) return v;
    const s = snap(v);
    if (!s) return v;
    snapped.push(s.ref);
    return s.value;
  };
  const set = (t, prop, value) => {
    const own = authored(t.el, prop);
    if (own === (value ?? '')) return;
    // `#ffffff` asked, `rgb(255, 255, 255)` read back: the same literal already written
    if (COLOUR_PROPS.has(prop) && value && own && !value.startsWith('var(') && !own.startsWith('var(')
      && same(resolveColor(own), resolveColor(value))) return;
    changes.push({ t, prop, value });
  };
  /** Make `t` show `src`: its token, else nothing of its own if that already looks right, else the hex. */
  const colour = (t, src) => {
    if (!t || !src) return;
    if (src.token) { set(t, t.prop, onBrand(src.token)); return; }
    const own = authored(t.el, t.prop);
    const inline = t.el.style.getPropertyValue(t.prop);
    const priority = t.el.style.getPropertyPriority(t.prop);
    if (inline) t.el.style.removeProperty(t.prop);
    const bare = resolveColor(computed(t.el, t.prop));
    if (inline) t.el.style.setProperty(t.prop, inline, priority);
    if (!src.rgb) { if (own && !bare) set(t, t.prop, null); return; }
    if (same(bare, src.rgb)) { if (own) set(t, t.prop, null); return; }
    if (!same(resolveColor(computed(t.el, t.prop)), src.rgb)) set(t, t.prop, onBrand(rgbToHex(src.rgb)));
  };
  const shape = tg.fill[0];
  const kind = isSvg(shape ?? tg.text[0]) ? 'svg' : 'html';
  let concept = null;
  if (kind === 'svg' && tg.conceptAt) {
    const here = tg.conceptAt;
    if (clip.concept && clip.kind === 'svg') {
      // the concept, not its colour: the deck paints it, and keeps painting it when the theme changes
      if (here.name !== clip.concept) concept = { at: here, value: clip.concept };
    } else if (here.name && shape) {
      // out of its concept: the fill it shows is the concept's paint, not the
      // file's, so it is planned as a shape with no fill of its own
      concept = { at: here, value: null };
      const paint = ['fill', 'stroke'].map((p) => [p, shape.el.style.getPropertyValue(p)]);
      for (const [p] of paint) shape.el.style.removeProperty(p);
      colour(shape, clip.fill);
      for (const [p, v] of paint) if (v) shape.el.style.setProperty(p, v);
    } else {
      colour(shape, clip.fill);
    }
  } else {
    colour(shape, clip.fill);
  }
  const stroke = tg.stroke?.[0];
  if (stroke && !(concept?.value && stroke.el === shape?.el && shape.el.getAttribute('fill') === 'none')) {
    colour(stroke, clip.stroke);
    if (clip.stroke?.rgb && clip.width) {
      const prop = kind === 'svg' ? 'stroke-width' : 'border-width';
      if (Math.abs(parseFloat(computed(stroke.el, prop)) - Number(clip.width)) > 0.01) set(stroke, prop, kind === 'svg' ? clip.width : `${clip.width}px`);
    }
  }
  for (const t of tg.text) {
    colour(t, clip.text);
    for (const prop of ['font-weight', 'font-family', 'font-style']) if (clip.type[prop]) set(t, prop, clip.type[prop]);
    if (clip.type['font-size'] && clip.kind === kind) set(t, 'font-size', clip.type['font-size']);
    if (clip.type.align) {
      const svgText = isSvg(t);
      set(t, svgText ? 'text-anchor' : 'text-align', (svgText ? TO_ANCHOR : TO_ALIGN)[clip.type.align]);
    }
  }
  return { changes, concept, snapped: [...new Set(snapped)], snapRoles: !!snap?.roles };
}

/** A clip said in a few words, for the toast: `box · “agent”`, `box · fill 3`, `blockquote · #2a6f97`. */
export function describeClip(clip) {
  const name = (token) => {
    const slot = /^var\(--d-fill-(\d)\)$/.exec(asSlotFill(token ?? ''));
    if (slot) return `fill ${slot[1]}`;
    return /^var\(--([a-z0-9-]+)/i.exec(token ?? '')?.[1] ?? token;
  };
  const colour = clip.concept ? `“${clip.concept}”` : name(clip.fill?.token) ?? (clip.fill?.rgb ? rgbToHex(clip.fill.rgb) : null);
  const what = /^(rect|circle|ellipse|polygon|path)$/.test(clip.what) ? 'box' : clip.what;
  return [what, colour].filter(Boolean).join(' · ');
}

/**
 * The clipboard: `copy(target)` and `paste(target)`, the menu's rows and
 * ⌥⌘C / ⌥⌘V on a selection. `save({ slide, index, edits, concept })` is the
 * in-place style write (editmode.saveStyles); `repaint()` puts the deck's
 * concept colours back on after a paste moved a concept.
 */
export function createStyleClip({ save, toast, repaint = () => {}, snap = () => null, debugLog = () => {} }) {
  let clip = readJson(KEY, null);
  const has = () => !!clip;

  function copy(target) {
    const c = copyStyle(target);
    if (!c) { toast('nothing here has a style to copy', 2200); return false; }
    clip = c;
    writePref(KEY, JSON.stringify(c));
    debugLog('edit', `style copied: ${describeClip(c)}`);
    toast(`style copied: ${describeClip(c)} · ${STYLE_KEYS.paste} pastes it on another shape`, 2800);
    return true;
  }

  async function paste(target) {
    if (!clip) { toast(`no style copied yet: ${STYLE_KEYS.copy} on a shape copies its style`, 2600); return false; }
    const plan = pasteChanges(clip, target, { snap: snap() });
    if (!plan) { toast('nothing here takes a style', 2200); return false; }
    const { changes, concept } = plan;
    if (!changes.length && !concept) { toast('already that style', 2000); return false; }
    // shown first, the way a pick is: the write is in place and nothing reloads
    const before = changes.map((c) => [c, c.t.el.style.getPropertyValue(c.prop), c.t.el.style.getPropertyPriority(c.prop), c.t.el.dataset?.nestFill]);
    for (const c of changes) {
      if (c.value === null) c.t.el.style.removeProperty(c.prop); else c.t.el.style.setProperty(c.prop, c.value);
      if (c.prop === 'fill' && c.t.el.dataset?.nestFill !== undefined) c.t.el.dataset.nestFill = c.value ?? '';
    }
    const holder = concept?.at.el;
    const was = holder?.getAttribute('data-concept') ?? null;
    if (holder) {
      if (concept.value) holder.setAttribute('data-concept', concept.value);
      else unpaintConcept(holder, changes);
    }
    try {
      await save({
        slide: target.slide, index: target.index,
        edits: changes.map((c) => ({ path: c.t.path, tag: c.t.tag, prop: c.prop, value: c.value })),
        concept: concept ? { path: concept.at.path, tag: concept.at.tag, value: concept.value } : null,
      });
    } catch (e) {
      for (const [c, v, pr, nest] of before) {
        if (v) c.t.el.style.setProperty(c.prop, v, pr); else c.t.el.style.removeProperty(c.prop);
        if (c.prop === 'fill' && nest !== undefined) c.t.el.dataset.nestFill = nest;
      }
      if (holder) { if (was) holder.setAttribute('data-concept', was); else holder.removeAttribute('data-concept'); }
      if (concept) repaint();
      toast(`style not pasted: ${String(e?.message || e).slice(0, 90)}`, 3400);
      return false;
    }
    if (concept) repaint();
    debugLog('edit', `style pasted on slide ${target.slide} #${target.index}: ${changes.length} declaration${changes.length === 1 ? '' : 's'}${concept ? `, concept ${concept.value ?? '(detached)'}` : ''}`);
    toast(plan.snapped.length ? `style pasted, on the brand's ${plan.snapRoles ? 'roles' : 'palette'}: ${plan.snapped.join(', ')} · ${UNDO_CHORD} takes it back` : `style pasted · ${UNDO_CHORD} takes it back`, plan.snapped.length ? 3200 : 2200);
    return true;
  }

  return { copy, paste, has, clip: () => clip, keys: STYLE_KEYS };
}

/** A concept taken off by a paste: its paint goes too, except where the paste just wrote one. */
function unpaintConcept(holder, changes) {
  holder.removeAttribute('data-concept');
  const shapes = holder.matches('rect, circle, ellipse, polygon, path') ? [holder]
    : [...holder.children].filter((c) => c.matches('rect, circle, ellipse, polygon, path'));
  for (const s of shapes) {
    for (const prop of ['fill', 'stroke']) {
      if (!changes.some((c) => c.t.el === s && c.prop === prop)) s.style.removeProperty(prop);
    }
  }
}
