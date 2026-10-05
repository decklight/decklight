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

// Imported and re-exported, not redefined: the package root has one
// definition (pkg.mjs), and every bug in this area came from a second one.
// `import` then `export`, not `export … from`, because this module reads
// PKG.version itself and a bare re-export creates no local binding.
import { PKG_ROOT, PKG } from './pkg.mjs';

export { PKG_ROOT, PKG };

/**
 * The authoring contract, sliced from SPEC.md through JS_API (everything an
 * agent needs to write slides), dropping the repo-layout/tooling section
 * that only matters to Decklight's own contributors.
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
export function claudeSkillMd(referenceHref = 'reference.md') {
  return `---
name: decklight
description: Author and edit Decklight presentations — single-file HTML decks with Keynote-style builds, theme-aware SVG diagrams, 46 built-in themes, truthful terminal recordings, and live TTS narration. Use whenever creating or editing a Decklight deck (a .html file with a <div class="decklight"> of <section> slides) in this project.
---

Decklight decks are one HTML file of slides: no build step, no bundler. A deck
is \`<div class="decklight">\` containing \`<section>\` slides, plus one JSON
configuration block (\`<script type="application/json" data-decklight-config>\`)
— and nothing that executes: no runtime in the file, no \`Decklight.init\` call.
\`decklight <deck>\` (write mode or \`--read-only\`) adds the installed runtime as it
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

**CLI** (\`npx decklight@latest <command>\`, no install needed):
- \`decklight deck.html\` — the whole authoring loop: serve with live reload; **E** in the browser edits speaker notes back into the file
- \`decklight cast script.term.yaml\` — record a truthful terminal cast in a real PTY, for \`<div class="terminal">\` (this records a TERMINAL; \`decklight record\` records the author's voice)
- \`decklight bundle deck.html --themes all\` — flatten into one self-contained file to hand off or publish
- \`decklight pdf deck.html\` — render every slide to a PDF, and report the ones that overflow
- \`decklight pptx deck.html\` — a PowerPoint file for whoever asks for one: every slide a picture, the notes real notes (lossy on purpose)
- \`decklight tts\` — live voice bridge so the deck can narrate itself on the fly
- \`decklight record deck.html\` — record the narration in the author's OWN voice: the deck shows one \`[click]\` beat at a time and \`→\` ends it, writing \`slide-NN-KK.wav\` per beat so the recording paces the builds (play it back with \`narration: { files: 'voiceover', ext: 'wav', segments: true }\`)
- \`decklight deck.html --read-only\` (M to comment) / \`decklight comments deck.html\` — reviewer comments on slides, stored append-only in \`<deck>.review.jsonl\` and carried by git; a comment records the slide's title and a fingerprint of its text, so it finds its slide again after the deck moves and says so when the slide changed or is gone; \`decklight comments submit deck.html\` pushes the review to a \`review/<you>-<date>\` branch (one file, never the reviewer's own commits; \`--pr\` opens the pull request), and the author hears about waiting reviews at \`decklight author\` startup, in the M overlay, and via \`decklight comments deck.html --incoming\`
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
fits (SLIDE_DENSITY).

**For a comparison slide, use \`data-layout="split"\` — and do not also write
your own column flexbox.** Two sibling blocks become the columns, a third
becomes a full-width footer. A hand-rolled flex shell inside a section that
also carries \`data-layout="split"\` leaves two layout systems fighting, and the
visible result is the pinned title landing on top of the column headings.
COMPARISON_SLIDES has the markup. The engine marks the mixed state
\`data-split-conflict\` (assertable headlessly, like \`data-overflow\`), and the
same \`decklight pdf\` run above names such slides — one render check catches
both.

**On a deck that uses a design system, fill its layouts' slots — never
recreate a layout's structure by hand.** A design system (DESIGN_SYSTEMS) is a
company's look as a package: the deck lists it under \`designSystems\` in its
configuration block, and a slide names one of its layouts and supplies only
content, one element per named slot:

\`\`\`html
<section data-layout="acme/section-divider">
  <p data-slot="kicker">Module 01</p>
  <h2 data-slot="title">Flink on Confluent Cloud</h2>
</section>
\`\`\`

Find the layouts and their slots first —
\`decklight design-system layouts acme@<marketplace>\` lists every layout, its
slots, and which are required (\`*\`). The structure comes from the design
system when the deck renders, so a slide that copies a layout's markup instead
never updates with it. Then \`decklight check deck.html\` names every layout
or slot the design system does not have, a slot filled twice, and a required
one left empty — before the talk, not on stage, where the slide would only
render plainly.

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

**Prompting ElevenLabs v4 in the notes.** When a deck is narrated by
ElevenLabs, the notes ARE the prompt — write them the way ElevenLabs'
[best practices](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices#prompting-eleven-v4)
say v4 is prompted:

- **Text structure does most of the work.** Natural spoken sentences, real
  punctuation and a clear emotional context steer v4 more than tags do.
  An ellipsis (…) adds a pause and weight; CAPITALS add emphasis — use both
  sparingly, since captions show them.
- **Tags are free-form direction, placed right before what they direct**:
  delivery (\`[whispers]\`, \`[excited]\`, \`[curious]\`, \`[sarcastic]\`,
  \`[sighs]\`), reactions (\`[laughs]\`, \`[exhales]\`), sound effects
  (\`[applause]\`, \`[clapping]\`). Being explicit helps: \`[low, warm voice]\`
  says more than a vague cue. Tags can be combined for a layered delivery.
- **Match the tag to the voice.** A tag lands best when the voice already has
  that delivery in it — a calm narrator will not shout convincingly, a hyped
  one will not whisper. Experimental tags (\`[sings]\`, \`[strong French
  accent]\`) vary by voice; tell the author to listen before the talk.
- **Pauses are tags, not SSML**: v4 and v3 ignore \`<break>\`. Write
  \`[pause]\` or \`[long pause]\` (decklight's own markers, above) — or an
  ellipsis for a lighter one.
- **One or two tags a slide, at the lines that earn them.** A tag on every
  sentence flattens the delivery it was meant to lift, and every tag is
  billed as characters.

To tag a script that already exists, \`decklight enhance deck.html --slides 3\`
(or \`--all\`, \`--dry-run\` to only look) asks the installed agent with the
prompt ElevenLabs publishes for exactly that, and writes only answers that kept
every word, \`[click]\` and \`[pause]\`. When you edit the notes yourself,
follow the same rules: add tags and emphasis, never reword the author's script
unless asked.

**Notes are said, not read.** Write them as sentences a person would say out
loud — "And if you fluff a line, just press Backspace to take it again", not
"Fluffed a line? Backspace retakes it." — and say symbols as words ("Command",
not "⌘"). To rewrite terse notes that way when asked, \`decklight enhance
deck.html --spoken --slides 3\` does it with the same checks on the beats and
the pauses.

**Commit your own changes when an edit server is running.** The edit
server does not commit edits for anyone: it snapshots the deck silently on
\`decklight/wip\` and commits when told to — the person presses K; only an
agent it started itself (A) commits on its own — and it did not start you. So
when you finish one logical change, say so:

\`\`\`sh
curl -sf -X POST localhost:8788/edit/commit \\
  -H 'content-type: application/json' \\
  -d '{"message":"split the crowded video slides"}'
\`\`\`

One call per logical change, with a subject describing THAT change — not
\"updated the deck\". It commits only the deck file, and does nothing when
nothing changed, so an extra call is harmless. If the port is not listening
there is no edit server: skip it silently and carry on, never start one
yourself. This is what makes a history someone can read afterwards, instead
of a wall of identical timer commits.

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
export function agentsSection(referenceHref = '.claude/skills/decklight/reference.md') {
  return `${AGENTS_MARKER}
## Decklight decks

This project contains a Decklight presentation (a single-file HTML deck —
see \`${referenceHref}\` for the full authoring
contract: builds, notes, sources, SVG diagrams, themes, terminals, narration).
Read that file before adding or editing slides.

After editing slides, render the deck and check nothing is clipped:
\`npx decklight@latest pdf deck.html -o /tmp/check.pdf\` — every \`⚠ slide N overflows\`
line is a slide losing content. Overflow is the late failure, though: a slide
that fits can still be too crowded, so keep to one idea and ~3–4 bullets per
column rather than to whatever renders.

On a deck with a design system, a slide fills a layout's slots
(\`<section data-layout="acme/section-divider">\` and children carrying
\`data-slot\`, listed by \`decklight design-system layouts <ref>\`) and never
recreates its structure by hand; \`decklight check deck.html\` names any slot
or layout the design system does not have.

When the deck is open in write mode (\`decklight deck.html\`), commit each logical
change you finish rather than leaving it to the timer's generic \`autosave\`:
\`curl -sf -X POST localhost:8788/edit/commit -H 'content-type: application/json'
-d '{"message":"what this change did"}'\`. No server listening means no
authoring session — skip it and carry on.

Hit a Decklight bug? Run \`npx decklight@latest report-bug\` for the environment
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
