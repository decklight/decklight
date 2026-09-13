// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The two block scanners `decklight upgrade` and the ingredients label
// (SPEC PRESENTING) share — `headStyles` and `scripts`.
//
// They had no test of their own, and everything downstream is string surgery
// on the offsets they return: upgrade splices new text at [start, end) and the
// audit names unaccounted scripts by them. An off-by-one there does not throw,
// it writes a deck with half a tag in it. The two failure modes worth pinning
// are both about what is NOT markup — a `<style>` merely mentioned inside an
// HTML comment (masked, never removed, so later offsets stay exact) and a
// scriptSafe-escaped `<\/script` inside a payload — plus the head boundary,
// which is the only thing keeping the inlined runtime's own strings from
// being scanned as tags.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headStyles, scripts } from '../cli/upgrade.mjs';

// One deck-shaped document reused by most cases: a comment that talks about
// markup, two head styles, a body style past </head>, and two scripts.
const RUNTIME_STYLE = '<style data-decklight-runtime="css">.decklight{color:red}</style>';
const THEME_STYLE = '<style data-theme="midnight" media="not all">.t{}</style>';
const BODY_STYLE = '<style id="late">.after-head{}</style>';
const RUNTIME_SCRIPT = '<script data-decklight-runtime="js">var Decklight = {};</script>';
const MODULE_SCRIPT = '<script type="module">import "./x.js";</SCRIPT>';

const DECK = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '<!-- the runtime <style> block is written by init; this mention is prose -->',
  RUNTIME_STYLE,
  THEME_STYLE,
  '</head>',
  '<body>',
  BODY_STYLE,
  RUNTIME_SCRIPT,
  MODULE_SCRIPT,
  '</body>',
  '</html>',
].join('\n');

// ── comments are masked, not removed ───────────────────────────────────────

test('a <style> mentioned inside an HTML comment is not a block', () => {
  const found = headStyles(DECK);
  assert.equal(found.length, 2, 'the comment\'s "<style>" must not pair with the real </style> below it');
  assert.deepEqual(found.map((s) => s.tag), [RUNTIME_STYLE, THEME_STYLE],
    'an invented block spanning the gap would make upgrade splice over the comment');
});

test('masking a comment leaves every later offset exact', () => {
  // Masking blanks characters in place rather than deleting them, so the
  // ranges still index the ORIGINAL html. This is the invariant upgrade bets
  // on when it writes `html.slice(0, start) + text + html.slice(end)`.
  const [runtime] = headStyles(DECK);
  assert.equal(runtime.start, DECK.indexOf(RUNTIME_STYLE),
    'an offset measured against a comment-stripped copy would land short by the comment\'s length');
  assert.equal(DECK.slice(runtime.start, runtime.end), RUNTIME_STYLE,
    'the range must reproduce the block byte-for-byte or the splice eats its neighbours');
});

test('a comment that mentions a script does not open one', () => {
  const html = [
    '<body>',
    '<!-- slide 15: its text lives inside a <script> tag -->',
    '<p>prose</p>',
    '<script>real();</script>',
    '</body>',
  ].join('\n');
  const found = scripts(html);
  assert.equal(found.length, 1, 'the mention must not pair with the real </script> several lines below');
  assert.equal(found[0].inner, 'real();', 'an invented block would swallow the author\'s prose');
});

// ── the head boundary ──────────────────────────────────────────────────────

test('a <style> after </head> is not a head style', () => {
  const found = headStyles(DECK);
  assert.ok(!found.some((s) => s.tag === BODY_STYLE),
    'the scan is head-bounded because the inlined runtime script carries "<style" as a string');
  assert.ok(DECK.includes(BODY_STYLE), 'the fixture really does put a style past </head>');
});

// Was a bug: headStyles finds headEnd in the RAW html (cli/upgrade.mjs:63) but
// matches against the masked copy (:66), so a </head> inside a comment
// truncates the head and every real style below it is dropped — upgrade then
// warns "no runtime <style> block found in <head>" and leaves the css un-
// upgraded
test('a </head> mentioned in a comment is not the head boundary', () => {
  // Masking exists precisely so a comment that TALKS about markup is not
  // markup. The boundary has to be read from the masked copy for that to hold.
  const html = [
    '<head>',
    '<!-- everything above </head> is the head -->',
    '<style data-decklight-runtime="css">.decklight{}</style>',
    '</head>',
  ].join('\n');
  const found = headStyles(html);
  assert.equal(found.length, 1, 'the runtime style really is inside the head');
  assert.match(found[0].attrs, /data-decklight-runtime/, 'and it is the block upgrade would replace');
});

test('a document with no </head> at all is scanned end to end', () => {
  // A fragment, or a deck whose head was never closed: -1 means "no boundary",
  // not "boundary at zero" — reading it as zero would return nothing at all.
  const html = `<style id="a">.a{}</style>\n<p>x</p>\n<style id="b">.b{}</style>`;
  const found = headStyles(html);
  assert.equal(found.length, 2, 'a missing </head> must not silently empty the result');
  assert.deepEqual(found.map((s) => s.attrs), [' id="a"', ' id="b"'],
    'both blocks come back in document order');
});

// ── script blocks ──────────────────────────────────────────────────────────

test('a closing tag in mixed case still closes the block', () => {
  // HTML tag names are case-insensitive and hand-edited decks prove it.
  const found = scripts(DECK);
  assert.equal(found.length, 2, 'both scripts are found');
  assert.equal(found[1].tag, MODULE_SCRIPT, '</SCRIPT> closes just as </script> does');
  assert.equal(found[1].inner, 'import "./x.js";',
    'a missed closer would run the block to the end of the document');
});

test('a script\'s attributes round-trip verbatim, leading space included', () => {
  // upgrade rebuilds theme blocks as `<style${attrs}>`, so the captured text
  // has to be exactly what sat between the tag name and the ">".
  const found = scripts(DECK);
  assert.equal(found[1].attrs, ' type="module"',
    'dropping the leading space would emit <scripttype="module">');
  assert.equal(found[0].attrs, ' data-decklight-runtime="js"',
    'the marker attribute is how the next upgrade finds this block');
});

test('a scriptSafe-escaped closer inside a payload does not end the block', () => {
  // init, bundle and upgrade all guarantee the inlined runtime is escaped this
  // way, which is what makes a whole-document script scan safe. If `<\/script`
  // terminated the block, upgrade would splice its replacement over the first
  // half of the runtime and leave the rest as loose text in the page.
  const inner = 'var close = "<\\/script>"; var open = "<script>";';
  const html = `<body><script data-decklight-runtime="js">${inner}</script><p>after</p></body>`;
  const found = scripts(html);
  assert.equal(found.length, 1, 'the escaped closer is not a closer');
  assert.equal(found[0].inner, inner, 'the whole payload belongs to the block');
  assert.ok(html.slice(found[0].end).startsWith('<p>after</p>'),
    'the block ends at the real </script>, leaving the rest of the document intact');
});

// ── the invariant every caller depends on ──────────────────────────────────

test('slicing the html at a returned range reproduces that block', () => {
  for (const s of [...headStyles(DECK), ...scripts(DECK)]) {
    assert.equal(DECK.slice(s.start, s.end), s.tag,
      `range [${s.start}, ${s.end}) must index the original html, not a masked copy`);
    assert.ok(s.end > s.start, 'a range is non-empty');
  }
});

test('ranges come back in document order and never overlap', () => {
  // upgrade sorts its edits by descending start and splices them one after the
  // other; overlapping ranges would corrupt the file rather than fail.
  const all = [...headStyles(DECK), ...scripts(DECK)].sort((a, b) => a.start - b.start);
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i].start >= all[i - 1].end,
      `block ${i} starts at ${all[i].start}, inside the block ending at ${all[i - 1].end}`);
  }
});
