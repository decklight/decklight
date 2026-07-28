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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { chromeBin, chromeArgs } from '../tools/chrome.mjs';
import { argReader, isMain } from '../tools/args.mjs';

const USAGE = `usage: decklight pdf <deck.html> [-o out.pdf] [--theme <name>] [--wait <ms>]
  renders the deck's ?print view to a PDF — one slide per page, at the deck's
  own 1280×720, in its theme, with every build complete

  -o <file>      output path                    [the deck's, with .pdf]
  --theme <name> export in another theme (rides ?theme=)
  --wait <ms>    render budget for heavy decks  [8000]

  slides the print-mode overflow guardrail flags are named on stderr; the PDF
  is still written (a clipped slide is worth knowing about, not worth refusing)`;

/** The deck's path with .pdf in place of .html — or whatever -o said. */
export function pdfOut(deckPath, oFlag) {
  if (oFlag) return resolve(oFlag);
  return resolve(deckPath.replace(/\.html?$/i, '') + '.pdf');
}

/**
 * The URL to print. `?print` is the whole rendering contract; `?theme=` is the
 * existing startup override, so exporting in another theme costs nothing here.
 */
export function printUrl(absDeckPath, { theme } = {}) {
  const q = theme ? `?print&theme=${encodeURIComponent(theme)}` : '?print';
  return `file://${absDeckPath}${q}`;
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
 * Which slides the print-mode guardrail flagged, 1-based, from a dumped DOM.
 * Sections are in document order in print mode (print never re-runs sync()),
 * so position IS the slide number.
 */
export function overflowSlides(html) {
  const out = [];
  let n = 0;
  for (const m of html.matchAll(/<section\b[^>]*>/g)) {
    n += 1;
    if (/\bdata-overflow\b/.test(m[0])) out.push(n);
  }
  return out;
}

/** Slides in the printed deck — the number the page count should equal. */
export const slideCount = (html) => (html.match(/<section\b/g) ?? []).length;

const KB = (n) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export async function pdfMain(args = []) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const { opt } = argReader(args);
  const deck = args.find((a) => !a.startsWith('-') && /\.html?$/i.test(a));
  if (!deck) { console.error(`decklight pdf: needs a deck\n\n${USAGE}`); return 1; }
  const src = resolve(deck);
  if (!existsSync(src)) { console.error(`decklight pdf: no such deck: ${deck}`); return 1; }

  const out = pdfOut(src, opt('-o'));
  const theme = opt('--theme');
  const wait = Number(opt('--wait', 8000));
  const url = printUrl(src, { theme });
  const bin = chromeBin('pdf');
  // file:// decks load their runtime, themes and casts as siblings
  const shared = chromeArgs('--allow-file-access-from-files', `--virtual-time-budget=${wait}`);

  // Pass one: the DOM, for the slide count and the overflow audit. Cheap — the
  // same URL, the same budget, and it is the only way to know what the PDF is
  // about to hide.
  let html = '';
  try {
    html = execFileSync(bin, [...shared, '--dump-dom', url],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { /* the print pass below is the one that must succeed */ }
  const slides = slideCount(html);
  console.error(`pdf: rendering ${basename(src)}?print${theme ? ` · theme ${theme}` : ''}`
    + `${slides ? ` — ${slides} slides, builds complete, casts expanded` : ''}`);

  rmSync(out, { force: true }); // never leave a stale PDF looking like a fresh one
  try {
    execFileSync(bin, [...shared, '--no-pdf-header-footer', `--print-to-pdf=${out}`, url],
      { stdio: ['ignore', 'ignore', 'ignore'] });
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
  const buf = readFileSync(out);
  const pages = pdfPageCount(buf);
  console.log(`${out} · ${pages || '?'} pages · 1280×720 (16:9) · ${KB(buf.length)}`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(await pdfMain(process.argv.slice(2)));
