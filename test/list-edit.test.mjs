// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Lists and tables edited like a document (src/core/list-edit.js,
// PRESENTING_EDITING): every change a key or the table menu makes is made
// on the element's SOURCE markup, so these are the functions whose wrong
// answer would land in the file. The keys and the caret are the engine
// harness's (test/engine.html, listkeys / listnest / tablekeys / tablemenu).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanPasted, cleanTyped, pastedWords, PASTE_MAX_LINES,
  parseMarkup, serialize, splitInline, joinInline, textLength, cleanInline, trimInline, dropAttrs,
  listDoc, listHtml, listShape, itemFacts, splitItem, mergeItem, removeItem, indentItem, outdentItem, moveItem, setItemWords,
  tableOp, tableEdit, tableShape, elementAt, columnAlign, hasHeaderRow,
} from '../src/core/list-edit.js';

const LIST = '<ul data-build>\n    <li class="x" id="a">Hello <strong>bold</strong> world</li>\n    <li>Second</li>\n  </ul>';
const keys = (doc) => listShape(doc).items.map((i) => i.key);

test('the markup tree gives back exactly the bytes it read', () => {
  for (const s of [LIST, '<p>a &amp; b<br>c<!-- note --><img src="x.png" alt=\'q > r\'></p>', '<ul><li>one<li>two</ul>',
    '<svg viewBox="0 0 10 10"><rect x="1"/><text>t</text></svg>', 'text </b> stray']) {
    assert.equal(serialize(parseMarkup(s)), s);
  }
  // a close tag for an element still open above ends the ones inside it
  const [ul] = parseMarkup('<ul><li>one<li>two</ul>');
  assert.equal(ul.kids.length, 1, 'the first <li> holds the second, as written');
  assert.equal(ul.close, '</ul>');
});

test('words are counted as the page counts them: an entity is one character, a picture none', () => {
  assert.equal(textLength(parseMarkup('a &amp; <em>bé</em><img src="x">')), 6);
  assert.equal(textLength(parseMarkup('&nbsp;&#8217;&#x2014;')), 3);
});

test('a cut inside emphasis splits the tag into two of the same, attributes and all', () => {
  const [a, b] = splitInline(parseMarkup('Hello <strong class="k">bold</strong> world'), 8);
  assert.equal(serialize(a), 'Hello <strong class="k">bo</strong>');
  assert.equal(serialize(b), '<strong class="k">ld</strong> world');
  // a cut that only touches an element leaves it whole on its side
  const [c, d] = splitInline(parseMarkup('<em>one</em> two'), 3);
  assert.equal(serialize(c), '<em>one</em>');
  assert.equal(serialize(d), ' two');
  const [e, f] = splitInline(parseMarkup('a &amp; b'), 2);
  assert.deepEqual([serialize(e), serialize(f)], ['a ', '&amp; b'], 'an entity is never cut in half');
  assert.deepEqual(splitInline(parseMarkup('<code>x</code>'), 0).map(serialize), ['', '<code>x</code>']);
});

test('a join makes the two halves of one tag one again', () => {
  const [a, b] = splitInline(parseMarkup('Hello <strong>bold</strong> <em><code>deep</code></em>'), 8);
  assert.equal(serialize(joinInline(a, b)), 'Hello <strong>bold</strong> <em><code>deep</code></em>');
  const [c, d] = splitInline(parseMarkup('<em><code>deep</code></em>'), 2);
  assert.equal(serialize(joinInline(c, d)), '<em><code>deep</code></em>');
  assert.equal(serialize(joinInline(parseMarkup('<em>a</em>'), parseMarkup('<em class="b">c</em>'))), '<em>a</em><em class="b">c</em>',
    'two different tags stay two');
});

test('the browser\'s furniture never reaches the file', () => {
  assert.equal(cleanInline('Hello<br>'), 'Hello', 'the <br> holding a line open');
  assert.equal(cleanInline('<br>'), '', 'an item of nothing but a line break is empty');
  assert.equal(cleanInline('a&nbsp;&nbsp;b'), 'a b');
  assert.equal(cleanInline('10&nbsp;km'), '10&nbsp;km', 'an author\'s own no-break space stays');
  assert.equal(cleanInline('one&nbsp;<strong>two</strong>'), 'one <strong>two</strong>');
  assert.equal(cleanInline('<span style="color: red;">a</span> <strong>b</strong>'), 'a <strong>b</strong>');
  assert.equal(cleanInline('<b>Bold</b> and <i>italic</i>, as the author wrote them'), '<b>Bold</b> and <i>italic</i>, as the author wrote them', 'an author\'s own <b> and <i> stay');
  assert.equal(cleanInline('<div>pasted</div>'), 'pasted');
  assert.equal(cleanInline('<em style="x">a</em>'), '<em>a</em>');
  assert.equal(cleanInline('<em style="x">a</em>', { keepStyle: true }), '<em style="x">a</em>');
  assert.equal(cleanInline('<span class="k">a</span><strong></strong>'), '<span class="k">a</span>', 'an emptied emphasis goes, an author\'s span stays');
  assert.equal(cleanInline('  two<br>  lines <br>'), 'two<br>  lines', 'a line break inside the words is the author\'s');
  assert.equal(serialize(trimInline(parseMarkup(' <em> x </em> '))), '<em>x </em>'.replace('x ', 'x'));
});

test('a copied tag drops what would make two of one', () => {
  assert.equal(dropAttrs('<li id="a" class="x y" data-build-order="3">', ['id', 'data-build-order']), '<li class="x y">');
  assert.equal(dropAttrs('<td style="a:b" colspan=2>', ['style']), '<td colspan=2>');
});

test('a list is read once, every list and item numbered in reading order', () => {
  const doc = listDoc(LIST);
  assert.ok(doc);
  assert.equal(listHtml(doc), LIST, 'untouched, byte for byte');
  assert.deepEqual(keys(doc), [2, 3]);
  assert.equal(listDoc(LIST).root.key, doc.root.key, 'read again, numbered the same');
  // what this editor cannot honestly cut is left to the old edit
  assert.equal(listDoc('<ul><li><p>a paragraph</p></li></ul>'), null);
  assert.equal(listDoc('<ul><li>a<ul><li>b</li></ul><ul><li>c</li></ul></li></ul>'), null, 'two sublists in one item');
  assert.equal(listDoc('<p>not a list</p>'), null);
  assert.ok(listDoc('<ol><li>a <code>b</code> <img src="x"></li></ol>'));
});

test('Enter cuts the point at the caret: the words after it start the next one', () => {
  const doc = listDoc(LIST);
  const [first] = keys(doc);
  const to = splitItem(doc, first, 8);
  assert.equal(listHtml(doc), '<ul data-build>\n    <li class="x" id="a">Hello <strong>bo</strong></li>\n    <li class="x"><strong>ld</strong> world</li>\n    <li>Second</li>\n  </ul>');
  assert.deepEqual(to, { key: 4, offset: 0 }, 'the caret goes to the start of the new point');
  // at the end: a new empty point; at the start: the words move down, an empty point above
  const end = listDoc('<ul><li>one</li></ul>');
  splitItem(end, keys(end)[0], 3);
  assert.equal(listHtml(end), '<ul><li>one</li><li></li></ul>', 'a list on one line stays on one line');
  const start = listDoc('<ul><li>one</li></ul>');
  splitItem(start, keys(start)[0], 0);
  assert.equal(listHtml(start), '<ul><li></li><li>one</li></ul>');
});

test('Enter cuts what was typed, cleaned: the page\'s words, not the file\'s', () => {
  const doc = listDoc('<ul>\n  <li>old</li>\n</ul>');
  const to = splitItem(doc, keys(doc)[0], 4, { words: 'new <em>words</em>&nbsp;<br>', clean: (h) => cleanInline(h) });
  assert.equal(listHtml(doc), '<ul>\n  <li>new</li>\n  <li><em>words</em></li>\n</ul>');
  assert.equal(to.key, keys(doc)[1]);
});

test('a point with a sublist: Enter moves the sublist with the words after the caret, as the lines under it read', () => {
  const doc = listDoc('<ul>\n  <li>Parent\n    <ul>\n      <li>child</li>\n    </ul>\n  </li>\n</ul>');
  splitItem(doc, keys(doc)[0], 6);
  assert.equal(listHtml(doc), '<ul>\n  <li>Parent</li>\n  <li>\n    <ul>\n      <li>child</li>\n    </ul>\n  </li>\n</ul>');
});

test('Backspace at the start joins the point to the one above, emphasis whole again', () => {
  const doc = listDoc(LIST);
  const to = splitItem(doc, keys(doc)[0], 8);
  const back = mergeItem(doc, to.key);
  assert.equal(listHtml(doc), LIST, 'a cut and a join give the file back exactly');
  assert.deepEqual(back, { key: 2, offset: 8 }, 'the caret where the two met');
  assert.equal(mergeItem(doc, keys(doc)[0]), null, 'nothing above the first point: nothing joins');
  // an empty point simply goes, the caret at the end of the one above
  const empty = listDoc('<ul><li>a</li><li></li></ul>');
  assert.deepEqual(mergeItem(empty, keys(empty)[1]), { key: keys(empty)[0], offset: 1 });
  assert.equal(listHtml(empty), '<ul><li>a</li></ul>');
});

test('a join reaches the point above as it reads, deep in the previous point\'s sublist', () => {
  const doc = listDoc('<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b<ul><li>b1</li></ul></li></ul>');
  const b = listShape(doc).items[1].key;
  const to = mergeItem(doc, b);
  assert.equal(listHtml(doc), '<ul><li>a<ul><li>a1</li><li>a2b</li><li>b1</li></ul></li></ul>', 'b\'s own sublist stays at its depth, after');
  assert.equal(to.offset, 2);
  // the first point of a sublist joins the point holding it
  const sub = listDoc('<ul><li>a<ul><li>a1<ul><li>deep</li></ul></li><li>a2</li></ul></li></ul>');
  const a1 = listShape(sub).items[0].sub.items[0].key;
  mergeItem(sub, a1);
  assert.equal(listHtml(sub), '<ul><li>aa1<ul><li>deep</li><li>a2</li></ul></li></ul>');
});

test('Control-Shift-↑ / ↓ swaps a point with its neighbour in its own list, its sublist going with it', () => {
  const doc = listDoc('<ul>\n  <li>one</li>\n  <li>two\n    <ul>\n      <li>two a</li>\n      <li>two b</li>\n    </ul>\n  </li>\n  <li>three</li>\n</ul>');
  const every = (l) => l.items.flatMap((i) => [i.key, ...(i.sub ? every(i.sub) : [])]);
  const [one, two, twoA, twoB, three] = every(listShape(doc));
  assert.equal(moveItem(doc, one, -1), null, 'the first point has nowhere further up');
  assert.deepEqual(moveItem(doc, one, 1), { key: one });
  assert.equal(listHtml(doc), '<ul>\n  <li>two\n    <ul>\n      <li>two a</li>\n      <li>two b</li>\n    </ul>\n  </li>\n  <li>one</li>\n  <li>three</li>\n</ul>');
  // inside a sublist a point moves among its own, and never out of it
  assert.equal(moveItem(doc, twoA, -1), null, 'first of its sublist');
  moveItem(doc, twoA, 1);
  assert.equal(listHtml(doc), '<ul>\n  <li>two\n    <ul>\n      <li>two b</li>\n      <li>two a</li>\n    </ul>\n  </li>\n  <li>one</li>\n  <li>three</li>\n</ul>');
  assert.equal(moveItem(doc, twoA, 1), null, 'last of its sublist');
  assert.equal(moveItem(doc, three, 1), null, 'the last point has nowhere further down');
  assert.equal(moveItem(doc, three, 2), null, 'one place at a time');
  moveItem(doc, two, 1);
  assert.equal(listHtml(doc), '<ul>\n  <li>one</li>\n  <li>two\n    <ul>\n      <li>two b</li>\n      <li>two a</li>\n    </ul>\n  </li>\n  <li>three</li>\n</ul>');
  assert.ok(twoB > twoA, 'reading order numbers the sublist after its point');
  // a list written on one line stays on one line
  const flat = listDoc('<ol><li>a</li><li>b</li></ol>');
  moveItem(flat, keys(flat)[1], -1);
  assert.equal(listHtml(flat), '<ol><li>b</li><li>a</li></ol>');
});

test('Tab nests a point under the one before, in a sublist of the same type; Shift-Tab takes it out again', () => {
  const doc = listDoc('<ol>\n  <li>one</li>\n  <li>two</li>\n  <li>three</li>\n</ol>');
  const [one, two, three] = keys(doc);
  assert.equal(indentItem(doc, one), null, 'the first point has nothing to go under');
  assert.deepEqual(indentItem(doc, two), { key: two });
  assert.equal(listHtml(doc), '<ol>\n  <li>one\n    <ol>\n      <li>two</li>\n    </ol>\n  </li>\n  <li>three</li>\n</ol>');
  indentItem(doc, three);
  assert.equal(listHtml(doc), '<ol>\n  <li>one\n    <ol>\n      <li>two</li>\n      <li>three</li>\n    </ol>\n  </li>\n</ol>', 'into the sublist already there');
  // out: the points after it in the sublist become its own, so the order reads the same
  outdentItem(doc, two);
  assert.equal(listHtml(doc), '<ol>\n  <li>one</li>\n  <li>two\n    <ol>\n      <li>three</li>\n    </ol>\n  </li>\n</ol>');
  assert.equal(outdentItem(doc, one), null, 'the top level has nowhere further out');
  outdentItem(doc, three);
  assert.equal(listHtml(doc), '<ol>\n  <li>one</li>\n  <li>two</li>\n  <li>three</li>\n</ol>', 'an emptied sublist goes');
});

test('a nested point carries its own sublist when it moves', () => {
  const doc = listDoc('<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul>');
  indentItem(doc, keys(doc)[1]);
  assert.equal(listHtml(doc), '<ul><li>a<ul><li>b<ul><li>b1</li></ul></li></ul></li></ul>');
});

test('what a point is decides what Enter does with it', () => {
  const doc = listDoc('<ul><li>a<ul><li></li></ul></li><li></li></ul>');
  const shape = listShape(doc);
  assert.deepEqual(itemFacts(doc, shape.items[1].key), { empty: true, last: true, first: false, top: true, only: false, length: 0 });
  assert.equal(itemFacts(doc, shape.items[0].sub.items[0].key).top, false);
  assert.equal(itemFacts(doc, shape.items[0].key).empty, false);
  assert.equal(itemFacts(listDoc('<ul><li><img src="x"></li></ul>'), 2).empty, false, 'a picture is not nothing');
  removeItem(doc, shape.items[1].key);
  removeItem(doc, shape.items[0].sub.items[0].key);
  assert.equal(listHtml(doc), '<ul><li>a</li></ul>');
  assert.equal(setItemWords(doc, shape.items[0].key, 'b <em>c</em>'), true);
  assert.equal(listHtml(doc), '<ul><li>b <em>c</em></li></ul>');
});

const TABLE = '<table>\n  <thead>\n    <tr><th>A</th><th>B</th></tr>\n  </thead>\n  <tbody>\n    <tr><td class="n">1</td><td>2</td></tr>\n  </tbody>\n</table>';

test('the table menu adds rows like the row beside them, the file\'s layout kept', () => {
  assert.equal(tableOp(TABLE, 'row-above', 1, 0),
    '<table>\n  <thead>\n    <tr><th>A</th><th>B</th></tr>\n  </thead>\n  <tbody>\n    <tr><td class="n"></td><td></td></tr>\n    <tr><td class="n">1</td><td>2</td></tr>\n  </tbody>\n</table>');
  assert.equal(tableOp(TABLE, 'row-below', 1, 0),
    '<table>\n  <thead>\n    <tr><th>A</th><th>B</th></tr>\n  </thead>\n  <tbody>\n    <tr><td class="n">1</td><td>2</td></tr>\n    <tr><td class="n"></td><td></td></tr>\n  </tbody>\n</table>');
  // below the header: the body's first row, shaped like the body
  assert.equal(tableOp(TABLE, 'row-below', 0, 0),
    '<table>\n  <thead>\n    <tr><th>A</th><th>B</th></tr>\n  </thead>\n  <tbody>\n    <tr><td class="n"></td><td></td></tr>\n    <tr><td class="n">1</td><td>2</td></tr>\n  </tbody>\n</table>');
  assert.equal(tableOp(TABLE, 'row-above', 0, 0),
    '<table>\n  <thead>\n    <tr><th></th><th></th></tr>\n    <tr><th>A</th><th>B</th></tr>\n  </thead>\n  <tbody>\n    <tr><td class="n">1</td><td>2</td></tr>\n  </tbody>\n</table>');
});

test('the table menu adds and deletes columns in every row, a header keeping its <th>', () => {
  assert.equal(tableOp(TABLE, 'col-left', 1, 1),
    '<table>\n  <thead>\n    <tr><th>A</th><th></th><th>B</th></tr>\n  </thead>\n  <tbody>\n    <tr><td class="n">1</td><td></td><td>2</td></tr>\n  </tbody>\n</table>');
  assert.equal(tableOp(TABLE, 'col-right', 1, 0),
    '<table>\n  <thead>\n    <tr><th>A</th><th></th><th>B</th></tr>\n  </thead>\n  <tbody>\n    <tr><td class="n">1</td><td class="n"></td><td>2</td></tr>\n  </tbody>\n</table>');
  assert.equal(tableOp(TABLE, 'col-delete', 1, 0),
    '<table>\n  <thead>\n    <tr><th>B</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>2</td></tr>\n  </tbody>\n</table>');
  const spaced = '<table>\n  <tr>\n    <td>a</td>\n    <td>b</td>\n  </tr>\n</table>';
  assert.equal(tableOp(spaced, 'col-right', 0, 0), '<table>\n  <tr>\n    <td>a</td>\n    <td></td>\n    <td>b</td>\n  </tr>\n</table>');
  assert.equal(tableOp(spaced, 'col-delete', 0, 1), '<table>\n  <tr>\n    <td>a</td>\n  </tr>\n</table>');
  const cols = '<table><colgroup><col class="w"><col></colgroup><tr><td>a</td><td>b</td></tr></table>';
  assert.equal(tableOp(cols, 'col-left', 0, 0), '<table><colgroup><col class="w"><col class="w"><col></colgroup><tr><td></td><td>a</td><td>b</td></tr></table>');
});

test('the table menu deletes a row, and its section when that was the last', () => {
  assert.equal(tableOp(TABLE, 'row-delete', 0, 0), '<table>\n  <tbody>\n    <tr><td class="n">1</td><td>2</td></tr>\n  </tbody>\n</table>');
  assert.equal(tableOp(TABLE, 'row-delete', 1, 1), '<table>\n  <thead>\n    <tr><th>A</th><th>B</th></tr>\n  </thead>\n</table>');
  assert.throws(() => tableOp('<table><tr><td>a</td></tr></table>', 'row-delete', 0, 0), /at least one row/);
  assert.throws(() => tableOp('<table><tr><td>a</td></tr></table>', 'col-delete', 0, 0), /at least one column/);
});

test('a table that merges cells is refused rather than guessed at', () => {
  assert.throws(() => tableOp('<table><tr><td colspan="2">a</td></tr><tr><td>b</td><td>c</td></tr></table>', 'col-left', 1, 1), /merges cells/);
  assert.throws(() => tableOp(TABLE, 'row-above', 7, 0), /no row 8/);
  assert.throws(() => tableOp('<ul></ul>', 'row-above', 0, 0), /not a table/);
});

test('a table session\'s writes: rows Tab added, then the cells\' new words', () => {
  assert.deepEqual(tableShape(TABLE), [2, 2]);
  assert.equal(tableEdit(TABLE, { append: 1, cells: [{ row: 2, col: 0, html: 'x' }, { row: 0, col: 1, html: '<em>B</em>' }] }),
    '<table>\n  <thead>\n    <tr><th>A</th><th><em>B</em></th></tr>\n  </thead>\n  <tbody>\n    <tr><td class="n">1</td><td>2</td></tr>\n    <tr><td class="n">x</td><td></td></tr>\n  </tbody>\n</table>');
  assert.throws(() => tableEdit(TABLE, { cells: [{ row: 5, col: 0, html: 'x' }] }), /no cell/);
});

test('the list or table is found in the element by path, and only it is rewritten', () => {
  const top = '<div class="columns" data-x>\n  <p>Intro &amp; more</p>\n  <ul data-build>\n    <li>a</li>\n  </ul>\n</div>';
  const at = elementAt(top, [1], 'ul');
  assert.equal(at.html, '<ul data-build>\n    <li>a</li>\n  </ul>');
  assert.equal(at.replace('<ul data-build><li>b</li></ul>'), '<div class="columns" data-x>\n  <p>Intro &amp; more</p>\n  <ul data-build><li>b</li></ul>\n</div>',
    'every byte around it as written: a bare attribute, an entity');
  assert.equal(elementAt(top, [0], 'ul'), null, 'a path that lands on another tag is refused');
  assert.equal(elementAt(top, [5]), null);
  assert.equal(elementAt('<ol><li>x</li></ol>', [], 'ol').replace('<ol><li>y</li></ol>'), '<ol><li>y</li></ol>');
});

// ── a paste while typing (PRESENTING_EDITING) ─────────────────────────────

test('a paste from another app brings the words and the editor\'s emphasis, never its look', () => {
  // tried by hand on main: this span was saved inside the paragraph
  const mail = '<meta charset="utf-8"><!--StartFragment--><span style="color: red; font: 31px \'Comic Sans MS\'" class="m_1">Ship it <b>today</b></span><!--EndFragment-->';
  assert.equal(cleanPasted({ html: mail }), 'Ship it <strong>today</strong>');
  assert.equal(cleanPasted({ html: '<font face="Arial" size="7"><i>soft</i> <u>under</u> <code class="x">x()</code></font>' }), '<em>soft</em> under <code>x()</code>');
  assert.equal(cleanPasted({ html: '<div style="margin:0"><p class="MsoNormal">One</p><p>Two<br>three</p></div>' }), 'One Two three', 'paragraphs and lines are spaces between words');
});

test('a paste drops pictures, frames, scripts and the page head, content and all', () => {
  const page = '<html><head><title>Page</title><style>p{color:red}</style></head><body><p>Words<img src="x.png" onerror="alert(1)"></p>'
    + '<script>alert(1)</script><iframe src="https://evil"></iframe><svg><text>drawn</text></svg><video src="v.mp4">no</video></body></html>';
  assert.equal(cleanPasted({ html: page }), 'Words');
});

test('a pasted link keeps its href only when it is the web, mail, a slide or a path', () => {
  assert.equal(cleanPasted({ html: '<a href="https://x.io/?a=1&amp;b=2" style="color:red" target="_blank">site</a>' }), '<a href="https://x.io/?a=1&amp;b=2">site</a>');
  assert.equal(cleanPasted({ html: '<a href="mailto:a@b.c">mail</a> <a href="#/3">slide</a> <a href="notes.html">file</a>' }),
    '<a href="mailto:a@b.c">mail</a> <a href="#/3">slide</a> <a href="notes.html">file</a>');
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x']) {
    assert.equal(cleanPasted({ html: `<a href="${bad}">click</a>` }), 'click', bad);
  }
  assert.equal(cleanPasted({ html: '<a href="https://x.io"><img src="logo.png"></a> after' }), 'after', 'a link with nothing left to read goes');
});

test('Google Docs: its whole-copy <b> is not bold, its bold and italic spans are', () => {
  const docs = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-size:11pt;font-weight:700;color:#000">Bold</span><span style="font-size:11pt"> plain </span><span style="font-style:italic">slanted</span></p></b>';
  assert.equal(cleanPasted({ html: docs }), '<strong>Bold</strong> plain <em>slanted</em>');
});

test('plain text comes as text: its markup characters escaped, its lines and runs of spaces one space', () => {
  assert.equal(cleanPasted({ text: 'a < b & c\r\n\r\n  next\tline' }), 'a &lt; b &amp; c next line');
  assert.equal(cleanPasted({ html: 'not <html> really', text: 'ignored' }), 'not really', 'html, when there is some, is what is read');
  assert.equal(cleanPasted({ html: '', text: '' }), '');
  assert.equal(cleanPasted({ html: '<img src="a.png">' }), '', 'a picture alone is no words');
});

test('spaces fall between words, never inside emphasis edges or doubled where tags met', () => {
  assert.equal(cleanPasted({ html: '<p> Hello<strong> big </strong>world </p>' }), 'Hello <strong>big</strong> world');
  assert.equal(cleanPasted({ html: '<strong></strong><em> </em>x' }), 'x');
  assert.equal(cleanPasted({ html: 'a&nbsp;&nbsp;b&#160;c' }), 'a b c');
});

test('a save cleans what typing left that the file should not get, and keeps what the file had', () => {
  assert.equal(cleanTyped('Words <span style="color:red">red</span>', 'Words'), 'Words red');
  assert.equal(cleanTyped('Words <span style="color:red">red</span>', 'Was <span style="color:red">red</span>'), 'Words <span style="color:red">red</span>',
    'a style the element had in the file stays');
  assert.equal(cleanTyped('\n      Title <font face="x">here</font>\n    ', '\n      Title\n    '), '\n      Title here\n    ', 'the file\'s white space round the words kept');
  assert.equal(cleanTyped('<p>One</p><p>Two <span style="x">t</span></p>', '<p>One</p><p>Two</p>'), '<p>One</p><p>Two <span style="x">t</span></p>',
    'words that hold blocks of their own (a quote of paragraphs) are left as typed');
  assert.equal(cleanTyped('<strong>B</strong> <em>i</em> <a href="#/2">s</a> <span class="accent">kept</span>', ''), '<strong>B</strong> <em>i</em> <a href="#/2">s</a> <span class="accent">kept</span>');
});

test('more emphasis survives a list or table save and a paste: highlight, strikethrough, superscript, subscript', () => {
  assert.equal(cleanInline('a <mark>b</mark> <s>c</s> x<sup>2</sup> H<sub>2</sub>O <mark></mark>'), 'a <mark>b</mark> <s>c</s> x<sup>2</sup> H<sub>2</sub>O');
  const doc = listDoc('<ul><li>one <mark>key</mark></li><li>E=mc<sup>2</sup></li></ul>');
  assert.match(listHtml(doc), /<li>one <mark>key<\/mark><\/li><li>E=mc<sup>2<\/sup><\/li>/);
  assert.equal(cleanPasted({ html: '<p>H<sub>2</sub>O, mc<sup>2</sup>, <del>old</del> <strike>older</strike> <mark style="background:yellow">key</mark></p>' }),
    'H<sub>2</sub>O, mc<sup>2</sup>, <s>old</s> <s>older</s> <mark>key</mark>');
});

test('tableOp aligns a column: a text-align on each of its cells, any other style kept, and a merged table takes it', () => {
  const t = '<table>\n  <tr><th>Name</th><th>Cost</th></tr>\n  <tr><td>Ada</td><td style="color: red">12</td></tr>\n</table>';
  const right = tableOp(t, 'col-align-right', 1, 1);
  assert.equal(right, '<table>\n  <tr><th>Name</th><th style="text-align: right">Cost</th></tr>\n  <tr><td>Ada</td><td style="color: red; text-align: right">12</td></tr>\n</table>');
  assert.equal(columnAlign(right, 1), 'right');
  assert.equal(columnAlign(right, 0), null);
  assert.equal(columnAlign(tableOp(right, 'col-align-center', 0, 1), 1), 'center', 'one alignment replaces the other');
  const merged = '<table><tr><td colspan="2">x</td></tr><tr><td>a</td><td>b</td></tr></table>';
  assert.match(tableOp(merged, 'col-align-left', 1, 0), /<td colspan="2" style="text-align: left">x<\/td><\/tr><tr><td style="text-align: left">a<\/td>/);
  assert.throws(() => tableOp(merged, 'row-below', 0, 0), /merges cells/, 'rows and columns are still refused');
  assert.throws(() => tableOp(t, 'col-align-right', 0, 7), /no column 8/);
});

test('tableOp turns the header row on and off: th in a thead, td back in the body, and on again as it was', () => {
  const bare = '<table>\n  <tr><td>Name</td><td>Role</td></tr>\n  <tr><td>Ada</td><td>Engineer</td></tr>\n</table>';
  assert.equal(hasHeaderRow(bare), false);
  const on = tableOp(bare, 'header-on', 0, 0);
  assert.equal(on, '<table>\n  <thead><tr><th>Name</th><th>Role</th></tr></thead>\n  <tr><td>Ada</td><td>Engineer</td></tr>\n</table>');
  assert.equal(hasHeaderRow(on), true);
  assert.equal(tableOp(on, 'header-off', 0, 0), bare, 'off gives the table back as it was');
  const sections = '<table>\n  <thead>\n    <tr><th>A</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>1</td></tr>\n  </tbody>\n</table>';
  const off = tableOp(sections, 'header-off', 0, 0);
  assert.equal(off, '<table>\n  <tbody>\n    <tr><td>A</td></tr>\n    <tr><td>1</td></tr>\n  </tbody>\n</table>', 'the first row of the body, at its indent');
  assert.match(tableOp(off, 'header-on', 0, 0), /^<table>\n {2}<thead><tr><th>A<\/th><\/tr><\/thead>\n {2}<tbody>\n {4}<tr><td>1<\/td><\/tr>/);
  // a merged table takes it too
  assert.match(tableOp('<table><tr><td colspan="2">x</td></tr></table>', 'header-on', 0, 0), /<thead><tr><th colspan="2">x<\/th><\/tr><\/thead>/);
});

test('tableOp sets a column\'s width as a share of the table, in a colgroup, and Even widths takes them off', () => {
  const t = '<table>\n  <tr><th>Name</th><th>Role</th></tr>\n  <tr><td>Ada</td><td>Engineer</td></tr>\n</table>';
  const w = tableOp(t, 'col-width', 0, 0, { width: 30.4 });
  assert.equal(w, '<table>\n  <colgroup><col style="width: 30%"><col></colgroup>\n  <tr><th>Name</th><th>Role</th></tr>\n  <tr><td>Ada</td><td>Engineer</td></tr>\n</table>');
  assert.match(tableOp(w, 'col-width', 0, 1, { width: 60 }), /<colgroup><col style="width: 30%"><col style="width: 60%"><\/colgroup>/, 'the same colgroup, the other column');
  assert.equal(tableOp(w, 'col-even', 0, 0), t, 'even widths: the colgroup it made goes with them');
  // a colgroup the author wrote keeps its own attributes
  const own = '<table><colgroup><col class="k"><col></colgroup><tr><td>a</td><td>b</td></tr></table>';
  assert.equal(tableOp(tableOp(own, 'col-width', 0, 0, { width: 50 }), 'col-even', 0, 0), own);
  assert.throws(() => tableOp(t, 'col-width', 0, 0, { width: 99 }), /5% to 95%/);
  assert.throws(() => tableOp('<table><tr><td colspan="2">x</td></tr></table>', 'col-width', 0, 0, { width: 40 }), /merges cells/);
});

// ── a paste outside typing (PRESENTING_EDITING, the clipboard) ─────────────

test('words pasted onto a slide: one line a paragraph, several a list, each line cleaned', () => {
  assert.deepEqual(pastedWords({ text: 'one line' }), { kind: 'text', words: ['one line'] });
  assert.deepEqual(pastedWords({ text: 'alpha\r\nbeta\n\n  gamma <x>  ' }), { kind: 'bullets', words: ['alpha', 'beta', 'gamma &lt;x&gt;'] });
  assert.deepEqual(pastedWords({ html: '<meta charset="utf-8"><p class="x" style="color:red">One <b>bold</b></p><div>Two<br>three</div><ul><li>four</li></ul>' }),
    { kind: 'bullets', words: ['One <strong>bold</strong>', 'Two', 'three', 'four'] });
  assert.deepEqual(pastedWords({ html: '<span style="font: 31px Comic Sans">just <a href="https://x.io">words</a></span>' }),
    { kind: 'text', words: ['just <a href="https://x.io">words</a>'] });
  assert.deepEqual(pastedWords({ text: '  \n\t\n' }), { kind: null, words: [] });
  assert.deepEqual(pastedWords({ html: '<img src="a.png">' }), { kind: null, words: [] }, 'a picture is no words');
});

test('a pasted list keeps its kind and loses its markers; a long one is cut at the most a slide should hold', () => {
  assert.deepEqual(pastedWords({ text: '- alpha\n* beta\n• gamma' }), { kind: 'bullets', words: ['alpha', 'beta', 'gamma'] });
  assert.deepEqual(pastedWords({ text: '1. first\n2) second\n10. tenth' }), { kind: 'numbered', words: ['first', 'second', 'tenth'] });
  assert.deepEqual(pastedWords({ text: '1. first\nnot numbered' }).kind, 'bullets', 'numbered only when every line is');
  assert.equal(pastedWords({ text: '-not a bullet\nx' }).words[0], '-not a bullet', 'a dash with no space is a word');
  const many = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  assert.equal(pastedWords({ text: many }).words.length, PASTE_MAX_LINES);
});
