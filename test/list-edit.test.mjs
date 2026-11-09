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
  parseMarkup, serialize, splitInline, joinInline, textLength, cleanInline, trimInline, dropAttrs,
  listDoc, listHtml, listShape, itemFacts, splitItem, mergeItem, removeItem, indentItem, outdentItem, setItemWords,
  tableOp, tableEdit, tableShape, elementAt,
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
  assert.equal(cleanInline('<span style="color: red;">a</span> <b>b</b> <i>c</i>'), 'a <strong>b</strong> <em>c</em>');
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
