#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight pdf — a deck as one shareable file, without the print dialog.
//
//   decklight pdf <deck.html> [-o out.pdf] [--theme name] [--wait ms]
//
// There is almost nothing here, and that is the point: `?print` (SPEC PRESENTING)
// already renders every slide with every build complete, casts expanded and
// strokes drawn, at 1280×720 with a matching @page. A human can already get
// this PDF through File → Print → Save as PDF. This command only removes the
// human from that loop — headless Chrome, the same one tools/shot.mjs drives,
// pointed at the same URL.
//
// The one thing it does beyond printing is TELL YOU what is wrong: print mode
// stamps [data-overflow] on every clipped slide, so a second pass over the same
// URL reads those back and names them on stderr. A clipped slide in a PDF you
// have already emailed is a slide nobody can fix.

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { chromeBin, chromeArgs } from '../tools/chrome.mjs';
import { argReader, isMain } from '../tools/args.mjs';
import { runAsync, CODEC_MS } from '../tools/exec.mjs';
import { sectionBodies, isHiddenSection } from '../tools/deck-html.mjs';

/**
 * How many slides the handout puts on a page — the runtime's own number,
 * RESTATED rather than imported.
 *
 * `src/core/print.js` exports it and this file used to import it, which works
 * in a clone and cannot work in an install: the package ships `cli/`, `tools/`,
 * `dist/`, `themes/` and `docs/` — never `src/`, whose only shipped form is the
 * bundle. `npm test` and `npm run verify` both drive the CLI out of the working
 * tree, so both were green while `decklight pdf` was a `Cannot find module` for
 * everyone who had installed it. `npm run soak` caught it at step 40.
 *
 * The pair is kept honest by test/pdf.test.mjs, which reads the number out of
 * both sources and fails when they drift — the same shape as the harness list
 * that verify.mjs spells out for tools/test-impact.mjs.
 */
export const HANDOUT_PER_PAGE = 3;

const USAGE = `usage: decklight pdf <deck.html> [-o out.pdf] [--theme <name>] [--wait <ms>]
                    [--notes | --handout]
  renders the deck's ?print view to a PDF — one slide per page, at the deck's
  own 1280×720, in its theme, with every build complete

  -o <file>      output path                    [the deck's, with .pdf]
  --notes        one slide per page with its speaker notes underneath —
                 the presenter's copy               [out: <deck>.notes.pdf]
  --handout      three slides a page, portrait, ruled lines beside each for
                 the audience to write on           [out: <deck>.handout.pdf]
  --theme <name> export in another theme (rides ?theme=)
  --wait <ms>    render budget for heavy decks  [8000]

  slides the print-mode overflow guardrail flags are named on stderr; the PDF
  is still written (a clipped slide is worth knowing about, not worth refusing)`;

/** The deck's path with .pdf in place of .html — or whatever -o said. */
export function pdfOut(deckPath, oFlag, variant = '') {
  if (oFlag) return resolve(oFlag);
  // a variant gets its own name, so the handout never overwrites the slides
  return resolve(deckPath.replace(/\.html?$/i, '') + (variant ? `.${variant}` : '') + '.pdf');
}

/**
 * The URL to print. `?print` is the whole rendering contract; `?theme=` is the
 * existing startup override, so exporting in another theme costs nothing here.
 */
export function printUrl(absDeckPath, { theme, variant = '' } = {}) {
  // `?print=notes` / `?print=handout` are the runtime's own variants (src/core/print.js)
  const print = variant ? `?print=${variant}` : '?print';
  const q = theme ? `${print}&theme=${encodeURIComponent(theme)}` : print;
  return `file://${absDeckPath}${q}`;
}

/**
 * How many pages the PDF should have: one per slide, except the handout,
 * which groups HANDOUT_PER_PAGE to a page — the same number print.js
 * paginates with, held to it by a test rather than by an import.
 */
export function expectedPages(slides, variant = '') {
  return variant === 'handout' ? Math.ceil(slides / HANDOUT_PER_PAGE) : slides;
}

/**
 * How many pages Chrome actually wrote.
 *
 * By regex over the bytes, deliberately: a PDF library would be the only
 * runtime-adjacent dependency in the repo, for one number. `/Type /Page` (not
 * `/Pages`, the tree node) appears once per page object. If a future Chrome
 * moves those into compressed object streams the count comes back 0, so the
 * page-tree `/Count` is read as a fallback and 0 means "could not tell" — the
 * caller reports rather than asserts.
 */
export function pdfPageCount(buf) {
  const pages = (buf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  if (pages) return pages;
  const counts = [...buf.toString('latin1').matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return counts.length ? Math.max(...counts) : 0;
}

/**
 * Which slides carry a guardrail attribute, 1-based, from a dumped DOM.
 * Sections are in document order in print mode (print never re-runs sync()),
 * so position IS the slide number. The attribute must sit in the section TAG:
 * a deck that merely talks about data-overflow in a code sample stays clean.
 */
function flaggedSlides(html, attr) {
  const out = [];
  const has = new RegExp(`\\b${attr}\\b`);
  let n = 0;
  for (const m of html.matchAll(/<section\b[^>]*>/g)) {
    n += 1;
    if (has.test(m[0])) out.push(n);
  }
  return out;
}

/** Slides the overflow guardrail flagged (SPEC PRESENTING). */
export const overflowSlides = (html) => flaggedSlides(html, 'data-overflow');

/**
 * Slides mixing data-layout="split" with their own column flexbox (SPEC
 * COMPARISON_SLIDES) — the engine marks the cause the overflow guardrail
 * only ever catches the symptom of.
 */
export const splitConflictSlides = (html) => flaggedSlides(html, 'data-split-conflict');

/** Slides in the printed deck — the number the page count should equal. */
export const slideCount = (html) => sectionBodies(html).filter((b) => !isHiddenSection(b)).length;

const KB = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export async function pdfMain(args = []) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const { opt } = argReader(args);
  const deck = args.find((a) => !a.startsWith('-') && /\.html?$/i.test(a));
  if (!deck) { console.error(`decklight pdf: needs a deck\n\n${USAGE}`); return 1; }
  const src = resolve(deck);
  if (!existsSync(src)) { console.error(`decklight pdf: no such deck: ${deck}`); return 1; }

  const variant = args.includes('--notes') ? 'notes' : args.includes('--handout') ? 'handout' : '';
  if (args.includes('--notes') && args.includes('--handout')) {
    console.error('decklight pdf: --notes and --handout are two different PDFs — run it twice');
    return 1;
  }
  const out = pdfOut(src, opt('-o'), variant);
  const theme = opt('--theme');
  const wait = Number(opt('--wait', 8000));
  const url = printUrl(src, { theme, variant });
  const bin = chromeBin('pdf');
  // file:// decks load their runtime, themes and casts as siblings
  const shared = chromeArgs('--allow-file-access-from-files', `--virtual-time-budget=${wait}`);

  // Chrome is AWAITED, never `run`. Not for the deadlock reason pptx has (this
  // command opens the deck as a file, and serves nothing) but because the
  // author server runs `pdfMain` in its own process for the palette's Export
  // rows: a synchronous child would freeze live reload, the SSE stream and the
  // page itself for the ten seconds Chrome takes to print.
  //
  // Pass one: the DOM, for the slide count and the overflow audit. Cheap — the
  // same URL, the same budget, and it is the only way to know what the PDF is
  // about to hide.
  let html = '';
  try {
    html = await runAsync(bin, [...shared, '--dump-dom', url],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: CODEC_MS, why: 'Chrome did not finish rendering — a slide is probably waiting on a resource it cannot reach' });
  } catch { /* the print pass below is the one that must succeed */ }
  const slides = slideCount(html);
  console.error(`pdf: rendering ${basename(src)}?print${variant ? `=${variant}` : ''}${theme ? ` · theme ${theme}` : ''}`
    + `${slides ? ` — ${slides} slides, builds complete, casts expanded` : ''}`);

  rmSync(out, { force: true }); // never leave a stale PDF looking like a fresh one
  try {
    await runAsync(bin, [...shared, '--no-pdf-header-footer', `--print-to-pdf=${out}`, url],
      { maxBuffer: 32 * 1024 * 1024, timeout: CODEC_MS, why: 'Chrome did not finish rendering — a slide is probably waiting on a resource it cannot reach' });
  } catch (e) {
    console.error(`decklight pdf: Chrome failed — ${String(e.message ?? e).split('\n')[0]}`);
    return 1;
  }
  if (!existsSync(out) || statSync(out).size === 0) {
    console.error('decklight pdf: Chrome produced no PDF — try a longer --wait');
    return 1;
  }

  for (const n of overflowSlides(html)) {
    console.error(`pdf: ⚠ slide ${n} overflows — it will be clipped in the PDF`);
  }
  for (const n of splitConflictSlides(html)) {
    console.error(`pdf: ⚠ slide ${n} mixes data-layout="split" with its own column flexbox — `
      + 'two layout systems fight; drop one (SPEC COMPARISON_SLIDES)');
  }
  const buf = readFileSync(out);
  const pages = pdfPageCount(buf);
  const want = slides ? expectedPages(slides, variant) : 0;
  const geometry = variant === 'handout' ? 'portrait, 3 slides a page' : variant === 'notes' ? 'slide + notes per page' : '1280×720 (16:9)';
  console.log(`${out} · ${pages || '?'} pages · ${geometry} · ${KB(buf.length)}`);
  if (want && pages && pages !== want) {
    console.error(`pdf: ⚠ expected ${want} pages for ${slides} slides${variant ? ` (${variant})` : ''}, got ${pages}`);
  }
  return 0;
}

if (isMain(import.meta.url)) process.exit(await pdfMain(process.argv.slice(2)));
