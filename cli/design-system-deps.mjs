// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A design system's DEPENDENCIES (SPEC DESIGN_SYSTEMS, #642): the themes and
// fonts it recommends. A design system leaves the page, the type and the
// colours to a theme — `paints-the-page` — so `recommendedThemes` and
// `recommendedFonts` are how it names the ones it was drawn for. Adding it
// to a deck brings them along (unless `--no-recommended`); applying them —
// making the deck's theme and font the recommended ones — is offered, never
// automatic, because the page and the type stay the author's choice.
//
// Shared by `design-system add|apply` and the author server's
// /edit/design-system/mark|apply, so the command line and the UI resolve,
// gate and refuse by the same code:
//
//   planRecommended(html, ds)  → what each recommendation is: added, already
//                                there, a stack (applied, never referenced),
//                                or skipped — with the reason and the command
//   writePlan(html, plan)      → the deck with every addable one written, in
//                                the same string the design system is written
//                                to, so the whole thing is ONE edit
//   lookOf(html, ds, plan)     → the theme and font the deck would apply, and
//                                whether that differs from what it has
//   applyLook(html, look)      → the deck's `theme` and `font` set to them
//
// Nothing here fetches: registry, catalog cache and checkouts only.

import { configHome, loadRegistry, loadCatalog, loadLedger, MarketplaceError } from './marketplace.mjs';
import { configBlock } from './runtime-link.mjs';
import {
  parseRef, resolveThemeRef, stillValid, refForDeck, setMarked, markedEntries, shippedThemes, withKey,
} from './theme-refs.mjs';
import { resolveFontRef, setFont, fontRefs, FONT_DEFAULT_KEY } from './font-refs.mjs';
import { checkFontDir } from './font.mjs';
import { STACK_LABELS } from '../tools/font-stacks.mjs';

/** The registered catalogs this machine has fetched. */
function catalogs(home) {
  const out = {};
  for (const name of Object.keys(loadRegistry(home).marketplaces ?? {})) {
    const c = loadCatalog(name, home);
    if (c?.ok) out[name] = c.manifest;
  }
  return out;
}

/**
 * A recommendation's qualified reference, by the resolution order the spec
 * sets: `name@marketplace` as written; a bare name is the design system's own
 * marketplace's entry of that kind, else the one registered catalog that has
 * it. Returns `{ qualified }`, or `{ why }` — ambiguous (with the qualified
 * forms to write instead) or nowhere.
 */
function qualify(rec, type, dsLocal, cats) {
  if (rec.includes('@')) return parseRef(rec) ? { qualified: rec } : { why: `"${rec}" is not a reference (name@marketplace)` };
  const has = (m) => (cats[m]?.entries ?? []).some((e) => e.name === rec && e.type === type);
  if (dsLocal && has(dsLocal)) return { qualified: `${rec}@${dsLocal}` };
  const everywhere = Object.keys(cats).filter(has);
  if (everywhere.length === 1) return { qualified: `${rec}@${everywhere[0]}` };
  if (everywhere.length > 1) {
    return { why: `"${rec}" is a ${type} in ${everywhere.length} marketplaces — say which: ${everywhere.map((m) => `${rec}@${m}`).join(', ')}` };
  }
  return { why: `no registered marketplace offers a ${type} called "${rec}"` };
}

/**
 * What every recommendation of a design system would do to this deck.
 * `ds` is `{ manifest, local }` — the package's manifest and what this
 * machine calls its marketplace. Each item: `{ kind: 'theme'|'font', rec,
 * status: 'add'|'already'|'stack'|'skip', ref, name, version, why, cmd }` —
 * an `already` one carries `same` when the deck has THIS entry, not another
 * marketplace's of the same name.
 */
export function planRecommended(html, ds, home = configHome()) {
  const cats = catalogs(home);
  const marked = markedEntries(html);
  const fonts = fontRefs(html);
  const items = [];
  for (const rec of (ds.manifest?.recommendedThemes ?? []).filter((t) => typeof t === 'string')) {
    // a theme decklight ships is marked by its bare name — nothing to resolve or check
    if (!rec.includes('@') && shippedThemes().includes(rec)) {
      items.push({ kind: 'theme', rec, name: rec, ref: rec, status: marked.some((m) => m.ref === rec) ? 'already' : 'add', shipped: true });
      continue;
    }
    const q = qualify(rec, 'theme', ds.local, cats);
    if (q.why) { items.push({ kind: 'theme', rec, status: 'skip', why: q.why, cmd: `decklight theme add <name@marketplace> <deck>` }); continue; }
    const r = resolveThemeRef(q.qualified, home);
    const cmd = `decklight theme add ${q.qualified} <deck>`;
    if (!r.file) {
      items.push({ kind: 'theme', rec, status: 'skip', why: r.remote ? `${q.qualified} lives at a URL — reading it is its own explicit act` : r.missing, cmd });
      continue;
    }
    const valid = stillValid(r.file);
    if (!valid.ok) { items.push({ kind: 'theme', rec, status: 'skip', why: valid.why, cmd }); continue; }
    const ref = refForDeck(html, r.name, r.local, r.source ?? null);
    const same = marked.some((m) => m.ref === ref);
    items.push({
      kind: 'theme', rec, name: r.name, ref, source: r.source ?? null, local: r.local, version: r.entry?.version ?? null,
      status: same || marked.some((m) => m.name === r.name && !m.shipped) ? 'already' : 'add', same,
    });
  }
  for (const rec of (ds.manifest?.recommendedFonts ?? []).filter((t) => typeof t === 'string')) {
    // a picker stack is APPLIED, never referenced: there is nothing to carry
    if (STACK_LABELS.includes(rec)) { items.push({ kind: 'font', rec, name: rec, status: 'stack' }); continue; }
    const q = qualify(rec, 'font', ds.local, cats);
    if (q.why) { items.push({ kind: 'font', rec, status: 'skip', why: q.why, cmd: `decklight font add <name@marketplace> <deck>` }); continue; }
    const r = resolveFontRef(q.qualified, home);
    const cmd = `decklight font add ${q.qualified} <deck>`;
    if (!r.dir) { items.push({ kind: 'font', rec, status: 'skip', why: r.missing, cmd }); continue; }
    const verdict = checkFontDir(r.dir);
    if (!verdict.ok) {
      const p = verdict.problems[0];
      items.push({ kind: 'font', rec, status: 'skip', why: `it fails the font check — ${p.file}: ${p.msg}`, cmd });
      continue;
    }
    const ref = refForDeck(html, r.name, r.local, r.source ?? null);
    const same = fonts.some((f) => f.ref === ref);
    items.push({
      kind: 'font', rec, name: r.name, ref, source: r.source ?? null, local: r.local, version: r.entry?.version ?? null,
      family: verdict.manifest.family, status: same || fonts.some((f) => f.name === r.name) ? 'already' : 'add', same,
    });
  }
  return { items, title: ds.manifest?.title || ds.manifest?.name || '' };
}

/** The deck with every addable recommendation written — the caller writes it with the design system, as one edit. */
export function writePlan(html, plan) {
  let out = html;
  for (const it of plan.items) {
    if (it.status !== 'add') continue;
    // a refusal here (a name another theme or font already holds) skips THAT
    // one and keeps the rest: a dependency never blocks the design system
    try {
      out = it.kind === 'theme'
        ? setMarked(out, it.ref, true, { source: it.source ?? null }).html
        : setFont(out, it.ref, true, { source: it.source ?? null }).html;
    } catch (e) {
      if (!(e instanceof MarketplaceError)) throw e;
      Object.assign(it, { status: 'skip', why: e.message, cmd: `decklight ${it.kind} add ${it.ref} <deck>` });
    }
  }
  return out;
}

/**
 * What `installed.json` remembers for each recommendation, as a separate add
 * would: every one added, AND every one the deck already has — re-running
 * `theme add` / `font add` on a marked one records the catalog's version now
 * (#616), so bringing it again does the same, or `marketplace list` keeps
 * calling it out of date (#653). Never a shipped theme or a stack, and never
 * one the deck has from another marketplace's entry of that name. An
 * `already` item whose record this changes gets `recorded`, for its line.
 */
export function plannedInstalls(plan, home = configHome()) {
  const reg = loadRegistry(home).marketplaces ?? {};
  const had = loadLedger(home).installs;
  const taken = plan.items.filter((it) => !it.shipped && (it.status === 'add' || (it.status === 'already' && it.same)));
  for (const it of taken) {
    if (it.status === 'already' && it.version && had[`${it.kind}:${it.name}@${it.local}`]?.version !== it.version) it.recorded = it.version;
  }
  return taken.map((it) => ({ type: it.kind, name: it.name, marketplace: it.local, version: it.version ?? null, commit: reg[it.local]?.commit ?? null }));
}

/**
 * The look the design system was drawn for, as this deck could wear it: the
 * first recommended theme that is (or is being) marked, and the first
 * recommended font that is a stack or a (being) referenced package — and
 * whether either differs from the deck's `theme` / `font` now.
 */
export function lookOf(html, plan) {
  const config = configBlock(html)?.config ?? {};
  const usable = (it) => it.status === 'add' || it.status === 'already' || it.status === 'stack';
  const theme = plan.items.find((it) => it.kind === 'theme' && usable(it))?.name ?? null;
  const font = plan.items.find((it) => it.kind === 'font' && usable(it))?.name ?? null;
  const themeChanges = !!theme && config.theme !== theme;
  const fontChanges = !!font && config[FONT_DEFAULT_KEY] !== font;
  return { title: plan.title, theme, font, themeChanges, fontChanges, differs: themeChanges || fontChanges };
}

/** The deck's `theme` and `font` set to the look — only what changes. */
export function applyLook(html, look) {
  const block = configBlock(html);
  if (!block?.config) return html;
  let inner = block.inner;
  if (look.themeChanges) inner = withKey(inner, 'theme', look.theme);
  if (look.fontChanges) inner = withKey(inner, FONT_DEFAULT_KEY, look.font);
  return html.slice(0, block.innerStart) + inner + html.slice(block.innerEnd);
}

/** The question, naming only what would change: "theme verdant-light, font Fira Sans". */
export function lookPhrase(look, plan) {
  const fontLabel = plan.items.find((it) => it.kind === 'font' && it.name === look.font)?.family ?? look.font;
  return [look.themeChanges ? `theme ${look.theme}` : null, look.fontChanges ? `font ${fontLabel}` : null].filter(Boolean).join(', ');
}

/** One line per recommendation, for the command line's summary. */
export function planLines(plan) {
  return plan.items.map((it) => {
    const what = it.kind === 'theme' ? 'theme' : 'font';
    const v = it.version ? ` ${it.version}` : '';
    if (it.status === 'add') return `  + ${what} ${it.ref}${v}${it.shipped ? ' (shipped)' : ''}`;
    if (it.status === 'already') return `  = ${what} ${it.ref ?? it.rec} — already there${it.recorded ? `, recorded ${it.recorded}` : ''}`;
    if (it.status === 'stack') return `  · font ${it.rec} — a picker stack: applied, nothing to carry`;
    return `  ⚠ ${what} ${it.rec} — ${it.why}\n      ${it.cmd}`;
  });
}
