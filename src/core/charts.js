// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Charts — SPEC CHARTS. Theme-aware SVG charts generated from inline JSON:
// a chart IS a theme-aware diagram (SVG_DIAGRAMS), so every color is a diagram token
// (series i → --d-fill-i, axes --d-stroke, labels --d-text, grid --d-muted)
// and no chart library, image, or new theme token exists.
//
// Geometry is pure functions (node:test-able); only initCharts touches the
// DOM. The generated <svg> emits one <g> per series, so the BUILD_AUTHORING SVG-container
// build semantics and BUILD_ENTRANCES draw machinery apply with zero chart-specific code:
// initCharts moves the wrapper's authored data-build onto the <svg>, the
// chrome group (axes, grid, labels, legend) is data-build-stay, and prepareDraw
// finds the strokes on its own.
//
// Ink: the --d-fill panels sit deliberately close to the canvas (they are
// gated for --d-text ON them, never against --bg — most themes land at
// 1.1–1.2:1), so a fill-only bar or a fill-colored line is invisible in half
// the themes. Charts therefore use the hand-drawn-diagram box idiom: bars,
// slices and legend swatches are outlined with --d-stroke, and every line
// rides on a --d-stroke casing under its fill-colored core. Under
// data-build="draw" that ink is exactly what draws; fills, dots and labels
// carry .draw-fade so they materialize on the existing fade channel instead
// of appearing before their step.

import { escapeHtml as esc } from './escape.js';
import { parseChart } from '../../tools/chart-spec.mjs';

// Reading a chart's JSON is shared with the Data tab and `decklight check`
// (tools/chart-spec.mjs); this file draws what it returns.
export { parseChart };

// coordinate formatting: 2 decimals, no FP noise, no "-0"
const f = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

const fillVar = (i) => `var(--d-fill-${(i % 6) + 1})`;

/**
 * Nice linear ticks covering [lo, hi]: step from the {1, 2, 2.5, 5} × 10^k
 * ladder, bounds rounded outward onto the step grid. Returns
 * { min, max, step, ticks }.
 */
export function niceTicks(lo, hi, count = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error('niceTicks: non-finite range');
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) {
    const pad = lo === 0 ? 1 : Math.abs(lo) / 2;
    lo -= lo === 0 ? 0 : pad;
    hi += pad;
  }
  const step0 = (hi - lo) / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const min = Math.floor(lo / step + 1e-9) * step;
  const max = Math.ceil(hi / step - 1e-9) * step;
  const n = Math.max(1, Math.round((max - min) / step));
  const ticks = Array.from({ length: n + 1 }, (_, i) => +((min + i * step).toPrecision(12)));
  return { min: ticks[0], max: ticks[n], step, ticks };
}

// tick label with exactly the decimals the step needs ("2.5", never "3")
function tickLabel(v, step) {
  let dec = 0;
  while (dec < 6 && Math.abs(Math.round(step * 10 ** dec) - step * 10 ** dec) > 1e-9) dec++;
  return v.toFixed(dec);
}

/**
 * Grouped-bar geometry. series = [{data: [n|null, …]}], plot = {x, y, w, h},
 * y = {min, max}. Returns [seriesIdx][catIdx] → {x, y, w, h, value} | null.
 * Bars rise from the zero baseline (clamped into the scale), so negative
 * values hang below it.
 */
export function barRects(series, nCats, plot, y) {
  const span = y.max - y.min || 1;
  const yFor = (v) => plot.y + plot.h * (1 - (v - y.min) / span);
  const base = yFor(Math.max(y.min, Math.min(y.max, 0)));
  const band = plot.w / nCats;
  const group = band * 0.72;
  const bw = group / series.length;
  return series.map((s, si) =>
    Array.from({ length: nCats }, (_, ci) => {
      const v = s.data[ci];
      if (v == null || !Number.isFinite(v)) return null;
      const vy = yFor(v);
      return {
        x: plot.x + ci * band + (band - group) / 2 + si * bw + 1,
        y: Math.min(vy, base),
        w: Math.max(1, bw - 2),
        h: Math.abs(base - vy),
        value: v,
      };
    }));
}

/** Polyline path from [{x, y} | null] — a null is a gap (pen up). */
export function linePath(points) {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (!p) { pen = false; continue; }
    d += `${pen ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`;
    pen = true;
  }
  return d;
}

/** The runs of a point list between its gaps: [[p, p, …], …], each at least one point. */
function runs(points) {
  const out = [];
  let cur = null;
  for (const p of points) {
    if (!p) { cur = null; continue; }
    if (!cur) out.push(cur = []);
    cur.push(p);
  }
  return out;
}

/**
 * Closed area path: each run of the line between its gaps dropped to baseY
 * at both ends, a closed shape of its own, so a gap is a gap in the area too
 * and never a bridge across it (#1125).
 */
export function areaPath(points, baseY) {
  let d = '';
  for (const run of runs(points)) {
    d += `M${f(run[0].x)} ${f(baseY)}`;
    for (const p of run) d += `L${f(p.x)} ${f(p.y)}`;
    d += `L${f(run[run.length - 1].x)} ${f(baseY)}Z`;
  }
  return d;
}

/**
 * A band's area: along its high edge and back along its low, one closed shape
 * per run where both edges have a value. `high` and `low` are [{x, y} | null]
 * of one length. A run of one point has no width and draws nothing.
 */
export function bandPath(high, low) {
  const both = high.map((h, k) => (h && low[k] ? { h, l: low[k] } : null));
  let d = '';
  for (const run of runs(both)) {
    if (run.length < 2) continue;
    d += `M${f(run[0].h.x)} ${f(run[0].h.y)}`;
    for (const p of run.slice(1)) d += `L${f(p.h.x)} ${f(p.h.y)}`;
    for (const p of run.slice().reverse()) d += `L${f(p.l.x)} ${f(p.l.y)}`;
    d += 'Z';
  }
  return d;
}

/**
 * A line split where it turns dashed (`from`, an index into `points`): the
 * solid part up to that point and the dashed part from it, sharing it, so the
 * two meet with no seam. `from` null leaves it whole and solid.
 */
export function splitAt(points, from) {
  if (from == null) return { solid: points, dashed: [] };
  return { solid: points.slice(0, from + 1), dashed: points.map((p, k) => (k >= from ? p : null)) };
}

/**
 * Pie/donut slices from raw values (negatives clamp to 0; zero slices keep
 * their index with an empty path). Starts at 12 o'clock, clockwise. Returns
 * [{d, value, frac, mid, labelX, labelY, outX, outY, anchor}] — labelX/Y sit
 * inside the slice (value label), outX/Y outside it (name label).
 */
export function pieArcs(values, cx, cy, r, r0 = 0) {
  const vals = values.map((v) => Math.max(0, Number(v) || 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error('pie needs at least one positive value');
  const pt = (ang, rad) => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)];
  let a = -Math.PI / 2;
  return vals.map((v) => {
    const frac = v / total;
    const a0 = a;
    const a1 = a + frac * 2 * Math.PI;
    a = a1;
    const mid = (a0 + a1) / 2;
    const lr = r0 > 0 ? (r + r0) / 2 : r * 0.66;
    const [labelX, labelY] = pt(mid, lr);
    const [outX, outY] = pt(mid, r + 14);
    const base = {
      value: v, frac, mid, labelX, labelY, outX, outY,
      anchor: Math.cos(mid) < -1e-6 ? 'end' : Math.cos(mid) > 1e-6 ? 'start' : 'middle',
    };
    if (frac === 0) return { ...base, d: '' };
    let d;
    if (frac >= 0.9999) {
      // a full circle can't be one arc command: two half-arcs (+ donut hole
      // via evenodd — the renderer sets fill-rule on every slice)
      const [xa, ya] = pt(a0, r);
      const [xb, yb] = pt(a0 + Math.PI, r);
      d = `M${f(xa)} ${f(ya)}A${f(r)} ${f(r)} 0 1 1 ${f(xb)} ${f(yb)}A${f(r)} ${f(r)} 0 1 1 ${f(xa)} ${f(ya)}Z`;
      if (r0 > 0) {
        const [ia, ja] = pt(a0, r0);
        const [ib, jb] = pt(a0 + Math.PI, r0);
        d += `M${f(ia)} ${f(ja)}A${f(r0)} ${f(r0)} 0 1 0 ${f(ib)} ${f(jb)}A${f(r0)} ${f(r0)} 0 1 0 ${f(ia)} ${f(ja)}Z`;
      }
    } else {
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const [x0, y0] = pt(a0, r);
      const [x1, y1] = pt(a1, r);
      if (r0 > 0) {
        const [ix1, iy1] = pt(a1, r0);
        const [ix0, iy0] = pt(a0, r0);
        d = `M${f(x0)} ${f(y0)}A${f(r)} ${f(r)} 0 ${large} 1 ${f(x1)} ${f(y1)}` +
          `L${f(ix1)} ${f(iy1)}A${f(r0)} ${f(r0)} 0 ${large} 0 ${f(ix0)} ${f(iy0)}Z`;
      } else {
        d = `M${f(cx)} ${f(cy)}L${f(x0)} ${f(y0)}A${f(r)} ${f(r)} 0 ${large} 1 ${f(x1)} ${f(y1)}Z`;
      }
    }
    return { ...base, d };
  });
}

// --------------------------------------------------------------------------
// SVG assembly (pure string building — node:test renders charts headlessly)

const TEXT = 'fill="var(--d-text)"';

function seriesOpen(s, si) {
  return `<g class="chart-series" data-series="${si + 1}" data-name="${esc(s.name)}"` +
    (s.concept ? ` data-concept="${esc(s.concept)}"` : '') + '>';
}

// non-stroke series content carries .draw-fade, so under data-build="draw" it
// fades in on the existing draw CSS channel instead of appearing instantly
function axisChart(spec, chrome, out, over) {
  // the value axis covers every number drawn: the values, the bands, the threshold
  const vals = spec.series.flatMap((s) => [...s.data, ...(s.band && spec.type !== 'bar' ? [...s.band.low, ...s.band.high] : [])])
    .concat(spec.threshold ? [spec.threshold.y] : [])
    .filter((v) => v != null);
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const y = niceTicks(lo, hi === lo ? lo + 1 : hi, 5);
  const tickStrs = y.ticks.map((t) => tickLabel(t, y.step));
  const left = 14 + Math.max(...tickStrs.map((s) => s.length)) * 6.6 + 8;
  const plot = {
    x: left,
    y: spec.title || legendOn(spec) ? 40 : 18,
    w: spec.width - left - 14,
    h: 0,
  };
  plot.h = spec.height - plot.y - 34;
  const span = y.max - y.min || 1;
  const yFor = (v) => plot.y + plot.h * (1 - (v - y.min) / span);

  // grid + tick labels + axes
  y.ticks.forEach((t, i) => {
    const ty = yFor(t);
    chrome.push(`<line class="chart-grid" x1="${f(plot.x)}" y1="${f(ty)}" x2="${f(plot.x + plot.w)}" y2="${f(ty)}" stroke="var(--d-muted)" stroke-opacity="0.35" stroke-width="1"/>`);
    chrome.push(`<text class="chart-tick" x="${f(plot.x - 8)}" y="${f(ty + 4)}" text-anchor="end" font-size="11" ${TEXT}>${esc(tickStrs[i])}</text>`);
  });
  chrome.push(`<line class="chart-axis" x1="${f(plot.x)}" y1="${f(plot.y)}" x2="${f(plot.x)}" y2="${f(plot.y + plot.h)}" stroke="var(--d-stroke)" stroke-width="1.5"/>`);
  const baseY = yFor(Math.max(y.min, Math.min(y.max, 0)));
  chrome.push(`<line class="chart-axis" x1="${f(plot.x)}" y1="${f(baseY)}" x2="${f(plot.x + plot.w)}" y2="${f(baseY)}" stroke="var(--d-stroke)" stroke-width="1.5"/>`);

  const band = plot.w / spec.labels.length;
  spec.labels.forEach((lab, ci) => {
    chrome.push(`<text class="chart-cat" x="${f(plot.x + (ci + 0.5) * band)}" y="${f(plot.y + plot.h + 20)}" text-anchor="middle" font-size="12" ${TEXT}>${esc(lab)}</text>`);
  });
  rules(spec, plot, yFor, band, chrome, over);

  if (spec.type === 'bar') {
    const rects = barRects(spec.series, spec.labels.length, plot, y);
    spec.series.forEach((s, si) => {
      out.push(seriesOpen(s, si));
      rects[si].forEach((r) => {
        if (!r) return;
        out.push(`<rect class="chart-bar draw-fade" x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" rx="2" fill="${fillVar(si)}" stroke="var(--d-stroke)" stroke-width="1.5"/>`);
      });
      out.push('</g>');
    });
  } else {
    // line / area: points at category band centers. The casing sits in a
    // nested <g> so concept pinning (direct-child shapes only) recolors the
    // core stroke and the dot fills, never the --d-stroke ink under them.
    const at = (v, ci) => (v == null ? null : { x: plot.x + (ci + 0.5) * band, y: yFor(v) });
    const joins = 'stroke-linejoin="round" stroke-linecap="round"';
    spec.series.forEach((s, si) => {
      const pts = s.data.map(at);
      out.push(seriesOpen(s, si));
      // the band first, under everything of its series: the range in the
      // series' fill slot, translucent so the grid reads through it, its two
      // edges in faint ink one group down (concepts repaint the fill, not them)
      if (s.band) {
        const hi = s.band.high.map(at), lo = s.band.low.map(at);
        const d = bandPath(hi, lo);
        if (d) {
          out.push(`<path class="chart-band draw-fade" d="${d}" fill="${fillVar(si)}" fill-opacity="${s.kind === 'band' ? 0.6 : 0.45}"/>`);
          out.push(`<g class="chart-band-edge">${[hi, lo].map((e) => `<path d="${linePath(e)}" fill="none" stroke="var(--d-stroke)" stroke-opacity="0.4" stroke-width="1" ${joins}/>`).join('')}</g>`);
        }
      }
      if (s.kind === 'band') { out.push('</g>'); return; }
      if (spec.type === 'area') {
        out.push(`<path class="chart-area draw-fade" d="${areaPath(pts, baseY)}" fill="${fillVar(si)}" fill-opacity="0.35"/>`);
      }
      // solid up to dashFrom, dashed after it: two strokes, each on its casing,
      // the dashed one drawn by the draw build through its mask as a dashed wire is
      const { solid, dashed } = splitAt(pts, s.dashFrom);
      // (a part that is only lone points draws no stroke: it is left out once the line is split)
      const parts = [[linePath(solid), ''], [linePath(dashed), ` stroke-dasharray="${DASH}"`]]
        .filter(([d]) => d && (s.dashFrom == null || /L/.test(d)));
      out.push(`<g class="chart-casing">${parts.map(([d, dash]) => `<path d="${d}" fill="none" stroke="var(--d-stroke)" stroke-width="4.5" ${joins}${dash}/>`).join('')}</g>`);
      for (const [d, dash] of parts) {
        out.push(`<path class="chart-line${dash ? ' chart-dashed' : ''}" d="${d}" fill="none" stroke="${fillVar(si)}" stroke-width="2.5" ${joins}${dash}/>`);
      }
      if (spec.type === 'line') {
        for (const p of pts) {
          if (p) out.push(`<circle class="chart-dot draw-fade" cx="${f(p.x)}" cy="${f(p.y)}" r="4" fill="${fillVar(si)}" stroke="var(--d-stroke)" stroke-width="1"/>`);
        }
      }
      // a marker: the point made larger, ringed, and its words beside it
      for (const m of s.markers) {
        const p = pts[m.at];
        if (!p) continue;
        out.push(`<g class="chart-marker-ring"><circle class="draw-fade" cx="${f(p.x)}" cy="${f(p.y)}" r="11" fill="none" stroke="var(--d-stroke)" stroke-width="1.5"/></g>`);
        out.push(`<circle class="chart-marker draw-fade" cx="${f(p.x)}" cy="${f(p.y)}" r="6.5" fill="${fillVar(si)}" stroke="var(--d-stroke)" stroke-width="2.5"/>`);
        if (m.label) {
          const t = markerLabelAt(pts, m.at, plot, m.label.length * 6.8);
          out.push(`<text class="chart-marker-label draw-fade" x="${f(t.x)}" y="${f(t.y)}" text-anchor="${t.anchor}" font-size="12" font-weight="600" ${TEXT} ${HALO}>${esc(m.label)}</text>`);
        }
      }
      out.push('</g>');
    });
  }
}

/** The dashes of a series' dashed part: long enough to read as a line, gapped enough to read as not one. */
const DASH = '9 7';

/**
 * Words laid over a chart's ink (a rule's, a marker's) sit on a thin halo of
 * the slide's own ground, so a line or a band passing under them never cuts
 * a letter. A ground the halo cannot be (a gradient) leaves the words bare.
 */
const HALO = 'stroke="var(--bg)" stroke-width="4" stroke-linejoin="round" paint-order="stroke"';

/**
 * Where a marker's words go, `{ x, y, anchor }`, so its own line does not run
 * through them: over a peak, under a dip, and beside a point on a slope, on
 * the side the line leaves free (below a rise to the right, above a fall),
 * mirrored to the left near the plot's right edge, and kept inside the plot.
 * `w` is the words' rough width.
 */
function markerLabelAt(pts, k, plot, w) {
  const p = pts[k];
  const ys = [pts[k - 1], pts[k + 1]].filter(Boolean).map((q) => q.y);
  const peak = ys.length && ys.every((y) => y > p.y);
  const dip = ys.length && ys.every((y) => y < p.y);
  const centred = () => {
    if (p.x - w / 2 < plot.x + 2) return { x: plot.x + 2, anchor: 'start' };
    if (p.x + w / 2 > plot.x + plot.w - 2) return { x: plot.x + plot.w - 2, anchor: 'end' };
    return { x: p.x, anchor: 'middle' };
  };
  if ((peak || !ys.length) && p.y - 20 > plot.y + 4) return { ...centred(), y: p.y - 18 };
  if (dip && p.y + 30 < plot.y + plot.h) return { ...centred(), y: p.y + 28 };
  const left = p.x + 16 + w > plot.x + plot.w;
  const next = pts[k + 1] ?? null, prev = pts[k - 1] ?? null;
  // which way the line runs on the side the words go: rising there frees the space below
  const rising = left ? (prev ? prev.y > p.y : false) : (next ? next.y < p.y : prev ? prev.y > p.y : false);
  const y = peak || dip ? p.y + 4 : left === rising ? p.y - 10 : p.y + 18;
  return { x: left ? p.x - 16 : p.x + 16, y: Math.max(plot.y + 12, Math.min(plot.y + plot.h - 4, y)), anchor: left ? 'end' : 'start' };
}

/**
 * The chart's own rules (they stand for the whole build): a horizontal
 * `threshold`, its words on it at the left where a line has usually not yet
 * reached it, and a vertical `now`, its word at the top. Ink, not a series
 * colour: --d-stroke for the rule, --d-text for the words, as the axes are.
 * The rules go in the chrome, under the series; their words in `over`, a
 * layer above them, so a band or a line never covers them.
 */
function rules(spec, plot, yFor, band, chrome, over) {
  if (spec.threshold) {
    const ty = yFor(spec.threshold.y);
    chrome.push(`<line class="chart-threshold" x1="${f(plot.x)}" y1="${f(ty)}" x2="${f(plot.x + plot.w)}" y2="${f(ty)}" stroke="var(--d-stroke)" stroke-width="1.5" stroke-dasharray="2 5" stroke-linecap="round"/>`);
    if (spec.threshold.label) {
      const above = ty - 16 > plot.y;
      over.push(`<text class="chart-rule-label" x="${f(plot.x + 6)}" y="${f(above ? ty - 6 : ty + 15)}" text-anchor="start" font-size="11" font-weight="600" ${TEXT} ${HALO}>${esc(spec.threshold.label)}</text>`);
    }
  }
  if (spec.now) {
    const nx = plot.x + (spec.now.at + 0.5) * band;
    chrome.push(`<line class="chart-now" x1="${f(nx)}" y1="${f(plot.y)}" x2="${f(nx)}" y2="${f(plot.y + plot.h)}" stroke="var(--d-stroke)" stroke-width="1.5" stroke-dasharray="2 5" stroke-linecap="round"/>`);
    if (spec.now.label) {
      const right = nx + 6 + spec.now.label.length * 6.6 < plot.x + plot.w;
      over.push(`<text class="chart-rule-label" x="${f(right ? nx + 6 : nx - 6)}" y="${f(plot.y + 11)}" text-anchor="${right ? 'start' : 'end'}" font-size="11" font-weight="600" ${TEXT} ${HALO}>${esc(spec.now.label)}</text>`);
    }
  }
}

/**
 * A scatter: two numeric axes, a dot per pair.
 *
 * It shares the grid, the ticks and the ink of `axisChart` but not its
 * geometry — there is no band, because there are no categories: x is a
 * measurement, and the whole point of the chart is where a dot lands between
 * two of them.
 */
function scatterChart(spec, chrome, out) {
  const xs = spec.series.flatMap((sr) => sr.points.map(([x]) => x));
  const ys = spec.series.flatMap((sr) => sr.points.map(([, y]) => y));
  const x = niceTicks(Math.min(...xs), Math.max(...xs) === Math.min(...xs) ? Math.min(...xs) + 1 : Math.max(...xs), 5);
  const y = niceTicks(Math.min(0, ...ys), Math.max(...ys) === Math.min(0, ...ys) ? Math.max(...ys) + 1 : Math.max(...ys), 5);
  const yStrs = y.ticks.map((t) => tickLabel(t, y.step));
  const xStrs = x.ticks.map((t) => tickLabel(t, x.step));

  const left = 14 + Math.max(...yStrs.map((t) => t.length)) * 6.6 + 8 + (spec.yTitle ? 16 : 0);
  const bottom = 34 + (spec.xTitle ? 18 : 0);
  const plot = { x: left, y: spec.title || legendOn(spec) ? 40 : 18, w: spec.width - left - 18, h: 0 };
  plot.h = spec.height - plot.y - bottom;
  const xSpan = x.max - x.min || 1;
  const ySpan = y.max - y.min || 1;
  const xFor = (v) => plot.x + plot.w * ((v - x.min) / xSpan);
  const yFor = (v) => plot.y + plot.h * (1 - (v - y.min) / ySpan);

  y.ticks.forEach((t, i) => {
    const ty = yFor(t);
    chrome.push(`<line class="chart-grid" x1="${f(plot.x)}" y1="${f(ty)}" x2="${f(plot.x + plot.w)}" y2="${f(ty)}" stroke="var(--d-muted)" stroke-opacity="0.35" stroke-width="1"/>`);
    chrome.push(`<text class="chart-tick" x="${f(plot.x - 8)}" y="${f(ty + 4)}" text-anchor="end" font-size="11" ${TEXT}>${esc(yStrs[i])}</text>`);
  });
  x.ticks.forEach((t, i) => {
    const tx = xFor(t);
    chrome.push(`<line class="chart-grid" x1="${f(tx)}" y1="${f(plot.y)}" x2="${f(tx)}" y2="${f(plot.y + plot.h)}" stroke="var(--d-muted)" stroke-opacity="0.35" stroke-width="1"/>`);
    chrome.push(`<text class="chart-cat" x="${f(tx)}" y="${f(plot.y + plot.h + 20)}" text-anchor="middle" font-size="12" ${TEXT}>${esc(xStrs[i])}</text>`);
  });
  chrome.push(`<line class="chart-axis" x1="${f(plot.x)}" y1="${f(plot.y)}" x2="${f(plot.x)}" y2="${f(plot.y + plot.h)}" stroke="var(--d-stroke)" stroke-width="1.5"/>`);
  chrome.push(`<line class="chart-axis" x1="${f(plot.x)}" y1="${f(plot.y + plot.h)}" x2="${f(plot.x + plot.w)}" y2="${f(plot.y + plot.h)}" stroke="var(--d-stroke)" stroke-width="1.5"/>`);
  if (spec.xTitle) {
    chrome.push(`<text class="chart-axis-title" x="${f(plot.x + plot.w / 2)}" y="${f(spec.height - 8)}" text-anchor="middle" font-size="12" ${TEXT}>${esc(spec.xTitle)}</text>`);
  }
  if (spec.yTitle) {
    // rotated about its own middle, so the label reads bottom-to-top beside the axis
    const cx = 16, cy = plot.y + plot.h / 2;
    chrome.push(`<text class="chart-axis-title" x="${f(cx)}" y="${f(cy)}" text-anchor="middle" font-size="12" ${TEXT} transform="rotate(-90 ${f(cx)} ${f(cy)})">${esc(spec.yTitle)}</text>`);
  }

  spec.series.forEach((sr, si) => {
    out.push(seriesOpen(sr, si));
    for (const [px, py] of sr.points) {
      out.push(`<circle class="chart-dot draw-fade" cx="${f(xFor(px))}" cy="${f(yFor(py))}" r="5" fill="${fillVar(si)}" stroke="var(--d-stroke)" stroke-width="1.5"/>`);
    }
    out.push('</g>');
  });
}

function pieChart(spec, out) {
  const top = spec.title ? 40 : 16;
  const cx = spec.width / 2;
  const cy = top + (spec.height - top - 12) / 2;
  const r = Math.max(24, Math.min((spec.height - top - 12) / 2 - 26, spec.width / 2 - 110));
  const arcs = pieArcs(spec.series[0].data.map((v) => v ?? 0), cx, cy, r, spec.donut ? r * 0.55 : 0);
  out.push(seriesOpen(spec.series[0], 0));
  arcs.forEach((a, i) => {
    if (!a.d) return;
    out.push(`<path class="chart-slice draw-fade" d="${a.d}" fill="${fillVar(i)}" fill-rule="evenodd" stroke="var(--d-stroke)" stroke-width="1.5" stroke-linejoin="round"/>`);
    out.push(`<text class="chart-cat draw-fade" x="${f(a.outX)}" y="${f(a.outY + 4)}" text-anchor="${a.anchor}" font-size="12" ${TEXT}>${esc(spec.labels[i])}</text>`);
    if (a.frac >= 0.05) {
      // the value label sits ON the slice fill — --d-text clears every
      // --d-fill by the THEMING contrast gate, so this is readable in any theme
      out.push(`<text class="chart-value draw-fade" x="${f(a.labelX)}" y="${f(a.labelY + 4)}" text-anchor="middle" font-size="12" font-weight="600" ${TEXT}>${Math.round(a.frac * 100)}%</text>`);
    }
  });
  out.push('</g>');
}

function legendOn(spec) {
  if (spec.legend === true) return true;
  if (spec.legend === false) return false;
  return spec.type !== 'pie' && spec.series.length > 1;
}

/** Full chart → SVG markup (pure). One <g class="chart-series"> per series. */
export function chartSvg(spec) {
  const chrome = [];
  const out = [];
  const over = []; // words over the series: a rule's (they stand for the whole build, as the chrome does)

  if (spec.title) {
    chrome.push(`<text class="chart-title" x="14" y="24" font-size="15" font-weight="600" ${TEXT}>${esc(spec.title)}</text>`);
  }
  if (legendOn(spec)) {
    const items = spec.series.map((s) => ({ name: s.name, w: s.name.length * 6.6 + 24 }));
    let lx = spec.width - 14 - items.reduce((a, i) => a + i.w, 0);
    spec.series.forEach((s, si) => {
      chrome.push(`<rect class="chart-swatch" x="${f(lx)}" y="14" width="11" height="11" rx="2" fill="${fillVar(si)}" stroke="var(--d-stroke)" stroke-width="1"/>`);
      chrome.push(`<text class="chart-legend" x="${f(lx + 16)}" y="24" font-size="12" ${TEXT}>${esc(s.name)}</text>`);
      lx += items[si].w;
    });
  }

  if (spec.type === 'pie') pieChart(spec, out);
  else if (spec.type === 'scatter') scatterChart(spec, chrome, out);
  else axisChart(spec, chrome, out, over);

  const label = spec.title ? `${spec.title} — ${spec.type} chart` : `${spec.type} chart`;
  return `<svg class="chart-svg" viewBox="0 0 ${spec.width} ${spec.height}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">` +
    `<g class="chart-chrome" data-build-stay>${chrome.join('')}</g>` +
    out.join('') +
    (over.length ? `<g class="chart-over" data-build-stay>${over.join('')}</g>` : '') +
    '</svg>';
}

// --------------------------------------------------------------------------
// DOM application (browser only)

/**
 * Expand every chart declaration under `root`, synchronously, in place.
 * Runs in the init pipeline ahead of namespaceSvgIds and the build scan, so
 * the generated SVG is id-namespaced (it emits none, but the invariant holds)
 * and build-scanned like any hand-drawn diagram. Invalid input renders a visible
 * .chart-broken box — never a blank slide, never a thrown error.
 */
export function initCharts(root) {
  root.querySelectorAll('[data-chart]').forEach((el) => {
    if (el.querySelector(':scope > svg.chart-svg, :scope > .chart-broken')) return; // idempotent
    drawChart(el);
  });
}

// the data-build each wrapper authored, kept when it moves onto the <svg>, so
// a chart drawn again (renderChart) moves it again, and a build its JSON
// carried (the fence form's) is never mistaken for one the wrapper had
const authoredBuild = new WeakMap();

/**
 * Draw ONE chart again from what its element says now: its JSON, its
 * data-chart and data-title. The inspector's Data tab calls this on every
 * edit (chartgrid.js), so the slide shows the number as it is typed; the
 * caller rescans the slide's builds after, as init's pipeline does.
 */
export function renderChart(el) {
  el.querySelectorAll(':scope > svg.chart-svg, :scope > .chart-broken').forEach((n) => n.remove());
  if (authoredBuild.has(el) && !el.hasAttribute('data-build')) el.setAttribute('data-build', authoredBuild.get(el));
  drawChart(el);
}

function drawChart(el) {
  el.classList.add('chart');
  const dataEl = el.querySelector('script[type="application/json"]');
  try {
    const spec = parseChart(dataEl ? dataEl.textContent : null, {
      type: el.getAttribute('data-chart') || undefined,
      title: el.getAttribute('data-title') || undefined,
      aspect: el.getAttribute('data-aspect') || undefined,
    });
    const tpl = document.createElement('template');
    tpl.innerHTML = chartSvg(spec);
    const svg = tpl.content.firstElementChild;
    // builds without a build provider: the authored data-build moves onto
    // the generated <svg>, whose direct-child series groups are exactly the
    // BUILD_AUTHORING SVG-container steps (the chrome group is data-build-stay)
    if (el.hasAttribute('data-build')) {
      authoredBuild.set(el, el.getAttribute('data-build'));
      svg.setAttribute('data-build', el.getAttribute('data-build'));
      el.removeAttribute('data-build');
    } else if (spec.build != null && spec.build !== false) {
      svg.setAttribute('data-build', spec.build === true ? '' : String(spec.build));
    }
    if (!el.getAttribute('data-chart')) {
      el.setAttribute('data-chart', spec.donut ? 'donut' : spec.type);
    }
    el.insertBefore(svg, dataEl);
  } catch (err) {
    const box = document.createElement('div');
    box.className = 'chart-broken';
    box.textContent = `chart: ${err.message || err}`;
    el.insertBefore(box, dataEl);
  }
}
