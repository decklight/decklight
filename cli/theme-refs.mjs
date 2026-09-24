// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck's added themes, as REFERENCES (SPEC THEME_DISTRIBUTION).
//
// A source deck is data (DECK_ANATOMY): slides and one configuration block.
// A theme from a marketplace used to break that — `theme add` pasted the whole
// stylesheet into the deck as a <style data-theme-added> block, kilobytes of
// somebody else's CSS in the file an author diffs and reviews. Now the deck
// records WHICH theme it uses, and nothing else:
//
//   { "theme": "acme", "addedThemes": ["acme@acme-themes"] }
//
// A theme in that list is MARKED: it travels with the deck. The servers link it
// from the marketplace already on this machine, `present` lists it, and
// `bundle` inlines it at hand-over, where the reference would mean nothing to
// whoever opens the file. A theme that is not marked is still listed while
// authoring (every registered marketplace's themes are), and can be looked at
// and applied — it simply does not go anywhere the deck goes.
//
// Everything here reads the catalog CACHE and the checkouts `marketplace
// add`/`update` left on disk. Nothing fetches: a deck on a plane links what
// this machine has and names what it has not (MARKETPLACES — registered, not
// fetched). The one exception is a catalog entry whose `source` is an https
// URL rather than a file in its repo: its bytes arrive when it is marked, or
// looked at while authoring, and are kept in `theme-cache/` from then on —
// see `themeCachePath`.

import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml } from '../tools/escape.mjs';
import { writeFileAtomic } from '../tools/atomic-write.mjs';
import { THEMES_DIR } from './pkg.mjs';
import { validateTheme } from '../tools/theme-check.mjs';
import { configBlock, isDeck } from './runtime-link.mjs';
import {
  configHome, loadRegistry, saveRegistry, loadCatalog, writeCache, validateManifest,
  classifySource, MarketplaceError, NAME_RE,
} from './marketplace.mjs';
import { resolveSource } from './theme.mjs';

/** The config key a deck lists its marked themes under. */
export const MARKED_KEY = 'addedThemes';

/** The config key a deck records where each of its marketplaces comes from. */
export const SOURCES_KEY = 'themeSources';

/** The personal marketplace `theme add <file|url>` copies into. */
export const LOCAL_MARKETPLACE = 'local';

/** `acme@acme-themes` → `{ name, marketplace }`, or null for anything else. */
export function parseRef(ref) {
  const m = /^([^@\s]+)@([^@\s]+)$/.exec(String(ref ?? ''));
  if (!m || !NAME_RE.test(m[1]) || !NAME_RE.test(m[2])) return null;
  return { name: m[1], marketplace: m[2], ref: `${m[1]}@${m[2]}` };
}

/** The deck's marked references, parsed — malformed entries are dropped, not guessed at. */
export function markedRefs(html) {
  const list = configBlock(html)?.config?.[MARKED_KEY];
  return Array.isArray(list) ? list.map(parseRef).filter(Boolean) : [];
}

/**
 * A marketplace's source as a deck records it — the form `marketplace add`
 * takes, so it is also the command that brings it — or null when there is
 * nothing portable to record.
 *
 * The name a marketplace is registered under is this machine's (`--name`
 * renames it), so it cannot say which catalog a deck means: the same catalog
 * can be `acme` here and `acme-themes` there, and two different catalogs can
 * share a name. The source can. A LOCAL marketplace has none worth writing: its
 * source is a path on the author's disk, meaningless anywhere else and a
 * disclosure of their home directory — the personal one included. Credentials
 * a URL carries (`https://user:token@host/…`) are removed before anything is
 * written; a deck is a file that gets sent to people.
 */
export function portableSource(source) {
  if (typeof source !== 'string' || !source) return null;
  const bare = source.replace(/^(https?:\/\/|ssh:\/\/|git:\/\/)[^/@]*@/i, '$1');
  const src = classifySource(bare, { exists: () => false });
  if (src.kind === 'github') return `${src.owner}/${src.repo}`;
  if (src.kind === 'git' && !/^file:\/\//i.test(bare)) return bare.replace(/\.git\/?$/, '').replace(/\/$/, '');
  return null;
}

/** The deck's recorded sources, by the marketplace name its references use. */
export function markedSources(html) {
  const map = configBlock(html)?.config?.[SOURCES_KEY];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  return Object.fromEntries(Object.entries(map).filter(([k, v]) => NAME_RE.test(k) && typeof v === 'string' && v));
}

/** The theme names shipped with this install. */
export const shippedThemes = () =>
  readdirSync(THEMES_DIR).filter((f) => f.endsWith('.css')).map((f) => f.slice(0, -4));

/**
 * Where an https-sourced entry's bytes are kept once read.
 *
 * Every other entry is a file in a checkout, which is already on disk; this is
 * the one kind that is not. Keeping it is what lets every server link it with
 * no network — a marked theme must look the same on a plane as it did at the
 * desk. Filled only by an explicit act (marking it, or looking at it while
 * authoring), never by serving a deck.
 */
export const themeCachePath = (home, marketplace, name) => join(home, 'theme-cache', marketplace, `${name}.css`);

/** Keep an https-sourced entry's bytes for later offline serving. */
export function cacheThemeCss(home, marketplace, name, css) {
  mkdirSync(join(home, 'theme-cache', marketplace), { recursive: true });
  writeFileAtomic(themeCachePath(home, marketplace, name), css);
}

/**
 * Resolve a reference to the file on disk that holds its CSS, reading only
 * the registry, the catalog cache, the checkouts and the theme cache.
 *
 * Returns `{ name, marketplace, ref, title, entry, file }`, or
 * `{ ...parsed, missing }` with `missing` saying, in words a presenter can act
 * on, why this machine cannot show it. `remote` is set on an https-sourced
 * entry that has not been read yet — the caller that is allowed to fetch
 * (an explicit mark, an author looking at it) knows to.
 */
export function resolveThemeRef(ref, home = configHome(), { source = null } = {}) {
  const parsed = typeof ref === 'string' ? parseRef(ref) : ref;
  if (!parsed) return { ref: String(ref), missing: 'not a theme reference (name@marketplace)' };
  const { name } = parsed;
  // Which marketplace HERE the reference means. With a recorded source, the
  // source decides: whatever this machine calls that catalog is the one, and
  // a marketplace that merely shares the name is not it.
  const registry = loadRegistry(home).marketplaces ?? {};
  let marketplace = parsed.marketplace;
  if (source) {
    const same = Object.entries(registry).find(([, m]) => portableSource(m.source) === source)?.[0];
    if (same) marketplace = same;
    else if (registry[marketplace]) {
      return { ...parsed, missing: `"${marketplace}" here is a different catalog (${portableSource(registry[marketplace].source) ?? 'a local one'}) — the deck's comes from ${source}` };
    } else {
      return { ...parsed, missing: `its marketplace is not registered on this machine — decklight marketplace add ${source}` };
    }
  }
  const registered = registry[marketplace];
  if (!registered) {
    return { ...parsed, missing: `marketplace "${marketplace}" is not registered on this machine`
      + ' — it was local to whoever marked it, or never recorded where it came from' };
  }
  const local = marketplace;
  const catalog = loadCatalog(marketplace, home);
  if (!catalog?.ok) {
    return { ...parsed, missing: `marketplace "${marketplace}" has never been fetched — decklight marketplace update ${marketplace}` };
  }
  const entry = (catalog.manifest.entries ?? []).find((e) => e.name === name);
  if (!entry) return { ...parsed, missing: `"${name}" is not in ${marketplace} any more` };
  const origin = portableSource(registered.source);
  if (entry.type !== 'theme') return { ...parsed, entry, missing: `"${parsed.ref}" is a ${entry.type}, not a theme` };
  const title = catalog.manifest.title?.trim() || null;
  if (/^https?:\/\//i.test(entry.source)) {
    const cached = themeCachePath(home, marketplace, name);
    if (existsSync(cached)) return { ...parsed, local, title, entry, file: cached, source: origin };
    return { ...parsed, local, title, entry, remote: entry.source, missing: `${parsed.ref} lives at ${entry.source} and has not been read on this machine` };
  }
  let file;
  try { file = resolveSource(entry.source, { name: marketplace, source: registered.source }, home); }
  catch (e) {
    if (e instanceof MarketplaceError) return { ...parsed, title, entry, missing: e.message.replace(/\n\s*/g, ' — ') };
    throw e;
  }
  if (!existsSync(file)) return { ...parsed, title, entry, missing: `${parsed.ref}: ${entry.source} is not in the marketplace's files` };
  return { ...parsed, local, title, entry, file, source: origin };
}

/**
 * Does the file a marked theme resolves to STILL pass the THEMING contract?
 *
 * A marked theme follows its marketplace: `marketplace update` can change its
 * bytes after it was marked and checked. A deck must never be made to show —
 * or a bundle to carry — what the shipped set could not contain, so the
 * contract is re-run wherever the file is used, not only when it was marked.
 * Remembered by path, mtime and size, so a page load re-reads nothing that
 * has not changed.
 */
const verdicts = new Map();
export function stillValid(file) {
  let st;
  try { st = statSync(file); } catch { return { ok: false, why: 'its file is gone' }; }
  const hit = verdicts.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  const r = validateTheme(readFileSync(file, 'utf8'));
  const value = r.ok ? { ok: true } : { ok: false, why: `it no longer passes the theme contract — ${r.errors[0] ?? 'see decklight theme check'}` };
  verdicts.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

/**
 * Every theme every registered marketplace offers, from the cache — what the
 * overlay lists while authoring — and the marketplaces it could not read.
 *
 * A marketplace that is registered but never fetched is the FIRST-RUN state
 * (the first-party one is deliberately in it), so it is reported, by name, as
 * something `marketplace update` fixes rather than as an empty list that looks
 * like an empty marketplace.
 */
export function marketplaceThemes(home = configHome()) {
  const themes = [];
  const stale = [];
  for (const market of Object.keys(loadRegistry(home).marketplaces ?? {})) {
    const catalog = loadCatalog(market, home);
    if (!catalog?.ok) { stale.push(market); continue; }
    let readable = 0;
    for (const entry of catalog.manifest.entries ?? []) {
      if (entry.type !== 'theme') continue;
      const r = resolveThemeRef({ name: entry.name, marketplace: market, ref: `${entry.name}@${market}` }, home);
      // An entry whose files are not here — a remote marketplace never cloned —
      // would only be a row that fails. An https entry not read yet is fine:
      // looking at it is the explicit act that reads it.
      if (r.missing && !r.remote) continue;
      readable++;
      themes.push({
        name: entry.name, marketplace: market, qualified: r.ref,
        title: r.title, description: entry.description ?? '',
      });
    }
    if (!readable && (catalog.manifest.entries ?? []).some((e) => e.type === 'theme')) stale.push(market);
  }
  return { themes, stale };
}

/** Where a server answers a reference's CSS, relative to the deck. */
export const themeRefHref = (marketplace, name) => `decklight-theme/${marketplace}/${name}.css`;

const REF_ASSET = /(?:^|\/)decklight-theme\/([\w-]+)\/([\w-]+)\.css$/;

/**
 * `staticFiles`' answer for a reference's CSS — `{ file, type }`, or null.
 * Matched on the path's tail like `packageAsset`, so a deck in `slides/`
 * resolves too. Cache and checkout only: this is on every server's path,
 * `present` included, and it never fetches.
 */
export function themeRefAsset(rel, home = configHome()) {
  const m = REF_ASSET.exec(String(rel ?? '').split('\\').join('/'));
  if (!m) return null;
  const r = resolveThemeRef({ name: m[2], marketplace: m[1], ref: `${m[2]}@${m[1]}` }, home);
  return r.file && stillValid(r.file).ok ? { file: r.file, type: 'text/css; charset=utf-8' } : null;
}

/**
 * The element a resolved reference is linked as. The same attributes an
 * inline added block has always carried, so the runtime lists, groups and
 * applies it by the code it already had: `data-theme-added` keeps it apart
 * from the deck's own themes, `media="not all"` keeps it off until chosen,
 * and provenance names its marketplace heading. Both provenance values come
 * from a manifest somebody else wrote and land in double-quoted attributes —
 * escaped, never trusted.
 */
export function addedThemeLink({ name, marketplace, local = marketplace, title }) {
  // `href` is where THIS server answers it (the catalog's name here); the
  // marketplace attribute is the deck's own name for it, which is what the
  // picker groups by and what a mark toggle writes back
  const label = title ? ` data-theme-source="${escapeHtml(title)}"` : '';
  return `<link rel="stylesheet" href="${themeRefHref(local, name)}" data-theme="${escapeHtml(name)}"`
    + ` data-theme-added data-theme-marketplace="${escapeHtml(marketplace)}"${label} media="not all">`;
}

/**
 * A marked theme as a bundle carries it: the same attributes as its link, so
 * the picker in a file opened on a machine with no registry still draws the
 * marketplace heading — provenance travels in the file or not at all. A
 * `</style` inside the CSS would end the block early; it is somebody else's
 * file, which is exactly when to check.
 */
export function addedThemeStyle({ name, marketplace, title }, css, { active = false } = {}) {
  const label = title ? ` data-theme-source="${escapeHtml(title)}"` : '';
  const safe = css.replace(/<\/(style)/gi, '<\\/$1');
  return `<style data-theme="${escapeHtml(name)}" data-theme-added data-theme-marketplace="${escapeHtml(marketplace)}"`
    + `${label}${active ? '' : ' media="not all"'}>\n${safe.trim()}\n</style>`;
}

/**
 * The marked themes of a deck, linked into the page on its way out — what
 * every server does after `linkRuntime`, never `bundle` (a hand-over carries
 * the CSS itself, not a link to this machine's marketplaces).
 *
 * A reference this machine cannot resolve is not linked; the page carries a
 * `<meta name="decklight-theme-missing">` instead, so the runtime can say which
 * theme is absent and what brings it, rather than a list that is silently
 * short by one. A theme the deck already carries a block for — a bundle's
 * inlined copy — is left to that block.
 */
export function linkAddedThemes(html, home = configHome(), { log = null } = {}) {
  if (!isDeck(html)) return html;
  const refs = markedRefs(html);
  if (!refs.length) return html;
  const sources = markedSources(html);
  const tags = [];
  for (const ref of refs) {
    const carried = new RegExp(`<(?:style|link)\\b[^>]*\\bdata-theme\\s*=\\s*["']${ref.name}["']`, 'i');
    if (carried.test(html)) continue;
    const r = resolveThemeRef(ref, home, { source: sources[ref.marketplace] ?? null });
    const valid = r.file ? stillValid(r.file) : null;
    if (r.file && !valid.ok) r.missing = valid.why;
    if (r.file && valid.ok) tags.push(addedThemeLink(r));
    else {
      tags.push(`<meta name="decklight-theme-missing" content="${escapeHtml(`${ref.ref} — ${r.missing}`)}">`);
      log?.(`theme ${ref.ref}: ${r.missing}`);
    }
  }
  if (!tags.length) return html;
  const masked = html.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  const headEnd = masked.search(/<\/head>/i);
  const at = headEnd !== -1 ? headEnd : Math.max(0, masked.search(/<body\b/i));
  return `${html.slice(0, at)}${tags.join('\n')}\n${html.slice(at)}`;
}

/**
 * Mark (`on`) or unmark a reference in the deck's configuration block, editing
 * only the `addedThemes` value so the author's own formatting of the rest
 * survives. Returns `{ html, changed }`, or throws a MarketplaceError a
 * command prints as-is.
 *
 * The rules are the ones the overlay needs to stay unambiguous: a marked name
 * is never a shipped theme's (the picker would show two `aurora`s and apply
 * whichever it met first), never another marketplace's theme of the same name,
 * and the theme the deck OPENS on cannot be unmarked out from under it.
 */
export function setMarked(html, ref, on, { source = null } = {}) {
  const parsed = parseRef(ref);
  if (!parsed) throw new MarketplaceError(`"${ref}" is not a theme reference — name@marketplace`);
  const block = configBlock(html);
  if (!block) {
    throw new MarketplaceError('the deck has no configuration block to record its themes in'
      + ' — decklight upgrade --link <deck.html> gives it one');
  }
  if (block.error) throw new MarketplaceError(block.error);
  const current = markedRefs(html);
  const has = current.some((r) => r.ref === parsed.ref);
  if (on) {
    if (has) return { html, changed: false };
    if (shippedThemes().includes(parsed.name)) {
      throw new MarketplaceError(`"${parsed.name}" is the name of a theme decklight ships — ${parsed.ref} cannot sit beside it`);
    }
    const clash = current.find((r) => r.name === parsed.name);
    if (clash) throw new MarketplaceError(`the deck already marks ${clash.ref} — two themes called "${parsed.name}" cannot both be listed`);
  } else {
    if (!has) return { html, changed: false };
    if (block.config.theme === parsed.name) {
      throw new MarketplaceError(`${parsed.ref} is the theme the deck opens on — set another "theme" first`);
    }
  }
  const next = on ? [...current.map((r) => r.ref), parsed.ref] : current.map((r) => r.ref).filter((r) => r !== parsed.ref);
  // Where each marketplace comes from rides alongside, once per marketplace:
  // written when its first theme is marked, gone with its last. A theme from a
  // marketplace with nothing portable to record (a local one) records nothing.
  const sources = markedSources(html);
  if (on && source) sources[parsed.marketplace] = source;
  for (const m of Object.keys(sources)) {
    if (!next.some((r) => r.endsWith(`@${m}`))) delete sources[m];
  }
  let inner = withKey(block.inner, MARKED_KEY, next.length ? next : null);
  inner = withKey(inner, SOURCES_KEY, Object.keys(sources).length ? sources : null);
  return { html: html.slice(0, block.innerStart) + inner + html.slice(block.innerEnd), changed: true };
}

// The block's text with `key` set to `value` (an array of refs, or a flat map
// of names to sources) — the value swapped, the key appended last, or the key
// removed when `value` is null. Both are flat, so a bracket match finds the
// whole value; their strings are refs and sources, JSON-escaped, and a
// `</script` cannot survive `portableSource` or a ref's shape to reach here.
function withKey(inner, key, value) {
  const json = value === null ? null
    : Array.isArray(value) ? `[${value.map((r) => JSON.stringify(r)).join(', ')}]`
      : `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v).replace(/<\//g, '<\\/')}`).join(', ')} }`;
  const val = '(?:\\[[^\\]]*\\]|\\{[^{}]*\\})';
  const keyRe = new RegExp(`"${key}"\\s*:\\s*${val}`);
  if (keyRe.test(inner)) {
    if (json !== null) return inner.replace(keyRe, () => `"${key}": ${json}`);
    const withComma = new RegExp(`\\s*,\\s*"${key}"\\s*:\\s*${val}|"${key}"\\s*:\\s*${val}\\s*,?\\s*`);
    return inner.replace(withComma, '');
  }
  if (json === null) return inner;
  const close = inner.lastIndexOf('}');
  const before = inner.slice(0, close);
  const empty = /\{\s*$/.test(before);
  const trailing = before.match(/\s*$/)[0];
  // a pretty-printed block gets the new key on a line of its own, at the
  // indent its first key has; a one-line block stays on one line
  const indent = /\{[ \t]*\n([ \t]*)"/.exec(before)?.[1];
  const sep = empty ? ' ' : indent !== undefined ? `,\n${indent}` : ', ';
  return `${before.slice(0, before.length - trailing.length)}${sep}"${key}": ${json}${trailing || (empty ? ' ' : '')}${inner.slice(close)}`;
}

/**
 * The reference a deck should record for `name` from the marketplace called
 * `local` here. A deck that already records that marketplace's source under
 * its own name keeps its name — the same catalog is one entry in the deck,
 * whatever each machine that marks from it happens to call it.
 */
export function refForDeck(html, name, local, source) {
  const known = source ? Object.entries(markedSources(html)).find(([, v]) => v === source)?.[0] : null;
  return `${name}@${known ?? local}`;
}

/**
 * Copy a theme that came from a file or a URL into the personal marketplace,
 * so it can be referenced like any other: `house@local`.
 *
 * The personal marketplace is an ordinary LOCAL marketplace, registered the
 * first time it is needed: a directory with `.decklight/marketplace.json` and
 * the themes beside it. It lives at `~/.decklight/local/`, deliberately NOT
 * under `marketplaces/` — that is where `marketplace remove` deletes clones
 * from, and removing the registration must never take somebody's themes with
 * it. Re-adding a name replaces its file (there is no auto-update; re-adding
 * IS the update).
 */
export function addToLocalMarketplace(css, name, from, home = configHome()) {
  if (!NAME_RE.test(name)) throw new MarketplaceError(`"${name}" is not a usable theme name — letters, digits, - and _`);
  const dir = join(home, LOCAL_MARKETPLACE);
  const reg = loadRegistry(home);
  const existing = reg.marketplaces?.[LOCAL_MARKETPLACE];
  if (existing && existing.source !== dir) {
    throw new MarketplaceError(`a marketplace called "${LOCAL_MARKETPLACE}" is already registered from ${existing.source}`
      + ` — the personal marketplace needs that name (decklight marketplace remove ${LOCAL_MARKETPLACE})`);
  }
  const manifestPath = join(dir, '.decklight', 'marketplace.json');
  let manifest = { name: LOCAL_MARKETPLACE, title: 'Local', entries: [] };
  if (existsSync(manifestPath)) {
    const v = validateManifest(readFileSync(manifestPath, 'utf8'));
    if (!v.ok) throw new MarketplaceError(`${manifestPath} does not validate — fix or delete it`);
    manifest = v.manifest;
  }
  mkdirSync(join(dir, 'themes'), { recursive: true });
  mkdirSync(join(dir, '.decklight'), { recursive: true });
  writeFileAtomic(join(dir, 'themes', `${name}.css`), css);
  const entry = { name, type: 'theme', source: `themes/${name}.css`, description: `added from ${from}` };
  const at = manifest.entries.findIndex((e) => e.name === name);
  const replaced = at !== -1;
  if (replaced) manifest.entries[at] = entry; else manifest.entries.push(entry);
  const raw = JSON.stringify(manifest, null, 2) + '\n';
  writeFileAtomic(manifestPath, raw);
  if (!existing) {
    reg.marketplaces = { ...(reg.marketplaces ?? {}), [LOCAL_MARKETPLACE]: { source: dir } };
    saveRegistry(reg, home);
  }
  writeCache(home, LOCAL_MARKETPLACE, raw);
  return { ref: `${name}@${LOCAL_MARKETPLACE}`, replaced, registered: !existing, file: join(dir, 'themes', `${name}.css`) };
}
