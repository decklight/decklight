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
import os from 'node:os';
import path from 'node:path';

// Imported and re-exported, not redefined: the package root has one
// definition (pkg.mjs), and every bug in this area came from a second one.
// `import` then `export`, not `export … from`, because this module reads
// PKG.version itself and a bare re-export creates no local binding.
import { PKG_ROOT, PKG } from './pkg.mjs';

export { PKG_ROOT, PKG };

/**
 * The authoring contract: SPEC.md up to REPO_LAYOUT, which only matters to
 * Decklight's own contributors. The platform contract (the marketplace and
 * the library's units) lives in PLATFORM.md, which SPEC.md points at and the
 * skill does not install: an agent writing slides rarely needs it, and it
 * was a third of every project's reference.md.
 */
export function referenceDoc() {
  const spec = fs.readFileSync(path.join(PKG_ROOT, 'SPEC.md'), 'utf8');
  const cut = spec.indexOf('\n## REPO_LAYOUT');
  return (cut > 0 ? spec.slice(0, cut) : spec).trimEnd() + '\n';
}

/**
 * The Claude Code SKILL.md — YAML frontmatter Claude indexes on, then a
 * progressive-disclosure body that points at `referenceHref` (a path
 * relative to the SKILL.md) for the full contract.
 */
/**
 * The version a skill was written by, as a comment the file carries — read
 * back by `decklight skills` (a skill older than this build is refreshed
 * without --force) and by write mode's startup (which names one that is
 * older than the install, since an agent reading it reads an old contract).
 */
export const SKILL_STAMP = (version = PKG.version) => `<!-- decklight skill ${version} -->`;
export function skillVersionOf(text) {
  const m = /<!-- decklight skill (\d+\.\d+\.\d+[^\s]*) -->/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

export function claudeSkillMd(referenceHref = 'reference.md') {
  return `---
name: decklight
description: Author and edit Decklight presentations — single-file HTML decks with Keynote-style builds, theme-aware SVG diagrams, 46 built-in themes, a company's design system (its templates, brand themes and roles), truthful terminal recordings, and live TTS narration. Use whenever creating or editing a Decklight deck (a .html file with a <div class="decklight"> of <section> slides) in this project.
---
${SKILL_STAMP()}

Decklight decks are one HTML file of slides: no build step, no bundler. A deck
is \`<div class="decklight">\` containing \`<section>\` slides, plus one JSON
configuration block (\`<script type="application/json" data-decklight-config>\`)
— and nothing that executes: no runtime in the file, no \`Decklight.init\` call.
\`decklight <deck>\` (write mode or \`--no-trust\`) adds the installed runtime as it
serve it, and \`decklight bundle\` embeds it into one self-contained file to hand
over. Write slides and configuration; never write boilerplate.

**Full authoring contract**: read [${referenceHref}](${referenceHref}) in this same
skill directory before authoring or editing a slide — SLIDE_DENSITY is how much goes on
one, COMPARISON_SLIDES is the worked comparison (pros/cons) slide, and past those it covers builds,
speaker notes segmentation ([click]), SLIDE_SOURCES (where a slide got what it says),
SVG diagrams, theming, motion, code
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

A long deck can be split into chapters with \`data-module\` on the section that
starts one — every slide after it belongs to that chapter until the next marker.
The deck shows the current chapter in its chrome and shows them as a foldable
outline in the slide finder (**G**). Use it for a course or a multi-module deck; a
fifteen-slide talk does not need chapters:

\`\`\`html
<section data-module="Foundations"><h2>Foundations</h2></section>
\`\`\`

Two asides, and they are not the same thing. \`notes\` is what the speaker SAYS.
\`sources\` is where the slide got what it says — named facts and links a reader
can follow, hidden on the slide and opened with **I**. Add it when a slide makes
a claim worth attributing; leave it off when it does not:

\`\`\`html
<aside class="sources">
  <dl><dt>owner</dt><dd>platform-team</dd><dt>reviewed</dt><dd>2026-08-14</dd></dl>
  <ul><li><a href="https://…/KIP-98">KIP-98</a> — the original proposal</li></ul>
</aside>
\`\`\`

**Cite as you build.** When a deck is made from material (a PDF, a web page, a
document, a transcript, files in a repository) the user gave you or you looked
up, every slide that states something taken from it gets its \`sources\` aside
**while you write the slide**, not in a pass at the end, when you no longer
know which page a number came from. One link per source the slide stands on:

- **Name the part, not just the source**, whenever the source is bigger than
  what you used: the pages of a PDF (\`report.pdf#page=12\`, note \`pp. 12–14\`),
  the section of a web page (its \`#anchor\`, or a text fragment
  \`#:~:text=first%20words\`), the heading of a document, the lines of a file
  (\`src/server.ts\`, note \`lines 40–88\`), the minutes of a recording. The link
  opens where you read; the note says how much.
- **A local file is linked by its path relative to the deck**, so the link
  still opens after the deck moves with it.
- **Cite only what you actually opened and read.** Never a source you did not
  read, never a page you did not read, and never a link you reconstructed from
  memory. A slide built from your own general knowledge carries no link that
  pretends otherwise: leave it unsourced and say so in the report below.

\`\`\`html
<aside class="sources">
  <ul>
    <li><a href="docs/annual-report-2025.pdf#page=12">Annual report 2025</a> — pp. 12–14, revenue by region</li>
    <li><a href="https://example.com/pricing#enterprise">Pricing page</a> — Enterprise tier only</li>
  </ul>
</aside>
\`\`\`

**Then tell the user what the deck stands on.** When you finish a deck (or a
batch of slides), end your reply with a sources report, so they can check the
deck against its material without opening every slide:

- each source you used, with the parts of it you used (pages, sections,
  headings, lines) and the slides that cite it;
- each source you were given but did not use, and why (off topic, unreadable,
  a scanned PDF with no text layer);
- each slide that makes claims with no source behind it, so the user knows
  which ones rest on your general knowledge.

Keep the report in your reply, not on a slide: the deck already carries the same
facts, per slide, in its \`sources\` asides.

**CLI** (\`npx decklight@latest <command>\`, no install needed):
- \`decklight deck.html\` — the whole authoring loop: serve with live reload; editing is on in the browser — text, pictures, layouts and speaker notes are written back into the file
- \`decklight cast script.term.yaml\` — record a truthful terminal cast in a real PTY, for \`<div class="terminal">\` (this records a TERMINAL; \`decklight narrate --mic\` records the author's voice)
- \`decklight bundle deck.html --themes all\` — flatten into one self-contained file to hand off or publish
- \`decklight pdf deck.html\` — render every slide to a PDF, and report the ones that overflow
- \`decklight pptx deck.html\` — a PowerPoint file for whoever asks for one: every slide a picture, the notes real notes (lossy on purpose)
- \`decklight setup voice\` — set up live narration once (which engine, what it needs); every deck opened after uses it
- \`decklight narrate --mic deck.html\` — record the narration in the author's OWN voice: the deck shows one \`[click]\` beat at a time and \`→\` ends it, writing \`slide-NN-KK.wav\` per beat so the recording paces the builds (play it back with \`narration: { files: 'voiceover', ext: 'wav', segments: true }\`)
- \`decklight deck.html --no-trust\` (M to comment) / \`decklight comments deck.html\` — reviewer comments on slides, stored append-only in \`<deck>.review.jsonl\` and carried by git; a comment records the slide's title and a fingerprint of its text, so it finds its slide again after the deck moves and says so when the slide changed or is gone; \`decklight comments submit deck.html\` pushes the review to a \`review/<you>-<date>\` branch (one file, never the reviewer's own commits; \`--pr\` opens the pull request), and the author hears about waiting reviews at startup in write mode, in the M overlay, and via \`decklight comments deck.html --incoming\`
- \`decklight skills\` — regenerate this skill after upgrading Decklight

**Render the deck before you call a slide done.** Content that exceeds a slide
is clipped, and the runtime marks that section \`data-overflow\` — but only in a
browser. An agent authoring twenty slides in one pass never sees it, and ships
decks whose bottom lines are simply missing. One command checks all of them:

\`\`\`sh
npx decklight@latest pdf deck.html -o /tmp/check.pdf
\`\`\`

Every \`⚠ slide N overflows\` line is a slide losing content: split it, cut it,
or move the detail into the notes. Run it after each batch of slides rather
than once at the end — and note that overflow is the *late* failure. A slide
that fits can still be too crowded to present from; prefer ~3–4 bullets or ~2
short paragraphs per column, and one idea per slide, over anything that merely
fits (SLIDE_DENSITY). \`npx decklight@latest check deck.html\` names those
too: a slide past that budget is reported \`crowded\` with the count that
tipped it (a warning, never a failed run); split it rather than shrink it.

**For a comparison slide, use \`data-layout="split"\` — and do not also write
your own column flexbox.** Two sibling blocks become the columns, a third
becomes a full-width footer. A hand-rolled flex shell inside a section that
also carries \`data-layout="split"\` leaves two layout systems fighting, and the
visible result is the pinned title landing on top of the column headings.
COMPARISON_SLIDES has the markup. The engine marks the mixed state
\`data-split-conflict\` (assertable headlessly, like \`data-overflow\`), and the
same \`decklight pdf\` run above names such slides — one render check catches
both.

**A diagram line that draws is one stroke, with everything on it.** A
\`data-build="draw"\` container draws its strokes in; an arrowhead is a
\`<marker>\` on the stroke's \`marker-end\` (it rides the tip), a dashed line is
\`stroke-dasharray\` on the stroke (it draws dashed, start to finish), and a
line in stages is \`data-draw-stops\`. A separate arrowhead shape, or dashes set
from a stylesheet class, do not draw as one: the head stands at the end before
the line arrives, the dashes snap in when it ends. Group a line with the box it
points at when they should arrive together; keep it a direct child when the
line is its own beat. The engine adds \`.draw-head\` and \`.draw-mask\` nodes
beside a drawing stroke in the browser: they are not in the file, so never
copy them from the rendered DOM into the deck. SVG_DIAGRAMS has the rules.

**On a deck that uses a design system, fill its templates' slots — never
recreate a template's structure by hand.** A slide names a template and
supplies one element per slot (\`<section data-template="acme/section-divider">\`
with \`<h2 data-slot="title">\`); the structure comes from the design system
when the deck renders, so copied markup never updates with it.
\`decklight design-system templates acme@<marketplace>\` lists the templates and
their slots (\`*\` required); \`decklight check\` names a missing template or slot,
a slot filled twice and a required one left empty (DESIGN_SYSTEMS in the reference).

**On a deck held to a design system's brand, colour through its roles.** A
design system that ships a palette and its own themes holds the deck to them
(\`"brandThemesOnly"\` unset): the deck opens only on the brand's themes, and
every colour a slide names is the brand's. When it declares roles, write
\`var(--acme-color-text-accent)\` (\`--<prefix>color-<role>\`, the roles are in
\`design-system.json\`), never a swatch (\`var(--acme-blue-600)\`), the theme
contract (\`var(--accent)\`, \`var(--d-fill-2)\`), one of its other tokens, or a
literal: each theme sets every role, so \`T\` recolours the deck and nothing
drifts off-brand. A diagram fill the contract maps to a role is written as that
role and still nests like its slot. \`decklight check\` says \`off-role\` (a
colour that is not a role, with the nearest one), \`off-palette-literal\` (on a
brand without roles) and \`theme-off-brand\` (a configured theme outside the
brand); \`"brandThemesOnly": false\` is the author's way out, never yours to
add (BRAND_PALETTE and DESIGN_SYSTEM_ROLES in the reference).

Speaker notes drive both live narration and the transcript/caption
features, so write them even for decks that will only ever be read: split
multi-beat notes with a bare \`[click]\` line so narration and build steps
stay in sync (PRESENTING in the reference). Where an idea needs a moment to
land, put \`[pause]\` there (\`[long pause]\` for twice that) and it is never
said: ElevenLabs v4/v3 holds it itself, in its own breath; for every other
voice decklight holds it (two beat pauses, 1s by default). Use it sparingly —
at the few moments that earn it. Write the markers in square brackets; the
older \`<pause>\` and \`⟨PAUSE⟩\` spellings still read the same.
Any other bracketed words — \`[whispers]\`, \`[laughs]\` — are audio tags for
ElevenLabs v4 (the default ElevenLabs model) and v3; every other voice leaves
them out, and captions never show them, so the notes read the same anywhere.

**Prompting ElevenLabs v4 in the notes.** When ElevenLabs narrates, the notes
ARE the prompt ([its best practices](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices#prompting-eleven-v4)):
natural sentences and punctuation do most of the work; a tag goes right before
what it directs (\`[whispers]\`, \`[curious]\`, \`[laughs]\`), suits the voice, and
earns its place, one or two a slide; pauses are \`[pause]\`, never \`<break>\`.
\`decklight enhance deck.html --slides 3\` adds tags with ElevenLabs' own prompt
and writes only answers that kept every word, \`[click]\` and \`[pause]\`. Editing
by hand, follow the same rules: add tags, never reword the author's script.

**Notes are said, not read.** Write them as sentences a person would say out
loud — "And if you fluff a line, just press Backspace to take it again", not
"Fluffed a line? Backspace retakes it." — and say symbols as words ("Command",
not "⌘"). To rewrite terse notes that way when asked, \`decklight enhance
deck.html --spoken --slides 3\` does it with the same checks on the beats and
the pauses.

**Installed marketplace skills sit beside this one.** \`decklight library add
skill <name>\` installs a skill from a marketplace into
\`~/.decklight/skills/<name>/SKILL.md\` (\`$DECKLIGHT_HOME/skills/\` when that is
set) and copies it next to this skill. When a task is one a skill there
describes — migrating a deck to a new major version of its design system, say —
list that directory, read the SKILL.md whose \`description\` fits, and follow
it together with this contract.

**Commit your own changes when an edit server is running.** It snapshots
silently and commits only when told; you are not an agent it started, so
after each logical change:

\`\`\`sh
curl -sf -X POST localhost:8788/deck/edit/commit \\
  -H 'content-type: application/json' -d '{"message":"split the crowded video slides"}'
\`\`\`

A subject for THAT change, never "updated the deck". It commits only the deck
and is a no-op when nothing changed. Nothing listening on the port: skip it
silently, and never start a server yourself.

**That history is readable, and it is how a bad edit is undone.** \`decklight
history deck.html\` lists every commit that touched the deck and marks the ones
that exist only on this machine; \`decklight restore deck.html <hash>\` puts the
deck back — written as a NEW commit, never a rewrite, so restoring is always
safe to try. In the deck itself the same history is \`H\` (a live preview of
every version; \`⏎\` restores after asking). Prefer restore over hand-reverting
your own edits: it is exact, and it keeps the record honest about what
happened.
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
export function agentsSection(referenceHref = '.claude/skills/decklight/reference.md', { librarySkills = [] } = {}) {
  return `${AGENTS_MARKER}
${SKILL_STAMP()}
## Decklight decks

This project contains a Decklight presentation (a single-file HTML deck —
see \`${referenceHref}\` for the full authoring
contract: builds, notes, sources, SVG diagrams, themes, terminals, narration).
Read that file before adding or editing slides.

When slides come from material (PDFs, web pages, documents, files), give each
slide a \`<aside class="sources">\` as you write it, linking the part it uses
(PDF pages via \`#page=N\`, a page section via its anchor, file lines in the
note), cite only what you actually read, and end with a report to the user of
each source, the parts used, the slides citing it, and the slides with none.

After editing slides, render the deck and check nothing is clipped:
\`npx decklight@latest pdf deck.html -o /tmp/check.pdf\` — every \`⚠ slide N overflows\`
line is a slide losing content. Overflow is the late failure, though: a slide
that fits can still be too crowded, so keep to one idea and ~3–4 bullets per
column rather than to whatever renders.

On a deck with a design system, a slide fills a template's slots
(\`<section data-template="acme/section-divider">\` and children carrying
\`data-slot\`, listed by \`decklight design-system templates <ref>\`) and never
recreates its structure by hand; \`decklight check deck.html\` names any slot
or template the design system does not have. On a design system with roles,
every colour is a role (\`var(--acme-color-<role>)\`), never a swatch, a theme
token or a literal; \`check\` names each one that is not (\`off-role\`).

When the deck is open in write mode (\`decklight deck.html\`), commit each logical
change you finish rather than leaving it to the timer's generic \`autosave\`:
\`curl -sf -X POST localhost:8788/deck/edit/commit -H 'content-type: application/json'
-d '{"message":"what this change did"}'\`. No server listening means no
authoring session — skip it and carry on.

${librarySkillLines(librarySkills)}Hit a Decklight bug? Run \`npx decklight@latest report-bug\` for the environment
facts, then ask the user what happened, what they expected, and the smallest
repro — and show them the whole issue before filing anything.
${AGENTS_MARKER}
`;
}

/** A path as an agent should read it on this machine: `~/…` under $HOME. */
export function homePath(file) {
  const home = os.homedir();
  return home && file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

/**
 * The installed marketplace skills (`librarySkills` in units.mjs), one line
 * each, for an agent that reads AGENTS.md and nothing else (#880): no
 * directory of skills is indexed for it, so the line is the only way it
 * learns one exists. Nothing installed, no paragraph.
 */
function librarySkillLines(skills) {
  if (!skills.length) return '';
  // `- <name>: <description> Read <path>.` — a description is a sentence of its own
  const sentence = (d) => (d ? `${d.replace(/\s+/g, ' ').trim()}${/[.!?]$/.test(d.trim()) ? '' : '.'} ` : '');
  const lines = skills.map((s) => `- ${s.name}: ${sentence(s.description)}Read \`${homePath(path.join(s.path, 'SKILL.md'))}\`.`);
  return `Installed marketplace skills (\`decklight library add skill\`). Before a task
one of them describes, read its SKILL.md and follow it:
${lines.join('\n')}

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
${SKILL_STAMP()}

Help the user file a bug report against Decklight that a triager can act on
without a round trip. Work in this order.

**1. Collect the machine facts.** Run \`npx decklight@latest report-bug\`. It prints a
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
