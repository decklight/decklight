// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A chart's JSON, read (SPEC CHARTS): what `data-chart` declares, normalized
// and checked, with no DOM and no drawing. Pure and shared, so the runtime
// (src/core/charts.js, which draws what this returns), the Data tab
// (src/core/chartdata.js) and `decklight check` (cli/check.mjs, which reports
// what this refuses and what it notes) hold one reading of a chart.

const VB_W = 640;
const VB_H = 360;
export const CHART_TYPES = ['bar', 'line', 'area', 'pie', 'donut', 'scatter'];
/** The one type whose data is x/y pairs rather than a value per category. */
const isXY = (type) => type === 'scatter';
/** The types a series can dash, carry a band or mark a point on: a value per label, joined by a line. */
const isLine = (type) => type === 'line' || type === 'area';

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

/**
 * One value of a series, as the chart plots it: a finite JSON number, or a
 * string `cellNumber` reads as one; anything else (`null`, `''`, a boolean,
 * a list, an object, a word) is a gap, `null`, never a zero (#1125).
 */
export function chartValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const n = cellNumber(v); return n.ok ? n.value : null; }
  return null;
}

/**
 * The row a reference names (`dashFrom`, `now`, a marker's `at`): a label,
 * as written, or else a position counted from 0. -1 when it names neither.
 * The label wins, so a chart over the years 2023…2026 says `"now": 2025`.
 */
export function resolveAt(labels, at) {
  if (typeof at !== 'string' && typeof at !== 'number') return -1;
  const byLabel = labels.indexOf(String(at));
  if (byLabel !== -1) return byLabel;
  if (typeof at === 'number' && Number.isInteger(at) && at >= 0 && at < labels.length) return at;
  return -1;
}
/** How a reference reads in a sentence. */
const said = (at) => (typeof at === 'string' ? `"${at}"` : String(at));

/**
 * Normalize and validate a chart declaration. `source` is the JSON text (or
 * an already-parsed object); `attrs` carries the wrapper's data-* attributes,
 * which win over the same keys in the JSON (the fence form has no attribute
 * surface, so the JSON may carry type/title/aspect/build itself).
 * Throws with a message meant to be READ: it lands in the error box, and
 * `decklight check` says it. What is drawn without being refused (a band
 * shorter than the labels, a `now` that names no label) is said in `notes`,
 * which only `check` reads.
 */
export function parseChart(source, attrs = {}) {
  let json;
  if (typeof source === 'string') {
    try { json = JSON.parse(source); } catch (e) {
      throw new Error(`invalid JSON — ${e.message}`);
    }
  } else if (source && typeof source === 'object') {
    json = source;
  } else {
    throw new Error('no data — expected a <script type="application/json"> child (or the fence body)');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('the JSON must be an object');

  const type = String(attrs.type || json.type || '').toLowerCase();
  if (!CHART_TYPES.includes(type)) {
    throw new Error(`unknown type "${type}" — use ${CHART_TYPES.join(' | ')}`);
  }
  const notes = [];

  // A scatter has no categories: its x is a number, not a label, which is the
  // whole difference between "sales by region" and "latency against load".
  if (!isXY(type) && (!Array.isArray(json.labels) || json.labels.length === 0)) {
    throw new Error('"labels" must be a non-empty array');
  }
  if (!Array.isArray(json.series) || json.series.length === 0) {
    throw new Error('"series" must be a non-empty array');
  }
  const labels = isXY(type) ? [] : json.labels.map(String);
  // pad/trim to the label count; a value that is not a number is a gap
  const row = (list) => labels.map((_, k) => chartValue(list[k]));
  const series = json.series.map((s, i) => {
    const name = s && s.name != null ? String(s.name) : `series ${i + 1}`;
    const concept = s && s.concept != null ? String(s.concept) : null;
    if (isXY(type)) {
      if (!s || !Array.isArray(s.points)) {
        throw new Error(`series ${i + 1}: "points" must be an array of [x, y] pairs`);
      }
      const points = s.points
        .map((pt) => (Array.isArray(pt) ? [chartValue(pt[0]), chartValue(pt[1])] : [null, null]))
        .filter(([x, y]) => x != null && y != null);
      if (!points.length) throw new Error(`series ${i + 1}: no usable [x, y] pairs`);
      if (s.band !== undefined || s.dashFrom !== undefined || s.markers !== undefined) {
        notes.push(`series ${i + 1}: a scatter draws no band, dashes or markers — only a line or area chart does`);
      }
      return { name, concept, kind: 'line', points, data: points.map(([, y]) => y), band: null, dashFrom: null, markers: [] };
    }
    if (!s || typeof s !== 'object') throw new Error(`series ${i + 1}: must be an object with "data"`);
    // a series is a line (its values, the default) or a band (a range, no line)
    const kind = s.type == null ? 'line' : String(s.type).toLowerCase();
    if (kind !== 'line' && kind !== 'band') {
      throw new Error(`series ${i + 1}: "type" is "band" (a range drawn as an area) or left out`);
    }
    if (kind === 'band' && !isLine(type)) {
      throw new Error(`series ${i + 1} is a band: a band needs a line or area chart`);
    }
    if (kind === 'line' && !Array.isArray(s.data)) {
      throw new Error(`series ${i + 1}: "data" must be an array of numbers`);
    }

    // a band: the range round a series, or the whole of a band series
    let band = null;
    if (s.band != null) {
      const b = s.band;
      if (typeof b !== 'object' || Array.isArray(b) || !Array.isArray(b.low) || !Array.isArray(b.high)) {
        throw new Error(`series ${i + 1}: "band" must be { "low": […], "high": […] }`);
      }
      for (const edge of ['low', 'high']) {
        if (b[edge].length !== labels.length) {
          notes.push(`series ${i + 1}: its band's "${edge}" has ${b[edge].length} value${b[edge].length === 1 ? '' : 's'} for ${labels.length} label${labels.length === 1 ? '' : 's'} — ${b[edge].length < labels.length ? 'the rest is a gap' : 'the extra values are not drawn'}`);
        }
      }
      band = { low: row(b.low), high: row(b.high) };
      const crossed = labels.findIndex((_, k) => band.low[k] != null && band.high[k] != null && band.low[k] > band.high[k]);
      if (crossed !== -1) notes.push(`series ${i + 1}: its band's low is above its high at "${labels[crossed]}"`);
      if (!isLine(type)) notes.push(`series ${i + 1}: a ${type} chart draws no band — only a line or area chart does`);
    } else if (kind === 'band') {
      throw new Error(`series ${i + 1} is a band: it needs "band": { "low": […], "high": […] }`);
    }
    const data = kind === 'band' ? labels.map(() => null) : row(s.data);

    // where the line turns dashed: solid up to that point, dashed after it
    let dashFrom = null;
    if (s.dashFrom != null) {
      if (typeof s.dashFrom !== 'string' && typeof s.dashFrom !== 'number') {
        throw new Error(`series ${i + 1}: "dashFrom" is a label or a position`);
      }
      const k = resolveAt(labels, s.dashFrom);
      if (k === -1) notes.push(`series ${i + 1}: "dashFrom": ${said(s.dashFrom)} names no label (nor a position from 0): the line is drawn solid`);
      else if (!isLine(type) || kind === 'band') notes.push(`series ${i + 1}: "dashFrom" dashes a line, and ${kind === 'band' ? 'a band series has none' : `a ${type} chart draws none`}`);
      else dashFrom = k;
    }

    // emphasised points, each with its words
    const markers = [];
    if (s.markers != null) {
      if (!Array.isArray(s.markers)) throw new Error(`series ${i + 1}: "markers" must be a list of { "at": …, "label": … }`);
      s.markers.forEach((m, j) => {
        if (!m || typeof m !== 'object' || Array.isArray(m) || (typeof m.at !== 'string' && typeof m.at !== 'number')) {
          throw new Error(`series ${i + 1}: marker ${j + 1} must be { "at": <label or position>, "label": "…" }`);
        }
        const k = resolveAt(labels, m.at);
        if (k === -1) { notes.push(`series ${i + 1}: marker ${j + 1} is at ${said(m.at)}, which names no label (nor a position from 0): it is not drawn`); return; }
        if (!isLine(type)) { notes.push(`series ${i + 1}: a ${type} chart draws no markers — only a line or area chart does`); return; }
        if (data[k] == null) { notes.push(`series ${i + 1}: marker ${j + 1} is at "${labels[k]}", where the series has no value: it is not drawn`); return; }
        markers.push({ at: k, label: m.label != null ? String(m.label) : '' });
      });
    }
    return { name, concept, kind, data, band, dashFrom, markers };
  });

  const isPie = type === 'pie' || type === 'donut';
  if (isPie && series.length > 1) {
    throw new Error('pie takes exactly one series (labels are the slices)');
  }
  if (isPie && !series[0].data.some((v) => v > 0)) {
    throw new Error('pie needs at least one positive value');
  }

  let height = VB_H;
  const aspect = attrs.aspect ?? json.aspect ?? null;
  if (aspect != null) {
    const m = String(aspect).match(/^\s*(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)\s*$/i);
    if (!m || +m[1] === 0 || +m[2] === 0) throw new Error(`bad aspect "${aspect}" — use "w:h", e.g. "4:3"`);
    height = Math.round((VB_W * +m[2]) / +m[1]);
  }

  // the chart's own rules: a level to read the line against, and the moment it is now
  const axes = !isPie && !isXY(type);
  let threshold = null;
  if (json.threshold != null) {
    const t = json.threshold;
    const y = t && typeof t === 'object' && !Array.isArray(t) ? chartValue(t.y) : null;
    if (y == null) throw new Error('"threshold" must be { "y": <number>, "label": "…" }');
    if (axes) threshold = { y, label: t.label != null ? String(t.label) : '' };
    else notes.push(`"threshold": a ${type} chart has no value axis to draw it on`);
  }
  let now = null;
  if (json.now != null) {
    // a label or a position, or { "at": …, "label": "today" } for words of its own
    const n = json.now;
    const obj = typeof n === 'object' && !Array.isArray(n);
    const at = obj ? n.at : n;
    if (typeof at !== 'string' && typeof at !== 'number') throw new Error('"now" is a label or a position (or { "at": …, "label": "…" })');
    const k = resolveAt(labels, at);
    if (!axes) notes.push(`"now": a ${type} chart has no category axis to draw it on`);
    else if (k === -1) notes.push(`"now": ${said(at)} names no label (nor a position from 0): it is not drawn`);
    else now = { at: k, label: obj && n.label != null ? String(n.label) : 'now' };
  }

  return {
    type: isPie ? 'pie' : type,
    donut: type === 'donut' || json.donut === true,
    title: attrs.title ?? (json.title != null ? String(json.title) : null),
    // What the two axes MEAN. Only a scatter asks for them: a category chart's
    // x axis is already labelled, one value at a time.
    xTitle: json.x != null ? String(json.x) : null,
    yTitle: json.y != null ? String(json.y) : null,
    labels,
    series,
    threshold,
    now,
    legend: json.legend, // true forces, false suppresses, undefined = auto
    width: VB_W,
    height,
    build: json.build, // fence form only; the div form authors data-build
    notes,
  };
}
