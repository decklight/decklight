#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight import — bring an existing deck across.
//
//   decklight import "Q3 Review.pptx"
//   decklight import keynote-deck.key                (macOS: converted via Keynote)
//   decklight import https://docs.google.com/presentation/d/<id>/edit
//
// THREE FRONT DOORS, ONE PARSER. PowerPoint's .pptx is the only one of the
// three that is a readable format: .key is an undocumented binary archive
// (Apple ships no schema and there is no honest way to parse it), and a Google
// Slides deck is not a local file at all. Both, however, can *become* a .pptx —
// Keynote exports one on the machine that owns it, and Google serves one from
// /export/pptx. So the importer speaks one format and meets you where you are.
//
// It is a CONTENT importer, not a pixel renderer: the original template's look
// is replaced by decklight theming. Anything that cannot cross is dropped and
// NAMED, per slide, because a chart that quietly vanishes from slide 14 gets
// discovered on stage.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argReader, isMain } from '../tools/args.mjs';
import { unzip } from '../tools/zip.mjs';
import { decodeEntities } from '../tools/ooxml.mjs';
import { parseRels, resolvePart, slideOrder, parseSlide, notesText, slideSection, mimeOf } from '../tools/pptx.mjs';

// fileURLToPath, never `.pathname` — a URL path is percent-encoded, so an
// install under `/Users/First Last/…` (or any Windows profile with a space)
// came back as `/Users/First%20Last/…` and every read of themes/ and dist/
// failed. Every other command in the tree already resolves it this way.
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const THEMES_DIR = join(PKG_ROOT, 'themes');

const USAGE = `usage: decklight import <deck.pptx | deck.key | google-slides-url> [options]
  convert an existing presentation into a self-contained decklight deck

  -o <file>        output path                     [the source's, with .html]
  --theme <name>   theme to open in                [midnight]
  --build all|none|auto
                   which lists step in                            [auto]
                   auto follows PowerPoint's own per-paragraph build list
  --force          overwrite an existing output file
  -v, --verbose    print every slide's line, not just the ones with drops

  content crosses over — titles, bullets (nested), paragraphs, tables, images
  and speaker notes. The template's LOOK does not: the result is themed by
  decklight. Anything that cannot cross is named on stderr with its slide
  number, so you know what to rebuild by hand.

  .key needs Keynote (macOS): it is converted to .pptx by Keynote itself.
  A Google Slides URL is fetched as .pptx — the deck must be link-shared.

  A format decklight cannot read itself runs through an installed import
  adapter instead, if one is installed for that extension: decklight importer
  add <name>, then this command again. -v/--build/drop reporting are the
  built-in PowerPoint path's own; a third-party adapter has no equivalent yet.`;

/**
 * The deck name a source implies: the file's, or the URL's document id.
 *
 * Strips ANY trailing extension, not only `.pptx`/`.key`/`.ppt`: a source an
 * installed import adapter reads (`.marp`, say) is just as much "the file's
 * name minus its format" as the three built-in ones — `talk.marp` importing
 * to `talk-marp.html` would be the format's name doubling into the deck's,
 * for every extension `EXTENSIONS#ADAPTEREXEC` newly makes importable.
 */
export function outPath(source, oFlag) {
  if (oFlag) return resolve(oFlag);
  const base = /^https?:/i.test(source)
    ? (slidesId(source) ?? 'imported-deck')
    : basename(source).replace(/\.[A-Za-z0-9]+$/, '');
  return resolve(slug(base) + '.html');
}

export const slug = (s) => String(s).trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';

/** The document id in a Google Slides URL, or null if it is not one. */
export function slidesId(url) {
  const m = /docs\.google\.com\/presentation\/d\/(?:e\/)?([A-Za-z0-9_-]{8,})/.exec(String(url ?? ''));
  return m ? m[1] : null;
}

/** Google serves any presentation it will show you as a .pptx at this URL. */
export const slidesExportUrl = (id) => `https://docs.google.com/presentation/d/${id}/export/pptx`;

/**
 * What kind of source this is. Deciding up front keeps the three doors'
 * error messages specific: "that is not a Google Slides link" beats a 404.
 */
export function sourceKind(source) {
  const s = String(source ?? '');
  if (/^https?:/i.test(s)) return slidesId(s) ? 'gslides' : 'url';
  if (/\.pptx$/i.test(s)) return 'pptx';
  if (/\.key$/i.test(s)) return 'keynote';
  if (/\.ppt$/i.test(s)) return 'ppt';
  return 'unknown';
}

/**
 * Turn a .key into a .pptx by asking Keynote to export it.
 *
 * There is no parser here and there should not be: iWork's format is
 * undocumented, versioned with the app, and a snappy-compressed protobuf
 * archive in current versions. Keynote already exports PowerPoint perfectly
 * well; the only thing missing was someone to ask. Off macOS, the honest
 * answer is instructions.
 */
export function keynoteScript(src, outDir) {
  // `save ... as` is scriptable export; the file name follows the document's
  return `tell application "Keynote"
  set d to open POSIX file ${JSON.stringify(src)}
  export d to POSIX file ${JSON.stringify(outDir)} as Microsoft PowerPoint
  close d saving no
end tell`;
}

function convertKeynote(src, { platform = process.platform, exec = execFileSync } = {}) {
  if (platform !== 'darwin') {
    throw new Error(
      `.key files can only be read by Keynote, and Keynote only runs on macOS.\n`
      + `  On a Mac, either run this same command there, or export by hand:\n`
      + `    Keynote → File → Export To → PowerPoint… → save as .pptx\n`
      + `  then: decklight import that-file.pptx`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'decklight-key-'));
  try {
    exec('osascript', ['-e', keynoteScript(resolve(src), dir)], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `Keynote could not export ${basename(src)} (${String(e.stderr ?? e.message).trim().split('\n')[0]}).\n`
      + `  Keynote must be installed, and the first run needs you to allow automation\n`
      + `  (System Settings → Privacy & Security → Automation). Or export by hand:\n`
      + `    Keynote → File → Export To → PowerPoint…`);
  }
  const made = readdirSync(dir).find((f) => /\.pptx$/i.test(f));
  if (!made) { rmSync(dir, { recursive: true, force: true }); throw new Error('Keynote exported no .pptx'); }
  return { file: join(dir, made), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function fetchSlides(url, { fetchImpl = fetch } = {}) {
  const id = slidesId(url);
  const r = await fetchImpl(slidesExportUrl(id));
  if (!r.ok) {
    throw new Error(
      `Google would not export that presentation (HTTP ${r.status}).\n`
      + `  decklight downloads it as .pptx, which only works if the deck is shared:\n`
      + `    Share → General access → "Anyone with the link"\n`
      + `  Otherwise download it yourself (File → Download → Microsoft PowerPoint)\n`
      + `  and run: decklight import that-file.pptx`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  // an unshared deck answers 200 with a sign-in page, not an archive
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(
      'Google returned a web page instead of a presentation — the deck is probably not shared.\n'
      + '  Share → General access → "Anyone with the link", or download it as .pptx yourself.');
  }
  return buf;
}

/**
 * The whole conversion, from archive bytes to sections and a report.
 * Pure apart from the parsing, so the mapping is testable without a CLI.
 */
export function convert(zip, { build = 'auto' } = {}) {
  const part = (name) => zip.get(name)?.toString('utf8');
  const order = slideOrder(part('ppt/presentation.xml'), part('ppt/_rels/presentation.xml.rels'));
  if (!order.length) throw new Error('no slides found — is this really a PowerPoint file?');

  const sections = [];
  const report = [];
  let n = 0;
  for (const slidePath of order) {
    const xml = part(slidePath);
    if (!xml) continue;
    const rels = parseRels(part(`${slidePath.replace(/([^/]+)$/, '_rels/$1')}.rels`));
    const slide = parseSlide(xml, {
      rels,
      mediaOf: (target) => {
        const p = resolvePart(slidePath, target);
        const bytes = zip.get(p);
        return bytes ? { bytes, mime: mimeOf(p) } : null;
      },
    });
    n += 1;
    if (slide.hidden) { report.push({ n, hidden: true, title: slide.title }); continue; }

    const notesRel = [...rels.values()].find((r) => r.type.endsWith('/notesSlide'));
    const notes = notesRel
      ? notesText(part(resolvePart(slidePath, notesRel.target)), { rels })
      : [];
    const { html, did } = slideSection(slide, notes, { build });
    sections.push(html);
    report.push({ n, title: slide.title, did, drops: slide.drops });
  }
  if (!sections.length) throw new Error('every slide in this file is hidden — nothing to import');
  return { sections, report };
}

/** The self-contained deck, runtime and theme inlined — the `init` output shape. */
export function deckHtml(sections, { title, theme }) {
  const css = readFileSync(join(PKG_ROOT, 'dist/decklight.css'), 'utf8');
  const themeCss = readFileSync(join(THEMES_DIR, `${theme}.css`), 'utf8');
  const js = readFileSync(join(PKG_ROOT, 'dist/decklight.js'), 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, '');
  const safe = (s) => s.replace(/<\/(script|style)/gi, '<\\/$1');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</title>
  <style data-decklight-runtime="css">
${safe(css)}
  </style>
  <style data-theme="${theme}">
${safe(themeCss)}
  </style>
</head>
<body>
  <div class="decklight">

${sections.join('\n\n')}

  </div>
  <script data-decklight-runtime="js">${safe(js)}</script>
  <script>Decklight.init({});</script>
</body>
</html>
`;
}

/**
 * What to say about a file this importer cannot read AND has no installed
 * adapter for.
 *
 * Two answers, deliberately distinguishable — "no adapter exists" and "one
 * exists and here is how to get it". An INSTALLED adapter is a third state,
 * but it is not one this function ever needs to describe: `importMain`
 * checks for an installed adapter before reaching here, and runs it instead
 * (`EXTENSIONS#ADAPTEREXEC`, `cli/loader.mjs`'s `runImporter`) — reaching this
 * function at all already means there is nothing installed to run.
 */
export async function adapterOffer(source, { home } = {}) {
  const name = basename(String(source ?? ''));
  const ext = /(\.[A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  const out = [`decklight import: don't know how to read ${name}`,
    '  supported: .pptx, .key (macOS), or a Google Slides URL'];
  if (!ext) return out;

  const { adapterFor } = await import('./units.mjs');
  const offered = adapterFor(ext, home);
  if (!offered) return out;

  out.push(`  no adapter for ${ext} — ${offered.qualified} reads it:`,
    `    decklight importer add ${offered.qualified}`);
  return out;
}

export async function importMain(args = []) {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return args.length ? 0 : 1;
  }
  const { opt } = argReader(args);
  const VALUE = new Set(['-o', '--theme', '--build']);
  const source = args.find((a, i) => !a.startsWith('-') && !VALUE.has(args[i - 1]));
  if (!source) { console.error(`decklight import: needs a file or a Google Slides URL\n\n${USAGE}`); return 1; }

  const theme = opt('--theme', 'midnight');
  if (!existsSync(join(THEMES_DIR, `${theme}.css`))) {
    const all = readdirSync(THEMES_DIR).filter((f) => f.endsWith('.css')).map((f) => f.replace(/\.css$/, ''));
    console.error(`decklight import: no theme "${theme}"`);
    console.error(`  available: ${all.join(', ')}`);
    return 1;
  }
  const build = opt('--build', 'auto');
  if (!['auto', 'all', 'none'].includes(build)) {
    console.error(`decklight import: --build must be auto, all or none (got "${build}")`);
    return 1;
  }

  const out = outPath(source, opt('-o'));
  if (existsSync(out) && !args.includes('--force')) {
    console.error(`decklight import: ${out} already exists — pass --force to overwrite`);
    return 1;
  }

  // ---- get a .pptx, whichever door we came in by ------------------------
  const kind = sourceKind(source);
  let bytes;
  let cleanup = () => {};
  try {
    if (kind === 'pptx') {
      if (!existsSync(source)) { console.error(`decklight import: no such file: ${source}`); return 1; }
      bytes = readFileSync(source);
    } else if (kind === 'keynote') {
      if (!existsSync(source)) { console.error(`decklight import: no such file: ${source}`); return 1; }
      console.error(`import: asking Keynote to export ${basename(source)} as PowerPoint…`);
      const done = convertKeynote(source);
      cleanup = done.cleanup;
      bytes = readFileSync(done.file);
    } else if (kind === 'gslides') {
      console.error('import: downloading the deck from Google as .pptx…');
      bytes = await fetchSlides(source);
    } else if (kind === 'ppt') {
      console.error('decklight import: .ppt is the pre-2007 binary format, which decklight cannot read.');
      console.error('  Open it in PowerPoint or Keynote and save as .pptx first.');
      return 1;
    } else if (kind === 'url') {
      console.error('decklight import: that URL is not a Google Slides presentation.');
      console.error('  Expected https://docs.google.com/presentation/d/<id>/…');
      return 1;
    } else {
      // The offer at the point of failure (UNITS#REST): the moment someone
      // learns .marp is unsupported is the only moment they care which adapter
      // reads it, so the answer belongs HERE rather than in a setup step
      // nobody performs in advance. This is the ENGINES pattern.
      //
      // Cache-only, always: the lookup reads catalogs already on disk, so a
      // command that worked offline before still does. With nothing cached it
      // simply has nothing to add, and the message is the one it always was.
      const ext = /(\.[A-Za-z0-9]+)$/.exec(basename(source))?.[1]?.toLowerCase() ?? '';
      const { adapterFor, findUnit } = await import('./units.mjs');
      const offered = ext ? adapterFor(ext) : null;
      const installedAdapter = offered && findUnit('importer', offered.name);
      if (!installedAdapter) {
        for (const line of await adapterOffer(source)) console.error(line);
        return 1;
      }

      // An installed adapter runs (EXTENSIONS#ADAPTEREXEC, SPEC
      // EXTENSIONS_ADAPTERS) — bytes in, one HTML string of section markup
      // out, the same in-process trust model `bundle --transform` already
      // uses. It has no per-slide report the way the built-in PowerPoint path
      // does (that shape is deliberately not part of the v1 adapter
      // contract), so it writes the deck and returns here rather than
      // falling into the `convert()` pipeline below.
      if (!existsSync(source)) { console.error(`decklight import: no such file: ${source}`); return 1; }
      console.error(`import: reading ${basename(source)} with ${offered.name}…`);
      const { runImporter } = await import('./loader.mjs');
      const { html: sectionsHtml } = await runImporter(offered.name, readFileSync(source));

      const title = basename(out).replace(/\.html$/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
      writeFileSync(out, deckHtml([sectionsHtml], { title, theme }));
      const slideCount = (sectionsHtml.match(/<section[\s>]/gi) ?? []).length;
      const kb = Math.round(readFileSync(out).length / 1024);
      console.error(`${out} · ${slideCount} slide(s) · theme ${theme} · ${kb} KB · imported via ${offered.name}`);
      return 0;
    }
  } catch (e) {
    console.error(`decklight import: ${e.message}`);
    return 1;
  }

  // ---- convert ----------------------------------------------------------
  let result;
  try {
    result = convert(unzip(bytes), { build });
  } catch (e) {
    console.error(`decklight import: ${e.message}`);
    return 1;
  } finally {
    cleanup();
  }

  const verbose = args.includes('-v') || args.includes('--verbose');
  let dropped = 0;
  for (const row of result.report) {
    if (row.hidden) {
      const t = decodeEntities((row.title ?? '').replace(/<[^>]+>/g, ''));
      console.error(`  ${String(row.n).padStart(3)}  ⊘ hidden slide skipped${t ? ` — ${t}` : ''}`);
      continue;
    }
    // the title is HTML by now; the terminal wants the words back
    const name = decodeEntities((row.title ?? '(no title)').replace(/<[^>]+>/g, '')).slice(0, 44);
    if (row.drops.length) {
      dropped += row.drops.length;
      console.error(`  ${String(row.n).padStart(3)}  ⚠ ${name}${row.did.length ? ` — ${row.did.join(' · ')}` : ''}`);
      for (const d of row.drops) console.error(`       ${d}`);
    } else if (verbose) {
      console.error(`  ${String(row.n).padStart(3)}    ${name}${row.did.length ? ` — ${row.did.join(' · ')}` : ''}`);
    }
  }

  const title = basename(out).replace(/\.html$/, '').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  writeFileSync(out, deckHtml(result.sections, { title, theme }));
  const kb = Math.round(readFileSync(out).length / 1024);
  console.error(`${out} · ${result.sections.length} slides · theme ${theme} · ${kb} KB`
    + (dropped ? ` · ${dropped} thing(s) dropped — see ⚠ above` : ''));
  if (!verbose && !dropped) console.error('  everything converted; -v lists each slide');
  return 0;
}

if (isMain(import.meta.url)) process.exit(await importMain(process.argv.slice(2)));
