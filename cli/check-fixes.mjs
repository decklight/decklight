// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The quick fixes Check deck… offers for what `decklight check` finds (SPEC
 * PRESENTING_EDITING). Pure over the deck's text and the resolved design
 * systems: nothing here writes, spawns or reads the clock. The edit server's
 * `GET /deck/edit/check` runs `quickFixes` over the static findings so every
 * row the panel shows carries what pressing its fix WOULD do, and its
 * `POST /deck/edit/check/fix` applies the transforms below.
 *
 * Two kinds of fix (the issue's distinction, #889). A DETERMINISTIC one is a
 * rename or a setting the server can apply itself, in one write:
 *
 *   ds-behind          migrate   design-system migrate (DESIGN_SYSTEM_MIGRATIONS)
 *   theme-off-brand    theme     the theme the brand's migration renames it to,
 *                                else the brand's first theme
 *   off-role           rename    a renamed role → its successor, on that slide
 *                                (batchable: ⇧F does every slide at once)
 *   ds-unresolved      update    marketplace update <marketplace>
 *   ds-unknown-system  add       design-system add <name>@<marketplace>, when a
 *                                registered marketplace offers one of that name
 *
 * Everything else — clipped and crowded slides, ⟨CLICK⟩s against builds, a
 * literal off the palette, a slot left empty — is a JUDGEMENT fix: the panel
 * hands it to the A agent as an ordinary ask (src/core/deckcheck.js writes
 * that prompt, since the live page has findings of its own), and nothing
 * here claims one.
 */

import { deckDesignSystems } from './check.mjs';
import { configBlock } from './runtime-link.mjs';
import { deckBehind, designSystemRefs, marketplaceDesignSystems, planMigration } from './design-system-refs.mjs';
import { configHome, loadRegistry } from './marketplace.mjs';
import { applyRenames, composeRenames, findRenamed, migrationsOf } from '../tools/design-system-migrations.mjs';
import { tokenPrefixOf } from '../tools/design-system-format.mjs';
import { locateSlide, sectionBodies } from '../tools/deck-html.mjs';

/** The rules whose fix is deterministic and safe to apply to every slide at once. */
export const BATCH_RULES = ['off-role'];

const readConfig = (html) => { try { return JSON.parse(configBlock(html)?.inner ?? 'null') ?? {}; } catch { return {}; } };

/**
 * The role renames every design system the deck uses declares, composed
 * across its migrations: `[{ prefix, roles }]`. ALL its migrations, not
 * only the pending ones: an off-role that still meets a renamed role is a
 * deck recorded at the current version with an old name left in it, which
 * is exactly the case `ds-behind` does not cover (SPEC
 * DESIGN_SYSTEM_MIGRATIONS).
 */
function roleRenames(systems) {
  const out = [];
  for (const sys of systems.values()) {
    const mm = sys.migrationManifest;
    if (!mm) continue;
    const roles = composeRenames(migrationsOf(mm)).roles;
    if (Object.keys(roles).length) out.push({ prefix: tokenPrefixOf(mm), roles });
  }
  return out;
}

/** The renamed roles slide `n` still uses, as `findRenamed` names them. */
function renamedRolesOn(html, n, systems) {
  const body = sectionBodies(html)[n - 1];
  if (!body) return [];
  return roleRenames(systems).flatMap(({ prefix, roles }) => findRenamed([body], { roles }, prefix));
}

/**
 * The theme a deck held to its brand should wear instead of the off-brand
 * one its configuration names (SPEC BRAND_PALETTE): the one a design
 * system's migration renames it to, when that is a brand theme, else the
 * brand's first theme, which is what the runtime opens on. Null when the
 * deck is not off its brand or the brand has no themes.
 */
export function offBrandTarget(html, systems = deckDesignSystems(html)) {
  const config = readConfig(html);
  if (config.brandThemesOnly === false || typeof config.theme !== 'string' || !config.theme) return null;
  const brand = [...systems.values()].flatMap((sys) => sys.themeNames ?? []);
  if (!brand.length || brand.includes(config.theme)) return null;
  for (const sys of systems.values()) {
    const mm = sys.migrationManifest;
    const to = mm ? composeRenames(migrationsOf(mm)).themes[config.theme]?.to : null;
    if (to && brand.includes(to)) return { from: config.theme, to, renamed: true };
  }
  return { from: config.theme, to: brand[0], renamed: false };
}

/**
 * A renamed role moved to its successor on slide `n`, or on every slide
 * (`n` null): `{ html, count, slides }`, the markup otherwise byte for byte.
 * The head and the tail are never touched — a role a stylesheet writes is
 * the migration's, not a slide's.
 */
export function renameRoles(html, n, systems = deckDesignSystems(html)) {
  const renames = roleRenames(systems);
  const total = sectionBodies(html).length;
  const targets = n ? [n] : Array.from({ length: total }, (_, i) => i + 1);
  let out = html;
  let count = 0;
  const slides = [];
  for (const slide of targets) {
    if (slide < 1 || slide > total) continue;
    const { parts, idx } = locateSlide(out, slide);
    let body = parts[idx];
    let here = 0;
    for (const { prefix, roles } of renames) {
      const r = applyRenames(body, { roles }, prefix);
      body = r.text;
      here += r.count;
    }
    if (!here) continue;
    parts[idx] = body;
    out = parts.join('');
    count += here;
    slides.push(slide);
  }
  return { html: out, count, slides };
}

/** `name@marketplace` → its marketplace, when the reference is spelled so. */
const marketplaceOf = (ref) => /^[^@\s]+@([\w-]+)$/.exec(String(ref ?? ''))?.[1] ?? null;

/**
 * The static findings, each with the deterministic fix the server can apply
 * for it (`fix: { kind, label, … }`) — or none, which the panel says in so
 * many words. `label` is what the fix WILL do, written on the row (*Migrate
 * to acme 3.0.0 · 3 renames*), never a verb alone.
 */
export function quickFixes(findings, html, dir, { home = configHome(), deck = 'deck.html', systems = null } = {}) {
  const sys = systems ?? (designSystemRefs(html).length ? deckDesignSystems(html) : new Map());
  let behind = null;
  let offered = null;
  const registered = () => { try { return Object.keys(loadRegistry(home).marketplaces ?? {}); } catch { return []; } };
  const fixFor = (f) => {
    switch (f.rule) {
      case 'ds-behind': {
        behind ??= deckBehind(html, dir, home, { deck });
        const b = behind.find((x) => f.message.startsWith(`${x.ref} `)) ?? behind[0];
        if (!b) return null;
        const plan = planMigration(html, dir, b.ref, home);
        if (plan.error || !plan.changed) return null;
        return {
          kind: 'migrate', ref: b.ref,
          label: `Migrate to ${plan.name} ${plan.version}${plan.renamed ? ` · ${plan.renamed} rename${plan.renamed === 1 ? '' : 's'}` : ''}`,
          ...(b.skills.length ? { skills: b.skills } : {}),
        };
      }
      case 'theme-off-brand': {
        const t = offBrandTarget(html, sys);
        return t ? { kind: 'theme', theme: t.to, label: `Switch to ${t.to}${t.renamed ? ` (${t.from} was renamed)` : ', the brand’s first theme'}` } : null;
      }
      case 'off-role': {
        if (!f.slide) return null;
        const found = renamedRolesOn(html, f.slide, sys);
        if (!found.length) return null;
        return {
          kind: 'rename', slide: f.slide, batch: true,
          label: `Rename ${found.length === 1 ? `${found[0].from} → ${found[0].to}` : `${found.length} roles to their successors`} on slide ${f.slide}`,
        };
      }
      case 'ds-unresolved': {
        const ref = /^design system (\S+) cannot be read/.exec(f.message)?.[1];
        const name = marketplaceOf(ref);
        if (!name || !registered().includes(name)) return null;
        return { kind: 'marketplace-update', name, label: `Update the ${name} marketplace` };
      }
      case 'ds-unknown-system': {
        const want = /no design system called "([^"]+)"/.exec(f.message)?.[1];
        if (!want) return null;
        offered ??= marketplaceDesignSystems(home).systems;
        const hit = offered.find((s) => s.name === want && !s.missing);
        return hit ? { kind: 'design-system-add', ref: hit.qualified, label: `Add ${hit.qualified} to the deck` } : null;
      }
      default: return null;
    }
  };
  return findings.map((f) => {
    const fix = fixFor(f);
    return fix ? { ...f, fix } : f;
  });
}

/** `fix: <rule> on slide N`, or `fix: <rule>` for the deck — the commit a quick fix makes. */
export const fixSubject = (rule, slide = null) => `fix: ${rule}${slide ? ` on slide ${slide}` : ''}`;
