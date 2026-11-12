#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight vscode — help an editor help the author.
 *
 *   decklight vscode [dir | deck.html] [--print]
 *
 * Writes a `.vscode/` folder beside the deck: VS Code's HTML custom data, so
 * typing `data-` completes `data-build`, `data-layout` and the rest with
 * their values and a line on each, and a snippets file (a slide, a build
 * list, notes with [click] markers, a diagram, a chart, a comparison slide).
 * `decklight init --vscode` writes the same.
 *
 * GENERATED WHEN WRITTEN, never committed as copies: both files are made from
 * tools/vocabulary.mjs, the one table `decklight check` and the Check deck
 * panel read, at the moment they are written, its words described by
 * cli/vocabulary-docs.mjs (kept out of the runtime bundle). So they say what the installed
 * Decklight reads, and re-running after an upgrade refreshes them.
 *
 * `.vscode/settings.json` is the person's. It is never overwritten: the one
 * key, `html.customData`, is added in place (comments and the rest of the file
 * untouched), or, when it cannot be added safely, the line to add is said.
 *
 * NO JSON SCHEMA FOR THE CONFIGURATION BLOCK. The block lives in a `<script
 * type="application/json">` inside the deck, and VS Code applies a JSON schema
 * to JSON files, not to JSON embedded in HTML: a schema would validate
 * nothing where the author types. `decklight check` (config-json, config-key,
 * config-value) is what reads the block, and the custom data's hover on
 * `data-decklight-config` lists its keys.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ATTRIBUTES, CONFIG_KEYS, attributeEntry } from '../tools/vocabulary.mjs';
import { ATTRIBUTE_DOCS, CONFIG_DOCS } from './vocabulary-docs.mjs';
import { PKG } from './skill-content.mjs';
import { isMain } from '../tools/args.mjs';
import { CommandError, runMain } from './util.mjs';

export const DATA_FILE = 'decklight.html-data.json';
export const SNIPPETS_FILE = 'decklight.code-snippets';
/** What `html.customData` names: relative to the folder VS Code opened. */
export const DATA_REF = `./.vscode/${DATA_FILE}`;

// ── the custom data ──────────────────────────────────────────────────────────

const where = (on) => (!on ? '' : /^[a-z]+$/.test(on) ? `On \`<${on}>\`. ` : `On a ${on}. `);

/**
 * VS Code's HTML custom data (version 1.1): every authored attribute as a
 * global attribute, its values when it takes an enumeration, `valueSet: "v"`
 * when it takes none. Global rather than per-tag, so a `data-build` completes
 * on any element, which is where it may go; the description says where an
 * attribute belongs when that matters.
 */
export function customData() {
  return {
    version: 1.1,
    globalAttributes: ATTRIBUTES.map((a) => {
      const keys = a.name === 'data-decklight-config'
        ? `\n\nKeys:\n${CONFIG_KEYS.map((k) => `- \`${k.name}\`: ${CONFIG_DOCS[k.name]}`).join('\n')}` : '';
      const doc = ATTRIBUTE_DOCS[a.name];
      return {
        name: a.name,
        description: { kind: 'markdown', value: `${where(doc.on)}${doc.desc}${keys}` },
        ...(a.values ? { values: a.values.map((v) => ({ name: v })) }
          : a.bare && !a.number ? { valueSet: 'v' } : {}),
      };
    }),
  };
}

// ── the snippets ─────────────────────────────────────────────────────────────

/** `${n|a,b,c|}`: a placeholder that offers the table's values for `name`. */
const choice = (n, name) => `\${${n}|${attributeEntry(name).values.join(',')}|}`;

/**
 * Each snippet's markup, as the reference writes it (SPEC DECK_ANATOMY,
 * BUILDS, SVG_DIAGRAMS, CHARTS, COMPARISON_SLIDES). test/editor-support.test.mjs
 * expands every one into a deck and runs `decklight check` on it.
 */
export function snippets() {
  const s = (prefix, description, body) => ({ prefix, description, scope: 'html', body: body.split('\n') });
  return {
    'Decklight slide': s('dl-slide', 'A slide: a title, one point, and what you say over it.', `<section>
  <h2>\${1:The point of this slide}</h2>
  <p>\${2:One thing, said plainly.}</p>
  <aside class="notes">\${3:What you say while it is up.}</aside>
</section>$0`),
    'Decklight build list': s('dl-build', 'A list that builds: one item per click.', `<ul data-build="${choice(1, 'data-build')}">
  <li>\${2:First point}</li>
  <li>\${3:Second point}</li>
  <li>\${4:Third point}</li>
</ul>$0`),
    'Decklight notes': s('dl-notes', 'Speaker notes with [click] markers: one per build step, words before the first said on arrival.', `<aside class="notes">
  \${1:Said as the slide arrives.}
  [click] \${2:Said as the first build lands.}
  [click] \${3:Said as the second lands.}
  [click] \${4:Said as the third lands.}
</aside>$0`),
    'Decklight diagram': s('dl-diagram', 'An SVG diagram in theme colours that draws in: two boxes and the wire that joins them.', `<svg viewBox="0 0 640 220" role="img" aria-label="\${1:Client calls the API}" data-build="draw">
  <defs>
    <marker id="\${2:arrow}" markerWidth="6" markerHeight="4" refX="5" refY="2" orient="auto">
      <polygon points="0 0, 6 2, 0 4" fill="var(--d-stroke)"/>
    </marker>
  </defs>
  <g data-node="\${3:client}">
    <rect x="40" y="70" width="180" height="80" rx="10" fill="var(--d-fill-1)" stroke="var(--d-stroke)" stroke-width="2"/>
    <text x="130" y="117" text-anchor="middle" font-size="22" fill="var(--d-text)">\${4:Client}</text>
  </g>
  <g data-node="\${5:api}">
    <rect x="420" y="70" width="180" height="80" rx="10" fill="var(--d-fill-2)" stroke="var(--d-stroke)" stroke-width="2"/>
    <text x="510" y="117" text-anchor="middle" font-size="22" fill="var(--d-text)">\${6:API}</text>
  </g>
  <line x1="220" y1="110" x2="420" y2="110" data-from="\${3}" data-to="\${5}" data-route="${choice(7, 'data-route')}"
        stroke="var(--d-stroke)" stroke-width="2" marker-end="url(#\${2})"/>
</svg>$0`),
    'Decklight chart': s('dl-chart', 'A chart drawn from data, in theme colours, one series per click.', `<div class="chart" data-chart="${choice(1, 'data-chart')}" data-title="\${2:Latency by release}" data-build="draw">
  <script type="application/json">
  { "labels": ["v1", "v2", "v3"],
    "series": [ { "name": "\${3:p50}", "data": [120, 80, 45] },
                { "name": "\${4:p99}", "data": [340, 260, 190] } ] }
  </script>
</div>$0`),
    'Decklight comparison slide': s('dl-compare', 'Two columns side by side and a footer under both (COMPARISON_SLIDES).', `<section data-layout="split">
  <h2>\${1:This or that}</h2>

  <div>
    <h3>\${2:Pros}</h3>
    <ul><li>\${3:One}</li><li>\${4:Two}</li></ul>
  </div>

  <div>
    <h3>\${5:Cons}</h3>
    <ul><li>\${6:One}</li><li>\${7:Two}</li></ul>
  </div>

  <p>\${8:A line that applies to both.}</p>

  <aside class="notes">\${9:Pros first, then the two that bite.}</aside>
</section>$0`),
  };
}

/** The snippets file: JSON with a first line saying where it came from. */
export const snippetsText = () => `// Decklight ${PKG.version} snippets, generated by \`decklight vscode\`: run it again after an upgrade to refresh them.\n`
  + `${JSON.stringify(snippets(), null, 2)}\n`;

/**
 * A snippet as it lands with every placeholder taken at its default: the
 * first value of a choice, the words of a `${n:words}`, a bare `${n}` as what
 * its number said first, and `$0` as nothing.
 */
export function expandSnippet(body) {
  const text = Array.isArray(body) ? body.join('\n') : String(body);
  const said = {};
  const out = text
    .replace(/\$\{(\d+)\|([^|]*)\|\}/g, (_, n, opts) => (said[n] = opts.split(',')[0]))
    .replace(/\$\{(\d+):([^}]*)\}/g, (_, n, words) => (said[n] = words));
  return out.replace(/\$\{(\d+)\}/g, (_, n) => said[n] ?? '').replace(/\$0/g, '');
}

// ── settings.json, merged and never overwritten ─────────────────────────────

/**
 * `text` with its comments and its trailing commas blanked to spaces, so it
 * parses as JSON and every offset still points where it did. VS Code reads
 * settings.json as JSON with comments; this reads it the same way.
 */
export function maskJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop - 1;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, ' $1');
}

/**
 * `.vscode/settings.json` with `html.customData` naming the data file, as
 * `{ text, did }`: `created` (no file), `added` (the key put in at the top of
 * the object, nothing else touched), `present` (it already names the file:
 * `text` unchanged), or `manual` with `text` null and `say` the line to add,
 * when the file has its own list there or cannot be read as JSON.
 */
export function mergeSettings(existing, ref = DATA_REF) {
  const line = `"html.customData": ["${ref}"]`;
  if (existing == null || !existing.trim()) return { did: 'created', text: `{\n  ${line}\n}\n` };
  const masked = maskJsonc(existing);
  let parsed;
  try { parsed = JSON.parse(masked); } catch { parsed = undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { did: 'manual', text: null, say: `add ${line} to it (it does not read as a JSON object)` };
  }
  const have = parsed['html.customData'];
  if (have !== undefined) {
    if (Array.isArray(have) && have.includes(ref)) return { did: 'present', text: existing };
    return { did: 'manual', text: null, say: `add "${ref}" to its "html.customData" list` };
  }
  const brace = masked.indexOf('{');
  const empty = !Object.keys(parsed).length;
  const indent = /\n([ \t]+)\S/.exec(existing.slice(brace))?.[1] ?? '  ';
  const text = `${existing.slice(0, brace + 1)}\n${indent}${line}${empty ? '\n' : ','}${existing.slice(brace + 1)}`;
  return { did: 'added', text };
}

// ── writing them ─────────────────────────────────────────────────────────────

/**
 * Write the editor support into `<root>/.vscode/`: the data file and the
 * snippets always (they are generated, so a refresh is the point), and the
 * one settings key merged. Returns the lines to say, in order.
 */
export function writeEditorSupport(root) {
  const dir = path.join(root, '.vscode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, DATA_FILE), `${JSON.stringify(customData(), null, 2)}\n`);
  fs.writeFileSync(path.join(dir, SNIPPETS_FILE), snippetsText());
  const lines = [`wrote .vscode/${DATA_FILE} and .vscode/${SNIPPETS_FILE} (v${PKG.version}): data-* completions, and dl- snippets`];
  const settings = path.join(dir, 'settings.json');
  const had = fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null;
  const merged = mergeSettings(had);
  if (merged.did === 'created' || merged.did === 'added') fs.writeFileSync(settings, merged.text);
  lines.push({
    created: 'wrote .vscode/settings.json: html.customData points VS Code at the completions',
    added: 'added html.customData to .vscode/settings.json, the rest of it as it was',
    present: '.vscode/settings.json already points VS Code at the completions',
    manual: `.vscode/settings.json is yours and was left as it is: ${merged.say}`,
  }[merged.did]);
  return lines;
}

const USAGE = `usage: decklight vscode [dir | deck.html]
  writes .vscode/ beside the deck, so VS Code helps you write it:
    ${DATA_FILE}    typing data- completes data-build, data-layout and
                                the rest, with their values and a line on each
    ${SNIPPETS_FILE}     dl-slide, dl-build, dl-notes, dl-diagram,
                                dl-chart, dl-compare
    settings.json               html.customData added, the rest of the file
                                kept (a list of your own there: the line to
                                add is said)
  Both files are generated from the Decklight installed here: run it again
  after an upgrade. decklight init --vscode writes the same for a new deck.`;

export async function vscodeMain(args = []) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const unknown = args.filter((a) => a.startsWith('-'));
  if (unknown.length) throw new CommandError(`unknown option ${unknown[0]}\n\n${USAGE}`);
  const target = path.resolve(args[0] ?? '.');
  if (args.length > 1) throw new CommandError(`one folder or deck at a time\n\n${USAGE}`);
  const root = fs.existsSync(target) && fs.statSync(target).isFile() ? path.dirname(target) : target;
  if (!fs.existsSync(root)) throw new CommandError(`no such folder: ${args[0]}`);
  for (const line of writeEditorSupport(root)) console.log(line);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await runMain('vscode', vscodeMain);
