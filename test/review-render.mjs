// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Review comments in a real browser (SPEC REVIEW).
//
// Three modes, and one thing that can only be checked here: the fingerprint the
// BROWSER computes for a slide has to be the one a tool reading the FILE
// computes, or a comment written in the deck cannot be found by `decklight
// comments` — silently, and only for some slides. The unit tests pin each
// reader on its own; a regex pretending to be a DOM would only prove that two
// regexes agree. So the browser's own index is carried out of the page and
// compared against the file reader here.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';
import { indexDeckFile } from '../cli/comments.mjs';
import { readFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = path.join(here, 'review.html');

let bad = 0;
const run = (mode, extra = '') => resultsFrom(
  dumpDom(`file://${page}?mode=${mode}${extra}`, {
    budget: 30_000, fileAccess: true, quietStderr: true, who: 'review-render',
  }), 'REVIEW', `mode=${mode}`);

// ── the seam ──────────────────────────────────────────────────────────────
{
  const r = run('reviewer');
  const ok = r.PASS === true;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} reviewer   composer on the slide you are looking at=${r.saysWhichSlide}`
    + ` · what it posted carries the anchor=${r.anchoredToTheSlideOnScreen}`
    + ` · listed straight after=${r.listedAfterPosting}`
    + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));

  // The browser read this deck through the DOM; read the same file the way a
  // tool does and the two indexes must be identical, fingerprints included.
  const fromFile = indexDeckFile(readFileSync(page, 'utf8'));
  const fromDom = r.browserIndex ?? [];
  const same = JSON.stringify(fromFile) === JSON.stringify(fromDom);
  if (!same) bad++;
  console.log(`${same ? 'ok  ' : 'FAIL'} seam       the browser and the file agree on every slide's`
    + ` title and fingerprint (${fromDom.length} slides)`);
  if (!same) {
    console.error('  dom :', JSON.stringify(fromDom));
    console.error('  file:', JSON.stringify(fromFile));
  }
}

// ── the panel docks beside the slide ──────────────────────────────────────
{
  const r = run('dock');
  const ok = r.PASS === true;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} dock       opens floating=${r.defaultFloat}`
    + ` · docks right & reflows the stage=${r.dockedRight && r.stageReflowed}`
    + ` · deck still navigable=${r.arrowNavigatedDeck}`
    + ` · target follows then locks=${r.targetFollowedWhileEmpty && r.targetLockedWhileTyping}`
    + ` · gutter released on close=${r.gutterReleased}`
    + ` · placement remembered=${r.persisted && r.restoredPlacement}`
    + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
}

// ── the deck moves under the comments ─────────────────────────────────────
{
  const r = run('moved', '&seed');
  const ok = r.PASS === true;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} moved      found the moved slide=${r.foundTheMovedSlide}`
    + ` · flagged the edited one=${r.flaggedTheEdited}`
    + ` · the deleted one is not re-pinned=${r.orphanNotRepinned}`
    + ` · ⏎ went where it is NOW=${r.jumpedToWhereItIsNow} (slide ${r.jumpedTo})`
    + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
}

// ── the author's side ─────────────────────────────────────────────────────
{
  const r = run('author', '&seed');
  const ok = r.PASS === true;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} author     no composer=${r.noComposerForAnAuthor}`
    + ` · R arms rather than fires=${r.armedNotFired} (nothing sent=${r.nothingPostedYet})`
    + ` · Esc disarms without closing=${r.escapeDisarmedNotClosed}`
    + ` · a resolve is an append=${r.resolveIsAnAppend}`
    + (r.exception ? ` · ${r.exception.split('\n')[0]}` : ''));
}

console.log(bad ? `review-render: ${bad} FAILED` : 'review-render: PASS');
process.exit(bad ? 1 : 0);
