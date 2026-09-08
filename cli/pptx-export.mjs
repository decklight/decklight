// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight pptx — a deck as a PowerPoint file, lossy on purpose.
//
// Each slide is rendered by a one-shot headless Chrome at its own 1280×720
// with every build complete (the mechanism tools/video.mjs and tools/shot.mjs
// use), and becomes one picture filling one 16:9 page; the speaker notes ride
// along as real notes. Nothing round-trips — see tools/pptx-write.mjs for why
// that is the design and not a gap.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { chromeBin, chromeArgs } from '../tools/chrome.mjs';
import { argReader } from '../tools/args.mjs';
import { runAsync, CODEC_MS } from '../tools/exec.mjs';
import { NOTES_ASIDE, cleanNotes, sectionBodies, isHiddenSection } from '../tools/deck-html.mjs';
import { buildPptx } from '../tools/pptx-write.mjs';
import { serveForRender } from './present.mjs';

const USAGE = `usage: decklight pptx <deck.html> [-o out.pptx] [--theme <name>] [--wait <ms>]
  writes a PowerPoint file: every slide as a picture, rendered at 1280×720 with
  its builds complete, and its speaker notes as real notes

  -o <file>      output path                    [the deck's, with .pptx]
  --theme <name> export in another theme (rides ?theme=)
  --wait <ms>    render budget per slide        [1500]

  Hidden slides (data-hidden) are not in the file, exactly as they are not in
  the pdf, the video or the voiceover — the file is the talk, not the archive.

  Lossy by design: the file OPENS in PowerPoint, Keynote and Slides, and the
  notes are text there — but the slides are pictures. Import it back and you
  get pictures. Decklight is for people who never liked PowerPoint; this is
  for the people around them who still ask for the file.`;

/** The deck's path with .pptx in place of .html — or whatever -o said. */
export const pptxOut = (deckPath, oFlag) => (oFlag ? resolve(oFlag) : resolve(deckPath.replace(/\.html?$/i, '') + '.pptx'));

/**
 * Speaker notes per slide, as lines. Paragraphs and line breaks become lines,
 * tags fall away, entities come back — the same reading the voiceover and
 * the speaker view give the aside, so what PowerPoint shows is what the
 * presenter saw.
 */
export function notesLines(html) {
  return sectionBodies(html).map((sec) => {
    const m = sec.match(NOTES_ASIDE);
    if (!m) return [];
    return m[1].split(/<\/p>|<br\s*\/?>|\n{2,}/i).map((part) => cleanNotes(part)).filter(Boolean);
  });
}

/** The deck's <title>, else its file name. */
const titleOf = (html, file) => cleanNotes(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '') || basename(file).replace(/\.html?$/i, '');

/**
 * Chrome, ASYNC — `runAsync`, never `run`.
 *
 * The deck is served from THIS process (serveForRender, PRESENTING) so that a
 * relative asset still resolves and the CSP is the one `present` applies. A
 * synchronous child blocks the event loop, so the server never answers the
 * browser it just launched: Chrome waits for a first byte that cannot arrive
 * until Chrome exits. 0.8.0 shipped exactly that — every `decklight pptx`
 * stalled for the full five-minute budget and then reported a hang whose real
 * cause was one import. tools/shot.mjs carries the same warning above the same
 * call; test/pptx-render.mjs is what now notices.
 */
export async function chromeShot(bin, argv, _ctx, { timeout = CODEC_MS } = {}) {
  await runAsync(bin, argv, { maxBuffer: 32 * 1024 * 1024, timeout, why: 'Chrome did not finish rendering a slide — it is probably waiting on a resource it cannot reach' });
}

export async function pptxMain(args = [], { render = chromeShot, log = console.error } = {}) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const { opt } = argReader(args);
  const deck = args.find((a) => !a.startsWith('-') && /\.html?$/i.test(a));
  if (!deck) { log(`decklight pptx: needs a deck\n\n${USAGE}`); return 1; }
  const src = resolve(deck);
  if (!existsSync(src)) { log(`decklight pptx: no such deck: ${deck}`); return 1; }
  // The deck is SERVED (see chromeShot), and a server has one root. A deck
  // under the current directory keeps it as the root, which is what lets a
  // deck in a subdirectory reach the dist/ and themes/ at the top of its
  // project. A deck anywhere else is served from its OWN directory rather
  // than refused: `decklight pptx ~/talks/q3.html` is a reasonable thing to
  // type from anywhere, and a deck's assets are its siblings.
  const root = src.startsWith(process.cwd() + sep) ? process.cwd() : dirname(src);
  const out = pptxOut(src, opt('-o'));
  const wait = Number(opt('--wait', 1500));
  const theme = opt('--theme');
  const html = readFileSync(src, 'utf8');
  const notes = notesLines(html);
  // HIDDEN_SLIDES — the file you hand over holds what the audience saw, the
  // same rule `pdf`, `video` and `voiceover` already keep. Not merely a
  // preference: a deep link onto a hidden slide lands on its nearest SHOWN
  // neighbour (the engine's `goto`), so exporting one wrote that neighbour's
  // picture a second time, carrying the hidden slide's notes.
  const shown = sectionBodies(html).map((b, i) => (isHiddenSection(b) ? 0 : i + 1)).filter(Boolean);
  const total = notes.length;
  const count = shown.length;
  if (!total) { log('decklight pptx: the deck has no <section> slides'); return 1; }
  if (!count) { log('decklight pptx: every slide in this deck is hidden — there is nothing to hand over'); return 1; }

  // served, not file://, so every relative asset the deck names still resolves
  const inject = (text, file) => (file === src && theme ? text.replace(/(<\/head>)/i, `<link rel="stylesheet" href="themes/${theme}.css">$1`) : text);
  const server = await serveForRender(root, { html: inject });
  const scratch = mkdtempSync(join(tmpdir(), 'decklight-pptx-'));
  const slides = [];
  try {
    const deckPath = '/' + relative(root, src).split(sep).join('/');
    const bin = chromeBin('pptx');
    log(`pptx: rendering ${basename(src)} — ${count} slides at 1280×720, builds complete`
      + (total > count ? ` · ${total - count} hidden, skipped` : ''));
    for (const n of shown) {
      const png = join(scratch, `slide-${n}.png`);
      // /999 lands on the last build step, whatever the slide has
      await render(bin, chromeArgs(
        '--hide-scrollbars', '--window-size=1280,720', `--virtual-time-budget=${wait}`,
        `--screenshot=${png}`, `${server.origin}${deckPath}#/${n}/999`,
      ), { n, png });
      if (!existsSync(png) || statSync(png).size === 0) { log(`decklight pptx: slide ${n} did not render — try a longer --wait`); return 1; }
      slides.push({ png: readFileSync(png), notes: notes[n - 1] });
    }
  } finally {
    await server.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  const bytes = buildPptx(slides, { title: titleOf(html, src) });
  writeFileSync(out, bytes);
  const withNotes = shown.filter((n) => notes[n - 1].length).length;
  console.log(`${out} · ${count} slides as pictures${total > count ? ` (${total - count} hidden, skipped)` : ''}`
    + ` · ${withNotes} with notes · ${Math.round(bytes.length / 1024)} KB`);
  return 0;
}
