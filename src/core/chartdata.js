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

/**
 * Cell text → the JSON it writes. `''` is a gap (`null`, which the chart
 * skips); a number is kept as typed when it is already JSON (`1.50` stays
 * `1.50`), and put in JSON's spelling when it is a plain decimal JSON does
 * not spell that way (`+3`, `.5`, `007`). Anything else (`12a`, `1,5`, `0x10`,
 * `Infinity`) is refused: `{ ok: false }`.
 */
export function cellNumber(input) {
  const t = String(input ?? '').trim();
  if (t === '') return { ok: true, raw: 'null', value: null };
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) {
    const v = Number(t);
    return Number.isFinite(v) ? { ok: true, raw: t, value: v } : { ok: false };
  }
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) {
    const v = Number(t);
    return Number.isFinite(v) ? { ok: true, raw: String(v), value: v } : { ok: false };
  }
  return { ok: false };
}

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
  if (type === 'scatter') return { ok: false, type, reason: 'a scatter is x/y pairs, not one value per label' };
  if (!GRID_TYPES.includes(type)) return { ok: false, type, reason: type ? `"${type}" is not a kind of chart` : 'it names no kind of chart' };
  const labelsNode = member(tree, 'labels')?.value;
  const seriesNode = member(tree, 'series')?.value;
  if (labelsNode?.kind !== 'array' || !labelsNode.items.length) return { ok: false, type, reason: 'it has no "labels" list' };
  if (seriesNode?.kind !== 'array' || !seriesNode.items.length) return { ok: false, type, reason: 'it has no "series" list' };
  if (labelsNode.items.some((n) => n.kind === 'object' || n.kind === 'array')) return { ok: false, type, reason: 'a label is not a word or a number' };
  const labels = labelsNode.items.map((n) => (n.value == null ? '' : String(n.value)));
  const series = [];
  for (const [si, s] of seriesNode.items.entries()) {
    const data = member(s, 'data')?.value;
    if (s.kind !== 'object' || data?.kind !== 'array') return { ok: false, type, reason: `series ${si + 1} has no "data" list` };
    if (data.items.length > labels.length) return { ok: false, type, reason: `series ${si + 1} has more values than there are labels` };
    const cells = [];
    for (const v of data.items) {
      if (v.kind === 'number') cells.push(json.slice(v.start, v.end));
      else if (v.kind === 'null') cells.push('');
      else if (v.kind === 'string' && cellNumber(v.value).ok) cells.push(v.value.trim());
      else return { ok: false, type, reason: `series ${si + 1} has a value that is not a number` };
    }
    while (cells.length < labels.length) cells.push('');
    const name = member(s, 'name')?.value;
    series.push({ name: name?.value != null ? String(name.value) : `series ${si + 1}`, named: !!name, cells });
  }
  const jsonTitle = member(tree, 'title')?.value;
  const titleFrom = attrs.title != null || !jsonTitle ? 'attr' : 'json';
  const title = titleFrom === 'attr' ? attrs.title ?? '' : String(jsonTitle.value ?? '');
  return { ok: true, type, typeFrom, title, titleFrom, labels, series };
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
  return splice(json, [replaceEdit(node, jsonString(text))]);
}

/** Series `col` is called `name`; a series that had no name gets one, first. */
export function setSeriesName(json, col, name) {
  const p = parts(json);
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
  const padded = splice(json, padEdits(json, p, k));
  p = parts(padded);
  const edits = [arrayInsert(padded, p.labels, k, [jsonString(label ?? `label ${n + 1}`)])];
  for (const d of p.data) if (d) edits.push(arrayInsert(padded, d, k, ['0']));
  return splice(padded, edits);
}

/** Row `row` goes, its label and its value in every series; the last row stays. */
export function removeRow(json, row) {
  const p = parts(json);
  if (p.labels.items.length <= 1) throw new Error('a chart keeps at least one row');
  if (row < 0 || row >= p.labels.items.length) throw new Error('no such row');
  const edits = [arrayRemove(p.labels, row)];
  for (const d of p.data) if (d && row < d.items.length) edits.push(arrayRemove(d, row));
  return splice(json, edits);
}

/** Row `row` trades places with the one `by` (±1) from it. */
export function moveRow(json, row, by) {
  let p = parts(json);
  const to = row + by;
  const n = p.labels.items.length;
  if (row < 0 || row >= n || to < 0 || to >= n) throw new Error('no row to move it past');
  // a series holding one of the two values but not the other is given a gap
  // for the missing one, so the value moves; one holding neither is left alone
  const lo = Math.min(row, to), hi = Math.max(row, to);
  const pads = p.data.flatMap((d) => (d && d.items.length > lo && d.items.length <= hi
    ? [arrayInsert(json, d, d.items.length, Array(hi + 1 - d.items.length).fill('null'))] : []));
  const padded = splice(json, pads);
  p = parts(padded);
  const swap = (arr) => {
    const a = arr.items[row], b = arr.items[to];
    if (!a || !b) return [];
    return [replaceEdit(a, padded.slice(b.start, b.end)), replaceEdit(b, padded.slice(a.start, a.end))];
  };
  return splice(padded, [p.labels, ...p.data.filter(Boolean)].flatMap(swap));
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
  const p = parts(json);
  if (p.series.items.length <= 1) throw new Error('a chart keeps at least one series');
  if (col < 0 || col >= p.series.items.length) throw new Error('no such series');
  return splice(json, [arrayRemove(p.series, col)]);
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
    return { open: { start: t.start, end: t.end }, type: chart.value, title: title ? title.value : null, json };
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
