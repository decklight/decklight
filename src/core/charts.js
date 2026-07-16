// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Charts — SPEC §3.1. Theme-aware SVG charts generated from inline JSON:
// a chart IS a theme-aware diagram (§3), so every color is a diagram token
// (series i → --d-fill-i, axes --d-stroke, labels --d-text, grid --d-muted)
// and no chart library, image, or new theme token exists.
//
// Geometry is pure functions (node:test-able); only initCharts touches the
// DOM. The generated <svg> emits one <g> per series, so the §2.1 SVG-container
// build semantics and §2.3 draw machinery apply with zero chart-specific code:
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

const VB_W = 640;
const VB_H = 360;
const TYPES = ['bar', 'line', 'area', 'pie', 'donut'];

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// coordinate formatting: 2 decimals, no FP noise, no "-0"
const f = (n) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

const fillVar = (i) => `var(--d-fill-${(i % 6) + 1})`;

/**
 * Normalize and validate a chart declaration. `source` is the JSON text (or
 * an already-parsed object); `attrs` carries the wrapper's data-* attributes,
 * which win over the same keys in the JSON (the fence form has no attribute
 * surface, so the JSON may carry type/title/aspect/build itself).
 * Throws with a message meant to be READ — it lands in the error box.
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

  const type = String(attrs.type || json.type || '').toLowerCase();
  if (!TYPES.includes(type)) {
    throw new Error(`unknown type "${type}" — use ${TYPES.join(' | ')}`);
  }

  if (!Array.isArray(json.labels) || json.labels.length === 0) {
    throw new Error('"labels" must be a non-empty array');
  }
  if (!Array.isArray(json.series) || json.series.length === 0) {
    throw new Error('"series" must be a non-empty array');
  }
  const labels = json.labels.map(String);
  const series = json.series.map((s, i) => {
    if (!s || !Array.isArray(s.data)) {
      throw new Error(`series ${i + 1}: "data" must be an array of numbers`);
    }
    return {
      name: s.name != null ? String(s.name) : `series ${i + 1}`,
      concept: s.concept != null ? String(s.concept) : null,
      // pad/trim to the label count; non-numbers become gaps, not NaN geometry
      data: labels.map((_, k) => {
        const v = Number(s.data[k]);
        return Number.isFinite(v) ? v : null;
      }),
    };
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
    if (!m || +m[1] === 0) throw new Error(`bad aspect "${aspect}" — use "w:h", e.g. "4:3"`);
    height = Math.round((VB_W * +m[2]) / +m[1]);
  }

  return {
    type: isPie ? 'pie' : type,
    donut: type === 'donut' || json.donut === true,
    title: attrs.title ?? (json.title != null ? String(json.title) : null),
    labels,
    series,
    legend: json.legend, // true forces, false suppresses, undefined = auto
    width: VB_W,
    height,
    build: json.build, // fence form only; the div form authors data-build
  };
}

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

/** Closed area path: the line, dropped to baseY at both ends (gaps skipped). */
export function areaPath(points, baseY) {
  const pts = points.filter(Boolean);
  if (!pts.length) return '';
  let d = `M${f(pts[0].x)} ${f(baseY)}`;
  for (const p of pts) d += `L${f(p.x)} ${f(p.y)}`;
  d += `L${f(pts[pts.length - 1].x)} ${f(baseY)}Z`;
  return d;
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
function axisChart(spec, chrome, out) {
  const vals = spec.series.flatMap((s) => s.data).filter((v) => v != null);
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
    spec.series.forEach((s, si) => {
      const pts = s.data.map((v, ci) =>
        v == null ? null : { x: plot.x + (ci + 0.5) * band, y: yFor(v) });
      const d = linePath(pts);
      const joins = 'stroke-linejoin="round" stroke-linecap="round"';
      out.push(seriesOpen(s, si));
      if (spec.type === 'area') {
        out.push(`<path class="chart-area draw-fade" d="${areaPath(pts, baseY)}" fill="${fillVar(si)}" fill-opacity="0.35"/>`);
      }
      out.push(`<g class="chart-casing"><path d="${d}" fill="none" stroke="var(--d-stroke)" stroke-width="4.5" ${joins}/></g>`);
      out.push(`<path class="chart-line" d="${d}" fill="none" stroke="${fillVar(si)}" stroke-width="2.5" ${joins}/>`);
      if (spec.type === 'line') {
        for (const p of pts) {
          if (p) out.push(`<circle class="chart-dot draw-fade" cx="${f(p.x)}" cy="${f(p.y)}" r="4" fill="${fillVar(si)}" stroke="var(--d-stroke)" stroke-width="1"/>`);
        }
      }
      out.push('</g>');
    });
  }
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
      // --d-fill by the §5 contrast gate, so this is readable in any theme
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
  else axisChart(spec, chrome, out);

  const label = spec.title ? `${spec.title} — ${spec.type} chart` : `${spec.type} chart`;
  return `<svg class="chart-svg" viewBox="0 0 ${spec.width} ${spec.height}" role="img" aria-label="${esc(label)}" preserveAspectRatio="xMidYMid meet">` +
    `<g class="chart-chrome" data-build-stay>${chrome.join('')}</g>` +
    out.join('') +
    '</svg>';
}

// --------------------------------------------------------------------------
// DOM application (browser only)

/**
 * Expand every chart declaration under `root`, synchronously, in place.
 * Runs in the init pipeline between initMarkdown and namespaceSvgIds, so the
 * generated SVG is id-namespaced (it emits none, but the invariant holds) and
 * build-scanned like any hand-drawn diagram. Invalid input renders a visible
 * .chart-broken box — never a blank slide, never a thrown error.
 */
export function initCharts(root) {
  // markdown fence form: ```chart with the JSON as the body (a nested
  // </script> can't live inside text/template) — rendered by marked as
  // pre > code.language-chart, converted here to the canonical div form
  root.querySelectorAll('pre > code.language-chart').forEach((code) => {
    const holder = document.createElement('div');
    holder.className = 'chart';
    holder.setAttribute('data-chart', '');
    const data = document.createElement('script');
    data.type = 'application/json';
    data.textContent = code.textContent;
    holder.appendChild(data);
    code.parentElement.replaceWith(holder);
  });

  root.querySelectorAll('[data-chart]').forEach((el) => {
    if (el.querySelector(':scope > svg.chart-svg, :scope > .chart-broken')) return; // idempotent
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
      // §2.1 SVG-container steps (the chrome group is data-build-stay)
      if (el.hasAttribute('data-build')) {
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
  });
}
