// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The H overlay's preview staying the size of a slide (SPEC PRESENTING).
//
// It once rendered 57px wide. Not by anyone choosing 57 — the rail was
// declared `flex: 0 0 300px` and rendered 785px, because a flex item's default
// `min-width: auto` forbids shrinking below its own MIN-CONTENT width, and the
// rail's content was a `white-space: nowrap` title bar 774px long. The declared
// basis was a suggestion its own content could veto. The preview got the
// remainder.
//
// That is a whole class of bug rather than one typo, and the thing that makes
// it nasty is that nothing fails: the CSS is valid, the layout is valid, and
// the pane is simply the wrong size until somebody looks. There is no headless
// harness that opens this overlay (it needs an edit server and a git
// repository), so these assert the RULES that make the collapse impossible.
// A source test, deliberately, and narrow enough to say what it means.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const css = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/decklight.css'), 'utf8');

/** The declaration block for `selector`, or null. */
function ruleFor(selector) {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return null;
  return css.slice(at + selector.length + 2, css.indexOf('}', at));
}

test('the history rail may shrink below its content', () => {
  // The one line that turns `flex-basis` back into a real basis. Without it
  // every other rule here is advisory.
  const side = ruleFor('.decklight-history .tp-side');
  assert.ok(side, 'no .decklight-history .tp-side rule — the rail is unconstrained again');
  assert.match(side, /min-width:\s*0/,
    'the rail lost `min-width: 0`, so its content can veto its width again (that is the 57px bug)');
});

test('nothing in the rail is a single unbreakable line', () => {
  // Two things live in that column and both used to be nowrap. Either one is
  // enough to set the column's min-content width to its full length.
  const filter = ruleFor('.decklight-history .tp-filter');
  assert.ok(filter, 'no .decklight-history .tp-filter rule');
  assert.match(filter, /white-space:\s*normal/,
    'the title bar is nowrap again — its full sentence becomes the rail\'s minimum width');

  const row = ruleFor('.decklight-history .tp-row');
  assert.ok(row, 'no .decklight-history .tp-row rule');
  assert.doesNotMatch(row, /white-space:\s*nowrap/,
    'a nowrap row makes the longest commit subject the rail\'s minimum width');
});

test('the row is two lines, not four things competing for one', () => {
  // The structural half of the fix: with the subject on its own line the row
  // has no horizontal appetite left to express.
  const row = ruleFor('.decklight-history .tp-row');
  assert.match(row, /display:\s*block/,
    'the row went back to flex — that is the layout whose min-content was the sum of four columns');
  assert.ok(ruleFor('.decklight-history .hs-meta'), 'the metadata line has no rule of its own');
});

test('the subject is clamped, so a row has a knowable height', () => {
  // Unbounded wrapping trades one bug for another: a 200-character commit
  // subject would push every other commit off the visible list.
  const subj = ruleFor('.decklight-history .rs-subject');
  assert.ok(subj, 'no .decklight-history .rs-subject rule');
  assert.match(subj, /line-clamp:\s*2/);
  assert.match(subj, /overflow:\s*hidden/);
});

test('the preview is shaped like a slide', () => {
  // A deck is 1280×720. Before this the iframe was `flex: 1` inside a column,
  // so it took whatever height was left and letterboxed the slide into it —
  // 57×250 in the collapsed case, which is a portrait sliver of a landscape
  // thing.
  const frame = ruleFor('.decklight-history .tp-preview iframe');
  assert.ok(frame, 'no .decklight-history .tp-preview iframe rule');
  assert.match(frame, /aspect-ratio:\s*16\s*\/\s*9/);
});

test('the caption cannot grow to hide a collapse', () => {
  // It wrapped to eight lines at 57px wide — one word per line — which is the
  // symptom that made the screenshot look like a caption bug rather than a
  // layout one. A single truncating line makes the pane's size the only thing
  // that can be wrong.
  const cap = ruleFor('.decklight-history .tp-caption');
  assert.ok(cap, 'no .decklight-history .tp-caption rule');
  assert.match(cap, /white-space:\s*nowrap/);
  assert.match(cap, /text-overflow:\s*ellipsis/);
});

test('the panel is wide enough for the preview to be worth having', () => {
  const panel = ruleFor('.decklight-history .tp-panel');
  assert.ok(panel, 'no .decklight-history .tp-panel rule');
  const m = /min\((\d+)px/.exec(panel);
  assert.ok(m, 'the panel width is no longer a min(px, vw) pair');
  assert.ok(Number(m[1]) >= 1000, `panel caps at ${m[1]}px — the preview cannot reach slide size`);
  assert.match(panel, /9\d?vw/, 'no viewport cap — the panel would overflow a small screen');
});
