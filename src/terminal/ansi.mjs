// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Decklight ANSI subset renderer (SPEC §7.3).
 *
 * A pure, DOM-free state machine: feed raw PTY chunks (split anywhere, even
 * mid-escape), read back a styled line model or serialized HTML.
 *
 * Supported: SGR 0/1/2/3/4/7/22/23/24/27, 30-37/40-47/90-97/100-107 (16-color,
 * mapped to CSS classes -> theme `--ansi-*` tokens), 38;5/48;5 (256-color) and
 * 38;2/48;2 (truecolor) as inline styles, `\r` overwrite, `\b`, `\t`,
 * EL (`\x1b[K` variants 0/1/2), cursor forward/back (`\x1b[nC` / `\x1b[nD`).
 * Everything else (other CSI, OSC titles, charset selection, keypad modes) is
 * consumed and ignored — escape bytes never leak into output. Full-screen
 * cursor addressing is out of scope by design.
 */

const ESC = '\x1b';

const BLANK_STYLE = Object.freeze({
  fg: null, bg: null,
  bold: false, dim: false, italic: false, underline: false, inverse: false,
});

/** Standard xterm 256-color palette entry -> [r,g,b] (only used for n >= 16). */
export function xterm256ToRgb(n) {
  if (n < 16) return null; // 0-15 are theme-mapped, not fixed RGB
  if (n >= 16 && n <= 231) {
    const v = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return [steps[Math.floor(v / 36) % 6], steps[Math.floor(v / 6) % 6], steps[v % 6]];
  }
  const gray = 8 + (n - 232) * 10;
  return [gray, gray, gray];
}

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class AnsiScreen {
  constructor() {
    /** @type {{ch: string, style: object}[][]} */
    this.rows = [[]];
    this.row = 0;
    this.col = 0;
    this.style = { ...BLANK_STYLE };
    this._pending = ''; // partial escape sequence carried across chunks
  }

  /** Feed a raw chunk. */
  write(chunk) {
    let data = this._pending + chunk;
    this._pending = '';
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === ESC) {
        const consumed = this._consumeEscape(data, i);
        if (consumed === 0) { this._pending = data.slice(i); return; } // incomplete: buffer
        i += consumed;
        continue;
      }
      i += 1;
      if (ch === '\n') { this._lineFeed(); continue; }
      if (ch === '\r') { this.col = 0; continue; }
      if (ch === '\b') { this.col = Math.max(0, this.col - 1); continue; }
      if (ch === '\t') { this.col = (Math.floor(this.col / 8) + 1) * 8; continue; }
      if (ch === '\x07') continue; // bell
      if (ch < ' ' && ch !== '\t') continue; // other C0 controls: ignore
      this._putChar(ch);
    }
  }

  _lineFeed() {
    this.row += 1;
    if (!this.rows[this.row]) this.rows[this.row] = [];
    // PTYs run with onlcr so we virtually always see \r\n; keep the column for
    // correctness on bare \n.
  }

  _putChar(ch) {
    const line = this.rows[this.row];
    while (line.length < this.col) line.push({ ch: ' ', style: BLANK_STYLE });
    line[this.col] = { ch, style: { ...this.style } };
    this.col += 1;
  }

  /**
   * Consume one escape sequence starting at data[i] (an ESC).
   * Returns the number of chars consumed, or 0 if the sequence is incomplete
   * (caller buffers the remainder for the next chunk).
   */
  _consumeEscape(data, i) {
    if (i + 1 >= data.length) return 0;
    const kind = data[i + 1];

    if (kind === '[') { // CSI
      let j = i + 2;
      while (j < data.length) {
        const c = data.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) { // final byte
          this._handleCsi(data.slice(i + 2, j), data[j]);
          return j - i + 1;
        }
        j += 1;
      }
      return 0; // incomplete
    }

    if (kind === ']') { // OSC — terminated by BEL or ST (ESC \)
      let j = i + 2;
      while (j < data.length) {
        if (data[j] === '\x07') return j - i + 1;
        if (data[j] === ESC && data[j + 1] === '\\') return j - i + 2;
        if (data[j] === ESC && j + 1 >= data.length) return 0;
        j += 1;
      }
      return 0;
    }

    if (kind === '(' || kind === ')') { // charset selection: ESC ( B
      return i + 2 < data.length ? 3 : 0;
    }

    // Single-char escapes: ESC =, ESC >, ESC 7, ESC 8, ESC M, ESC c ...
    return 2;
  }

  _handleCsi(params, final) {
    // Private-mode sequences like \x1b[?25l — consume, ignore.
    if (params.startsWith('?')) return;
    switch (final) {
      case 'm': this._sgr(params); return;
      case 'K': this._eraseLine(params); return;
      case 'C': this.col += Math.max(1, parseInt(params || '1', 10) || 1); return;
      case 'D': this.col = Math.max(0, this.col - (Math.max(1, parseInt(params || '1', 10) || 1))); return;
      default: return; // cursor addressing, ED, scroll regions… out of scope
    }
  }

  _eraseLine(params) {
    const mode = parseInt(params || '0', 10) || 0;
    const line = this.rows[this.row];
    if (mode === 0) { line.length = Math.min(line.length, this.col); return; }
    if (mode === 1) {
      for (let c = 0; c <= Math.min(this.col, line.length - 1); c++) line[c] = { ch: ' ', style: BLANK_STYLE };
      return;
    }
    if (mode === 2) { line.length = 0; return; }
  }

  _sgr(params) {
    const p = params === '' ? [0] : params.split(';').map(x => parseInt(x, 10) || 0);
    let i = 0;
    while (i < p.length) {
      const n = p[i];
      if (n === 0) this.style = { ...BLANK_STYLE };
      else if (n === 1) this.style.bold = true;
      else if (n === 2) this.style.dim = true;
      else if (n === 3) this.style.italic = true;
      else if (n === 4) this.style.underline = true;
      else if (n === 7) this.style.inverse = true;
      else if (n === 22) { this.style.bold = false; this.style.dim = false; }
      else if (n === 23) this.style.italic = false;
      else if (n === 24) this.style.underline = false;
      else if (n === 27) this.style.inverse = false;
      else if (n >= 30 && n <= 37) this.style.fg = { type: 'ansi', idx: n - 30 };
      else if (n >= 90 && n <= 97) this.style.fg = { type: 'ansi', idx: n - 90 + 8 };
      else if (n === 39) this.style.fg = null;
      else if (n >= 40 && n <= 47) this.style.bg = { type: 'ansi', idx: n - 40 };
      else if (n >= 100 && n <= 107) this.style.bg = { type: 'ansi', idx: n - 100 + 8 };
      else if (n === 49) this.style.bg = null;
      else if (n === 38 || n === 48) {
        const target = n === 38 ? 'fg' : 'bg';
        if (p[i + 1] === 5 && p.length > i + 2) { this.style[target] = { type: '256', idx: p[i + 2] }; i += 2; }
        else if (p[i + 1] === 2 && p.length > i + 4) {
          this.style[target] = { type: 'rgb', r: p[i + 2], g: p[i + 3], b: p[i + 4] };
          i += 4;
        }
      }
      i += 1;
    }
  }

  /** Line model: consecutive same-styled cells merged into spans. */
  get lines() {
    return this.rows.map(row => {
      const spans = [];
      for (const cell of row) {
        const last = spans[spans.length - 1];
        if (last && sameStyle(last.style, cell.style)) last.text += cell.ch;
        else spans.push({ text: cell.ch, style: cell.style });
      }
      return spans;
    });
  }

  /** Serialize to HTML. 16-color -> classes (theme tokens); 256/truecolor -> inline. */
  toHtml() {
    return this.lines.map(spans => spansToHtml(spans)).join('\n');
  }
}

function sameStyle(a, b) {
  return a.bold === b.bold && a.dim === b.dim && a.italic === b.italic &&
    a.underline === b.underline && a.inverse === b.inverse &&
    colorEq(a.fg, b.fg) && colorEq(a.bg, b.bg);
}

function colorEq(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.idx === b.idx && a.r === b.r && a.g === b.g && a.b === b.b;
}

function colorCss(c) {
  if (c.type === '256') {
    if (c.idx < 16) return null; // handled via class
    const [r, g, b] = xterm256ToRgb(c.idx);
    return `rgb(${r},${g},${b})`;
  }
  if (c.type === 'rgb') return `rgb(${c.r},${c.g},${c.b})`;
  return null;
}

export function spansToHtml(spans) {
  return spans.map(({ text, style }) => {
    const classes = [];
    const css = [];
    let { fg, bg } = style;
    if (style.inverse) [fg, bg] = [bg ?? { type: 'inv-default-bg' }, fg ?? { type: 'inv-default-fg' }];
    for (const [color, kind] of [[fg, 'fg'], [bg, 'bg']]) {
      if (!color) continue;
      if (color.type === 'ansi' || (color.type === '256' && color.idx < 16)) {
        classes.push(`ansi-${kind}-${color.idx}`);
      } else if (color.type === 'inv-default-bg') classes.push('ansi-inv-fg'); // fg becomes default bg color
      else if (color.type === 'inv-default-fg') classes.push('ansi-inv-bg');
      else {
        const v = colorCss(color);
        if (v) css.push(`${kind === 'fg' ? 'color' : 'background-color'}:${v}`);
      }
    }
    if (style.bold) classes.push('ansi-bold');
    if (style.dim) classes.push('ansi-dim');
    if (style.italic) classes.push('ansi-italic');
    if (style.underline) classes.push('ansi-underline');
    const esc = escapeHtml(text);
    if (!classes.length && !css.length) return esc;
    const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
    const sty = css.length ? ` style="${css.join(';')}"` : '';
    return `<span${cls}${sty}>${esc}</span>`;
  }).join('');
}
