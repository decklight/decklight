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
skill directory before authoring or editing a slide — §1.1 is how much goes on
one, §1.2 is the worked comparison (pros/cons) slide, and past those it covers builds,
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
- \`decklight pdf deck.html\` — render every slide to a PDF, and report the ones that overflow
- \`decklight tts\` — live voice bridge so the deck can narrate itself on the fly
- \`decklight skills\` — regenerate this skill after upgrading Decklight

**Render the deck before you call a slide done.** Content that exceeds a slide
is clipped, and the runtime marks that section \`data-overflow\` — but only in a
browser. An agent authoring twenty slides in one pass never sees it, and ships
decks whose bottom lines are simply missing. One command checks all of them:

\`\`\`sh
npx decklight pdf deck.html -o /tmp/check.pdf
\`\`\`

Every \`⚠ slide N overflows\` line is a slide losing content: split it, cut it,
or move the detail into the notes. Run it after each batch of slides rather
than once at the end — and note that overflow is the *late* failure. A slide
that fits can still be too crowded to present from; prefer ~3–4 bullets or ~2
short paragraphs per column, and one idea per slide, over anything that merely
fits (§1.1).

**For a comparison slide, use \`data-layout="split"\` — and do not also write
your own column flexbox.** Two sibling blocks become the columns, a third
becomes a full-width footer. A hand-rolled flex shell inside a section that
also carries \`data-layout="split"\` leaves two layout systems fighting, and the
visible result is the pinned title landing on top of the column headings.
§1.2 has the markup.

Speaker notes drive both live narration and the transcript/caption
features, so write them even for decks that will only ever be read: split
multi-beat notes with a bare \`⟨CLICK⟩\` line so narration and build steps
stay in sync (§8 in the reference).

**Commit your own changes when a dev server is running.** \`decklight dev\` /
\`edit\` auto-commits the deck, but on a timer and under a generic \`autosave\`
message — it cannot tell your edits from anyone else's, because it did not
start you. When you finish one logical change, say so:

\`\`\`sh
curl -sf -X POST localhost:8788/edit/commit \\
  -H 'content-type: application/json' \\
  -d '{"message":"split the crowded video slides"}'
\`\`\`

One call per logical change, with a subject describing THAT change — not
\"updated the deck\". It commits only the deck file, and does nothing when
nothing changed, so an extra call is harmless. If the port is not listening
there is no dev server: skip it silently and carry on, never start one
yourself. This is what makes a history someone can read afterwards, instead
of a wall of identical timer commits.
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

After editing slides, render the deck and check nothing is clipped:
\`npx decklight pdf deck.html -o /tmp/check.pdf\` — every \`⚠ slide N overflows\`
line is a slide losing content. Overflow is the late failure, though: a slide
that fits can still be too crowded, so keep to one idea and ~3–4 bullets per
column rather than to whatever renders.

When a dev server is running (\`decklight dev\`), commit each logical change
you finish rather than leaving it to the timer's generic \`autosave\`:
\`curl -sf -X POST localhost:8788/edit/commit -H 'content-type: application/json'
-d '{"message":"what this change did"}'\`. No server listening means no dev
session — skip it and carry on.

Hit a Decklight bug? Run \`npx decklight report-bug\` for the environment
facts, then ask the user what happened, what they expected, and the smallest
repro — and show them the whole issue before filing anything.
${AGENTS_MARKER}
`;
}

/**
 * The `decklight-report-bug` skill (#73): the conversational half of filing a
 * bug, which the print-and-exit CLI deliberately does not do.
 *
 * Two consent gates are the point of this text, not decoration. A screenshot
 * here is a HEADLESS RENDER of a deck file the user names — never a capture of
 * their screen — and a public issue publishes whatever slide it shows, so the
 * user has to say yes knowing both. And nothing is filed until they have seen
 * the whole body. An agent that quietly attaches a slide or opens an issue on
 * someone's behalf has done something they cannot take back.
 */
export function reportBugSkillMd() {
  return `---
name: decklight-report-bug
description: File a Decklight bug report — gather version and environment facts, ask what broke and how to reproduce it, optionally attach a headless screenshot, and open the issue only after the user approves the full text. Use when the user hits a Decklight bug or asks to report one.
---

Help the user file a bug report against Decklight that a triager can act on
without a round trip. Work in this order.

**1. Collect the machine facts.** Run \`npx decklight report-bug\`. It prints a
markdown environment block and the issues URL and does nothing else — no
network, nothing sent. Use its output verbatim; do not retype it from memory.

**2. Ask what the command cannot know.** Three questions:
- what happened (ask for any error output **verbatim** — paraphrased errors
  cost a round trip)
- what they expected instead
- the smallest deck and keypresses that reproduce it

**3. Offer a screenshot — and be exact about what one is.** Before capturing
anything, say plainly that it would be a **headless render of the deck file
they name**, produced with \`node tools/shot.mjs <deck> -o .shots/bug.png\`, and
**never a capture of their screen**; and that a public issue **publishes that
slide's content**, so a deck with anything confidential on it should not be
attached. No explicit yes means no screenshot — continue without one, it is
optional. If Chrome is not available (the environment block says so), skip
this step with a note rather than treating it as an error. When a shot is
taken, show the user the saved PNG **before** anything else happens.

**4. Show the whole issue, then ask.** Assemble the title, what happened, what
was expected, the repro, and the environment block, and show the user the
**complete** text. File it only on an explicit yes:
- \`gh issue create --repo decklight/decklight\` when \`gh\` is authenticated
- otherwise hand them the new-issue URL and the body to paste

GitHub has no supported CLI path for attaching an image to an issue, so a
screenshot cannot ride either route: finish by pointing at the saved PNG and
telling them to drag it into the issue.

**Say what has and has not been sent.** If the user declines at any gate, tell
them plainly that nothing was uploaded and nothing was filed.
`;
}
