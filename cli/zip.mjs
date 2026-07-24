// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A minimal ZIP writer — stored (uncompressed) entries only, which is all
 * `decklight skills --pack` needs for two small text files. Owning ~40 lines
 * of container format keeps the CLI at zero dependencies, the same reasoning
 * that gave the terminal player its own ANSI parser.
 *
 * Output is deterministic: entry timestamps are pinned to the DOS epoch
 * (1980-01-01), so packing the same content twice yields identical bytes.
 */

// Standard CRC-32 (the polynomial every ZIP tool checks entries against).
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_DATE = 0x21; // 1980-01-01, the format's epoch — deterministic output

/** zip([{ name, data }, …]) → Buffer holding a standard archive. */
export function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const crc = crc32(body);
    // local file header + name + stored data
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4);         // version needed to extract
    local.writeUInt16LE(DOS_DATE, 12);  // mod date (time, flags, method stay 0)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // compressed size (= stored)
    local.writeUInt32LE(body.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);
    // matching central directory record
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);    // signature
    cd.writeUInt16LE(20, 4);            // version made by
    cd.writeUInt16LE(20, 6);            // version needed to extract
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0x81a40000, 38);   // external attrs: unix -rw-r--r--
    cd.writeUInt32LE(offset, 42);       // local header offset
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);    // end-of-central-directory signature
  eocd.writeUInt16LE(entries.length, 8);  // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // entries total
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);       // central directory offset
  return Buffer.concat([...chunks, cdBuf, eocd]);
}
