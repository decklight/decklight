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
  let attrs = { type: null, title: null };
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
    attrs = { type: chart.getAttribute('data-chart'), title: chart.getAttribute('data-title') };
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
      attrs = { type: c.type, title: c.title };
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
      if (name === 'data-chart') attrs.type = v;
      if (name === 'data-title') attrs.title = v;
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
    const want = { json, attrs: Object.fromEntries([...touched].map((n) => [n, n === 'data-chart' ? attrs.type : attrs.title])) };
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

  function cellAt(row, col) { return el.querySelector(`.dg-cell[data-row="${row}"][data-col="${col}"]`); }
  function focusCell(row, col) {
    const c = cellAt(row, col) ?? cellAt(Math.min(row, (grid?.labels.length ?? 1) - 1), Math.min(col, (grid?.series.length ?? 1) - 1));
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

    // the kind of chart: the ones a grid's numbers can draw
    const typeRow = h('div', 'dg-field');
    typeRow.append(h('span', 'dg-key', 'Type'));
    const seg = h('div', 'dg-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'chart type');
    for (const t of GRID_TYPES) {
      const b = h('button', 'dg-seg-btn', t);
      b.type = 'button';
      b.dataset.type = t;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(grid.type === t));
      const one = (t === 'pie' || t === 'donut') && grid.series.length > 1;
      b.disabled = readOnly || one;
      if (one) b.title = 'a pie takes one series: remove the others first';
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

    // the grid
    const scroll = h('div', 'dg-scroll');
    const table = h('table', 'dg-grid');
    const head = h('tr');
    const corner = h('th', 'dg-corner', pie ? 'slice' : 'label');
    head.append(corner);
    grid.series.forEach((s, ci) => {
      const th = h('th');
      th.append(cellInput(-1, ci, s.name, `series ${ci + 1} name`, 'dg-name', s.named ? '' : s.name));
      head.append(th);
    });
    const thead = h('thead');
    thead.append(head);
    const tbody = h('tbody');
    grid.labels.forEach((lab, ri) => {
      const tr = h('tr');
      const th = h('th');
      th.append(cellInput(ri, -1, lab, `label ${ri + 1}`, 'dg-label'));
      tr.append(th);
      grid.series.forEach((s, ci) => {
        const td = h('td');
        td.append(cellInput(ri, ci, s.cells[ri], `${s.name}, ${lab}`, 'dg-num'));
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(thead, tbody);
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
    del.disabled = n <= 1;
    up.disabled = rowAt() <= 0 || cur.row < 0;
    down.disabled = rowAt() >= n - 1 || cur.row < 0;
    addS.disabled = pie;
    if (pie) addS.title = 'a pie takes one series';
    delS.disabled = m <= 1;
    for (const b of [add, del, up, down, addS, delS]) if (readOnly) b.disabled = true;
    actions.append(add, del, up, down, h('span', 'dg-spacer'), addS, delS);
    el.append(actions);

    statusEl = h('div', 'dg-status');
    el.append(statusEl);
    status();
    el.append(h('div', 'narr-head ins-foot', readOnly ? 'esc lets go of it' : 'tab and enter walk the cells'));
    if (to) focusCell(to.row, to.col);
    else if (keep && keep.dataset.row != null) focusCell(Number(keep.dataset.row), Number(keep.dataset.col));
  }

  /** One cell: a label, a series' name (row -1) or a number. */
  function cellInput(row, col, value, label, cls, placeholder = '') {
    const c = h('input', `dg-cell ${cls}`);
    c.type = 'text';
    c.value = placeholder && value === placeholder ? '' : value;
    if (placeholder) c.placeholder = placeholder;
    c.dataset.row = String(row);
    c.dataset.col = String(col);
    c.setAttribute('aria-label', label);
    c.spellcheck = false;
    c.autocomplete = 'off';
    if (cls === 'dg-num') c.inputMode = 'decimal';
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
    else {
      const ok = cellNumber(c.value).ok;
      c.classList.toggle('dg-bad', !ok);
      c.setAttribute('aria-invalid', String(!ok));
      c.title = ok ? '' : 'not a number: not saved';
      // not a number: the cell keeps, on the slide and in the file, what it
      // held when the caret came in, never the `19` on the way to `19o`
      if (!ok) { if (cellNumber(c.dataset.was ?? '').ok) { apply(setCell(json, row, col, c.dataset.was ?? '')); later(); } return; }
      next = setCell(json, row, col, c.value);
    }
    apply(next);
    later();
  }

  /** A spreadsheet's keys: Tab and Enter walk the cells, Esc puts a cell back. */
  function keys(e, c) {
    // a cell's keys are its own: the deck never hears what is typed here
    e.stopPropagation();
    const row = Number(c.dataset.row), col = Number(c.dataset.col);
    if (e.key === 'Escape') {
      e.preventDefault();
      if (c.value !== c.dataset.was) { c.value = c.dataset.was ?? ''; edit(c); c.select(); } else c.blur();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      flush();
      const to = row + (e.shiftKey ? -1 : 1);
      if (cellAt(to, col)) focusCell(to, col);
      return;
    }
    if (e.key === 'Tab' && grid) {
      // across, then on to the next row's label; past either end, the tab order's
      const last = grid.series.length - 1;
      const [r, k] = e.shiftKey ? (col > -1 ? [row, col - 1] : [row - 1, last]) : (col < last ? [row, col + 1] : [row + 1, -1]);
      const to = r === -1 && k === -1 ? null : cellAt(r, k);
      if (to) { e.preventDefault(); to.focus(); to.select(); }
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
