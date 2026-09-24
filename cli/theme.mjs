#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight theme — validate themes that came from somewhere else, and mark
// which of them a deck travels with.
//
//   decklight theme check  <file|url>
//   decklight theme add    <name@marketplace|file|url> <deck.html> [--name x] [--dry-run]
//   decklight theme remove <name|name@marketplace> <deck.html>
//
// A theme is ONE portable CSS file, and compatibility with a runtime IS
// passing that runtime's check: there is no registry of themes and no version
// number. When the contract grows a token, `check` names exactly what an older
// theme is missing.
//
// `add` never puts CSS in the deck (SPEC THEME_DISTRIBUTION). It MARKS a theme:
// the deck's configuration block gains a reference, `"addedThemes":
// ["acme@acme-themes"]`, the servers link it from the marketplace on this
// machine, and `bundle` inlines it at hand-over. A file or a URL has no
// marketplace to be referenced in, so it is copied into the personal one —
// `~/.decklight/local/` — and referenced there: `house@local`.

import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../tools/atomic-write.mjs';
import path, { resolve } from 'node:path';
import { argReader, isMain } from '../tools/args.mjs';
import { validateTheme, themeNameFrom, validThemeName, REQUIRED } from '../tools/theme-check.mjs';
import { checkoutPath, classifySource, configHome, MarketplaceError, loadRegistry, loadCatalog, resolveEntry } from './marketplace.mjs';
import { setMarked, addToLocalMarketplace, resolveThemeRef, cacheThemeCss, markedRefs, parseRef, refForDeck } from './theme-refs.mjs';

const USAGE = `usage: decklight theme <check|add|remove> …

  decklight theme check <file|url>
    run the SPEC THEMING token contract and the WCAG contrast gates on a theme file
    EXAMPLE: decklight theme check nord-deep.css

  decklight theme add <name@marketplace|file|url> <deck.html> [--name <name>] [--dry-run]
    validate a theme, then MARK it for the deck: its configuration block gains
    a reference ("addedThemes"), never the CSS. A marked theme is listed by T
    under its marketplace, reachable by , / . and ?theme=, and inlined by
    decklight bundle. A file or url is first copied into your personal
    marketplace (~/.decklight/local) and marked as <name>@local
    EXAMPLE: decklight theme add nord-deep@acme-themes talk.html
    EXAMPLE: decklight theme add https://gist.../nord-deep.css talk.html

    --name <name>  a file or url's name in the personal marketplace [its file name]
    --dry-run      validate and report; touch nothing

  decklight theme remove <name|name@marketplace> <deck.html>
    unmark it — the deck stops listing and carrying it; the theme itself stays
    in its marketplace

  a theme that does not pass is not marked — a deck cannot be made to carry
  something the shipped set would not be allowed to contain`;

/**
 * Where a catalog entry's `source` actually lives.
 *
 * A manifest says `./themes/nord-deep.css`, which is relative to the
 * MARKETPLACE — and by the time the catalog is a cached JSON file, the repo it
 * came from is not the cwd of whoever is installing. So a relative entry
 * resolves against what `marketplace add`/`update` left on disk for that
 * marketplace: the CHECKOUT it cloned (MARKETPLACES#CLONE), or, for a local
 * marketplace, the directory it was registered from.
 *
 * It used to build a `raw.githubusercontent.com` URL instead, and that was the
 * private-marketplace bug in one line: the manifest could be read with the
 * caller's git credentials while every entry's bytes were fetched with none,
 * so a private catalog listed correctly and then 404'd on every install. It
 * also read a moving ref — the manifest at one HEAD, each artifact at another
 * — so an install could match no single commit of the marketplace. Resolving
 * into the checkout closes both: same commit, same credentials, no network.
 *
 * An ABSOLUTE `https://` source is still fetched as written: an entry may
 * legitimately point at a gist or a release asset outside its own repo.
 *
 * This lives in theme.mjs rather than in the author server on purpose. Reading
 * an ARTIFACT on an explicit install is fine anywhere; fetching a CATALOG is
 * what `registered, not fetched` forbids on a deck-serving path, and keeping the
 * two in different files is what keeps the sweep in test/marketplace.test.mjs
 * able to tell them apart.
 *
 * @param {string} source        the entry's `source`, as the manifest wrote it
 * @param {{name?: string, source?: string}} marketplace  registry name + registered source
 */
export function resolveSource(source, marketplace, home = configHome()) {
  if (/^https?:\/\//i.test(source)) return source;                 // absolute already
  const rel = source.replace(/^\.\//, '');
  const { name, source: from } = marketplace ?? {};
  if (name) {
    const checkout = checkoutPath(home, name);
    if (existsSync(checkout)) return path.join(checkout, rel);
  }
  if (!from) return source;                                        // nothing to resolve against
  if (classifySource(from).kind === 'local') return path.resolve(from, rel);
  // Registered from a remote source with nothing cloned: the entry is real and
  // its bytes are simply not here yet. Naming the one command that fixes it
  // beats a fetch that would only work for a public repo (SPEC MARKETPLACE_REGISTRY).
  throw new MarketplaceError(`${name ?? from} has no local checkout, so "${source}" cannot be read`
    + `\n  its files arrive with the marketplace itself: decklight marketplace update ${name ?? ''}`.trimEnd());
}

/** Read a theme from disk or over https. */
export async function fetchTheme(source, { fetchImpl = fetch, read = readFileSync } = {}) {
  if (/^https?:\/\//i.test(source)) {
    const r = await fetchImpl(source);
    if (!r.ok) throw new Error(`${source} — HTTP ${r.status}`);
    return await r.text();
  }
  const p = resolve(source);
  if (!existsSync(p)) throw new Error(`no such file: ${source}`);
  return read(p, 'utf8');
}

/** The validation report, as the lines to print. */
export function reportLines(name, result) {
  const out = [];
  if (result.ok) {
    out.push(`✔ ${name} — all ${REQUIRED.length} tokens present, contrast gates pass`);
    const ex = Object.entries(result.exceptions ?? {});
    for (const [rule, why] of ex) out.push(`  ○ ${rule} waived — ${why}`);
    return out;
  }
  out.push(`✘ ${name}`);
  for (const e of result.errors) out.push(`    ${e}`);
  if (result.missing.length && !result.empty) {
    out.push(`  ${result.missing.length} of ${REQUIRED.length} tokens missing`
      + ' — a theme written against an older contract needs the new ones added (SPEC THEMING)');
  }
  return out;
}

async function checkMain(args) {
  const [source] = args.filter((a) => !a.startsWith('-'));
  if (!source) { console.error(`decklight theme check: needs a theme file or url\n\n${USAGE}`); return 1; }
  let css;
  try { css = await fetchTheme(source); } catch (e) { console.error(`decklight theme check: ${e.message}`); return 1; }
  const name = themeNameFrom(source) || 'theme';
  const result = validateTheme(css);
  for (const line of reportLines(name, result)) console.log(line);
  return result.ok ? 0 : 1;
}

async function addMain(args) {
  const { opt } = argReader(args);
  const positional = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--name');
  const [source, deck] = positional;
  if (!source || !deck) { console.error(`decklight theme add: needs a theme and a deck\n\n${USAGE}`); return 1; }

  const deckPath = resolve(deck);
  if (!existsSync(deckPath)) { console.error(`decklight theme add: no such deck: ${deck}`); return 1; }
  const home = configHome();
  const fail = (msg) => { console.error(`decklight theme add: ${msg}`); return 1; };

  // A marketplace ref (`confluent@decklight-confluent`, or a bare entry name
  // one marketplace alone has) is marked where it is; a file or a URL has no
  // marketplace to be referenced in, so it is copied into the personal one.
  const isFile = /^https?:\/\//i.test(source) || existsSync(resolve(source));
  let name, css, ref, label, remote = null, origin = null;
  if (!isFile) {
    const reg = loadRegistry();
    const catalogs = {};
    for (const mkt of Object.keys(reg.marketplaces ?? {})) {
      const c = loadCatalog(mkt);
      if (c?.ok) catalogs[mkt] = c.manifest;
    }
    let hit;
    try { hit = resolveEntry(source, catalogs); } catch (e) { return fail(e.message); }
    if (hit.entry.type !== 'theme') return fail(`${hit.qualified} is a ${hit.entry.type}, not a theme`);
    if (opt('--name')) return fail('--name names a file or url; a marketplace theme is marked under its own name');
    const r = resolveThemeRef(hit.qualified, home);
    if (r.file) css = readFileSync(r.file, 'utf8');
    else if (r.remote) {
      // An entry whose bytes live at a URL outside its repo: read once, now,
      // on this explicit act, and kept — every server after this links the
      // kept copy and never the URL.
      try { css = await fetchTheme(r.remote); } catch (e) { return fail(e.message); }
      remote = r;
    } else return fail(r.missing);
    name = hit.entry.name;
    ref = hit.qualified;
    origin = r.source ?? null;
    label = catalogs[hit.marketplace]?.title?.trim() || hit.marketplace;
  } else {
    name = opt('--name') ?? themeNameFrom(source);
    if (!validThemeName(name)) {
      console.error(`decklight theme add: "${name}" is not a usable theme name`);
      console.error('  the runtime only resolves names matching [A-Za-z0-9_-]+ — pass --name to choose one');
      return 1;
    }
    try { css = await fetchTheme(source); } catch (e) { return fail(e.message); }
    ref = `${name}@local`;
    label = 'Local';
  }

  const result = validateTheme(css);
  for (const line of reportLines(name, result)) console.log(line);
  if (!result.ok) {
    console.error(`\ndecklight theme add: ${name} was NOT marked — fix the report above and try again`);
    return 1;
  }

  // Settled BEFORE anything is written: a name that clashes must not leave a
  // copy in the personal marketplace behind a refusal.
  const html = readFileSync(deckPath, 'utf8');
  if (!isFile) ref = refForDeck(html, name, ref.split("@")[1], origin);
  let next;
  try { next = setMarked(html, ref, true, { source: origin }); }
  catch (e) {
    if (!(e instanceof MarketplaceError)) throw e;
    return fail(e.message + (isFile ? ' — pass --name to choose another' : ''));
  }
  if (args.includes('--dry-run')) {
    console.log(`would ${isFile ? `copy ${source} into your personal marketplace and ` : ''}`
      + `${next.changed ? 'mark' : 'keep'} ${ref} in ${deck}`);
    return 0;
  }
  if (isFile) {
    let out;
    try { out = addToLocalMarketplace(css, name, source, home); }
    catch (e) { if (e instanceof MarketplaceError) return fail(e.message); throw e; }
    if (out.registered) console.log(`registered your personal marketplace "local" — ${out.file.replace(/[\\/]themes[\\/][^\\/]+$/, '')}`);
    console.log(`${out.replaced ? 'replaced' : 'copied'} ${name} → ${out.file}`);
  } else if (remote) {
    cacheThemeCss(home, remote.marketplace, name, css);
  }
  if (next.changed) writeFileAtomic(deckPath, next.html);
  console.log(next.changed
    ? `marked ${ref} in ${deck} — press T and look under "${label}"; decklight bundle carries it`
    : `${ref} is already marked in ${deck}`);
  return 0;
}

function removeMain(args) {
  const [what, deck] = args.filter((a) => !a.startsWith('-'));
  if (!what || !deck) { console.error(`decklight theme remove: needs a theme and a deck\n\n${USAGE}`); return 1; }
  const deckPath = resolve(deck);
  if (!existsSync(deckPath)) { console.error(`decklight theme remove: no such deck: ${deck}`); return 1; }
  const html = readFileSync(deckPath, 'utf8');
  const marked = markedRefs(html);
  const hit = parseRef(what) ? marked.find((r) => r.ref === what) : marked.find((r) => r.name === what);
  if (!hit) {
    console.error(`decklight theme remove: ${what} is not marked in ${deck}`
      + (marked.length ? ` — it marks ${marked.map((r) => r.ref).join(', ')}` : ' — it marks no themes'));
    return 1;
  }
  let next;
  try { next = setMarked(html, hit.ref, false); }
  catch (e) {
    if (!(e instanceof MarketplaceError)) throw e;
    console.error(`decklight theme remove: ${e.message}`);
    return 1;
  }
  writeFileAtomic(deckPath, next.html);
  console.log(`unmarked ${hit.ref} — ${deck} no longer lists or carries it`);
  return 0;
}

export async function themeMain(args = []) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { console.log(USAGE); return sub ? 0 : 1; }
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) { console.log(USAGE); return 0; }
  if (sub === 'check') return checkMain(rest);
  if (sub === 'add') return addMain(rest);
  if (sub === 'remove') return removeMain(rest);
  console.error(`decklight theme: unknown subcommand "${sub}"\n\n${USAGE}`);
  return 1;
}

if (isMain(import.meta.url)) process.exit(await themeMain(process.argv.slice(2)));
