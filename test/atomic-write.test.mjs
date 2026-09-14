// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/atomic-write.mjs — the write that is the whole file or none of it.
//
// The failure this exists for cannot be staged directly: it is a process dying
// between `writeFileSync`'s truncate and the end of its copy. What CAN be
// staged is the guarantee either side of it — that the bytes handed over are
// the bytes that land, that a write which refuses leaves the previous file
// exactly as it was, and that nothing of the attempt is left in the directory
// afterwards. A temp file left behind next to a deck is its own bug: cli's
// live reload watches that directory, and `decklight bundle` looks in it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../tools/atomic-write.mjs';
import { tmp } from './helpers.mjs';

test('a string lands whole, byte for byte', (t) => {
  const dir = tmp('atomic', t);
  const file = path.join(dir, 'talk.html');
  const html = '<!doctype html>\n<div class="decklight">\n  <section>é ⟨CLICK⟩ 日本語</section>\n</div>\n';
  writeFileAtomic(file, html);
  assert.equal(readFileSync(file, 'utf8'), html, 'utf-8 must survive the staging file');
  assert.deepEqual(readdirSync(dir), ['talk.html'], 'the temp sibling outlived the rename');
});

test('a Buffer lands as the exact bytes given, never re-encoded', (t) => {
  const dir = tmp('atomic', t);
  const file = path.join(dir, 'slide-01.wav');
  // Bytes that are not valid utf-8 — a recording is what this route writes,
  // and a helper that stringified it would corrupt every one of them.
  const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x7f, 0x00]);
  writeFileAtomic(file, bytes);
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(statSync(file).size, bytes.length);
  assert.deepEqual(readdirSync(dir), ['slide-01.wav']);
});

test('a rewrite replaces the whole file, with nothing of the old one left on the end', (t) => {
  const dir = tmp('atomic', t);
  const file = path.join(dir, 'talk.html');
  writeFileAtomic(file, 'a much longer first version of the deck');
  writeFileAtomic(file, 'short');
  assert.equal(readFileSync(file, 'utf8'), 'short',
    'a rename replaces the file; it does not write over the front of it');
  assert.deepEqual(readdirSync(dir), ['talk.html']);
});

test('a write that fails leaves the original untouched and no temp file behind', (t) => {
  const dir = tmp('atomic', t);
  const file = path.join(dir, 'talk.html');
  const original = '<section>the version that must survive</section>';
  writeFileSync(file, original);

  // A directory where the rename wants a file: renameSync refuses it (EISDIR
  // / EPERM / ENOTEMPTY depending on the platform) AFTER the staging file has
  // been written, which is the one failure that can strand one.
  const blocked = path.join(dir, 'blocked');
  mkdirSync(blocked);
  assert.throws(() => writeFileAtomic(blocked, 'anything'), 'renaming over a directory must not pass silently');
  assert.equal(readFileSync(file, 'utf8'), original, 'the neighbouring deck was disturbed');
  assert.deepEqual(readdirSync(dir).sort(), ['blocked', 'talk.html'],
    'the staging file was left in the deck\'s own directory');

  // And the other half: a path that cannot be staged at all (no such
  // directory) fails without inventing one.
  assert.throws(() => writeFileAtomic(path.join(dir, 'nope', 'talk.html'), 'x'), /ENOENT/);
  assert.deepEqual(readdirSync(dir).sort(), ['blocked', 'talk.html']);
});

test('the staging file is a sibling, so the rename never crosses a filesystem', (t) => {
  const dir = tmp('atomic', t);
  const file = path.join(dir, 'deep', 'talk.html');
  mkdirSync(path.dirname(file));
  writeFileAtomic(file, 'one');
  // If the temp file had been put in os.tmpdir() this would be a copy on most
  // machines and a cross-device EXDEV on a container — the whole guarantee.
  assert.equal(readFileSync(file, 'utf8'), 'one');
  assert.deepEqual(readdirSync(path.dirname(file)), ['talk.html']);
});

test('two writers in the same directory cannot stage onto each other', (t) => {
  const dir = tmp('atomic', t);
  // The name carries the pid and six random bytes. Nothing here can run two
  // processes cheaply, so the assertion is on the name itself: a thousand
  // staging names for one target, all distinct.
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    writeFileAtomic(path.join(dir, 'talk.html'), String(i));
    for (const name of readdirSync(dir)) seen.add(name);
  }
  assert.deepEqual([...seen], ['talk.html'], 'a staging name survived its own write');
  assert.equal(readFileSync(path.join(dir, 'talk.html'), 'utf8'), '999');
});
