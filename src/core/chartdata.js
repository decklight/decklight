// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A chart's numbers as a grid (the inspector's Data tab, SPEC CHARTS and
 * PRESENTING_EDITING): read from the chart's own JSON, edited a cell at a
 * time, and written back as the SAME text with only the edited values
 * changed.
 *
 * The JSON is the author's, so it is never parsed into an object and printed
 * again: that would lose the key order a reader relies on, the line breaks,
 * the `1.50` typed on purpose, and every key this module does not know. It is
 * read as a tree of OFFSETS into the text instead, and each edit is a splice
 * of the few characters it changes; an inserted item copies the separator its
 * neighbours already use.
 *
 * The page side is in chartgrid.js. Everything here is pure, so it runs under
 * node:test without a browser.
 */

import { cellNumber, resolveAt } from '../../tools/chart-spec.mjs';

// ---------------------------------------------------------------------------
// the JSON, as offsets

/**
 * Parse `text` as JSON, keeping where every value starts and ends.
 * Nodes: `{ kind, start, end }`, plus `items` (array), `members` (object:
 * `{ key, name, value }`, `key` the key's string node) and `value` (scalars,
 * decoded). Throws with a message meant to be read, like JSON.parse.
 */
export function parseJsonTree(text) {
  let i = 0;
  const fail = (what) => { throw new Error(`${what} at position ${i}`); };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  function value() {
    ws();
    const c = text[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') return string();
    if (c === '-' || (c >= '0' && c <= '9')) return number();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) { const start = i; i += word.length; return { kind: word, start, end: i, value: v }; }
    }
    return fail(i >= text.length ? 'unexpected end of JSON' : `unexpected "${c}"`);
  }
  function string() {
    const start = i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if (text.charCodeAt(i) < 0x20) fail('control character in a string');
      i++;
    }
    if (i >= text.length) fail('unterminated string');
    i++;
    let decoded;
    try { decoded = JSON.parse(text.slice(start, i)); } catch { i = start; fail('bad escape in a string'); }
    return { kind: 'string', start, end: i, value: decoded };
  }
  function number() {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail('bad number');
    const start = i;
    i += m[0].length;
    return { kind: 'number', start, end: i, value: Number(m[0]) };
  }
  function array() {
    const start = i++;
    const items = [];
    ws();
    if (text[i] === ']') { i++; return { kind: 'array', start, end: i, items }; }
    for (;;) {
      items.push(value());
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return { kind: 'array', start, end: i, items }; }
      fail('expected , or ]');
    }
  }
  function object() {
    const start = i++;
    const members = [];
    ws();
    if (text[i] === '}') { i++; return { kind: 'object', start, end: i, members }; }
    for (;;) {
      ws();
      if (text[i] !== '"') fail('expected a key');
      const key = string();
      ws();
      if (text[i] !== ':') fail('expected :');
      i++;
      members.push({ key, name: key.value, value: value() });
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return { kind: 'object', start, end: i, members }; }
      fail('expected , or }');
    }
  }
  const root = value();
  ws();
  if (i < text.length) fail('unexpected text after the JSON');
  return root;
}

/** The member `name` of an object node (the last one, as JSON.parse keeps), or null. */
const member = (obj, name) => (obj?.kind === 'object' ? obj.members.filter((m) => m.name === name).at(-1) ?? null : null);

/**
 * A string as JSON that can sit inside a `<script>`: a `</script` in a label
 * would end the element, and `<!--` would start a comment the browser keeps
 * reading into.
 */
export function jsonString(s) {
  return JSON.stringify(String(s)).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '\\u003c!--');
}

/** Apply `[{ start, end, text }]` (non-overlapping) to `src`, the last first so the offsets hold. */
function splice(src, edits) {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** The whitespace a line starts with, for the line `at` is on. */
function indentAt(src, at) {
  const nl = src.lastIndexOf('\n', at - 1);
  return /^[ \t]*/.exec(src.slice(nl + 1))[0];
}

// what goes between two values on one line, as this text spells it
// elsewhere: `[1,2]` writes `[1,2,0]`, never `[1,2, 0]`
let inlineSep = ', ';
function learnSeparator(src, tree) {
  inlineSep = ', ';
  const walk = (n) => {
    const list = n.kind === 'array' ? n.items : n.kind === 'object' ? n.members.map(span) : [];
    if (list.length >= 2) {
      const gap = src.slice(list[0].end, list[1].start);
      if (!/\n/.test(gap)) { inlineSep = gap; return true; }
    }
    return (n.kind === 'array' ? n.items : n.kind === 'object' ? n.members.map((m) => m.value) : []).some(walk);
  };
  walk(tree);
}

/**
 * What goes between two items of `list` (array items, or object members as
 * `{ start, end }`), as the author wrote it: the gap between the first two,
 * else the gap this text puts between values on a line (or a line break at
 * the one item's own depth when it sits on a line of its own).
 */
function separatorOf(src, open, list) {
  if (list.length >= 2) return src.slice(list[0].end, list[1].start);
  if (list.length === 1 && /\n/.test(src.slice(open + 1, list[0].start))) return `,\n${indentAt(src, list[0].start)}`;
  // `{ "data": [1] }` is spaced inside, so its items are too
  if (list.length === 1 && src[open + 1] === ' ') return ', ';
  return inlineSep;
}

/** The edit that inserts `raws` at position `at` of `list` (inside the container opening at `open`, closing at `close`). */
function insertEdit(src, open, close, list, at, raws) {
  if (!raws.length) return null;
  const sep = separatorOf(src, open, list);
  const body = raws.join(sep);
  if (!list.length) return { start: open + 1, end: close - 1, text: body };
  if (at < list.length) return { start: list[at].start, end: list[at].start, text: body + sep };
  return { start: list.at(-1).end, end: list.at(-1).end, text: sep + body };
}

/** The edit that removes item `k` of `list`, and the separator beside it. */
function removeEdit(open, close, list, k) {
  if (list.length === 1) return { start: open + 1, end: close - 1, text: '' };
  if (k < list.length - 1) return { start: list[k].start, end: list[k + 1].start, text: '' };
  return { start: list[k - 1].end, end: list[k].end, text: '' };
}

const span = (m) => ({ start: m.key.start, end: m.value.end });
const arrayInsert = (src, arr, at, raws) => insertEdit(src, arr.start, arr.end, arr.items, at, raws);
const arrayRemove = (arr, k) => removeEdit(arr.start, arr.end, arr.items, k);
const objectRemove = (obj, name) => {
  const k = obj.members.findIndex((m) => m.name === name);
  return k < 0 ? null : removeEdit(obj.start, obj.end, obj.members.map(span), k);
};
/** Insert `"name": raw` as member `at` of `obj`, the colon spaced as its neighbours space theirs. */
function objectInsert(src, obj, at, name, raw) {
  const colon = obj.members.length ? src.slice(obj.members[0].key.end, obj.members[0].value.start) : ': ';
  return insertEdit(src, obj.start, obj.end, obj.members.map(span), at, [`${jsonString(name)}${colon}${raw}`]);
}
const replaceEdit = (node, text) => ({ start: node.start, end: node.end, text });

// ---------------------------------------------------------------------------
// the chart, as a grid

/** The kinds the grid edits: one value per label per series (SPEC CHARTS). */
export const GRID_TYPES = ['bar', 'line', 'area', 'pie', 'donut'];
const isPie = (t) => t === 'pie' || t === 'donut';

// Cell text → the JSON it writes: shared with the chart itself, which reads
// a value the way a cell does (tools/chart-spec.mjs).
export { cellNumber };

/** The type a chart is, from its `data-chart` attribute or else its JSON, donut told apart: `{ type, from }`. */
function typeOf(tree, attrs) {
  const fromAttr = attrs.type != null && String(attrs.type).trim() !== '';
  const named = fromAttr ? String(attrs.type) : member(tree, 'type')?.value?.value;
  let type = String(named ?? '').trim().toLowerCase();
  if (type === 'pie' && member(tree, 'donut')?.value?.value === true) type = 'donut';
  return { type, from: fromAttr ? 'attr' : 'json' };
}

/**
 * The grid a chart's JSON shows, or why it cannot be one.
 *
 * On a line or area chart a series also shows its band (`band`, `{ low,
 * high }` as cells, null when it has none) and its markers (`marks`, a row's
 * marker words, '' for a marker without, null for none); a band series
 * (`kind: 'band'`) has no values of its own, only its band.
 *
 * `attrs` is what the element says: `{ type, title }` (its `data-chart` and
 * `data-title`, null when absent). Returns `{ ok: true, type, typeFrom,
 * title, titleFrom, labels, series: [{ name, named, cells }] }`, a cell being
 * the text it shows ('' for a gap), or `{ ok: false, reason }` for a chart
 * the grid cannot represent: a scatter (x/y pairs), JSON that does not parse,
 * a series that is not a list of numbers, more values than labels.
 */
export function chartGrid(json, attrs = {}) {
  let tree;
  try { tree = parseJsonTree(String(json ?? '')); } catch (e) { return { ok: false, reason: `its JSON does not parse (${e.message})` }; }
  if (tree.kind !== 'object') return { ok: false, reason: 'its JSON is not an object' };
  const { type, from: typeFrom } = typeOf(tree, attrs);
  if (type === 'scatter') return scatterGrid(json, tree, attrs, typeFrom);
  if (!GRID_TYPES.includes(type)) return { ok: false, type, reason: type ? `"${type}" is not a kind of chart` : 'it names no kind of chart' };
  const labelsNode = member(tree, 'labels')?.value;
  const seriesNode = member(tree, 'series')?.value;
  if (labelsNode?.kind !== 'array' || !labelsNode.items.length) return { ok: false, type, reason: 'it has no "labels" list' };
  if (seriesNode?.kind !== 'array' || !seriesNode.items.length) return { ok: false, type, reason: 'it has no "series" list' };
  if (labelsNode.items.some((n) => n.kind === 'object' || n.kind === 'array')) return { ok: false, type, reason: 'a label is not a word or a number' };
  const labels = labelsNode.items.map((n) => (n.value == null ? '' : String(n.value)));
  // a list of values as cells, or why it is not one
  const cellsOf = (list, what) => {
    if (list.items.length > labels.length) return `${what} has more values than there are labels`;
    const cells = [];
    for (const v of list.items) {
      if (v.kind === 'number') cells.push(json.slice(v.start, v.end));
      else if (v.kind === 'null') cells.push('');
      else if (v.kind === 'string' && cellNumber(v.value).ok) cells.push(v.value.trim());
      else return `${what} has a value that is not a number`;
    }
    while (cells.length < labels.length) cells.push('');
    return cells;
  };
  // a line or area chart shows a series' band and its markers too (CHARTS)
  const lines = type === 'line' || type === 'area';
  const series = [];
  for (const [si, s] of seriesNode.items.entries()) {
    const kind = s.kind === 'object' && member(s, 'type')?.value?.value === 'band' ? 'band' : 'line';
    const data = member(s, 'data')?.value;
    if (s.kind !== 'object' || (kind === 'line' && data?.kind !== 'array')) return { ok: false, type, reason: `series ${si + 1} has no "data" list` };
    let cells = data?.kind === 'array' ? cellsOf(data, `series ${si + 1}`) : labels.map(() => '');
    if (typeof cells === 'string') return { ok: false, type, reason: cells };
    if (kind === 'band') cells = labels.map(() => '');
    let band = null;
    const b = member(s, 'band')?.value;
    if (b && b.kind !== 'null') {
      const low = member(b, 'low')?.value, high = member(b, 'high')?.value;
      if (b.kind !== 'object' || low?.kind !== 'array' || high?.kind !== 'array') return { ok: false, type, reason: `series ${si + 1} has a band that is not a "low" and a "high" list` };
      band = { low: cellsOf(low, `the band of series ${si + 1}`), high: cellsOf(high, `the band of series ${si + 1}`) };
      for (const e of [band.low, band.high]) if (typeof e === 'string') return { ok: false, type, reason: e };
    } else if (kind === 'band') return { ok: false, type, reason: `series ${si + 1} is a band with no "band" lists` };
    // the markers, a ticked cell a row: null where there is none, else its words
    let marks = null;
    const ms = member(s, 'markers')?.value;
    if (ms && ms.kind !== 'null') {
      if (ms.kind !== 'array') return { ok: false, type, reason: `series ${si + 1} has "markers" that are not a list` };
      marks = labels.map(() => null);
      for (const m of ms.items) {
        const k = m.kind === 'object' ? resolveAt(labels, member(m, 'at')?.value?.value) : -1;
        if (k === -1) return { ok: false, type, reason: `series ${si + 1} has a marker at no label of the chart` };
        if (marks[k] != null) return { ok: false, type, reason: `series ${si + 1} has two markers at "${labels[k]}"` };
        const label = member(m, 'label')?.value?.value;
        marks[k] = label != null ? String(label) : '';
      }
    }
    const name = member(s, 'name')?.value;
    // where its line turns dashed: a row, or -1 for a reference naming none
    const dash = member(s, 'dashFrom')?.value;
    series.push({
      name: name?.value != null ? String(name.value) : `series ${si + 1}`, named: !!name, kind, cells,
      band: lines ? band : null, marks: lines && kind === 'line' ? marks ?? labels.map(() => null) : null,
      dash: lines && kind === 'line' && dash && dash.kind !== 'null' ? refAt(labels, dash) : null,
    });
  }
  const jsonTitle = member(tree, 'title')?.value;
  const titleFrom = attrs.title != null || !jsonTitle ? 'attr' : 'json';
  const title = titleFrom === 'attr' ? attrs.title ?? '' : String(jsonTitle.value ?? '');
  return { ok: true, type, typeFrom, title, titleFrom, labels, series, ...(isPie(type) ? {} : rulesOf(json, tree, labels)) };
}

/** A reference to a row as the grid shows it: `{ row, written }`, row -1 when it names no label (nor a position). */
const refAt = (labels, node) => ({ row: resolveAt(labels, node?.value), written: node?.value == null ? '' : String(node.value) });

/**
 * The chart's own rules (CHARTS), on a chart with a value axis: `now`, `{ row,
 * written, words }` (words '' when it says none: drawn as *now*), and
 * `threshold`, `{ y, words }`, `y` the number as it is written; each null
 * when the chart has none.
 */
function rulesOf(json, tree, labels) {
  const n = member(tree, 'now')?.value;
  let now = null;
  if (n && n.kind !== 'null') {
    const obj = n.kind === 'object';
    const words = obj ? member(n, 'label')?.value?.value : null;
    now = { ...refAt(labels, obj ? member(n, 'at')?.value : n), words: words != null ? String(words) : '' };
  }
  const t = member(tree, 'threshold')?.value;
  let threshold = null;
  if (t?.kind === 'object') {
    const y = member(t, 'y')?.value;
    const words = member(t, 'label')?.value?.value;
    threshold = {
      y: y?.kind === 'number' ? json.slice(y.start, y.end) : y?.kind === 'string' ? y.value.trim() : '',
      words: words != null ? String(words) : '',
    };
  }
  return { now, threshold };
}

/**
 * A scatter as the grid shows it (CHARTS): its series as x / y pairs, and its
 * axis titles. `{ ok: true, type: 'scatter', typeFrom, title, titleFrom,
 * x, y, series: [{ name, named, points: [[x, y]] }] }`, each number the text
 * it is written as, or `{ ok: false, reason }`: a series without a `points`
 * list, or a point that is not two numbers (the chart drops one; the grid
 * would write it back, so it says so instead).
 */
function scatterGrid(json, tree, attrs, typeFrom) {
  const seriesNode = member(tree, 'series')?.value;
  if (seriesNode?.kind !== 'array' || !seriesNode.items.length) return { ok: false, type: 'scatter', reason: 'it has no "series" list' };
  const series = [];
  for (const [si, s] of seriesNode.items.entries()) {
    const pts = member(s, 'points')?.value;
    if (s.kind !== 'object' || pts?.kind !== 'array') return { ok: false, type: 'scatter', reason: `series ${si + 1} has no "points" list` };
    const points = [];
    for (const [pi, pt] of pts.items.entries()) {
      if (pt.kind !== 'array' || pt.items.length !== 2 || pt.items.some((v) => v.kind !== 'number')) {
        return { ok: false, type: 'scatter', reason: `point ${pi + 1} of series ${si + 1} is not two numbers` };
      }
      points.push(pt.items.map((v) => json.slice(v.start, v.end)));
    }
    const name = member(s, 'name')?.value;
    series.push({ name: name?.value != null ? String(name.value) : `series ${si + 1}`, named: !!name, points });
  }
  const text = (k) => { const v = member(tree, k)?.value; return v?.value != null ? String(v.value) : ''; };
  const jsonTitle = member(tree, 'title')?.value;
  const titleFrom = attrs.title != null || !jsonTitle ? 'attr' : 'json';
  const title = titleFrom === 'attr' ? attrs.title ?? '' : String(jsonTitle.value ?? '');
  return { ok: true, type: 'scatter', typeFrom, title, titleFrom, x: text('x'), y: text('y'), series };
}

/** The series list alone: what naming and removing a series need, whatever kind of chart it is. */
function seriesParts(json) {
  const tree = parseJsonTree(json);
  learnSeparator(json, tree);
  const series = member(tree, 'series')?.value;
  if (series?.kind !== 'array') throw new Error('this chart has no series list');
  return { tree, series };
}
/** A scatter's series, each with its `points` list, or a refusal. */
function scatterParts(json) {
  const p = seriesParts(json);
  const points = p.series.items.map((s) => member(s, 'points')?.value ?? null);
  if (points.some((x) => x?.kind !== 'array')) throw new Error('this scatter has a series without points');
  return { ...p, points };
}

/** Point `pi` of series `si` takes `input` as its x (`axis` 0) or its y (1); both must be numbers. */
export function setPoint(json, si, pi, axis, input) {
  const n = cellNumber(input);
  if (!n.ok || n.value === null) throw new Error(`"${String(input).trim()}" is not a number: a point needs both its x and its y`);
  const p = scatterParts(json);
  const pt = p.points[si]?.items[pi];
  if (pt?.kind !== 'array' || !pt.items[axis] || (axis !== 0 && axis !== 1)) throw new Error('no such point');
  return splice(json, [replaceEdit(pt.items[axis], n.raw)]);
}

/** A point after point `at` of series `si` (at the end by default), a copy of the one before it, written as its neighbours are. */
export function addPoint(json, si, at = null) {
  const p = scatterParts(json);
  const pts = p.points[si];
  if (!pts) throw new Error('no such series');
  const k = at == null ? pts.items.length : Math.max(0, Math.min(pts.items.length, at + 1));
  const like = pts.items[k - 1] ?? pts.items[0];
  const raw = like ? json.slice(like.start, like.end) : '[0, 0]';
  return splice(json, [arrayInsert(json, pts, k, [raw])]);
}

/** Point `pi` of series `si` goes; a series keeps at least one. */
export function removePoint(json, si, pi) {
  const p = scatterParts(json);
  const pts = p.points[si];
  if (!pts || pi < 0 || pi >= pts.items.length) throw new Error('no such point');
  if (pts.items.length <= 1) throw new Error('a series keeps at least one point');
  return splice(json, [arrayRemove(pts, pi)]);
}

/** A new scatter series at the end, called `name`, one point at the origin, written the way the last series is (one line or several). */
export function addScatterSeries(json, name = null) {
  const p = scatterParts(json);
  const last = p.series.items.at(-1);
  const lastText = last ? json.slice(last.start, last.end) : '{ }';
  const colon = last?.kind === 'object' && last.members.length ? json.slice(last.members[0].key.end, last.members[0].value.start) : ': ';
  const nm = jsonString(name ?? `series ${p.series.items.length + 1}`);
  let raw;
  if (/\n/.test(lastText) && last?.kind === 'object' && last.members.length) {
    const inner = indentAt(json, last.members[0].key.start);
    const outer = indentAt(json, last.end - 1);
    raw = `{\n${inner}"name"${colon}${nm},\n${inner}"points"${colon}[[0, 0]]\n${outer}}`;
  } else {
    const pad = /^\{\s/.test(lastText) ? ' ' : '';
    raw = `{${pad}"name"${colon}${nm}, "points"${colon}[[0, 0]]${pad}}`;
  }
  return splice(json, [arrayInsert(json, p.series, p.series.items.length, [raw])]);
}

/** A scatter's axis title, `"x"` or `"y"` in its JSON; empty takes it off. */
export function setAxisTitle(json, axis, text) {
  if (axis !== 'x' && axis !== 'y') throw new Error('an axis is x or y');
  const t = String(text ?? '');
  return setTopKey(json, axis, t ? jsonString(t) : null);
}

/** The parts every edit below needs, or a refusal. */
function parts(json) {
  const tree = parseJsonTree(json);
  learnSeparator(json, tree);
  const labels = member(tree, 'labels')?.value;
  const series = member(tree, 'series')?.value;
  if (labels?.kind !== 'array' || series?.kind !== 'array') throw new Error('this chart is not a grid');
  const data = series.items.map((s) => member(s, 'data')?.value ?? null);
  return { tree, labels, series, data };
}

/** The edits that make each series' data at least `len` long, with gaps. */
function padEdits(json, p, len) {
  return p.data.flatMap((d) => (d && d.items.length < len ? [arrayInsert(json, d, d.items.length, Array(len - d.items.length).fill('null'))] : []));
}

/** A series' band lists, `{ band, low, high }` (null where it has none). */
function bandOf(s) {
  const band = member(s, 'band')?.value;
  if (band?.kind !== 'object') return null;
  const low = member(band, 'low')?.value, high = member(band, 'high')?.value;
  return low?.kind === 'array' && high?.kind === 'array' ? { band, low, high } : null;
}
/** Every list that holds a value a row: each series' data and its band's two edges. */
const rowLists = (p) => p.series.items.flatMap((s, k) => {
  const b = bandOf(s);
  return [p.data[k], b?.low, b?.high].filter(Boolean);
});

/** Value `row` of series `col` becomes the number typed (`''` a gap); a bad number throws. */
export function setCell(json, row, col, input) {
  const n = cellNumber(input);
  if (!n.ok) throw new Error(`"${String(input).trim()}" is not a number`);
  const p = parts(json);
  const d = p.data[col];
  if (!d || row < 0 || row >= p.labels.items.length) throw new Error('no such cell');
  if (row < d.items.length) return splice(json, [replaceEdit(d.items[row], n.raw)]);
  return splice(json, [arrayInsert(json, d, d.items.length, [...Array(row - d.items.length).fill('null'), n.raw])]);
}

/** Label `row` becomes `text`. */
export function setLabel(json, row, text) {
  const p = parts(json);
  const node = p.labels.items[row];
  if (!node) throw new Error('no such row');
  const before = labelsOf(p);
  // a reference that names the row by its label follows it to its new one
  return followRefs(splice(json, [replaceEdit(node, jsonString(text))]), before, (k) => k, row);
}

/** Series `col` is called `name`; a series that had no name gets one, first. */
export function setSeriesName(json, col, name) {
  const p = seriesParts(json);
  const s = p.series.items[col];
  if (s?.kind !== 'object') throw new Error('no such series');
  const m = member(s, 'name');
  return splice(json, [m ? replaceEdit(m.value, jsonString(name)) : objectInsert(json, s, 0, 'name', jsonString(name))]);
}

/** A row at `at` (the end by default): its label, and a 0 in every series. */
export function addRow(json, at = null, label = null) {
  let p = parts(json);
  const n = p.labels.items.length;
  const k = at == null ? n : Math.max(0, Math.min(n, at));
  // a series shorter than the place the row goes is filled with gaps first
  const before = labelsOf(p);
  const padded = splice(json, padEdits(json, p, k));
  p = parts(padded);
  const edits = [arrayInsert(padded, p.labels, k, [jsonString(label ?? `label ${n + 1}`)])];
  for (const d of p.data) if (d) edits.push(arrayInsert(padded, d, k, ['0']));
  // a band has no range there yet: a gap, never a pinch to 0
  for (const s of p.series.items) {
    const b = bandOf(s);
    if (!b) continue;
    for (const e of [b.low, b.high]) if (e.items.length >= k) edits.push(arrayInsert(padded, e, k, ['null']));
  }
  return followRefs(splice(padded, edits), before, (r) => (r >= k ? r + 1 : r));
}

/** Row `row` goes, its label and its value in every series; the last row stays. */
export function removeRow(json, row) {
  const p = parts(json);
  if (p.labels.items.length <= 1) throw new Error('a chart keeps at least one row');
  if (row < 0 || row >= p.labels.items.length) throw new Error('no such row');
  const before = labelsOf(p);
  const edits = [arrayRemove(p.labels, row)];
  for (const d of rowLists(p)) if (row < d.items.length) edits.push(arrayRemove(d, row));
  // a marker at the row goes with it; a dashFrom or now there comes off
  return followRefs(splice(json, edits), before, (r) => (r === row ? -1 : r > row ? r - 1 : r));
}

/** Row `row` trades places with the one `by` (±1) from it. */
export function moveRow(json, row, by) {
  let p = parts(json);
  const to = row + by;
  const n = p.labels.items.length;
  if (row < 0 || row >= n || to < 0 || to >= n) throw new Error('no row to move it past');
  // a series holding one of the two values but not the other is given a gap
  // for the missing one, so the value moves; one holding neither is left alone
  const before = labelsOf(p);
  const lo = Math.min(row, to), hi = Math.max(row, to);
  const pads = rowLists(p).flatMap((d) => (d.items.length > lo && d.items.length <= hi
    ? [arrayInsert(json, d, d.items.length, Array(hi + 1 - d.items.length).fill('null'))] : []));
  const padded = splice(json, pads);
  p = parts(padded);
  const swap = (arr) => {
    const a = arr.items[row], b = arr.items[to];
    if (!a || !b) return [];
    return [replaceEdit(a, padded.slice(b.start, b.end)), replaceEdit(b, padded.slice(a.start, a.end))];
  };
  return followRefs(splice(padded, [p.labels, ...rowLists(p)].flatMap(swap)), before, (r) => (r === row ? to : r === to ? row : r));
}

/**
 * A new series at the end, called `name`, a 0 for every label. It is written
 * the way the last series is: on one line if that one is, else on lines of
 * its own at the same depth. Only `name` and `data`: the last series' other
 * keys (a concept, say) are its own.
 */
export function addSeries(json, name = null) {
  const p = parts(json);
  const n = p.labels.items.length;
  const last = p.series.items.at(-1);
  const lastText = last ? json.slice(last.start, last.end) : '{ }';
  const colon = last?.kind === 'object' && last.members.length ? json.slice(last.members[0].key.end, last.members[0].value.start) : ': ';
  const lastData = last ? member(last, 'data')?.value : null;
  const vsep = lastData?.kind === 'array' && lastData.items.length >= 2 ? json.slice(lastData.items[0].end, lastData.items[1].start) : ', ';
  const nm = `${jsonString(name ?? `series ${p.series.items.length + 1}`)}`;
  const values = `[${Array(n).fill('0').join(vsep)}]`;
  let raw;
  if (/\n/.test(lastText) && last?.kind === 'object' && last.members.length) {
    const inner = indentAt(json, last.members[0].key.start);
    const outer = indentAt(json, last.end - 1);
    raw = `{\n${inner}"name"${colon}${nm},\n${inner}"data"${colon}${values}\n${outer}}`;
  } else {
    const pad = /^\{\s/.test(lastText) ? ' ' : '';
    raw = `{${pad}"name"${colon}${nm}, "data"${colon}${values}${pad}}`;
  }
  return splice(json, [arrayInsert(json, p.series, p.series.items.length, [raw])]);
}

/** Series `col` goes; the last one stays. */
export function removeSeries(json, col) {
  const p = seriesParts(json);
  if (p.series.items.length <= 1) throw new Error('a chart keeps at least one series');
  if (col < 0 || col >= p.series.items.length) throw new Error('no such series');
  return splice(json, [arrayRemove(p.series, col)]);
}

// ---------------------------------------------------------------------------
// a series' band and its markers (CHARTS): low / high as two more columns,
// a marker a ticked cell

/** The chart's labels as text, as the references name them. */
const labelsOf = (p) => p.labels.items.map((n) => (n.value == null ? '' : String(n.value)));

/**
 * Every place that names a row (`now`, each series' `dashFrom`, each marker's
 * `at`): `{ node, remove }`, the value node and the edit that takes the
 * reference away (the key, or the whole marker).
 */
function refsOf(tree) {
  const out = [];
  const now = member(tree, 'now');
  if (now) {
    const at = now.value.kind === 'object' ? member(now.value, 'at')?.value : now.value;
    if (at) out.push({ node: at, remove: () => objectRemove(tree, 'now') });
  }
  for (const s of member(tree, 'series')?.value?.items ?? []) {
    if (s.kind !== 'object') continue;
    const dash = member(s, 'dashFrom');
    if (dash) out.push({ node: dash.value, remove: () => objectRemove(s, 'dashFrom') });
    const ms = member(s, 'markers')?.value;
    if (ms?.kind !== 'array') continue;
    ms.items.forEach((m, j) => {
      const at = member(m, 'at')?.value;
      if (at) out.push({ node: at, remove: () => (ms.items.length === 1 ? objectRemove(s, 'markers') : arrayRemove(ms, j)) });
    });
  }
  return out;
}

/**
 * After a row edit, every reference to a row still names the row it did:
 * `move(oldRow)` is where that row is now (-1: gone, and the reference with
 * it). One named by its label needs nothing, unless the label itself was
 * `renamed` (the row whose label changed); one named by its position is
 * renumbered. Applied one edit at a time, so two in one list never collide.
 */
function followRefs(json, before, move, renamed = -1) {
  const done = new Set();
  for (let guard = 0; guard < 256; guard++) {
    const tree = parseJsonTree(json);
    learnSeparator(json, tree);
    const after = (member(tree, 'labels')?.value?.items ?? []).map((n) => (n.value == null ? '' : String(n.value)));
    let edit = null;
    for (const ref of refsOf(tree)) {
      if (done.has(ref.node.start)) continue;
      const v = ref.node.value;
      const old = resolveAt(before, v);
      if (old === -1) continue;
      const byLabel = before.indexOf(String(v)) !== -1;
      const to = move(old);
      if (to === -1) edit = ref.remove();
      else if (byLabel && old === renamed) edit = replaceEdit(ref.node, jsonString(after[to]));
      else if (!byLabel && to !== old) edit = replaceEdit(ref.node, String(to));
      if (edit) break;
      done.add(ref.node.start);
    }
    if (!edit) return json;
    // offsets before the edit hold; after it, they move by what it changed
    const delta = edit.text.length - (edit.end - edit.start);
    const kept = [...done].map((at) => (at >= edit.end ? at + delta : at));
    done.clear();
    for (const at of kept) done.add(at);
    if (edit.text) done.add(edit.start);
    json = splice(json, [edit]);
  }
  return json;
}

/** A series of a grid chart, by column. */
function seriesAt(json, col) {
  const p = parts(json);
  const s = p.series.items[col];
  if (s?.kind !== 'object') throw new Error('no such series');
  return { p, s };
}

/** Edge `edge` ('low' or 'high') of series `col`'s band, at `row`, becomes the number typed (`''` a gap). */
export function setBandCell(json, row, col, edge, input) {
  const n = cellNumber(input);
  if (!n.ok) throw new Error(`"${String(input).trim()}" is not a number`);
  if (edge !== 'low' && edge !== 'high') throw new Error('a band edge is low or high');
  const { p, s } = seriesAt(json, col);
  const b = bandOf(s);
  if (!b) throw new Error('this series has no band');
  const e = b[edge];
  if (row < 0 || row >= p.labels.items.length) throw new Error('no such cell');
  if (row < e.items.length) return splice(json, [replaceEdit(e.items[row], n.raw)]);
  return splice(json, [arrayInsert(json, e, e.items.length, [...Array(row - e.items.length).fill('null'), n.raw])]);
}

/**
 * Series `col` gets a band, its low and its high each a copy of its values
 * (to be widened), after its `data`; a series that has one keeps it.
 */
export function addBand(json, col) {
  const { p, s } = seriesAt(json, col);
  if (bandOf(s)) return json;
  const d = p.data[col];
  const n = p.labels.items.length;
  const vals = Array.from({ length: n }, (_, k) => (d?.items[k] ? json.slice(d.items[k].start, d.items[k].end) : 'null'));
  const sep = d && d.items.length >= 2 ? json.slice(d.items[0].end, d.items[1].start) : ', ';
  const list = `[${vals.join(/\n/.test(sep) ? ', ' : sep)}]`;
  const colon = s.members.length ? json.slice(s.members[0].key.end, s.members[0].value.start) : ': ';
  const raw = `{ "low"${colon}${list}, "high"${colon}${list} }`;
  const at = s.members.findIndex((m) => m.name === 'data');
  const edits = [objectInsert(json, s, at === -1 ? s.members.length : at + 1, 'band', raw)];
  const old = member(s, 'band');
  if (old) edits[0] = replaceEdit(old.value, raw);
  return splice(json, edits);
}

/** Series `col`'s band comes off; a band series is nothing else, so it keeps its own. */
export function removeBand(json, col) {
  const { s } = seriesAt(json, col);
  if (member(s, 'type')?.value?.value === 'band') throw new Error('a band series is its band: remove the series instead');
  const e = objectRemove(s, 'band');
  return e ? splice(json, [e]) : json;
}

/**
 * Series `col` has a marker at `row` (`on`), or none there. A new one names
 * the row by its label; taking one off takes every marker at that row, and
 * the `markers` key with the last.
 */
export function setMarker(json, row, col, on) {
  const { p, s } = seriesAt(json, col);
  const labels = labelsOf(p);
  if (row < 0 || row >= labels.length) throw new Error('no such row');
  const ms = member(s, 'markers')?.value;
  const at = (m) => resolveAt(labels, member(m, 'at')?.value?.value);
  const here = ms?.kind === 'array' ? ms.items.map((m, j) => (at(m) === row ? j : -1)).filter((j) => j !== -1) : [];
  if (on) {
    if (here.length) return json;
    const colon = s.members.length ? json.slice(s.members[0].key.end, s.members[0].value.start) : ': ';
    const raw = `{ "at"${colon}${jsonString(labels[row])} }`;
    if (ms?.kind === 'array') return splice(json, [arrayInsert(json, ms, ms.items.length, [raw])]);
    if (ms) return splice(json, [replaceEdit(ms, `[${raw}]`)]);
    return splice(json, [objectInsert(json, s, s.members.length, 'markers', `[${raw}]`)]);
  }
  if (!here.length) return json;
  if (here.length === ms.items.length) return splice(json, [objectRemove(s, 'markers')]);
  let out = json;
  for (const j of here.reverse()) {
    const t = seriesAt(out, col).s;
    out = splice(out, [arrayRemove(member(t, 'markers').value, j)]);
  }
  return out;
}

/** The words of series `col`'s marker at `row` become `text` (empty takes them off); a row with no marker gets one. */
export function setMarkerLabel(json, row, col, text) {
  let out = setMarker(json, row, col, true);
  const { p, s } = seriesAt(out, col);
  const labels = labelsOf(p);
  const m = member(s, 'markers').value.items.find((x) => resolveAt(labels, member(x, 'at')?.value?.value) === row);
  const t = String(text ?? '');
  const has = member(m, 'label');
  if (!t) { const e = has ? objectRemove(m, 'label') : null; return e ? splice(out, [e]) : out; }
  return splice(out, [has ? replaceEdit(has.value, jsonString(t)) : objectInsert(out, m, m.members.length, 'label', jsonString(t))]);
}

// ---------------------------------------------------------------------------
// where a line turns dashed, the chart's now and threshold, a band series
// (CHARTS): each one change, a reference to a row written as its label

/** A top-level key not there yet, put after the first of `after` the chart has (else at the end). */
function topInsert(json, tree, name, raw, after) {
  const k = Math.max(-1, ...after.map((a) => tree.members.findIndex((m) => m.name === a)));
  return objectInsert(json, tree, k === -1 ? tree.members.length : k + 1, name, raw);
}
const colonOf = (json, obj) => (obj.members.length ? json.slice(obj.members[0].key.end, obj.members[0].value.start) : ': ');

/**
 * Series `col`'s line turns dashed from `row` on (its `dashFrom`, naming the
 * row by its label, after its `data` and `band`), or is solid (`row` null,
 * the key taken off). A reference already naming that row stays as written.
 */
export function setDashFrom(json, col, row) {
  const { p, s } = seriesAt(json, col);
  const m = member(s, 'dashFrom');
  if (row == null) { const e = m ? objectRemove(s, 'dashFrom') : null; return e ? splice(json, [e]) : json; }
  const labels = labelsOf(p);
  if (row < 0 || row >= labels.length) throw new Error('no such row');
  if (member(s, 'type')?.value?.value === 'band') throw new Error('a band series has no line to dash');
  const raw = jsonString(labels[row]);
  if (m) return resolveAt(labels, m.value.value) === row ? json : splice(json, [replaceEdit(m.value, raw)]);
  const k = Math.max(s.members.findIndex((x) => x.name === 'data'), s.members.findIndex((x) => x.name === 'band'));
  return splice(json, [objectInsert(json, s, k === -1 ? s.members.length : k + 1, 'dashFrom', raw)]);
}

/**
 * The chart's now is at `row` (named by its label; a `{ "at": …, "label": … }`
 * keeps its words), or there is none (`row` null). A new one goes after
 * `labels`.
 */
export function setNow(json, row) {
  const p = parts(json);
  const m = member(p.tree, 'now');
  if (row == null) return setTopKey(json, 'now', null);
  const labels = labelsOf(p);
  if (row < 0 || row >= labels.length) throw new Error('no such row');
  const raw = jsonString(labels[row]);
  if (m?.value.kind === 'object') {
    const at = member(m.value, 'at');
    if (at && resolveAt(labels, at.value.value) === row) return json;
    return splice(json, [at ? replaceEdit(at.value, raw) : objectInsert(json, m.value, 0, 'at', raw)]);
  }
  if (m && m.value.kind !== 'null') return resolveAt(labels, m.value.value) === row ? json : splice(json, [replaceEdit(m.value, raw)]);
  if (m) return splice(json, [replaceEdit(m.value, raw)]);
  return splice(json, [topInsert(json, p.tree, 'now', raw, ['labels'])]);
}

/**
 * The words on the now rule become `text`: `"now": "Tue"` turns into `{
 * "at": "Tue", "label": "today" }`, and empty words (drawn *now*) turn it
 * back, unless the object holds keys of its own.
 */
export function setNowLabel(json, text) {
  const tree = parseJsonTree(json);
  learnSeparator(json, tree);
  const m = member(tree, 'now');
  if (!m || m.value.kind === 'null') throw new Error('the chart has no now: pick its label first');
  const t = String(text ?? '');
  const v = m.value;
  if (v.kind === 'object') {
    const has = member(v, 'label');
    const at = member(v, 'at');
    if (t) return splice(json, [has ? replaceEdit(has.value, jsonString(t)) : objectInsert(json, v, v.members.length, 'label', jsonString(t))]);
    if (at && v.members.every((x) => x.name === 'at' || x.name === 'label')) return splice(json, [replaceEdit(v, json.slice(at.value.start, at.value.end))]);
    const e = has ? objectRemove(v, 'label') : null;
    return e ? splice(json, [e]) : json;
  }
  if (!t) return json;
  const colon = json.slice(m.key.end, v.start);
  return splice(json, [replaceEdit(v, `{ "at"${colon}${json.slice(v.start, v.end)}, "label"${colon}${jsonString(t)} }`)]);
}

/**
 * The chart's threshold is at `y` (a number as a cell takes one; empty takes
 * the threshold off) with `words` on it (empty: none). Its other keys stay; a
 * new one goes after `now`, else `labels`.
 */
export function setThreshold(json, y, words = '') {
  const n = cellNumber(y);
  if (!n.ok) throw new Error(`"${String(y).trim()}" is not a number`);
  let tree = parseJsonTree(json);
  learnSeparator(json, tree);
  if (tree.kind !== 'object') throw new Error('its JSON is not an object');
  const m = member(tree, 'threshold');
  if (n.value === null) { const e = m ? objectRemove(tree, 'threshold') : null; return e ? splice(json, [e]) : json; }
  const t = String(words ?? '');
  if (m?.value.kind !== 'object') {
    const colon = colonOf(json, tree);
    const raw = `{ "y"${colon}${n.raw}${t ? `, "label"${colon}${jsonString(t)}` : ''} }`;
    return splice(json, [m ? replaceEdit(m.value, raw) : topInsert(json, tree, 'threshold', raw, ['now', 'labels'])]);
  }
  // its y, then its words: one splice each, the second on the text the first left
  const ym = member(m.value, 'y');
  let out = splice(json, [ym ? replaceEdit(ym.value, n.raw) : objectInsert(json, m.value, 0, 'y', n.raw)]);
  tree = parseJsonTree(out);
  learnSeparator(out, tree);
  const o = member(tree, 'threshold').value;
  const has = member(o, 'label');
  if (!t) { const e = has ? objectRemove(o, 'label') : null; return e ? splice(out, [e]) : out; }
  return splice(out, [has ? replaceEdit(has.value, jsonString(t)) : objectInsert(out, o, o.members.length, 'label', jsonString(t))]);
}

/**
 * A band series at the end (a range with no line of its own: a learned
 * normal range), its low and its high each a copy of series `from`'s values
 * (its band, for a band series; 0s with none), to be widened. Written the way
 * the last series is, as addSeries writes one.
 */
export function addBandSeries(json, from = null, name = null) {
  const p = parts(json);
  const n = p.labels.items.length;
  const src = from != null ? p.series.items[from] : null;
  const b = src ? bandOf(src) : null;
  const d = from != null ? p.data[from] : null;
  const copy = (list) => Array.from({ length: n }, (_, k) => (list ? (list.items[k] ? json.slice(list.items[k].start, list.items[k].end) : 'null') : '0'));
  const listOf = (list) => {
    const sep = list && list.items.length >= 2 ? json.slice(list.items[0].end, list.items[1].start) : ', ';
    return `[${copy(list).join(/\n/.test(sep) ? ', ' : sep)}]`;
  };
  const low = listOf(d ?? b?.low ?? null), high = listOf(d ?? b?.high ?? null);
  const last = p.series.items.at(-1);
  const lastText = last ? json.slice(last.start, last.end) : '{ }';
  const colon = last?.kind === 'object' ? colonOf(json, last) : ': ';
  const taken = new Set(p.series.items.map((s) => member(s, 'name')?.value?.value));
  const nm = jsonString(name ?? (taken.has('range') ? `range ${p.series.items.length + 1}` : 'range'));
  const band = `{ "low"${colon}${low}, "high"${colon}${high} }`;
  let raw;
  if (/\n/.test(lastText) && last?.kind === 'object' && last.members.length) {
    const inner = indentAt(json, last.members[0].key.start);
    const outer = indentAt(json, last.end - 1);
    raw = `{\n${inner}"name"${colon}${nm},\n${inner}"type"${colon}"band",\n${inner}"band"${colon}${band}\n${outer}}`;
  } else {
    const pad = /^\{\s/.test(lastText) ? ' ' : '';
    raw = `{${pad}"name"${colon}${nm}, "type"${colon}"band", "band"${colon}${band}${pad}}`;
  }
  return splice(json, [arrayInsert(json, p.series, p.series.items.length, [raw])]);
}

/** Top-level key `name` set to `raw` (JSON text), or removed with `raw` null; appended when new. */
export function setTopKey(json, name, raw) {
  const tree = parseJsonTree(json);
  learnSeparator(json, tree);
  if (tree.kind !== 'object') throw new Error('its JSON is not an object');
  const m = member(tree, name);
  if (raw == null) { const e = m ? objectRemove(tree, name) : null; return e ? splice(json, [e]) : json; }
  return splice(json, [m ? replaceEdit(m.value, raw) : objectInsert(json, tree, tree.members.length, name, raw)]);
}

/**
 * The chart becomes `type` (one of GRID_TYPES). Returns `{ json, attr }`:
 * the new JSON, and the `data-chart` value to write (null to leave the
 * attribute alone). The type is said where the chart already says it, the
 * attribute or the JSON's `"type"`; a `"donut": true` is taken off when the
 * chart stops being one. A pie takes one series: more is refused.
 */
export function setType(json, attrs, type) {
  if (!GRID_TYPES.includes(type)) throw new Error(`a grid cannot make a ${type} chart`);
  const g = chartGrid(json, attrs);
  if (!g.ok) throw new Error(g.reason);
  if (isPie(type) && g.series.length > 1) throw new Error('a pie takes one series');
  if (type !== 'line' && type !== 'area' && g.series.some((x) => x.kind === 'band')) throw new Error('a band series needs a line or area chart');
  const tree = parseJsonTree(json);
  let next = member(tree, 'donut') ? setTopKey(json, 'donut', null) : json;
  if (g.typeFrom === 'attr') return { json: next, attr: type };
  next = setTopKey(next, 'type', jsonString(type));
  return { json: next, attr: null };
}

/**
 * The chart's title becomes `title`: `{ json, attr }` as setType, `attr`
 * undefined when the attribute stays as it is, null when it goes. Said where
 * the chart says it now (the attribute wins, as it does when drawn); an
 * empty title removes it.
 */
export function setTitle(json, attrs, title) {
  const g = chartGrid(json, attrs);
  const t = String(title ?? '');
  if (g.ok && g.titleFrom === 'json') return { json: setTopKey(json, 'title', t ? jsonString(t) : null), attr: undefined };
  return { json, attr: t || null };
}

/**
 * The shapes a chart can take (CHARTS, `data-aspect` or the JSON's
 * `"aspect"`), as the Data tab names them; wide is the 640 × 360 a chart has
 * when it says nothing.
 */
export const ASPECTS = [['16:9', 'wide'], ['4:3', 'standard'], ['1:1', 'square'], ['3:4', 'tall']];
const ratioOf = (v) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(v ?? ''));
  return m && +m[1] > 0 && +m[2] > 0 ? +m[2] / +m[1] : null;
};

/**
 * The chart's shape: `{ aspect, from, written }`. `aspect` is one of ASPECTS'
 * values, or null for a shape of its own (`5:2`, shown as it is written);
 * `from` says where it is written, `'attr'`, `'json'`, or null when nowhere
 * (wide). The attribute wins, as it does when the chart is drawn.
 */
export function aspectOf(json, attrs = {}) {
  let written = attrs.aspect ?? null;
  let from = written != null ? 'attr' : null;
  if (from === null) {
    try {
      const t = parseJsonTree(String(json ?? ''));
      const a = t.kind === 'object' ? member(t, 'aspect')?.value : null;
      if (a && a.value != null) { written = String(a.value); from = 'json'; }
    } catch { /* the grid says why it cannot read the JSON */ }
  }
  if (from === null) return { aspect: '16:9', from, written: null };
  const r = ratioOf(written);
  const hit = r === null ? null : ASPECTS.find(([v]) => Math.abs(ratioOf(v) - r) < 1e-6);
  return { aspect: hit ? hit[0] : null, from, written };
}

/**
 * The chart takes shape `aspect` (one of ASPECTS): `{ json, attr }` as
 * setTitle, said where the chart says it now. Wide is the shape of a chart
 * that says nothing, so it takes the attribute or the key off, unless the
 * attribute is there over a JSON shape it would then let through.
 */
export function setAspect(json, attrs, aspect) {
  if (!ASPECTS.some(([v]) => v === aspect)) throw new Error(`a chart's shape is one of ${ASPECTS.map(([, n]) => n).join(', ')}`);
  const now = aspectOf(json, attrs);
  if (now.aspect === aspect) return { json, attr: undefined };
  const wide = aspect === '16:9';
  if (now.from === 'json') return { json: setTopKey(json, 'aspect', wide ? null : jsonString(aspect)), attr: undefined };
  if (now.from === 'attr' && wide) {
    const under = aspectOf(json, {});
    return { json, attr: under.from === 'json' && under.aspect !== '16:9' ? aspect : null };
  }
  return { json, attr: aspect };
}

/** The legend's setting: `'auto'` (the JSON says nothing), `'on'` or `'off'`. */
export function legendOf(json) {
  try {
    const t = parseJsonTree(String(json ?? ''));
    const v = t.kind === 'object' ? member(t, 'legend')?.value : null;
    return v?.value === true ? 'on' : v?.value === false ? 'off' : 'auto';
  } catch { return 'auto'; }
}
/** The legend set (`"legend": true | false` in the JSON), or its key taken off for auto. */
export function setLegend(json, legend) {
  if (!['auto', 'on', 'off'].includes(legend)) throw new Error('a legend is auto, on or off');
  return setTopKey(json, 'legend', legend === 'auto' ? null : legend === 'on' ? 'true' : 'false');
}

// ---------------------------------------------------------------------------
// the chart, in its element's source

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const ATTR = /\s+([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;

/** An open tag's attributes, with where each sits in `tag`: `[{ name, start, end, value, vStart, vEnd, quote }]`. */
function attrsOf(tag) {
  const out = [];
  const name = /^<[^\s/>]+/.exec(tag)[0];
  ATTR.lastIndex = name.length;
  let m;
  while ((m = ATTR.exec(tag))) {
    const quote = m[2] != null ? '"' : m[3] != null ? "'" : m[4] != null ? '' : null;
    const raw = m[2] ?? m[3] ?? m[4] ?? null;
    const vEnd = quote === null ? m.index + m[0].length : m.index + m[0].length - (quote ? 1 : 0);
    out.push({ name: m[1].toLowerCase(), start: m.index, end: m.index + m[0].length, value: raw == null ? '' : decodeEntities(raw),
      vStart: raw == null ? null : vEnd - raw.length, vEnd: raw == null ? null : vEnd, quote });
  }
  return out;
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (all, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k] ?? all;
  });
}
const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * Every tag in `html`, in order: `{ start, end, name, close, selfClosing }`.
 * Comments are skipped, and so is what a `<script>` or `<style>` holds (a
 * chart's JSON may say `"<b>"` and it is no tag).
 */
function tagsOf(html) {
  const out = [];
  let i = 0;
  while ((i = html.indexOf('<', i)) !== -1) {
    if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i + 4); i = e < 0 ? html.length : e + 3; continue; }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)/.exec(html.slice(i, i + 64));
    if (!m) { i++; continue; }
    let j = i + m[0].length, q = null;
    for (; j < html.length; j++) {
      const c = html[j];
      if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
    }
    const tag = { start: i, end: Math.min(j + 1, html.length), name: m[2].toLowerCase(), close: m[1] === '/' };
    tag.selfClosing = !tag.close && /\/\s*>$/.test(html.slice(tag.start, tag.end));
    out.push(tag);
    i = tag.end;
    if (!tag.close && (tag.name === 'script' || tag.name === 'style')) {
      const e = html.toLowerCase().indexOf(`</${tag.name}`, i);
      tag.contentEnd = e < 0 ? html.length : e;
      i = tag.contentEnd;
    }
  }
  return out;
}

/**
 * Chart number `ordinal` (0 first) in an element's source, counted in
 * document order with the element itself first: where its open tag is, what
 * its `data-chart` and `data-title` say (decoded; null when absent), and
 * where its JSON sits (`json: { start, end }` the script's content, or null
 * when it has none). Null when there is no such chart.
 */
export function findChart(html, ordinal = 0) {
  const tags = tagsOf(html);
  let seen = -1;
  for (const [ti, t] of tags.entries()) {
    if (t.close) continue;
    const open = html.slice(t.start, t.end);
    const attrs = attrsOf(open);
    const chart = attrs.find((a) => a.name === 'data-chart');
    if (!chart || ++seen !== ordinal) continue;
    let json = null;
    let depth = 0;
    for (const u of tags.slice(ti + 1)) {
      if (u.close) { if (--depth < 0) break; continue; }
      if (u.name === 'script' && attrsOf(html.slice(u.start, u.end)).some((a) => a.name === 'type' && a.value.trim().toLowerCase() === 'application/json')) {
        json = { start: u.end, end: u.contentEnd };
        break;
      }
      if (!VOID.has(u.name) && !u.selfClosing && u.name !== 'script' && u.name !== 'style') depth++;
    }
    const title = attrs.find((a) => a.name === 'data-title');
    const aspect = attrs.find((a) => a.name === 'data-aspect');
    return { open: { start: t.start, end: t.end }, type: chart.value, title: title ? title.value : null, aspect: aspect ? aspect.value : null, json };
  }
  return null;
}

/** `tag` with attribute `name` set to `value` (null removes it), its quoting and neighbours as they were. */
function setAttr(tag, name, value) {
  const attrs = attrsOf(tag);
  const a = attrs.find((x) => x.name === name);
  if (a) {
    if (value == null) return tag.slice(0, a.start) + tag.slice(a.end);
    if (a.value === value) return tag;
    if (a.quote === '"' || a.quote === "'") {
      const v = a.quote === '"' ? escAttr(value) : String(value).replace(/&/g, '&amp;').replace(/'/g, '&#39;');
      return tag.slice(0, a.vStart) + v + tag.slice(a.vEnd);
    }
    // bare or valueless: quoted from now on
    return tag.slice(0, a.start) + ` ${a.name}="${escAttr(value)}"` + tag.slice(a.end);
  }
  if (value == null) return tag;
  // beside data-chart, where a reader looks for it; else before the tag closes
  const after = attrs.find((x) => x.name === 'data-chart');
  const at = after ? after.end : tag.length - (/\/\s*>$/.test(tag) ? tag.match(/\s*\/\s*>$/)[0].length : 1);
  return `${tag.slice(0, at)} ${name}="${escAttr(value)}"${tag.slice(at)}`;
}

/**
 * The element's source with chart `ordinal` rewritten: its JSON replaced by
 * `json` (when given), and its attributes in `attrs` (`{ 'data-chart':
 * 'line', 'data-title': null }`, null removing one) set. Everything else, its
 * other attributes and its data-build included, is the bytes it was.
 */
export function rewriteChart(html, ordinal, { json = null, attrs = {} } = {}) {
  const c = findChart(html, ordinal);
  if (!c) throw new Error('the chart is not in the file where the page has it');
  const edits = [];
  if (json != null) {
    if (!c.json) throw new Error('the chart has no JSON in the file');
    if (html.slice(c.json.start, c.json.end) !== json) edits.push({ start: c.json.start, end: c.json.end, text: json });
  }
  let tag = html.slice(c.open.start, c.open.end);
  const was = tag;
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined) tag = setAttr(tag, name, value);
  if (tag !== was) edits.push({ start: c.open.start, end: c.open.end, text: tag });
  return splice(html, edits);
}
