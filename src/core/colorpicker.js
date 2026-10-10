// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The colour picker of element edit mode (SPEC PRESENTING): a shape's
 * background and the text on it, from the theme's own palette or a colour of
 * your own.
 *
 * Two tabs, and the split is the point. **Theme** writes a token BY REFERENCE
 * — `var(--d-fill-3)`, never the hex it happens to resolve to today — so a
 * recoloured box still follows `T` to the next theme and still passes the
 * theme gates. **Custom** writes a literal hex, which is what you want for a
 * brand colour and exactly what stops following the theme; it lives on its
 * own tab so reaching for it is a decision rather than the default.
 *
 * A deck that uses a design system (SPEC DESIGN_SYSTEMS) gets its palette on
 * the Theme tab too, after the theme's own, under the names the design system
 * gives its colours. Those write `var(--token, #rrggbb)` — the hex is what the
 * token is at pick time — because the token is the design system's, not the
 * theme's: the box keeps its brand colour through `T`, and still has it if
 * the design system goes missing.
 *
 * The colour maths and the target resolution are pure and exported for the
 * unit tests; the card is the only part that needs a document.
 */

// ----- colour maths (pure) --------------------------------------------------

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** h 0–360, s and v 0–100 → `{r,g,b}` 0–255. */
export function hsbToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; v = clamp(v, 0, 100) / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/** `{r,g,b}` 0–255 → `{h,s,v}` (h 0–360, s and v 0–100), rounded to whole units. */
export function rgbToHsb({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  let h = 0;
  if (d) {
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h: Math.round(h) % 360, s: Math.round(max ? (d / max) * 100 : 0), v: Math.round(max * 100) };
}

export function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map((n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')).join('');
}

/** `#rgb` or `#rrggbb` (the `#` optional — it is what people paste) → `{r,g,b}`, else null. */
export function hexToRgb(text) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

// ----- the theme palette ----------------------------------------------------

/**
 * The palette rows, in the order the card shows them. `--link` is the theme's
 * SECONDARY colour only where it is one: a theme whose links are simply its
 * accent has a primary and no secondary, and the row is left out rather than
 * offered as a second name for the same colour.
 */
export const PALETTE = [
  { group: 'Theme', items: [
    { label: 'Primary', token: '--accent' },
    { label: 'Secondary', token: '--link', unlessSameAs: '--accent' },
    { label: 'On primary', token: '--accent-contrast' },
    { label: 'Heading', token: '--heading-color' },
    { label: 'Text', token: '--fg' },
    { label: 'Muted', token: '--muted' },
    { label: 'Background', token: '--bg' },
    { label: 'Background alt', token: '--bg-accent' },
    { label: 'Block', token: '--block-bg' },
  ] },
  { group: 'Diagram fills', compact: true, items: [1, 2, 3, 4, 5, 6].map((n) => ({ label: `Fill ${n}`, short: String(n), token: `--d-fill-${n}` })) },
  { group: 'Diagram ink', items: [
    { label: 'Diagram accent', token: '--d-accent' },
    { label: 'Diagram text', token: '--d-text' },
    { label: 'Diagram muted', token: '--d-muted' },
    { label: 'Diagram stroke', token: '--d-stroke' },
  ] },
];

/** PALETTE against a token reader: undefined tokens dropped, a secondary equal to its primary dropped. */
export function themePalette(read) {
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  return PALETTE.map((g) => ({
    ...g,
    items: g.items
      .map((it) => ({ ...it, value: norm(read(it.token)) }))
      .filter((it) => it.value && !(it.unlessSameAs && it.value === norm(read(it.unlessSameAs)))),
  })).filter((g) => g.items.length);
}

/** A token a style value may name — the same shape the edit server accepts. */
const TOKEN = /^--[a-z][a-z0-9-]{0,40}$/i;

/**
 * The palettes of the deck's design systems, against a token reader: one
 * group per design system and palette `group`, in the order the deck uses
 * them, headed `<title> · <group>` (just `<title>` when its palette has one
 * group); a token the page leaves undefined is dropped, like a theme's.
 * `systems` is the page's design-system metas: `[{ name, title, palette:
 * [{ group, label, token }] }]`.
 */
export function systemPalette(systems, read) {
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const out = [];
  for (const sys of systems ?? []) {
    const entries = (Array.isArray(sys?.palette) ? sys.palette : [])
      .filter((p) => p && typeof p.label === 'string' && TOKEN.test(String(p.token)));
    const title = String(sys.title || sys.name || 'Design system');
    const declared = new Set(entries.map((p) => String(p.group ?? '').trim()));
    const groups = new Map();
    for (const p of entries) {
      const value = norm(read(p.token));
      if (!value) continue;
      const g = String(p.group ?? '').trim();
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push({ label: p.label, token: p.token, value });
    }
    for (const [g, items] of groups) {
      out.push({ group: declared.size > 1 && g ? `${title} · ${g}` : title, system: sys.name, fallback: true, items });
    }
  }
  return out;
}

/** The token a written value names — `var(--x)` or `var(--x, #hex)` → `--x` — or null. */
export function tokenOf(value) {
  return /^var\(\s*(--[a-z][a-z0-9-]*)\s*(?:,[^()]*)?\)$/i.exec(String(value ?? '').trim())?.[1] ?? null;
}

/** What a design-system pick writes: the token, and what it is now as the fallback. */
export function fallbackValue(token, rgb) {
  return rgb ? `var(${token}, ${rgbToHex(rgb)})` : `var(${token})`;
}

// ----- what a right-click means ---------------------------------------------

const SVG_SHAPES = 'rect, circle, ellipse, polygon, path';
/** Nodes the ENGINE put in the page (builds.js's arrowheads): in the DOM, not in the file. */
const INJECTED = '.draw-head';
/** …and what a slide template brought (SPEC DESIGN_SYSTEMS) — never on a path into the file. */
const INJECTED_ON_PATH = '.draw-head, [data-ds-injected]';

/**
 * The child-index path from `top` down to `el`, counted the way the file
 * counts — over element children, minus the ones the engine added. `[]` is
 * `top` itself; null when `el` is not under it, or sits inside an injected node.
 */
export function pathFrom(top, el) {
  const path = [];
  for (let n = el; n !== top; n = n.parentElement) {
    const parent = n?.parentElement;
    if (!parent || n.matches(INJECTED_ON_PATH)) return null;
    path.unshift([...parent.children].filter((c) => !c.matches(INJECTED_ON_PATH)).indexOf(n));
  }
  return path;
}

/**
 * The concept a right-click lands on (SPEC SVG_DIAGRAMS, #718): the shape
 * under `clicked`, or the group it sits in, carrying `data-concept`. Returns
 * `{ name, el, path, tag }` for the HOLDER of the attribute — the element a
 * detach takes it off — or, with no concept, the shape itself with `name`
 * null, which is where a new concept would go. Null off a diagram.
 */
export function conceptOf(top, clicked) {
  const svg = clicked.closest?.('svg');
  if (!svg || !top.contains(svg) || clicked === svg) return null;
  let shape = clicked.closest(SVG_SHAPES);
  if (!shape) {
    const label = clicked.closest('text');
    const group = label?.parentElement;
    shape = group && group !== svg ? [...group.children].find((c) => c.matches(SVG_SHAPES)) ?? null : null;
  }
  if (!shape || shape.closest(INJECTED + ', defs')) return null;
  const holder = shape.closest('[data-concept]');
  const el = holder && svg.contains(holder) && holder !== svg ? holder : shape;
  const path = pathFrom(top, el);
  if (!path) return null;
  return { name: el.getAttribute('data-concept') || null, el, path, tag: el.tagName.toLowerCase() };
}

function inside(outer, inner) {
  const o = outer.getBoundingClientRect(); const i = inner.getBoundingClientRect();
  const cx = i.left + i.width / 2; const cy = i.top + i.height / 2;
  return cx >= o.left && cx <= o.right && cy >= o.top && cy <= o.bottom;
}

/**
 * What "this shape and its text" is for a right-click on `clicked`, inside the
 * slide's top-level child `top`. Returns `{ fill: [target], text: [target…],
 * what }` with a target being `{ el, path, tag, prop }`, or null when there is
 * nothing here to colour.
 *
 * In a diagram the background is the shape's `fill` and the text is the
 * `<text>` that sits on it — the labels sharing its `<g>` (the diagram
 * convention: one group per box), or, for a shape drawn loose on the canvas,
 * the labels whose centre falls inside its box. Clicking the LABEL means the
 * same pair, found from the other side. Anywhere else the element is a box in
 * the CSS sense and both colours are its own: `background-color` and `color`.
 */
export function colorTargets(top, clicked) {
  const target = (el, prop) => {
    const path = pathFrom(top, el);
    return path ? { el, path, tag: el.tagName.toLowerCase(), prop } : null;
  };
  const svg = clicked.closest?.('svg');
  if (svg && top.contains(svg) && clicked !== svg) {
    let shape = clicked.closest(SVG_SHAPES);
    const label = clicked.closest('text');
    const filled = (s) => getComputedStyle(s).fill !== 'none';
    if (!shape && label) {
      const group = label.parentElement;
      const near = group !== svg ? [...group.children].filter((c) => c.matches(SVG_SHAPES)) : [];
      const under = [...svg.querySelectorAll(SVG_SHAPES)].filter((s) => !s.closest(INJECTED + ', defs') && filled(s) && inside(s, label));
      // the smallest box under the label is the one it is written on
      const area = (s) => { const b = s.getBoundingClientRect(); return b.width * b.height; };
      shape = near.find(filled) ?? under.sort((a, b) => area(a) - area(b))[0] ?? null;
    }
    if (shape?.closest(INJECTED + ', defs')) shape = null;
    let labels = [];
    if (shape) {
      const group = shape.parentElement;
      labels = group !== svg && group.tagName.toLowerCase() === 'g'
        ? [...group.children].filter((c) => c.tagName.toLowerCase() === 'text')
        : [...svg.querySelectorAll('text')].filter((t) => inside(shape, t));
    } else if (label) labels = [label];
    const fill = shape ? [target(shape, 'fill')].filter(Boolean) : [];
    // the border is the same shape's stroke (#717): a third side, never the fill
    const stroke = shape ? [target(shape, 'stroke')].filter(Boolean) : [];
    const text = labels.map((t) => target(t, 'fill')).filter(Boolean);
    // a shape the deck colours by concept (#718): the Fill side says so instead of offering a pick that would not take
    const concept = shape ? conceptOf(top, shape) : null;
    return fill.length || text.length ? { fill, stroke, text, what: shape ? shape.tagName.toLowerCase() : 'text', concept: concept?.name ? concept : null } : null;
  }
  // an HTML box: climb out of inline runs and out of a highlighted <pre>, whose
  // spans are the highlighter's and not the file's
  let el = clicked.closest('pre') ?? clicked;
  while (el !== top && top.contains(el) && getComputedStyle(el).display.startsWith('inline')) el = el.parentElement;
  if (!top.contains(el)) el = top;
  const fill = [target(el, 'background-color')].filter(Boolean);
  const stroke = [target(el, 'border-color')].filter(Boolean);
  const text = [target(el, 'color')].filter(Boolean);
  return fill.length ? { fill, stroke, text, what: el.tagName.toLowerCase() } : null;
}

// ----- the card -------------------------------------------------------------

let probe = null;
/** Any CSS colour the browser understands → `{r,g,b}`; null for none/transparent/garbage. */
function resolveColor(css) {
  if (!css || css === 'none' || css === 'transparent') return null;
  try {
    probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    probe.canvas.width = probe.canvas.height = 1;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000'; probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return a ? { r, g, b } : null;
  } catch { return null; }
}

const h = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

/**
 * Open the card inside `root`. `targets` is colorTargets()'s result; `dock` is
 * the caller's createDock() (dock.js) — the card is a panel BESIDE the slide
 * like every other editing surface, floating or docked to an edge, because
 * the thing being coloured has to stay in view while you colour it.
 * `onApply(edits)` gets the `{ path, tag, prop, value }` list to save — `value`
 * null takes the picker's colour back off — and the card is closed by then.
 * Every pick PREVIEWS on the slide at once; anything but Apply puts the
 * slide back exactly as it was. `systems` is the deck's design-system metas
 * (`pageDesignSystems()`), whose palettes follow the theme's. Returns
 * `{ el, close, apply, isOpen }`.
 */
export function openColorPicker({ root, dock, targets, systems = [], onApply, onClose, onDetach, side: startSide = null }) {
  const SIDES = ['fill', 'stroke', 'text'];
  targets.stroke ??= [];
  const all = [...targets.fill, ...targets.stroke, ...targets.text];
  const saved = (el, prop) => [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
  const before = new Map(all.map((t) => [t, saved(t.el, t.prop)]));
  // the stroke's width travels with its colour (#717): `stroke-width` on a
  // shape, `border-width` on a box — one more declaration, same element
  const widthProp = (t) => (t.prop === 'stroke' ? 'stroke-width' : 'border-width');
  const widthBefore = new Map(targets.stroke.map((t) => [t, saved(t.el, widthProp(t))]));
  // undefined: untouched · null: reset · string: the value to write
  const picks = { fill: undefined, stroke: undefined, text: undefined, width: undefined };
  // the Type side (PRESENTING): the text targets' size, weight, font role,
  // italic and alignment, prop → the same undefined / null / value as picks
  const typePicks = {};
  const isSvg = (t) => t.el instanceof SVGElement;
  const alignProp = (t) => (isSvg(t) ? 'text-anchor' : 'text-align');
  const TYPE_PROPS = ['font-size', 'font-weight', 'font-family', 'font-style', 'align'];
  const propFor = (t, p) => (p === 'align' ? alignProp(t) : p);
  const typeBefore = new Map(targets.text.map((t) => [t, new Map(TYPE_PROPS.map((p) => [p, saved(t.el, propFor(t, p))]))]));
  let side = startSide === 'type' && targets.text.length ? 'type'
    : targets.fill.length ? 'fill' : targets.stroke.length ? 'stroke' : 'text';
  let tab = 'theme';
  let model = 'rgb';
  let rgb = { r: 128, g: 128, b: 128 };
  let hsb = rgbToHsb(rgb);   // kept beside rgb: a grey has no hue to read back, and the H slider must not snap to 0

  const el = h('div', 'decklight-narr decklight-dockable decklight-colorpicker');
  const card = h('div', 'narr-card cp-card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Colors');
  // the header is built once: it is the drag handle, and a handle that is
  // re-created on every pick drops the drag that is holding it
  const head = h('div', 'narr-head');
  head.append(h('span', 'cp-title', `colors & type — ${targets.what} · ⏎ applies`));
  const main = h('div', 'cp-main');
  card.append(head, main);
  el.appendChild(card);

  const authored = (s) => targets[s][0]?.el.style.getPropertyValue(targets[s][0].prop).trim() ?? '';
  const computedName = (prop) => ({ 'background-color': 'backgroundColor', 'border-color': 'borderColor' }[prop] ?? prop);
  const current = (s) => {
    const t = targets[s]?.[0];   // the Type side has no colour of its own
    return t ? resolveColor(getComputedStyle(t.el)[computedName(t.prop)]) : null;
  };
  /** The stroke's width as the shape has it now: a pick, else the computed value, in px. */
  const currentWidth = () => {
    if (picks.width !== undefined && picks.width !== null) return picks.width;
    const t = targets.stroke[0];
    const n = t ? parseFloat(getComputedStyle(t.el)[computedName(widthProp(t)) === 'border-width' ? 'borderWidth' : 'strokeWidth']) : NaN;
    return Number.isFinite(n) ? String(n) : '1';
  };
  function preview(s, value) {
    for (const t of targets[s]) {
      if (value === null) { const [v, p] = before.get(t); v ? t.el.style.setProperty(t.prop, v, p) : t.el.style.removeProperty(t.prop); }
      else t.el.style.setProperty(t.prop, value);
    }
  }
  function previewWidth(value) {
    for (const t of targets.stroke) {
      if (value === null) { const [v, p] = widthBefore.get(t); v ? t.el.style.setProperty(widthProp(t), v, p) : t.el.style.removeProperty(widthProp(t)); }
      else t.el.style.setProperty(widthProp(t), value);
    }
  }
  function pick(value) { picks[side] = value; preview(side, value); render(); }
  function previewType(p, value) {
    for (const t of targets.text) {
      const prop = propFor(t, p);
      if (value === null) { const [v, pr] = typeBefore.get(t).get(p); v ? t.el.style.setProperty(prop, v, pr) : t.el.style.removeProperty(prop); }
      else t.el.style.setProperty(prop, value);
    }
  }
  function restore() { for (const s of SIDES) preview(s, null); previewWidth(null); for (const p of TYPE_PROPS) previewType(p, null); }
  function syncFromTarget() { const c = current(side); if (c) { rgb = c; hsb = rgbToHsb(c); } }

  function segmented(cls, label, options, value, onPick) {
    const bar = h('div', 'cp-seg ' + cls);
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', label);
    for (const o of options) {
      const b = h('button', 'cp-seg-btn', o.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(o.id === value));
      b.dataset.id = o.id;
      b.disabled = !!o.disabled;
      if (o.title) b.title = o.title;
      b.addEventListener('click', () => onPick(o.id));
      bar.appendChild(b);
    }
    return bar;
  }

  function renderTheme(body) {
    const style = getComputedStyle(root);
    const chosen = picks[side] === undefined ? authored(side) : picks[side];
    const read = (t) => style.getPropertyValue(t);
    // marked by the token, never by a design-system pick's fallback, which can go stale
    const chosenToken = tokenOf(chosen);
    for (const g of [...themePalette(read), ...systemPalette(systems, read)]) {
      const box = h('div', 'cp-groupbox');
      box.appendChild(h('div', 'cp-group', g.group));
      const grid = h('div', g.compact ? 'cp-swatches cp-compact' : 'cp-swatches');
      for (const it of g.items) {
        const b = h('button', 'cp-swatch');
        b.type = 'button';
        b.dataset.token = it.token;
        b.title = `${it.label} · ${it.token} · ${it.value}`;
        b.setAttribute('aria-label', `${it.label} (${it.token})`);
        b.setAttribute('aria-pressed', String(chosenToken === it.token));
        const chip = h('span', 'cp-chip');
        chip.style.background = `var(${it.token})`;
        b.append(chip, h('span', 'cp-label', g.compact ? it.short : it.label));
        b.addEventListener('click', () => pick(g.fallback ? fallbackValue(it.token, resolveColor(it.value)) : `var(${it.token})`));
        grid.appendChild(b);
      }
      box.appendChild(grid);
      body.appendChild(box);
    }
  }

  // a grey reads back as hue 0: keep the hue the sliders were on
  function setRgb(c) { rgb = c; const back = rgbToHsb(c); hsb = back.s ? back : { ...back, h: hsb.h }; }
  function move(key, n) {
    if (model === 'rgb') setRgb({ ...rgb, [key]: n });
    else { hsb = { ...hsb, [key]: n }; rgb = hsbToRgb(hsb.h, hsb.s, hsb.v); }
  }

  function renderCustom(body) {
    body.appendChild(segmented('cp-model', 'Color model', [{ id: 'rgb', label: 'RGB' }, { id: 'hsb', label: 'HSB' }], model, (id) => { model = id; render(); }));
    const chans = model === 'rgb'
      ? [['R', 'r', 255], ['G', 'g', 255], ['B', 'b', 255]]
      : [['H', 'h', 360], ['S', 's', 100], ['B', 'v', 100]];
    const src = model === 'rgb' ? rgb : hsb;
    const set = (key, n) => {
      move(key, n);
      pick(rgbToHex(rgb));
    };
    for (const [name, key, max] of chans) {
      const row = h('label', 'cp-chan');
      row.appendChild(h('span', 'cp-chan-name', name));
      const range = h('input', 'cp-range'); range.type = 'range';
      const num = h('input', 'cp-num'); num.type = 'number';
      for (const i of [range, num]) { i.min = '0'; i.max = String(max); i.step = '1'; i.value = String(src[key]); i.dataset.chan = key; }
      range.setAttribute('aria-label', name);
      num.setAttribute('aria-label', `${name} value`);
      // dragging repaints the slide but not the card: a re-render mid-drag would drop the thumb
      range.addEventListener('input', () => {
        num.value = range.value;
        const n = Number(range.value);
        move(key, n);
        picks[side] = rgbToHex(rgb); preview(side, picks[side]);
        card.querySelector('.cp-hex').value = picks[side];
        card.querySelector('.cp-now').style.background = picks[side];
      });
      range.addEventListener('change', render);
      num.addEventListener('change', () => set(key, clamp(Math.round(Number(num.value) || 0), 0, max)));
      row.append(range, num);
      body.appendChild(row);
    }
    const row = h('label', 'cp-chan cp-hexrow');
    row.appendChild(h('span', 'cp-chan-name', 'Hex'));
    const now = h('span', 'cp-now'); now.style.background = rgbToHex(rgb);
    const hex = h('input', 'cp-hex'); hex.type = 'text'; hex.spellcheck = false; hex.maxLength = 7; hex.value = rgbToHex(rgb);
    hex.setAttribute('aria-label', 'Hex color');
    hex.addEventListener('change', () => {
      const c = hexToRgb(hex.value);
      if (!c) { hex.value = rgbToHex(rgb); return; }
      setRgb(c);
      pick(rgbToHex(rgb));
    });
    row.append(now, hex);
    body.appendChild(row);
  }

  /** The Stroke side's width row: a slider and a number, in px, previewed as it moves (#717). */
  function renderWidth(body) {
    const row = h('label', 'cp-chan cp-widthrow');
    row.appendChild(h('span', 'cp-chan-name', 'Width'));
    const range = h('input', 'cp-range cp-width'); range.type = 'range';
    const num = h('input', 'cp-num cp-width'); num.type = 'number';
    for (const i of [range, num]) { i.min = '0'; i.max = '24'; i.step = '0.5'; i.value = currentWidth(); i.dataset.chan = 'w'; }
    range.setAttribute('aria-label', 'Stroke width');
    num.setAttribute('aria-label', 'Stroke width value');
    const set = (v) => {
      const n = clamp(Math.round(Number(v) * 2) / 2 || 0, 0, 24);
      picks.width = String(n);
      previewWidth(picks.width);
      range.value = num.value = picks.width;
      card.querySelector('.cp-apply').disabled = false;
    };
    range.addEventListener('input', () => set(range.value));
    num.addEventListener('change', () => set(num.value));
    row.append(range, num);
    body.appendChild(row);
  }

  /**
   * The Type side: a size in px, a weight, one of the theme's three font
   * roles by reference (the type then follows `T` and a deck's marked fonts,
   * never a family name pinned in the markup), italic, and where the line
   * sits: `text-anchor` on a diagram label, `text-align` on a block. Every
   * change previews at once; Apply saves them with the colours.
   */
  function renderType(body) {
    const t = targets.text[0];
    const cs = getComputedStyle(t.el);
    const typePick = (p, value) => { typePicks[p] = value; previewType(p, value); render(); };
    const row = (name, ...kids) => { const r = h('div', 'cp-chan cp-typerow'); r.append(h('span', 'cp-chan-name', name), ...kids); body.appendChild(r); };

    const sizeNow = String(Math.round(parseFloat(typePicks['font-size'] ?? cs.fontSize) || 16));
    const range = h('input', 'cp-range cp-size'); range.type = 'range';
    const num = h('input', 'cp-num cp-size'); num.type = 'number';
    for (const i of [range, num]) { i.min = '8'; i.max = '160'; i.step = '1'; i.value = sizeNow; i.dataset.chan = 'size'; }
    range.setAttribute('aria-label', 'Text size');
    num.setAttribute('aria-label', 'Text size value');
    const setSize = (v) => {
      const n = clamp(Math.round(Number(v)) || 16, 8, 160);
      typePicks['font-size'] = `${n}px`;
      previewType('font-size', typePicks['font-size']);
      range.value = num.value = String(n);
      card.querySelector('.cp-apply').disabled = false;
    };
    // dragging repaints the slide but not the card: a re-render mid-drag would drop the thumb
    range.addEventListener('input', () => setSize(range.value));
    num.addEventListener('change', () => setSize(num.value));
    row('Size', range, num);

    const weightNow = String(typePicks['font-weight'] ?? (Math.round((Number(cs.fontWeight) || 400) / 100) * 100));
    row('Weight', segmented('cp-weight', 'Weight', [
      { id: '400', label: 'Regular', title: '400' }, { id: '500', label: 'Medium', title: '500' }, { id: '600', label: 'Semi', title: 'semibold · 600' },
      { id: '700', label: 'Bold', title: '700' }, { id: '800', label: 'Heavy', title: '800' },
    ], weightNow, (id) => typePick('font-weight', id)));

    // the role the text is set in: the one picked, else the one its family is
    const style = getComputedStyle(root);
    const norm = (f) => String(f).replace(/["']/g, '').replace(/\s*,\s*/g, ',').trim().toLowerCase();
    const roleNow = (typePicks['font-family'] ?? t.el.style.getPropertyValue('font-family')).match(/--font-(heading|body|mono)/)?.[1]
      ?? ['heading', 'body', 'mono'].find((r) => style.getPropertyValue(`--font-${r}`).trim() && norm(style.getPropertyValue(`--font-${r}`)) === norm(cs.fontFamily));
    row('Font', segmented('cp-family', 'Font', ['heading', 'body', 'mono'].map((r) => ({
      id: r, label: r[0].toUpperCase() + r.slice(1), title: `the theme's ${r} font · var(--font-${r})`,
      disabled: !style.getPropertyValue(`--font-${r}`).trim(),
    })), roleNow, (id) => typePick('font-family', `var(--font-${id})`)));

    const italic = (typePicks['font-style'] ?? cs.fontStyle) === 'italic';
    const it = h('button', 'cp-btn cp-italic', 'Italic'); it.type = 'button';
    it.setAttribute('aria-pressed', String(italic));
    it.addEventListener('click', () => typePick('font-style', italic ? 'normal' : 'italic'));
    const anchors = isSvg(t)
      ? [{ id: 'start', label: 'Start' }, { id: 'middle', label: 'Middle' }, { id: 'end', label: 'End' }]
      : [{ id: 'left', label: 'Left' }, { id: 'center', label: 'Center' }, { id: 'right', label: 'Right' }];
    const alignNow = typePicks.align ?? (isSvg(t) ? cs.textAnchor : ({ start: 'left', end: 'right', justify: 'left' }[cs.textAlign] ?? cs.textAlign));
    row('Align', segmented('cp-align', 'Align', anchors, alignNow, (id) => typePick('align', id)), it);
  }

  function renderConcept(body) {
    const note = h('div', 'cp-notice');
    note.append(h('span', 'cp-notice-text', `this shape is the “${targets.concept.name}” concept — the deck colours it, and a fill picked here would be painted over on the next load. Pin the concept's slot in / → Concept colors…, or`));
    const btn = h('button', 'cp-btn cp-detach', 'Detach from concept'); btn.type = 'button';
    btn.title = `take data-concept="${targets.concept.name}" off this ${targets.concept.tag}, then colour it by hand`;
    btn.addEventListener('click', () => { shut(); onDetach?.(targets.concept); });
    note.appendChild(btn);
    body.appendChild(note);
  }

  function render() {
    const focus = document.activeElement?.dataset?.chan && card.contains(document.activeElement)
      ? [document.activeElement.className, document.activeElement.dataset.chan] : null;
    main.textContent = '';
    main.appendChild(segmented('cp-side', 'What to color', [
      { id: 'fill', label: 'Fill', disabled: !targets.fill.length, title: targets.fill.length ? 'the shape’s background' : 'nothing here has a background to color' },
      { id: 'stroke', label: 'Stroke', disabled: !targets.stroke.length, title: targets.stroke.length ? 'the shape’s border, and how wide it is' : 'nothing here has a border' },
      { id: 'text', label: 'Text', disabled: !targets.text.length, title: targets.text.length ? 'the text on it' : 'this shape carries no text' },
      { id: 'type', label: 'Type', disabled: !targets.text.length, title: targets.text.length ? 'the text’s size, weight, font and alignment' : 'this shape carries no text' },
    ], side, (id) => { side = id; if (side === 'type') { render(); return; } if (picks[side] === undefined || picks[side] === null || picks[side].startsWith('var(')) syncFromTarget(); else setRgb(hexToRgb(picks[side])); render(); }));
    if (side === 'stroke') renderWidth(main);
    if (side === 'type') {
      const body = h('div', 'cp-body cp-type');
      renderType(body);
      main.appendChild(body);
    } else main.appendChild(segmented('cp-tabs', 'Color source', [{ id: 'theme', label: 'Theme' }, { id: 'custom', label: 'Custom' }], tab, (id) => {
      tab = id;
      // Custom opens on the colour the target HAS — a token pick included — so the sliders start from what you see
      if (tab === 'custom' && (picks[side] === undefined || picks[side] === null || picks[side].startsWith('var('))) syncFromTarget();
      render();
    }));
    if (side !== 'type') {
      const body = h('div', 'cp-body');
      body.dataset.tab = tab;
      // the Fill of a concept shape is the deck's (SPEC SVG_DIAGRAMS): the
      // concept repaints it on every load, so a fill picked here would be
      // lost; the side says so and offers the one thing that would take
      if (side === 'fill' && targets.concept) renderConcept(body); else (tab === 'theme' ? renderTheme : renderCustom)(body);
      main.appendChild(body);
    }
    const foot = h('div', 'cp-foot');
    const reset = h('button', 'cp-btn cp-reset', 'Reset'); reset.type = 'button';
    reset.title = 'take the picked color off — back to what the theme or the markup gives it';
    if (side === 'type') reset.title = 'take the picked type off — back to what the theme or the markup gives it';
    reset.addEventListener('click', () => {
      if (side === 'type') {
        for (const p of TYPE_PROPS) { typePicks[p] = null; for (const t of targets.text) t.el.style.removeProperty(propFor(t, p)); }
        render();
        return;
      }
      picks[side] = null; for (const t of targets[side]) t.el.style.removeProperty(t.prop);
      if (side === 'stroke') { picks.width = null; for (const t of targets.stroke) t.el.style.removeProperty(widthProp(t)); }
      render();
    });
    const cancel = h('button', 'cp-btn', 'Cancel'); cancel.type = 'button';
    cancel.addEventListener('click', close);
    const ok = h('button', 'cp-btn cp-apply', 'Apply'); ok.type = 'button';
    ok.disabled = SIDES.every((s) => picks[s] === undefined) && picks.width === undefined && TYPE_PROPS.every((p) => typePicks[p] === undefined);
    ok.addEventListener('click', apply);
    foot.append(reset, h('span', 'cp-spacer'), cancel, ok);
    main.appendChild(foot);
    if (focus) card.querySelector(`.${focus[0].split(' ')[0]}[data-chan="${focus[1]}"]`)?.focus();
  }

  let open = true;
  const onResize = () => dock.reserveGutter();
  function shut() {
    open = false;
    window.removeEventListener('resize', onResize);
    el.remove();
    dock.release();   // or the stage keeps reflowing around a gutter nothing sits in
    onClose?.();
  }
  function close() {
    if (!open) return;
    restore();
    shut();
  }
  function apply() {
    if (!open) return;
    const edits = [];
    for (const s of SIDES) {
      if (picks[s] === undefined) continue;
      for (const t of targets[s]) edits.push({ path: t.path, tag: t.tag, prop: t.prop, value: picks[s] });
    }
    if (picks.width !== undefined) {
      for (const t of targets.stroke) edits.push({ path: t.path, tag: t.tag, prop: widthProp(t), value: picks.width === null ? null : `${picks.width}${t.prop === 'stroke' ? '' : 'px'}` });
    }
    for (const p of TYPE_PROPS) {
      if (typePicks[p] === undefined) continue;
      for (const t of targets.text) edits.push({ path: t.path, tag: t.tag, prop: propFor(t, p), value: typePicks[p] });
    }
    // the preview STAYS: the save reloads the deck, and a slide that flashed
    // back to its old colours in between would read as a failed save
    shut();
    if (edits.length) onApply(edits);
  }

  // A key pressed INSIDE the card is the card's and stops here: docked, the
  // panel is not modal, and Space on a swatch must not also advance the deck.
  // (The deck never sees keys typed in an input anyway — so Enter and Escape
  // have to be answered here for the fields to have them at all.)
  card.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && !/^button$/i.test(e.target.tagName)) {
      e.preventDefault();
      e.target.dispatchEvent(new Event('change'));   // a number still being typed counts
      apply();
    }
  });

  head.append(dock.controls(close, 'close (esc)'));
  dock.wireHeader(head);
  syncFromTarget();
  root.appendChild(el);
  render();
  dock.reserveGutter();
  window.addEventListener('resize', onResize);
  return { el, close, apply, isOpen: () => open };
}
