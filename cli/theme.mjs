#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight theme — install and validate themes that came from somewhere else.
//
//   decklight theme check <file|url>
//   decklight theme add   <file|url> <deck.html> [--name x] [--dry-run]
//
// The distribution mechanism already half-existed: a theme is ONE portable CSS
// file, `⌃⇧T` already downloads a shareable one, `decklight bundle` already
// embeds whatever the deck carries. What was missing is the last mile in both
// directions — a way to prove a file satisfies the contract before sharing it,
// and a way to put someone else's file into a deck without hand-editing HTML.
//
// There is no registry and no version number. The distribution unit is the
// file — a repo, a gist, a download — and compatibility with a runtime IS
// passing that runtime's check. When the contract grows a token, `check` names
// exactly what an older theme is missing.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argReader, isMain } from '../tools/args.mjs';
import { validateTheme, themeNameFrom, validThemeName, REQUIRED } from '../tools/theme-check.mjs';

const USAGE = `usage: decklight theme <check|add> …

  decklight theme check <file|url>
    run the SPEC §5 token contract and the WCAG contrast gates on a theme file
    EXAMPLE: decklight theme check nord-deep.css

  decklight theme add <file|url> <deck.html> [--name <name>] [--dry-run]
    validate a theme, then install it into the deck — it then behaves like a
    shipped one: in the picker under "Added", reachable by , / . and ?theme=,
    and carried by decklight bundle
    EXAMPLE: decklight theme add https://gist.../nord-deep.css talk.html

    --name <name>  install under this name        [the file's, minus .css]
    --dry-run      validate and report; touch nothing

  a theme that does not pass is not installed — a deck cannot be made to carry
  something the shipped set would not be allowed to contain`;

/** The <style> block an installed theme becomes, marked so the runtime groups it. */
export function themeStyleBlock(name, css) {
  // </style> inside a theme's own comment would end the block early. Themes
  // are CSS and have no business containing one, but a downloaded file is
  // somebody else's, and "somebody else's" is exactly when to check.
  const safe = css.replace(/<\/(style)/gi, '<\\/$1');
  return `<style data-theme="${name}" data-theme-added media="not all">\n${safe.trim()}\n</style>`;
}

/** Where an existing block for this name starts and ends, or null. */
export function findThemeBlock(html, name) {
  const re = new RegExp(`<style[^>]*\\bdata-theme=["']${name}["'][^>]*>[\\s\\S]*?<\\/style>`, 'i');
  const m = re.exec(html);
  return m ? { start: m.index, end: m.index + m[0].length, text: m[0] } : null;
}

/**
 * Put the block in the deck: replacing the theme's previous block if it has
 * one (re-adding IS the update path — there is no auto-update), otherwise
 * last in <head> so an active added theme wins the cascade over the deck's
 * link or inline base theme.
 */
export function installTheme(html, name, css) {
  const block = themeStyleBlock(name, css);
  const existing = findThemeBlock(html, name);
  if (existing) {
    return { html: html.slice(0, existing.start) + block + html.slice(existing.end), replaced: true };
  }
  const head = /<\/head>/i.exec(html);
  if (!head) return { html: null, replaced: false };
  return {
    html: html.slice(0, head.index) + block + '\n' + html.slice(head.index),
    replaced: false,
  };
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
      + ' — a theme written against an older contract needs the new ones added (SPEC §5)');
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

  const name = opt('--name') ?? themeNameFrom(source);
  if (!validThemeName(name)) {
    console.error(`decklight theme add: "${name}" is not a usable theme name`);
    console.error('  the runtime only resolves names matching [A-Za-z0-9_-]+ — pass --name to choose one');
    return 1;
  }
  const deckPath = resolve(deck);
  if (!existsSync(deckPath)) { console.error(`decklight theme add: no such deck: ${deck}`); return 1; }

  let css;
  try { css = await fetchTheme(source); } catch (e) { console.error(`decklight theme add: ${e.message}`); return 1; }

  const result = validateTheme(css);
  for (const line of reportLines(name, result)) console.log(line);
  if (!result.ok) {
    console.error(`\ndecklight theme add: ${name} was NOT installed — fix the report above and try again`);
    return 1;
  }

  const html = readFileSync(deckPath, 'utf8');
  const { html: next, replaced } = installTheme(html, name, css);
  if (next === null) { console.error(`decklight theme add: ${deck} has no </head> to install into`); return 1; }

  if (args.includes('--dry-run')) {
    console.log(`would ${replaced ? 'replace' : 'install'} ${name} in ${deck} (${(css.length / 1024).toFixed(1)} KB)`);
    return 0;
  }
  writeFileSync(deckPath, next);
  console.log(`${replaced ? 'replaced' : 'installed'} ${name} in ${deck}`
    + ` — press T and look under "Added"${replaced ? '' : ', or open it with ?theme=' + name}`);
  return 0;
}

export async function themeMain(args = []) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { console.log(USAGE); return sub ? 0 : 1; }
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) { console.log(USAGE); return 0; }
  if (sub === 'check') return checkMain(rest);
  if (sub === 'add') return addMain(rest);
  console.error(`decklight theme: unknown subcommand "${sub}"\n\n${USAGE}`);
  return 1;
}

if (isMain(import.meta.url)) process.exit(await themeMain(process.argv.slice(2)));
