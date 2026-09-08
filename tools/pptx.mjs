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
};

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
    const cat = find(ser, 'c:cat');
    const val = find(ser, 'c:val');
    return {
      name: name || `series ${i + 1}`,
      labels: cat ? cachePoints(cat, false) : [],
      data: val ? cachePoints(val, true).map((n) => (Number.isFinite(n) ? n : 0)) : [],
    };
  }).filter((sr) => sr.data.length);
  if (!series.length) return null;
  const labels = series.find((sr) => sr.labels.length)?.labels ?? series[0].data.map((_, i) => String(i + 1));
  const titleNode = find(doc, 'c:title');
  const title = titleNode ? findAll(titleNode, 'a:t').map((t) => textOf(t)).join('').trim() : '';
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

  const walk = (tree) => {
    for (const node of tree.children ?? []) {
      if (node.name === 'p:grpSp') { walk(node); continue; }

      if (node.name === 'p:sp') {
        if (find(node, 'a:videoFile') || find(node, 'a:audioFile')) {
          drop('embedded media dropped — use data-background-video or a <video> (SPEC DECK_ANATOMY)');
          continue;
        }
        const ph = find(node, 'p:ph');
        const type = ph?.attrs.type ?? '';
        const txBody = find(node, 'p:txBody');
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
          blocks.push(wantsBuild && b.kind === 'list' ? { ...b, build: true } : b);
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
export function chartHtml({ type, title, labels, series }) {
  const json = JSON.stringify({ labels, series }).replace(/<\//g, '<\\/');
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
      did.push(`chart (${b.type}, ${b.series.length} series × ${b.labels.length})`);
      parts.push(`      ${chartHtml(b)}`);
    } else if (b.kind === 'diagram') {
      const { html, as } = diagramBlockHtml(b);
      const count = (function count(list) { return list.reduce((n, x) => n + 1 + count(x.children), 0); })(b.nodes);
      did.push(`SmartArt (${b.shape}, ${count} node${count === 1 ? '' : 's'}) as ${as}`);
      parts.push(`      ${html}`);
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
