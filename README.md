<p align="center">
  <img src="docs/demo.svg" width="760" alt="An animated Decklight slide: the title, bullets and a diagram build in step by step, then the theme cycles from indigo light to dark to warm parchment while a generator toast appears.">
</p>

# Decklight

**The presentation library that presents itself.**

A deck is a single HTML file — no build, no server, no framework. You describe a slide in plain English, your AI agent writes it, and because agents can't squint at a screen, every feature is **verifiable by a headless render**: clipped content flags itself, every theme passes machine-checked contrast gates, and terminal demos are recorded truth rather than screenshots.

## Why I built this

I have lost more hours than I'd like to admit fighting my slides instead of writing them.

Keynote pins me to one laptop and a proprietary file I can't diff. PowerPoint turns a two-line edit into a fifteen-minute wrestle with alignment guides. Google Slides makes me watch a spinner to move a box three pixels. And all three share the same original sin: the deck is a **binary blob**. You can't grep it, you can't code-review it, you can't hand it to a program and say "fix the contrast on slide 12." When something's wrong, *you* are the one clicking around at 11pm.

I wanted the opposite of that. A deck that is **plain text** end to end — one HTML file you can read, diff, and email — with a runtime that has **zero dependencies** and runs straight off `file://`. Everything is text, so decks live happily in git, and anything that can read text can read your slides.

But the real reason this project exists is the second half: I wanted a codebase where **bugs and features ship at the speed of light**, because the AI agents do the heavy lifting. Open an issue in the morning, and by lunch an agent has reproduced it, another has drafted a spec with real rendered mockups, and — once I give the nod — a third has implemented it, proven it with a screenshot, and merged it green. That's not a someday aspiration; it's [how this repo runs today](#how-decklight-itself-ships-at-agent-speed). Decklight is built the way it's meant to be used: humans decide *what*, agents handle *how*, and a wall of automated verification keeps everyone honest.

> `SPEC.md` is the full contract and `demo/showcase.html` is the exhaustive self-demo. **This README is the quick tour.** For the two-minute version, open **`demo/intro.html`** — a short deck that explains what Decklight is, each slide live-demoing the feature it describes. See it all live at **[decklight.io](https://decklight.io)**.

## What you get

- **Agent-native** — describe a slide to your favorite agent; `init` hands it a skill with the real contract, and overflow flags + contrast gates + headless-render assertions let it check its own work without eyes.
- **One file, zero build** — author a single HTML file, double-click it, present. No toolchain, no server, no framework.
- **Diagrams & graphics** — native, theme-aware inline SVG, not just bullet lists.
- **Animation** — progressive builds, Magic Move between slides, and diagrams that draw themselves in.
- **62 built-in themes** — every one passes WCAG contrast gates and codified palette rules; generate your own with a keystroke.
- **Truthful terminals** — real PTY recordings replayed truthfully, never a video.
- **Live narration** — text-to-speech presents the deck by itself, in sync, captions included.
- **Everything is text** — no binary formats, so decks diff cleanly in git and agents can read, review, and edit every byte.

## Quick start

```
npx decklight init "My Deck"
```

This scaffolds a self-contained `deck.html` (double-click it — no server) **and** a `.claude/skills/decklight/` skill + `AGENTS.md`, so Claude Code (or anything that reads `AGENTS.md`) has the full authoring contract on hand instead of guessing from Reveal.js memory. The skill is sliced straight from `SPEC.md`, so it never drifts from the runtime you actually installed.

Prefer to write the HTML yourself? Here's the whole anatomy:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="decklight/dist/decklight.css">
  <link rel="stylesheet" href="decklight/themes/aurora.css">
</head>
<body>
  <div class="decklight">
    <section>
      <h2>A plain HTML slide</h2>
      <p>With an auto-detected subtitle</p>
      <ul data-build>
        <li>First point</li>
        <li>Second point — steps in on the next advance</li>
      </ul>
      <aside class="notes">Speaker notes. ⟨CLICK⟩ markers align with builds.</aside>
    </section>
  </div>
  <script src="decklight/dist/decklight.js"></script>
  <script>Decklight.init({ transition: 'fade' });</script>
</body>
</html>
```

Open it in a browser — `file://` works for everything, no server needed.

## How authoring works

The whole loop is agent-friendly and stays in one file end to end:

1. **`decklight init`** — scaffold a starter deck plus the agent skill above.
2. **Author** one HTML file: `<section>` slides, `data-build` reveals, inline SVG with theme tokens, `<aside class="notes">` split on `⟨CLICK⟩` (notes drive builds, captions, transcript **and** narration all at once).
3. **`decklight dev deck.html`** — the whole live loop under one Ctrl-C: live-reload editing (from your editor or the browser), plus any narration/lip-sync bridges this machine can run (missing prerequisites are skipped with the fix printed, never a hard failure). In the browser: **`E`** edits notes back into the file, **`L`** cycles layouts, **`Z`/`⇧Z`** undo/redo, and **`A`** asks an installed coding agent — Claude Code, Codex, Gemini, Copilot, Aider and more, auto-detected from `$PATH` — to edit the deck headlessly; the page reloads when it saves. Edits auto-commit as you go.
4. **`decklight rec script.term.yaml`** — record a truthful terminal cast in a real PTY.
5. **`decklight bundle deck.html --themes all`** — flatten runtime, themes, casts and narration into one offline HTML file to hand off.

## Features at a glance

| Feature | In one line | More |
|---|---|---|
| **Markdown** | opt a slide into CommonMark with `data-markdown`; HTML stays the default | [SPEC §1](SPEC.md#1-deck-anatomy) |
| **Builds** | `data-build` on a container — each child is a step; the layout never jumps | [SPEC §2](SPEC.md#2-builds-keynote-style-reveal-calls-these-fragments) |
| **SVG diagrams** | inline SVG authored with `var(--d-*)` tokens; recolors with every theme, strokes draw in | [SPEC §3](SPEC.md#3-svg-diagrams-first-class) |
| **Motion** | slide transitions, Magic Move auto-animate, looping element effects — all respect reduced-motion | [SPEC §4](SPEC.md#4-motion) |
| **Theming** | 62 themes in 5 packs on one token contract; `T` picker, `⌃T` generates a contract-complete theme | [SPEC §5](SPEC.md#5-theming--the-token-contract) |
| **Code** | highlight.js themed through `--hl-*` tokens; `data-lines` steps highlight ranges as builds | [SPEC §6](SPEC.md#6-code--math) |
| **Math** | `data-math` renders `$$…$$` / `\(…\)` LaTeX to native MathML via bundled Temml — no webfonts, no build step | [SPEC §6](SPEC.md#6-code--math) |
| **Terminals** | `decklight rec` captures real PTY output; replayed by typing then streaming, never a video | [SPEC §7](SPEC.md#7-terminal-recordings) |
| **Presenting** | speaker view, rehearse cue cards, overview, command palette, slide finder — all on `file://` | [SPEC §8](SPEC.md#8-presenting--output) |
| **Narration** | TTS reads your notes in sync with builds; the voice is the clock, captions + auto-advance | [SPEC §8](SPEC.md#8-presenting--output) |

## CLI

| Command | Purpose |
|---|---|
| `decklight init ["Title"]` | scaffold a self-contained starter deck + an agent skill (run bare in a terminal, it asks for the title and offers a git repo; `--open` launches the deck, and it can hand straight off to `dev`) |
| `decklight skills [agent…]` | install the authoring skill for Claude, Codex, OpenCode or IBM Bob (detected, named, or `--all`; `--global` for every project) |
| `decklight dev deck.html` | **the whole authoring loop in one command** — live reload + every bridge this machine can run |
| `decklight rec script.term.yaml` | record a terminal cast in a real PTY |
| `decklight bundle deck.html [--all]` | flatten to a self-contained single-file HTML |
| `decklight upgrade deck.html` | bring a self-contained deck's inlined runtime + themes up to the installed version |
| `decklight tts` | live voice bridge — the player synthesizes narration through it |
| `decklight lipsync` | lip-sync bridge — visemes (rhubarb) + a talking head (your GPU); `--veo` animates the portrait so the narrator moves, not just its mouth |

`decklight help` lists every command and flag — `refresh` and `export` are in [SPEC §7](SPEC.md#7-terminal-recordings), `edit` and `lipsync` in [SPEC §8](SPEC.md#8-presenting--output). Drive a deck programmatically with the [JS API](SPEC.md#9-public-js-api). The runtime has **zero dependencies** (marked, highlight.js and temml are bundled at build time); `node-pty` and `js-yaml` are CLI-only.

## Keys

| Key | Action |
|---|---|
| `→` `←` `Space` | next / previous build or slide |
| `S` | speaker view (again: rehearse cue cards) |
| `T` | theme picker (type to filter) · `⌃T` generate a theme |
| `V` | narration on/off |
| `/` | command palette · `G` find a slide |
| `?` | help overlay — every key |

## Install on another machine

```sh
git clone https://github.com/decklight/decklight && cd decklight
npm install        # dev deps for building/recording; decks only need dist/ + themes/
npm run build
```

A deck references `dist/decklight.{js,css}` and one theme file — copy those three files (or a single `bundle`) and nothing else.

## How Decklight itself ships at agent-speed

The whole point was a project where fixes and features land fast because agents do the work and automated verification keeps it safe. So the repo runs itself as a pipeline of small, single-purpose GitHub Actions — each one a Claude agent with exactly the powers it needs and no more:

- **You open an issue.** An agent reads it *and the code it blames*, then either asks the missing questions or routes it — a bug goes to a reproduction agent (which actually builds `main` and tries it, posting screenshots of what it saw), a feature goes to a spec agent (which drafts acceptance criteria and renders real UI mockups for review).
- **You approve.** Applying `ready-to-dev` is the one human gate. An implementation agent writes the code on a branch, proves it with `npm run verify` and a screenshot of the feature actually working, and opens a PR with that picture inline. You review the *screenshots*, not the merge button — the PR merges itself once CI is green.
- **The loop keeps itself unstuck.** If CI goes red, a fix agent reads the failing logs and repairs the branch (capped, so it never argues with a red build forever). If `main` moves and a branch goes stale, a rebase agent replays it cleanly. A grooming pass reads the backlog daily and closes what the code already fixed — citing the exact `file:line` as proof.

Every one of those agents runs under the same rule: on a public repo, an automated trigger never hands a push token to an agent reading text a stranger can write. The agents that need a shell run credential-less; the tokens live only in plain shell steps; a verification band — WCAG contrast gates, palette rules, headless-render assertions, property tests — holds all of it to `SPEC.md`. The `.github/workflows/` files each open with a header explaining *why* they're shaped the way they are; they're worth a read if you like this sort of thing.

## Architecture

<p align="center">
  <img src="docs/architecture.svg" width="860" alt="Decklight architecture: a single deck.html and a theme.css feed a zero-dependency browser runtime (engine, terminal player, markdown/svg/code, narration, overlays); two localhost servers sit beside it — decklight edit for live-reload note editing and decklight tts bridging to Vertex AI Gemini TTS; a node CLI records, refreshes, exports and bundles; and a verification band (WCAG gates, palette rules, headless render assertions, property tests) gates everything against SPEC.md.">
</p>

One HTML file and one theme stylesheet feed a **zero-dependency browser runtime**; everything with native dependencies or credentials lives in **localhost tools** (the CLI, the `edit` live-reload server, the `tts` bridge); and a **verification band** — contrast gates, palette rules, headless render assertions, property tests — holds all of it to the `SPEC.md` contract.

## Development

`npm test` (unit + property tests) · `node test/render.mjs` (headless-Chrome render assertions) · `node test/contrast.mjs` (WCAG theme gates) · `npm run verify` for the lot. The house rule: every feature is verified end-to-end against a real render, not just unit-tested — see SPEC §10, and `CONTRIBUTING.md` for the DCO sign-off every commit needs.

## Links

- **[decklight.io](https://decklight.io)** — the showcase deck, live and narrating itself
- **`demo/intro.html`** — the short "what is Decklight" tour
- **`demo/showcase.html`** — the full self-demo, every feature on its own slide
- **[`SPEC.md`](SPEC.md)** — the authoring contract
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — how to contribute (DCO sign-off required)

## License

Decklight is free and open source, released under the [Apache License 2.0](LICENSE). Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
