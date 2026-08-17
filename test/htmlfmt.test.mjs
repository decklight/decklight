// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Making an element's source readable in the content editor without changing
// what it renders (SPEC `DECK_ANATOMY`).
//
// The stakes are the reason this is a test file rather than three lines inline:
// whatever the editor shows is what a save writes back over the deck. A
// formatter that is merely usually right would silently edit slides, and the
// author would find out at the worst possible moment. So the rule is narrow —
// remove a common leading prefix, insert and delete nothing else — and these
// pin both halves: that it tidies the case it exists for, and that it refuses
// every case where a space is content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedentHtml, dedentable } from '../src/core/htmlfmt.js';

test('the file\'s nesting depth comes off, and the element keeps its own', () => {
  // Verbatim from `/edit/element/source` on a scaffolded deck: the slice ate
  // the first line's indentation, and every other line still carries where the
  // element happened to sit in the file.
  const src = '<aside class="notes">\n        <p>Welcome.</p>\n      </aside>';
  assert.equal(dedentHtml(src), '<aside class="notes">\n  <p>Welcome.</p>\n</aside>');
});

test('relative depth survives — this dedents, it does not flatten', () => {
  const src = '<ul>\n    <li>one\n      <b>bold</b>\n    </li>\n  </ul>';
  assert.equal(dedentHtml(src), '<ul>\n  <li>one\n    <b>bold</b>\n  </li>\n</ul>');
});

test('a single line, or an already-flush block, is returned untouched', () => {
  for (const src of ['<h1>Chip Check</h1>', '', '<p>a</p>\n<p>b</p>']) {
    assert.equal(dedentHtml(src), src, JSON.stringify(src));
  }
});

test('a blank line does not count as zero indentation', () => {
  // Measuring it would find a common prefix of 0 and the whole thing would be
  // left ragged — a blank line is the commonest thing in an edited block.
  const src = '<div>\n    <p>a</p>\n\n    <p>b</p>\n  </div>';
  assert.equal(dedentHtml(src), '<div>\n  <p>a</p>\n\n  <p>b</p>\n</div>');
});

test('a blank line comes back genuinely empty, not full of spaces', () => {
  // Trailing whitespace on an otherwise empty line is invisible noise that the
  // author would then be saving.
  const out = dedentHtml('<div>\n    <p>a</p>\n      \n    <p>b</p>\n  </div>');
  assert.ok(out.split('\n').includes(''), `no empty line in ${JSON.stringify(out)}`);
  assert.ok(!/\n +\n/.test(out), 'a line of only spaces survived');
});

// ── where a space is content, and nothing may be removed ──────────────────

test('anything preserving whitespace is refused outright', () => {
  // Inside these, the leading spaces on a line ARE the text. Shortening them
  // rewrites what the audience reads — a code sample losing its indentation is
  // the exact failure this whole file exists to prevent.
  for (const tag of ['pre', 'textarea', 'script', 'style']) {
    const src = `<div>\n    <${tag}>\n        indented\n    </${tag}>\n  </div>`;
    assert.equal(dedentable(src), false, tag);
    assert.equal(dedentHtml(src), src, `${tag} was dedented`);
  }
});

test('the refusal is by tag, whatever its case or attributes', () => {
  assert.equal(dedentable('<div>\n  <PRE class="x">\n  y\n  </PRE>\n</div>'), false);
  assert.equal(dedentable('<div>\n  <pre data-lang="js">\n  y\n  </pre>\n</div>'), false);
  // Blunt on purpose: one <pre> anywhere disables dedenting for the whole
  // element rather than for part of it. Getting this wrong edits a deck.
  assert.equal(dedentable('<div>\n  <p>fine</p>\n  <pre>x</pre>\n</div>'), false);
});

test('a word starting with "pre" is not a <pre>', () => {
  assert.equal(dedentable('<div>\n    <p>prefer prescriptive</p>\n  </div>'), true);
  assert.equal(dedentable('<div>\n    <p class="preview">x</p>\n  </div>'), true);
});

test('tabs are left alone rather than guessed at', () => {
  // Mixing tabs and spaces makes "how deep is this line" unanswerable without
  // a tab width nobody has told us, and a wrong answer deletes real characters.
  const src = '<div>\n\t<p>a</p>\n\t</div>';
  assert.equal(dedentHtml(src), src);
});

test('nothing is inserted — dedenting can only ever shorten', () => {
  // The safety argument in one property. Whitespace between inline elements is
  // a visible space, so a formatter that ADDED a line break would change what
  // the slide shows. This one cannot: every output line is a suffix of its
  // input line, and there are exactly as many lines.
  const cases = [
    '<aside>\n        <p>x</p>\n      </aside>',
    '<ul>\n    <li>one</li>\n    <li>two</li>\n  </ul>',
    '<div>\n  <p>a</p>\n\n  <p>b</p>\n</div>',
  ];
  for (const src of cases) {
    const inLines = src.split('\n');
    const outLines = dedentHtml(src).split('\n');
    assert.equal(outLines.length, inLines.length, 'line count changed');
    outLines.forEach((line, i) => {
      assert.ok(inLines[i].endsWith(line), `line ${i}: ${JSON.stringify(line)} is not a suffix of the input`);
    });
  }
});

test('the visible text is byte-identical once whitespace runs are collapsed', () => {
  // What a browser actually renders outside a pre: runs of whitespace collapse
  // to one space. If that string is unchanged, the slide is unchanged.
  const collapse = (h) => h.replace(/\s+/g, ' ').trim();
  const src = '<aside class="notes">\n        <p>Welcome, and hello.</p>\n      </aside>';
  assert.equal(collapse(dedentHtml(src)), collapse(src));
});
