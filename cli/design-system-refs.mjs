// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck's design systems, as REFERENCES (SPEC DESIGN_SYSTEMS) — the second
// instance of what THEME_DISTRIBUTION built for themes:
//
//   "designSystems": ["acme@acme-mkt"],
//   "themeSources": { "acme-mkt": "acme/decklight-marketplace" }
//
// The deck records WHICH design system it uses; the package stays in its
// marketplace. Every server — author, present, and the render server behind
// shot/pdf/pptx/video — links it into the page from the checkouts on this
// machine (`linkDesignSystems`) and answers its files under
// `decklight-design-system/<marketplace>/<name>/…` (`designSystemAsset`).
// Nothing here fetches: a deck on a plane serves what this machine has and
// names what it has not (MARKETPLACE_REGISTRY — registered, not fetched).
//
// What differs from a marked theme, on purpose:
//   - the stylesheet is ALWAYS ON (no `media="not all"`): a design system is
//     not an alternative to choose between, so `T` leaves it applied;
//   - a package is a DIRECTORY of somebody else's files, so serving it is held
//     tighter than the deck root — plain segments, the asset allowlist, real
//     paths inside the package, fixed MIME, nosniff, a script-free SVG policy,
//     and one indistinguishable 404 for every refusal;
//   - the page also carries the package's meta (palette, layouts and slots)
//     and its layouts, inline in a <template>, so the engine expands them
//     synchronously, identically for a served deck and a bundled one;
//   - an https `source` has no cache to land in (the theme cache holds one
//     file; a package is many), so it resolves as missing.
//
// Every package is re-checked where it is used, not only when it was added —
// `marketplace update` can change its bytes afterwards — remembered by a
// stat signature so a page load re-reads nothing that has not changed.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { escapeHtml } from '../tools/escape.mjs';
import { DESIGN_SYSTEM_API_VERSION, ASSET_EXTENSIONS } from '../tools/design-system-format.mjs';
import { configBlock, isDeck } from './runtime-link.mjs';
import { configHome, loadRegistry, loadCatalog, MarketplaceError, NAME_RE } from './marketplace.mjs';
import {
  parseRef, resolveCatalogEntry, markedSources, withKey, DESIGN_SYSTEMS_KEY, SOURCES_KEY, MARKED_KEY,
} from './theme-refs.mjs';
import { resolveSource } from './theme.mjs';
import { checkDir } from './design-system.mjs';

export { DESIGN_SYSTEMS_KEY };

/** The design systems a deck references, parsed; anything else dropped, not guessed at. */
export function designSystemRefs(html) {
  const list = configBlock(html)?.config?.[DESIGN_SYSTEMS_KEY];
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.map((e) => parseRef(e)).filter((r) => r && !seen.has(r.ref) && seen.add(r.ref));
}

/**
 * Resolve a reference to its package directory on this machine — registry,
 * catalog cache and checkouts only — or `{ missing }` in words a presenter can
 * act on. Returns `{ name, marketplace, ref, local, title, entry, dir, source }`.
 */
export function resolveDesignSystemRef(ref, home = configHome(), { source = null } = {}) {
  const parsed = typeof ref === 'string' ? parseRef(ref) : ref;
  if (!parsed) return { ref: String(ref), missing: 'not a design-system reference (name@marketplace)' };
  const hit = resolveCatalogEntry(parsed, home, { source });
  if (hit.missing) return hit;
  const { local, title, entry, registered, origin } = hit;
  if (entry.type !== 'design-system') return { ...parsed, entry, missing: `"${parsed.ref}" is a ${entry.type}, not a design system` };
  if (Number.isInteger(entry.apiVersion) && entry.apiVersion > DESIGN_SYSTEM_API_VERSION) {
    return { ...parsed, entry, missing: `${parsed.ref} needs a newer decklight — it is written for design-system format ${entry.apiVersion}, this one reads up to ${DESIGN_SYSTEM_API_VERSION}` };
  }
  if (typeof entry.source !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(entry.source)) {
    return { ...parsed, entry, missing: `${parsed.ref} names a URL as its source — a design system is a directory of files in its marketplace, and there is no cache for one` };
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

/** A cheap fingerprint of a package's files — names, sizes and mtimes — so nothing unchanged is re-read. */
function signature(dir) {
  const parts = [];
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      if (name === '.git') continue;
      const full = join(abs, name);
      let st;
      try { st = statSync(full); } catch { parts.push(`${rel}${name}!`); continue; }
      if (st.isDirectory()) walk(full, `${rel}${name}/`);
      else parts.push(`${rel}${name}:${st.size}:${st.mtimeMs}`);
    }
  };
  walk(dir, '');
  return parts.join('|');
}

const verdicts = new Map();

/**
 * Does the package STILL pass `decklight design-system check`? It follows its
 * marketplace, so it is re-checked wherever it is used. `{ ok, why, summary,
 * manifest }`, remembered by its stat signature.
 */
export function packageVerdict(dir) {
  let sig;
  try { sig = signature(dir); } catch { return { ok: false, why: 'its files are gone' }; }
  const hit = verdicts.get(dir);
  if (hit && hit.sig === sig) return hit.value;
  const r = checkDir(dir);
  const value = r.ok
    ? { ok: true, summary: r.summary, manifest: r.manifest, layoutsHtml: r.layoutsHtml }
    : { ok: false, why: `it no longer passes the design-system check — ${r.problems[0].file}${r.problems[0].line ? ` line ${r.problems[0].line}` : ''}: ${r.problems[0].msg} (decklight design-system check)` };
  verdicts.set(dir, { sig, value });
  return value;
}

/** What the page is told about a package: the facts the engine and the palette read. */
export function designSystemMeta(verdict) {
  const m = verdict.manifest ?? {};
  return {
    name: m.name, version: m.version, title: m.title,
    palette: Array.isArray(m.palette) ? m.palette : [],
    layouts: (verdict.summary?.layouts ?? []).map(({ id, title, slots }) => ({ id, title, slots })),
  };
}

/** Where a server answers a package's files, relative to the deck. */
export const designSystemHref = (marketplace, name, path) => `decklight-design-system/${marketplace}/${name}/${path}`;

/** JSON safe inside a <script> — the manifest is somebody else's file. */
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * A deck's design systems, linked into the page on its way out — what every
 * server does after `linkAddedThemes`, never `bundle`. Per reference, after
 * the theme links and before `</head>`:
 *   <link rel="stylesheet" href="decklight-design-system/…/design-system.css" data-design-system="<name>">
 *   <script type="application/json" data-design-system-meta="<name>">{…}</script>
 *   <template data-design-system-layouts="<name>">…layouts.html…</template>
 * Nothing when the page already carries `<style data-design-system="<name>">`
 * (a bundle's own copy). An unresolvable reference, or a package that no
 * longer passes the check, becomes `<meta name="decklight-design-system-missing">`
 * naming it and why — never a silently short page.
 */
export function linkDesignSystems(html, home = configHome(), { log = null } = {}) {
  if (!isDeck(html)) return html;
  const refs = designSystemRefs(html);
  if (!refs.length) return html;
  const sources = markedSources(html);
  const tags = [];
  for (const ref of refs) {
    // a bundle's own copy (<style>), or a link this page already got
    const carried = new RegExp(`<(?:style|link)\\b[^>]*\\bdata-design-system\\s*=\\s*["']${ref.name}["']`, 'i');
    if (carried.test(html)) continue;
    const r = resolveDesignSystemRef(ref, home, { source: sources[ref.marketplace] ?? null });
    const verdict = r.dir ? packageVerdict(r.dir) : null;
    if (r.dir && !verdict.ok) r.missing = verdict.why;
    if (r.dir && verdict.ok) {
      const name = escapeHtml(ref.name);
      tags.push(`<link rel="stylesheet" href="${designSystemHref(r.local, r.name, verdict.manifest.styles)}" data-design-system="${name}">`);
      tags.push(`<script type="application/json" data-design-system-meta="${name}">${scriptJson(designSystemMeta(verdict))}</script>`);
      tags.push(`<template data-design-system-layouts="${name}">\n${verdict.layoutsHtml.trim()}\n</template>`);
    } else {
      tags.push(`<meta name="decklight-design-system-missing" content="${escapeHtml(`${ref.ref} — ${r.missing}`)}">`);
      log?.(`design system ${ref.ref}: ${r.missing}`);
    }
  }
  if (!tags.length) return html;
  const masked = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const headEnd = masked.search(/<\/head>/i);
  const at = headEnd !== -1 ? headEnd : Math.max(0, masked.search(/<body\b/i));
  return `${html.slice(0, at)}${tags.join('\n')}\n${html.slice(at)}`;
}

/** A design system's `url()`s — quoted or not — and the address each names. */
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;

/** Bytes as a `data:` URI: an SVG as percent-encoded UTF-8 (readable, smaller), anything else base64. */
function dataUri(ext, bytes) {
  if (ext === 'svg') {
    const text = encodeURIComponent(bytes.toString('utf8')).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `data:image/svg+xml;charset=utf-8,${text}`;
  }
  return `data:${(DS_MIME[ext] ?? 'application/octet-stream').split(';')[0]};base64,${bytes.toString('base64')}`;
}

/**
 * A design system's stylesheet with every RELATIVE `url()` inlined as a
 * `data:` URI, resolved against the stylesheet's own location — and nothing
 * else touched, byte for byte, so a font's licence header travels with its
 * face. `data:` and `#fragment` urls are left; an outside one (http(s), `//`)
 * is left and listed, because it will not show offline. A relative url whose
 * file is not in the package throws: half a design system is worse than none.
 * Returns `{ css, assets, bytes, external }`.
 */
export function inlineDesignSystemCss(css, dir, stylesPath) {
  const base = dirname(resolve(dir, stylesPath));
  const root = resolve(dir);
  const assets = new Set();
  let bytes = 0;
  const external = [];
  const out = css.replace(CSS_URL, (whole, dq, sq, bare) => {
    const url = (dq ?? sq ?? bare ?? '').trim();
    if (!url || url.startsWith('#') || /^data:/i.test(url)) return whole;
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) { external.push(url); return whole; }
    const rel = url.replace(/[?#].*$/, '');
    const file = resolve(base, rel);
    let data;
    try {
      if (!file.startsWith(root + sep)) throw new Error('outside');
      data = readFileSync(file);
    } catch {
      throw new MarketplaceError(`${stylesPath} names url(${url}), and the design system has no such file`);
    }
    assets.add(file);
    bytes += data.length;
    return `url("${dataUri(file.split('.').pop().toLowerCase(), data)}")`;
  });
  return { css: out, assets: assets.size, bytes, external: [...new Set(external)] };
}

/**
 * What a bundle carries for one resolved, still-valid design system: the
 * stylesheet INLINE (`<style data-design-system data-design-system-version>`
 * — the block every server's `linkDesignSystems` sees and links no second
 * copy of), then the meta `<script>` and the layouts `<template>` exactly as
 * the servers inject them, so the runtime finds them by the same selectors.
 * Returns `{ tags, assets, bytes, external, layouts }`.
 */
export function bundleDesignSystem(r, verdict) {
  const m = verdict.manifest;
  const inlined = inlineDesignSystemCss(readFileSync(join(r.dir, m.styles), 'utf8'), r.dir, m.styles);
  const name = escapeHtml(r.name);
  const safe = inlined.css.replace(/<\/(style)/gi, '<\\/$1');
  return {
    tags: [
      `<style data-design-system="${name}" data-design-system-version="${escapeHtml(String(m.version ?? ''))}">\n${safe}\n</style>`,
      `<script type="application/json" data-design-system-meta="${name}">${scriptJson(designSystemMeta(verdict))}</script>`,
      `<template data-design-system-layouts="${name}">\n${verdict.layoutsHtml.trim()}\n</template>`,
    ],
    assets: inlined.assets, bytes: inlined.bytes, external: inlined.external,
    layouts: verdict.summary?.layouts?.length ?? 0,
  };
}

/** The MIME a package file is answered as — fixed by extension, never sniffed. */
const DS_MIME = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  woff2: 'font/woff2', woff: 'font/woff', css: 'text/css; charset=utf-8',
};
const NAMESPACE = /(?:^|\/)decklight-design-system\/(.*)$/;

/** Is this request path in the design-system namespace at all? */
export const inDesignSystemNamespace = (rel) => NAMESPACE.test(String(rel ?? '').split('\\').join('/'));

/**
 * `staticFiles`' answer for a file of a referenced package — `{ file, type,
 * headers }`, or null, which the caller answers as a plain 404 whatever the
 * reason (a probe learns nothing). The path must be plain segments ending in
 * an allowlisted asset, or the package's own stylesheet; the package must
 * resolve and still pass its check; and the real path must stay inside the
 * package's real directory, so a symlink cannot reach out.
 */
export function designSystemAsset(rel, home = configHome()) {
  const m = NAMESPACE.exec(String(rel ?? '').split('\\').join('/'));
  if (!m) return null;
  const segs = m[1].split('/');
  if (segs.length < 3) return null;
  const [marketplace, name, ...path] = segs;
  if (!NAME_RE.test(marketplace) || !NAME_RE.test(name)) return null;
  const last = path[path.length - 1];
  if (!path.slice(0, -1).every((s) => /^[\w-]+$/.test(s))) return null;
  const ext = /^[\w-]+\.([A-Za-z0-9]+)$/.exec(last)?.[1]?.toLowerCase();
  if (!ext || !(ASSET_EXTENSIONS.includes(ext) || ext === 'css')) return null;
  const r = resolveDesignSystemRef({ name, marketplace, ref: `${name}@${marketplace}` }, home);
  if (!r.dir) return null;
  const verdict = packageVerdict(r.dir);
  if (!verdict.ok) return null;
  const relPath = path.join('/');
  // the one stylesheet is the package's own; any other .css is not served
  if (ext === 'css' && relPath !== verdict.manifest.styles) return null;
  let real, root;
  try { real = realpathSync(join(r.dir, ...path)); root = realpathSync(r.dir); } catch { return null; }
  if (!real.startsWith(root + sep)) return null;
  try { if (!statSync(real).isFile()) return null; } catch { return null; }
  const headers = { 'x-content-type-options': 'nosniff' };
  // an SVG is a document; one served same-origin to the deck must not script
  if (ext === 'svg') headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'";
  return { file: real, type: DS_MIME[ext], headers };
}

/**
 * Reference (`on`) or drop a design system in the deck's configuration
 * block, editing only its keys so the author's formatting survives. The
 * source rides alongside in the shared `themeSources`, once per marketplace,
 * and goes only with the last reference of EITHER kind. Returns `{ html,
 * changed }`, or throws a MarketplaceError a command prints as-is.
 */
export function setDesignSystem(html, ref, on, { source = null } = {}) {
  const parsed = parseRef(ref);
  if (!parsed) throw new MarketplaceError(`"${ref}" is not a design-system reference — name@marketplace`);
  const block = configBlock(html);
  if (!block) {
    throw new MarketplaceError('the deck has no configuration block to record its design systems in'
      + ' — decklight upgrade --link <deck.html> gives it one');
  }
  if (block.error) throw new MarketplaceError(block.error);
  const current = designSystemRefs(html);
  const has = current.some((r) => r.ref === parsed.ref);
  if (on) {
    if (has) return { html, changed: false };
    // a slide names a design system by its name (data-layout="acme/…"), so
    // two of the same name from different catalogs would be ambiguous
    const clash = current.find((r) => r.name === parsed.name);
    if (clash) throw new MarketplaceError(`the deck already uses ${clash.ref} — two design systems called "${parsed.name}" cannot both be referenced`);
  } else if (!has) return { html, changed: false };
  const next = on ? [...current.map((r) => r.ref), parsed.ref] : current.map((r) => r.ref).filter((r) => r !== parsed.ref);
  const sources = markedSources(html);
  if (on && source) sources[parsed.marketplace] = source;
  const themes = (Array.isArray(block.config[MARKED_KEY]) ? block.config[MARKED_KEY] : []).map((e) => parseRef(e)).filter(Boolean);
  for (const m of Object.keys(sources)) {
    if (!next.some((r) => r.endsWith(`@${m}`)) && !themes.some((t) => t.marketplace === m)) delete sources[m];
  }
  let inner = withKey(block.inner, DESIGN_SYSTEMS_KEY, next.length ? next : null);
  inner = withKey(inner, SOURCES_KEY, Object.keys(sources).length ? sources : null);
  return { html: html.slice(0, block.innerStart) + inner + html.slice(block.innerEnd), changed: true };
}

/**
 * Every design system every registered marketplace offers, from the cache —
 * what `design-system list` and the "Design systems…" palette show — and the
 * marketplaces it could not list, named so `marketplace update` can be said:
 * `unfetched`, registered but never fetched (the first-party one, on every
 * install that has not asked — nothing is fetched unasked), and `stale`, a
 * cached catalog that no longer reads. The two are told apart because "could
 * not be read" about a catalog nobody has fetched yet sounds like a fault.
 */
export function marketplaceDesignSystems(home = configHome()) {
  const systems = [];
  const stale = [];
  const unfetched = [];
  for (const market of Object.keys(loadRegistry(home).marketplaces ?? {})) {
    const catalog = loadCatalog(market, home);
    if (!catalog) { unfetched.push(market); continue; }
    if (!catalog.ok) { stale.push(market); continue; }
    for (const entry of catalog.manifest.entries ?? []) {
      if (entry.type !== 'design-system') continue;
      const r = resolveDesignSystemRef({ name: entry.name, marketplace: market, ref: `${entry.name}@${market}` }, home);
      systems.push({
        name: entry.name, marketplace: market, qualified: `${entry.name}@${market}`,
        group: catalog.manifest.title?.trim() || market,
        description: entry.description ?? '', version: entry.version ?? null,
        ...(r.missing ? { missing: r.missing } : {}),
      });
    }
  }
  return { systems, stale, unfetched };
}
