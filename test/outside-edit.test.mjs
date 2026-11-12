// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The deck changed on disk under write mode, by an editor, git or a tool
// (PRESENTING_EDITING, outside edits): what the server says changed, whether
// the pages can swap the slides in place (cli/outside-edit.mjs), and where a
// page lands afterwards (src/core/outside-edit.js). The page doing it is the
// engine harness's (outsideedit) and the real server's (edit-e2e).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outsideEdit, topSections, slidePartsSaid, PATCH_MAX_BYTES } from '../cli/outside-edit.mjs';
import { describeReload } from '../cli/edit.mjs';
import { landing, movedTo } from '../src/core/outside-edit.js';

const deck = (secs, head = '') => `<!doctype html>
<html><head>${head}<script>const tpl = "<section>not a slide";</script></head>
<body>
  <div class="decklight">
${secs.map((s) => `    <section>\n      ${s}\n    </section>`).join('\n')}
  </div>
</body></html>
`;
const S = ['<h2>One</h2>', '<h2>Two</h2>\n      <ul><li>a</li></ul>', '<h2>Three</h2>', '<h2>Four</h2>'];

test('the slides are the top-level sections, a script\'s "<section" and a nested one not counted', () => {
  const html = deck([S[0], '<h2>Two</h2><section><p>inner</p></section>', S[2]]);
  const r = topSections(html);
  assert.equal(r.length, 3);
  assert.match(html.slice(r[1].start, r[1].end), /^<section>[\s\S]*inner[\s\S]*<\/section>$/);
});

test('one slide\'s markup changed: patched in place, said by the part that changed, gone to', () => {
  const o = outsideEdit(deck(S), deck([S[0], '<h2>Two</h2>\n      <ul><li>b</li></ul>', S[2], S[3]]));
  assert.equal(o.said, 'slide 2 changed: the bullet list');
  assert.equal(o.patch.total, 4);
  assert.deepEqual(o.patch.slides.map((s) => s.slide), [2]);
  assert.match(o.patch.slides[0].html, /^<section>[\s\S]*<li>b<\/li>[\s\S]*<\/section>$/);
  assert.deepEqual(o.land, { go: 2, moves: [], was: 4, total: 4 });
});

test('several slides changed: one patch, the first of them is where an author goes', () => {
  const o = outsideEdit(deck(S), deck(['<h2>Uno</h2>', S[1], '<h2>Tres</h2>', S[3]]));
  assert.equal(o.said, 'slides 1 and 3 changed');
  assert.deepEqual(o.patch.slides.map((s) => s.slide), [1, 3]);
  assert.equal(o.land.go, 1);
});

test('a slide added, removed, swapped or moved: a reload that says so and knows where each slide went', () => {
  const added = outsideEdit(deck(S), deck([S[0], '<h2>New</h2>', S[1], S[2], S[3]]));
  assert.equal(added.said, 'slide 2 added');
  assert.equal(added.patch, undefined);
  assert.deepEqual(added.land, { go: 2, moves: [[2, 3], [3, 4], [4, 5]], was: 4, total: 5 });

  const removed = outsideEdit(deck(S), deck([S[0], S[2], S[3]]));
  assert.equal(removed.said, 'slide 2 removed');
  assert.equal(removed.land.go, 2, 'the slide that now stands where it was');

  const swapped = outsideEdit(deck(S), deck([S[0], S[2], S[1], S[3]]));
  assert.equal(swapped.said, 'slides 2 and 3 swapped');
  assert.equal(swapped.patch, undefined, 'a swap is not two slides edited');
  assert.equal(swapped.land.go, 2);

  const moved = outsideEdit(deck(S), deck([S[1], S[2], S[3], S[0]]));
  assert.equal(moved.said, 'slide 1 moved to 4');
  assert.equal(moved.land.go, 4);
});

test('a change around the slides reloads, and says where', () => {
  const head = outsideEdit(deck(S), deck(S, '<style>h2 { color: red }</style>'));
  assert.equal(head.said, 'the deck\'s head changed');
  assert.equal(head.patch, undefined);
  assert.equal(head.land.go, null, 'no slide changed: nobody is moved');
  const both = outsideEdit(deck(S), deck([S[0], S[1], '<h2>3</h2>', S[3]], '<style>x{}</style>'));
  assert.equal(both.said, 'the deck\'s head changed, slide 3 changed: the title');
  assert.equal(both.patch, undefined);
  const root = outsideEdit(deck(S), deck(S).replace('class="decklight"', 'class="decklight" data-x'));
  assert.equal(root.said, 'the deck changed outside its slides');
});

test('nothing a page shows changed: no message at all', () => {
  assert.equal(outsideEdit(deck(S), deck(S)), null);
  assert.equal(outsideEdit(deck(S), deck(S).replace('    </section>\n    <section>', '    </section>\n\n\n    <section>')), null);
});

test('a slide with a script, markdown, or too much markup reloads instead of swapping', () => {
  assert.equal(outsideEdit(deck(S), deck([S[0], S[1], '<h2>Three</h2><script>go()</script>', S[3]])).patch, undefined);
  assert.equal(outsideEdit(deck(S), deck([S[0], S[1], S[2], S[3]]).replace('<section>\n      <h2>Four', '<section data-markdown>\n      <h2>Fourth')).patch, undefined);
  const big = `<img src="data:image/png;base64,${'A'.repeat(PATCH_MAX_BYTES)}">`;
  const o = outsideEdit(deck(S), deck([S[0], S[1], big, S[3]]));
  assert.equal(o.patch, undefined);
  assert.equal(o.said, 'slide 3 changed: the title removed and a picture added');
});

test('what changed on a slide, in a few words', () => {
  const sec = (inner, attrs = '') => `<section${attrs}>${inner}</section>`;
  assert.equal(slidePartsSaid(sec('<h2>A</h2><p>x</p>'), sec('<h2>B</h2><p>x</p>')), 'the title');
  assert.equal(slidePartsSaid(sec('<h2>A</h2>'), sec('<h2>A</h2><img src="a.png">')), 'a picture added');
  assert.equal(slidePartsSaid(sec('<h2>A</h2><table></table>'), sec('<h2>A</h2>')), 'the table removed');
  assert.equal(slidePartsSaid(sec('<h2>A</h2><aside class="notes">a</aside>'), sec('<h2>A</h2><aside class="notes">b</aside>')), 'the notes');
  assert.equal(slidePartsSaid(sec('<h2>A</h2>'), sec('<h2>A</h2>', ' data-layout="split"')), 'the layout');
  assert.equal(slidePartsSaid(sec('<h2>A</h2><p>a</p><ol></ol>'), sec('<h2>B</h2><p>b</p><ol><li>c</li></ol>')), '3 parts');
  assert.equal(slidePartsSaid(sec('<h2>A</h2>'), sec('<h2>A</h2> ')), '', 'spacing has no name');
});

test('describeReload: an outside edit, given the bytes, carries the patch and the landing; else as before', () => {
  const before = deck(S), after = deck([S[0], S[1], '<h2>Trois</h2>', S[3]]);
  const why = describeReload({ before, after });
  assert.equal(why.reload, 'slide 3 changed: the title');
  assert.equal(why.from, null);
  assert.deepEqual(why.patch.slides.map((s) => s.slide), [3]);
  assert.equal(why.land.go, 3);
  assert.equal(describeReload({ before, after: before }), null, 'nothing changed: nothing sent');
  // the server's own write and an agent's run are said as they always were
  const at = 1000;
  assert.deepEqual(describeReload({ write: { at, what: 'notes saved' }, now: at + 10, before, after }), { reload: 'notes saved', from: null });
  assert.deepEqual(describeReload({ agent: { agent: 'claude' }, before, after }), { reload: 'claude\'s edit', from: null });
  assert.match(describeReload({}).reload, /changed on disk/);
});

test('landing: an author goes to what changed, a presenter stays on the content', () => {
  const inserted = { go: 2, moves: [[2, 3], [3, 4], [4, 5]], was: 4, total: 5 };
  assert.deepEqual(landing({ slide: 3, step: 1 }, [inserted], { follow: true }), { slide: 2, step: 0 });
  assert.deepEqual(landing({ slide: 3, step: 1 }, [inserted], { follow: false }), { slide: 4, step: 1 });
  assert.deepEqual(landing({ slide: 1, step: 2 }, [inserted], { follow: false }), { slide: 1, step: 2 });
  // a change that touched no slide moves nobody, following or not
  assert.deepEqual(landing({ slide: 3, step: 1 }, [{ go: null, moves: [], was: 4, total: 4 }], { follow: true }), { slide: 3, step: 1 });
  // a slide that is gone gives way to the one now in its place, from its first step
  const removed = { go: 2, moves: [[2, null], [3, 2], [4, 3]], was: 4, total: 3 };
  assert.deepEqual(landing({ slide: 2, step: 3 }, [removed], { follow: false }), { slide: 2, step: 0 });
  assert.equal(movedTo(4, { moves: [[4, null]], was: 4, total: 3 }), 3, 'the last slide gone: the new last');
  // a reload that waited gathers its changes, in order
  assert.deepEqual(landing({ slide: 3, step: 0 }, [inserted, inserted], { follow: false }), { slide: 5, step: 0 });
  assert.deepEqual(landing({ slide: 3, step: 0 }, [inserted, { go: null, moves: [[4, 1]], was: 5, total: 5 }], { follow: true }), { slide: 2, step: 0 });
});
