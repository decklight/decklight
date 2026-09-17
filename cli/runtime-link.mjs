// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A deck as data (#520): slides plus one JSON configuration block, and no
 * runtime in the file — no `<script src="decklight.js">`, no embedded engine,
 * no `Decklight.init(…)` call. The server adds the engine on the way out
 * (`linkRuntime`, applied by `staticFiles` to every html response and by
 * `present` to the deck it serves from memory); `bundle` embeds it at
 * hand-over through the same function, and then flattens the references it
 * just added exactly as it flattens a deck that wrote them itself.
 *
 * The configuration block is
 *
 *     <script type="application/json" data-decklight-config>
 *     { "decklight": "0.8.1", "theme": "aurora", "transition": "fade" }
 *     </script>
 *
 * inert to every browser (JSON is not executed), read by the runtime when it
 * boots — `Decklight.init()` with no argument takes its options from it, and
 * the engine boots itself once the document is parsed when a deck calls no
 * `init` of its own. Two keys are the file's, not the engine's: `decklight`
 * is the version the deck was written for (what `present --check` compares
 * against the runtime this install serves), `theme` names the theme the
 * server links (default `aurora`).
 *
 * One module, used by every command that has to know whether a file carries
 * a runtime, so that "no runtime at all" is the normal case everywhere and no
 * classifier is left assuming a deck must load an engine to be a deck.
 */

import { PKG } from './pkg.mjs';

export const DEFAULT_THEME = 'aurora';
export const CONFIG_ATTR = 'data-decklight-config';

const maskComments = (html) => html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

/** Is there a deck in this document at all? The one marker of deckness (DECK_ANATOMY). */
export const isDeck = (html) =>
  /<[a-z][^>]*\bclass=["'](?:[^"']*\s)?decklight(?:\s[^"']*)?["']/i.test(maskComments(html));

/**
 * Does the document load or carry the engine? True for a `<script src>`
 * naming `decklight.js`, a block marked `data-decklight-runtime="js"`, or an
 * unmarked block defining `Decklight` (the bundle output of every version).
 */
export function hasRuntime(html) {
  const masked = maskComments(html);
  for (const m of masked.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, inner] = m;
    if (/\bsrc\s*=\s*["'][^"']*(?:^|\/)?decklight(?:\.min)?\.js(?:[?#][^"']*)?["']/i.test(attrs)) return true;
    if (/\bdata-decklight-runtime\s*=\s*["']js["']/i.test(attrs)) return true;
    if (/(?:\bvar\s+|\bwindow\.)Decklight\s*=/.test(inner) || /\/\*!\s*Decklight v\d/.test(inner)) return true;
  }
  return false;
}

/**
 * Is the engine IN the file — a bundle, an `init --inline` deck — as opposed
 * to referenced or absent? What `bundle` and `publish` ask before flattening.
 */
export function hasEmbeddedRuntime(html) {
  const masked = maskComments(html);
  for (const m of masked.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [, attrs, inner] = m;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/\bdata-decklight-runtime\s*=\s*["']js["']/i.test(attrs)) return true;
    if (/(?:\bvar\s+|\bwindow\.)Decklight\s*=/.test(inner) || /\/\*!\s*Decklight v\d/.test(inner)) return true;
  }
  return false;
}

/** Does the document carry the runtime stylesheet — by reference or embedded? */
const hasRuntimeCss = (html) =>
  /<link\b[^>]*\bhref\s*=\s*["'][^"']*decklight(?:\.min)?\.css(?:[?#][^"']*)?["']/i.test(html)
  || /<style\b[^>]*\bdata-decklight-runtime\s*=\s*["']css["']/i.test(html);

/** Does the document carry a theme — a `themes/<name>.css` link or a `<style data-theme>` block? */
const hasTheme = (html) =>
  /<link\b[^>]*\bhref\s*=\s*["'][^"']*themes\/[\w-]+\.css(?:[?#][^"']*)?["']/i.test(html)
  || /<style\b[^>]*\bdata-theme\b/i.test(html);

/**
 * The configuration block, with its offsets: `start`/`end` span the whole
 * `<script>` element, `innerStart`/`innerEnd` its text. `config` is the
 * parsed object, or null with `error` set when the text is not JSON — a
 * deck with a broken block is still a deck, and the caller says what is
 * wrong rather than treating it as absent. Null when there is no block.
 */
export function configBlock(html) {
  const masked = maskComments(html);
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(masked))) {
    const [tag, attrs, inner] = m;
    if (!/\bdata-decklight-config\b/i.test(attrs)) continue;
    const innerStart = m.index + tag.length - inner.length - '</script>'.length;
    const block = { start: m.index, end: m.index + tag.length, attrs, inner, innerStart, innerEnd: innerStart + inner.length, config: null, error: null };
    try {
      const parsed = JSON.parse(inner);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) block.config = parsed;
      else block.error = 'the configuration block is not a JSON object';
    } catch (e) {
      block.error = `the configuration block is not valid JSON — ${e.message}`;
    }
    return block;
  }
  return null;
}

/** The parsed configuration, or null (no block, or not JSON). */
export const deckConfig = (html) => configBlock(html)?.config ?? null;

/** The version the block says the deck was written for, or null. */
export function configVersion(html) {
  const v = deckConfig(html)?.decklight;
  return typeof v === 'string' && v ? v : null;
}

/** The theme the block names, or the default. */
export function configTheme(html) {
  const t = deckConfig(html)?.theme;
  return typeof t === 'string' && /^[\w-]+$/.test(t) ? t : DEFAULT_THEME;
}

/**
 * The block's text with `decklight` recorded as `version` — edited in place
 * (the value swapped, or the key added first) so the author's own formatting
 * of the rest survives. Null when there is no block.
 */
export function withConfigVersion(html, version = PKG.version) {
  const block = configBlock(html);
  if (!block) return null;
  const keyRe = /("decklight"\s*:\s*)"[^"]*"/;
  let inner;
  if (keyRe.test(block.inner)) inner = block.inner.replace(keyRe, `$1"${version}"`);
  else {
    const open = block.inner.indexOf('{');
    if (open === -1) return null;
    const rest = block.inner.slice(open + 1);
    const empty = /^\s*}/.test(rest);
    inner = `${block.inner.slice(0, open + 1)} "decklight": "${version}"${empty ? ' ' : ', '}${rest.replace(/^\s+/, empty ? '' : '')}`;
  }
  return html.slice(0, block.innerStart) + inner + html.slice(block.innerEnd);
}

/** JSON text that is safe inside a `<script>`: a `</script` in a string value cannot end the block early. */
const jsonSafe = (text) => text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\u0021--');

/**
 * The configuration block as markup, `indent` in front of each line. The
 * keys the file owns (`decklight`, `theme`) lead, so the version is on the
 * first line whoever reads the file.
 */
export function configBlockHtml(config = {}, { indent = '  ', version = PKG.version } = {}) {
  const { decklight: _v, theme, ...rest } = config;
  const ordered = { decklight: version, ...(theme ? { theme } : {}), ...rest };
  const json = Object.keys(rest).length
    ? JSON.stringify(ordered, null, 2).split('\n').map((l) => indent + l).join('\n')
    : `${indent}{ ${Object.entries(ordered).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
  return `${indent}<script type="application/json" ${CONFIG_ATTR}>\n${jsonSafe(json)}\n${indent}</script>`;
}

/** The first executable `<script>` — no type, or a JavaScript one — and its offset; null when there is none. */
function firstExecutableScript(html) {
  const masked = maskComments(html);
  for (const m of masked.matchAll(/<script\b([^>]*)>/gi)) {
    const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(m[1])?.[1]?.trim().toLowerCase();
    if (!type || type === 'module' || /^(text|application)\/(javascript|ecmascript)$/.test(type)) return m.index;
  }
  return null;
}

/**
 * The document with the runtime referenced — and unchanged when it already
 * is, or when it is not a deck. Idempotent and ordered: the stylesheet and
 * the theme go at the end of `<head>` (each only when the document has none
 * of its own), the engine before the first script that executes — an
 * author's own script, or a `Decklight.init` call kept as the JS API's
 * escape hatch, must find `Decklight` defined — or else before `</body>`.
 * Every reference is a sibling path the servers answer from the installed
 * package (`packageAsset`), the same ones `init` used to write (#517).
 */
export function linkRuntime(html, { theme = null } = {}) {
  if (!isDeck(html) || hasRuntime(html)) return html;
  const head = [];
  if (!hasRuntimeCss(html)) head.push('<link rel="stylesheet" href="decklight.css" data-decklight-runtime="css">');
  if (!hasTheme(html)) head.push(`<link rel="stylesheet" href="themes/${theme ?? configTheme(html)}.css">`);
  let out = html;
  if (head.length) {
    const masked = maskComments(out);
    const headEnd = masked.search(/<\/head>/i);
    const bodyAt = masked.search(/<body\b/i);
    const at = headEnd !== -1 ? headEnd : bodyAt !== -1 ? bodyAt : 0;
    out = `${out.slice(0, at)}${head.join('\n')}\n${out.slice(at)}`;
  }
  const engine = '<script src="decklight.js" data-decklight-runtime="js"></script>';
  const scriptAt = firstExecutableScript(out);
  if (scriptAt !== null) return `${out.slice(0, scriptAt)}${engine}\n${out.slice(scriptAt)}`;
  const bodyEnd = maskComments(out).toLowerCase().lastIndexOf('</body>');
  return bodyEnd === -1 ? `${out}\n${engine}\n` : `${out.slice(0, bodyEnd)}${engine}\n${out.slice(bodyEnd)}`;
}

/**
 * A JavaScript object literal as data — the argument of a `Decklight.init(…)`
 * call, which `upgrade` turns into the configuration block. Accepts what an
 * author writes by hand: unquoted keys, single- or double-quoted strings,
 * numbers, booleans, null, nested arrays and objects, trailing commas, and
 * comments. Refuses anything that is code — an identifier, a call, an
 * expression — by returning null, so the call stays as it is: the JS API is
 * the escape hatch, and a guess at what an expression evaluates to is not.
 */
export function parseLiteral(src) {
  let i = 0;
  const s = String(src ?? '');
  const ws = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s.startsWith('//', i)) { const nl = s.indexOf('\n', i); i = nl === -1 ? s.length : nl + 1; continue; }
      if (s.startsWith('/*', i)) { const end = s.indexOf('*/', i + 2); if (end === -1) throw 0; i = end + 2; continue; }
      return;
    }
  };
  const string = () => {
    const q = s[i++];
    let out = '';
    while (i < s.length && s[i] !== q) {
      if (s[i] === '\n' && q !== '`') throw 0;
      if (s[i] === '\\') {
        const c = s[++i];
        const map = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' };
        if (c === 'u' && s[i + 1] === '{') { const end = s.indexOf('}', i); out += String.fromCodePoint(parseInt(s.slice(i + 2, end), 16)); i = end + 1; continue; }
        if (c === 'u') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 5; continue; }
        if (c === 'x') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16)); i += 3; continue; }
        out += c in map ? map[c] : c;
        i++;
        continue;
      }
      if (q === '`' && s.startsWith('${', i)) throw 0;
      out += s[i++];
    }
    if (s[i] !== q) throw 0;
    i++;
    return out;
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        ws();
        if (s[i] === '}') { i++; return obj; }
        let key;
        if (s[i] === '"' || s[i] === "'") key = string();
        else {
          const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
          if (!m) throw 0;
          key = m[0];
          i += key.length;
        }
        ws();
        if (s[i] !== ':') throw 0;
        i++;
        obj[key] = value();
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return obj; }
        throw 0;
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        ws();
        if (s[i] === ']') { i++; return arr; }
        arr.push(value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return arr; }
        throw 0;
      }
    }
    if (c === '"' || c === "'" || c === '`') return string();
    const num = /^[+-]?(?:\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?|0x[0-9a-f]+)/i.exec(s.slice(i));
    if (num) { i += num[0].length; return Number(num[0]); }
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (s.startsWith(word, i) && !/[\w$]/.test(s[i + word.length] ?? '')) { i += word.length; return v; }
    }
    throw 0;
  };
  try {
    ws();
    if (i >= s.length) return { value: {} };
    const v = value();
    ws();
    if (s[i] === ';') { i++; ws(); }
    if (i !== s.length) return null;
    return v && typeof v === 'object' && !Array.isArray(v) ? { value: v } : null;
  } catch {
    return null;
  }
}

/**
 * The deck's own `Decklight.init(…)` boot script, when it has one: the
 * `<script>` whose whole body is that one call (an optional `const deck =`
 * in front, at most a semicolon after), with the call's argument text.
 * `upgrade` turns the argument into the configuration block when
 * `parseLiteral` accepts it. Null when the deck boots some other way.
 */
export function bootCall(html) {
  const masked = maskComments(html);
  for (const m of masked.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const [tag, attrs, inner] = m;
    if (/\bsrc\s*=/i.test(attrs) || /\btype\s*=/i.test(attrs) && !/\btype\s*=\s*["'](?:text\/javascript|module)["']/i.test(attrs)) continue;
    const bare = inner.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ').trim();
    const head = /^(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*)?Decklight\s*\.\s*init\s*\(/.exec(bare);
    if (!head) continue;
    let depth = 0;
    for (let i = head[0].length - 1; i < bare.length; i++) {
      const c = bare[i];
      if (c === '"' || c === "'" || c === '`') {
        for (i++; i < bare.length && bare[i] !== c; i++) if (bare[i] === '\\') i++;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        if (!/^\s*;?\s*$/.test(bare.slice(i + 1))) break;
        return { start: m.index, end: m.index + tag.length, arg: bare.slice(head[0].length, i) };
      }
    }
  }
  return null;
}

/**
 * The span of an element widened to the whole line it sits on — the
 * indentation before it when nothing else is on the line, and the line
 * break after — so that removing the element removes its line, not just its
 * tag, and the author's surrounding text closes up as if it was never there.
 */
export function lineSpan(html, start, end) {
  let from = start;
  while (from > 0 && (html[from - 1] === ' ' || html[from - 1] === '\t')) from--;
  if (from > 0 && html[from - 1] !== '\n') from = start;
  let to = end;
  if (html[to] === '\r') to++;
  if (html[to] === '\n') to++;
  return { start: from, end: to };
}
