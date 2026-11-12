// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The clipboard in write mode (SPEC PRESENTING_EDITING): what a paste
// carries, read as one kind, and where the browser's own paste belongs.
// Pure: a clipboard is faked as what a DataTransfer offers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyClipboard, typingTarget } from '../src/core/clipboard.js';
import { altFromName } from '../src/core/authoring.js';

const file = (name, type) => ({ name, type, kind: 'file' });
/** A clipboard: `files` (as `data.files`), `items` (as `data.items`, each a file), and its strings. */
const clip = ({ files = [], items = [], html = '', text = '' } = {}) => ({
  files,
  items: items.map((f) => ({ kind: 'file', getAsFile: () => f })),
  getData: (type) => (type === 'text/html' ? html : type === 'text/plain' ? text : ''),
});

test('a picture on the clipboard is a picture, even beside the html a browser\'s Copy image adds', () => {
  const png = file('image.png', 'image/png');
  assert.deepEqual(classifyClipboard(clip({ files: [png] })), { kind: 'pictures', files: [png] });
  const copied = classifyClipboard(clip({ files: [png], html: '<img src="https://example.com/a.png">', text: '' }));
  assert.equal(copied.kind, 'pictures');
  // some browsers carry it in `items` only
  assert.deepEqual(classifyClipboard(clip({ items: [png] })).files, [png]);
  const two = [file('a.png', 'image/png'), file('b.webp', 'image/webp')];
  assert.equal(classifyClipboard(clip({ files: two })).files.length, 2);
});

test('a file that is not a picture is nothing the editor takes; words are html or text', () => {
  assert.deepEqual(classifyClipboard(clip({ files: [file('notes.pdf', 'application/pdf')] })), { kind: 'none' });
  assert.deepEqual(classifyClipboard(clip({ html: '<b>hi</b>', text: 'hi' })), { kind: 'html', html: '<b>hi</b>', text: 'hi' });
  assert.deepEqual(classifyClipboard(clip({ text: 'hi' })), { kind: 'text', text: 'hi' });
  assert.deepEqual(classifyClipboard(clip({ text: '  \n' })), { kind: 'none' });
  assert.deepEqual(classifyClipboard(null), { kind: 'none' });
});

test('a field or a box being typed in keeps the browser\'s paste', () => {
  const el = (tagName, extra = {}) => ({ nodeType: 1, tagName, isContentEditable: false, closest: () => null, ...extra });
  assert.equal(typingTarget(el('INPUT')), true);
  assert.equal(typingTarget(el('TEXTAREA')), true);
  assert.equal(typingTarget(el('INPUT', { readOnly: true })), false, 'a read-only field is not typed in');
  assert.equal(typingTarget(el('P', { isContentEditable: true })), true);
  assert.equal(typingTarget(el('SPAN', { closest: () => ({}) })), true, 'inside an editable box');
  assert.equal(typingTarget(el('BODY')), false);
  assert.equal(typingTarget({ nodeType: 3, parentElement: el('TEXTAREA') }), true, 'a text node in a field');
  assert.equal(typingTarget(null), false);
});

test('a picture\'s alt from its name says nothing when the name says nothing: never "image"', () => {
  for (const generic of ['image.png', 'image (2).png', 'Pasted image.png', 'Pasted Image 20261112.png', 'clipboard.png', 'unnamed.png', 'download.jpeg',
    'Screenshot.png', 'Screenshot 2026-11-12 at 10.31.22.png', 'Screenshot from 2026-11-12 10-31-22.png', 'Screen Shot 2020-01-01 at 9.00.00 AM.png',
    'Capture d’écran 2026-11-12 à 10.00.png', 'Bildschirmfoto vom 2026-11-12.png', 'IMG_1234.JPG', 'DSC01234.jpg', 'PXL_20261112_101010.jpg',
    '20261112.png', '3f2504e0-4f89-11d3-9a0c-0305e82c3301.png']) {
    assert.equal(altFromName(generic), '', generic);
  }
  assert.equal(altFromName('team-offsite.jpg'), 'team offsite');
  assert.equal(altFromName('Screenshot of the pricing page.png'), 'Screenshot of the pricing page', 'words of its own are kept');
  assert.equal(altFromName('image-of-the-team.png'), 'image of the team');
  assert.equal(altFromName('photo booth night.png'), 'photo booth night');
});
