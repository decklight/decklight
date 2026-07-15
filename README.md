<p align="center">
  <img src="docs/demo.svg" width="760" alt="An animated Decklight slide: the title, bullets and a diagram build in step by step, then the theme cycles from indigo light to dark to warm parchment while a generator toast appears.">
</p>

# Decklight

**The presentation library that presents itself.**

A deck is a single HTML file — no build, no server, no framework. Decklight is a presentation library in the Reveal.js tradition, designed to be **authored by AI agents and humans alike**: describe a slide in plain English and your agent writes it, then — because agents can't eyeball a slide — every feature is **verifiable by a headless render** (clipped content flags itself, every theme passes machine-checked contrast gates, terminal demos are recorded truth, not screenshots).

> `SPEC.md` is the full contract and `demo/showcase.html` is the exhaustive self-demo. **This README is the quick tour.** For the two-minute version, open **`demo/intro.html`** — a short deck that explains what Decklight is, each slide live-demoing the feature it describes. See it all live at **[decklight.io](https://decklight.io)**.

## Why Decklight

- **Agent-native** — describe a slide to your favorite agent; `init` hands it a skill with the real contract, and overflow flags + contrast gates + headless-render assertions let it verify its own work without eyes.
- **One file, zero build** — author a single HTML file, double-click it, present.
- **Diagrams & graphics** — native, theme-aware inline SVG, not just bullet lists.
- **Animation** — progressive builds, Magic Move between slides, and diagrams that draw themselves in.
- **61 built-in themes** — every one passes WCAG contrast gates and codified palette rules; generate your own with a keystroke.
- **Truthful terminals** — real PTY recordings replayed truthfully, never a video.
- **Live narration** — text-to-speech presents the deck by itself, in sync, captions included.
- **Everything is text** — no binary formats, so decks diff cleanly in git and agents can read, review, and edit every byte.

## Quick start

```
npx decklight init "My Deck"
```

Scaffolds a self-contained `deck.html` (double-click it — no server) **and** a `.claude/skills/decklight/` skill + `AGENTS.md`, so Claude Code (or anything reading `AGENTS.md`) has the full authoring contract on hand instead of guessing from Reveal.js memory. The skill is sliced from `SPEC.md`, so it never drifts from the installed runtime.

Or hand-author the anatomy directly:

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

The whole loop is agent-friendly, one file end to end:

1. **`decklight init`** — scaffold a starter deck plus the agent skill above.
2. **Author** one HTML file: `<section>` slides, `data-build` reveals, inline SVG with theme tokens, `<aside class="notes">` split on `⟨CLICK⟩` (notes drive builds, captions, transcript **and** narration at once).
3. **`decklight dev deck.html`** — the whole live loop under one Ctrl-C: live-reload editing (from your editor or the browser), plus any narration/lip-sync bridges this machine can run (missing prerequisites are skipped with the fix, never a hard failure). In the browser: **`E`** edits notes back into the file, **`L`** cycles layouts, **`Z`/`⇧Z`** undo/redo, and **`A`** asks an installed coding agent — Claude Code, Codex, Gemini, Copilot, Aider and more, auto-detected from `$PATH` — to edit the deck headlessly; the page reloads when it saves. Edits auto-commit as you go.
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
| **Code** | highlight.js themed through `--hl-*` tokens; `data-lines` steps highlight ranges as builds | [SPEC §6](SPEC.md#6-code) |
| **Terminals** | `decklight rec` captures real PTY output; replayed by typing then streaming, never a video | [SPEC §7](SPEC.md#7-terminal-recordings) |
| **Presenting** | speaker view, rehearse cue cards, overview, command palette, slide finder — all on `file://` | [SPEC §8](SPEC.md#8-presenting--output) |
| **Narration** | TTS reads your notes in sync with builds; the voice is the clock, captions + auto-advance | [SPEC §8](SPEC.md#8-presenting--output) |

## CLI

| Command | Purpose |
|---|---|
| `decklight init ["Title"]` | scaffold a self-contained starter deck + an agent skill |
| `decklight skills [agent…]` | install the authoring skill for Claude, Codex, OpenCode or IBM Bob (detected, named, or `--all`) |
| `decklight dev deck.html` | **the whole authoring loop in one command** — live reload + every bridge this machine can run |
| `decklight rec script.term.yaml` | record a terminal cast in a real PTY |
| `decklight bundle deck.html [--all]` | flatten to a self-contained single-file HTML |
| `decklight tts` | live voice bridge — the player synthesizes narration through it |
| `decklight lipsync` | lip-sync bridge — visemes (rhubarb) + a talking head (your GPU); `--veo` animates the portrait so the narrator moves, not just its mouth |

`decklight help` for every command and flag — `refresh` and `export` are in [SPEC §7](SPEC.md#7-terminal-recordings), `edit` and `lipsync` in [SPEC §8](SPEC.md#8-presenting--output). Drive a deck programmatically with the [JS API](SPEC.md#9-public-js-api). The runtime has **zero dependencies** (marked and highlight.js are bundled at build time); `node-pty` and `js-yaml` are CLI-only.

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

Decks reference `dist/decklight.{js,css}` and one theme file — copy those three files (or a `bundle`) and nothing else.

## Architecture

<p align="center">
  <img src="docs/architecture.svg" width="860" alt="Decklight architecture: a single deck.html and a theme.css feed a zero-dependency browser runtime (engine, terminal player, markdown/svg/code, narration, overlays); two localhost servers sit beside it — decklight edit for live-reload note editing and decklight tts bridging to Vertex AI Gemini TTS; a node CLI records, refreshes, exports and bundles; and a verification band (WCAG gates, palette rules, headless render assertions, property tests) gates everything against SPEC.md.">
</p>

One HTML file and one theme stylesheet feed a **zero-dependency browser runtime**; everything with native dependencies or credentials lives in **localhost tools** (the CLI, the `edit` live-reload server, the `tts` bridge); and a **verification band** — contrast gates, palette rules, headless render assertions, property tests — holds all of it to the `SPEC.md` contract.

## Development

`npm test` (unit + property tests) · `node test/render.mjs` (headless-Chrome render assertions) · `node test/contrast.mjs` (WCAG theme gates) · `npm run verify` for the lot. The repo culture: every feature is verified end-to-end against a real render, not just unit-tested — see SPEC §10.

## Links

- **[decklight.io](https://decklight.io)** — the showcase deck, live and narrating itself
- **`demo/intro.html`** — the short "what is Decklight" tour
- **`demo/showcase.html`** — the full self-demo, every feature on its own slide
- **[`SPEC.md`](SPEC.md)** — the authoring contract
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)** — how to contribute (DCO sign-off required)

## License

Decklight is free and open source, released under the [Apache License 2.0](LICENSE). Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
