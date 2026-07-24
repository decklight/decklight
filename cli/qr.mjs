// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A zero-dependency QR encoder (ISO/IEC 18004) — the building block the phone
// remote (#39) needs to put a scannable URL in the speaker view. Deliberately
// narrow: byte mode, error-correction level L, versions 1–10 (a v10-L symbol
// holds 271 bytes; a `http://host:port/remote?t=token` URL is well under v4).
// Numeric/alphanumeric modes and higher EC levels buy nothing here and are
// left out. Node-only (cli/): the browser runtime bundle never sees this.

// ---- version tables (EC level L only) --------------------------------------

// Per version 1–10: EC codewords per block, and the blocks as [count, dataLen]
// groups (ISO/IEC 18004 table 9).
const EC_BLOCKS = [
  [7, [[1, 19]]],
  [10, [[1, 34]]],
  [15, [[1, 55]]],
  [20, [[1, 80]]],
  [26, [[1, 108]]],
  [18, [[2, 68]]],
  [20, [[2, 78]]],
  [24, [[2, 97]]],
  [30, [[2, 116]]],
  [18, [[2, 68], [2, 69]]],
];

// Alignment pattern center coordinates per version 1–10 (table E.1).
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const dataCodewords = (version) =>
  EC_BLOCKS[version - 1][1].reduce((n, [count, len]) => n + count * len, 0);

// Byte-mode payload capacity: data bits minus the 4-bit mode indicator and the
// character count (8 bits through v9, 16 from v10).
const byteCapacity = (version) =>
  Math.floor((dataCodewords(version) * 8 - 4 - (version < 10 ? 8 : 16)) / 8);

// ---- Reed–Solomon over GF(256), polynomial 0x11d ---------------------------

const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = EXP[i + 255] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Generator polynomial for `n` EC codewords: ∏(x − α^i), MSB-first coefficients. */
function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** The `ecLen` Reed–Solomon codewords for a data block (polynomial remainder). */
function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const buf = new Uint8Array(data.length + ecLen);
  buf.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (!factor) continue;
    for (let j = 1; j < gen.length; j++) buf[i + j] ^= gfMul(gen[j], factor);
  }
  return buf.slice(data.length);
}

// ---- format / version information (BCH-protected) --------------------------

/** 15 format bits for EC level L + `mask`: BCH(15,5) with 0x537, XOR 0x5412. */
function formatBits(mask) {
  const data = (0b01 << 3) | mask; // 01 = level L
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18 version bits (versions ≥ 7 only): BCH(18,6) with 0x1f25. */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >> 11) & 1) * 0x1f25);
  return (version << 12) | rem;
}

// ---- mask patterns and penalty scoring --------------------------------------

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// The four penalty rules (table 11); lower total wins the mask choice.
function penalty(m) {
  const size = m.length;
  let score = 0;
  // N1: runs of ≥5 same-colored modules in a row/column
  for (let axis = 0; axis < 2; axis++) {
    const at = axis === 0 ? (i, j) => m[i][j] : (i, j) => m[j][i];
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j <= size; j++) {
        if (j < size && at(i, j) === at(i, j - 1)) run++;
        else {
          if (run >= 5) score += 3 + run - 5;
          run = 1;
        }
      }
    }
  }
  // N2: 2×2 blocks of one color
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++)
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
  // N3: finder-lookalike 1011101 with 4 light modules on one side
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let axis = 0; axis < 2; axis++) {
    const at = axis === 0 ? (i, j) => m[i][j] : (i, j) => m[j][i];
    for (let i = 0; i < size; i++)
      for (let j = 0; j + 11 <= size; j++) {
        let a = true;
        let b = true;
        for (let k = 0; k < 11 && (a || b); k++) {
          const v = at(i, j + k) ? 1 : 0;
          if (v !== P1[k]) a = false;
          if (v !== P2[k]) b = false;
        }
        if (a || b) score += 40;
      }
  }
  // N4: dark-module proportion, 10 points per 5% step away from 50%
  let dark = 0;
  for (const row of m) for (const cell of row) if (cell) dark++;
  const total = size * size;
  score += Math.floor(Math.abs(dark * 100 - total * 50) / (total * 5)) * 10;
  return score;
}

// ---- matrix construction -----------------------------------------------------

/** Draw the 15 format bits into both of their reserved areas. */
function drawFormat(modules, bits) {
  const size = modules.length;
  const bit = (i) => ((bits >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) modules[i][8] = bit(i); // top-left, going down
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i < 15; i++) modules[8][14 - i] = bit(i); // top-left, going left
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = bit(i); // top-right
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = bit(i); // bottom-left
}

/**
 * Encode `text` (UTF-8, byte mode, EC level L) into a QR module matrix — a
 * size×size array of row arrays of booleans, `true` = dark. Picks the smallest
 * fitting version in 1–10 and the best of the 8 masks by penalty score; throws
 * when the text won't fit v10 or `ecLevel` isn't 'L'.
 */
export function encodeQR(text, { ecLevel = 'L' } = {}) {
  if (ecLevel !== 'L') {
    throw new Error(`unsupported error-correction level "${ecLevel}" — this encoder only implements level L`);
  }
  const bytes = new TextEncoder().encode(String(text));
  let version = 0;
  for (let v = 1; v <= 10 && !version; v++) if (bytes.length <= byteCapacity(v)) version = v;
  if (!version) {
    throw new Error(
      `text is ${bytes.length} bytes; QR version 10 at EC level L holds at most ${byteCapacity(10)} — shorten the text`,
    );
  }

  // Bit stream: mode 0100, char count, data, terminator, byte-align, pad bytes.
  const bits = [];
  const push = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacityBits = dataCodewords(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    codewords.push(b);
  }
  for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) codewords.push(pad);

  // Split into blocks, append RS codewords, interleave data then EC.
  const [ecLen, groups] = EC_BLOCKS[version - 1];
  const blocks = [];
  let off = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++, off += len) {
      const data = codewords.slice(off, off + len);
      blocks.push({ data, ec: rsEncode(data, ecLen) });
    }
  }
  const stream = [];
  const maxLen = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.data.length) stream.push(b.data[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) stream.push(b.ec[i]);

  // Function patterns. `func` marks modules the data zigzag must skip.
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const func = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, dark) => {
    modules[r][c] = dark;
    func[r][c] = true;
  };
  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    // 7×7 finder ring plus its one-module light separator
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = fr + r;
        const cc = fc + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const d = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(rr, cc, d <= 3 && d !== 2);
      }
  }
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Alignment patterns everywhere except the three finder corners (they DO
  // overlap the timing lines — v7's (6, 22) sits right on the timing row).
  const centers = ALIGN[version - 1];
  const last = centers.length - 1;
  for (let i = 0; i <= last; i++)
    for (let j = 0; j <= last; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let r = -2; r <= 2; r++)
        for (let c = -2; c <= 2; c++)
          set(centers[i] + r, centers[j] + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
    }
  set(size - 8, 8, true); // the always-dark module
  if (version >= 7) {
    const vbits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((vbits >> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(b, a, dark);
      set(a, b, dark);
    }
  }
  // Reserve the format areas so the zigzag skips them (real bits drawn per
  // mask): row/column 8 around the top-left finder (position 6 is timing,
  // already reserved), the top-right 8 of row 8, the bottom-left 8 of column 8.
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      func[8][i] = true;
      func[i][8] = true;
    }
    if (i < 8) {
      func[8][size - 1 - i] = true;
      func[size - 1 - i][8] = true;
    }
  }

  // Zigzag data placement: column pairs right to left, alternating up/down,
  // skipping the vertical timing column. Left-over modules are remainder bits.
  let bitIndex = 0;
  const dataBits = stream.flatMap((cw) => Array.from({ length: 8 }, (_, i) => (cw >> (7 - i)) & 1));
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!func[r][c] && bitIndex < dataBits.length) {
          modules[r][c] = dataBits[bitIndex] === 1;
          bitIndex++;
        }
      }
    }
  }

  // Try all 8 masks on the data modules; keep the lowest penalty (XOR is its
  // own inverse, so each candidate is applied, scored, and peeled off).
  const applyMask = (mask) => {
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++) if (!func[r][c] && MASKS[mask](r, c)) modules[r][c] = !modules[r][c];
  };
  let best = { mask: 0, score: Infinity };
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(modules, formatBits(mask));
    const score = penalty(modules);
    if (score < best.score) best = { mask, score };
    applyMask(mask);
  }
  applyMask(best.mask);
  drawFormat(modules, formatBits(best.mask));
  return modules;
}

/**
 * Render `text` as a self-contained SVG string — no external refs, quiet zone
 * included, sized by `viewBox` (one unit per module) so the consumer scales it
 * freely. Options: `ecLevel`, `quiet` (modules of margin, default 4, the
 * spec minimum), `dark`/`light` colors.
 */
export function qrSvg(text, { ecLevel = 'L', quiet = 4, dark = '#000', light = '#fff' } = {}) {
  const matrix = encodeQR(text, { ecLevel });
  const size = matrix.length + quiet * 2;
  let d = '';
  for (let r = 0; r < matrix.length; r++)
    for (let c = 0; c < matrix.length; c++) if (matrix[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
