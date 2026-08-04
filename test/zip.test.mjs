// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The ZIP reader against archives someone MADE hostile (issue #234).
//
// Everything tools/zip.mjs reads was sent by someone else — a .pptx on import,
// a .decklight that `present` must unzip before it can even find the
// signature — and the classic attack on an eager unzipper is the zip bomb: a
// few-KB file whose entries inflate to gigabytes, detonating ahead of every
// trust decision. The happy-path reader tests live in import.test.mjs; these
// are the refusals. Every hostile archive here is a real zipSync archive with
// its central directory patched afterwards, because the central directory is
// exactly the part an attacker writes freely.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { unzip, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES } from '../tools/zip.mjs';
import { zipSync } from '../cli/zip.mjs';
import { DECK_EXT, MANIFEST, OPEN, CLOSE, readContainer } from '../cli/deckfile.mjs';

/** Rewrite what the central directory DECLARES an entry inflates to, leaving
 *  the entry's actual bytes alone — the disagreement a bomb is made of. */
function declareSize(zip, name, size) {
  const buf = Buffer.from(zip);
  let e = buf.length - 22; // EOCD, scanned backwards past any archive comment
  while (buf.readUInt32LE(e) !== 0x06054b50) e -= 1;
  let p = buf.readUInt32LE(e + 16);
  while (p < e) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      buf.writeUInt32LE(size, p + 24);
      return buf;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`no ${name} in the central directory`);
}

test('an entry that inflates past its declared size is refused, not allocated', () => {
  // 64 KiB of one byte deflates to ~a hundred bytes; the directory then claims
  // 16. Without a cap this inflates to whatever the stream holds — the bomb.
  const zip = zipSync([{ name: 'boom.bin', data: 'A'.repeat(65536) }]);
  assert.throws(() => unzip(declareSize(zip, 'boom.bin', 16)),
    /boom\.bin: inflates past the 16 bytes its central directory entry declares/);
});

test('an entry that inflates SHORT of its declaration is refused the same way', () => {
  // The other half of "enforced, not merely read": a directory that overstates
  // is lying too, and a reader that shrugs would hand back bytes nobody sent.
  const zip = zipSync([{ name: 'short.bin', data: 'A'.repeat(65536) }]);
  assert.throws(() => unzip(declareSize(zip, 'short.bin', 65537)),
    /short\.bin: inflates to 65536 bytes, not the 65537 its central directory entry declares/);
});

test('one entry declaring past the entry cap is refused before any inflation', () => {
  const zip = zipSync([{ name: 'huge.bin', data: 'A'.repeat(64) }]);
  assert.throws(() => unzip(declareSize(zip, 'huge.bin', MAX_ENTRY_BYTES + 1)),
    /huge\.bin: declares \d+ bytes inflated, past the \d+-byte entry cap/);
});

test('entries whose declarations SUM past the archive cap are refused up front', () => {
  // Three entries at exactly the per-entry cap each pass it alone; together
  // they declare 1.5 GiB. The refusal comes from the directory sums, before a
  // single entry is inflated — which is what makes it cost nothing.
  let zip = zipSync(['a', 'b', 'c'].map((n) => ({ name: `${n}.bin`, data: 'A'.repeat(64) })));
  for (const n of ['a.bin', 'b.bin', 'c.bin']) zip = declareSize(zip, n, MAX_ENTRY_BYTES);
  assert.throws(() => unzip(zip), /archive declares \d+ bytes inflated, past the \d+-byte cap/);
  assert.ok(3 * MAX_ENTRY_BYTES > MAX_TOTAL_BYTES, 'the fixture really is over the cap');
});

test('a bomb inside a .decklight is refused by readContainer — ahead of any trust decision', () => {
  // The delivery vehicle the ticket names: the signature lives INSIDE the
  // container, so readContainer must unzip before anything is verified. The
  // refusal has to come from the unzipping itself.
  const body = Buffer.from('<!doctype html><html><body>deck</body></html>', 'utf8');
  const zip = zipSync([
    { name: MANIFEST, data: JSON.stringify({ decklight: 1, signature: 'talk.html.sig' }) },
    { name: 'boom.bin', data: 'A'.repeat(65536) },
  ], { prefix: body.length + OPEN.length, comment: CLOSE });
  // Patch the assembled container, not the bare archive: a container zip's
  // offsets are file-relative, prefix and all, and declareSize walks them.
  const bytes = declareSize(Buffer.concat([body, Buffer.from(OPEN, 'utf8'), zip]), 'boom.bin', 16);

  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-zip-bomb-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `bomb${DECK_EXT}`);
  writeFileSync(file, bytes);
  assert.throws(() => readContainer(file), /boom\.bin: inflates past/);
});
