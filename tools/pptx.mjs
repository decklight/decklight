// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// PowerPoint → decklight, as a pure transformation over parsed XML.
//
// This is a CONTENT importer, not a pixel renderer. The template's look is
// deliberately thrown away and replaced by decklight theming — the deck you get
// is a decklight deck, not a screenshot of the old one. What that buys is
// everything downstream: themes, builds, narration, the notes editor, `dev`.
//
// What it cannot carry, it drops LOUDLY. A silent drop is the failure mode that
// matters here: a chart that quietly vanishes from slide 14 is discovered on
// stage. Every drop is named with its slide number, and where decklight has a
// native answer the report says what to rebuild it with.

import { parseXml, find, findAll, children, textOf } from './ooxml.mjs';

import { escapeHtml } from './escape.mjs';

/** OOXML relationship parts map an rId to a part path, relative to the owner. */
export function parseRels(xml) {
  const rels = new Map();
  for (const r of findAll(parseXml(xml ?? ''), 'Relationship')) {
    if (r.attrs.Id) rels.set(r.attrs.Id, { target: r.attrs.Target ?? '', type: r.attrs.Type ?? '' });
  }
  return rels;
}

/** Resolve a relationship target (`../media/image1.png`) against its owner. */
export function resolvePart(ownerPath, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = ownerPath.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * The slides, in presentation order.
 *
 * The order is `<p:sldIdLst>`'s, not the archive's: slide7.xml can be third in
 * the deck, and importing in filename order would silently reorder the talk.
 */
export function slideOrder(presentationXml, presentationRelsXml) {
  const rels = parseRels(presentationRelsXml);
  const lst = find(parseXml(presentationXml ?? ''), 'p:sldIdLst');
  return children(lst, 'p:sldId')
    .map((s) => rels.get(s.attrs['r:id'])?.target)
    .filter(Boolean)
    .map((t) => resolvePart('ppt/presentation.xml', t));
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tiff: 'image/tiff',
};
export const mimeOf = (name) => MIME[name.split('.').pop()?.toLowerCase()] ?? 'application/octet-stream';

/** One `<a:p>` as inline HTML: runs, their formatting, links and breaks. */
export function paragraphHtml(p, { rels } = {}) {
  let out = '';
  for (const node of p.children ?? []) {
    if (node.name === 'a:br') { out += '<br>'; continue; }
    if (node.name !== 'a:r') continue;
    const rPr = find(node, 'a:rPr');
    const t = find(node, 'a:t');
    let text = escapeHtml(t ? textOf(t) : '');
    if (!text) continue;
    if (rPr?.attrs.b === '1') text = `<strong>${text}</strong>`;
    if (rPr?.attrs.i === '1') text = `<em>${text}</em>`;
    const link = rPr && find(rPr, 'a:hlinkClick');
    const href = link && rels?.get(link.attrs['r:id'])?.target;
    if (href) text = `<a href="${escapeHtml(href)}">${text}</a>`;
    out += text;
  }
  return out.trim();
}

const paraLevel = (p) => Number(find(p, 'a:pPr')?.attrs.lvl ?? 0) || 0;
/** A paragraph is a bullet unless it says otherwise — PowerPoint's own default. */
const isBullet = (p) => !find(p, 'a:buNone');
const isNumbered = (p) => !!find(p, 'a:buAutoNum');

/**
 * A text body's paragraphs, grouped into blocks.
 *
 * Consecutive bulleted paragraphs become one list (their `lvl` becoming
 * nesting); anything else becomes its own paragraph. Empty paragraphs are
 * spacing in PowerPoint and separators here — they close a run of bullets
 * rather than producing an empty `<li>`.
 */
export function bodyBlocks(txBody, { rels } = {}) {
  const blocks = [];
  let list = null;
  for (const p of children(txBody, 'a:p')) {
    const html = paragraphHtml(p, { rels });
    if (!html) { list = null; continue; }
    if (isBullet(p)) {
      const ordered = isNumbered(p);
      if (!list || list.ordered !== ordered) {
        list = { kind: 'list', ordered, items: [] };
        blocks.push(list);
      }
      list.items.push({ level: paraLevel(p), html });
    } else {
      list = null;
      blocks.push({ kind: 'p', html });
    }
  }
  return blocks;
}

/**
 * A flat list of `{level, html}` as nested `<ul>`/`<ol>` markup.
 *
 * PowerPoint stores indent as a number on each paragraph; HTML stores it as a
 * sublist INSIDE the parent `<li>`. So an item's `</li>` cannot be written
 * until the next item proves nothing nests under it — which is why the open
 * `<li>` is tracked rather than closed eagerly. It also matters beyond
 * validity: `data-build` makes each DIRECT child a step, so a sublist that
 * escaped its parent would become a build step of its own.
 */
export function listHtml(list, { build } = {}) {
  const tag = list.ordered ? 'ol' : 'ul';
  const attr = build ? ` data-build="${build}"` : '';
  let out = `<${tag}${attr}>`;
  let depth = 0;
  let open = false;
  for (const item of list.items) {
    // a jump from level 0 to level 3 indents by one: HTML has no way to
    // express the missing levels, and inventing empty <li>s to carry them
    // would put bullets on screen that were never in the deck
    const level = Math.max(0, Math.min(item.level, depth + 1));
    if (level > depth) {
      out += `<${tag}>`;      // inside the open <li> — the parent stays open
      depth += 1;
    } else {
      if (open) out += '</li>';
      while (depth > level) { out += `</${tag}></li>`; depth -= 1; }
    }
    out += `<li>${item.html}`;
    open = true;
  }
  if (open) out += '</li>';
  while (depth > 0) { out += `</${tag}></li>`; depth -= 1; }
  return out + `</${tag}>`;
}

/** An `<a:tbl>` as an HTML table; the first row becomes a header. */
export function tableHtml(tbl, { rels } = {}) {
  const rows = children(tbl, 'a:tr');
  const cells = (tr, cellTag) => children(tr, 'a:tc')
    .map((tc) => {
      const body = find(tc, 'a:txBody');
      const text = body ? children(body, 'a:p').map((p) => paragraphHtml(p, { rels })).filter(Boolean).join('<br>') : '';
      return `<${cellTag}>${text}</${cellTag}>`;
    }).join('');
  if (!rows.length) return '';
  const head = `<thead><tr>${cells(rows[0], 'th')}</tr></thead>`;
  const body = rows.slice(1).map((tr) => `<tr>${cells(tr, 'td')}</tr>`).join('');
  return `<table>${head}${body ? `<tbody>${body}</tbody>` : ''}</table>`;
}

const GRAPHIC = {
  table: null,                                        // handled
  chart: 'chart dropped — rebuild as data-chart (SPEC CHARTS)',
  // Only when its data model cannot be read at all — otherwise the words
  // cross, and often the shape with them (parseDiagram, below).
  diagram: 'SmartArt dropped — its data could not be read; rebuild as an SVG diagram (SPEC SVG_DIAGRAMS)',
};

/** OOXML chart element → data-chart type. Anything else is still a drop. */
const CHART_TYPES = {
  'c:barChart': 'bar', 'c:bar3DChart': 'bar',
  'c:lineChart': 'line', 'c:line3DChart': 'line',
  'c:areaChart': 'area', 'c:area3DChart': 'area',
  'c:pieChart': 'pie', 'c:pie3DChart': 'pie',
  'c:doughnutChart': 'donut',
  // x/y pairs rather than a value per category — read from c:xVal/c:yVal below
  'c:scatterChart': 'scatter',
};

/** A chart part's own title, as plain text — '' when it has none. */
function titleOfChart(doc) {
  const node = find(doc, 'c:title');
  return node ? findAll(node, 'a:t').map((t) => textOf(t)).join('').trim() : '';
}

/** The `c:pt` values of a cache, in index order; numbers where they parse. */
function cachePoints(node, numeric) {
  const pts = findAll(node, 'c:pt').map((pt) => [Number(pt.attrs.idx ?? 0), textOf(find(pt, 'c:v') ?? pt).trim()]);
  pts.sort((a, b) => a[0] - b[0]);
  return pts.map(([, v]) => (numeric ? Number(v) : v));
}

/**
 * A PowerPoint chart, as data-chart's JSON.
 *
 * The chart part carries the data in caches — `c:numCache` and `c:strCache`
 * are the values as last calculated, so nothing here needs the workbook the
 * chart was drawn from. This was the single most common rebuild in a business
 * deck, and every byte it needed was already in the file.
 *
 * Returns null for a chart kind decklight has no native answer for (scatter,
 * radar, stock…); the caller then drops it by name, as before.
 */
export function parseChart(xml) {
  const doc = parseXml(xml ?? '');
  const plot = find(doc, 'c:plotArea');
  if (!plot) return null;
  // `children(node, name)` filters by ONE name; the plot area's first chart
  // element is whichever of the known kinds is there, so walk its kids directly
  const kindNode = (plot.children ?? []).find((n) => CHART_TYPES[n.name]);
  if (!kindNode) return null;
  const type = CHART_TYPES[kindNode.name];
  const series = findAll(kindNode, 'c:ser').map((ser, i) => {
    const tx = find(ser, 'c:tx');
    const name = tx ? textOf(tx).trim() : `series ${i + 1}`;
    if (type === 'scatter') {
      // A scatter's x is a MEASUREMENT, in its own cache, so the pairing is
      // by index: the k-th x goes with the k-th y, and a series missing
      // either of them has no points rather than points at zero.
      const xs = find(ser, 'c:xVal');
      const ys = find(ser, 'c:yVal');
      const xv = xs ? cachePoints(xs, true) : [];
      const yv = ys ? cachePoints(ys, true) : [];
      const points = xv.map((x, k) => [x, yv[k]])
        .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
      return { name: name || `series ${i + 1}`, labels: [], data: [], points };
    }
    const cat = find(ser, 'c:cat');
    const val = find(ser, 'c:val');
    return {
      name: name || `series ${i + 1}`,
      labels: cat ? cachePoints(cat, false) : [],
      data: val ? cachePoints(val, true).map((n) => (Number.isFinite(n) ? n : 0)) : [],
    };
  }).filter((sr) => (type === 'scatter' ? sr.points.length : sr.data.length));
  if (!series.length) return null;
  if (type === 'scatter') {
    // The axis titles are the chart's own, where it has them: a scatter with
    // two unnamed numeric axes is a picture of nothing in particular.
    const axisTitle = (i) => {
      const ax = findAll(doc, 'c:valAx')[i];
      const t = ax && find(ax, 'c:title');
      return t ? findAll(t, 'a:t').map((n) => textOf(n)).join('').trim() || null : null;
    };
    return {
      type,
      title: titleOfChart(doc),
      x: axisTitle(0),
      y: axisTitle(1),
      series: series.map(({ name, points }) => ({ name, points })),
    };
  }
  const labels = series.find((sr) => sr.labels.length)?.labels ?? series[0].data.map((_, i) => String(i + 1));
  const title = titleOfChart(doc);
  return {
    type,
    title,
    labels,
    // a pie is one series in decklight; PowerPoint allows more but draws one
    series: (type === 'pie' || type === 'donut' ? series.slice(0, 1) : series)
      .map(({ name, data }) => ({ name, data })),
  };
}

// ── SmartArt ────────────────────────────────────────────────────────────────
//
// A SmartArt graphic is three parts: a DATA model (the words, and how they
// relate), a LAYOUT (which picture PowerPoint chose to draw of them), and a
// drawing cache that is a rendering of the first two and worth nothing here.
//
// It used to be a loud drop, and loud was right — but the words were always
// crossable, and a slide whose whole content is one SmartArt graphic came
// across EMPTY, with a line underneath saying so. Now the words always cross;
// the shape crosses when decklight can draw it.

/** Which picture PowerPoint was drawing, read from the layout part's own id. */
export function diagramKind(layoutXml) {
  const id = find(parseXml(layoutXml ?? ''), 'dgm:layoutDef')?.attrs.uniqueId ?? '';
  const name = id.split('/').pop().toLowerCase();
  if (/cycle|gear|radial/.test(name)) return 'cycle';
  if (/hierarchy|orgchart|org\d/.test(name)) return 'hierarchy';
  if (/process|chevron|arrow|step|funnel|timeline/.test(name)) return 'process';
  return 'list';
}

/**
 * The data model as a tree of `{ text, plain, children }`.
 *
 * Two things make this less obvious than it looks. The point list carries
 * PRESENTATION points beside the content ones — the boxes and connectors the
 * chosen layout needed — and importing those would put the drawing's scaffolding
 * on the slide as words. And the nesting is not in the XML's shape: it is in a
 * separate connection list, where `parOf` links a parent to a child and `srcOrd`
 * is the order, so the tree has to be rebuilt from the edges.
 */
export function parseDiagram(dataXml, { rels } = {}) {
  const doc = parseXml(dataXml ?? '');
  const pts = new Map();
  let rootId = null;
  for (const pt of findAll(doc, 'dgm:pt')) {
    const id = pt.attrs.modelId;
    if (!id) continue;
    const type = pt.attrs.type ?? 'node';
    if (type === 'doc') { rootId = id; continue; }
    // `pres` is the layout's own scaffolding; parTrans/sibTrans are the text
    // ON a connector, which is a label for an edge and not a node of its own.
    if (type !== 'node' && type !== 'asst') continue;
    const t = find(pt, 'dgm:t');
    const paras = t ? children(t, 'a:p') : [];
    pts.set(id, {
      text: paras.map((q) => paragraphHtml(q, { rels })).filter(Boolean).join(' '),
      plain: t ? textOf(t).replace(/\s+/g, ' ').trim() : '',
      children: [],
    });
  }
  const kids = new Map();
  for (const cxn of findAll(doc, 'dgm:cxn')) {
    if ((cxn.attrs.type ?? 'parOf') !== 'parOf') continue;
    const { srcId, destId } = cxn.attrs;
    if (!srcId || !destId || !pts.has(destId)) continue;
    if (!kids.has(srcId)) kids.set(srcId, []);
    kids.get(srcId).push({ ord: Number(cxn.attrs.srcOrd ?? 0), id: destId });
  }
  // `seen` is not defensive tidiness: a malformed or circular connection list
  // would otherwise recurse until the stack ends, on a file nobody can inspect.
  const build = (id, seen) => (kids.get(id) ?? [])
    .slice()
    .sort((a, b) => a.ord - b.ord)
    .filter((k) => !seen.has(k.id))
    .map((k) => {
      seen.add(k.id);
      const node = pts.get(k.id);
      return { ...node, children: build(k.id, seen) };
    })
    .filter((node) => node.text || node.children.length);
  return rootId ? build(rootId, new Set([rootId])) : [];
}

/** Text as `<tspan>` lines, wrapped to a width in characters. */
function wrapLines(text, chars) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= chars) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

const flat = (nodes) => nodes.every((n) => !n.children.length);

/**
 * A flat sequence as an SVG strip — one box per step, an arrow between each.
 *
 * `cycle` is the same strip with the last arrow curving back under it to the
 * first box, which is what a cycle IS once it is on a page that reads left to
 * right. Drawing a ring instead would look more like PowerPoint and read worse
 * at the back of a room.
 */
export function diagramSvg(nodes, kind) {
  const W = 960, H = kind === 'cycle' ? 168 : 120, GAP = 30, TOP = 14, BOX_H = 84;
  const n = nodes.length;
  const boxW = Math.round((W - GAP * (n - 1)) / n);
  const chars = Math.max(8, Math.floor(boxW / 8.4));
  const arrow = `<defs><marker id="dgm-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">`
    + `<polygon points="0 0, 8 3, 0 6" style="fill: var(--d-stroke)"/></marker></defs>`;
  const groups = nodes.map((node, i) => {
    const x = i * (boxW + GAP);
    const mid = x + boxW / 2;
    const lines = wrapLines(node.plain, chars).slice(0, 3);
    const first = TOP + BOX_H / 2 - ((lines.length - 1) * 19) / 2 + 6;
    const text = lines
      .map((l, k) => `<tspan x="${Math.round(mid)}" y="${Math.round(first + k * 19)}">${escapeHtml(l)}</tspan>`)
      .join('');
    const link = i < n - 1
      ? `<line x1="${x + boxW + 4}" y1="${TOP + BOX_H / 2}" x2="${x + boxW + GAP - 6}" y2="${TOP + BOX_H / 2}"`
        + ` stroke-width="2" style="stroke: var(--d-stroke)" marker-end="url(#dgm-arrow)"/>`
      : '';
    return `<g><rect x="${x}" y="${TOP}" width="${boxW}" height="${BOX_H}" rx="10"`
      + ` style="fill: var(--d-fill-${(i % 6) + 1}); stroke: var(--d-stroke)" stroke-width="2"/>`
      + `<text text-anchor="middle" font-size="15" font-weight="600"`
      + ` style="font-family: var(--font-body); fill: var(--d-text)">${text}</text>${link}</g>`;
  });
  // the return leg: out of the last box, under the strip, back into the first
  const loop = kind === 'cycle' && n > 1
    ? `<path d="M ${W - Math.round(boxW / 2)} ${TOP + BOX_H} V ${H - 18} H ${Math.round(boxW / 2)} V ${TOP + BOX_H + 6}"`
      + ` fill="none" stroke-width="2" style="stroke: var(--d-stroke)" marker-end="url(#dgm-arrow)"/>`
    : '';
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="${escapeHtml(nodes.map((x) => x.plain).join(' → '))}">`
    + `${arrow}${groups.join('')}${loop}</svg>`;
}

/** A diagram's nodes as a nested list — every word, none of the shape. */
export function diagramList(nodes, ordered) {
  const items = [];
  const walk = (list, level) => {
    for (const node of list) {
      items.push({ level, html: node.text || escapeHtml(node.plain) });
      walk(node.children, level + 1);
    }
  };
  walk(nodes, 0);
  return listHtml({ ordered, items });
}

/**
 * A SmartArt graphic as markup, and the word for what happened to it.
 *
 * The strip is drawn only when it would be READABLE: a flat sequence of at most
 * six steps. Past that the boxes are too narrow for their own words, and a list
 * that can be read beats a picture that cannot — an ordered one for a process,
 * because the numbering is the half of the shape a list can still carry.
 */
export function diagramBlockHtml({ shape, nodes }) {
  const sequence = shape === 'process' || shape === 'cycle';
  if (sequence && flat(nodes) && nodes.length > 1 && nodes.length <= 6) {
    return { html: diagramSvg(nodes, shape), as: 'an SVG diagram' };
  }
  return { html: diagramList(nodes, sequence), as: 'a nested list' };
}

// ── drawn diagrams ──────────────────────────────────────────────────────────
//
// The other way a PowerPoint deck carries a diagram: no SmartArt, no picture,
// just boxes and arrows somebody dragged onto the slide. There is no marker
// saying "this is a diagram" — it is shapes with positions, and connectors
// that name the shapes they join.
//
// Before this, every one of those slides came across as a pile of paragraphs
// in document order, with the arrows gone and nothing said about it: the
// silent partial loss this importer's own preamble says is the failure that
// matters. Now the arrangement crosses, or — when the evidence is not strong
// enough to be sure it IS an arrangement — the report at least says what was
// flattened.

/** A drawing unit: 914400 EMU to the inch, 96 of those to the CSS pixel. */
const EMU_PX = 9525;

/** `a:xfrm` as pixels, or null for a shape the slide never placed. */
export function shapeBox(node) {
  const xfrm = find(find(node, 'p:spPr') ?? node, 'a:xfrm');
  const off = xfrm && find(xfrm, 'a:off');
  const ext = xfrm && find(xfrm, 'a:ext');
  if (!off || !ext) return null;
  const n = (v) => Number(v ?? NaN) / EMU_PX;
  const box = { x: n(off.attrs.x), y: n(off.attrs.y), w: n(ext.attrs.cx), h: n(ext.attrs.cy),
    flipH: xfrm.attrs.flipH === '1', flipV: xfrm.attrs.flipV === '1' };
  return Object.values(box).slice(0, 4).every(Number.isFinite) ? box : null;
}

/** The preset shape name, e.g. `roundRect` — absent for a shape with custom geometry. */
const presetOf = (node) => find(node, 'a:prstGeom')?.attrs.prst ?? '';

const ROUND = /roundRect|round1Rect|round2SameRect|round2DiagRect|snip/;
const OVAL = /ellipse|circle|oval|flowChartConnector|flowChartTerminator/;
const DIAMOND = /diamond|flowChartDecision/;
const TRIANGLE = /triangle/;

/**
 * The shapes and connectors of a slide, as one drawing — or null when what is
 * there is not evidence enough that it IS one.
 *
 * The test is deliberately strict, because the cost of a false positive is a
 * perfectly ordinary slide turned into a strange picture. A connector that
 * NAMES the shapes at both of its ends (`a:stCxn` / `a:endCxn`) is the strong
 * signal: PowerPoint writes those when somebody attaches an arrow to a box,
 * which is drawing a diagram and not laying out a caption. Two shapes and one
 * attached connector is the floor.
 */
export function asDrawing(shapes, links) {
  const joined = links.filter((l) => l.from != null && l.to != null);
  if (shapes.length < 2 || !joined.length) return null;
  const pad = 12;
  const xs = shapes.map((s) => s.box);
  const minX = Math.min(...xs.map((b) => b.x)) - pad;
  const minY = Math.min(...xs.map((b) => b.y)) - pad;
  const maxX = Math.max(...xs.map((b) => b.x + b.w)) + pad;
  const maxY = Math.max(...xs.map((b) => b.y + b.h)) + pad;
  return { shapes, links, box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

/** Where a line from `b` towards `to` leaves b's box — its edge, not its middle. */
function edgePoint(b, to) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const dx = to.x - cx, dy = to.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  // the smaller scale is the edge the ray crosses first
  const sx = dx ? b.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? b.h / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** A drawing as a themed SVG, in the coordinates the slide used. */
export function drawingSvg({ shapes, links, box }) {
  const at = (b) => ({ x: b.x - box.x, y: b.y - box.y, w: b.w, h: b.h });
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const arrow = `<defs><marker id="dwg-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">`
    + `<polygon points="0 0, 8 3, 0 6" style="fill: var(--d-stroke)"/></marker></defs>`;

  const lines = links.map((l) => {
    const a = byId.get(l.from), b = byId.get(l.to);
    if (!a || !b) return '';
    const ca = { x: a.box.x + a.box.w / 2, y: a.box.y + a.box.h / 2 };
    const cb = { x: b.box.x + b.box.w / 2, y: b.box.y + b.box.h / 2 };
    const p1 = edgePoint(a.box, cb), p2 = edgePoint(b.box, ca);
    return `<line x1="${Math.round(p1.x - box.x)}" y1="${Math.round(p1.y - box.y)}"`
      + ` x2="${Math.round(p2.x - box.x)}" y2="${Math.round(p2.y - box.y)}"`
      + ` stroke-width="2" style="stroke: var(--d-stroke)" marker-end="url(#dwg-arrow)"/>`;
  }).join('');

  const boxes = shapes.map((s, i) => {
    const r = at(s.box);
    const [x, y, w, h] = [r.x, r.y, r.w, r.h].map(Math.round);
    const fill = `var(--d-fill-${(i % 6) + 1})`;
    const stroke = ` style="fill: ${fill}; stroke: var(--d-stroke)" stroke-width="2"`;
    let shape;
    if (OVAL.test(s.prst)) shape = `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"${stroke}/>`;
    else if (DIAMOND.test(s.prst)) shape = `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}"${stroke}/>`;
    else if (TRIANGLE.test(s.prst)) shape = `<polygon points="${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}"${stroke}/>`;
    else shape = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${ROUND.test(s.prst) ? 10 : 3}"${stroke}/>`;
    const lines_ = wrapLines(s.plain, Math.max(6, Math.floor(w / 8.4))).slice(0, 4);
    const first = y + h / 2 - ((lines_.length - 1) * 18) / 2 + 5;
    const text = lines_.length
      ? `<text text-anchor="middle" font-size="14" font-weight="600"`
        + ` style="font-family: var(--font-body); fill: var(--d-text)">`
        + lines_.map((t, k) => `<tspan x="${Math.round(x + w / 2)}" y="${Math.round(first + k * 18)}">${escapeHtml(t)}</tspan>`).join('')
        + `</text>`
      : '';
    return `<g>${shape}${text}</g>`;
  }).join('');

  const label = shapes.map((s) => s.plain).filter(Boolean).join(', ');
  return `<svg viewBox="0 0 ${Math.round(box.w)} ${Math.round(box.h)}" width="${Math.round(Math.min(box.w, 960))}"`
    + ` role="img" aria-label="${escapeHtml(label || 'diagram')}">${arrow}${lines}${boxes}</svg>`;
}

/**
 * One slide, as the pieces a `<section>` needs.
 *
 * `spTree` children are walked in document order so the section reads in the
 * order the slide did. Groups are walked into: a shape inside a group is still
 * content, and skipping groups loses whole slides' worth of text.
 */
export function parseSlide(xml, { rels, mediaOf, chartOf, diagramOf, slideNo = 0 } = {}) {
  const doc = parseXml(xml);
  const sld = find(doc, 'p:sld');
  const hidden = sld?.attrs.show === '0';
  const drops = [];
  const drop = (what) => { if (!drops.includes(what)) drops.push(what); };

  // <p:bldP> names the shapes PowerPoint reveals a paragraph at a time — which
  // is exactly what data-build means. Reading the real build list beats
  // guessing from the animation timeline.
  const builds = new Set(findAll(sld, 'p:bldP').map((b) => b.attrs.spid).filter(Boolean));
  if (find(sld, 'p:transition')) drop('slide transition dropped — decklight transitions are deck-wide');

  let title = null;
  let titleIsH1 = false;
  let subtitle = null;
  const blocks = [];
  const drawn = [];   // placed, non-placeholder shapes — a diagram, maybe
  const links = [];   // connectors, and which shapes they join

  const walk = (tree) => {
    for (const node of tree.children ?? []) {
      if (node.name === 'p:grpSp') { walk(node); continue; }

      // A connector NAMES the shapes it joins; that is what makes a set of
      // boxes a diagram rather than a layout (asDrawing).
      if (node.name === 'p:cxnSp') {
        const cxn = find(node, 'p:cNvCxnSpPr');
        links.push({
          from: cxn && find(cxn, 'a:stCxn')?.attrs.id,
          to: cxn && find(cxn, 'a:endCxn')?.attrs.id,
        });
        continue;
      }

      if (node.name === 'p:sp') {
        if (find(node, 'a:videoFile') || find(node, 'a:audioFile')) {
          drop('embedded media dropped — use data-background-video or a <video> (SPEC DECK_ANATOMY)');
          continue;
        }
        const ph = find(node, 'p:ph');
        const type = ph?.attrs.type ?? '';
        const txBody = find(node, 'p:txBody');
        // A shape the slide PLACED, which is not one of the layout's
        // placeholders, may be part of a drawing. It is only kept as one if
        // the connectors bear that out (below); otherwise its text is read
        // exactly as it always was, and a shape with no text is skipped.
        let placed = false;
        if (!ph) {
          const box = shapeBox(node);
          if (box) {
            placed = true;
            drawn.push({
              id: find(node, 'p:cNvPr')?.attrs.id,
              box,
              prst: presetOf(node),
              plain: txBody ? textOf(txBody).replace(/\s+/g, ' ').trim() : '',
              at: blocks.length,
            });
          }
        }
        if (!txBody) continue;
        const text = textOf(txBody).trim();

        if ((type === 'title' || type === 'ctrTitle') && text && title === null) {
          title = children(txBody, 'a:p').map((p) => paragraphHtml(p, { rels })).filter(Boolean).join(' ');
          titleIsH1 = type === 'ctrTitle';   // the title-layout's centered title
          continue;
        }
        if (type === 'subTitle' && text && subtitle === null) {
          subtitle = children(txBody, 'a:p').map((p) => paragraphHtml(p, { rels })).filter(Boolean).join(' ');
          continue;
        }
        if (!text) continue;
        const id = find(node, 'p:cNvPr')?.attrs.id;
        const wantsBuild = id && builds.has(id);
        for (const b of bodyBlocks(txBody, { rels })) {
          const block = wantsBuild && b.kind === 'list' ? { ...b, build: true } : b;
          // `placed` is how the drawing swap finds these again exactly, rather
          // than by comparing their contents — two boxes can say the same word.
          blocks.push(placed ? { ...block, placed } : block);
        }
        continue;
      }

      if (node.name === 'p:pic') {
        if (find(node, 'a:videoFile') || find(node, 'a:audioFile')) {
          drop('embedded media dropped — use data-background-video or a <video> (SPEC DECK_ANATOMY)');
          continue;
        }
        const blip = find(node, 'a:blip');
        const rel = blip && rels?.get(blip.attrs['r:embed']);
        const media = rel && mediaOf?.(rel.target);
        if (!media) { drop('an image could not be read from the file'); continue; }
        const alt = find(node, 'p:cNvPr')?.attrs.descr ?? '';
        blocks.push({ kind: 'image', ...media, alt });
        continue;
      }

      if (node.name === 'p:graphicFrame') {
        const uri = find(node, 'a:graphicData')?.attrs.uri ?? '';
        const kind = uri.split('/').pop();
        if (kind === 'table') {
          const tbl = find(node, 'a:tbl');
          if (tbl) blocks.push({ kind: 'table', node: tbl });
          continue;
        }
        if (kind === 'chart') {
          // the frame holds only a relationship; the data is in its own part
          const rid = find(node, 'c:chart')?.attrs['r:id'];
          const rel = rid && rels?.get(rid);
          const chart = rel && chartOf ? parseChart(chartOf(rel.target)) : null;
          if (chart) { blocks.push({ kind: 'chart', ...chart }); continue; }
          drop(GRAPHIC.chart);
          continue;
        }
        if (kind === 'diagram') {
          // The frame holds only relationships: r:dm is the data model, r:lo
          // the layout that says which picture was drawn of it.
          const ids = find(node, 'dgm:relIds');
          const dm = ids && rels?.get(ids.attrs['r:dm'])?.target;
          const nodes = dm && diagramOf ? parseDiagram(diagramOf(dm), { rels }) : [];
          if (nodes.length) {
            const lo = ids && rels?.get(ids.attrs['r:lo'])?.target;
            blocks.push({ kind: 'diagram', shape: diagramKind(lo && diagramOf ? diagramOf(lo) : ''), nodes });
            continue;
          }
          drop(GRAPHIC.diagram);
          continue;
        }
        drop(GRAPHIC[kind] ?? `an embedded ${kind || 'object'} was dropped`);
        continue;
      }

      if (node.name === 'mc:AlternateContent' || node.name === 'p:oleObj') {
        drop('an embedded object was dropped');
      }
    }
  };
  const tree = find(sld, 'p:spTree');
  if (tree) walk(tree);

  // The drawing decision is made once the whole slide has been seen: a
  // connector can be written after the shapes it joins, and one shape is never
  // a diagram. When it holds, the shapes' own text blocks give way to the
  // picture that has them in it; when it does not, nothing changes except that
  // the slide now SAYS its arrangement did not survive.
  const drawing = asDrawing(drawn, links);
  if (drawing) {
    const at = blocks.findIndex((b) => b.placed);
    const kept = blocks.filter((b) => !b.placed);
    kept.splice(at < 0 ? kept.length : Math.min(at, kept.length), 0, { kind: 'drawing', drawing });
    blocks.length = 0;
    blocks.push(...kept);
  } else {
    for (const b of blocks) delete b.placed;
    // Said only when the slide LOOKED like a drawing — three placed shapes, or
    // two with a line between them. Two text boxes side by side is a layout,
    // and warning about every one of those is how a report stops being read.
    if (drawn.length >= 3 || (drawn.length >= 2 && links.length)) {
      drop(`${drawn.length} drawn shapes came across as text — their arrangement did not (SPEC SVG_DIAGRAMS)`);
    }
  }

  return { slideNo, hidden, title, titleIsH1, subtitle, blocks, drops };
}

/** The notes text of a notesSlide part — the body placeholder, paragraph per line. */
export function notesText(xml, { rels } = {}) {
  const doc = parseXml(xml ?? '');
  for (const sp of findAll(doc, 'p:sp')) {
    const type = find(sp, 'p:ph')?.attrs.type;
    if (type !== 'body') continue;
    const body = find(sp, 'p:txBody');
    if (!body) continue;
    const lines = children(body, 'a:p').map((p) => paragraphHtml(p, { rels })).filter(Boolean);
    if (lines.length) return lines;
  }
  return [];
}

/** A parsed slide as the `<section>` markup, plus what its report line says. */
/** A chart block as SPEC CHARTS markup — JSON in a script tag, so `</` must not end it early. */
export function chartHtml({ type, title, labels, series, x, y }) {
  // A scatter carries pairs and two axis names; everything else carries
  // categories. Same wrapper, different payload — CHARTS reads both.
  const body = type === 'scatter'
    ? { ...(x ? { x } : {}), ...(y ? { y } : {}), series }
    : { labels, series };
  const json = JSON.stringify(body).replace(/<\//g, '<\\/');
  const attrs = [`class="chart"`, `data-chart="${type}"`, title ? `data-title="${escapeHtml(title)}"` : null].filter(Boolean);
  return `<div ${attrs.join(' ')}>\n        <script type="application/json">${json}</script>\n      </div>`;
}

export function slideSection(slide, notes = [], { build = 'auto' } = {}) {
  const parts = [];
  const did = [];
  if (slide.title) {
    parts.push(`      <${slide.titleIsH1 ? 'h1' : 'h2'}>${slide.title}</${slide.titleIsH1 ? 'h1' : 'h2'}>`);
  }
  if (slide.subtitle) parts.push(`      <p>${slide.subtitle}</p>`);

  let bullets = 0;
  for (const b of slide.blocks) {
    if (b.kind === 'list') {
      bullets += b.items.length;
      // --build all forces it on, none forces it off; auto follows PowerPoint's
      // own per-paragraph build list
      const on = build === 'all' || (build === 'auto' && b.build);
      parts.push(`      ${listHtml(b, { build: on ? 'fade-up' : null })}`);
    } else if (b.kind === 'p') {
      parts.push(`      <p>${b.html}</p>`);
    } else if (b.kind === 'table') {
      const rows = children(b.node, 'a:tr');
      const cols = rows.length ? children(rows[0], 'a:tc').length : 0;
      did.push(`table ${rows.length}×${cols}`);
      parts.push(`      ${tableHtml(b.node)}`);
    } else if (b.kind === 'chart') {
      const size = b.type === 'scatter'
        ? `${b.series.reduce((n, sr) => n + sr.points.length, 0)} points`
        : `${b.labels.length}`;
      did.push(`chart (${b.type}, ${b.series.length} series × ${size})`);
      parts.push(`      ${chartHtml(b)}`);
    } else if (b.kind === 'diagram') {
      const { html, as } = diagramBlockHtml(b);
      const count = (function count(list) { return list.reduce((n, x) => n + 1 + count(x.children), 0); })(b.nodes);
      did.push(`SmartArt (${b.shape}, ${count} node${count === 1 ? '' : 's'}) as ${as}`);
      parts.push(`      ${html}`);
    } else if (b.kind === 'drawing') {
      const n = b.drawing.shapes.length;
      did.push(`${n} drawn shapes as an SVG diagram`);
      parts.push(`      ${drawingSvg(b.drawing)}`);
    } else if (b.kind === 'image') {
      did.push(`image inlined (${Math.round(b.bytes.length / 1024)} KB)`);
      parts.push(`      <img src="data:${b.mime};base64,${b.bytes.toString('base64')}"`
        + `${b.alt ? ` alt="${escapeHtml(b.alt)}"` : ' alt=""'}>`);
    }
  }
  if (bullets) did.unshift(`${bullets} bullet${bullets === 1 ? '' : 's'}`);
  if (notes.length) {
    did.push('notes');
    parts.push('      <aside class="notes">');
    for (const line of notes) parts.push(`        <p>${line}</p>`);
    parts.push('      </aside>');
  }
  return { html: `    <section${slide.hidden ? ' data-hidden' : ''}>\n${parts.join('\n')}\n    </section>`, did };
}
