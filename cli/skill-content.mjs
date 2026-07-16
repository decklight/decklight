// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The Decklight authoring skill's *content*, in one place: the reference
 * doc (sliced from SPEC.md), the Claude SKILL.md body, and the AGENTS.md
 * section. `init` and `skills` both render these — the deck scaffolder and
 * the standalone skill installer must hand every agent the same contract,
 * so they share the source rather than each carrying a copy that can drift.
 *
 * The reference is derived from the installed version's SPEC.md, so it
 * always matches the runtime that produced it — an agent should trust it
 * over prior training.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(here, '..');
export const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

/**
 * The authoring contract, sliced from SPEC.md through §9 (everything an
 * agent needs to write slides), dropping the repo-layout/tooling section
 * that only matters to Decklight's own contributors.
 */
export function referenceDoc() {
  const spec = fs.readFileSync(path.join(PKG_ROOT, 'SPEC.md'), 'utf8');
  const cut = spec.indexOf('\n## 10. Repository layout & tooling');
  return (cut > 0 ? spec.slice(0, cut) : spec).trimEnd() + '\n';
}

/**
 * The Claude Code SKILL.md — YAML frontmatter Claude indexes on, then a
 * progressive-disclosure body that points at `referenceHref` (a path
 * relative to the SKILL.md) for the full contract.
 */
export function claudeSkillMd(referenceHref = 'reference.md') {
  return `---
name: decklight
description: Author and edit Decklight presentations — single-file HTML decks with Keynote-style builds, theme-aware SVG diagrams, 61 built-in themes, truthful terminal recordings, and live TTS narration. Use whenever creating or editing a Decklight deck (a .html file with a <div class="decklight"> of <section> slides) in this project.
---

Decklight decks are one HTML file: no build step, no bundler, no server to
author. A deck is \`<div class="decklight">\` containing \`<section>\` slides;
the runtime is one JS file + one CSS file + one theme CSS file.

**Full authoring contract**: read [${referenceHref}](${referenceHref}) in this same
skill directory before authoring or editing a slide — it covers builds,
speaker notes segmentation (⟨CLICK⟩), SVG diagrams, theming, motion, code
blocks, LaTeX math, terminal recordings, narration, and the public JS API. It's sliced
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
- \`decklight skills\` — regenerate this skill after upgrading Decklight

Speaker notes drive both live narration and the transcript/caption
features, so write them even for decks that will only ever be read: split
multi-beat notes with a bare \`⟨CLICK⟩\` line so narration and build steps
stay in sync (§8 in the reference).
`;
}

export const AGENTS_MARKER = '<!-- decklight:skill -->';

/**
 * The marked AGENTS.md block every AGENTS.md-reading agent (Codex,
 * OpenCode, IBM Bob, …) shares. `referenceHref` is where that agent
 * should look for the full contract, relative to the repo root. The
 * marker pair lets `init`/`skills` refresh the block in place instead of
 * appending a duplicate.
 */
export function agentsSection(referenceHref = '.claude/skills/decklight/reference.md') {
  return `${AGENTS_MARKER}
## Decklight decks

This project contains a Decklight presentation (a single-file HTML deck —
see \`${referenceHref}\` for the full authoring
contract: builds, notes, SVG diagrams, themes, terminals, narration).
Read that file before adding or editing slides.
${AGENTS_MARKER}
`;
}
