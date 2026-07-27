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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzip, zipEntries } from '../tools/zip.mjs';
import { parseXml, find, findAll, children, textOf, decodeEntities } from '../tools/ooxml.mjs';
import { listHtml, resolvePart, slideOrder, parseSlide, notesText, mimeOf, paragraphHtml } from '../tools/pptx.mjs';
import { convert, outPath, slidesId, slidesExportUrl, sourceKind, slug, keynoteScript } from '../cli/import.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '../cli/decklight.mjs');
const FIXTURE = path.resolve(here, 'fixtures/sample.pptx');
const zip = () => unzip(readFileSync(FIXTURE));

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
    'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/slides/slide3.xml', 'ppt/slides/slide4.xml',
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
  assert.equal(parseSlide(z.get('ppt/slides/slide4.xml').toString()).hidden, true);
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
  assert.ok(third.drops.some((d) => /SmartArt dropped.*SVG diagram/.test(d)));
  assert.equal(parseSlide(z.get('ppt/slides/slide1.xml').toString()).drops.length, 0,
    'a slide that converted cleanly reports nothing');
});

test('image mime types come from the file name', () => {
  assert.equal(mimeOf('ppt/media/image1.png'), 'image/png');
  assert.equal(mimeOf('a/b/photo.JPEG'), 'image/jpeg');
  assert.equal(mimeOf('x.heic'), 'application/octet-stream', 'and an unknown one is not guessed');
});

// ── the whole conversion ──────────────────────────────────────────────────

test('the fixture converts to three visible slides and one skipped', () => {
  const { sections, report } = convert(zip());
  assert.equal(sections.length, 3);
  assert.equal(report.length, 4);
  assert.equal(report[3].hidden, true);

  assert.match(sections[0], /<h1>Q3 &amp; Beyond<\/h1>/);
  assert.match(sections[0], /<p>What shipped, what did not<\/p>/, 'the subtitle feeds the §1 subtitle rule');
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
  assert.equal(outPath('x.pptx', '/tmp/out.html'), '/tmp/out.html');
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
    assert.equal((html.match(/<section>/g) || []).length, 3);
    assert.doesNotMatch(html, /<link rel="stylesheet"/, 'nothing to fetch from disk');
    assert.doesNotMatch(html, /src="ppt\//, 'the image is inlined, not referenced');

    // the report names the drops with their slide numbers
    assert.match(r.stderr, /3 {2}⚠/);
    assert.match(r.stderr, /chart dropped/);
    assert.match(r.stderr, /⊘ hidden slide skipped/);
    assert.match(r.stderr, /3 slides · theme midnight/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a drop is a warning, not a failure — only an unreadable deck fails', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-import-'));
  try {
    const out = path.join(dir, 'd.html');
    // slide 3 drops a chart and SmartArt, and the command still succeeds
    assert.equal(spawnSync('node', [CLI, 'import', FIXTURE, '-o', out], { encoding: 'utf8' }).status, 0);

    const junk = path.join(dir, 'junk.pptx');
    writeFileSync(junk, 'not an office file at all');
    const bad = spawnSync('node', [CLI, 'import', junk, '-o', path.join(dir, 'x.html')], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not a zip file/);
    assert.doesNotMatch(bad.stderr, /at .*\.mjs:\d+/, 'no stack trace');
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('import is routed and documented by the dispatcher', () => {
  const help = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help, /^  import {3}/m);
  const own = execFileSync('node', [CLI, 'import', '--help'], { encoding: 'utf8' });
  assert.match(own, /usage: decklight import/);
  assert.match(own, /--build all\|none\|auto/);
});
