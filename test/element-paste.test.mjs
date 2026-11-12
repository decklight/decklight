// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// An element pasted onto a slide (PRESENTING_EDITING, the clipboard): cleaned
// on the server first, whatever it came from, then its ids and diagram names
// made its own, then placed where a new block lands. A template slide refuses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePasted, relativeAssets } from '../cli/paste.mjs';
import { pasteSlideElement } from '../cli/edit.mjs';

const DECK = `<div class="decklight">
  <section>
    <h2>One</h2>
    <p id="intro">First</p>
    <svg viewBox="0 0 100 50"><g data-node="box"><rect/></g></svg>
  </section>
  <section data-layout="split">
    <h2>Two</h2>
    <div><p>Left</p></div>
    <div><p>Right</p></div>
  </section>
  <section data-template="acme/divider"><h2>Three</h2></section>
</div>`;

test('nothing that runs is ever kept, and each kind left out is named once', () => {
  const { html, dropped } = sanitizePasted(`<div class="x" onclick="a()"><p onmouseover="b()">Hi</p>
    <a href="javascript:alert(1)">l</a> <a href=" JaVaScRiPt:x">m</a> <a href="data:text/html,<b>">n</a>
    <img src="a.png" onerror="c()"><iframe src="https://e/"></iframe><iframe srcdoc="<b>">x</iframe>
    <object data="x"></object><embed src="y"><script>d()</script><style>p{}</style><link rel="stylesheet" href="z">
    <svg><script>e()</script><a xlink:href="javascript:f()">s</a></svg><form action="/x"><input></form>
    <div style="background: url(javascript:g())">s</div><div style="color: red">kept</div><!-- <script>h()</script> --></div>`);
  for (const bad of ['onclick', 'onmouseover', 'onerror', 'javascript:', 'data:text/html', '<iframe', 'srcdoc', '<object', '<embed', '<script', '<style', '<link', '<form', 'url(javascript']) {
    assert.ok(!html.toLowerCase().includes(bad.toLowerCase()), `${bad} left in: ${html}`);
  }
  assert.match(html, /<div style="color: red">kept<\/div>/, 'a style that only styles stays');
  assert.match(html, /<img src="a\.png">/, 'the picture stays, without its handler');
  for (const said of ['a script', 'a style block', 'a frame', 'an embedded object', 'a linked file', 'a form', 'an onclick handler', 'an onerror handler', 'a javascript: link', 'a data: link', 'a style that runs code']) {
    assert.ok(dropped.includes(said), `${said} not said: ${dropped}`);
  }
  assert.equal(new Set(dropped).size, dropped.length, 'each said once');
  assert.deepEqual(sanitizePasted('<p class="lead">Plain <em>words</em> <a href="https://x.example/">ok</a> <img src="https://cdn.example/p.png"></p>').dropped, [],
    'words, emphasis, an http link and an absolute picture are content');
});

test('the files a paste points at, relative ones only', () => {
  assert.deepEqual(relativeAssets('<img src="assets/a.png"><img src=b.png><img src="https://x/y.png"><a href="#top">t</a><a href="/abs">a</a><img src="assets/a.png?v=2">'),
    ['assets/a.png', 'b.png']);
});

test('a paste lands after the element, its id and diagram names its own, every other byte kept', () => {
  const out = pasteSlideElement(DECK, 1, { index: 1, markup: '<p id="intro" class="lead">Pasted <strong>here</strong></p>' });
  assert.equal(out.index, 2);
  assert.equal(out.markup, '<p class="lead">Pasted <strong>here</strong></p>', 'an id the page would have twice goes');
  assert.equal(out.html, DECK.replace('<p id="intro">First</p>\n', '<p id="intro">First</p>\n    <p class="lead">Pasted <strong>here</strong></p>\n'));
  const svg = pasteSlideElement(DECK, 1, { index: 2, markup: '<svg viewBox="0 0 100 50"><g data-node="box"><rect/></g></svg>' });
  assert.match(svg.markup, /data-node="box-2"/, 'a copied diagram on the same slide is a second diagram, not a second view');
  const last = pasteSlideElement(DECK, 1, { index: null, markup: '<p>At the end</p>' });
  assert.match(last.html, /<svg[\s\S]*?<\/svg>\n    <p>At the end<\/p>\n  <\/section>/, 'nothing selected: last on the slide');
});

test('with a column selected, the paste lands inside it; on a template slide it is refused', () => {
  const into = pasteSlideElement(DECK, 2, { index: 1, path: [0], markup: '<p>Also left</p>' });
  assert.equal(into.index, 1);
  assert.deepEqual(into.path, [1]);
  assert.match(into.html, /<div><p>Left<\/p><p>Also left<\/p><\/div>|<div><p>Left<\/p>\s*<p>Also left<\/p>\s*<\/div>/);
  assert.throws(() => pasteSlideElement(DECK, 3, { markup: '<p>x</p>' }), (e) => e.status === 409 && /template's slots/.test(e.message));
});

test('what cleans to nothing, or is nothing, is refused with what was left out', () => {
  assert.throws(() => pasteSlideElement(DECK, 1, { markup: '<script>x()</script>' }), (e) => e.status === 400 && /nothing left to paste: a script was left out/.test(e.message));
  assert.throws(() => pasteSlideElement(DECK, 1, { markup: '   ' }), /nothing to paste/);
  const r = pasteSlideElement(DECK, 1, { index: 1, markup: '<p onclick="x()">Hi</p>' });
  assert.deepEqual(r.dropped, ['an onclick handler']);
});
