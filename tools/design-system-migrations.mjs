// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * A design system's declared migrations (SPEC DESIGN_SYSTEM_MIGRATIONS): what
 * a major version renamed, so decklight knows a deck is behind without
 * guessing, says it once, and can apply the renames itself.
 *
 *   "migrations": {
 *     "6.0.0": {
 *       "skill":   "acme-migrate",
 *       "roles":   { "text-diagram-blue": "text-diagram-default" },
 *       "tokens":  { "--acme-font-size-body-lg": "--acme-font-size-body-xl" },
 *       "classes": { "acme-tile--zest": "acme-tile--secondary-3" },
 *       "themes":  { "acme-devrel": "acme-dark" }
 *     }
 *   }
 *
 * A key is the version that made the change. Every rename is a WHOLE name:
 * a role id (the slide writes its token, `--<prefix>color-<role>`), a custom
 * property, a class, a theme. Pure — no file is read here; the gate, `check`,
 * the servers and `design-system migrate` hand in the text.
 */

import { SEMVER_RE, semverCompare } from './semver.mjs';

/** The four kinds of name a migration renames, in the order they are said. */
export const RENAME_KINDS = ['roles', 'tokens', 'classes', 'themes'];
const ONE = { roles: 'role', tokens: 'token', classes: 'class', themes: 'theme' };

const ID_RE = /^[a-z][a-z0-9-]*$/;
const SHAPES = {
  roles: [ID_RE, 'a role id (a lowercase word, e.g. "text-heading-main")'],
  tokens: [/^--[A-Za-z0-9_-]+$/, 'a custom property, "--…"'],
  classes: [/^-?[A-Za-z_][A-Za-z0-9_-]*$/, 'a class name, without the dot'],
  themes: [ID_RE, 'a theme name'],
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A name as a whole word of CSS or HTML: not inside a longer identifier. */
const whole = (name) => new RegExp(`(?<![\\w-])${escapeRe(name)}(?![\\w-])`, 'g');

/** The major of a semver version, or null. */
export const majorOf = (v) => (SEMVER_RE.test(String(v ?? '')) ? Number(String(v).split('.')[0]) : null);

/**
 * What is wrong with a manifest's `migrations`, as `[{ msg }]` — its shape
 * only: every key a semver version no later than the package's own, every
 * value `{ skill?, roles?, tokens?, classes?, themes? }` of whole names.
 */
export function migrationShapeProblems(m) {
  const out = [];
  if (m.migrations === undefined) return out;
  if (!isObj(m.migrations)) return [{ msg: 'migrations must be { "<version>": { "roles": { "<old>": "<new>" }, … } }, one entry per version that renamed something' }];
  for (const [version, mig] of Object.entries(m.migrations)) {
    if (!SEMVER_RE.test(version)) { out.push({ msg: `migrations: "${version}" is not a semver version — key each migration by the version that made it` }); continue; }
    if (SEMVER_RE.test(String(m.version ?? '')) && semverCompare(version, m.version) > 0) {
      out.push({ msg: `migrations: ${version} is later than this package's version ${m.version}` });
    }
    if (!isObj(mig)) { out.push({ msg: `migrations: ${version} must be { "skill"?, "roles"?, "tokens"?, "classes"?, "themes"? }` }); continue; }
    for (const key of Object.keys(mig)) {
      if (key !== 'skill' && !RENAME_KINDS.includes(key)) out.push({ msg: `migrations: ${version} has "${key}" — a migration renames roles, tokens, classes and themes, and may name a skill` });
    }
    if (mig.skill !== undefined && (typeof mig.skill !== 'string' || !ID_RE.test(mig.skill))) {
      out.push({ msg: `migrations: ${version}.skill ${JSON.stringify(mig.skill)} — the name of a marketplace skill (decklight library add skill <name>)` });
    }
    for (const kind of RENAME_KINDS) {
      if (mig[kind] === undefined) continue;
      if (!isObj(mig[kind])) { out.push({ msg: `migrations: ${version}.${kind} must be { "<old>": "<new>" }` }); continue; }
      const [re, what] = SHAPES[kind];
      for (const [from, to] of Object.entries(mig[kind])) {
        if (!re.test(from) || typeof to !== 'string' || !re.test(to)) out.push({ msg: `migrations: ${version}.${kind} "${from}" → ${JSON.stringify(to)} — each side is ${what}` });
        else if (from === to) out.push({ msg: `migrations: ${version}.${kind} renames "${from}" to itself` });
      }
    }
  }
  return out;
}

/** The migrations in version order, each `{ version, skill, roles, tokens, classes, themes }` — only well-formed ones. */
export function migrationsOf(manifest) {
  const all = isObj(manifest?.migrations) ? manifest.migrations : {};
  return Object.entries(all)
    .filter(([v, mig]) => SEMVER_RE.test(v) && isObj(mig))
    .map(([version, mig]) => ({
      version,
      skill: typeof mig.skill === 'string' ? mig.skill : null,
      ...Object.fromEntries(RENAME_KINDS.map((k) => [k, isObj(mig[k]) ? Object.fromEntries(Object.entries(mig[k]).filter(([, to]) => typeof to === 'string')) : {}])),
    }))
    .sort((a, b) => semverCompare(a.version, b.version));
}

/**
 * The migrations a deck written for `from` has still to take, up to the
 * package's own version: every one after `from`, or every one when the deck
 * records no version.
 */
export function pendingMigrations(manifest, from = null) {
  return migrationsOf(manifest).filter((m) => (!from || !SEMVER_RE.test(from) || semverCompare(m.version, from) > 0)
    && (!SEMVER_RE.test(String(manifest?.version ?? '')) || semverCompare(m.version, manifest.version) <= 0));
}

/**
 * The renames of several migrations as one map per kind, chains followed: a
 * name renamed in 5.0.0 and its successor again in 6.0.0 goes straight to the
 * last one, so a deck two majors behind is moved in one pass. Each value is
 * `{ to, version }` — the version of the LAST rename on the way.
 */
export function composeRenames(migrations) {
  const out = Object.fromEntries(RENAME_KINDS.map((k) => [k, {}]));
  for (const m of migrations) {
    for (const kind of RENAME_KINDS) {
      const map = out[kind];
      for (const [from, to] of Object.entries(m[kind])) {
        for (const r of Object.values(map)) if (r.to === from) { r.to = to; r.version = m.version; }
        if (!map[from]) map[from] = { to, version: m.version };
      }
    }
  }
  return out;
}

/** A role id's token, as a slide writes it — the shape `roleToken` gives (SPEC DESIGN_SYSTEM_ROLES). */
const roleTokenOf = (prefix, id) => `${prefix}color-${id}`;

/**
 * Every renamed name the texts still use: `[{ kind, from, to, version, as }]`,
 * `as` the spelling found (a role is found as its token). Classes are looked
 * for in `class` attributes and in CSS selectors, themes as the configured
 * `"theme"`; roles and tokens anywhere, as whole names.
 */
export function findRenamed(texts, renames, prefix) {
  const found = [];
  const body = [].concat(texts).join('\n');
  const classAttrs = [...body.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => ` ${m[1] ?? m[2]} `).join(' ');
  for (const [from, r] of Object.entries(renames.roles ?? {})) {
    const as = roleTokenOf(prefix, from);
    if (whole(as).test(body)) found.push({ kind: 'roles', from, to: r.to, version: r.version, as });
  }
  for (const [from, r] of Object.entries(renames.tokens ?? {})) {
    if (whole(from).test(body)) found.push({ kind: 'tokens', from, to: r.to, version: r.version, as: from });
  }
  for (const [from, r] of Object.entries(renames.classes ?? {})) {
    if (whole(from).test(classAttrs) || new RegExp(`\\.${escapeRe(from)}(?![\\w-])`).test(body)) found.push({ kind: 'classes', from, to: r.to, version: r.version, as: from });
  }
  for (const [from, r] of Object.entries(renames.themes ?? {})) {
    if (new RegExp(`"theme"\\s*:\\s*"${escapeRe(from)}"`).test(body)) found.push({ kind: 'themes', from, to: r.to, version: r.version, as: from });
  }
  return found;
}

/**
 * The renames applied to one text: roles (as tokens) and tokens wherever they
 * stand as whole names, classes in `class` attributes and in selectors, and
 * — when `config` is true, for the deck — the configured `"theme"`. Nothing
 * else changes, byte for byte. Returns `{ text, count }`.
 */
export function applyRenames(text, renames, prefix, { config = false } = {}) {
  let count = 0;
  let out = String(text);
  const swap = (re, to) => { out = out.replace(re, () => { count++; return to; }); };
  for (const [from, r] of Object.entries(renames.roles ?? {})) swap(whole(roleTokenOf(prefix, from)), roleTokenOf(prefix, r.to));
  for (const [from, r] of Object.entries(renames.tokens ?? {})) swap(whole(from), r.to);
  const classes = Object.entries(renames.classes ?? {});
  if (classes.length) {
    out = out.replace(/(\bclass\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (all, lead, dq, sq) => {
      const q = dq !== undefined ? '"' : "'";
      let v = dq ?? sq;
      for (const [from, r] of classes) v = v.replace(whole(from), () => { count++; return r.to; });
      return `${lead}${q}${v}${q}`;
    });
    for (const [from, r] of classes) swap(new RegExp(`\\.${escapeRe(from)}(?![\\w-])`, 'g'), `.${r.to}`);
  }
  if (config) {
    for (const [from, r] of Object.entries(renames.themes ?? {})) {
      out = out.replace(new RegExp(`("theme"\\s*:\\s*")${escapeRe(from)}"`, 'g'), (all, lead) => { count++; return `${lead}${r.to}"`; });
    }
  }
  return { text: out, count };
}

/**
 * The gate's half (DESIGN_SYSTEM_MIGRATIONS): a migration's names, against
 * the package as it now is. Every old name must be gone — a rename that
 * leaves it is not one — and every new name present, unless a later
 * migration renamed it again. `has` is `{ roles, tokens, classes, themes }`,
 * each a Set of what the package defines. Returns `[{ msg }]`.
 */
export function migrationNameProblems(manifest, has) {
  const out = [];
  const migrations = migrationsOf(manifest);
  migrations.forEach((m, i) => {
    const later = migrations.slice(i + 1);
    for (const kind of RENAME_KINDS) {
      const set = has[kind];
      if (!set) continue;
      for (const [from, to] of Object.entries(m[kind])) {
        if (set.has(from)) out.push({ msg: `migrations: ${m.version} renames ${ONE[kind]} "${from}", which this version still defines — a renamed name is gone from the new version` });
        if (!set.has(to) && !later.some((n) => Object.hasOwn(n[kind], to))) {
          out.push({ msg: `migrations: ${m.version} renames ${ONE[kind]} "${from}" to "${to}", which this version does not define` });
        }
      }
    }
  });
  return out;
}
