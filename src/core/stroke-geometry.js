// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A stroke's length and the point along it, from the shape's own attributes
 * (BUILD_ENTRANCES, draw). The engine prepares a draw build while its slide
 * is hidden, and some Chrome builds refuse `getTotalLength()` and
 * `getPointAtLength()` on a NON-RENDERED `<line>`, `<polyline>`, `<polygon>`,
 * `<rect>`, `<circle>` or `<ellipse>` ("This element is non-rendered
 * element") — only a `<path>` is measured from its `d`. Refused, the stroke
 * used to read as "nothing to draw": it faded instead, and its arrowhead and
 * dash mask were never built. These answer for the browser in that case;
 * a rendered shape is still measured by the browser.
 */

/** A length attribute in user units: the DOM's resolved value, else the attribute's number. */
function unit(el, name) {
  try {
    const v = el[name]?.baseVal?.value;
    if (Number.isFinite(v)) return v;
  } catch { /* not resolvable here — the attribute stands */ }
  const n = parseFloat(el.getAttribute?.(name));
  return Number.isFinite(n) ? n : 0;
}

/** The vertices of a straight-segment shape, closed for a polygon; null for any other shape. */
function verticesOf(el) {
  const tag = String(el.tagName ?? '').toLowerCase();
  if (tag === 'line') return [[unit(el, 'x1'), unit(el, 'y1')], [unit(el, 'x2'), unit(el, 'y2')]];
  if (tag !== 'polyline' && tag !== 'polygon') return null;
  const nums = String(el.getAttribute?.('points') ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < nums.length && Number.isFinite(nums[i]) && Number.isFinite(nums[i + 1]); i += 2) pts.push([nums[i], nums[i + 1]]);
  if (tag === 'polygon' && pts.length > 1) pts.push(pts[0]);
  return pts;
}

/** An ellipse's perimeter, Ramanujan's second approximation (exact for a circle). */
function ellipsePerimeter(a, b) {
  if (!(a > 0) || !(b > 0)) return 0;
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/** The length of the shape's outline in user units; 0 when it has none or is not a basic shape. */
export function shapeLength(el) {
  const v = verticesOf(el);
  if (v) {
    let len = 0;
    for (let i = 1; i < v.length; i++) len += Math.hypot(v[i][0] - v[i - 1][0], v[i][1] - v[i - 1][1]);
    return len;
  }
  const tag = String(el.tagName ?? '').toLowerCase();
  if (tag === 'circle') return 2 * Math.PI * Math.max(0, unit(el, 'r'));
  if (tag === 'ellipse') return ellipsePerimeter(unit(el, 'rx'), unit(el, 'ry'));
  if (tag === 'rect') {
    const w = unit(el, 'width'); const h = unit(el, 'height');
    if (!(w > 0) || !(h > 0)) return 0;
    // an absent rx or ry takes the other's value (SVG's auto), each clamped to half the side
    const hasRx = el.getAttribute?.('rx') != null; const hasRy = el.getAttribute?.('ry') != null;
    let rx = hasRx ? unit(el, 'rx') : unit(el, 'ry'); let ry = hasRy ? unit(el, 'ry') : unit(el, 'rx');
    rx = Math.min(Math.max(0, rx), w / 2); ry = Math.min(Math.max(0, ry), h / 2);
    if (!(rx > 0) || !(ry > 0)) return 2 * (w + h);
    return 2 * (w - 2 * rx) + 2 * (h - 2 * ry) + ellipsePerimeter(rx, ry);
  }
  return 0;
}

/** The point `d` along a straight-segment shape (`{ x, y }`), or null for a shape whose geometry is not segments. */
export function pointAlong(el, d) {
  const v = verticesOf(el);
  if (!v?.length) return null;
  let left = Math.max(0, d);
  for (let i = 1; i < v.length; i++) {
    const seg = Math.hypot(v[i][0] - v[i - 1][0], v[i][1] - v[i - 1][1]);
    if (left <= seg && seg > 0) {
      const t = left / seg;
      return { x: v[i - 1][0] + t * (v[i][0] - v[i - 1][0]), y: v[i - 1][1] + t * (v[i][1] - v[i - 1][1]) };
    }
    left -= seg;
  }
  const [x, y] = v[v.length - 1];
  return { x, y };
}
