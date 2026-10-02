// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck's fonts, as REFERENCES (SPEC FONTS) — the third instance of what
// THEME_DISTRIBUTION built for themes and DESIGN_SYSTEMS for design systems:
//
//   "fonts": ["inter@type-mkt"],
//   "themeSources": { "type-mkt": "acme/decklight-marketplace" }
//
// The deck records WHICH font it uses; the faces stay in the marketplace.
// Every server links them into the page from the checkouts on this machine
// (`linkFonts`: an @font-face per face, and a meta block the font picker
// reads) and answers the files under `decklight-font/<marketplace>/<name>/…`
// (`fontAsset`). `bundle` carries them as data: URIs. Nothing here fetches.
//
// A referenced font makes a FAMILY available; it does not apply it. A theme
// that names the family in --font-body gets it; the font picker offers it;
// the deck's `font` default (config) or the viewer's pick sets it.

import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { escapeHtml } from '../tools/escape.mjs';
import { FONT_API_VERSION, FACE_EXTENSIONS, fontFaceCss, fontStack } from '../tools/font-format.mjs';
import { configBlock, isDeck } from './runtime-link.mjs';
import { configHome, loadRegistry, loadCatalog, MarketplaceError, NAME_RE } from './marketplace.mjs';
import {
  parseRef, resolveCatalogEntry, markedSources, withKey, referencedMarketplaces,
  FONTS_KEY, SOURCES_KEY, MARKED_KEY, DESIGN_SYSTEMS_KEY,
} from './theme-refs.mjs';
import { resolveSource } from './theme.mjs';
import { signature } from './design-system-refs.mjs';
import { checkFontDir } from './font.mjs';

export { FONTS_KEY };

/** The config key a deck's DEFAULT font lives under: a referenced font's name, or a picker stack's label. */
export const FONT_DEFAULT_KEY = 'font';

/** The fonts a deck references, parsed; anything else dropped, not guessed at. */
export function fontRefs(html) {
  const list = configBlock(html)?.config?.[FONTS_KEY];
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.map((e) => parseRef(e)).filter((r) => r && !seen.has(r.ref) && seen.add(r.ref));
}

/**
 * Resolve a reference to its package directory on this machine — registry,
 * catalog cache and checkouts only — or `{ missing }` in words a presenter can
 * act on. `{ name, marketplace, ref, local, title, entry, dir, source }`.
 */
export function resolveFontRef(ref, home = configHome(), { source = null } = {}) {
  const parsed = typeof ref === 'string' ? parseRef(ref) : ref;
  if (!parsed) return { ref: String(ref), missing: 'not a font reference (name@marketplace)' };
  const hit = resolveCatalogEntry(parsed, home, { source });
  if (hit.missing) return hit;
  const { local, title, entry, registered, origin } = hit;
  if (entry.type !== 'font') return { ...parsed, entry, missing: `"${parsed.ref}" is a ${entry.type}, not a font` };
  if (Number.isInteger(entry.apiVersion) && entry.apiVersion > FONT_API_VERSION) {
    return { ...parsed, entry, missing: `${parsed.ref} needs a newer decklight — it is written for font format ${entry.apiVersion}, this one reads up to ${FONT_API_VERSION}` };
  }
  if (typeof entry.source !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(entry.source)) {
    return { ...parsed, entry, missing: `${parsed.ref} names a URL as its source — a font is a directory of files in its marketplace` };
  }
  let dir;
  try { dir = resolveSource(entry.source, { name: local, source: registered.source }, home); }
  catch (e) {
    if (e instanceof MarketplaceError) return { ...parsed, title, entry, missing: e.message.replace(/\n\s*/g, ' — ') };
    throw e;
  }
  let isDir = false;
  try { isDir = statSync(dir).isDirectory(); } catch { /* not here */ }
  if (!isDir) return { ...parsed, title, entry, missing: `${parsed.ref}: ${entry.source} is not in the marketplace's files` };
  return { ...parsed, local, title, entry, dir: resolve(dir), source: origin };
}

const verdicts = new Map();

/**
 * Does the package STILL pass `decklight font check`? It follows its
 * marketplace, so it is re-checked wherever it is used, remembered by a stat
 * signature. `{ ok, why, summary, manifest }`.
 */
export function fontVerdict(dir) {
  let sig;
  try { sig = signature(dir); } catch { return { ok: false, why: 'its files are gone' }; }
  const hit = verdicts.get(dir);
  if (hit && hit.sig === sig) return hit.value;
  const r = checkFontDir(dir);
  const value = r.ok
    ? { ok: true, summary: r.summary, manifest: r.manifest }
    : { ok: false, why: `it no longer passes the font check — ${r.problems[0].file}${r.problems[0].line ? ` line ${r.problems[0].line}` : ''}: ${r.problems[0].msg} (decklight font check)` };
  verdicts.set(dir, { sig, value });
  return value;
}

/** What the page is told about a font: the facts the font picker reads. */
export function fontMeta(verdict, name = verdict.manifest?.name) {
  const m = verdict.manifest ?? {};
  return { name, title: m.title, family: m.family, fallback: m.fallback, stack: fontStack(m), role: m.role ?? 'any', version: m.version };
}

/** Where a server answers a package's files, relative to the deck. */
export const fontHref = (marketplace, name, path) => `decklight-font/${marketplace}/${name}/${path}`;

/** JSON safe inside a <script> — the manifest is somebody else's file. */
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/** The two blocks a page carries for one font: its @font-face rules, and its meta. */
function fontTags(name, verdict, urlFor) {
  const n = escapeHtml(name);
  return [
    `<style data-font="${n}" data-font-version="${escapeHtml(String(verdict.manifest.version ?? ''))}">\n${fontFaceCss(verdict.manifest, urlFor).replace(/<\/(style)/gi, '<\\/$1')}\n</style>`,
    `<script type="application/json" data-font-meta="${n}">${scriptJson(fontMeta(verdict, name))}</script>`,
  ];
}

/**
 * A deck's fonts, linked into the page on its way out — what every server
 * does after `linkDesignSystems`, never `bundle`. Per reference, before
 * `</head>`: a `<style data-font>` of @font-face rules whose `src` is the
 * served file, and the meta. Nothing when the page already carries it (a
 * bundle's own copy). One this machine cannot read becomes `<meta
 * name="decklight-font-missing">` naming it and why: the theme's own stack
 * shows, nothing breaks.
 */
export function linkFonts(html, home = configHome(), { log = null } = {}) {
  if (!isDeck(html)) return html;
  const refs = fontRefs(html);
  if (!refs.length) return html;
  const sources = markedSources(html);
  const tags = [];
  for (const ref of refs) {
    if (new RegExp(`<style\\b[^>]*\\bdata-font\\s*=\\s*["']${ref.name}["']`, 'i').test(html)) continue;
    const r = resolveFontRef(ref, home, { source: sources[ref.marketplace] ?? null });
    const verdict = r.dir ? fontVerdict(r.dir) : null;
    if (r.dir && !verdict.ok) r.missing = verdict.why;
    if (r.dir && verdict.ok) tags.push(...fontTags(ref.name, verdict, (file) => fontHref(r.local, r.name, file)));
    else {
      tags.push(`<meta name="decklight-font-missing" content="${escapeHtml(`${ref.ref} — ${r.missing}`)}">`);
      log?.(`font ${ref.ref}: ${r.missing}`);
    }
  }
  if (!tags.length) return html;
  const masked = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const headEnd = masked.search(/<\/head>/i);
  const at = headEnd !== -1 ? headEnd : Math.max(0, masked.search(/<body\b/i));
  return `${html.slice(0, at)}${tags.join('\n')}\n${html.slice(at)}`;
}

/**
 * What a bundle carries for one resolved, still-valid font: the same two
 * blocks, every face a base64 data: URI — `{ tags, bytes, faces }`. A
 * bundle opened offline has the face; a re-serve sees the <style data-font>
 * and links no second copy.
 */
export function bundleFont(r, verdict) {
  let bytes = 0;
  const urlFor = (file) => {
    const data = readFileSync(join(r.dir, file));
    bytes += data.length;
    const mime = file.toLowerCase().endsWith('.woff2') ? 'font/woff2' : 'font/woff';
    return `data:${mime};base64,${data.toString('base64')}`;
  };
  const tags = fontTags(r.name, verdict, urlFor);
  return { tags, bytes, faces: verdict.manifest.faces.length };
}

const NAMESPACE = /(?:^|\/)decklight-font\/(.*)$/;

/** Is this request path in the font namespace at all? */
export const inFontNamespace = (rel) => NAMESPACE.test(String(rel ?? '').split('\\').join('/'));

/**
 * `staticFiles`' answer for a face of a registered font — `{ file, type,
 * headers }`, or null, answered as one plain 404 whatever the reason. The
 * path must name a face the manifest lists (never the licence, never a file
 * it does not list); the package must resolve and still pass its check; the
 * real path must stay inside the package's real directory.
 */
export function fontAsset(rel, home = configHome()) {
  const m = NAMESPACE.exec(String(rel ?? '').split('\\').join('/'));
  if (!m) return null;
  const segs = m[1].split('/');
  if (segs.length < 3) return null;
  const [marketplace, name, ...path] = segs;
  if (!NAME_RE.test(marketplace) || !NAME_RE.test(name)) return null;
  if (!path.every((s) => /^[\w.-]+$/.test(s) && !s.startsWith('.'))) return null;
  const relPath = path.join('/');
  const ext = /\.([A-Za-z0-9]+)$/.exec(relPath)?.[1]?.toLowerCase();
  if (!FACE_EXTENSIONS.includes(ext)) return null;
  const r = resolveFontRef({ name, marketplace, ref: `${name}@${marketplace}` }, home);
  if (!r.dir) return null;
  const verdict = fontVerdict(r.dir);
  if (!verdict.ok || !verdict.manifest.faces.some((f) => f.file === relPath)) return null;
  let real, root;
  try { real = realpathSync(join(r.dir, ...path)); root = realpathSync(r.dir); } catch { return null; }
  if (!real.startsWith(root + sep)) return null;
  try { if (!statSync(real).isFile()) return null; } catch { return null; }
  return { file: real, type: ext === 'woff2' ? 'font/woff2' : 'font/woff', headers: { 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' } };
}

/**
 * Reference (`on`) or drop a font in the deck's configuration block, editing
 * only its keys. The source rides in the shared `themeSources`, once per
 * marketplace, and goes only with the last reference of ANY kind. `use`
 * also makes it the deck's default (`"font"`); dropping the font the deck
 * defaults to drops the default too. Returns `{ html, changed }`.
 */
export function setFont(html, ref, on, { source = null, use = false } = {}) {
  const parsed = parseRef(ref);
  if (!parsed) throw new MarketplaceError(`"${ref}" is not a font reference — name@marketplace`);
  const block = configBlock(html);
  if (!block) {
    throw new MarketplaceError('the deck has no configuration block to record its fonts in'
      + ' — decklight upgrade --link <deck.html> gives it one');
  }
  if (block.error) throw new MarketplaceError(block.error);
  const current = fontRefs(html);
  const has = current.some((r) => r.ref === parsed.ref);
  const isDefault = block.config[FONT_DEFAULT_KEY] === parsed.name;
  if (on) {
    if (has && (!use || isDefault)) return { html, changed: false };
    const clash = current.find((r) => r.name === parsed.name && r.ref !== parsed.ref);
    if (clash) throw new MarketplaceError(`the deck already uses ${clash.ref} — two fonts called "${parsed.name}" cannot both be referenced`);
  } else if (!has) return { html, changed: false };
  const next = on ? [...new Set([...current.map((r) => r.ref), parsed.ref])] : current.map((r) => r.ref).filter((r) => r !== parsed.ref);
  const sources = markedSources(html);
  if (on && source) sources[parsed.marketplace] = source;
  const others = referencedMarketplaces(html, [MARKED_KEY, DESIGN_SYSTEMS_KEY]);
  for (const m of Object.keys(sources)) {
    if (!next.some((r) => r.endsWith(`@${m}`)) && !others.has(m)) delete sources[m];
  }
  let inner = withKey(block.inner, FONTS_KEY, next.length ? next : null);
  inner = withKey(inner, SOURCES_KEY, Object.keys(sources).length ? sources : null);
  if (on && use) inner = withKey(inner, FONT_DEFAULT_KEY, parsed.name);
  if (!on && isDefault) inner = withKey(inner, FONT_DEFAULT_KEY, null);
  return { html: html.slice(0, block.innerStart) + inner + html.slice(block.innerEnd), changed: true };
}

/**
 * Every font every registered marketplace offers, from the cache — what
 * `font list` and the font picker (authoring) show — with the faces a page
 * needs to PREVIEW one it does not reference yet (the author server answers
 * them under decklight-font/), and the marketplaces it could not list.
 */
export function marketplaceFonts(home = configHome()) {
  const fonts = [];
  const stale = [];
  const unfetched = [];
  for (const market of Object.keys(loadRegistry(home).marketplaces ?? {})) {
    const catalog = loadCatalog(market, home);
    if (!catalog) { unfetched.push(market); continue; }
    if (!catalog.ok) { stale.push(market); continue; }
    for (const entry of catalog.manifest.entries ?? []) {
      if (entry.type !== 'font') continue;
      const r = resolveFontRef({ name: entry.name, marketplace: market, ref: `${entry.name}@${market}` }, home);
      const verdict = r.dir ? fontVerdict(r.dir) : null;
      const missing = r.missing ?? (verdict && !verdict.ok ? verdict.why : null);
      fonts.push({
        name: entry.name, marketplace: market, qualified: `${entry.name}@${market}`,
        group: catalog.manifest.title?.trim() || market,
        description: entry.description ?? '', version: entry.version ?? null,
        ...(missing ? { missing } : {
          ...fontMeta(verdict, entry.name),
          faces: verdict.manifest.faces.map((f) => ({ url: fontHref(market, entry.name, f.file), weight: f.weight ?? 400, style: f.style ?? 'normal', format: f.file.endsWith('.woff2') ? 'woff2' : 'woff' })),
        }),
      });
    }
  }
  return { fonts, stale, unfetched };
}
