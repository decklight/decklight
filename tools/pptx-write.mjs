// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight → PowerPoint, lossy on purpose.
 *
 * PPTX export was a v1 non-goal, and the reason has not changed: a decklight
 * deck is HTML, builds, casts and a live voice, and none of that has a
 * PowerPoint shape. What changed is who asks. Decklight is a replacement for
 * people who never liked PowerPoint — and every one of them still has a
 * boss, a legal team or a conference organiser who says "just send the
 * pptx". They do not want to EDIT it there. They want a file that opens.
 *
 * So each slide is a picture — the slide rendered at its own 1280×720, every
 * build complete — filling a 16:9 page, and its speaker notes ride along as
 * real notes, because notes are the one part of a deck that survives the
 * trip as text and is worth having in PowerPoint's notes pane. Nothing here
 * pretends to round-trip: import this file and you get pictures.
 *
 * The package is the smallest one PowerPoint opens without complaint: a
 * presentation, one master, one layout, one theme, one notes master, and per
 * slide a slide part, a notes part and a PNG. Every part is a template string
 * here rather than a library, because the runtime has zero dependencies and
 * the writer lives beside the reader (tools/ooxml.mjs) that will be asked to
 * read it back in tests.
 */

import { zipSync } from '../cli/zip.mjs';
import { escapeHtml as esc } from './escape.mjs';

const NS = {
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.presentationml';
/** 16:9 in EMU — PowerPoint's own default for a widescreen deck. */
export const SLIDE_W = 12192000;
export const SLIDE_H = 6858000;

const xml = (s) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`;
const rels = (list) => xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
  + list.map(({ id, type, target }) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join('') + '</Relationships>');

const emptyShapeTree = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

/** A slide: one picture, the whole page. */
function slideXml(n) {
  return xml(`<p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:cSld>${emptyShapeTree}`
    + `<p:pic><p:nvPicPr><p:cNvPr id="2" name="Slide ${n}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${SLIDE_W}" cy="${SLIDE_H}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
    + `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
}

/** The notes part: the slide's thumbnail placeholder and the text, one paragraph per line. */
function notesXml(lines) {
  const paras = (lines.length ? lines : ['']).map((l) => `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(l)}</a:t></a:r></a:p>`).join('');
  return xml(`<p:notes xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:cSld>${emptyShapeTree}`
    + `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>`
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`
    + `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
}

const masterXml = xml(`<p:sldMaster xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>${emptyShapeTree}</p:spTree></p:cSld>`
  + `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>`
  + `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr/></p:titleStyle><p:bodyStyle><a:lvl1pPr/></p:bodyStyle><p:otherStyle><a:lvl1pPr/></p:otherStyle></p:txStyles></p:sldMaster>`);
const layoutXml = xml(`<p:sldLayout xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}" type="blank" preserve="1"><p:cSld name="Blank">${emptyShapeTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
const notesMasterXml = xml(`<p:notesMaster xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:cSld>${emptyShapeTree}</p:spTree></p:cSld>`
  + `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr/></p:notesStyle></p:notesMaster>`);
const themeXml = xml(`<a:theme xmlns:a="${NS.a}" name="Decklight"><a:themeElements><a:clrScheme name="Decklight">`
  + `<a:dk1><a:srgbClr val="1F2937"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="374151"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2>`
  + `<a:accent1><a:srgbClr val="0F6E6E"/></a:accent1><a:accent2><a:srgbClr val="B4541A"/></a:accent2><a:accent3><a:srgbClr val="2C7A4B"/></a:accent3><a:accent4><a:srgbClr val="7B1FA2"/></a:accent4><a:accent5><a:srgbClr val="0B57D0"/></a:accent5><a:accent6><a:srgbClr val="D93025"/></a:accent6>`
  + `<a:hlink><a:srgbClr val="0B57D0"/></a:hlink><a:folHlink><a:srgbClr val="7B1FA2"/></a:folHlink></a:clrScheme>`
  + `<a:fontScheme name="Decklight"><a:majorFont><a:latin typeface="Helvetica"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Helvetica"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>`
  + `<a:fmtScheme name="Decklight"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>`
  + `<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>`
  + `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>`
  + `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);

/**
 * The package, as bytes.
 *
 * `slides` is `[{ png, notes }]` in deck order — `png` the rendered slide as
 * a Buffer, `notes` the speaker notes as lines of plain text (empty for a
 * silent slide). `title` becomes the document title.
 */
export function buildPptx(slides, { title = 'Deck' } = {}) {
  if (!slides.length) throw new Error('a presentation needs at least one slide');
  const entries = [];
  const put = (name, data) => entries.push({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') });
  const n = slides.length;

  put('[Content_Types].xml', xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>`
    + `<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/>`
    + `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/>`
    + `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CT}.slideLayout+xml"/>`
    + `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${CT}.notesMaster+xml"/>`
    + `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`
    + slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${CT}.slide+xml"/>`
      + `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="${CT}.notesSlide+xml"/>`).join('')
    + `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`
    + `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`));
  put('_rels/.rels', rels([
    { id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' },
    { id: 'rId2', type: 'metadata/core-properties', target: 'docProps/core.xml' },
    { id: 'rId3', type: 'extended-properties', target: 'docProps/app.xml' },
  ]));
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  put('docProps/core.xml', xml(`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>decklight</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`));
  put('docProps/app.xml', xml(`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>decklight</Application><Slides>${n}</Slides><Notes>${n}</Notes></Properties>`));

  put('ppt/presentation.xml', xml(`<p:presentation xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}" saveSubsetFonts="1">`
    + `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`
    + `<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>`
    + `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('')}</p:sldIdLst>`
    + `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`));
  put('ppt/_rels/presentation.xml.rels', rels([
    { id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
    { id: 'rId2', type: 'notesMaster', target: 'notesMasters/notesMaster1.xml' },
    { id: 'rId3', type: 'theme', target: 'theme/theme1.xml' },
    ...slides.map((_, i) => ({ id: `rId${10 + i}`, type: 'slide', target: `slides/slide${i + 1}.xml` })),
  ]));
  put('ppt/slideMasters/slideMaster1.xml', masterXml);
  put('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([{ id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' }, { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' }]));
  put('ppt/slideLayouts/slideLayout1.xml', layoutXml);
  put('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels([{ id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' }]));
  put('ppt/notesMasters/notesMaster1.xml', notesMasterXml);
  put('ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([{ id: 'rId1', type: 'theme', target: '../theme/theme1.xml' }]));
  put('ppt/theme/theme1.xml', themeXml);

  slides.forEach(({ png, notes = [] }, i) => {
    const k = i + 1;
    if (!Buffer.isBuffer(png) || !png.length) throw new Error(`slide ${k}: no rendered image`);
    put(`ppt/slides/slide${k}.xml`, slideXml(k));
    put(`ppt/slides/_rels/slide${k}.xml.rels`, rels([
      { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: 'image', target: `../media/slide${k}.png` },
      { id: 'rId3', type: 'notesSlide', target: `../notesSlides/notesSlide${k}.xml` },
    ]));
    put(`ppt/media/slide${k}.png`, png);
    put(`ppt/notesSlides/notesSlide${k}.xml`, notesXml(notes));
    put(`ppt/notesSlides/_rels/notesSlide${k}.xml.rels`, rels([
      { id: 'rId1', type: 'notesMaster', target: '../notesMasters/notesMaster1.xml' },
      { id: 'rId2', type: 'slide', target: `../slides/slide${k}.xml` },
    ]));
  });
  return zipSync(entries);
}
