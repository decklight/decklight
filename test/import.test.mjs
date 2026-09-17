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
  parseDiagram, diagramKind, diagramBlockHtml, shapeBox, asDrawing, drawingSvg, groupFrame, placeIn, drawnIntent, rotationOf, POLYGONS, customPathD, attachLoose } from '../tools/pptx.mjs';
import { convert, outPath, slidesId, slidesExportUrl, sourceKind, slug, keynoteScript } from '../cli/import.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const FIXTURE = path.resolve(here, 'fixtures/sample.pptx');
const zip = () => unzip(readFileSync(FIXTURE));
// The shape fixture, written by python-pptx (test/fixtures/make-shapes.py) so it
// carries what PowerPoint itself writes — see the tests at the end of this file.
const SHAPES = path.resolve(here, 'fixtures/shapes.pptx');
const shapesZip = () => unzip(readFileSync(SHAPES));

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

// ── grouped shapes: a child's box is in its GROUP's space, not the slide's ──
const grpXml = (off, ext, chOff, chExt, inner) => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="90" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
  <p:grpSpPr><a:xfrm><a:off x="${off[0] * M}" y="${off[1] * M}"/><a:ext cx="${ext[0] * M}" cy="${ext[1] * M}"/>
    <a:chOff x="${chOff[0] * M}" y="${chOff[1] * M}"/><a:chExt cx="${chExt[0] * M}" cy="${chExt[1] * M}"/></a:xfrm></p:grpSpPr>
  ${inner}</p:grpSp>`;

test('a group that was moved and resized places its children where PowerPoint shows them', () => {
  // the group's child space is 200×100 at the origin; on the slide it sits at
  // (100,100) stretched to 400×200 — so a child at (50,25) 100×50 shows at
  // (200,150) 200×100. Reading the child's own box put it at (50,25).
  const frame = groupFrame(find(parseXml(grpXml([100, 100], [400, 200], [0, 0], [200, 100], '')), 'p:grpSp'));
  assert.deepEqual(frame, { x: 100 * M, y: 100 * M, cx: 0, cy: 0, sx: 2, sy: 2 });
  const child = find(parseXml(shapeXml(2, 50, 25, 100, 50, 'rect', 'x')), 'p:sp');
  assert.deepEqual(shapeBox(child, [frame]), { x: 200, y: 150, w: 200, h: 100, flipH: false, flipV: false });
  assert.deepEqual(shapeBox(child), { x: 50, y: 25, w: 100, h: 50, flipH: false, flipV: false }, 'ungrouped, as before');

  // a moved group with no resize: chExt equals ext, so the children only shift
  const moved = groupFrame(find(parseXml(grpXml([300, 40], [200, 100], [0, 0], [200, 100], '')), 'p:grpSp'));
  assert.deepEqual(shapeBox(child, [moved]), { x: 350, y: 65, w: 100, h: 50, flipH: false, flipV: false });
  // a group with no transform at all leaves its children in the parent's space
  assert.equal(groupFrame(find(parseXml('<p:grpSp><p:grpSpPr/></p:grpSp>'), 'p:grpSp')), null);
  // a zero child extent scales nothing on that axis — it only moves
  assert.equal(placeIn({ x: 10, y: 10, w: 5, h: 5 }, { x: 100, y: 100, cx: 0, cy: 0, sx: 1, sy: 1 }).w, 5);
});

test('nested groups compose, outermost first', () => {
  // outer: child space 400×400 at origin → slide (0,0) 800×800 (×2)
  // inner: child space 100×100 at (0,0) → outer space (100,100) 200×200 (×2)
  // a shape at (10,10) 20×20 in the inner space → outer (120,120) 40×40 → slide (240,240) 80×80
  const outer = { x: 0, y: 0, cx: 0, cy: 0, sx: 2, sy: 2 };
  const inner = { x: 100 * M, y: 100 * M, cx: 0, cy: 0, sx: 2, sy: 2 };
  const shape = find(parseXml(shapeXml(2, 10, 10, 20, 20, 'rect', 'x')), 'p:sp');
  assert.deepEqual(shapeBox(shape, [outer, inner]), { x: 240, y: 240, w: 80, h: 80, flipH: false, flipV: false });
});

test('a grouped diagram crosses with its shapes where the slide shows them, arrows included', () => {
  // Three boxes and two attached arrows, grouped, then the group dragged to
  // the right half of the slide and doubled in size. The diagram's own box is
  // the union of the PLACED shapes: at child coordinates it would sit at the
  // top-left and be half the size.
  const inner = shapeXml(2, 0, 0, 100, 40, 'roundRect', 'Client')
    + shapeXml(3, 150, 0, 100, 40, 'rect', 'Service')
    + shapeXml(4, 300, 0, 100, 40, 'ellipse', 'Ledger')
    + cxnXml(5, 2, 3) + cxnXml(6, 3, 4);
  const slide = parseSlide(slideXml(grpXml([640, 300], [800, 80], [0, 0], [400, 40], inner)), { rels: new Map() });
  assert.deepEqual(slide.blocks.map((b) => b.kind), ['drawing']);
  const d = slide.blocks[0].drawing;
  assert.deepEqual(d.shapes.map((s) => [s.box.x, s.box.y, s.box.w, s.box.h]),
    [[640, 300, 200, 80], [940, 300, 200, 80], [1240, 300, 200, 80]]);
  assert.deepEqual(d.box, { x: 628, y: 288, w: 824, h: 104 });
  // and the SVG is drawn in the placed coordinates: the first arrow leaves the
  // first box's right edge, 12px of padding in from the diagram's left
  assert.match(drawingSvg(d), /<line x1="212" y1="52" x2="312"/);
});

// ── the per-shape rule (--shapes auto), lines, transforms, presets, wordy boxes ──
const sp2 = (id, x, y, w, h, prst, text, { txBox = false, rot = 0, flipH = false, noFill = false, body = null, custom = false } = {}) => `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="s${id}"/><p:cNvSpPr${txBox ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm${rot ? ` rot="${rot * 60000}"` : ''}${flipH ? ' flipH="1"' : ''}><a:off x="${x * M}" y="${y * M}"/><a:ext cx="${w * M}" cy="${h * M}"/></a:xfrm>
   ${custom ? '<a:custGeom><a:pathLst/></a:custGeom>' : `<a:prstGeom prst="${prst}"/>`}${noFill ? '<a:noFill/>' : ''}</p:spPr>
  ${body ?? `<p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody>`}</p:sp>`;
const looseLine = (id, x, y, w, h, { flipH = false, tail = 'triangle', head = null } = {}) => `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="l"/>
  <p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>
  <p:spPr><a:xfrm${flipH ? ' flipH="1"' : ''}><a:off x="${x * M}" y="${y * M}"/><a:ext cx="${w * M}" cy="${h * M}"/></a:xfrm>
   <a:prstGeom prst="straightConnector1"/><a:ln>${head ? `<a:headEnd type="${head}"/>` : ''}${tail ? `<a:tailEnd type="${tail}"/>` : ''}</a:ln></p:spPr></p:cxnSp>`;
const parse = (inner, shapes) => parseSlide(slideXml(inner), { rels: new Map(), shapes });

test('--shapes auto believes a DRAWN shape; strict still wants an attached arrow; two text boxes are never a drawing', () => {
  const chevronAndBox = sp2(2, 40, 200, 200, 90, 'chevron', 'Plan') + sp2(3, 300, 200, 200, 90, 'rect', 'Build');
  assert.deepEqual(parse(chevronAndBox, 'strict').blocks.map((b) => b.kind), ['list', 'list'], 'strict: no connector, no drawing');
  assert.deepEqual(parse(chevronAndBox, 'auto').blocks.map((b) => b.kind), ['drawing'], 'auto: a chevron was drawn, not typed');
  // the strict report says what auto would have done
  assert.ok(parse(chevronAndBox, 'strict').drops.some((d) => /--shapes auto would draw it/.test(d)));

  // two text boxes — flagged as such, or plain rects — are a layout under every mode
  const twoTextBoxes = sp2(2, 40, 200, 200, 90, 'rect', 'left', { txBox: true }) + sp2(3, 300, 200, 200, 90, 'rect', 'right', { txBox: true });
  assert.deepEqual(parse(twoTextBoxes, 'auto').blocks.map((b) => b.kind), ['list', 'list']);
  assert.deepEqual(parse(twoTextBoxes, 'auto').drops, []);
  // a text box flagged txBox never lends intent, whatever its preset says
  const flaggedChevron = sp2(2, 40, 200, 200, 90, 'chevron', 'a', { txBox: true }) + sp2(3, 300, 200, 200, 90, 'rect', 'b');
  assert.deepEqual(parse(flaggedChevron, 'auto').blocks.map((b) => b.kind), ['list', 'list']);
  // hand-drawn geometry is intent too
  const custom = sp2(2, 40, 200, 200, 90, '', 'blob', { custom: true }) + sp2(3, 300, 200, 200, 90, 'rect', 'b');
  assert.deepEqual(parse(custom, 'auto').blocks.map((b) => b.kind), ['drawing']);
  assert.ok(drawnIntent({ prst: '', custom: true, textBox: false }));
  assert.ok(!drawnIntent({ prst: 'rect', custom: false, textBox: false }));
  assert.ok(!drawnIntent({ prst: 'chevron', custom: false, textBox: true }));
});

test('--shapes text never draws, and does not complain about it', () => {
  const drawn = sp2(2, 60, 230, 220, 96, 'roundRect', 'Client') + sp2(3, 420, 230, 220, 96, 'rect', 'Service') + cxnXml(5, 2, 3);
  const t = parse(drawn, 'text');
  assert.deepEqual(t.blocks.map((b) => b.kind), ['list', 'list']);
  assert.deepEqual(t.drops, [], 'asked for by name, so not a loss');
  assert.deepEqual(parse(drawn, 'strict').blocks.map((b) => b.kind), ['drawing'], 'the same slide draws under strict');
});

test('a line attached at neither end is drawn from its own place, with the arrowhead the file gave it', () => {
  // two boxes and a loose arrow floating between them, 30px clear of both:
  // under auto the line is the intent, and it stays a free line
  const inner = sp2(2, 40, 200, 200, 90, 'rect', 'a') + sp2(3, 400, 200, 200, 90, 'rect', 'b') + looseLine(9, 270, 245, 100, 0);
  const slide = parse(inner, 'auto');
  assert.deepEqual(slide.blocks.map((b) => b.kind), ['drawing']);
  const d = slide.blocks[0].drawing;
  assert.equal(d.loose.length, 1);
  assert.deepEqual(d.loose[0].geo, { x1: 270, y1: 245, x2: 370, y2: 245, headArrow: false, tailArrow: true });
  const svg = drawingSvg(d);
  // the diagram's box starts 12px up and left of the first shape (28,188), so the line runs (242,57) → (342,57)
  assert.match(svg, /<line x1="242" y1="57" x2="342" y2="57"[^>]*marker-end="url\(#dwg-arrow\)"/);
  assert.ok(!/marker-start/.test(svg), 'no head arrow was asked for');
  assert.match(svg, /orient="auto-start-reverse"/, 'one marker serves both ends');
  // flipped: the line runs the other way; a head arrow becomes marker-start
  const flipped = parse(sp2(2, 40, 200, 200, 90, 'rect', 'a') + sp2(3, 400, 200, 200, 90, 'rect', 'b')
    + looseLine(9, 270, 245, 100, 0, { flipH: true, tail: null, head: 'arrow' }), 'auto').blocks[0].drawing;
  assert.deepEqual(flipped.loose[0].geo, { x1: 370, y1: 245, x2: 270, y2: 245, headArrow: true, tailArrow: false });
  assert.match(drawingSvg(flipped), /marker-start="url\(#dwg-arrow\)"/);
  // a line drawn as a SHAPE (prst line) is a line too — it never becomes a box
  const asShape = parse(sp2(2, 40, 200, 200, 90, 'rect', 'a') + sp2(3, 400, 200, 200, 90, 'rect', 'b') + sp2(9, 270, 245, 100, 0, 'line', ''), 'auto');
  assert.equal(asShape.blocks[0].drawing.shapes.length, 2);
  assert.equal(asShape.blocks[0].drawing.loose.length, 1);
  // strict still wants an ATTACHED arrow: the loose line alone does not draw, and the report says auto would
  const strict = parse(inner, 'strict');
  assert.deepEqual(strict.blocks.map((b) => b.kind), ['list', 'list']);
  assert.ok(strict.drops.some((d) => /--shapes auto would draw it/.test(d)));
});

test('a line that LANDS on two shapes is attached to them under auto — direction kept, strict unmoved', () => {
  const boxes = sp2(2, 40, 200, 200, 90, 'rect', 'a') + sp2(3, 400, 200, 200, 90, 'rect', 'b');
  // drawn from a's right edge to b's left edge, never snapped: the file has no stCxn/endCxn
  const d = parse(boxes + looseLine(9, 240, 245, 160, 0), 'auto').blocks[0].drawing;
  assert.equal(d.loose.length, 0, 'not loose any more');
  const link = d.links.find((l) => l.inferred);
  assert.deepEqual([link.from, link.to], ['2', '3']);
  // …and drawn where the file drew it — here edge to edge — arrow at b
  assert.match(drawingSvg(d), /<line x1="212" y1="57" x2="372" y2="57"[^>]*marker-end="url\(#dwg-arrow\)"/);
  assert.ok(!/marker-start/.test(drawingSvg(d)));

  // within 8px counts; a head-only arrow points backwards, so the ends swap —
  // and the line is still drawn exactly where the file drew it, head at its start
  const back = parse(boxes + looseLine(9, 246, 245, 148, 0, { tail: null, head: 'triangle' }), 'auto').blocks[0].drawing;
  const l2 = back.links.find((l) => l.inferred);
  assert.deepEqual([l2.from, l2.to], ['3', '2']);
  assert.match(drawingSvg(back), /<line x1="218" y1="57" x2="366" y2="57"[^>]*marker-start="url\(#dwg-arrow\)"\/>/);
  // a plain line between them is a line, not an arrow; arrows at both ends are both
  const plain = drawingSvg(parse(boxes + looseLine(9, 240, 245, 160, 0, { tail: null }), 'auto').blocks[0].drawing);
  assert.ok(!/marker-/.test(plain), 'no head asked for, none drawn');
  const both = drawingSvg(parse(boxes + looseLine(9, 240, 245, 160, 0, { tail: 'triangle', head: 'triangle' }), 'auto').blocks[0].drawing);
  assert.match(both, /marker-start="url\(#dwg-arrow\)"[^>]*marker-end="url\(#dwg-arrow\)"|marker-start[^>]*marker-end/);
  // both ends in the same box is not an attachment
  const same = parse(boxes + looseLine(9, 60, 220, 100, 30), 'auto').blocks[0].drawing;
  assert.equal(same.loose.length, 1);
  // strict believes only the file's own attachments
  const strict = parse(boxes + looseLine(9, 240, 245, 160, 0), 'strict');
  assert.deepEqual(strict.blocks.map((b) => b.kind), ['list', 'list']);
  assert.deepEqual(attachLoose([{ id: '1', box: { x: 0, y: 0, w: 10, h: 10 } }], [{ from: null, to: null, geo: { x1: 0, y1: 0, x2: 5, y2: 5 } }])[0].from, null,
    'one shape cannot be attached to itself');
});

test('hand-drawn geometry crosses as the path it is, scaled onto its box', () => {
  const geom = (paths) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
    <p:spPr><a:xfrm><a:off x="${40 * M}" y="${200 * M}"/><a:ext cx="${200 * M}" cy="${90 * M}"/></a:xfrm>
      <a:custGeom><a:pathLst>${paths}</a:pathLst></a:custGeom></p:spPr>
    <p:txBody><a:p><a:r><a:t>blob</a:t></a:r></a:p></p:txBody></p:sp>`;
  const pt = (x, y) => `<a:pt x="${x}" y="${y}"/>`;
  const tri = `<a:path w="100" h="100"><a:moveTo>${pt(0, 0)}</a:moveTo><a:lnTo>${pt(100, 0)}</a:lnTo><a:lnTo>${pt(50, 100)}</a:lnTo><a:close/></a:path>`;
  const node = find(parseXml(geom(tri)), 'p:sp');
  const box = shapeBox(node);
  assert.deepEqual(customPathD(node, box), [{ d: 'M40 200L240 200L140 290Z', fill: true, stroke: true }], 'path space 100×100 → the 200×90 box');

  // an arc: from (0,50) sweeping −180° with radius 50 lands at (100,50) — an SVG arc from the current point
  const arc = `<a:path w="100" h="100"><a:moveTo>${pt(0, 50)}</a:moveTo><a:arcTo wR="50" hR="50" stAng="10800000" swAng="-10800000"/></a:path>`;
  const arcNode = find(parseXml(geom(arc)), 'p:sp');
  assert.deepEqual(customPathD(arcNode, { x: 0, y: 0, w: 100, h: 100 })[0].d, 'M0 50A50 50 0 0 0 100 50');

  // no w/h: the path is in the shape's own EMU space, so its far corner is the box's
  const emu = `<a:path><a:moveTo>${pt(0, 0)}</a:moveTo><a:lnTo>${pt(200 * M, 90 * M)}</a:lnTo></a:path>`;
  const emuNode = find(parseXml(geom(emu)), 'p:sp');
  assert.equal(customPathD(emuNode, box, { w: 200 * M, h: 90 * M })[0].d, 'M40 200L240 290');

  // a subpath that says it is unfilled stays so; a Bézier maps one to one
  const two = `<a:path w="10" h="10" fill="none"><a:moveTo>${pt(0, 0)}</a:moveTo><a:cubicBezTo>${pt(0, 10)}${pt(10, 10)}${pt(10, 0)}</a:cubicBezTo></a:path>`
    + `<a:path w="10" h="10"><a:moveTo>${pt(5, 5)}</a:moveTo><a:quadBezTo>${pt(10, 5)}${pt(10, 10)}</a:quadBezTo></a:path>`;
  const parts = customPathD(find(parseXml(geom(two)), 'p:sp'), { x: 0, y: 0, w: 10, h: 10 });
  assert.deepEqual(parts.map((p) => p.fill), [false, true]);
  assert.equal(parts[0].d, 'M0 0C0 10 10 10 10 0');
  assert.equal(parts[1].d, 'M5 5Q10 5 10 10');

  // in a slide: custom geometry is intent, and the SVG carries the path, moved to the diagram's origin
  const slide = parse(geom(tri) + sp2(3, 400, 200, 200, 90, 'rect', 'b'), 'auto');
  assert.deepEqual(slide.blocks.map((b) => b.kind), ['drawing']);
  const svg = drawingSvg(slide.blocks[0].drawing);
  assert.match(svg, /<g transform="translate\(-28 -188\)"><path d="M40 200L240 200L140 290Z" style="fill: var\(--d-fill-1\); stroke: var\(--d-stroke\)"/);
  assert.ok(!/<rect x="12"/.test(svg), 'not ALSO a rectangle');
});

test('a picture the arrows point at crosses inside the drawing, at its place', () => {
  const pic = (id, x, y, w, h) => `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="shot" descr="the screen"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
    <p:blipFill><a:blip r:embed="rId9"/></p:blipFill>
    <p:spPr><a:xfrm><a:off x="${x * M}" y="${y * M}"/><a:ext cx="${w * M}" cy="${h * M}"/></a:xfrm></p:spPr></p:pic>`;
  const opts = { rels: new Map([['rId9', { target: '../media/image1.png', type: 'image' }]]), mediaOf: () => ({ bytes: Buffer.from('png!'), mime: 'image/png' }) };
  const annotated = pic(7, 100, 100, 400, 300) + looseLine(9, 520, 150, 100, 0, { flipH: true });   // an arrow pointing at the picture
  const auto = parseSlide(slideXml(annotated), { ...opts, shapes: 'auto' });
  assert.deepEqual(auto.blocks.map((b) => b.kind), ['drawing'], 'the picture went INTO the drawing, not beside it');
  const d = auto.blocks[0].drawing;
  assert.equal(d.shapes.filter((s) => s.image).length, 1);
  const svg = drawingSvg(d);
  assert.match(svg, /<image x="12" y="12" width="400" height="300" preserveAspectRatio="none" href="data:image\/png;base64,cG5nIQ==" aria-label="the screen"\/>/);
  assert.match(svg, /<line /, 'and the arrow is drawn');
  assert.equal(slideSection(auto).did.find((l) => /SVG diagram/.test(l)), '1 line and 1 image as an SVG diagram');

  // a picture lends no intent: beside a text box it is a layout, and two of them are a layout
  const withText = parseSlide(slideXml(pic(7, 100, 100, 400, 300) + sp2(3, 600, 100, 200, 90, 'rect', 'caption')), { ...opts, shapes: 'auto' });
  assert.deepEqual(withText.blocks.map((b) => b.kind), ['image', 'list']);
  assert.ok(!withText.blocks.some((b) => 'placed' in b), 'no bookkeeping leaks');
  const twoPics = parseSlide(slideXml(pic(7, 100, 100, 400, 300) + pic(8, 600, 100, 400, 300)), { ...opts, shapes: 'auto' });
  assert.deepEqual(twoPics.blocks.map((b) => b.kind), ['image', 'image']);
  // strict leaves the annotated picture as a picture, and says what auto would do
  const strict = parseSlide(slideXml(annotated), { ...opts, shapes: 'strict' });
  assert.deepEqual(strict.blocks.map((b) => b.kind), ['image']);
  assert.ok(strict.drops.some((x) => /--shapes auto would draw it/.test(x)));
});

test('rotation and flips ride on the shape as a transform about its centre; an unfilled outline stays one', () => {
  const inner = sp2(2, 100, 100, 200, 100, 'rect', 'tilted', { rot: 30 }) + sp2(3, 400, 100, 100, 100, 'ellipse', 'mirrored', { flipH: true })
    + sp2(4, 600, 100, 100, 100, 'roundRect', 'region', { noFill: true });
  const svg = drawingSvg(parse(inner, 'auto').blocks[0].drawing);
  // box origin is (88,88): the tilted rect sits at (12,12) 200×100, so its centre is (112, 62)
  assert.match(svg, /<g transform="rotate\(30 112 62\)">/);
  // the mirror wraps the SHAPE only — a flipped arrow's label still reads left to right
  assert.match(svg, /<g><g transform="translate\(362 62\) scale\(-1 1\) translate\(-362 -62\)"><ellipse[^>]*\/><\/g><text/);
  assert.match(svg, /<rect x="512"[^>]*style="fill: none; stroke: var\(--d-stroke\)"/, 'noFill keeps the outline');
  assert.match(svg, /<rect x="12"[^>]*style="fill: var\(--d-fill-1\)/, 'a filled shape still takes a palette slot');
  assert.equal(rotationOf(find(parseXml(sp2(2, 0, 0, 10, 10, 'rect', 'x', { rot: 45 })), 'p:sp')), 45);
});

test('the presets people draw with are polygons of their kind; the rest keep their family or fall back to a box', () => {
  const kinds = ['chevron', 'rightArrow', 'star5', 'hexagon', 'parallelogram', 'plus'];
  const inner = kinds.map((k, i) => sp2(2 + i, 40 + i * 150, 200, 120, 80, k, k)).join('');
  // the arrowhead marker in <defs> is a polygon too; the shapes are what is counted
  const svg = drawingSvg(parse(inner, 'auto').blocks[0].drawing).replace(/<defs>.*?<\/defs>/, '');
  assert.equal((svg.match(/<polygon/g) || []).length, kinds.length, 'one polygon per drawn kind');
  assert.equal((svg.match(/<rect/g) || []).length, 0);
  for (const k of Object.keys(POLYGONS)) assert.ok(POLYGONS[k].every(([px, py]) => px >= 0 && px <= 1 && py >= 0 && py <= 1), `${k} stays on the unit box`);
  const family = drawingSvg(parse(sp2(2, 0, 0, 100, 60, 'wedgeRoundRectCallout', 'said') + sp2(3, 200, 0, 100, 60, 'cloud', 'thought')
    + sp2(4, 400, 0, 100, 60, 'flowChartMagneticDisk', 'unknown'), 'auto').blocks[0].drawing);
  assert.match(family, /<rect[^>]*rx="10"/, 'a callout is a rounded box');
  assert.match(family, /<ellipse/, 'a cloud is an oval');
  assert.match(family, /<rect[^>]*rx="3"/, 'an unknown preset falls back to a plain box');
});

test('a box with more to say than a label keeps every word: HTML that wraps, never four lines and silence', () => {
  const list = '<p:txBody><a:p><a:r><a:t>Owns the ledger</a:t></a:r></a:p><a:p><a:r><a:t>Settles nightly</a:t></a:r></a:p></p:txBody>';
  const long = 'This box explains, at some length, what the service does and why it exists, which no four lines of fourteen-pixel text could hold.';
  const inner = sp2(2, 40, 100, 160, 120, 'roundRect', 'Ledger', { body: list }) + sp2(3, 300, 100, 200, 120, 'ellipse', long) + sp2(4, 600, 100, 100, 60, 'rect', 'short');
  const svg = drawingSvg(parse(inner, 'auto').blocks[0].drawing);
  assert.match(svg, /<foreignObject x="12" y="12" width="160" height="120"><div xmlns="http:\/\/www.w3.org\/1999\/xhtml" class="dwg-text"><ul><li>Owns the ledger<\/li><li>Settles nightly<\/li><\/ul><\/div><\/foreignObject>/,
    'a list stays a list');
  assert.match(svg, /<foreignObject[^>]*><div[^>]*class="dwg-text"><p>This box explains/, 'a long paragraph wraps as HTML');
  assert.match(svg, /<text[^>]*><tspan[^>]*>short<\/tspan><\/text>/, 'a label is still plain SVG text, not a list of one');
  assert.match(svg, /no four lines of fourteen-pixel text could hold\.<\/p>/, 'every word is present, to the last');
  assert.ok(!/<tspan[^>]*>This box explains/.test(svg), 'and not ALSO as truncated tspans');
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

test('import writes a deck that links the installed runtime — and --inline one that needs no sibling files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-import-'));
  try {
    const out = path.join(dir, 'deck.html');
    const r = spawnSync('node', [CLI, 'import', FIXTURE, '-o', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(out, 'utf8');
    // the init shape (#520): slides plus a configuration block naming the
    // theme, no runtime in the file — served from the package, embedded by bundle
    assert.match(html, /<script type="application\/json" data-decklight-config>\n\s*\{ "decklight": "[^"]+", "theme": "midnight" \}/);
    assert.doesNotMatch(html, /<link rel="stylesheet"|<script src=|Decklight\.init|<style data-decklight-runtime/);
    assert.equal((html.match(/<section>/g) || []).length, 4);
    assert.doesNotMatch(html, /src="ppt\//, 'the image is inlined, not referenced');
    assert.ok(html.length < 200_000, `slides and pictures, not the runtime (${html.length} bytes)`);
    // --inline: the self-contained deck, as before
    const inl = path.join(dir, 'inline.html');
    assert.equal(spawnSync('node', [CLI, 'import', FIXTURE, '-o', inl, '--inline'], { encoding: 'utf8' }).status, 0);
    const embedded = readFileSync(inl, 'utf8');
    assert.match(embedded, /<style data-decklight-runtime="css">/);
    assert.match(embedded, /<script data-decklight-runtime="js">/);
    assert.match(embedded, /<style data-theme="midnight">/);
    assert.doesNotMatch(embedded, /<link rel="stylesheet"/, 'nothing to fetch from disk');

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

    // --shapes takes three words and refuses a fourth by name
    const shapes = spawnSync('node', [CLI, 'import', FIXTURE, '-o', path.join(dir, 'c.html'), '--shapes', 'gif'], { encoding: 'utf8' });
    assert.equal(shapes.status, 1);
    assert.match(shapes.stderr, /--shapes must be auto, strict or text \(got "gif"\)/);
    // and auto still draws the fixture's drawn slide — the connector rule is a subset of it
    const auto = spawnSync('node', [CLI, 'import', FIXTURE, '-o', path.join(dir, 'd.html'), '--shapes', 'auto', '-v'], { encoding: 'utf8' });
    assert.equal(auto.status, 0, auto.stderr);
    assert.match(auto.stderr, /3 drawn shapes as an SVG diagram/);
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
  // radar, stock, surface, bubble: no data-chart draws them, so they drop
  assert.equal(parseChart(BAR_CHART.replace(/c:barChart/g, 'c:radarChart')), null);
  assert.equal(parseChart('<c:chartSpace/>'), null);
  assert.equal(parseChart(''), null);
});

const SCATTER_CHART = `<c:chartSpace xmlns:c="c" xmlns:a="a">
 <c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>Latency against load</a:t></a:r></a:p></c:rich></c:tx></c:title>
  <c:plotArea><c:scatterChart>
   <c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>v1</c:v></c:pt></c:strCache></c:strRef></c:tx>
    <c:xVal><c:numRef><c:numCache><c:pt idx="1"><c:v>50</c:v></c:pt><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="2"><c:v>90</c:v></c:pt></c:numCache></c:numRef></c:xVal>
    <c:yVal><c:numRef><c:numCache><c:pt idx="0"><c:v>120</c:v></c:pt><c:pt idx="1"><c:v>180</c:v></c:pt><c:pt idx="2"><c:v>340</c:v></c:pt></c:numCache></c:numRef></c:yVal>
   </c:ser>
  </c:scatterChart>
  <c:valAx><c:title><c:tx><c:rich><a:p><a:r><a:t>Load (rps)</a:t></a:r></a:p></c:rich></c:tx></c:valAx>
  <c:valAx><c:title><c:tx><c:rich><a:p><a:r><a:t>p99 (ms)</a:t></a:r></a:p></c:rich></c:tx></c:valAx>
  </c:plotArea></c:chart></c:chartSpace>`;

test('a scatter crosses as pairs, in index order, with the axes it was drawn against', () => {
  const chart = parseChart(SCATTER_CHART);
  assert.equal(chart.type, 'scatter');
  assert.equal(chart.title, 'Latency against load');
  // the cache lists idx 1 before idx 0; the pairing is by index, not by file order
  assert.deepEqual(chart.series, [{ name: 'v1', points: [[10, 120], [50, 180], [90, 340]] }]);
  assert.equal(chart.x, 'Load (rps)');
  assert.equal(chart.y, 'p99 (ms)');

  // and it renders as CHARTS markup the runtime accepts
  const html = chartHtml(chart);
  assert.match(html, /data-chart="scatter"/);
  assert.match(html, /\{"x":"Load \(rps\)","y":"p99 \(ms\)","series":\[\{"name":"v1","points":\[\[10,120\]/);
  assert.doesNotMatch(html, /"labels"/, 'a scatter has no categories to carry');
  const { did } = slideSection({ blocks: [{ kind: 'chart', ...chart }], drops: [] });
  assert.ok(did.some((d) => /^chart \(scatter, 1 series × 3 points\)$/.test(d)), did.join(' · '));
});

test('a series with no usable pairs is not a chart at all', () => {
  assert.equal(parseChart(SCATTER_CHART.replace(/<c:yVal>[\s\S]*?<\/c:yVal>/, '')), null);
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

// ── two text boxes side by side: the split layout, not a list of two lists ───
test('two text boxes side by side cross as the split layout — left column first, whatever the file said', () => {
  const two = (leftFirst) => {
    const l = sp2(2, 40, 200, 300, 200, 'rect', 'left one', { txBox: true, body: '<p:txBody><a:p><a:r><a:t>left one</a:t></a:r></a:p><a:p><a:r><a:t>left two</a:t></a:r></a:p></p:txBody>' });
    const r = sp2(3, 400, 210, 300, 200, 'rect', 'right one', { txBox: true });
    return leftFirst ? l + r : r + l;
  };
  const slide = parse(two(false));
  assert.equal(slide.layout, 'split');
  assert.deepEqual(slide.blocks.map((b) => [b.kind, b.column]), [['list', 0], ['list', 1]], 'left first, though the file listed the right box first');
  const { html, did } = slideSection(slide);
  assert.match(html, /<section data-layout="split">/);
  assert.match(html, /<div>\n\s+<ul><li>left one<\/li><li>left two<\/li><\/ul>\n\s+<\/div>\n\s+<div>\n\s+<ul><li>right one<\/li><\/ul>\n\s+<\/div>/);
  assert.ok(did.includes('two columns'));
  assert.ok(!slide.blocks.some((b) => 'placed' in b), 'no bookkeeping leaks');

  // not a comparison: three boxes, a stacked pair, an empty partner, a box with nothing placed beside it
  const three = parse(two(true) + sp2(4, 760, 200, 200, 200, 'rect', 'third', { txBox: true }));
  assert.equal(three.layout, null);
  const stacked = parse(sp2(2, 40, 100, 300, 120, 'rect', 'top', { txBox: true }) + sp2(3, 40, 300, 300, 120, 'rect', 'bottom', { txBox: true }));
  assert.equal(stacked.layout, null);
  const empty = parse(sp2(2, 40, 200, 300, 200, 'rect', 'words', { txBox: true }) + sp2(3, 400, 200, 300, 200, 'rect', '', { txBox: true }));
  assert.equal(empty.layout, null);
  assert.doesNotMatch(slideSection(three).html, /data-layout/);
  // a drawing is a drawing, never columns: two boxes with a snapped arrow
  const drawn = parse(sp2(2, 40, 200, 200, 90, 'rect', 'a') + sp2(3, 400, 200, 200, 90, 'rect', 'b') + cxnXml(5, 2, 3));
  assert.equal(drawn.layout, null);
  assert.deepEqual(drawn.blocks.map((b) => b.kind), ['drawing']);
});

// ── the shape fixture: what PowerPoint writes, not what a test typed ─────────

test('the shape fixture carries the markers the rule reads — written by the library, not by hand', () => {
  const z = shapesZip();
  const xml = (n) => z.get(`ppt/slides/slide${n}.xml`).toString();
  const all = [1, 2, 3, 4, 5, 6].map(xml).join('');
  assert.equal((all.match(/txBox="1"/g) || []).length, 5, 'inserted text boxes are flagged');
  assert.equal((all.match(/<a:chOff/g) || []).length, 1, 'one group, with its own child space');
  assert.equal((all.match(/<a:custGeom>/g) || []).length, 1, 'one hand-drawn shape');
  assert.equal((all.match(/<a:stCxn /g) || []).length, 3, 'three snapped connector ends… ');
  assert.equal((all.match(/<a:endCxn /g) || []).length, 3, '…and their other ends; the rest are merely drawn');
  assert.match(all, / rot="720000"/, 'a 12° rotation, in 60,000ths');
});

test('the shape fixture, under the default: every arrangement crosses, every layout stays text', () => {
  const { sections, report } = convert(shapesZip());
  const did = (n) => report[n - 1].did.join(' · ');
  assert.equal(sections.length, 6);
  // 1: a title, a subtitle and a text box — a layout
  assert.match(did(1), /1 bullet/); assert.doesNotMatch(did(1), /SVG diagram/); assert.deepEqual(report[0].drops, []);
  // 2: chevrons with snapped arrows, a table, notes
  assert.match(did(2), /3 drawn shapes as an SVG diagram/); assert.match(did(2), /table 3×3/); assert.match(did(2), /notes/);
  // 3: the group, a loose line, rotation, a flip, an unfilled region
  assert.match(did(3), /^6 drawn shapes as an SVG diagram$/);
  // 4: a picture with two arrows on it, a callout and a text box
  assert.match(did(4), /2 drawn shapes and 2 lines and 1 image as an SVG diagram/);
  // 5: a hand-drawn blob, three presets, a wordy box
  assert.match(did(5), /5 drawn shapes as an SVG diagram/);
  // 6: two text boxes of bullets — a layout, and it crosses as one: two columns
  assert.match(did(6), /4 bullets/); assert.match(did(6), /two columns/); assert.doesNotMatch(did(6), /SVG diagram/); assert.deepEqual(report[5].drops, []);
  assert.match(sections[5], /<section data-layout="split">/);
  assert.match(sections[5], /<div>\n\s+<ul><li>left one<\/li><li>left two<\/li><\/ul>\n\s+<\/div>\n\s+<div>\n\s+<ul><li>right one<\/li><li>right two<\/li><\/ul>/);
  assert.ok(!report.some((r) => r.drops.length), `nothing dropped: ${JSON.stringify(report.map((r) => r.drops))}`);
});

test('the shape fixture, slide 3: a group placed where it was dragged, a line attached by where it lands, a readable mirrored label', () => {
  const { sections } = convert(shapesZip());
  const svg = sections[2].match(/<svg[\s\S]*?<\/svg>/)[0];
  // the group's children were at x≈1in in their own space; the group was then
  // dragged to 4.5in and scaled 1.3× — the API box lands right of the region
  assert.match(svg, /<rect x="386" y="31" width="312" height="125" rx="10"/, 'API, through the group frame');
  assert.match(svg, /<rect x="12" y="12" width="336" height="461" rx="10" style="fill: none;/, 'the region keeps its outline only');
  assert.match(svg, /<g transform="rotate\(12 165 156\)"><rect/, 'the worker is tilted, label and all');
  assert.match(svg, /<g><g transform="translate\(166 324\) scale\(-1 1\) translate\(-166 -324\)"><polygon[^>]*\/><\/g><text/, 'the arrow is mirrored; its label is not');
  assert.equal((svg.match(/<line /g) || []).length, 2, 'the snapped arrow and the merely-drawn one');
  assert.equal((svg.match(/marker-end/g) || []).length, 2, 'both arrows keep their heads');
  // the merely-drawn line was vertical in the file (cx="0"): it stays vertical,
  // not re-drawn centre to centre between two boxes whose centres differ by a hair
  const vertical = (svg.match(/<line x1="(\d+)" y1="\d+" x2="(\d+)"/g) || []).map((m) => m.match(/x1="(\d+)".*x2="(\d+)"/).slice(1));
  assert.ok(vertical.some(([x1, x2]) => x1 === x2), `one of the lines is vertical: ${JSON.stringify(vertical)}`);
  assert.match(svg, /rx="10"[^>]*\/><text[^>]*><tspan[^>]*>Ledger/, 'a can is a rounded box');
  assert.match(svg, /<polygon points="536,281 661,356 536,431 411,356"/, 'the diamond');
});

test('the shape fixture, slides 4 and 5: the picture inside the drawing, the hand-drawn path, the box that keeps every word', () => {
  const { sections } = convert(shapesZip());
  const s4 = sections[3].match(/<svg[\s\S]*?<\/svg>/)[0];
  assert.match(s4, /<image x="\d+" y="\d+" width="\d+" height="\d+" preserveAspectRatio="none" href="data:image\/png;base64,/);
  assert.equal((s4.match(/<line /g) || []).length, 2);
  assert.match(s4, /the button that matters/); assert.match(s4, /and the total, here/);
  assert.ok(!/<img /.test(sections[3]), 'the picture is IN the drawing, not also a block');
  const s5 = sections[4].match(/<svg[\s\S]*?<\/svg>/)[0];
  assert.match(s5, /<path d="M96 288L240 192L384 288L326\.4 441\.6L153\.6 441\.6Z"/, 'the freeform, as drawn');
  assert.equal((s5.replace(/<defs>.*?<\/defs>/, '').match(/<polygon/g) || []).length, 3, 'star, hexagon, left-right arrow');
  assert.match(s5, /<foreignObject[^>]*><div[^>]*class="dwg-text"><ul><li>The service<ul><li>owns the ledger<\/li>/, 'a real list, nested as it was');
  assert.match(s5, /never loses a write/, 'to the last word');
});

test('the shape fixture under --shapes strict and text', () => {
  const strict = convert(shapesZip(), { shapes: 'strict' });
  const did = (r, n) => r.report[n - 1].did.join(' · ');
  assert.match(did(strict, 2), /3 drawn shapes as an SVG diagram/, 'snapped arrows draw under strict');
  assert.match(did(strict, 3), /6 drawn shapes and 1 line as an SVG diagram/, 'one snapped arrow in the group is enough — and strict infers nothing, so the drawn line stays loose');
  assert.doesNotMatch(did(strict, 4), /SVG diagram/); assert.match(did(strict, 4), /image inlined/);
  assert.ok(strict.report[3].drops.some((d) => /--shapes auto would draw it/.test(d)), 'and strict says what auto would do');
  assert.doesNotMatch(did(strict, 5), /SVG diagram/);
  assert.ok(strict.report[4].drops.some((d) => /--shapes auto would draw it/.test(d)));
  const text = convert(shapesZip(), { shapes: 'text' });
  assert.ok(!text.sections.some((s) => /<svg/.test(s)), 'text never draws');
  assert.ok(!text.report.some((r) => r.drops.some((d) => /arrangement/.test(d))), 'and does not complain');
});
