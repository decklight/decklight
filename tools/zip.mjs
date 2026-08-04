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
//
// And deliberately bounded: everything this reads is something someone SENT —
// a `.pptx` on import, a `.decklight` container that `present` must unzip
// BEFORE it can even find the signature — so a few-KB archive that inflates to
// gigabytes (a zip bomb) would detonate ahead of every trust decision. Two
// caps, both far above anything Office or `bundle --deck` writes, and the
// central directory's declared size is enforced rather than merely read: an
// entry whose inflated bytes disagree with its declaration is hostile or
// corrupt, and either way the answer is a loud refusal, not an allocation.

import { inflateRawSync } from 'node:zlib';

/** The most one entry may inflate to. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
/** The most a whole archive may declare, summed across its entries. */
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

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
  if (entry.size > MAX_ENTRY_BYTES) {
    throw new Error(`${entry.name}: declares ${entry.size} bytes inflated, past the ${MAX_ENTRY_BYTES}-byte entry cap`);
  }
  const nameLen = buf.readUInt16LE(entry.offset + 26);
  const extraLen = buf.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === STORED) return Buffer.from(raw);
  if (entry.method === DEFLATED) {
    let out;
    // maxOutputLength makes zlib stop AT the declared size instead of
    // allocating whatever the stream expands to — the declaration is the cap.
    // (zlib refuses a cap of 0; a genuinely empty entry still inflates to
    // nothing under a cap of 1, and anything else fails the check below.)
    try {
      out = inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
    } catch (e) {
      if (e.code !== 'ERR_BUFFER_TOO_LARGE') throw e;
      throw new Error(`${entry.name}: inflates past the ${entry.size} bytes its central directory entry declares`);
    }
    if (out.length !== entry.size) {
      throw new Error(`${entry.name}: inflates to ${out.length} bytes, not the ${entry.size} its central directory entry declares`);
    }
    return out;
  }
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
  const entries = zipEntries(buf).filter((e) => !e.name.endsWith('/'));
  // Summed up front, from the directory alone — an archive that declares more
  // than the cap is refused before a single entry is inflated, and zipRead
  // holds every entry to its declaration, so the sum is a real bound.
  const total = entries.reduce((n, e) => n + e.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    throw new Error(`archive declares ${total} bytes inflated, past the ${MAX_TOTAL_BYTES}-byte cap`);
  }
  const out = new Map();
  for (const entry of entries) out.set(entry.name, zipRead(buf, entry));
  return out;
}
