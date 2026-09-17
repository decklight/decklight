# Decklight

A presentation library for people who would rather write their slides than
fight them. A deck is one HTML file. The runtime is one JS file, one CSS file
and a theme, with no dependencies and no build step. It opens straight from
`file://`, it diffs cleanly in git, and an AI agent can read, write and verify
every byte of it.

It is live at [decklight.io](https://decklight.io). The two-minute version is
`demo/intro.html`, the exhaustive one is `demo/showcase.html`, and the contract
everything is built against is [`SPEC.md`](SPEC.md).

## Why

I got tired of decks being binary blobs. You can't grep a Keynote file, you
can't code-review a PowerPoint, and when slide 12 has a contrast problem at
11pm, you're the one clicking around. I wanted a deck that is plain text end to
end, and a codebase where an agent can do most of the work because it can check
its own results: clipped content flags itself, every theme passes a
machine-checked contrast gate, and a headless render is the test.

That second half is also how this repo runs. Issues are triaged, reproduced,
specified and implemented by agents, and a human approves what ships.
[`CONTRIBUTING.md`](CONTRIBUTING.md) explains the loop if you're curious.

## Quick start

```sh
npm create decklight my-talk
```

That writes a `deck.html` in `my-talk/` — slides plus a two-line configuration
block, nothing else — plus a
`.claude/skills/decklight/` skill and an `AGENTS.md`, so Claude Code (or any
agent that reads `AGENTS.md`) has the real authoring contract on hand instead of
guessing from Reveal.js memory. Then it asks whether to open the deck in author
mode: live reload, edits from the browser, an AI agent on `A`, and every edit
auto-committed. Say yes. (`npx decklight@latest init "My Talk"` does the same
in the current directory.)

After that you rarely need a command name:

```sh
decklight                 # in a folder: start a deck, or pick one to open
decklight talk.html       # open a deck in author mode
decklight talk.pptx       # bring a PowerPoint, Keynote or Slides deck across
decklight talk.decklight  # play somebody else's deck, read-only
decklight bundle talk.html  # one self-contained file to send — the runtime embedded
decklight doctor          # what this machine can do, and how to get the rest
```

Type a command wrong and it tells you which one you meant. Or skip the scaffold
and write the HTML yourself. A deck you author is *data* — slides and a JSON
configuration block — and `author`/`present` add the runtime as they serve it;
`bundle` embeds it when you hand the file over. This is the whole anatomy:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <script type="application/json" data-decklight-config>
  { "decklight": "0.8.1", "theme": "aurora", "transition": "fade" }
  </script>
</head>
<body>
  <div class="decklight">
    <section>
      <h2>A plain HTML slide</h2>
      <p>With an auto-detected subtitle</p>
      <ul data-build>
        <li>First point</li>
        <li>Second point, revealed on the next advance</li>
      </ul>
      <aside class="notes">Speaker notes. ⟨CLICK⟩ markers line up with builds.</aside>
    </section>
  </div>
</body>
</html>
```

Nothing in that file executes. A deck that prefers to load the runtime
itself — `<script src="decklight/dist/decklight.js">` and a
`Decklight.init({ … })` call — is served exactly as written.

## What's in the box

- **Editing in the browser.** In author mode, double-click any text — or a
  code block, edited as plain source — to change it, drop a picture onto a
  slide to add it, and add, duplicate, move or delete slides from the palette
  or the right-click menu. Every edit lands in the file
  and `Z` takes it back. `decklight check` reports what an author or an agent
  would otherwise only see by looking: clipped slides, missing images, notes
  whose ⟨CLICK⟩ count disagrees with the builds.
- **Builds.** `data-build` on a container makes each child a step. The layout
  never jumps.
- **Diagrams.** Inline SVG written with `var(--d-*)` tokens recolours with every
  theme and can draw itself in.
- **Motion.** Slide transitions, Magic Move between slides, looping element
  effects. All of it respects reduced-motion.
- **Themes.** 46 themes in 2 packs, every one behind WCAG contrast gates. `T`
  picks one, `⌃T` generates a new one that passes the same gates.
- **Code and math.** highlight.js styled through theme tokens, LaTeX rendered
  to MathML with bundled Temml. No webfonts, no build step.
- **Charts.** `data-chart` plus a small JSON block gives you a theme-aware SVG
  chart: bar, line, area, pie, donut, scatter.
- **Terminals.** `decklight cast` records a real PTY session and the deck
  replays it, typing and streaming. Never a video.
- **Narration.** Text-to-speech reads your notes in sync with the builds, or you
  record your own voice one beat at a time. Captions and auto-advance come with
  it.
- **Review.** Reviewers comment on slides, the review travels as a git branch,
  and a comment finds its slide again after the deck has moved.
- **In and out.** PowerPoint, Keynote and Google Slides come in, with charts as
  data and SmartArt as diagrams. PDF and PowerPoint go out for whoever still
  asks.
- **Safe to receive.** `decklight present` plays a deck you didn't write
  read-only under a CSP and prints what the file will execute. `publish` signs
  what it ships.
- **Extensible without shipping code to the audience.** Themes, templates,
  speech engines and presenter plugins install from any git repo. Nothing
  executable travels inside a deck.

Every item above has a SPEC section behind it. The index at the top of
`SPEC.md` maps the names to the sections.

## The CLI

`decklight help <command>` prints the flags for any of these.

| Writing | |
|---|---|
| `init ["Title"]` | scaffold a deck and the agent skill, then offer author mode (`--author`, `--from <template>`) |
| `skills [agent…]` | install the authoring skill for Claude, Codex, OpenCode or IBM Bob |
| `author deck.html` | live reload plus every bridge this machine can run, under one Ctrl-C (`--open` for the browser; a git URL clones the repo and opens the deck inside). In the browser: double-click text to edit it, drop a picture onto a slide, right-click for the slide menu |
| `check deck.html` | lint it headlessly: clipped slides, missing assets, ⟨CLICK⟩ beats out of step with the builds (`--json`) |
| `record deck.html` | record the narration in your own voice, one ⟨CLICK⟩ beat at a time |
| `cast script.term.yaml` | record a terminal session in a real PTY (`refresh` re-runs, `export` writes asciicast) |

| Sharing | |
|---|---|
| `present deck.html` | play a deck you didn't write: read-only, under a CSP, with an ingredients label |
| `bundle deck.html` | one self-contained HTML file (`--all` merges a playlist, `--sign`, `--deck`) |
| `publish deck.html` | bundle and push to GitHub Pages, Netlify, Vercel or a folder |
| `pdf deck.html` | one slide per page (`--notes`, `--handout`) |
| `pptx deck.html` | a PowerPoint file, every slide a picture, notes as notes |
| `video deck.html` | a narrated video — mp4, mov or webm, with subtitles in it or beside it (`--format`, `--quality`, `--subtitles`; `--slides 5-9` for part of it, `--voiceover` synthesizes first; also **Export a video…** in the deck's palette, which can voice it with the live voice first) |
| `voiceover deck.html` | batch-synthesize the narration into a folder |

| Keeping track | |
|---|---|
| `review deck.html` | comment on somebody's deck; `review submit` sends it back as a branch |
| `comments deck.html` | what reviewers said, resolved against the deck as it is now |
| `history deck.html` | what decklight committed and what is only on this machine |
| `restore deck.html` | put the deck back to any commit that touched it |
| `upgrade deck.html` | bring a bundled deck's inlined runtime up to this version |

| Bringing things in | |
|---|---|
| `import talk.pptx` | convert PowerPoint, Keynote or Google Slides (`--theme template` keeps its palette, `--shapes strict` draws only snapped diagrams) |
| `theme check\|add` | validate a theme against the token contract, or install one |
| `marketplace add owner/repo` | register a catalog; it is cloned with your git credentials, then read from disk |
| `plugin add <name>` | presenter chrome for your machine only. `present` loads it, `bundle` never does |
| `template\|importer\|transform\|engine\|voice\|agent add …` | the rest of the unit library |
| `extension check t.mjs` | the marketplace admission gate for a transform |

| Odds and ends | |
|---|---|
| `tts` / `lipsync` | the live voice bridge and the lip-sync bridge the player talks to |
| `associate` | make double-clicking a `.decklight` file open `present` |
| `report-bug` | print the version and environment facts a bug report needs |
| `doctor` | what this machine can do (Chrome, ffmpeg, git, agents…) and the install line for what it can't |

The runtime has zero dependencies. highlight.js and Temml are bundled at build
time; `node-pty`, `js-yaml`, `sigstore` and Playwright are optional and used by
the CLI only.

## Keys

| Key | Action |
|---|---|
| `→` `←` `Space` | next / previous build or slide |
| `S` | speaker view (press again for rehearse cue cards) |
| `T` | theme picker, `⌃T` generate a theme |
| `⎵` | play / pause the voice once one is chosen; otherwise it advances |
| `V` | everything about the voice: tracks, live voice, character, record, captions, speed |
| `M` | review comments (`⏎` jumps to the slide, `R` marks one done), `⇧M` writes one |
| `H` | the deck's history, every version previewed live, `⏎` restores one |
| `I` | the sources behind this slide |
| `/` | command palette, `G` find a slide |
| `?` | every key |

## Working from a checkout

```sh
git clone https://github.com/decklight/decklight && cd decklight
npm install          # also builds dist/
npm test             # unit tests
npm run verify       # build + headless render assertions, needs Chrome
```

A deck you author carries no runtime: `author` and `present` reference
`dist/decklight.js`, `dist/decklight.css` and one theme file into it as they
serve it. To hand it over, `bundle` — one file, and nothing else to copy.

<p align="center">
  <img src="docs/architecture.svg" width="860" alt="Decklight architecture: one deck.html and a theme.css feed a zero-dependency browser runtime; the CLI, the author server, the tts bridge and the review server run beside it on localhost; a verification band of contrast gates, palette rules and headless render assertions holds everything to SPEC.md.">
</p>

Every commit needs a DCO sign-off (`git commit -s`). The rest of the process,
including how the agent loops work, is in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[Apache 2.0](LICENSE).
