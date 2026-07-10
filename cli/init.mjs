#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight init — scaffold a starter deck, plus an agent skill so Claude
 * Code (and any AGENTS.md-reading agent) knows the authoring contract
 * without a web search or a guess from Reveal.js memory.
 *
 *   decklight init ["My Deck"] [-o deck.html] [--dir path] [--themes …] [--force] [--no-skill]
 *
 * The deck is fully self-contained (runtime + every theme inlined, like
 * `decklight bundle --themes all` produces) — double-click it, it presents,
 * no sibling files, and the in-deck picker is fully stocked. Pass --themes to
 * ship a narrower set. The skill is regenerated every run (it's derived, not
 * authored content) so re-running after an upgrade refreshes it; the deck
 * file is only touched with --force.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(here, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

function fail(msg) {
  process.stderr.write(`decklight init: ${msg}\n`);
  process.exit(1);
}

const scriptSafe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\u0021--');

// aurora is the deck's starting look; init ships every theme by default so the
// in-deck picker (/ → themes) is fully stocked, unless --themes narrows it.
const STARTER_THEME = 'aurora';
const THEMES_DIR = path.join(PKG_ROOT, 'themes');

// 'all' → every shipped theme; otherwise a comma list of names (validated).
function resolveThemes(sel) {
  if (sel === 'all') {
    return fs.readdirSync(THEMES_DIR)
      .filter((f) => f.endsWith('.css'))
      .map((f) => f.slice(0, -4))
      .sort();
  }
  const names = sel.split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) fail('--themes: no theme names given');
  for (const n of names) {
    if (!fs.existsSync(path.join(THEMES_DIR, `${n}.css`))) {
      fail(`--themes: theme not found: ${n} (see themes/ for the full list)`);
    }
  }
  return names;
}

function starterDeck(title, themeNames, activeTheme) {
  const css = fs.readFileSync(path.join(PKG_ROOT, 'dist/decklight.css'), 'utf8');
  // one <style data-theme> per theme; only the active one applies (the rest
  // carry media="not all", which the runtime's inline-theme mode toggles).
  const themeBlocks = themeNames.map((name) => {
    const theme = fs.readFileSync(path.join(THEMES_DIR, `${name}.css`), 'utf8');
    const media = name === activeTheme ? '' : ' media="not all"';
    return `  <style data-theme="${name}"${media}>\n${theme}\n  </style>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
${css}
  </style>
${themeBlocks}
</head>
<body>
  <div class="decklight">

    <section>
      <h1>${title}</h1>
      <p>Made with Decklight — press → to advance, ? for every key</p>
      <aside class="notes">
        <p>Welcome. This is the title slide — say a line or two about what this deck covers.</p>
      </aside>
    </section>

    <section>
      <h2>A slide with a build</h2>
      <ul data-build="fade-up">
        <li>One attribute on the container: <code>data-build</code></li>
        <li>Each direct child becomes one build step, in document order</li>
        <li>Speaker notes segment with ⟨CLICK⟩ to match — see below</li>
      </ul>
      <aside class="notes">
        <p>The container opts in and the engine does the rest — not a single class on the items themselves.</p>
        <p>⟨CLICK⟩</p>
        <p>Every press of the arrow reveals the next one, in order.</p>
        <p>⟨CLICK⟩</p>
        <p>And that's it — replace this slide's content, duplicate the section for more, and you have a deck.</p>
      </aside>
    </section>

  </div>
  <script>${scriptSafe(fs.readFileSync(path.join(PKG_ROOT, 'dist/decklight.js'), 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, ''))}</script>
  <script>Decklight.init({});</script>
</body>
</html>
`;
}

function specSlice() {
  const spec = fs.readFileSync(path.join(PKG_ROOT, 'SPEC.md'), 'utf8');
  const cut = spec.indexOf('\n## 10. Repository layout & tooling');
  return (cut > 0 ? spec.slice(0, cut) : spec).trimEnd() + '\n';
}

function skillMd() {
  return `---
name: decklight
description: Author and edit Decklight presentations — single-file HTML decks with Keynote-style builds, theme-aware SVG diagrams, 61 built-in themes, truthful terminal recordings, and live TTS narration. Use whenever creating or editing a Decklight deck (a .html file with a <div class="decklight"> of <section> slides) in this project.
---

Decklight decks are one HTML file: no build step, no bundler, no server to
author. A deck is \`<div class="decklight">\` containing \`<section>\` slides;
the runtime is one JS file + one CSS file + one theme CSS file.

**Full authoring contract**: read [reference.md](reference.md) in this same
skill directory before authoring or editing a slide — it covers builds,
speaker notes segmentation (⟨CLICK⟩), SVG diagrams, theming, motion, code
blocks, terminal recordings, narration, and the public JS API. It's sliced
straight from Decklight's SPEC.md (v${PKG.version}), so it won't drift from
the installed runtime's actual behavior — trust it over prior training.

**Minimal skeleton** (see \`deck.html\` in this project for a worked example
with a build and notes already wired):

\`\`\`html
<div class="decklight">
  <section>
    <h1>Title</h1>
    <aside class="notes"><p>What you'd say on this slide.</p></aside>
  </section>
</div>
\`\`\`

**CLI** (\`npx decklight <command>\`, no install needed):
- \`decklight edit deck.html\` — serve with live reload; **E** in the browser edits speaker notes back into the file
- \`decklight rec script.term.yaml\` — record a truthful terminal cast in a real PTY, for \`<div class="terminal">\`
- \`decklight bundle deck.html --themes all\` — flatten into one self-contained file to hand off or publish
- \`decklight tts\` — live voice bridge so the deck can narrate itself on the fly
- \`decklight init\` — regenerate this skill after upgrading Decklight (deck file untouched unless \`--force\`)

Speaker notes drive both live narration and the transcript/caption
features, so write them even for decks that will only ever be read: split
multi-beat notes with a bare \`⟨CLICK⟩\` line so narration and build steps
stay in sync (§8 in the reference).
`;
}

const AGENTS_MARKER = '<!-- decklight:skill -->';

function agentsSection() {
  return `${AGENTS_MARKER}
## Decklight decks

This project contains a Decklight presentation (a single-file HTML deck —
see \`.claude/skills/decklight/reference.md\` for the full authoring
contract: builds, notes, SVG diagrams, themes, terminals, narration).
Read that file before adding or editing slides.
${AGENTS_MARKER}
`;
}

export async function initMain(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`decklight init — scaffold a starter deck + agent skill

Usage:
  decklight init ["Deck Title"] [-o deck.html] [--dir path] [--themes …] [--force] [--no-skill]

Options:
  -o <file>       deck output path (default: deck.html)
  --dir <path>    target directory (default: current directory)
  --themes <sel>  which themes to inline into the deck:
                    all           every shipped theme (default)
                    name,name,…   an explicit list (aurora stays active when
                                  included, else the first listed)
  --force         overwrite an existing deck file (default: refuses)
  --no-skill      skip .claude/skills/decklight/ and AGENTS.md

Always writes/refreshes the skill files (they're generated from the
installed version's SPEC.md, so re-running after an upgrade updates them)
unless --no-skill is given. The deck file is only touched with --force.
`);
    process.exit(0);
  }

  let title = null, outFile = 'deck.html', dir = '.', force = false, withSkill = true, themesSel = 'all';
  const args = [...argv];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o') outFile = args[++i];
    else if (a === '--dir') dir = args[++i];
    else if (a === '--themes') themesSel = args[++i];
    else if (a === '--force') force = true;
    else if (a === '--no-skill') withSkill = false;
    else if (!a.startsWith('-')) title = title ?? a;
    else fail(`unknown argument: ${a}`);
  }
  title = title || 'My Deck';
  const themeNames = resolveThemes(themesSel);
  const activeTheme = themeNames.includes(STARTER_THEME) ? STARTER_THEME : themeNames[0];

  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });

  const deckPath = path.resolve(root, outFile);
  if (fs.existsSync(deckPath) && !force) {
    fail(`${path.relative('.', deckPath) || outFile} already exists — pass --force to overwrite`);
  }
  fs.writeFileSync(deckPath, starterDeck(title, themeNames, activeTheme));
  const themeNote = themeNames.length === 1
    ? `theme: ${themeNames[0]}`
    : `${themeNames.length} themes, ${activeTheme} active`;
  process.stdout.write(`created ${path.relative('.', deckPath) || outFile} (${themeNote})\n`);

  if (!withSkill) return;

  const skillDir = path.join(root, '.claude', 'skills', 'decklight');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd());
  fs.writeFileSync(path.join(skillDir, 'reference.md'), specSlice());
  process.stdout.write(`wrote .claude/skills/decklight/{SKILL.md,reference.md} (v${PKG.version})\n`);

  const agentsPath = path.join(root, 'AGENTS.md');
  const section = agentsSection();
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, `# Agent notes\n\n${section}`);
    process.stdout.write('created AGENTS.md\n');
  } else {
    const existing = fs.readFileSync(agentsPath, 'utf8');
    const markerRe = new RegExp(`${AGENTS_MARKER}[\\s\\S]*?${AGENTS_MARKER}\\n?`);
    if (markerRe.test(existing)) {
      fs.writeFileSync(agentsPath, existing.replace(markerRe, section));
      process.stdout.write('refreshed the Decklight section in AGENTS.md\n');
    } else {
      fs.writeFileSync(agentsPath, existing.replace(/\n*$/, '\n\n') + section);
      process.stdout.write('appended a Decklight section to AGENTS.md\n');
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await initMain();
