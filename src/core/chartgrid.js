// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The inspector's Data tab (PRESENTING_EDITING, SPEC CHARTS): a chart's
 * numbers as a grid, one row per label, one column per series, every cell
 * typed into in place.
 *
 * What the grid edits is the chart's JSON as the FILE has it (read through
 * `GET /deck/edit/element/source`, never the live DOM, where the engine has
 * put an <svg> in the chart's place), and every edit is a splice of that text
 * (chartdata.js), so the author's key order, spacing and unknown keys stay.
 *
 * Each edit draws the chart again at once, on the slide; the write waits for
 * the typing to pause or the cell to be left, so one burst of typing is one
 * POST and one ⌘Z, the way the Colors tab saves as you pick. A button (a row,
 * a series, the type) is its own burst.
 */

import {
  chartGrid, cellNumber, setCell, setLabel, setSeriesName, addRow, removeRow, moveRow,
  addSeries, removeSeries, setType, setTitle, findChart, rewriteChart, GRID_TYPES,
  ASPECTS, aspectOf, setAspect, legendOf, setLegend,
  setPoint, addPoint, removePoint, addScatterSeries, setAxisTitle,
  setBandCell, addBand, removeBand, setMarker, setMarkerLabel,
  setDashFrom, setNow, setNowLabel, setThreshold, addBandSeries,
} from './chartdata.js';
import { renderChart } from './charts.js';
import { boundedFetch } from './devmode.js';
import { createEditCommit } from './edit-commit.js';
import { holdDraft } from './drafts.js';
import { UNDO_CHORD } from './undo-chord.js';

/** How long the typing must pause before it is written. */
const QUIET_MS = 700;

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const button = (cls, text, title, run) => {
  const b = h('button', `dg-btn ${cls}`, text);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
  return b;
};

/**
 * `chart` is the [data-chart] element on the slide; `target` the selection
 * it was found in (`{ slide, index, top }`); `ordinal` which chart of that
 * top-level element it is, in document order (the element itself first).
 * `redraw(chart)` draws it again and rescans the slide (the engine's).
 */
export function createChartGrid({ chart, target, ordinal, editmode, toast = () => {}, redraw = renderChart, openHtml = null }) {
  const em = editmode;
  const commit = createEditCommit(em ?? {});
  const { slide, index } = target;
  const el = h('div', 'dl-chartgrid');
  el.dataset.slide = String(slide);
  const live = () => chart.querySelector('script[type="application/json"]');
  const canWrite = () => !!em?.available?.() && em?.base?.() != null;
  let readOnly = !canWrite();
  let json = null;
  let attrs = { type: null, title: null, aspect: null };
  // the attributes the tab writes, and the key of `attrs` each one is
  const ATTR_KEYS = { 'data-chart': 'type', 'data-title': 'title', 'data-aspect': 'aspect' };
  let grid = null;
  let problem = null;          // why the grid cannot show this chart, or null
  let loading = !readOnly;
  // the cell the row and series buttons act on: row -1 is the header, col -1 the labels
  let cur = { row: 0, col: 0 };
  // the write: dirty since the last one went, the attributes it must set, one at a time
  let dirty = false;
  let timer = 0;
  let queue = Promise.resolve();
  let saving = 0;
  let failed = null;
  const touched = new Set();
  const letGo = holdDraft(() => (dirty || saving ? `the chart data on slide ${slide}` : null));

  // ── reading ────────────────────────────────────────────────────────────────

  function fromLive() {
    json = live()?.textContent ?? '';
    attrs = { type: chart.getAttribute('data-chart'), title: chart.getAttribute('data-title'), aspect: chart.getAttribute('data-aspect') };
  }
  async function load() {
    if (readOnly) { fromLive(); settleGrid(); paint(); return; }
    try {
      const res = await boundedFetch(`${em.base()}/deck/edit/element/source?slide=${slide}&index=${index}`);
      const j = await res.json().catch(() => ({}));
      if (!res.ok || typeof j.html !== 'string') throw new Error(j.error || String(res.status));
      const c = findChart(j.html, ordinal);
      if (!c) throw new Error('the chart is not in the file where the page has it');
      if (!c.json) { problem = 'it has no JSON of its own in the file'; json = ''; }
      else json = j.html.slice(c.json.start, c.json.end);
      attrs = { type: c.type, title: c.title, aspect: c.aspect };
    } catch (e) {
      // the grid still shows what the slide has; it writes nothing it could not read
      fromLive();
      readOnly = true;
      problem = null;
      failed = `could not read the chart from the file: ${String(e.message || e)}`;
    }
    loading = false;
    settleGrid();
    paint();
  }
  function settleGrid() {
    if (problem) { grid = null; return; }
    grid = chartGrid(json, attrs);
    if (!grid.ok) { problem = grid.reason; grid = null; }
  }

  // ── writing ────────────────────────────────────────────────────────────────

  /** The chart becomes `next` (and `set`'s attributes): on the slide now, in the file soon. */
  function apply(next, set = {}) {
    if (readOnly || next == null) return;
    const changedAttrs = Object.entries(set).filter(([, v]) => v !== undefined);
    if (next === json && !changedAttrs.length) return;
    json = next;
    for (const [name, v] of changedAttrs) {
      touched.add(name);
      if (ATTR_KEYS[name]) attrs[ATTR_KEYS[name]] = v;
      if (v == null) chart.removeAttribute(name); else chart.setAttribute(name, v);
    }
    const s = live();
    if (s) s.textContent = json;
    redraw(chart);
    const g = chartGrid(json, attrs);
    if (g.ok) grid = g;
    dirty = true;
    failed = null;
    status();
  }
  function later() {
    clearTimeout(timer);
    timer = setTimeout(() => flush(), QUIET_MS);
  }
  /** Write what is not written yet; resolves once it has landed (or been refused). */
  function flush() {
    clearTimeout(timer);
    if (!dirty || readOnly) return queue;
    dirty = false;
    const want = { json, attrs: Object.fromEntries([...touched].map((n) => [n, attrs[ATTR_KEYS[n]]])) };
    saving++;
    status();
    const p = queue.then(() => send(want)).then(() => { failed = null; }, (e) => {
      dirty = true;   // the next edit, or leaving the next cell, tries again
      failed = `not saved: ${commit.why(e)}`;
      toast(`the chart's data was ${failed} (it is still on the slide; the next edit tries again)`, 6000);
    }).finally(() => { saving--; status(); });
    queue = p;
    return commit.track(p);
  }
  async function send(want) {
    const res = await boundedFetch(`${em.base()}/deck/edit/element/source?slide=${slide}&index=${index}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || typeof j.html !== 'string') throw new Error(j.error || String(res.status));
    const html = rewriteChart(j.html, ordinal, want);
    if (html === j.html) return;
    await commit.send('/deck/edit/element/content', { slide, index, html });
  }

  /** A button's edit: refused with a word, else shown, the grid rebuilt, and written as its own burst. */
  function act(fn, focusAt = null) {
    if (readOnly || !grid) return;
    let out;
    try { out = fn(json); } catch (e) { toast(String(e.message || e), 3000); return; }
    if (typeof out === 'string') apply(out); else apply(out.json, out.set);
    const to = focusAt ? focusAt(cur) : null;
    paint(to);
    flush();
  }

  // ── the card ───────────────────────────────────────────────────────────────

  let statusEl = null;
  function status() {
    if (!statusEl) return;
    statusEl.classList.toggle('dg-failed', !!failed);
    statusEl.textContent = failed ?? (readOnly ? '' : saving ? 'saving…' : `saved as you type · ${UNDO_CHORD} takes back each burst`);
  }

  // a number cell is a series' value, or one edge of its band (`part`)
  function cellAt(row, col, part = null) {
    const p = part ? `[data-part="${part}"]` : '';
    return el.querySelector(`.dg-cell[data-row="${row}"][data-col="${col}"]${p}`);
  }
  function focusCell(row, col, part = null) {
    const c = cellAt(row, col, part) ?? cellAt(row, col) ?? cellAt(Math.min(row, (grid?.labels.length ?? 1) - 1), Math.min(col, (grid?.series.length ?? 1) - 1));
    if (!c) return;
    c.focus();
    c.select?.();
  }

  /** The card, drawn again; the caret goes to `to` (`{ row, col }`), else stays in the cell it was in. */
  function paint(to = null) {
    const keep = document.activeElement && el.contains(document.activeElement) ? document.activeElement : null;
    el.textContent = '';
    if (loading) { el.append(h('div', 'dg-note', 'reading the chart from the file…')); return; }
    if (problem || !grid) {
      el.append(h('div', 'dg-note', `This chart's data is not a grid: ${problem ?? 'it cannot be read'}.`));
      if (openHtml) el.append(button('dg-html', 'Edit its JSON as HTML', 'edit this chart in the HTML editor', openHtml));
      el.append(h('div', 'narr-head ins-foot', 'esc lets go of it'));
      return;
    }
    if (readOnly) {
      const why = failed ?? em?.cannot?.('edit its numbers') ?? 'editing a chart needs write mode';
      el.append(h('div', 'dg-note dg-readonly', why));
    }
    const pie = grid.type === 'pie' || grid.type === 'donut';
    const scatter = grid.type === 'scatter';

    // the kind of chart: the ones a grid's numbers can draw (a scatter's
    // pairs are not one value per label: it stays a scatter)
    const typeRow = h('div', 'dg-field');
    typeRow.append(h('span', 'dg-key', 'Type'));
    const seg = h('div', 'dg-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'chart type');
    for (const t of scatter ? ['scatter'] : GRID_TYPES) {
      const b = h('button', 'dg-seg-btn', t);
      b.type = 'button';
      b.dataset.type = t;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(grid.type === t));
      const one = (t === 'pie' || t === 'donut') && grid.series.length > 1;
      // a band series is a range round a line: only a line or area chart draws one
      const ranged = t !== 'line' && t !== 'area' && grid.series.some((x) => x.kind === 'band');
      b.disabled = readOnly || one || scatter || ranged;
      if (scatter) b.title = 'a scatter is x / y pairs: it stays a scatter';
      if (one) b.title = 'a pie takes one series: remove the others first';
      if (ranged) b.title = 'a band series needs a line or area chart: remove it first';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (grid.type === t) return;
        act((src) => {
          const r = setType(src, attrs, t);
          // said in the JSON: the file's attribute stays as it is, but the
          // page's (which the engine filled in from the JSON) must follow,
          // since an attribute wins over the JSON when the chart is drawn
          if (r.attr == null && chart.getAttribute('data-chart')) chart.setAttribute('data-chart', t);
          return { json: r.json, set: { 'data-chart': r.attr ?? undefined } };
        });
      });
      seg.append(b);
    }
    typeRow.append(seg);
    el.append(typeRow);

    // the title, data-title (or the JSON's, where the chart says it there)
    const titleRow = h('label', 'dg-field');
    titleRow.append(h('span', 'dg-key', 'Title'));
    const title = h('input', 'dg-title');
    title.type = 'text';
    title.value = grid.title;
    title.placeholder = 'no title';
    title.readOnly = readOnly;
    title.spellcheck = false;
    title.addEventListener('focus', () => { title.dataset.was = title.value; });
    title.addEventListener('input', () => {
      const r = setTitle(json, attrs, title.value);
      apply(r.json, { 'data-title': r.attr });
      later();
    });
    title.addEventListener('blur', () => flush());
    title.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        if (title.value !== title.dataset.was) { title.value = title.dataset.was ?? ''; title.dispatchEvent(new Event('input')); } else title.blur();
      } else if (e.key === 'Enter') { e.preventDefault(); flush(); }
    });
    titleRow.append(title);
    el.append(titleRow);

    // its shape and its legend: a choice each, written as one change
    const choices = (key, label, options, now, pickIt) => {
      const row = h('div', 'dg-field');
      row.append(h('span', 'dg-key', label));
      const box = h('div', 'dg-seg');
      box.setAttribute('role', 'radiogroup');
      box.setAttribute('aria-label', `chart ${label.toLowerCase()}`);
      box.dataset.key = key;
      for (const [value, name] of options) {
        const b = h('button', 'dg-seg-btn', name);
        b.type = 'button';
        b.dataset.value = value;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(now === value));
        b.disabled = readOnly;
        b.addEventListener('click', (e) => { e.stopPropagation(); if (now !== value) act((src) => pickIt(src, value)); });
        box.append(b);
      }
      row.append(box);
      return row;
    };
    const shape = aspectOf(json, attrs);
    const shapeRow = choices('aspect', 'Shape', ASPECTS, shape.aspect, (src, v) => {
      const r = setAspect(src, attrs, v);
      return { json: r.json, set: { 'data-aspect': r.attr } };
    });
    // a shape of its own (5:2) is said as written, none of the four ticked
    if (shape.aspect === null) shapeRow.append(h('span', 'dg-note dg-own', `its own: ${shape.written}`));
    el.append(shapeRow);
    el.append(choices('legend', 'Legend', [['auto', 'auto'], ['on', 'on'], ['off', 'off']], legendOf(json), (src, v) => setLegend(src, v)));
    if (scatter) { paintPairs(to, keep); return; }
    // a chart with a value axis (bar, line, area) has its two rules (CHARTS)
    if (grid.now !== undefined) el.append(nowField(), thresholdField());

    // the grid: a column a series, and on a line or area chart (CHARTS) its
    // band's low and high as two more, and its markers as a ticked cell
    const scroll = h('div', 'dg-scroll');
    const table = h('table', 'dg-grid');
    const head = h('tr');
    const corner = h('th', 'dg-corner', pie ? 'slice' : 'label');
    head.append(corner);
    const partsOf = (s) => [...(s.kind === 'band' ? [] : ['value']), ...(s.band ? ['low', 'high'] : []), ...(s.marks ? ['mark'] : [])];
    const extras = grid.series.some((s) => partsOf(s).length > 1 || s.kind === 'band');
    const sub = h('tr', 'dg-sub');
    if (extras) { sub.append(h('th', 'dg-corner')); table.classList.add('dg-wide'); }
    grid.series.forEach((s, ci) => {
      const th = h('th');
      th.colSpan = partsOf(s).length;
      th.append(cellInput(-1, ci, s.name, `series ${ci + 1} name`, 'dg-name', s.named ? '' : s.name));
      head.append(th);
      for (const part of partsOf(s)) {
        const word = { value: 'value', low: 'low', high: 'high', mark: 'marker' }[part];
        const sh = h('th', `dg-part-head dg-part-${part}`, part === 'mark' ? '◆' : word);
        sh.title = part === 'mark' ? 'a marker: the point emphasised, with its words' : `the ${word === 'value' ? 'values' : `band's ${word} edge`}`;
        sub.append(sh);
      }
    });
    const thead = h('thead');
    thead.append(head);
    if (extras) thead.append(sub);
    // under a line or area chart's grid, where each line turns dashed
    const lines = grid.type === 'line' || grid.type === 'area';
    const tfoot = h('tfoot', 'dg-foot');
    if (lines) {
      const tr = h('tr');
      const th = h('th', 'dg-corner', 'dashed from');
      th.title = 'where each line turns dashed: solid up to that label, dashed after it';
      tr.append(th);
      grid.series.forEach((s, ci) => {
        const td = h('td');
        td.colSpan = partsOf(s).length;
        if (s.kind === 'line') {
          td.append(rowPicker(`dash-${ci}`, s.dash, 'solid', `${s.name}: dashed from`, (row) => act((src) => setDashFrom(src, ci, row))));
        }
        tr.append(td);
      });
      tfoot.append(tr);
    }
    const tbody = h('tbody');
    grid.labels.forEach((lab, ri) => {
      const tr = h('tr');
      const th = h('th');
      th.append(cellInput(ri, -1, lab, `label ${ri + 1}`, 'dg-label'));
      tr.append(th);
      grid.series.forEach((s, ci) => {
        for (const part of partsOf(s)) {
          const td = h('td');
          if (part === 'value') td.append(cellInput(ri, ci, s.cells[ri], `${s.name}, ${lab}`, 'dg-num', '', 'value'));
          else if (part === 'mark') { td.className = 'dg-mark-cell'; td.append(...markCell(ri, ci, s, lab)); }
          else td.append(cellInput(ri, ci, s.band[part][ri], `${s.name}, ${lab}, band ${part}`, 'dg-num dg-band', '', part));
          tr.append(td);
        }
      });
      tbody.append(tr);
    });
    table.append(thead, tbody);
    if (lines) table.append(tfoot);
    scroll.append(table);
    el.append(scroll);

    // what the buttons act on: the cell last in, else the last row and series
    const actions = h('div', 'dg-actions');
    const rowAt = () => Math.max(0, Math.min(cur.row, grid.labels.length - 1));
    const colAt = () => Math.max(0, Math.min(cur.col, grid.series.length - 1));
    const n = grid.labels.length, m = grid.series.length;
    const add = button('dg-add-row', '+ row', 'add a row below this one', () => act((src) => addRow(src, rowAt() + 1), (c) => ({ row: rowAt() + 1, col: -1 })));
    const del = button('dg-del-row', '− row', 'remove this row', () => act((src) => removeRow(src, rowAt()), () => ({ row: Math.max(0, rowAt() - (rowAt() === n - 1 ? 1 : 0)), col: cur.col })));
    const up = button('dg-up', '↑', 'move this row up', () => act((src) => moveRow(src, rowAt(), -1), (c) => ({ row: rowAt() - 1, col: c.col })));
    const down = button('dg-down', '↓', 'move this row down', () => act((src) => moveRow(src, rowAt(), +1), (c) => ({ row: rowAt() + 1, col: c.col })));
    const addS = button('dg-add-series', '+ series', 'add a series', () => act((src) => addSeries(src), () => ({ row: -1, col: m })));
    const delS = button('dg-del-series', '− series', 'remove this series', () => act((src) => removeSeries(src, colAt()), () => ({ row: cur.row, col: Math.max(0, colAt() - (colAt() === m - 1 ? 1 : 0)) })));
    // a band round the series the caret is in: its low and high start as its values
    const sCur = grid.series[colAt()];
    const bandBtn = lines ? (sCur.band
      ? button('dg-del-band', '− band', 'take the band off this series', () => act((src) => removeBand(src, colAt()), () => ({ row: Math.max(0, cur.row), col: colAt(), part: 'value' })))
      : button('dg-add-band', '+ band', 'add a band round this series: a low and a high a label', () => act((src) => addBand(src, colAt()), () => ({ row: Math.max(0, cur.row), col: colAt(), part: 'low' }))))
      : null;
    if (bandBtn && sCur.kind === 'band') { bandBtn.disabled = true; bandBtn.title = 'a band series is its band'; }
    // a band series: a range with no line of its own (a learned normal range),
    // starting as the values of the series the caret is in, to be widened
    const bandSeries = lines
      ? button('dg-add-band-series', '+ band series', 'add a band series: a range of its own, a low and a high a label, with no line',
        () => act((src) => addBandSeries(src, colAt()), () => ({ row: Math.max(0, cur.row), col: m, part: 'low' })))
      : null;
    del.disabled = n <= 1;
    up.disabled = rowAt() <= 0 || cur.row < 0;
    down.disabled = rowAt() >= n - 1 || cur.row < 0;
    addS.disabled = pie;
    if (pie) addS.title = 'a pie takes one series';
    delS.disabled = m <= 1;
    for (const b of [add, del, up, down, addS, delS, bandBtn, bandSeries]) if (b && readOnly) b.disabled = true;
    actions.append(add, del, up, down, h('span', 'dg-spacer'), addS, delS);
    // the bands on a line of their own: the rows and the series fill the first
    if (bandBtn) actions.append(h('span', 'dg-break'), h('span', 'dg-spacer'), bandBtn, bandSeries);
    el.append(actions);

    statusEl = h('div', 'dg-status');
    el.append(statusEl);
    status();
    el.append(h('div', 'narr-head ins-foot', readOnly ? 'esc lets go of it' : 'tab and enter walk the cells'));
    if (to) focusCell(to.row, to.col, to.part);
    else if (keep?.dataset.key && keep.tagName === 'SELECT') el.querySelector(`select[data-key="${keep.dataset.key}"]`)?.focus();
    else if (keep && keep.dataset.row != null) {
      const at = [Number(keep.dataset.row), Number(keep.dataset.col)];
      if (keep.classList.contains('dg-mark') || keep.classList.contains('dg-mark-label')) {
        el.querySelector(`.${keep.classList.contains('dg-mark') ? 'dg-mark' : 'dg-mark-label'}[data-row="${at[0]}"][data-col="${at[1]}"]`)?.focus();
      } else focusCell(...at, keep.dataset.part ?? null);
    }
  }

  // ── the rules and the dashes: a row picked from the labels (CHARTS) ────────

  /**
   * A choice of the chart's labels, or `none` (a reference to no row): the
   * picked row handed to `pick` (null for none), as one write. A reference
   * naming no label is shown as written, picked, until another is.
   */
  function rowPicker(key, ref, none, label, pick) {
    const sel = h('select', 'dg-select');
    sel.dataset.key = key;
    sel.setAttribute('aria-label', label);
    sel.disabled = readOnly;
    const opt = (value, text, on) => { const o = h('option', null, text); o.value = value; o.selected = on; sel.append(o); };
    opt('', none, !ref);
    if (ref && ref.row === -1) { opt('?', `${ref.written} (no such label)`, true); sel.lastChild.disabled = true; }
    grid.labels.forEach((lab, k) => opt(String(k), lab === '' ? `(row ${k + 1})` : lab, ref?.row === k));
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    sel.addEventListener('change', (e) => { e.stopPropagation(); pick(sel.value === '' ? null : Number(sel.value)); });
    return sel;
  }

  /** A text field's keys: its own, Esc puts back what it held, Enter writes. */
  function wordsKeys(input) {
    input.addEventListener('focus', () => { input.dataset.was = input.value; });
    input.addEventListener('blur', () => flush());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        if (input.value !== input.dataset.was) { input.value = input.dataset.was ?? ''; input.dispatchEvent(new Event('input')); } else input.blur();
      } else if (e.key === 'Enter') { e.preventDefault(); flush(); }
    });
  }
  const textInput = (cls, value, placeholder, label) => {
    const i = h('input', `dg-title ${cls}`);
    i.type = 'text';
    i.value = value;
    i.placeholder = placeholder;
    i.readOnly = readOnly;
    i.spellcheck = false;
    i.autocomplete = 'off';
    i.setAttribute('aria-label', label);
    return i;
  };

  /** Now: the label the vertical rule stands at (or none), and its words (*now* when it says none). */
  function nowField() {
    const row = h('div', 'dg-field dg-rule');
    row.append(h('span', 'dg-key', 'Now'));
    const now = grid.now;
    row.append(rowPicker('now', now, 'none', 'now: the label the rule stands at', (r) => act((src) => setNow(src, r))));
    const words = textInput('dg-rule-words dg-now-label', now?.words ?? '', 'now', 'the words on the now rule');
    words.disabled = !now;
    words.addEventListener('input', () => { if (!readOnly && grid.now) { apply(setNowLabel(json, words.value)); later(); } });
    wordsKeys(words);
    row.append(words);
    return row;
  }

  /** Threshold: the value the horizontal rule is drawn at (empty: none), and its words. */
  function thresholdField() {
    const row = h('div', 'dg-field dg-rule');
    row.append(h('span', 'dg-key', 'Threshold'));
    const t = grid.threshold;
    const y = textInput('dg-threshold-y', t?.y ?? '', 'none', 'threshold: the value the rule is drawn at');
    y.inputMode = 'decimal';
    const words = textInput('dg-rule-words dg-threshold-label', t?.words ?? '', 'its words', 'the words on the threshold');
    words.disabled = !t;
    // a number or nothing (no threshold), as a cell takes one: anything else is marked and kept off
    y.addEventListener('input', () => {
      if (readOnly) return;
      const n = cellNumber(y.value);
      y.classList.toggle('dg-bad', !n.ok);
      y.setAttribute('aria-invalid', String(!n.ok));
      y.title = n.ok ? '' : 'not a number: not saved';
      const v = n.ok ? y.value : y.dataset.was ?? '';
      if (!n.ok && !cellNumber(v).ok) return;
      words.disabled = cellNumber(v).value === null;
      apply(setThreshold(json, v, words.value));
      later();
    });
    words.addEventListener('input', () => {
      const n = cellNumber(y.value);
      if (readOnly || !n.ok || n.value === null) return;
      apply(setThreshold(json, y.value, words.value));
      later();
    });
    wordsKeys(y);
    wordsKeys(words);
    row.append(y, words);
    return row;
  }

  /**
   * A marker's cell: ticked where the series has a marker at the row, and
   * then its words beside the tick. Ticking is its own write; the words are
   * written as a cell's number is, once the typing pauses.
   */
  function markCell(row, col, s, lab) {
    const words = s.marks[row];
    const tick = h('input', 'dg-mark');
    tick.type = 'checkbox';
    tick.checked = words != null;
    tick.disabled = readOnly;
    tick.dataset.row = String(row);
    tick.dataset.col = String(col);
    tick.setAttribute('aria-label', `${s.name}, ${lab}: a marker`);
    tick.addEventListener('focus', () => { const moved = cur.row !== row; cur = { row, col }; if (moved) syncRowButtons(); });
    tick.addEventListener('keydown', (e) => keys(e, tick));
    tick.addEventListener('change', (e) => {
      e.stopPropagation();
      const on = tick.checked;
      act((src) => setMarker(src, row, col, on));
      el.querySelector(`.${on ? 'dg-mark-label' : 'dg-mark'}[data-row="${row}"][data-col="${col}"]`)?.focus();
    });
    if (words == null) return [tick];
    const text = h('input', 'dg-cell dg-mark-label');
    text.type = 'text';
    text.value = words;
    text.placeholder = 'its words';
    text.readOnly = readOnly;
    text.spellcheck = false;
    text.autocomplete = 'off';
    text.dataset.row = String(row);
    text.dataset.col = String(col);
    text.dataset.part = 'label';
    text.setAttribute('aria-label', `${s.name}, ${lab}: the marker's words`);
    text.addEventListener('focus', () => { text.dataset.was = text.value; cur = { row, col }; });
    text.addEventListener('input', () => edit(text));
    text.addEventListener('blur', () => flush());
    text.addEventListener('keydown', (e) => keys(e, text));
    return [tick, text];
  }

  // ── a scatter: x / y pairs per series, and what its axes measure ─────────
  let curP = { s: 0, p: 0 };
  const pairAt = (si, pi, axis) => el.querySelector(`.dg-pt[data-series="${si}"][data-point="${pi}"][data-axis="${axis}"]`);
  function axisField(axis, value) {
    const row = h('label', 'dg-field');
    row.append(h('span', 'dg-key', axis === 'x' ? 'X axis' : 'Y axis'));
    const input = h('input', 'dg-title dg-axis');
    input.type = 'text';
    input.dataset.axis = axis;
    input.value = value;
    input.placeholder = `what ${axis} measures`;
    input.readOnly = readOnly;
    input.spellcheck = false;
    input.addEventListener('focus', () => { input.dataset.was = input.value; });
    input.addEventListener('input', () => { apply(setAxisTitle(json, axis, input.value)); later(); });
    input.addEventListener('blur', () => flush());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        if (input.value !== input.dataset.was) { input.value = input.dataset.was ?? ''; input.dispatchEvent(new Event('input')); } else input.blur();
      } else if (e.key === 'Enter') { e.preventDefault(); flush(); }
    });
    row.append(input);
    return row;
  }
  function pairInput(si, pi, axis, value, label) {
    const c = h('input', 'dg-cell dg-num dg-pt');
    c.type = 'text';
    c.value = value;
    c.dataset.series = String(si);
    c.dataset.point = String(pi);
    c.dataset.axis = String(axis);
    c.setAttribute('aria-label', label);
    c.spellcheck = false;
    c.autocomplete = 'off';
    c.inputMode = 'decimal';
    c.readOnly = readOnly;
    c.addEventListener('focus', () => { c.dataset.was = c.value; curP = { s: si, p: pi }; });
    c.addEventListener('input', () => {
      if (readOnly) return;
      const n = cellNumber(c.value);
      const ok = n.ok && n.value !== null;
      c.classList.toggle('dg-bad', !ok);
      c.setAttribute('aria-invalid', String(!ok));
      c.title = ok ? '' : 'a point needs a number here: not saved';
      if (!ok) { const w = cellNumber(c.dataset.was ?? ''); if (w.ok && w.value !== null) { apply(setPoint(json, si, pi, axis, c.dataset.was)); later(); } return; }
      apply(setPoint(json, si, pi, axis, c.value));
      later();
    });
    c.addEventListener('blur', () => flush());
    c.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        if (c.value !== c.dataset.was) { c.value = c.dataset.was ?? ''; c.dispatchEvent(new Event('input')); c.select(); } else c.blur();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        flush();
        const to = pairAt(si, pi + (e.shiftKey ? -1 : 1), axis);
        if (to) { to.focus(); to.select(); }
      }
    });
    return c;
  }
  function paintPairs(to, keep) {
    el.append(axisField('x', grid.x), axisField('y', grid.y));
    const scroll = h('div', 'dg-scroll');
    const table = h('table', 'dg-grid dg-pairs');
    const names = h('tr');
    const axes = h('tr');
    names.append(h('th', 'dg-corner', 'point'));
    axes.append(h('th', 'dg-corner'));
    grid.series.forEach((s, si) => {
      const th = h('th');
      th.colSpan = 2;
      const name = h('input', 'dg-cell dg-name');
      name.type = 'text';
      name.value = s.named ? s.name : '';
      name.placeholder = s.named ? '' : s.name;
      name.dataset.series = String(si);
      name.setAttribute('aria-label', `series ${si + 1} name`);
      name.spellcheck = false;
      name.readOnly = readOnly;
      name.addEventListener('focus', () => { curP = { s: si, p: curP.s === si ? curP.p : 0 }; });
      name.addEventListener('input', () => { if (!readOnly) { apply(setSeriesName(json, si, name.value)); later(); } });
      name.addEventListener('blur', () => flush());
      name.addEventListener('keydown', (e) => e.stopPropagation());
      th.append(name);
      names.append(th);
      axes.append(h('th', 'dg-axis-head', 'x'), h('th', 'dg-axis-head', 'y'));
    });
    const thead = h('thead');
    thead.append(names, axes);
    const tbody = h('tbody');
    const rows = Math.max(...grid.series.map((s) => s.points.length));
    for (let pi = 0; pi < rows; pi++) {
      const tr = h('tr');
      tr.append(h('th', 'dg-pt-n', String(pi + 1)));
      grid.series.forEach((s, si) => {
        for (const axis of [0, 1]) {
          const td = h('td');
          const v = s.points[pi]?.[axis];
          if (v !== undefined) td.append(pairInput(si, pi, axis, v, `${s.name}, point ${pi + 1}, ${axis ? 'y' : 'x'}`));
          tr.append(td);
        }
      });
      tbody.append(tr);
    }
    table.append(thead, tbody);
    scroll.append(table);
    el.append(scroll);

    // the buttons act on the point the caret was last in
    const actions = h('div', 'dg-actions');
    const sAt = () => Math.max(0, Math.min(curP.s, grid.series.length - 1));
    const pAt = () => Math.max(0, Math.min(curP.p, grid.series[sAt()].points.length - 1));
    const add = button('dg-add-point', '+ point', 'add a point after this one', () => act((src) => addPoint(src, sAt(), pAt()), () => ({ s: sAt(), p: pAt() + 1 })));
    const del = button('dg-del-point', '− point', 'remove this point', () => act((src) => removePoint(src, sAt(), pAt()), () => ({ s: sAt(), p: Math.max(0, pAt() - 1) })));
    const addS = button('dg-add-series', '+ series', 'add a series', () => act((src) => addScatterSeries(src), () => ({ s: grid.series.length, p: 0 })));
    const delS = button('dg-del-series', '− series', 'remove this series', () => act((src) => removeSeries(src, sAt()), () => ({ s: Math.max(0, sAt() - 1), p: 0 })));
    del.disabled = grid.series[sAt()].points.length <= 1;
    delS.disabled = grid.series.length <= 1;
    for (const b of [add, del, addS, delS]) if (readOnly) b.disabled = true;
    actions.append(add, del, h('span', 'dg-spacer'), addS, delS);
    el.append(actions);

    statusEl = h('div', 'dg-status');
    el.append(statusEl);
    status();
    el.append(h('div', 'narr-head ins-foot', readOnly ? 'esc lets go of it' : 'enter walks down a column'));
    const at = to && to.s != null ? to : keep?.dataset.point != null ? { s: Number(keep.dataset.series), p: Number(keep.dataset.point), axis: Number(keep.dataset.axis) } : null;
    if (at) {
      curP = { s: at.s, p: at.p };
      const c = pairAt(at.s, at.p, at.axis ?? 0);
      if (c) { c.focus(); c.select(); }
    }
  }

  /** One cell: a label, a series' name (row -1) or a number, a value or an edge of a band (`part`). */
  function cellInput(row, col, value, label, cls, placeholder = '', part = null) {
    const c = h('input', `dg-cell ${cls}`);
    c.type = 'text';
    c.value = placeholder && value === placeholder ? '' : value;
    if (placeholder) c.placeholder = placeholder;
    c.dataset.row = String(row);
    c.dataset.col = String(col);
    if (part) c.dataset.part = part;
    c.setAttribute('aria-label', label);
    c.spellcheck = false;
    c.autocomplete = 'off';
    if (cls.startsWith('dg-num')) c.inputMode = 'decimal';
    c.readOnly = readOnly;
    c.addEventListener('focus', () => {
      c.dataset.was = c.value;
      const moved = cur.row !== row;
      cur = { row, col };
      // the row buttons follow the cell
      if (moved) syncRowButtons();
    });
    c.addEventListener('input', () => edit(c));
    c.addEventListener('blur', () => flush());
    c.addEventListener('keydown', (e) => keys(e, c));
    return c;
  }
  function syncRowButtons() {
    const n = grid?.labels.length ?? 0;
    const up = el.querySelector('.dg-up'), down = el.querySelector('.dg-down');
    if (up) up.disabled = readOnly || cur.row <= 0;
    if (down) down.disabled = readOnly || cur.row < 0 || cur.row >= n - 1;
  }

  /** What was typed in `c`, shown at once; a number that is not one is marked and kept off the chart and the file. */
  function edit(c) {
    if (readOnly) return;
    const row = Number(c.dataset.row), col = Number(c.dataset.col);
    let next;
    if (row === -1) next = setSeriesName(json, col, c.value);
    else if (col === -1) next = setLabel(json, row, c.value);
    else if (c.dataset.part === 'label') next = setMarkerLabel(json, row, col, c.value);
    else {
      const part = c.dataset.part;
      const put = (v) => (part === 'low' || part === 'high' ? setBandCell(json, row, col, part, v) : setCell(json, row, col, v));
      const ok = cellNumber(c.value).ok;
      c.classList.toggle('dg-bad', !ok);
      c.setAttribute('aria-invalid', String(!ok));
      c.title = ok ? '' : 'not a number: not saved';
      // not a number: the cell keeps, on the slide and in the file, what it
      // held when the caret came in, never the `19` on the way to `19o`
      if (!ok) { if (cellNumber(c.dataset.was ?? '').ok) { apply(put(c.dataset.was ?? '')); later(); } return; }
      next = put(c.value);
    }
    apply(next);
    later();
  }

  /** A spreadsheet's keys: Tab and Enter walk the cells, Esc puts a cell back. */
  function keys(e, c) {
    // a cell's keys are its own: the deck never hears what is typed here
    e.stopPropagation();
    const row = Number(c.dataset.row), col = Number(c.dataset.col);
    const box = c.type === 'checkbox';
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!box && c.value !== c.dataset.was) { c.value = c.dataset.was ?? ''; edit(c); c.select(); } else c.blur();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      flush();
      const to = row + (e.shiftKey ? -1 : 1);
      const same = box ? el.querySelector(`.dg-mark[data-row="${to}"][data-col="${col}"]`) : cellAt(to, col, c.dataset.part ?? null);
      if (same && box) same.focus();
      else if (same) focusCell(to, col, c.dataset.part ?? null);
      return;
    }
    if (e.key === 'Tab' && grid) {
      // across, then on to the next row's label: the grid's cells in reading
      // order (a band's edges and a marker after their series' value); past
      // either end, the tab order's
      const walk = [...el.querySelectorAll('.dg-grid :is(.dg-cell, .dg-mark)')];
      const to = walk[walk.indexOf(c) + (e.shiftKey ? -1 : 1)];
      if (to) { e.preventDefault(); to.focus(); to.select?.(); }
    }
  }

  load();
  return {
    el,
    chart,
    /** Write whatever is waiting, now: the tab is closing, the selection moving. */
    flush,
    /** Let go: whatever is waiting is written first. */
    destroy() { const p = flush(); p.finally(letGo); return p; },
    /** Every write asked for so far, landed (or refused). */
    settled: () => queue,
  };
}
