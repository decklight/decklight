// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight import` — the XML→section mapping, and the three front doors.
//
// The mapping is where a silent wrong answer would live: a list that nests one
// level too shallow, a slide that lands out of order, a drop nobody is told
// about. All of it is pure over parsed XML, so it is checked here against a
// real .pptx in test/fixtures/ rather than against a mock of one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmTemp } from './helpers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzip, zipEntries } from '../tools/zip.mjs';
import { parseXml, find, findAll, children, textOf, decodeEntities } from '../tools/ooxml.mjs';
import {
  listHtml, resolvePart, slideOrder, parseSlide, notesText, mimeOf, paragraphHtml, parseChart, chartHtml, slideSection,
  parseDiagram, diagramKind, diagramBlockHtml, shapeBox, asDrawing, drawingSvg,
} from '../tools/pptx.mjs';
import { convert, outPath, slidesId, slidesExportUrl, sourceKind, slug, keynoteScript } from '../cli/import.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const FIXTURE = path.resolve(here, 'fixtures/sample.pptx');
const zip = () => unzip(readFileSync(FIXTURE));

// What is IN the fixture, because it is a binary and nothing else says:
//
//   slide 1  a title layout — ctrTitle + subTitle
//   slide 2  a bulleted body with nested levels, on PowerPoint's build list,
//            and the deck's only speaker notes
//   slide 3  a 2×2 table, a picture, an EMPTY chart frame (no chart part —
//            the "a graphic whose data cannot be read drops loudly" case),
//            and a SmartArt frame with a real data model and layout part:
//            a four-step Basic Process, plus `pres` points that must not
//            become words
//   slide 4  three boxes and two attached connectors — a diagram somebody
//            DREW, which is the other way a deck carries one
//   slide 5  `show="0"` — hidden, and kept (HIDDEN_SLIDES). It stays LAST, so
//            "a jump to the end never lands on it" still means something

// ── the zip reader ────────────────────────────────────────────────────────

test('the fixture reads as a zip, parts and all', () => {
  const z = zip();
  assert.ok(z.has('ppt/presentation.xml'));
  assert.ok(z.has('ppt/slides/slide1.xml'));
  assert.ok(z.has('ppt/media/image1.png'));
  // directory entries are not content
  assert.ok(![...z.keys()].some((k) => k.endsWith('/')));
  // the central directory is what we trust for sizes
  assert.ok(zipEntries(readFileSync(FIXTURE)).every((e) => e.size >= 0));
});

test('a file that is not a zip says so, rather than returning nothing', () => {
  assert.throws(() => unzip(Buffer.from('this is a plain text file')), /not a zip file/);
});

// ── the XML reader ────────────────────────────────────────────────────────

test('nesting is real: a table cell\'s paragraphs are not the slide\'s', () => {
  const doc = parseXml('<p:spTree><p:sp><a:p><a:t>own</a:t></a:p></p:sp>'
    + '<p:graphicFrame><a:tbl><a:tc><a:p><a:t>cell</a:t></a:p></a:tc></a:tbl></p:graphicFrame></p:spTree>');
  const tree = find(doc, 'p:spTree');
  assert.equal(children(tree, 'p:sp').length, 1, 'direct children only');
  assert.equal(findAll(tree, 'a:p').length, 2, 'descendants include the cell');
  assert.equal(textOf(find(tree, 'a:tbl')).trim(), 'cell');
});

test('entities decode, including numeric ones', () => {
  assert.equal(decodeEntities('Q3 &amp; beyond &#8212; part &#x32;'), 'Q3 & beyond — part 2');
  assert.equal(decodeEntities('&lt;tag&gt; &quot;q&quot; &apos;a&apos;'), `<tag> "q" 'a'`);
  assert.equal(decodeEntities('&notanentity;'), '&notanentity;', 'an unknown entity is left alone');
});

test('a stray close tag loses one element, not the document', () => {
  const doc = parseXml('<a><b>one</b></c><d>two</d></a>');
  assert.equal(textOf(find(doc, 'a')).replace(/\s+/g, ''), 'onetwo');
});

// ── the mapping ───────────────────────────────────────────────────────────

test('slides come out in presentation order, not archive order', () => {
  const z = zip();
  const order = slideOrder(z.get('ppt/presentation.xml').toString(), z.get('ppt/_rels/presentation.xml.rels').toString());
  assert.deepEqual(order, [
    'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml',
    'ppt/slides/slide4.xml', 'ppt/slides/slide5.xml',
  ]);
});

test('a relationship target resolves against the part that owns it', () => {
  assert.equal(resolvePart('ppt/slides/slide3.xml', '../media/image1.png'), 'ppt/media/image1.png');
  assert.equal(resolvePart('ppt/presentation.xml', 'slides/slide1.xml'), 'ppt/slides/slide1.xml');
  assert.equal(resolvePart('ppt/slides/slide1.xml', '/ppt/x.xml'), 'ppt/x.xml', 'an absolute target is package-rooted');
});

test('the title layout gives h1; every other slide gives h2', () => {
  const z = zip();
  const first = parseSlide(z.get('ppt/slides/slide1.xml').toString());
  assert.equal(first.titleIsH1, true, 'ctrTitle is the title-slide placeholder');
  assert.equal(first.title, 'Q3 &amp; Beyond');
  assert.equal(first.subtitle, 'What shipped, what did not');

  const second = parseSlide(z.get('ppt/slides/slide2.xml').toString());
  assert.equal(second.titleIsH1, false);
  assert.equal(second.title, 'Highlights');
});

test('a hidden slide is marked hidden, not silently dropped', () => {
  const z = zip();
  assert.equal(parseSlide(z.get('ppt/slides/slide5.xml').toString()).hidden, true);
  assert.equal(parseSlide(z.get('ppt/slides/slide1.xml').toString()).hidden, false);
});

test('indent levels become real nesting, inside the parent <li>', () => {
  // the failure this guards: closing </li> before the sublist, which produces
  // invalid HTML *and* makes the sublist its own data-build step
  const html = listHtml({ ordered: false, items: [
    { level: 0, html: 'one' }, { level: 1, html: 'a' }, { level: 1, html: 'b' }, { level: 0, html: 'two' },
  ] });
  assert.equal(html, '<ul><li>one<ul><li>a</li><li>b</li></ul></li><li>two</li></ul>');

  // every <li> and <ul> closes exactly once
  assert.equal((html.match(/<li>/g) || []).length, (html.match(/<\/li>/g) || []).length);
  assert.equal((html.match(/<ul[ >]/g) || []).length, (html.match(/<\/ul>/g) || []).length);
});

test('a skipped indent level indents by one, inventing no empty bullets', () => {
  const html = listHtml({ ordered: false, items: [{ level: 0, html: 'a' }, { level: 3, html: 'deep' }] });
  assert.equal(html, '<ul><li>a<ul><li>deep</li></ul></li></ul>');
});

test('a numbered list becomes <ol>', () => {
  assert.match(listHtml({ ordered: true, items: [{ level: 0, html: 'x' }] }), /^<ol><li>x<\/li><\/ol>$/);
});

test('run formatting and links survive the crossing', () => {
  const p = find(parseXml('<a:p><a:r><a:rPr b="1" i="1"><a:hlinkClick r:id="rId9"/></a:rPr>'
    + '<a:t>both</a:t></a:r></a:p>'), 'a:p');
  const rels = new Map([['rId9', { target: 'https://example.com', type: '' }]]);
  assert.equal(paragraphHtml(p, { rels }), '<a href="https://example.com"><em><strong>both</strong></em></a>');
});

test('text is escaped on the way in', () => {
  const p = find(parseXml('<a:p><a:r><a:t>a &lt;b&gt; &amp; "c"</a:t></a:r></a:p>'), 'a:p');
  assert.equal(paragraphHtml(p), 'a &lt;b&gt; &amp; &quot;c&quot;');
});

test('speaker notes come across as lines', () => {
  const z = zip();
  assert.deepEqual(notesText(z.get('ppt/notesSlides/notesSlide1.xml').toString()),
    ['Open with the revenue line.', 'Then hand over to Sam.']);
  assert.deepEqual(notesText(undefined), [], 'a slide with no notes part has no notes');
});

test('what cannot cross is named, per slide, with what to rebuild it as', () => {
  const z = zip();
  const third = parseSlide(z.get('ppt/slides/slide3.xml').toString());
  assert.ok(third.drops.some((d) => /chart dropped.*data-chart/.test(d)));
  assert.equal(parseSlide(z.get('ppt/slides/slide1.xml').toString()).drops.length, 0,
    'a slide that converted cleanly reports nothing');
});

// ── SmartArt ──────────────────────────────────────────────────────────────

const DGM_DATA = `<dgm:dataModel xmlns:dgm="d" xmlns:a="a"><dgm:ptLst>
  <dgm:pt modelId="0" type="doc"/>
  <dgm:pt modelId="1"><dgm:t><a:p><a:r><a:t>Discover</a:t></a:r></a:p></dgm:t></dgm:pt>
  <dgm:pt modelId="2"><dgm:t><a:p><a:r><a:rPr b="1"/><a:t>Build</a:t></a:r></a:p></dgm:t></dgm:pt>
  <dgm:pt modelId="2a"><dgm:t><a:p><a:r><a:t>with a team</a:t></a:r></a:p></dgm:t></dgm:pt>
  <dgm:pt modelId="9" type="pres"><dgm:t><a:p><a:r><a:t>SCAFFOLD</a:t></a:r></a:p></dgm:t></dgm:pt>
 </dgm:ptLst><dgm:cxnLst>
  <dgm:cxn modelId="c2" srcId="0" destId="2" srcOrd="1" type="parOf"/>
  <dgm:cxn modelId="c1" srcId="0" destId="1" srcOrd="0" type="parOf"/>
  <dgm:cxn modelId="c3" srcId="2" destId="2a" srcOrd="0" type="parOf"/>
  <dgm:cxn modelId="cp" srcId="0" destId="9" srcOrd="2" type="presOf"/>
 </dgm:cxnLst></dgm:dataModel>`;

test('a SmartArt data model becomes a tree — in ITS order, without the drawing’s scaffolding', () => {
  const nodes = parseDiagram(DGM_DATA);
  // srcOrd decides, not document order: the file above lists Build first
  assert.deepEqual(nodes.map((n) => n.plain), ['Discover', 'Build']);
  assert.deepEqual(nodes[1].children.map((n) => n.plain), ['with a team']);
  // a `pres` point is a box the chosen layout needed, not a word anybody wrote
  assert.ok(!JSON.stringify(nodes).includes('SCAFFOLD'));
  // run formatting survives into the list form, and the plain text stays plain
  assert.equal(nodes[1].text, '<strong>Build</strong>');
  assert.equal(nodes[1].plain, 'Build');
});

test('a circular connection list ends, rather than recursing until the stack does', () => {
  const nodes = parseDiagram(`<dgm:dataModel xmlns:dgm="d" xmlns:a="a"><dgm:ptLst>
    <dgm:pt modelId="0" type="doc"/>
    <dgm:pt modelId="1"><dgm:t><a:p><a:r><a:t>one</a:t></a:r></a:p></dgm:t></dgm:pt>
   </dgm:ptLst><dgm:cxnLst>
    <dgm:cxn srcId="0" destId="1" srcOrd="0" type="parOf"/>
    <dgm:cxn srcId="1" destId="1" srcOrd="0" type="parOf"/>
   </dgm:cxnLst></dgm:dataModel>`);
  assert.deepEqual(nodes.map((n) => n.plain), ['one']);
  assert.deepEqual(nodes[0].children, []);
});

test('the layout part says which picture was drawn', () => {
  const of = (id) => diagramKind(`<dgm:layoutDef uniqueId="urn:microsoft.com/office/officeart/2005/8/layout/${id}"/>`);
  assert.equal(of('process1'), 'process');
  assert.equal(of('chevron2'), 'process');
  assert.equal(of('cycle3'), 'cycle');
  assert.equal(of('hierarchy1'), 'hierarchy');
  assert.equal(of('vList2'), 'list');
  assert.equal(diagramKind(undefined), 'list', 'no layout part is a list, not a crash');
});

test('a flat process is drawn; anything else keeps its words as a list', () => {
  const steps = ['a', 'b', 'c'].map((t) => ({ text: t, plain: t, children: [] }));
  const drawn = diagramBlockHtml({ shape: 'process', nodes: steps });
  assert.equal(drawn.as, 'an SVG diagram');
  assert.match(drawn.html, /^<svg viewBox="0 0 960 120"/);
  assert.equal((drawn.html.match(/<rect/g) || []).length, 3, 'a box per step');
  assert.equal((drawn.html.match(/marker-end/g) || []).length, 2, 'an arrow between, and none after the last');
  assert.match(drawn.html, /var\(--d-fill-1\)/, 'themed, so it re-colors like every other diagram');

  // a cycle is the same strip with the way back drawn under it
  const cycle = diagramBlockHtml({ shape: 'cycle', nodes: steps });
  assert.match(cycle.html, /<path d="M /, 'the return leg');

  // seven boxes across 960px cannot be read; the words can
  const many = diagramBlockHtml({ shape: 'process', nodes: Array.from({ length: 7 }, (_, i) => ({ text: `s${i}`, plain: `s${i}`, children: [] })) });
  assert.equal(many.as, 'a nested list');
  assert.match(many.html, /^<ol>/, 'a process that has to be a list is still ordered');

  // a hierarchy has a shape decklight will not fake, so it keeps the words
  const tree = diagramBlockHtml({ shape: 'hierarchy', nodes: [{ text: 'top', plain: 'top', children: [{ text: 'under', plain: 'under', children: [] }] }] });
  assert.equal(tree.as, 'a nested list');
  assert.equal(tree.html, '<ul><li>top<ul><li>under</li></ul></li></ul>');
});

test('SmartArt whose data cannot be read is still a loud drop', () => {
  const xml = '<p:sld><p:cSld><p:spTree><p:graphicFrame><a:graphic>'
    + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>'
    + '</a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>';
  const slide = parseSlide(xml, { rels: new Map(), diagramOf: () => null });
  assert.equal(slide.blocks.length, 0);
  assert.ok(slide.drops.some((d) => /SmartArt dropped.*could not be read/.test(d)));
});

// ── diagrams somebody DREW ─────────────────────────────────────────────────

const M = 9525;   // EMU per pixel
const shapeXml = (id, x, y, w, h, prst, text) => `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${x * M}" y="${y * M}"/><a:ext cx="${w * M}" cy="${h * M}"/></a:xfrm>
   <a:prstGeom prst="${prst}"/></p:spPr>
  <p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const cxnXml = (id, from, to) => `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="c"/>
  <p:cNvCxnSpPr>${from ? `<a:stCxn id="${from}" idx="3"/>` : ''}${to ? `<a:endCxn id="${to}" idx="1"/>` : ''}</p:cNvCxnSpPr>
  <p:nvPr/></p:nvCxnSpPr><p:spPr/></p:cxnSp>`;
const slideXml = (inner) => `<p:sld><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`;

test('a placed shape reports its box in pixels; one the slide never placed reports none', () => {
  const doc = parseXml(shapeXml(2, 40, 200, 220, 96, 'rect', 'x'));
  assert.deepEqual(shapeBox(find(doc, 'p:sp')), { x: 40, y: 200, w: 220, h: 96, flipH: false, flipV: false });
  assert.equal(shapeBox(find(parseXml('<p:sp><p:spPr/></p:sp>'), 'p:sp')), null);
});

test('boxes with an attached arrow between them are a diagram; two text boxes are not', () => {
  const box = (id) => ({ id: String(id), box: { x: id * 100, y: 0, w: 80, h: 40 }, prst: 'rect', plain: `b${id}` });
  assert.ok(asDrawing([box(1), box(2)], [{ from: '1', to: '2' }]), 'two boxes and an attached connector');
  assert.equal(asDrawing([box(1), box(2)], [{ from: '1', to: null }]), null,
    'a line that is not attached at both ends is a line, not a diagram');
  assert.equal(asDrawing([box(1)], [{ from: '1', to: '1' }]), null, 'one shape is never an arrangement');
  // the box is the union of the shapes, with room to breathe
  const d = asDrawing([box(1), box(2)], [{ from: '1', to: '2' }]);
  assert.deepEqual(d.box, { x: 88, y: -12, w: 204, h: 64 });
});

test('a drawn slide crosses as one diagram — the shapes’ own text goes with it', () => {
  const slide = parseSlide(slideXml(
    `<p:sp><p:nvSpPr><p:cNvPr id="1" name="t"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>How an order flows</a:t></a:r></a:p></p:txBody></p:sp>`
    + shapeXml(2, 60, 230, 220, 96, 'roundRect', 'Client')
    + shapeXml(3, 420, 230, 220, 96, 'rect', 'Order service')
    + shapeXml(4, 780, 230, 220, 96, 'ellipse', 'Ledger')
    + cxnXml(5, 2, 3) + cxnXml(6, 3, 4)), { rels: new Map() });

  assert.equal(slide.title, 'How an order flows', 'the placeholder title is still the title');
  assert.deepEqual(slide.blocks.map((b) => b.kind), ['drawing'],
    'the boxes’ words are IN the picture, not beside it as stray bullets');
  assert.deepEqual(slide.drops, []);

  const svg = drawingSvg(slide.blocks[0].drawing);
  assert.equal((svg.match(/<rect/g) || []).length, 2, 'rect and roundRect');
  assert.equal((svg.match(/<ellipse/g) || []).length, 1);
  assert.equal((svg.match(/<line/g) || []).length, 2, 'an arrow per connector');
  assert.match(svg, /Order service/);
  assert.match(svg, /var\(--d-fill-1\)/, 'themed like every other diagram');
  // the arrows stop at the boxes' EDGES, not their middles: the first box
  // spans x 12–232 in the diagram's own coordinates, and the line starts there
  assert.match(svg, /<line x1="232" y1="60" x2="372"/);
});

test('shapes that do not add up to a diagram keep today’s answer — and now say what was lost', () => {
  // three boxes, no connector: the words still cross as text, as they always
  // did, but the slide no longer stays silent about the arrangement
  const three = parseSlide(slideXml(
    shapeXml(2, 40, 200, 200, 90, 'rect', 'one') + shapeXml(3, 300, 200, 200, 90, 'rect', 'two')
    + shapeXml(4, 560, 200, 200, 90, 'rect', 'three')), { rels: new Map() });
  assert.deepEqual(three.blocks.map((b) => b.kind), ['list', 'list', 'list']);
  assert.ok(three.drops.some((d) => /3 drawn shapes came across as text/.test(d)));
  assert.ok(!three.blocks.some((b) => 'placed' in b), 'the bookkeeping does not leak into the deck');

  // two of them, though, is a layout — and warning about every two-column
  // slide is how a report stops being read
  const two = parseSlide(slideXml(
    shapeXml(2, 40, 200, 200, 90, 'rect', 'left') + shapeXml(3, 300, 200, 200, 90, 'rect', 'right')), { rels: new Map() });
  assert.deepEqual(two.drops, []);
});

test('the fixture’s drawn slide crosses as a diagram', () => {
  const { sections, report } = convert(zip());
  assert.match(sections[3], /<h2>How an order flows<\/h2>/);
  assert.match(sections[3], /<svg viewBox="0 0 \d+ \d+"/);
  assert.match(sections[3], /Order service/);
  assert.ok(!/<ul>/.test(sections[3]), 'the boxes are not also bullets');
  assert.ok(report[3].did.some((d) => /^3 drawn shapes as an SVG diagram$/.test(d)));
});

test('the fixture’s SmartArt crosses as a drawn process, and says so', () => {
  const { sections, report } = convert(zip());
  assert.match(sections[2], /<svg viewBox="0 0 960 120"/);
  assert.match(sections[2], /General availability/, 'the last step is on the slide');
  assert.ok(!/PRESENTATION SCAFFOLD/.test(sections[2]), 'the layout’s own boxes are not words');
  assert.ok(report[2].did.some((d) => /^SmartArt \(process, 4 nodes\) as an SVG diagram$/.test(d)));
  assert.ok(!report[2].drops.some((d) => /SmartArt/.test(d)));
});

test('image mime types come from the file name', () => {
  assert.equal(mimeOf('ppt/media/image1.png'), 'image/png');
  assert.equal(mimeOf('a/b/photo.JPEG'), 'image/jpeg');
  assert.equal(mimeOf('x.heic'), 'application/octet-stream', 'and an unknown one is not guessed');
});

// ── the whole conversion ──────────────────────────────────────────────────

test('the fixture converts to five slides — four shown, the hidden one KEPT and marked', () => {
  const { sections, report } = convert(zip());
  assert.equal(sections.length, 5, 'a hidden slide is kept, not dropped (HIDDEN_SLIDES)');
  assert.equal(report.length, 5);
  assert.equal(report[4].hidden, true);
  assert.match(sections[4], /^\s*<section data-hidden>/);
  assert.doesNotMatch(sections[0] + sections[1] + sections[2] + sections[3], /data-hidden/);

  assert.match(sections[0], /<h1>Q3 &amp; Beyond<\/h1>/);
  assert.match(sections[0], /<p>What shipped, what did not<\/p>/, 'the subtitle feeds the DECK_ANATOMY subtitle rule');
  assert.match(sections[1], /<aside class="notes">/);
  assert.match(sections[2], /<table><thead><tr><th>Region<\/th>/);
  assert.match(sections[2], /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="The logo">/);
});

test("PowerPoint's own build list decides which lists step", () => {
  // <p:bldP> is the real signal — the shape PowerPoint reveals a paragraph at
  // a time is exactly the one that should carry data-build
  assert.match(convert(zip()).sections[1], /<ul data-build="fade-up">/);
  assert.doesNotMatch(convert(zip(), { build: 'none' }).sections[1], /data-build/);
  assert.match(convert(zip(), { build: 'all' }).sections[1], /data-build="fade-up"/);
});

test('a report line says what converted', () => {
  const { report } = convert(zip());
  assert.ok(report[1].did.includes('5 bullets'));
  assert.ok(report[1].did.includes('notes'));
  assert.ok(report[2].did.some((d) => /^table 2×2$/.test(d)));
  assert.ok(report[2].did.some((d) => /^image inlined/.test(d)));
});

// ── the three front doors ─────────────────────────────────────────────────

test('each source kind is recognised before anything is fetched', () => {
  assert.equal(sourceKind('deck.pptx'), 'pptx');
  assert.equal(sourceKind('/a/b/Talk.PPTX'), 'pptx');
  assert.equal(sourceKind('deck.key'), 'keynote');
  assert.equal(sourceKind('old.ppt'), 'ppt', 'the pre-2007 binary format is its own case');
  assert.equal(sourceKind('https://docs.google.com/presentation/d/1AbC_dEf-23/edit#slide=id.p'), 'gslides');
  assert.equal(sourceKind('https://example.com/deck.pptx'), 'url', 'some other URL is not a Slides link');
  assert.equal(sourceKind('notes.md'), 'unknown');
});

test('a Google Slides URL yields its document id and export URL', () => {
  assert.equal(slidesId('https://docs.google.com/presentation/d/1AbC_dEf-23/edit'), '1AbC_dEf-23');
  assert.equal(slidesId('https://docs.google.com/presentation/d/e/2PACX-1vAbc/pub'), '2PACX-1vAbc',
    'a published-to-web URL carries its id after /d/e/');
  assert.equal(slidesId('https://docs.google.com/document/d/1AbC/edit'), null, 'a Doc is not a deck');
  assert.match(slidesExportUrl('1AbC'), /\/presentation\/d\/1AbC\/export\/pptx$/);
});

test('the keynote export is scripted against Keynote, with the paths quoted', () => {
  // a deck called  My Deck".key  must not be able to end the AppleScript string
  const script = keynoteScript('/tmp/My "Q3" Deck.key', '/tmp/out');
  assert.match(script, /tell application "Keynote"/);
  assert.match(script, /as Microsoft PowerPoint/);
  assert.match(script, /"\/tmp\/My \\"Q3\\" Deck\.key"/, 'the quote is escaped, not closed');
});

test('the output lands beside the source, named after it', () => {
  assert.equal(outPath('/talks/Q3 Business Review.pptx'), path.resolve('q3-business-review.html'));
  assert.equal(outPath('deck.key'), path.resolve('deck.html'));
  // resolve(), not the literal: `-o` is resolved against cwd, and on Windows
  // '/tmp/out.html' resolves onto the current drive as 'D:\\tmp\\out.html'.
  // What the test means is "-o is honoured verbatim", not "POSIX paths".
  assert.equal(outPath('x.pptx', '/tmp/out.html'), path.resolve('/tmp/out.html'));
  assert.equal(slug('  Q3 — Business Review!  '), 'q3-business-review');
  assert.equal(slug('***'), 'deck', 'a name with nothing usable still yields a file name');
});

// ── the CLI ───────────────────────────────────────────────────────────────

test('import writes a self-contained deck that needs no sibling files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-import-'));
  try {
    const out = path.join(dir, 'deck.html');
    const r = spawnSync('node', [CLI, 'import', FIXTURE, '-o', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /<style data-decklight-runtime="css">/);
    assert.match(html, /<script data-decklight-runtime="js">/);
    assert.match(html, /<style data-theme="midnight">/);
    assert.equal((html.match(/<section>/g) || []).length, 4);
    assert.doesNotMatch(html, /<link rel="stylesheet"/, 'nothing to fetch from disk');
    assert.doesNotMatch(html, /src="ppt\//, 'the image is inlined, not referenced');

    // the report names the drops with their slide numbers
    assert.match(r.stderr, /3 {2}⚠/);
    assert.match(r.stderr, /chart dropped/);
    assert.match(r.stderr, /⊘ hidden — kept as data-hidden/);
    assert.match(r.stderr, /5 slides \(1 hidden\) · theme midnight/);
  } finally { rmTemp(dir); }
});

test('a drop is a warning, not a failure — only an unreadable deck fails', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-import-'));
  try {
    const out = path.join(dir, 'd.html');
    // slide 3 drops a chart it cannot draw, and the command still succeeds
    assert.equal(spawnSync('node', [CLI, 'import', FIXTURE, '-o', out], { encoding: 'utf8' }).status, 0);

    const junk = path.join(dir, 'junk.pptx');
    writeFileSync(junk, 'not an office file at all');
    const bad = spawnSync('node', [CLI, 'import', junk, '-o', path.join(dir, 'x.html')], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not a zip file/);
    assert.doesNotMatch(bad.stderr, /at .*\.mjs:\d+/, 'no stack trace');
  } finally { rmTemp(dir); }
});

test('import refuses to overwrite without --force, and refuses an unknown theme', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-import-'));
  try {
    const out = path.join(dir, 'deck.html');
    writeFileSync(out, 'mine');
    const clash = spawnSync('node', [CLI, 'import', FIXTURE, '-o', out], { encoding: 'utf8' });
    assert.equal(clash.status, 1);
    assert.match(clash.stderr, /already exists — pass --force/);
    assert.equal(readFileSync(out, 'utf8'), 'mine', 'and the existing file is untouched');

    assert.equal(spawnSync('node', [CLI, 'import', FIXTURE, '-o', out, '--force'], { encoding: 'utf8' }).status, 0);
    assert.notEqual(readFileSync(out, 'utf8'), 'mine');

    const theme = spawnSync('node', [CLI, 'import', FIXTURE, '-o', path.join(dir, 'b.html'), '--theme', 'nope'], { encoding: 'utf8' });
    assert.equal(theme.status, 1);
    assert.match(theme.stderr, /no theme "nope"/);
    assert.match(theme.stderr, /available: .*midnight/, 'and it lists what there is');
  } finally { rmTemp(dir); }
});

test('the doors that cannot open here say what to do instead', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-import-'));
  try {
    const ppt = path.join(dir, 'old.ppt');
    writeFileSync(ppt, 'x');
    const legacy = spawnSync('node', [CLI, 'import', ppt], { encoding: 'utf8' });
    assert.equal(legacy.status, 1);
    assert.match(legacy.stderr, /pre-2007 binary format/);
    assert.match(legacy.stderr, /save as \.pptx first/);

    const notSlides = spawnSync('node', [CLI, 'import', 'https://example.com/x'], { encoding: 'utf8' });
    assert.equal(notSlides.status, 1);
    assert.match(notSlides.stderr, /not a Google Slides presentation/);

    const odd = spawnSync('node', [CLI, 'import', path.join(dir, 'notes.md')], { encoding: 'utf8' });
    assert.equal(odd.status, 1);
    assert.match(odd.stderr, /supported: \.pptx, \.key \(macOS\), or a Google Slides URL/);
  } finally { rmTemp(dir); }
});

test('import is routed and documented by the dispatcher', () => {
  const help = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help, /^  import {3}/m);
  const own = execFileSync('node', [CLI, 'import', '--help'], { encoding: 'utf8' });
  assert.match(own, /usage: decklight import/);
  assert.match(own, /--build all\|none\|auto/);
});


// ── charts: the values were in the file all along ───────────────────────────

const BAR_CHART = `<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart>
  <c:title><c:tx><c:rich><a:p><a:r><a:t>Latency by </a:t></a:r><a:r><a:t>release</a:t></a:r></a:p></c:rich></c:tx></c:title>
  <c:plotArea><c:barChart><c:barDir val="col"/>
    <c:ser><c:idx val="0"/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>p50</c:v></c:pt></c:strCache></c:strRef></c:tx>
      <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>v1</c:v></c:pt><c:pt idx="1"><c:v>v2</c:v></c:pt><c:pt idx="2"><c:v>v3</c:v></c:pt></c:strCache></c:strRef></c:cat>
      <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>120</c:v></c:pt><c:pt idx="2"><c:v>45</c:v></c:pt><c:pt idx="1"><c:v>80</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>
    <c:ser><c:idx val="1"/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>p99</c:v></c:pt></c:strCache></c:strRef></c:tx>
      <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>340</c:v></c:pt><c:pt idx="1"><c:v>260</c:v></c:pt><c:pt idx="2"><c:v>190</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>
  </c:barChart></c:plotArea></c:chart></c:chartSpace>`;

test('a bar chart becomes data-chart JSON — labels, named series, values in index order', () => {
  const c = parseChart(BAR_CHART);
  assert.equal(c.type, 'bar');
  assert.equal(c.title, 'Latency by release', 'a title split across runs is one title');
  assert.deepEqual(c.labels, ['v1', 'v2', 'v3']);
  // p50's points arrive out of order in the cache (idx 0, 2, 1) and are sorted by idx
  assert.deepEqual(c.series, [{ name: 'p50', data: [120, 80, 45] }, { name: 'p99', data: [340, 260, 190] }]);
});

test('a pie keeps ONE series — decklight refuses two, PowerPoint draws one anyway', () => {
  const pie = BAR_CHART.replace(/c:barChart/g, 'c:pieChart');
  const c = parseChart(pie);
  assert.equal(c.type, 'pie');
  assert.equal(c.series.length, 1);
  assert.equal(parseChart(BAR_CHART.replace(/c:barChart/g, 'c:doughnutChart')).type, 'donut');
  assert.equal(parseChart(BAR_CHART.replace(/c:barChart/g, 'c:lineChart')).type, 'line');
});

test('a chart kind with no native answer is null — the caller drops it by name, as before', () => {
  assert.equal(parseChart(BAR_CHART.replace(/c:barChart/g, 'c:scatterChart')), null);
  assert.equal(parseChart('<c:chartSpace/>'), null);
  assert.equal(parseChart(''), null);
});

test('the slide reaches the chart through its relationship, and renders SPEC CHARTS markup', () => {
  const slide = '<p:sld><p:cSld><p:spTree><p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    + '<c:chart r:id="rId3"/></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>';
  const rels = new Map([['rId3', { target: '../charts/chart1.xml', type: '…/chart' }]]);
  const parsed = parseSlide(slide, { rels, chartOf: (target) => (target.endsWith('chart1.xml') ? BAR_CHART : null) });
  assert.equal(parsed.drops.length, 0, 'a chart that could be read is not a drop');
  assert.equal(parsed.blocks[0].kind, 'chart');
  const { html, did } = slideSection(parsed);
  assert.match(html, /<div class="chart" data-chart="bar" data-title="Latency by release">/);
  assert.match(html, /<script type="application\/json">\{"labels":\["v1","v2","v3"\],"series":\[\{"name":"p50"/);
  assert.ok(did.some((d) => /chart \(bar, 2 series × 3\)/.test(d)));
  // without a reader for the part, it is the old loud drop — never a silent one
  const noReader = parseSlide(slide, { rels });
  assert.ok(noReader.drops.some((d) => /chart dropped/.test(d)));
});

test('chart JSON cannot end the script tag early', () => {
  const html = chartHtml({ type: 'bar', title: '', labels: ['</script><img src=x onerror=alert(1)>'], series: [{ name: 'a', data: [1] }] });
  assert.doesNotMatch(html, /<\/script><img/);
  assert.match(html, /<\\\/script>/);
});

test('a PowerPoint hidden slide is kept as a hidden decklight slide, not dropped', () => {
  const hidden = parseSlide('<p:sld show="0"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Later</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
  assert.equal(hidden.hidden, true);
  assert.match(slideSection(hidden).html, /^\s*<section data-hidden>/);
  const shown = parseSlide('<p:sld><p:cSld><p:spTree/></p:cSld></p:sld>');
  assert.match(slideSection(shown).html, /^\s*<section>/);
});
