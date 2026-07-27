// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Enough of the ZIP format to read an Office file, and nothing more.
//
// A .pptx is a ZIP of XML parts, so importing one means unzipping one — and
// the repo's rule is that the runtime has zero dependencies while the CLI may
// have Node-only ones. This could have been a dependency. It is ~90 lines
// instead, because `node:zlib` already does the only hard part (inflate) and
// what remains is reading a well-documented directory structure.
//
// Deliberately partial: read-only, no ZIP64, no encryption, no multi-disk, no
// data descriptors trusted over the central directory. Every one of those is
// absent from files Office and Keynote write, and each is a loud error rather
// than a wrong answer if it ever shows up.

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/**
 * The End Of Central Directory record, scanned backwards from the end.
 *
 * It is last in the file but variable in position, because a trailing comment
 * may follow it — so the only way to find it is to look for its signature from
 * the back. The comment is at most 65535 bytes, which bounds the search.
 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * List a ZIP's entries from its central directory.
 *
 * The central directory is authoritative: the per-file local headers may carry
 * zeroed sizes (a streaming writer fills them in a trailing data descriptor
 * instead), so sizes and offsets are taken from here and the local header is
 * read only for where its data actually begins.
 */
export function zipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  const start = buf.readUInt32LE(eocd + 16);
  if (start === 0xffffffff || count === 0xffff) {
    throw new Error('zip64 archives are not supported');
  }

  const entries = [];
  let p = start;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`corrupt zip: bad central directory entry ${i}`);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    // Office writes UTF-8 names; the flag bit that says so is set, and the
    // legacy CP437 alternative has no characters we would read differently.
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The bytes of one entry, inflated if it needs to be. */
export function zipRead(buf, entry) {
  if (buf.readUInt32LE(entry.offset) !== LOC_SIG) {
    throw new Error(`corrupt zip: ${entry.name} does not start with a local file header`);
  }
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === STORED) return Buffer.from(raw);
  if (entry.method === DEFLATED) return inflateRawSync(raw);
  throw new Error(`${entry.name}: unsupported compression method ${entry.method}`);
}

/**
 * The whole archive as a name → Buffer map.
 *
 * An Office file is a few dozen small parts read in an order the code decides,
 * not the archive, so holding them all beats seeking repeatedly. Directory
 * entries (trailing slash, zero length) are dropped — they are not content.
 */
export function unzip(buf) {
  const out = new Map();
  for (const entry of zipEntries(buf)) {
    if (entry.name.endsWith('/')) continue;
    out.set(entry.name, zipRead(buf, entry));
  }
  return out;
}
