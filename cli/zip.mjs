// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A minimal ZIP writer, because two small text files do not justify a
// dependency — decklight already owns an ANSI parser on the same reasoning.
// Enough of the format to produce an archive every unzip reads: local headers,
// a central directory, and the end record. No zip64, no encryption, no
// directory entries (the paths carry the folder).
//
// Timestamps are pinned to the ZIP epoch (1980-01-01) rather than "now", so
// packing the same content twice produces the same bytes. A build artifact
// that changes every time you build it is one you cannot diff or checksum.

import { deflateRawSync } from 'node:zlib';

// CRC-32 by hand: node:zlib grew a crc32 export only in 20.15, and
// package.json promises Node 20 — testing what we promise means not reaching
// for something a valid Node 20 might not have.
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE = 0x0021; // 1980-01-01: day 1, month 1, year 0 → (1<<5)|1
const DOS_TIME = 0;

/**
 * Build a ZIP archive from `[{ name, data }]`, where data is a string or
 * Buffer. Each entry is deflated only when that actually makes it smaller —
 * a stored entry beats a "compressed" one that grew.
 *
 * `prefix` is how many bytes will sit in front of this archive in the file it
 * ends up in. Every offset a ZIP records is measured from the start of the
 * FILE, not the archive, so an archive appended to something else has to be
 * written knowing that — which is exactly how self-extracting archives have
 * always worked, and how the `.decklight` container (DECK_FILE) puts a playable
 * deck in front of its own signature.
 */
export function zipSync(entries, { prefix = 0, comment = '' } = {}) {
  const local = [];
  const central = [];
  let offset = prefix;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lh.writeUInt16LE(20, 4);         // version needed to extract (2.0)
    lh.writeUInt16LE(0, 6);          // general purpose flags
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);         // extra field length
    local.push(lh, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cd.writeUInt16LE(20, 4);         // version made by
    cd.writeUInt16LE(20, 6);         // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);         // extra
    cd.writeUInt16LE(0, 32);         // comment
    cd.writeUInt16LE(0, 34);         // disk number
    cd.writeUInt16LE(0, 36);         // internal attributes
    // external attributes: regular file, 0644. The >>> 0 matters — JS `<<` is
    // signed, so 0o100644 << 16 lands negative and writeUInt32LE throws.
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  // The archive comment is a real, boring ZIP field — and it is the last thing
  // in the file, which is what makes it the right place to close the HTML
  // comment wrapping a `.decklight` container (DECK_FILE). Trailing bytes AFTER
  // the end record would work for our own reader and make `unzip` complain
  // about garbage; the comment field is where trailing bytes are supposed to go.
  const tail = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(tail.length, 20); // archive comment length

  return Buffer.concat([...local, cdBuf, end, tail]);
}
