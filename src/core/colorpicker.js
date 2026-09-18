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

// ----- what a right-click means ---------------------------------------------

const SVG_SHAPES = 'rect, circle, ellipse, polygon, path';
/** Nodes the ENGINE put in the page (builds.js's arrowheads): in the DOM, not in the file. */
const INJECTED = '.draw-head';

/**
 * The child-index path from `top` down to `el`, counted the way the file
 * counts — over element children, minus the ones the engine added. `[]` is
 * `top` itself; null when `el` is not under it, or sits inside an injected node.
 */
export function pathFrom(top, el) {
  const path = [];
  for (let n = el; n !== top; n = n.parentElement) {
    const parent = n?.parentElement;
    if (!parent || n.matches(INJECTED)) return null;
    path.unshift([...parent.children].filter((c) => !c.matches(INJECTED)).indexOf(n));
  }
  return path;
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
    const text = labels.map((t) => target(t, 'fill')).filter(Boolean);
    return fill.length || text.length ? { fill, text, what: shape ? shape.tagName.toLowerCase() : 'text' } : null;
  }
  // an HTML box: climb out of inline runs and out of a highlighted <pre>, whose
  // spans are the highlighter's and not the file's
  let el = clicked.closest('pre') ?? clicked;
  while (el !== top && top.contains(el) && getComputedStyle(el).display.startsWith('inline')) el = el.parentElement;
  if (!top.contains(el)) el = top;
  const fill = [target(el, 'background-color')].filter(Boolean);
  const text = [target(el, 'color')].filter(Boolean);
  return fill.length ? { fill, text, what: el.tagName.toLowerCase() } : null;
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
 * slide back exactly as it was. Returns `{ el, close, apply, isOpen }`.
 */
export function openColorPicker({ root, dock, targets, onApply, onClose }) {
  const all = [...targets.fill, ...targets.text];
  const before = new Map(all.map((t) => [t, [t.el.style.getPropertyValue(t.prop), t.el.style.getPropertyPriority(t.prop)]]));
  // undefined: untouched · null: reset · string: the value to write
  const picks = { fill: undefined, text: undefined };
  let side = targets.fill.length ? 'fill' : 'text';
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
  head.append(h('span', 'cp-title', `colors — ${targets.what} · ⏎ applies`));
  const main = h('div', 'cp-main');
  card.append(head, main);
  el.appendChild(card);

  const authored = (s) => targets[s][0]?.el.style.getPropertyValue(targets[s][0].prop).trim() ?? '';
  const current = (s) => {
    const t = targets[s][0];
    return t ? resolveColor(getComputedStyle(t.el)[t.prop === 'background-color' ? 'backgroundColor' : t.prop]) : null;
  };
  function preview(s, value) {
    for (const t of targets[s]) {
      if (value === null) { const [v, p] = before.get(t); v ? t.el.style.setProperty(t.prop, v, p) : t.el.style.removeProperty(t.prop); }
      else t.el.style.setProperty(t.prop, value);
    }
  }
  function pick(value) { picks[side] = value; preview(side, value); render(); }
  function restore() { for (const s of ['fill', 'text']) preview(s, null); }
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
    for (const g of themePalette((t) => style.getPropertyValue(t))) {
      const box = h('div', 'cp-groupbox');
      box.appendChild(h('div', 'cp-group', g.group));
      const grid = h('div', g.compact ? 'cp-swatches cp-compact' : 'cp-swatches');
      for (const it of g.items) {
        const b = h('button', 'cp-swatch');
        b.type = 'button';
        b.dataset.token = it.token;
        b.title = `${it.label} · ${it.token} · ${it.value}`;
        b.setAttribute('aria-label', `${it.label} (${it.token})`);
        b.setAttribute('aria-pressed', String(chosen === `var(${it.token})`));
        const chip = h('span', 'cp-chip');
        chip.style.background = `var(${it.token})`;
        b.append(chip, h('span', 'cp-label', g.compact ? it.short : it.label));
        b.addEventListener('click', () => pick(`var(${it.token})`));
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

  function render() {
    const focus = document.activeElement?.dataset?.chan && card.contains(document.activeElement)
      ? [document.activeElement.className, document.activeElement.dataset.chan] : null;
    main.textContent = '';
    main.appendChild(segmented('cp-side', 'What to color', [
      { id: 'fill', label: 'Fill', disabled: !targets.fill.length, title: targets.fill.length ? 'the shape’s background' : 'nothing here has a background to color' },
      { id: 'text', label: 'Text', disabled: !targets.text.length, title: targets.text.length ? 'the text on it' : 'this shape carries no text' },
    ], side, (id) => { side = id; if (picks[side] === undefined || picks[side] === null || picks[side].startsWith('var(')) syncFromTarget(); else setRgb(hexToRgb(picks[side])); render(); }));
    main.appendChild(segmented('cp-tabs', 'Color source', [{ id: 'theme', label: 'Theme' }, { id: 'custom', label: 'Custom' }], tab, (id) => {
      tab = id;
      // Custom opens on the colour the target HAS — a token pick included — so the sliders start from what you see
      if (tab === 'custom' && (picks[side] === undefined || picks[side] === null || picks[side].startsWith('var('))) syncFromTarget();
      render();
    }));
    const body = h('div', 'cp-body');
    body.dataset.tab = tab;
    (tab === 'theme' ? renderTheme : renderCustom)(body);
    main.appendChild(body);
    const foot = h('div', 'cp-foot');
    const reset = h('button', 'cp-btn cp-reset', 'Reset'); reset.type = 'button';
    reset.title = 'take the picked color off — back to what the theme or the markup gives it';
    reset.addEventListener('click', () => { picks[side] = null; for (const t of targets[side]) t.el.style.removeProperty(t.prop); render(); });
    const cancel = h('button', 'cp-btn', 'Cancel'); cancel.type = 'button';
    cancel.addEventListener('click', close);
    const ok = h('button', 'cp-btn cp-apply', 'Apply'); ok.type = 'button';
    ok.disabled = picks.fill === undefined && picks.text === undefined;
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
    for (const s of ['fill', 'text']) {
      if (picks[s] === undefined) continue;
      for (const t of targets[s]) edits.push({ path: t.path, tag: t.tag, prop: t.prop, value: picks[s] });
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
