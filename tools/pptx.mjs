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
  diagram: 'SmartArt dropped — rebuild as an SVG diagram (SPEC SVG_DIAGRAMS)',
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

/**
 * One slide, as the pieces a `<section>` needs.
 *
 * `spTree` children are walked in document order so the section reads in the
 * order the slide did. Groups are walked into: a shape inside a group is still
 * content, and skipping groups loses whole slides' worth of text.
 */
export function parseSlide(xml, { rels, mediaOf, chartOf, slideNo = 0 } = {}) {
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
  return { html: `    <section>\n${parts.join('\n')}\n    </section>`, did };
}
