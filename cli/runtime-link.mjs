// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A deck as data (#520): slides plus one JSON configuration block, and no
 * runtime in the file — no `<script src="decklight.js">`, no embedded engine,
 * no `Decklight.init(…)` call. The server adds the engine on the way out
 * (`linkRuntime`, applied by `staticFiles` to every html response and by
 * `--no-trust` to the deck it serves from memory); `bundle` embeds it at
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
 * is the version the deck was written for (what --no-trust --audit compares
 * against the runtime this install serves), `theme` names the theme the
 * server links (default `aurora`).
 *
 * One module, used by every command that has to know whether a file carries
 * a runtime, so that "no runtime at all" is the normal case everywhere and no
 * classifier is left assuming a deck must load an engine to be a deck.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { PKG, THEMES_DIR } from './pkg.mjs';

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

/**
 * Does the document carry a theme of its OWN — a `themes/<name>.css` link or a
 * `<style data-theme>` block? An added theme (`data-theme-added`, inline or
 * linked) is not one: it is an extra the picker offers over the deck's base
 * theme, and a deck carrying only extras still needs that base linked.
 */
function hasTheme(html) {
  for (const [, tag, attrs] of html.matchAll(/<(link|style)\b([^>]*)>/gi)) {
    if (/\bdata-theme-added\b/i.test(attrs)) continue;
    if (tag.toLowerCase() === 'style' ? /\bdata-theme\b/i.test(attrs)
      : /\bhref\s*=\s*["'][^"']*themes\/[\w-]+\.css(?:[?#][^"']*)?["']/i.test(attrs)) return true;
  }
  return false;
}

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
 * The theme a server LINKS as the deck's base: the configured one, unless it
 * names a theme the deck marks from a marketplace (`markedThemes`, SPEC
 * THEME_DISTRIBUTION). That one is not a file in `themes/`; it arrives as an
 * added theme and the runtime applies it over the default linked here.
 */
export function baseTheme(html) {
  const t = configTheme(html);
  const marked = deckConfig(html)?.markedThemes;
  // marketplace references only: a marked SHIPPED theme is a file in themes/
  const names = Array.isArray(marked) ? marked.filter((r) => String(r).includes('@')).map((r) => String(r).split('@')[0]) : [];
  if (names.includes(t)) return DEFAULT_THEME;
  // a design system's own theme (SPEC BRAND_PALETTE) is a block the server
  // adds with the design system, not a file in themes/: the page opens on the
  // default and the runtime applies the configured one, as for a marked theme
  const usesSystems = Array.isArray(deckConfig(html)?.designSystems) && deckConfig(html).designSystems.length > 0;
  if (usesSystems && t && !existsSync(path.join(THEMES_DIR, `${t}.css`))) return DEFAULT_THEME;
  return t;
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

/**
 * The block's text with `theme` set — the value swapped, or the key added
 * after `decklight` (or first), so the author's own formatting survives.
 * Null when there is no block.
 */
export function withConfigTheme(html, name) {
  const block = configBlock(html);
  if (!block) return null;
  const keyRe = /("theme"\s*:\s*)"[^"]*"/;
  let inner;
  if (keyRe.test(block.inner)) inner = block.inner.replace(keyRe, `$1"${name}"`);
  else {
    const afterVersion = /("decklight"\s*:\s*"[^"]*")/;
    if (afterVersion.test(block.inner)) inner = block.inner.replace(afterVersion, `$1, "theme": "${name}"`);
    else {
      const open = block.inner.indexOf('{');
      if (open === -1) return null;
      const rest = block.inner.slice(open + 1);
      const empty = /^\s*}/.test(rest);
      inner = `${block.inner.slice(0, open + 1)} "theme": "${name}"${empty ? ' ' : ', '}${rest.replace(/^\s+/, empty ? '' : '')}`;
    }
  }
  return html.slice(0, block.innerStart) + inner + html.slice(block.innerEnd);
}

/**
 * Where a top-level `key` sits in an object literal — JSON, or a JS literal
 * with bare keys and single quotes — as `{ keyStart, valueEnd, open, close }`
 * (`open`/`close` the outer braces); `keyStart`/`valueEnd` null when the key
 * is absent. Null when `text` holds no object. Strings are skipped whole, so
 * a brace inside one never counts.
 */
function keySpan(text, key) {
  const open = text.indexOf('{');
  if (open === -1) return null;
  let depth = 0; let i = open; let keyStart = null; let valueEnd = null; let pendingKey = null; let close = -1;
  const skipString = (q) => { for (i++; i < text.length && text[i] !== q; i++) if (text[i] === '\\') i++; };
  // the value ends where its last character does, not where the comma or brace sits
  const trimmedEnd = (at) => { let e = at; while (e > 0 && /\s/.test(text[e - 1])) e--; return e; };
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const from = i; skipString(c);
      if (depth === 1 && pendingKey === null) pendingKey = { name: text.slice(from + 1, i), start: from };
      continue;
    }
    if (c === '{' || c === '[') { depth++; continue; }
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) { close = i; if (keyStart !== null && valueEnd === null) valueEnd = trimmedEnd(i); break; }
      continue;
    }
    if (depth !== 1) continue;
    if (/[A-Za-z_$]/.test(c) && pendingKey === null) {
      const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
      pendingKey = { name: m[0], start: i }; i += m[0].length - 1; continue;
    }
    if (c === ':' && pendingKey) {
      if (pendingKey.name === key) keyStart = pendingKey.start;
      pendingKey = { name: null, start: -1, value: true };
      continue;
    }
    if (c === ',') {
      if (keyStart !== null && valueEnd === null) valueEnd = trimmedEnd(i);
      pendingKey = null;
    }
  }
  if (close === -1) return null;
  return { open, close, keyStart, valueEnd };
}

/** `text` with top-level `key` set to `valueText` (or removed, null), spliced in place: nothing else moves. */
function withObjectKey(text, key, valueText) {
  const span = keySpan(text, key);
  if (!span) return null;
  const { open, close, keyStart, valueEnd } = span;
  if (keyStart !== null) {
    if (valueText !== null) return text.slice(0, keyStart) + `"${key}": ${valueText}` + text.slice(valueEnd);
    // off: the key, its value, and the comma that joined it to a neighbour
    let a = keyStart; let b = valueEnd;
    const after = /^\s*,\s*/.exec(text.slice(b));
    if (after) b += after[0].length;
    else { const before = /,\s*$/.exec(text.slice(open + 1, a)); if (before) a = open + 1 + before.index; }
    return text.slice(0, a) + text.slice(b);
  }
  if (valueText === null) return text;
  const inner = text.slice(open + 1, close);
  const empty = /^\s*$/.test(inner);
  const indent = /\n([ \t]*)\S/.exec(inner)?.[1] ?? (empty ? '  ' : ' ');
  const lastLine = /\n([ \t]*)$/.exec(inner)?.[1] ?? '';
  const nl = inner.includes('\n');
  const sep = empty ? (nl ? '' : ' ') : (nl ? `,\n${indent}` : ', ');
  const body = inner.replace(/\s+$/, '');
  return text.slice(0, open + 1) + (empty && nl ? `\n${indent}` : '') + body + sep + `"${key}": ${valueText}` + (nl ? `\n${lastLine}` : (empty ? ' ' : ' ')) + text.slice(close);
}

/**
 * The deck's concept colours (SVG_DIAGRAMS, #718), written the way the deck
 * carries its configuration: the configuration block's `concepts` key for a
 * deck that is data, or the `concepts` key of a plain-data `Decklight.init`
 * literal for a bundle. `concepts` is `{ name: slot (1-6) | css colour }`;
 * an empty map takes the key off. The key is spliced in place and nothing
 * else in the block moves. Null when the deck carries its configuration in
 * neither way (an init call that is code is the author's, not this server's),
 * or when a name or a value is not one the runtime reads.
 */
export function setDeckConcepts(html, concepts) {
  const clean = {};
  for (const [name, v] of Object.entries(concepts ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,40}$/i.test(name)) return null;
    if (typeof v === 'number' ? !(Number.isInteger(v) && v >= 1 && v <= 6) : (typeof v !== 'string' || !/^(?:var\(--[a-z][a-z0-9-]{0,40}\)|#[0-9a-f]{3,8})$/i.test(v))) return null;
    clean[name] = v;
  }
  const valueText = Object.keys(clean).length ? '{ ' + Object.entries(clean).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(', ') + ' }' : null;
  return withDeckConfigText(html, (text) => withObjectKey(text, 'concepts', valueText));
}

/**
 * Where this deck carries its configuration, so it can be rewritten in place:
 * `{ kind: 'block', block }` for the configuration block (a deck that is
 * data), `{ kind: 'boot', boot }` for a bundle's `Decklight.init({…})` whose
 * argument is a plain-data literal; or `{ why }`, one sentence saying why it
 * cannot be (a block that is not JSON, an init call that is code or booted
 * from a separate script, no configuration at all).
 */
export function deckConfigSource(html) {
  const block = configBlock(html);
  if (block) return block.config ? { kind: 'block', block, config: block.config } : { why: `its configuration block cannot be read: ${block.error}` };
  const boot = bootCall(html);
  if (!boot) {
    return /<script\b[^>]*\bsrc\s*=[^>]*>/i.test(html) && /Decklight\s*\.\s*init\b/.test(html) === false
      ? { why: 'it is booted from a separate script, so its configuration is not in this file' }
      : { why: 'its configuration is not in a form this editor rewrites: no configuration block, and no Decklight.init({…}) of plain data' };
  }
  const lit = parseLiteral(boot.arg);
  if (!lit) return { why: 'its Decklight.init(…) is code, not plain data, so it is the author’s to edit' };
  return { kind: 'boot', boot, config: lit.value };
}

/**
 * `html` with its configuration's text rewritten by `edit(text)` (the block's
 * JSON, or the init call's literal), spliced in place so nothing else in the
 * file moves. Null when the deck carries its configuration in neither way, or
 * `edit` gives null.
 */
function withDeckConfigText(html, edit) {
  const src = deckConfigSource(html);
  if (src.kind === 'block') {
    const inner = edit(src.block.inner);
    return inner === null ? null : html.slice(0, src.block.innerStart) + inner + html.slice(src.block.innerEnd);
  }
  if (src.kind === 'boot') {
    const { boot } = src;
    const call = html.slice(boot.start, boot.end);
    const argStart = call.indexOf(boot.arg);
    if (argStart === -1) return null;
    const arg = edit(boot.arg);
    if (arg === null) return null;
    return html.slice(0, boot.start) + call.slice(0, argStart) + arg + call.slice(argStart + boot.arg.length) + html.slice(boot.end);
  }
  return null;
}

/** The value text of top-level `key` in an object literal's `text` (from after its colon), or null. */
function valueTextOf(text, key) {
  const span = keySpan(text, key);
  if (!span || span.keyStart === null) return null;
  const colon = text.indexOf(':', span.keyStart);
  let from = colon + 1;
  while (/\s/.test(text[from])) from++;
  return { from, to: span.valueEnd, text: text.slice(from, span.valueEnd) };
}

/**
 * What Deck settings… writes (PRESENTING_EDITING), each key with the one
 * shape it takes and its default: a value set back to its default takes the
 * key off the file. `narration.*` are the keys of the `narration` object;
 * the object goes when its last key does.
 */
const LOGO_KEYS = ['onLight', 'onDark', 'src', 'height', 'position'];
const LOGO_POSITIONS = ['bottom-left', 'top-left', 'top-right', 'bottom-right'];
const relPath = (v) => typeof v === 'string' && v.length <= 200 && !/^(?:[a-z][a-z0-9+.-]*:|\/|#|<)/i.test(v) && !/(?:^|\/)\.\.(?:\/|$)/.test(v) && !/["'<>\\]/.test(v);
const pause = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 60;
export const DECK_SETTINGS = {
  transition: { ok: (v) => ['none', 'fade', 'slide', 'scale', 'flip'].includes(v), dflt: 'fade' },
  slideNumber: { ok: (v) => v === false || v === 'n' || v === 'n/N', dflt: false },
  controls: { ok: (v) => typeof v === 'boolean', dflt: true },
  pinTitles: { ok: (v) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2000), dflt: true },
  logo: {
    ok: (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => LOGO_KEYS.includes(k))
      && ['onLight', 'onDark', 'src'].every((k) => v[k] === undefined || relPath(v[k]))
      && (v.onLight || v.onDark || v.src)
      && (v.height === undefined || (typeof v.height === 'number' && v.height >= 8 && v.height <= 400))
      && (v.position === undefined || LOGO_POSITIONS.includes(v.position)),
    dflt: undefined,
  },
  'narration.slidePause': { ok: pause, dflt: 1 },
  'narration.beatPause': { ok: pause, dflt: 0.5 },
  'narration.sentencePause': { ok: pause, dflt: 0.25 },
};

/**
 * The deck's settings (`set`: `{ key: value | null }`, DECK_SETTINGS), each
 * written in its place in the configuration block or the init literal: a
 * value its default (or null) takes the key off. Throws on a key or a value
 * it does not write; null when the deck's configuration cannot be rewritten
 * (deckConfigSource says why).
 */
export function setDeckConfig(html, set) {
  if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length) throw new Error('bad set');
  for (const [key, v] of Object.entries(set)) {
    const rule = Object.hasOwn(DECK_SETTINGS, key) ? DECK_SETTINGS[key] : null;
    if (!rule) throw new Error(`not a deck setting this server writes: ${String(key).slice(0, 40)}`);
    if (v !== null && !rule.ok(v)) throw new Error(`not a value ${key} takes: ${JSON.stringify(v)?.slice(0, 60)}`);
  }
  const off = (key, v) => v === null || JSON.stringify(v) === JSON.stringify(DECK_SETTINGS[key].dflt);
  return withDeckConfigText(html, (text) => {
    let t = text;
    for (const [key, v] of Object.entries(set)) {
      if (!key.startsWith('narration.')) {
        t = withObjectKey(t, key, off(key, v) ? null : JSON.stringify(v));
        if (t === null) return null;
        continue;
      }
      // a nested key: spliced inside `narration`, which is made, or taken off with its last key
      const sub = key.slice('narration.'.length);
      const had = valueTextOf(t, 'narration');
      if (had && !/^\{/.test(had.text)) return null;
      const obj = had ? had.text : '{}';
      const next = withObjectKey(obj, sub, off(key, v) ? null : JSON.stringify(v));
      if (next === null) return null;
      const empty = /^\{\s*\}$/.test(next);
      if (had) t = empty ? withObjectKey(t, 'narration', null) : t.slice(0, had.from) + next + t.slice(had.to);
      else if (!empty) t = withObjectKey(t, 'narration', next.replace(/^\{\s*/, '{ ').replace(/\s*\}$/, ' }'));
      if (t === null) return null;
    }
    return t;
  });
}

/** Text as it goes between `<title>` and `</title>`: `&` and `<` escaped, one line. */
const titleText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The page's `<title>`, set in place (the hud, a commit message and an export
 * read it), or added at the top of `<head>`; an empty one is left empty.
 */
export function setDeckTitle(html, title) {
  const t = String(title ?? '');
  if (t.length > 200 || /[\u0000-\u001f\u007f]/.test(t)) throw new Error('a title is one line of up to 200 characters');
  const masked = maskComments(html);
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(masked);
  if (m) {
    const at = m.index + m[0].indexOf('>') + 1;
    return html.slice(0, at) + titleText(t) + html.slice(at + m[1].length);
  }
  const head = /<head\b[^>]*>/i.exec(masked);
  if (!head) throw new Error('the deck has no <head> to put a title in');
  const at = head.index + head[0].length;
  const indent = /\n([ \t]*)\S/.exec(html.slice(at))?.[1] ?? '  ';
  return html.slice(0, at) + `\n${indent}<title>${titleText(t)}</title>` + html.slice(at);
}

/** The page's title as text (entities read), or ''. */
export function deckTitle(html) {
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(maskComments(html));
  if (!m) return '';
  const raw = html.slice(m.index, m.index + m[0].length).replace(/^<title\b[^>]*>/i, '').replace(/<\/title>$/i, '');
  return raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
}

/**
 * What Deck settings… shows: the title, each setting as the file says it (the
 * default where it says nothing), and whether it can be written here, with
 * the one sentence saying why not.
 */
export function deckSettings(html) {
  const src = deckConfigSource(html);
  const cfg = src.config ?? {};
  const values = {};
  for (const [key, rule] of Object.entries(DECK_SETTINGS)) {
    const v = key.startsWith('narration.') ? cfg.narration?.[key.slice('narration.'.length)] : cfg[key];
    values[key] = v === undefined ? (rule.dflt ?? null) : v;
  }
  return { title: deckTitle(html), values, editable: !src.why, why: src.why ?? null };
}

/**
 * Whether the theme picker holds the deck to its design systems' own themes
 * (SPEC BRAND_PALETTE): on unless the configuration says `"brandThemesOnly":
 * false`, so `only` true takes the key off and false writes it. Written in a
 * deck that is data only, the configuration block; null otherwise.
 */
export function setDeckBrandThemesOnly(html, only) {
  const block = configBlock(html);
  if (!block?.config) return null;
  const inner = withObjectKey(block.inner, 'brandThemesOnly', only ? null : 'false');
  if (inner === null) return null;
  return html.slice(0, block.innerStart) + inner + html.slice(block.innerEnd);
}

/**
 * The deck's theme, written the way this deck carries it (PRESENTING): the
 * configuration block's `theme` for a deck that is data; for a bundle, the
 * active one among its embedded `<style data-theme>` blocks (`media="all"`
 * on the chosen, `not all` on the rest — the shape `bundle` and `upgrade`
 * write); for a source deck, the `themes/<name>.css` link. Null when the
 * deck carries its theme in none of those ways, or does not have `name`.
 */
export function setDeckTheme(html, name) {
  if (!/^[\w-]+$/.test(name)) return null;
  if (configBlock(html)) return withConfigTheme(html, name);
  const styles = [...html.matchAll(/<style\b([^>]*\bdata-theme\s*=\s*["']([\w-]+)["'][^>]*)>/gi)];
  if (styles.length) {
    if (!styles.some((m) => m[2] === name)) return null;
    let out = html;
    for (const m of styles) {
      const attrs = m[1].replace(/\s*\bmedia\s*=\s*["'][^"']*["']/i, '');
      const tag = `<style${attrs}${m[2] === name ? '' : ' media="not all"'}>`;
      out = out.replace(m[0], tag);
    }
    return out;
  }
  const link = /(<link\b[^>]*\bhref\s*=\s*["'][^"']*themes\/)([\w-]+)(\.css(?:[?#][^"']*)?["'][^>]*>)/i;
  if (link.test(html)) return html.replace(link, `$1${name}$3`);
  return null;
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
export function firstExecutableScript(html) {
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
  if (!hasTheme(html)) head.push(`<link rel="stylesheet" href="themes/${theme ?? baseTheme(html)}.css">`);
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
