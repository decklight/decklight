// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A deck's design systems, as REFERENCES (SPEC DESIGN_SYSTEMS) — the second
// instance of what THEME_DISTRIBUTION built for themes:
//
//   "designSystems": ["acme@acme-mkt"],
//   "themeSources": { "acme-mkt": "acme/decklight-marketplace" }
//
// The deck records WHICH design system it uses; the package stays in its
// marketplace. Every server — write mode, --no-trust, and the render server behind
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
//   - the page also carries the package's meta (palette, templates and slots)
//     and its templates, inline in a <template>, so the engine expands them
//     synchronously, identically for a served deck and a bundled one;
//   - an https `source` has no cache to land in (the theme cache holds one
//     file; a package is many), so it resolves as missing.
//
// Every package is re-checked where it is used, not only when it was added —
// `marketplace update` can change its bytes afterwards — remembered by a
// stat signature so a page load re-reads nothing that has not changed.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { escapeHtml } from '../tools/escape.mjs';
import { DESIGN_SYSTEM_API_VERSION, ASSET_EXTENSIONS, tokenPrefixOf } from '../tools/design-system-format.mjs';
import { pendingMigrations, composeRenames, findRenamed, majorOf, applyRenames, RENAME_KINDS } from '../tools/design-system-migrations.mjs';
import { configBlock, isDeck } from './runtime-link.mjs';
import { configHome, loadRegistry, loadCatalog, MarketplaceError, NAME_RE } from './marketplace.mjs';
import {
  parseRef, resolveCatalogEntry, markedSources, withKey, referencedMarketplaces, DESIGN_SYSTEMS_KEY, FONTS_KEY, SOURCES_KEY, MARKED_KEY,
} from './theme-refs.mjs';
import { resolveSource } from './theme.mjs';
import { checkDir } from './design-system.mjs';

export { DESIGN_SYSTEMS_KEY };

/**
 * The config key a deck records the version of each design system it took
 * under (SPEC DESIGN_SYSTEM_MIGRATIONS): `{ "<ref>": "5.0.0" }`, keyed by the
 * deck's own spelling of the reference. The deck's fact, not this machine's:
 * the ledger in ~/.decklight/ says what one machine installed, for every deck
 * at once, and says nothing on the next machine.
 */
export const DESIGN_SYSTEM_VERSIONS_KEY = 'designSystemVersions';

/** The versions a deck records, `{ ref: version }` — strings only. */
export function deckDesignSystemVersions(html) {
  const v = configBlock(html)?.config?.[DESIGN_SYSTEM_VERSIONS_KEY];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string'));
}

/**
 * Record (or, with null, forget) the version of one design system the deck
 * took, editing only that key so the author's formatting survives. A deck
 * with no configuration block is returned as it is.
 */
export function setDesignSystemVersion(html, ref, version) {
  const block = configBlock(html);
  if (!block || block.error) return html;
  const versions = deckDesignSystemVersions(html);
  if (version) versions[ref] = String(version);
  else delete versions[ref];
  const inner = withKey(block.inner, DESIGN_SYSTEM_VERSIONS_KEY, Object.keys(versions).length ? versions : null);
  return html.slice(0, block.innerStart) + inner + html.slice(block.innerEnd);
}

/**
 * The stylesheets a deck links from its own folder (`<link rel="stylesheet"
 * href="course.css">`), as `[{ href, path, text }]`: what a migration reads
 * and rewrites beside the deck. A URL, a root-absolute path, a design
 * system's or a theme's own link, and a file that is not there are left out.
 */
export function linkedStylesheets(html, dir) {
  const out = [];
  const masked = String(html).replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of masked.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag) || /\bdata-(?:design-system|theme)\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const url = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').replace(/[?#].*$/, '');
    if (!url || /^([a-z][a-z0-9+.-]*:|\/)/i.test(url) || url.includes('decklight-design-system/')) continue;
    const path = resolve(dir, decodeURI(url));
    if (out.some((s) => s.path === path)) continue;
    try { if (existsSync(path) && statSync(path).isFile()) out.push({ href: url, path, text: readFileSync(path, 'utf8') }); } catch { /* unreadable: not ours to migrate */ }
  }
  return out;
}

/**
 * Is a deck behind the design system this machine serves (SPEC
 * DESIGN_SYSTEM_MIGRATIONS)? From the version the deck records and the
 * names it, and the stylesheets it links, still use:
 *   `{ behind, recorded, current, major, found, skills, renames }`
 * `behind` when the deck records an older major, or uses a name a migration
 * since its version renamed; `found` is those names (`findRenamed`), `skills`
 * the skills the pending migrations name. A deck that records no version is
 * held to every migration the package declares.
 */
export function migrationStatus(manifest, recorded, texts) {
  const current = manifest?.version ?? null;
  const pending = pendingMigrations(manifest, recorded);
  const renames = composeRenames(pending);
  const found = findRenamed(texts, renames, tokenPrefixOf(manifest));
  const rm = majorOf(recorded), cm = majorOf(current);
  const major = rm !== null && cm !== null && rm < cm;
  return {
    behind: major || found.length > 0, recorded: recorded ?? null, current, major, found,
    skills: [...new Set(pending.map((m) => m.skill).filter(Boolean))], renames,
  };
}

/**
 * Every design system a deck is behind, from what `check` reads: the deck
 * and the stylesheets it links from `dir` (SPEC DESIGN_SYSTEM_MIGRATIONS).
 * `[{ ref, name, title, recorded, current, skills, message }]`, `message`
 * the one sentence (`behindMessage`) with `deck` as the command's argument.
 * A reference this machine cannot serve is not behind: it is missing, and
 * said as that.
 */
export function deckBehind(html, dir, home = configHome(), { deck = '<deck.html>' } = {}) {
  const refs = designSystemRefs(html);
  if (!refs.length) return [];
  const sources = markedSources(html);
  const versions = deckDesignSystemVersions(html);
  let texts = null;
  const out = [];
  for (const ref of refs) {
    const r = resolveDesignSystemRef(ref, home, { source: sources[ref.marketplace] ?? null });
    const verdict = r.dir ? packageVerdict(r.dir) : null;
    if (!verdict?.ok) continue;
    texts ??= [html, ...(dir ? linkedStylesheets(html, dir).map((x) => x.text) : [])];
    const status = migrationStatus(verdict.manifest, versions[ref.ref] ?? null, texts);
    if (!status.behind) continue;
    out.push({
      ref: ref.ref, name: ref.name, title: verdict.manifest.title || ref.name,
      recorded: status.recorded, current: status.current, skills: status.skills,
      message: behindMessage(ref.name, status, { ref: ref.ref, deck }),
    });
  }
  return out;
}

/**
 * A newer design system the catalog offers, said as what it means for the
 * decks on it (SPEC DESIGN_SYSTEM_MIGRATIONS): one `newerThanInstalled` row
 * with `note` (*major: decks that use it need migrating, with the acme-migrate
 * skill*) and `how` (where to find them and what moves one) when the package
 * this machine now has declares migrations since the version installed. Any
 * other row comes back as it was.
 */
export function withMigrationHint(n, home = configHome()) {
  if (n?.type !== 'design-system') return n;
  const r = resolveDesignSystemRef(n.qualified, home);
  const verdict = r.dir ? packageVerdict(r.dir) : null;
  if (!verdict?.ok) return n;
  const pending = pendingMigrations(verdict.manifest, n.from);
  if (!pending.length) return n;
  const skills = [...new Set(pending.map((m) => m.skill).filter(Boolean))];
  const major = n.from === null || (majorOf(n.from) ?? 0) < (majorOf(n.to) ?? 0);
  return {
    ...n, migrations: pending.map((m) => m.version), skills,
    note: `${major ? 'major: ' : ''}decks that use it need migrating${skills.length ? `, with the ${skills.join(' or ')} skill` : ''}`,
    how: `decklight check finds them; decklight design-system migrate ${n.qualified} <deck.html> moves one`,
  };
}

/**
 * What `design-system migrate` does to a deck, worked out in memory and
 * written by nobody (SPEC DESIGN_SYSTEM_MIGRATIONS): the command and the
 * edit server's Migrate both apply it. `{ error }` when the deck does not
 * use `ref` or this machine cannot serve it, else
 *   `{ ref, name, title, recorded, version, status, html, sheets, renamed, byKind, changed }`
 * — `html` the deck renamed and its version recorded, `sheets` the linked
 * stylesheets a rename touched (`{ href, path, text, count }`), `byKind`
 * `[[kind, found]]` for the report.
 */
export function planMigration(html, dir, ref, home = configHome()) {
  const hit = designSystemRefs(html).find((r) => r.ref === ref || r.name === ref);
  if (!hit) return { error: `the deck does not use ${ref}` };
  const r = resolveDesignSystemRef(hit, home, { source: markedSources(html)[hit.marketplace] ?? null });
  if (!r.dir) return { error: `${hit.ref} — ${r.missing}` };
  const verdict = checkDir(r.dir);
  if (!verdict.ok) return { error: `${hit.ref} no longer passes its check — decklight design-system gate ${r.dir}` };
  const m = verdict.manifest;
  const recorded = deckDesignSystemVersions(html)[hit.ref] ?? null;
  const sheets = linkedStylesheets(html, dir);
  const status = migrationStatus(m, recorded, [html, ...sheets.map((x) => x.text)]);
  const prefix = tokenPrefixOf(m);
  const deckOut = applyRenames(html, status.renames, prefix, { config: true });
  const next = setDesignSystemVersion(deckOut.text, hit.ref, m.version);
  const touched = sheets.map((x) => ({ ...x, ...applyRenames(x.text, status.renames, prefix) })).filter((x) => x.count);
  const renamed = deckOut.count + touched.reduce((n, x) => n + x.count, 0);
  return {
    ref: hit.ref, name: hit.name, title: m.title || hit.name, recorded, version: m.version, status,
    html: next, sheets: touched, renamed,
    byKind: RENAME_KINDS.map((k) => [k, status.found.filter((f) => f.kind === k)]).filter(([, l]) => l.length),
    changed: next !== html || renamed > 0,
  };
}

/**
 * A migration said in lines — what `design-system migrate` prints and what
 * the agent panel records when the edit server runs one: the versions, the
 * renames by kind, the count and where, and the skill named for what a
 * rename cannot decide.
 */
export function migrationLines(plan, deck) {
  const out = [`${deck}: ${plan.ref} ${plan.recorded ?? '(no version recorded)'} → ${plan.version}`];
  if (plan.renamed) {
    for (const [kind, list] of plan.byKind) out.push(`  ${kind.padEnd(8)} ${list.map((f) => `${f.from} → ${f.to}`).join(', ')}`);
    out.push(`  ${plan.renamed} rename${plan.renamed === 1 ? '' : 's'} — in ${deck}${plan.sheets.map((x) => `, ${x.href}`).join('')}`);
  } else out.push('  nothing it uses was renamed — recorded the new version');
  const skills = plan.status.skills;
  if (skills.length) {
    out.push(`  what a rename cannot decide (a name removed with no successor) is the ${skills.join(' and ')} skill's:`
      + ` decklight library add skill ${skills[0]}, then ask your agent to finish the migration`);
  }
  return out;
}

/**
 * A deck that uses a design system but records no version takes `manifest`'s
 * — unless it, or a stylesheet it links from `dir`, still uses a name a
 * migration renamed: recording the new version then would hide that it is
 * behind, and `migrate` moves it first. The html, recorded or as it was.
 */
export function recordVersionIfCurrent(html, ref, manifest, dir) {
  if (deckDesignSystemVersions(html)[ref] || !manifest?.version) return html;
  const status = migrationStatus(manifest, null, [html, ...linkedStylesheets(html, dir).map((x) => x.text)]);
  return status.found.length ? html : setDesignSystemVersion(html, ref, manifest.version);
}

/**
 * The one sentence that says a deck is behind, with what to do — the same in
 * `check`, the write-mode toast and `design-system migrate`'s refusal.
 */
export function behindMessage(name, status, { ref = name, deck = '<deck.html>' } = {}) {
  const was = status.recorded ? `${name} ${status.recorded}` : `an earlier ${name}`;
  const n = status.found.length;
  const shown = status.found.slice(0, 3).map((f) => `${f.from} → ${f.to}`).join(', ');
  const what = n ? `: ${n} renamed name${n === 1 ? '' : 's'} (${shown}${n > 3 ? ', …' : ''})` : ', a new major version';
  const how = status.skills.length
    ? `Migrate with the ${status.skills.join(' or ')} skill, or decklight design-system migrate ${ref} ${deck}`
    : `Migrate with decklight design-system migrate ${ref} ${deck}`;
  return `written for ${was}, this machine serves ${status.current}${what}. ${how}`;
}

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
export function signature(dir) {
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
 * Does the package STILL pass `decklight design-system gate`? It follows its
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
    ? { ok: true, summary: r.summary, manifest: r.manifest, templatesHtml: r.templatesHtml }
    : { ok: false, why: `it no longer passes the design-system check — ${r.problems[0].file}${r.problems[0].line ? ` line ${r.problems[0].line}` : ''}: ${r.problems[0].msg} (decklight design-system gate)` };
  verdicts.set(dir, { sig, value });
  return value;
}

/** What the page is told about a package: the facts the engine and the palette read. */
export function designSystemMeta(verdict) {
  const m = verdict.manifest ?? {};
  const brand = verdict.summary?.brand ?? null;
  return {
    name: m.name, version: m.version, title: m.title,
    // a palette of scales (SPEC BRAND_PALETTE) is told as one entry per swatch, a colour's ten in a row
    palette: brand ? brand.palette : Array.isArray(m.palette) ? m.palette : [],
    ...(brand ? { scales: true, themes: brand.themes.map(({ name, title, mode, refs, roleValues }) => ({ name, title, mode, refs, ...(roleValues ? { roles: roleValues } : {}) })) } : {}),
    // its roles (SPEC DESIGN_SYSTEM_ROLES): what the Colors tab offers on a deck held to the brand, each theme's value above
    // …and which contract tokens read which role: a fill role is that diagram slot (SVG_DIAGRAMS)
    ...(brand?.roles ? { roles: brand.roles, contract: brand.contract ?? {} } : {}),
    // the themes it is made to sit on — the theme picker lists them first
    recommendedThemes: Array.isArray(m.recommendedThemes) ? m.recommendedThemes.filter((t) => typeof t === 'string') : [],
    // …and the fonts (SPEC FONTS) — the font picker lists them first
    recommendedFonts: Array.isArray(m.recommendedFonts) ? m.recommendedFonts.filter((t) => typeof t === 'string') : [],
    templates: (verdict.summary?.templates ?? []).map(({ id, title, slots }) => ({ id, title, slots })),
  };
}

/** Where a server answers a package's files, relative to the deck. */
export const designSystemHref = (marketplace, name, path) => `decklight-design-system/${marketplace}/${name}/${path}`;

/** JSON safe inside a <script> — the manifest is somebody else's file. */
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * A design system's palette of scales and its brand themes, as the page gets
 * them (SPEC BRAND_PALETTE) — the same tags from every server and from
 * `bundle`: the swatches as tokens, defined from the manifest, and each theme
 * as an added theme (`<style data-theme data-theme-added media="not all">`,
 * the shape a bundle's marked theme has), tagged with the design system it
 * belongs to so the picker can hold a deck to its brand. Nothing for a
 * package without a scale palette.
 */
export function brandTags(name, verdict) {
  const brand = verdict.summary?.brand;
  if (!brand) return [];
  const sys = escapeHtml(name);
  const title = escapeHtml(String(verdict.manifest?.title ?? name));
  const lines = brand.palette.map((e) => `  ${e.token}: ${e.hex};`);
  // every role at its value in the brand's first theme, always on (SPEC DESIGN_SYSTEM_ROLES):
  // each theme block sets them again after this, so a role is never undefined
  // while no brand theme is applied — an unlocked deck on another theme, a block gone
  const first = brand.themes[0]?.css ?? '';
  for (const r of brand.roles ?? []) {
    const m = new RegExp(`^\\s*${r.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*([^;\\n]+);`, 'm').exec(first);
    if (m) lines.push(`  ${r.token}: ${m[1]};`);
  }
  const safe = (css) => css.replace(/<\/(style)/gi, '<\\/$1');
  return [
    `<style data-design-system-palette="${sys}">\n.decklight {\n${lines.join('\n')}\n}\n</style>`,
    ...brand.themes.map((t) => `<style data-theme="${escapeHtml(t.name)}" data-theme-added data-design-system-theme="${sys}" data-theme-source="${title}" media="not all">\n${safe(t.css)}</style>`),
  ];
}

/**
 * A deck's design systems, linked into the page on its way out — what every
 * server does after `linkAddedThemes`, never `bundle`. Per reference, after
 * the theme links and before `</head>`:
 *   <link rel="stylesheet" href="decklight-design-system/…/design-system.css" data-design-system="<name>">
 *   <script type="application/json" data-design-system-meta="<name>">{…}</script>
 *   <template data-design-system-templates="<name>">…templates.html…</template>
 * Nothing when the page already carries `<style data-design-system="<name>">`
 * (a bundle's own copy). An unresolvable reference, or a package that no
 * longer passes the check, becomes `<meta name="decklight-design-system-missing">`
 * naming it and why — never a silently short page. A deck behind a
 * package's major gets `<meta name="decklight-design-system-behind"
 * data-ref data-version>`, its sentence the content; `dir` is the deck's
 * folder, so the stylesheets it links are read as `check` reads them, and
 * `deck` its file name, for the command the sentence ends on.
 */
export function linkDesignSystems(html, home = configHome(), { log = null, dir = null, deck = '<deck.html>' } = {}) {
  if (!isDeck(html)) return html;
  const refs = designSystemRefs(html);
  if (!refs.length) return html;
  const sources = markedSources(html);
  const tags = [];
  let texts = null;
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
      tags.push(`<template data-design-system-templates="${name}">\n${verdict.templatesHtml.trim()}\n</template>`);
      tags.push(...brandTags(ref.name, verdict));
      // a deck behind the major this machine serves: said once, while authoring (SPEC DESIGN_SYSTEM_MIGRATIONS)
      // — read as `check` reads it: the deck and the stylesheets it links from `dir`
      texts ??= [html, ...(dir ? linkedStylesheets(html, dir).map((x) => x.text) : [])];
      const status = migrationStatus(verdict.manifest, deckDesignSystemVersions(html)[ref.ref] ?? null, texts);
      if (status.behind) {
        tags.push(`<meta name="decklight-design-system-behind" data-ref="${escapeHtml(ref.ref)}" data-version="${escapeHtml(status.current)}"`
          + ` content="${escapeHtml(`${verdict.manifest.title || ref.name}: ${behindMessage(ref.name, status, { ref: ref.ref, deck })}`)}">`);
      }
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
 * copy of), then the meta `<script>` and the templates `<template>` exactly as
 * the servers inject them, so the runtime finds them by the same selectors.
 * Returns `{ tags, assets, bytes, external, templates }`.
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
      `<template data-design-system-templates="${name}">\n${verdict.templatesHtml.trim()}\n</template>`,
      ...brandTags(r.name, verdict),
    ],
    assets: inlined.assets, bytes: inlined.bytes, external: inlined.external,
    templates: verdict.summary?.templates?.length ?? 0,
    // its own themes (SPEC BRAND_PALETTE): carried in `tags`, never looked up in themes/
    brandThemes: (verdict.summary?.brand?.themes ?? []).map((t) => t.name),
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
export function setDesignSystem(html, ref, on, { source = null, version = null } = {}) {
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
    // a slide names a design system by its name (data-template="acme/…"), so
    // two of the same name from different catalogs would be ambiguous
    const clash = current.find((r) => r.name === parsed.name);
    if (clash) throw new MarketplaceError(`the deck already uses ${clash.ref} — two design systems called "${parsed.name}" cannot both be referenced`);
  } else if (!has) return { html, changed: false };
  const next = on ? [...current.map((r) => r.ref), parsed.ref] : current.map((r) => r.ref).filter((r) => r !== parsed.ref);
  const sources = markedSources(html);
  if (on && source) sources[parsed.marketplace] = source;
  const others = referencedMarketplaces(html, [MARKED_KEY, FONTS_KEY]);
  for (const m of Object.keys(sources)) {
    if (!next.some((r) => r.endsWith(`@${m}`)) && !others.has(m)) delete sources[m];
  }
  let inner = withKey(block.inner, DESIGN_SYSTEMS_KEY, next.length ? next : null);
  inner = withKey(inner, SOURCES_KEY, Object.keys(sources).length ? sources : null);
  const out = html.slice(0, block.innerStart) + inner + html.slice(block.innerEnd);
  // the version it took goes in with the reference, and out with it (SPEC DESIGN_SYSTEM_MIGRATIONS)
  return { html: on ? (version ? setDesignSystemVersion(out, parsed.ref, version) : out) : setDesignSystemVersion(out, parsed.ref, null), changed: true };
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
