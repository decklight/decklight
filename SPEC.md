# Decklight — Specification v1

A presentation library in the Reveal.js tradition, designed to be **authored by AI agents and humans alike**: a deck is a single HTML file, the runtime is one JS + one CSS + one theme CSS, no build step. Every feature is designed to be **verifiable by a headless render** (the authoring agent can prove a deck works).

This document is the contract. All subsystems (core, themes, terminal, demos) build against it.

---

## 1. Deck anatomy

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
      <ul data-build>
        <li>First point</li>
        <li>Second — with <strong>bold</strong> and <code>code</code></li>
      </ul>
      <aside class="notes">Speaker notes. ⟨CLICK⟩ markers align with builds.</aside>
    </section>

    <section data-markdown>
      <script type="text/template">
## A markdown slide

Content here. HTML is the default; markdown is opt-in per slide.

Note:
Speaker notes in markdown slides.
      </script>
    </section>
  </div>
  <script src="decklight/dist/decklight.js"></script>
  <script>Decklight.init({ transition: 'fade' });</script>
</body>
</html>
```

- Slides are `<section>` children of `.decklight`. Flat list (no vertical nesting in v1).
- Markdown slides: `data-markdown` on the section, content in `<script type="text/template">`
  (never `<textarea>` — avoids the escaping and lazy-continuation bugs we hit in Reveal).
  Markdown is CommonMark via bundled `marked`. `Note:` starts speaker notes.
- Speaker notes: `<aside class="notes">` (HTML) or `Note:` (markdown).
- **Rehearse notes** (optional, build-time authored): a condensed cue-card variant of the notes for the speaker view's rehearse mode (§8) — a few words per segment instead of full prose, with **exactly the same ⟨CLICK⟩ segmentation** as the notes so build-step highlighting aligns. HTML: `<aside class="rehearse">` as a sibling of the notes aside. Markdown: a line `Rehearse:` after the `Note:` prose starts the cue block. Slides without a rehearse aside fall back to the full notes in rehearse mode.
- **Subtitle**: the `<p>` immediately following a slide's leading `h1`/`h2` is auto-marked `.subtitle` and gets one canonical look (muted, 0.72em) whether the slide is markdown- or HTML-authored. Opt out per slide with `data-subtitle="none"` on the section; an author-placed `class="subtitle"` is respected as-is. Don't bake subtitle text into diagram SVGs — author it as this `<p>` so it themes and scales with the deck.

## 2. Builds (Keynote-style; Reveal calls these fragments)

Design goal: **the container opts in, the engine does the rest** — one attribute on the
container, zero classes on the items.

### 2.1 Authoring

| Syntax | Meaning |
|---|---|
| `data-build` on a container (`ul`, `ol`, `table`, `svg`, `g`, `div.columns`, …) | each **direct child** (li / tbody tr / g or shape / column) becomes one build step, in DOM order |
| `data-build` on a leaf element (`p`, `img`, `blockquote`, `pre`, one `g`) | the element itself is one build step |
| `data-build="fade-up"` | entrance style (see 2.3) |
| `data-build-order="3"` | explicit step index within the slide (default: document order) |
| `data-build-stay` on a child of a `data-build` container | child is exempt (stays static) |
| Markdown: `::: build` … `:::` container directive | wraps content in a `<div data-build>` |

### 2.2 Engine semantics

- All build steps on a slide form one ordered sequence (document order, overridden by `data-build-order`; ties advance together).
- Navigation: `→`/`Space`/click advances one step; `←` reverses; arriving from the previous slide shows step 0 (nothing built); arriving *backwards* from the next slide shows all steps built.
- Hidden steps: `visibility: hidden` (not `display:none` — layout must not shift).
- Events: `decklight:build` fires with `{slide, index, total, direction}`.
- URL: `#/<slide>/<step>` deep-links to a build state.

### 2.3 Entrance styles

`fade` (default) · `fade-up` · `fade-down` · `zoom` · `pop` (overshoot) · `draw` (SVG paths/lines: stroke-dashoffset animation; non-stroke elements fall back to fade) · `highlight` (element already visible; step emphasizes it: accent outline + others dim) · `none` (instant).

All entrance styles are CSS-driven (`.build-step[data-build-state="done|current|pending"]`), duration via `--build-duration` (theme-overridable, default 300ms).

### 2.4 Build Provider API (for subsystems)

Complex widgets (code stepping, terminal player) register **build providers** instead of DOM steps:

```js
Decklight.registerBuildProvider(element, {
  count: 4,                 // number of steps this widget contributes
  apply(i) { ... },         // called with current step index (0 = nothing, count = all)
  label(i) { return 'git status' }  // optional, for the speaker view step list
});
```

The engine interleaves provider steps into the slide's sequence at the element's document position. Providers must be idempotent (`apply` may be called with any index in any order — e.g. deep links).

## 3. SVG diagrams (first-class)

- Inline SVG is the canonical diagram format. `data-build` on `<svg>` or a `<g>` makes direct-child groups progressive (exactly the pattern from §2.1).
- **Theme-aware diagrams**: themes define diagram tokens (§5). Diagrams authored with
  `var(--d-stroke)`, `var(--d-fill-1)`…`var(--d-fill-6)`, `var(--d-text)`, `var(--d-muted)`,
  `var(--d-accent)` re-color automatically across all 30 themes.
  Hardcoded-color SVGs still work; they just don't adapt.
- `data-build="draw"` on groups animates strokes (paths, lines, polylines) via dash-offset.
- The runtime namespaces `id` attributes inside each inline `<svg>` at init (prefix `svg{n}-`, rewriting `url(#…)` and `href="#…"` refs) — the defs-collision bug class is eliminated at the engine level.
- **Concept colors**: `data-concept="agent"` on a shape (or a group — its direct-child shapes recolor; text never does) pins that concept to ONE diagram-fill slot deck-wide, so a recurring concept never changes color between diagrams. Resolution: `init({ concepts: { agent: 3 } })` pins a slot (1–6) or any raw CSS color (`'var(--d-accent)'`); unconfigured names fall back to a stable hash of the name, identical across sessions and decks. The indirection targets a slot (`var(--d-fill-N)`), not a color, so concept identity survives all themes, generated ones included. Two concepts hashing to the same slot get a console warning telling the author to pin one explicitly. Applied on `sync()` (idempotent, covers dynamic slides).

## 4. Motion

### 4.1 Slide transitions
`transition: 'none' | 'fade' | 'slide' | 'scale' | 'flip'` — deck-level config, per-slide override `data-transition`. Duration `--transition-duration` (default 350ms). Reduced-motion: all transitions collapse to `none` under `prefers-reduced-motion`.

### 4.2 Auto-animate (Magic Move)
- `data-auto-animate` on two adjacent sections.
- Matching: elements sharing `data-id`; unmatched elements fade in/out.
- Animated properties: position/size (FLIP transform), opacity, color, background, border-radius, font-size. Works for HTML and inline-SVG elements (x/y/width/height via transform).
- Duration `--auto-animate-duration` (default 500ms).

### 4.3 Element animations
`data-animate="pulse | float | shake | spin | blink | bounce | swing | glow | breathe"` — looping attention animations, start when the slide becomes active (and only then; pause on inactive slides). Respect reduced-motion.

## 5. Theming — the token contract

`decklight.css` = structure only (layout, builds, navigation chrome, print). A theme = one CSS file defining tokens on `.decklight`:

```css
.decklight.theme-aurora { /* class added by the theme file itself via :root scoping */ }
```

Themes set (all required):

| Group | Tokens |
|---|---|
| Canvas | `--bg` (canvas: color **or** gradient), `--bg-accent` (gradient values paint as an overlay above `--bg`; color values are ignored on the canvas and serve as a secondary-surface token), `--fg`, `--muted` |
| Type | `--font-body`, `--font-heading`, `--font-mono`, `--heading-color`, `--heading-weight`, `--link` |
| Accent | `--accent`, `--accent-contrast` (text on accent) |
| Blocks | `--block-bg`, `--block-border`, `--block-radius`, `--shadow` |
| Code | `--code-bg`, `--code-fg`, plus highlight token colors `--hl-keyword`, `--hl-string`, `--hl-number`, `--hl-comment`, `--hl-function`, `--hl-type`, `--hl-punct` |
| Diagram | `--d-stroke`, `--d-text`, `--d-muted`, `--d-accent`, `--d-fill-1` … `--d-fill-6` |
| Terminal | `--term-bg`, `--term-fg`, `--term-prompt`, `--term-cursor`, `--term-selection`, ANSI 16: `--ansi-black` … `--ansi-bright-white` |
| Builds | optionally override `--build-duration`, dim level `--dim-opacity` |

Requirements for the shipped themes:
- Body text ≥ WCAG AA contrast on `--bg`; code tokens ≥ AA on `--code-bg` (validated by `test/contrast.mjs`).
- **Diagram ink clears the diagram panels**: `--d-text` ≥ 3.0 and `--d-muted`/`--d-accent` ≥ 2.6 against **every** `--d-fill-1..6`, not just the canvas — labels sit on the fills, and a theme can pass every canvas gate while its boxes are unreadable (the gameboy lesson). Enforced by `test/contrast.mjs` on shipped themes and by the generator's property tests.
- Variety: ≥10 dark, ≥10 light, ≥4 serif-headed, ≥4 gradient/duotone canvases, ≤2 that are safe-corporate-boring.
- Fonts: system stacks or bundled-safe Google-font `@import` (deck authors may be offline: every theme must degrade to a system stack gracefully).

Runtime-**generated** themes (§8, `⌃T`) satisfy the same contract: `src/core/themegen.js` derives every token with WCAG luminance math and iterates until all of `test/contrast.mjs`'s gates pass — a generated theme can never fail validation (property-tested across seeds in `test/themegen.test.mjs`).

Generation also follows **codified palette rules** (R1–R8 in `themegen.js`), distilled from the most-loved editor themes (Solarized, Nord, Catppuccin, Gruvbox) and the 60-30-10 doctrine — each enforced by an independent property test:
- **R1 limited palette** — one base hue plus the harmony's ≤5 accent hues, reused across every role (syntax, links, diagram fills); never a fresh hue per token.
- **R2 quiet dominant areas** — the canvas stays near-neutral; chroma belongs to small accents, not large surfaces.
- **R3 dimmed pastels** — vivid rolls are biased toward muted and saturation is hard-capped below neon.
- **R4 one accent lightness band** — accent-family colors share a starting lightness and saturation, so no color shouts louder than its peers.
- **R5 selective contrast** — syntax roles differ by hue at similar brightness, not by brightness spikes.
- **R6 no pure black or white** — every neutral carries the base-hue tint.
- **R7 gradients sparingly** — ~15% of rolls, low-drift same-family washes only.
- **R8 semantic anchors** — terminal red/green/yellow keep their recognizable hue even when muted (the green band admits olive — Solarized's green is h68, Gruvbox's h63).

The **shipped themes conform to the same rules**, graded by `test/palette-rules.mjs` (part of `npm run verify`; R7 is graded on the collection — gradient canvases ≤ 30% of the set). A theme may opt out of a rule where conformance would break its identity — official brand colors, an intentional duotone canvas — by declaring the exception *in the theme file* with a reason: `rule-exception: R2 official Polar→Glow brand gradient canvas is the identity`. Undeclared violations fail the grader; declared ones are printed with every run so they stay reviewable.

## 6. Code

- `<pre><code class="language-sql">…</code></pre>` — highlighting via bundled highlight.js
  (languages: sql, js, ts, python, bash/shell, yaml, json, java, go, rust, html/xml, css, plaintext), themed through the `--hl-*` tokens (no separate hljs theme files).
- **Line stepping**: `data-lines="1|3-5|all"` on the `<pre>` → registers a build provider with one step per segment; non-highlighted lines get `--dim-opacity`. `data-lines-numbers` shows line numbers.
- Escaping rule for authors: use `&lt;` inside code blocks in HTML slides; markdown fences handle escaping automatically.

## 7. Terminal recordings

### 7.1 Recorder CLI (authoring-time; the only part with native deps)

`cli/rec.mjs`, invoked as `npx decklight rec <script.term.yaml> [-o out.cast.json]`
(the `decklight` dispatcher in `cli/decklight.mjs` also provides `refresh`, `export`, `bundle`,
and a global `--help`; the per-file entry points still run directly, undocumented).

Script format:
```yaml
shell: zsh            # default: $SHELL
cwd: ~/demo           # default: script's directory
cols: 100             # default 100
rows: 28              # default 28
env: { NO_COLOR: "" } # extra env (merged over inherited)
prompt: "$ "          # cosmetic prompt used in playback
redact:               # regexes replaced with ▓▓▓ in captured output
  - "sk-[A-Za-z0-9-_]+"
max_idle: 2.0         # clamp recorded pauses to this many seconds (default 2.0)
steps:
  - cmd: export STAGE=demo
    hide: true        # runs in the session; omitted from playback (recorded, flagged hidden)
  - cmd: git status
  - sleep: 1.5        # pure pause: really sleeps at capture; timing marker in play/export
  - cmd: npx wrangler deploy
    timeout: 120      # seconds, default 60
    wait_for: "Deployed"   # step fails unless output matches before completion
    type_speed: 2     # playback typing-speed multiplier for this step
    note: deploys the worker   # shows in speaker view step list
  - cmd: myapp login
    interact:               # expect/send for interactive prompts
      - expect: "Email: "
        send: "demo@example.com\n"
      - expect: "Password: "
        send: { secret: "$APP_PASSWORD\n" }   # sent for real; recorded as ▓▓▓
```

Behavior: spawn PTY (node-pty), run each `cmd` sequentially in the same shell session,
capture raw output chunks with timestamps, apply redaction and idle-clamping, write the
cast. Commands run inside a brace group with the sentinel on the closing line, so a
command that reads stdin sees only `interact` sends (never the recorder's own control
lines). Exit non-zero if any step exceeds its timeout, an `expect` never matches
(including command exit before it fires), or the shell dies; `--allow-fail` records
failures as content (prompts and error output are often the point).

**Secrets**: a secret send is written to the PTY for real but stored as `▓▓▓` in the
cast's `input` record, and its value is auto-added to that step's output redaction.
Prefer the `$ENV` form — it resolves from the recorder's environment at run time, so
`--refresh` keeps working. Literal secret values (and script-`env` entries a `$NAME`
secret refers to) are scrubbed to `▓▓▓` in the embedded script; refreshing such a cast
requires the operator to provide the value via the environment.

**Refresh**: the cast embeds the full script. `decklight refresh <dir|cast…>` re-executes
every embedded script and rewrites casts whose output changed; prints a drift summary.
(Note: a cast that records the state of the repository it lives in — e.g. `git status` —
converges over two refreshes, since the rewrite itself changes that state.)

### 7.2 Cast format (`.cast.json`, version 1)

```json
{
  "decklightCast": 1,
  "meta": { "shell": "zsh", "cols": 100, "rows": 28, "recorded": "ISO-8601", "prompt": "$ " },
  "script": { /* the source YAML as JSON (secrets scrubbed — see §7.1) */ },
  "steps": [
    { "cmd": "git status",
      "output": [[0.031, "chunk…"], [0.480, "chunk…"]],
      "exit": 0, "duration": 1.24, "note": "optional",
      "hidden": true,            /* optional: hide: true steps            */
      "typeSpeed": 2,            /* optional: playback typing multiplier  */
      "input": [[0.5, "y\n"], [1.2, "▓▓▓"]] /* optional: interactive sends */ },
    { "sleep": 1.5 }             /* pure pause marker                      */
  ]
}
```

The format stays `decklightCast: 1`: every addition (`hidden`, `typeSpeed`, `input`,
sleep steps) is an optional field that old casts simply lack and the player treats as
absent — no compatibility break in either direction.

### 7.3 Player (runtime; zero native deps)

```html
<div class="terminal" data-cast="casts/demo.cast.json" data-mode="step"></div>
<!-- or, for decks that must work on file:// (fetch of local files is blocked): -->
<div class="terminal" data-cast-inline="#my-cast" data-mode="step"></div>
<script type="application/json" id="my-cast">{ "decklightCast": 1, … }</script>
```

- `data-mode="step"` (default): registers a build provider — each advance **types the command**
  (synthesized keystrokes, 80–135ms jitter, each landing with a synthesized switch sound: data-type-sound="creamy" (default) | "thocky" | "clacky" | "off") then streams its real
  output with recorded pacing compressed to ≤2.5s per step (`data-max-step` override).
  Provider is idempotent: `apply(i)` renders steps `< i` instantly-complete, animates step `i` if
  reached by a forward advance, clears the rest.
- **Typing sound**: a subtle synthesized key click accompanies each typed character
  (WebAudio — a ~35ms bandpassed noise tick with jittered pitch/level, no asset;
  spaces land deeper, with more bass). Three voicings, `data-type-sound="creamy"`
  (default) | `"thocky"` | `"clacky"`, or `"off"` to mute. A `♪ voice` titlebar button
  lets the presenter cycle creamy → clacky → thocky → off live; that choice persists per
  deck in localStorage and overrides the authored value. Degrades to silence where audio
  is unavailable.
- **Typing speed**: `data-type-speed` is a `1` (slow) … `10` (fast) scale, default `5`
  (the classic pace; the mapping is exponential — 1 ≈ ⅓×, 10 ≈ 4×, and factor 1 reads at
  ~55 wpm). A `⌨ n wpm` titlebar button lets the presenter cycle the speed live through
  words-per-minute presets (30 … 160); that choice persists per deck in localStorage and
  overrides the authored value on every terminal (which maps to the nearest preset).
  Per-step `typeSpeed` (a multiplier) composes on top.
- `data-mode="play"`: timeline playback with play/pause, speed control, original timing
  (`sleep` steps pause the timeline; `hidden` steps never play in either mode).
- `data-poster="N"`: the terminal arrives with its first N playable steps already
  rendered; poster steps are excluded from the build sequence (provider count =
  playable − N, `apply(i)` shows N + i).
- Interactive `input` records play back as typed keystrokes at their recorded position
  in the output stream (secrets appear as `▓▓▓`); per-step `typeSpeed` multiplies both
  command and input typing.
- Rendering: **ANSI subset renderer** (owned, no xterm.js): SGR 0/1/2/3/4/7/22/23/24/27,
  30–37/40–47/90–97/100–107, 38;5/48;5 (256), 38;2/48;2 (truecolor), `\r` overwrite, `\b`,
  EL (`\x1b[K`), simple cursor-forward. Full-screen apps out of scope (documented).
  256/truecolor pass through; the 16 named colors map to the theme's `--ansi-*` tokens.
- A scrollback cap (default 24 rows visible, older lines scroll) with themed chrome
  (`--term-*`), rounded window with fake traffic lights (theme may hide via `--term-chrome: none`).

### 7.4 asciicast v2 interop

- **Export**: `decklight export <cast.json> [-o out.cast]` flattens a decklight cast to
  asciicast v2 NDJSON — prompt and typed command injected as output events
  (deterministic 45ms/char typing), step boundaries as `m` marker events, hidden steps
  omitted, sleep steps as pure time gaps. Unlocks the asciinema ecosystem:
  `agg out.cast demo.gif` for READMEs, asciinema.org sharing, asciinema-player embeds.
- **Import**: `data-cast` also accepts a plain asciicast v2 file (detected by shape,
  not extension). Imported streams are `raw` — they already contain prompts and echoed
  input, so the player injects nothing. With `m` markers the recording is step-capable
  (one build per marker); without markers it plays as a single timeline (`data-mode="step"`
  falls back to `play`).

## 8. Presenting & output

- Keyboard: `→/←/Space` steps+slides, `Home/End`, `O` overview grid, `B` blackout, `F` fullscreen, `T` theme picker (`,`/`.` cycle the theme, `[`/`]` cycle the font), `L`/`⇧L` cycle the current slide's layout (dev mode — a persisted deck edit), `Z`/`⇧Z` undo/redo deck edits (dev mode), `A` ask an AI agent to edit the deck (dev mode), `/` command palette, `V` narration (`N` picks track / live voice / tone; `P` pauses/resumes; `<`/`>` change the voice speed in 0.25× steps, 0.25–2×, persisted per deck — YouTube's shortcut), `C` captions, `K` presenter clock, `H` progress bar, `D` debug log, `` ` `` messages, `G` slide/module finder (deliberately not `⌘F` — browser find stays untouched), `?` help overlay.
- **Captions** (`C`): a YouTube-style bar at the bottom showing the current notes segment — the same ⟨CLICK⟩-segmented text the live voice speaks — synced to slide/step, with narration on or off. Slides/steps without notes show no bar. Persists per deck in localStorage.
- **Presenter clock** (`K`): the wall-clock time (HH:MM) and the elapsed talk time, directly below the slide number — positioned so it never covers the slide number, the message window, or the default logo/controls corners. The elapsed count starts at the deck's **first advance after load**, not at page load — a deck idling on its title slide while the room fills is not a talk yet. Off by default, persists per deck in localStorage, never rendered in `?print`. `instance.toggleClock()` programmatically.
- **Progress bar** (`H`): a hairline along the bottom edge of the deck whose width tracks the position through the deck (slide plus build step, slide 1 empty → last slide full), updated on every navigation — keys, `G`, `Home`/`End`, deep links. A passive readout of the deck state: it never drives navigation or auto-advance. Sits at the very bottom edge, below the captions bar, the character overlay and the corner chrome, so it covers none of them. Off by default, persists per deck in localStorage, never rendered in `?print`. `instance.toggleProgress()` programmatically.
- **Transcript** (palette → Transcript…): the deck's full spoken script — every slide's notes segments in order, slide titles jump on click — with export to plain text or markdown (`<deck>-transcript.txt|.md`). Also programmatic: `instance.transcript.text()` / `.markdown()` / `.open()`.
- **Dev mode (edit server)**: `decklight edit <deck.html>` (or the umbrella `decklight dev`) serves the deck over localhost with live reload and accepts persisted edits from the player. Endpoints: `GET /edit/ping` (capabilities: deck name, undo/redo depths, git state, detected agents, `agentBusy`), SSE `GET /edit/events` (`reload` on any file change; named `agent` events for job status), `POST /edit/notes {slide, text}`, `POST /edit/layout {slide, layout}` (writes `data-layout` into the slide's `<section>` tag; `auto` removes it; a no-change write is skipped), `POST /edit/undo` / `POST /edit/redo`, and `POST /edit/agent {prompt, agent?}`.
- **Undo/redo** (`Z`/`⇧Z`): the server keeps ONE in-memory edit history — whole-file snapshots, capped at 200 — fed by every mutation it performs (layout picks, notes saves, agent runs). Undo/redo rewrites the deck file; the watcher's reload shows the result (the hash keeps the position). The history is deliberately **independent of git**: commits never consume or reset it, and undoing never touches the repository. A file edited externally between an edit and its undo isn't lost — the current content rides the opposite stack. Empty stacks answer 409, and the player toasts the remaining depths.
- **Git autocommit**: with `--git` (or automatically when the deck already sits inside a repository; `--no-git` opts out) the server commits the deck on a regular basis — every `--commit-every` seconds (default 300) when it actually changed, plus an opening commit and a final one on Ctrl-C. `--git` creates the repository when none exists; `decklight dev` ASKS first on a TTY ("no git repository here — create one and auto-commit?"). Only the deck file is staged (`git add -- <deck>`), and a machine with no git identity gets a per-commit `-c user.name/user.email` fallback rather than a silent failure.
- **Ask an agent** (`A`): dev mode drives whichever AI coding agent CLIs the dev machine has installed — the roster (`cli/agents.mjs`) covers **Claude Code** (`claude -p … --permission-mode acceptEdits`), **Codex CLI** (`codex exec --full-auto …`), and **IBM Bob** (`bob -p … --accept-license`), plus Gemini CLI, GitHub Copilot CLI, OpenCode, Goose, Aider, Cursor CLI, and Qwen Code — each as a headless one-shot invocation, detected by probing `$PATH`. A opens a prompt overlay (agent picker when several are detected; `--agent` sets the default); the server snapshots the deck, spawns the agent in the serving directory with the instruction wrapped in deck context, and streams start/done status over SSE (toasts in the player; 10-minute timeout; strictly one job at a time — `agentBusy` survives reloads via ping). If the agent changed the file, the watcher reloads every browser and `Z` takes the edit back like any other.
- **Notes editor** (`E`): E opens a notes editor — ⟨CLICK⟩-separated plain text — whose Save rewrites the slide's `<aside class="notes">` in the file (one `<p>` per segment, HTML-escaped; the aside is inserted if the slide had none). The server watches the deck file and broadcasts a reload to every connected browser on ANY change — the player's edits and external editors alike — and the `#/slide/step` hash restores the position. Markdown-authored slides decline the editor (their notes live in the template). `file://`-opened decks probe the server at its default localhost port (CORS-open endpoints, like the tts bridge) so the printed URL and a double-clicked file both work; `config.edit.url` overrides, and a basename guard refuses a server that's editing a different deck.
- **Messages** (`` ` `` — the key left of `1`, matched on `code` so it is the same physical key on every layout; or the palette's "Messages"): the deck talks back in the **top-left corner** — 20px, high-contrast, stacked newest-last (at most 4 at a time), each fading after a few seconds. Every message is also KEPT: that key opens the log — the full history with arrival times — because a message that explains why the voice stopped is worthless if it faded while you were looking at the slide. The shortcut is handled BEFORE the typing guard, so `` ⌃` ``/`` ⌥` `` reach you even while the notes editor (`E`) has focus and owns every bare keystroke; the bare key works whenever you are not typing. `instance.messages()` returns `[{ at, text }]`, `instance.toggleMessages()` opens the log.
- **Debug log** (`D`): a passive monospace panel over the deck (keys keep driving the presentation) showing a timestamped event stream — ready/slide/build with direction, theme and font applies, narration on/off and config changes, every TTS call with its duration and estimated cost (`slide 3 seg 1 · Alnilam · 214 chars → 2.4s · ~$0.0041`, previews included) and failures, and window `error` events — plus a live state line (slide/step/theme/narration incl. the active voice · tone or track, the voice rate, and the running TTS spend). Cost is an ESTIMATE: the Gemini API returns token counts (`usageMetadata`), never dollars; the bridge prices them at published Vertex list rates, sends `x-tts-cost` on each fresh synthesis (0 on cache replays), and prints a per-call line plus session total on its console. Events ring-buffer (last 200) from init, so the panel shows history from before it was opened.
- **Font cycling**: `[`/`]` walk a curated list of offline-safe system stacks (sans, rounded, humanist, geometric, two serifs, slab, mono; entry 0 = the theme's own type) applied to `--font-body` + `--font-heading` as inline root properties — they win over any theme and survive theme switches. The choice persists per deck path in localStorage and is restored before the first layout pass; every change re-measures pinned titles and re-runs the overflow guardrail (type metrics differ). `instance.cycleFont(±1)` programmatically.
- **Slide layout cycling** (dev mode only): `L`/`⇧L` walk the CURRENT slide through the layout ring — `auto` (deck default: the `pinTitles` config, **on by default**, + the pinnable heuristic — so out of the box a pinnable slide pins) → `centered` (title in flow, content vertically centered) → `pinned` (title pinned at the pin Y) → `top` (everything flows from the top of the slide) → `split` → `split-flip`. Ring entries that cannot change the slide's look are SKIPPED so every press shows something new: `pinned` when `auto` already pins, `split-flip` when there aren't two content blocks to swap sides. **Split layouts**: the content blocks — everything after the title + subtitle header (which spans the full width, pinned or in flow) — become ~half-width sides in a wrapping flex row, first block left and the rest right; `split-flip` mirrors (bullets left · diagram right ⇄ diagram left · bullets right). A slide whose ONLY content block is a list can't take sides — the engine marks it `.split-columns` and the list itself splits across two CSS columns (`break-inside: avoid` per item). The pick lands on the section as a `data-layout` attribute — the same attribute an author can write in the file, and headless probes can assert on — and it wins over `data-pin` (`pinned` forces the pin, a numeric `data-pin` still sets the Y; `centered`/`top` lay out in flow; the split pair keeps the deck's auto pin resolution for its header). `auto` removes the attribute. A layout pick is a PERSISTED deck edit, so cycling requires dev mode: the pick applies to the DOM instantly and is written back into the file through the edit server (debounced ~600ms, so a cycling burst costs one write/reload, and a pick pending when the slide changes is flushed, not dropped) — the file is the ONLY persistence (no localStorage). Without the server, L toasts what it needs and changes nothing — a presenter can't silently fork the deck from what's on disk. Every change re-measures pinned titles and re-runs the overflow guardrail. `instance.cycleLayout(±1)` programmatically (same gate); `instance.layoutRing(n)` exposes a slide's ring — skips included — so headless probes can assert the skip logic without a server; also in the `/` palette ("Cycle slide layout").
- Touch: swipe navigation.
- URL: `#/<slide>[/<step>]`; back/forward supported. `?theme=<name>` loads any theme at startup.
- **Theme switching**: the theme is the stylesheet link into `themes/`; the engine swaps its href in place, so every token cascades and the deck restyles live. `T` opens the **theme picker**: the theme list (config `themes: [...]`, defaulting to the shipped set baked in at build time) beside a live preview of the *current slide at the current step* — a real embedded deck (`?embedded&theme=<name>#/<slide>/<step>`). `↑/↓`/hover browse (debounced), `Enter`/click applies, `Esc` closes. **Packs** (themes/packs.json, baked in at build; the build fails if a shipped theme is missing from the manifest): the picker opens on the pack list (name + count; the active theme's pack is marked), `Enter` drills in, the `← packs` row or `Esc` goes back, `✳ all themes` flattens; saved-custom and generated themes form dynamic packs at the end. An active filter always searches globally and tags each hit with its pack. **Pack-aware cycling**: `,`/`.` walk the pack-grouped order; a step that would cross into another pack pends instead of applying — a toast names the pack and target theme, the same key confirms, the opposite key or `Esc` cancels, and the pending step times out after 4s. **Quick filter**: printable keys type into a filter bar that narrows the list (substring match; the generate row hides while a filter is active); `Backspace` edits, `Esc` clears the filter first and closes on the second press. Because keystrokes feed the filter, the picker has no letter shortcuts (`⌃T` re-rolls the generate-row candidate; the former `R`/`T` bindings are gone). The applied choice persists per deck path in `localStorage`; **embedded instances never persist** (previews can't pollute the saved choice).
- **Inline-theme mode** (bundled single-file decks): when `<style data-theme="name">` blocks exist, they replace the link — `applyTheme` toggles which block applies (via `media="not all"`; the HTML `disabled` attribute on `<style>` is non-functional per spec, and the engine normalizes either form at init). The picker lists the embedded names (config `themes` narrows), `?theme=` works, and everything else is unchanged.
- **Theme generator**: `⌃T` generates a brand-new contract-complete theme (§5 note) and applies it instantly — press again to re-roll. The roll lives as a `<style data-theme data-generated>` block appended last in `<head>` (wins the cascade over the link/inline base); cycling `<`/`>` or picking another theme deactivates it but keeps it in the theme list under its autoname (`gen-<word>-<hex4>`) until the next roll replaces it. The picker's first row is **“✨ Generate new…”**: selecting it rolls a candidate and previews it live like any other theme (`⌃T` re-rolls while selected; `Enter` applies). Previews for generated and saved-custom themes carry their tokens in the URL — `?gen=<base64url {name, tokens}>` — which the engine applies statelessly at init (works on `file://` and inside bundles). The preview deck loads **once per picker session**; subsequent selections are postMessage'd into the embedded instance (`{__decklightPreview: {theme|gen}}`, parent-origin-guarded) and applied in place — no document reload per candidate, which matters in bundles where each reload would re-parse the whole payload. `⌃⇧T` **saves** the applied generated theme: prompts for a name (sanitized `[a-z0-9-]{1,40}`, `custom-` prefixed on collision with a shipped name), persists `{name → tokens}` into `localStorage['decklight-custom-themes']`, and downloads `<name>.css` (a normal theme file). Saved customs appear in the theme list and picker (tagged “custom”), survive reload, and apply via the same inline-style mechanism — but localStorage is per-origin/per-browser: **the downloaded .css is the portable artifact** (drop it into `themes/` and commit). Unsaved generated autonames are never persisted as the deck's theme choice.
- **Brand logo**: `init({ logo: { onLight, onDark, src?, height?, position? } })` renders a mark as chrome on every slide (default `bottom-left`; also `top-left|top-right|bottom-right`; default height 30px). `onLight`/`onDark` are the variants for light/dark canvases: the engine reads the applied theme's real background luminance (first gradient stop for gradient canvases), sets `data-canvas="dark|light"` on the root, and the matching variant shows — following theme cycling, the picker, and generated themes ( `src` alone shows always). Refs resolve as `'#id'` (clones an inline element — bundle- and `file://`-safe, the `data-cast-inline` idiom), `'<svg…'` raw markup, or an `<img>` URL. In `?print`, every slide gets its own copy. **Hero variant**: `data-logo` on a section prepends a larger in-flow copy of the mark above the slide's content (default 96 design px; `data-logo="128"` overrides) — module openers and cover slides. Hero slides hide the corner chrome (and skip the print copy), the mark doesn't count as pinnable content, and the same on-light/on-dark variant switching applies.
- **Narration**: `V` toggles voice-over; `N` opens the picker (persisted per deck). Two sources. **Recorded**: pre-rendered per-slide audio (`<dir>/slide-NN.m4a`, 1-based like `state.slide`), synced to slide changes; the deck configures `narration: { files: '<dir>' }` or `[{ label, dir }, …]` for several takes. **Live voice**: the player synthesizes each slide's notes on the fly through the local bridge (`decklight tts`, default `http://127.0.0.1:8787/tts`, override via `narration.liveUrl`). The bridge speaks with one of three engines (`--engine`, tools/tts-engines.mjs): **gemini** (gemini-2.5-{pro,flash}-tts on Vertex AI — the only engine that honors a delivery style; no free tier, and a fresh project's per-minute quota 429s under the lookahead's bursts), **chirp** (Chirp 3: HD on the Cloud Text-to-Speech API — the same 30 star-named voices, ~1s a sentence, 1M characters a month free, no style channel), or **piper** (a local neural model — offline, unlimited, free, no credentials; one voice per installed model, and the process is held RESIDENT because piper reloads its ~120 MB model on every start). `GET /ping` reports `{engine, model, voices, stylable}` and the picker offers exactly those voices, skipping the tone step when the engine cannot be told how to speak — a roster the bridge cannot pronounce would be a silent lie. **The voice is the clock**: auto-advance is driven by narration finishing, so when the voice CANNOT be played — a quota 429, an unreachable bridge, a browser that blocked autoplay, a recorded track with no file for this slide — the deck **stops advancing** rather than walking the talk past slides nobody has heard, and says why in a message (`I`) naming the cause and the way out (`--tts-engine chirp` for a 429, `decklight tts` for a dead bridge, one click for blocked audio). Narration switches itself off; `V` retries — the picker drills tracks → Gemini voice (30 prebuilt, flavor-tagged) → tone (six presets or a custom typed instruction, sent as an in-prompt delivery-style prefix). Every voice row carries a ▶ **preview** that speaks an editable test sentence (default "Hey, this is Decklight", input at the top of the voices view, ↺ restores the default) through the bridge in that voice; tone rows preview the drafted voice in that delivery style, and the custom-tone input has a ▶ to audition a typed instruction before committing it. After a preview plays, the rest of its roster prefetches sequentially in the background (all voices neutrally, or all tones for the drafted voice). Two preview caches: the default sentence's cache is permanent once built; the custom sentence's cache holds exactly one sentence and is swapped (old audio freed) when the text changes. **Build-synced auto-advance**: the ⟨CLICK⟩ markers that segment the notes for the speaker view segment the audio too — segment k is synthesized as its own clip and narrates build step k (0 = arrival); when a clip ends the deck reveals the next build, and after the last segment it moves to the next slide, so a deck with well-segmented notes presents itself beat by beat. A segment with no words advances after a short beat; a slide with no notes is skipped; manual navigation mid-clip wins over the pending advance and re-syncs the voice to the new step. **`data-narration="hold"`** on a section marks it interactive (quiz, exercise, live demo): narration plays whatever notes it has and builds still sync, but the deck never auto-advances *off* it — the presenter moves on manually and narration resumes on the next slide. The spoken unit is a **sentence**: each ⟨CLICK⟩ segment splits into sentences, every sentence is its own TTS call and cache entry (slide, segment, sentence, voice, style), playback chains them and advances only after the segment's last one — so first audio arrives after one short synthesis, never a whole paragraph. While narration is on, a **lookahead buffer** keeps the next 10 sentences synthesized in the background (a few parallel low-priority workers, window re-derived from the current position, results landing in the same cache); an unreachable bridge toasts once and pauses the buffer until the next event. `⇧V` downloads per-slide `slide-NN.wav` files **stitched from this same sentence cache** (short silences joining sentences and builds) — already-heard clips cost nothing, only unheard sentences synthesize. **`P` pauses/resumes** narration — audio freezes mid-sentence and resumes exactly there, and auto-advance holds while paused. Captions (`C`) follow the voice **sentence by sentence** during live narration (segment-level when narration is off). With nothing configured, `V` opens the picker instead of failing. Files are generated by `tools/voiceover.mjs`: notes → optional local-LLM rewrite → `--engine piper` (local neural TTS; `--voice` = piper model name) or `--engine gemini` (gemini-2.5-pro-tts on Vertex AI; `--voice` = prebuilt voice name). The built-in speech-synthesis voices were removed — not good enough. `?voiceover` starts narration on the first user gesture. `instance.toggleNarration()` programmatically.
- **Character** (`N` → Character…, or palette → Character…): an animated narrator in a stage corner whose lips sync to the narration — fully offline, no cloud service. Two render modes behind one overlay (`.decklight-character`, persisted per deck): **🎭 2D character** — a layered SVG bust (theme-aware clothing/backdrop, blink, idle sway) with one mouth group per Rhubarb shape (`A–H` + `X` rest); a 30 Hz loop maps `narrAudio.currentTime` onto a **viseme timeline** and shows the matching `[data-mouth]` group, so pause (`P`) and voice speed (`<`/`>`) sync for free. **🎥 Neural video** — a muted picture-in-picture `<video>` talking head (audio always comes from the narration element; muted video is immune to autoplay policy) generated by Wav2Lip or SadTalker on the presenter's own GPU, drift-corrected against the audio clock (±150 ms) and mirroring its play/pause/rate. Timelines and clips come from the **lipsync bridge** (`decklight lipsync`, default `http://127.0.0.1:8789`, override via `narration.character.bridgeUrl`; CORS-open, 127.0.0.1-only, disk-cached in `~/.cache/decklight/lipsync` keyed by audio+params hash): `GET /ping` reports which engines actually resolve (the picker greys out the rest), `POST /viseme?text=` (raw WAV body → timeline JSON v1: `{v, duration, cues: [{t, v}]}` — start-time cues, each shape holds until the next), `POST /video?engine=&portrait=` (raw WAV → muted faststart MP4; strictly serial GPU queue). In **live voice** mode the sentence is the unit here too: the lookahead buffer that keeps 10 sentences of audio warm hands each synthesized sentence's WAV to the bridge, so lip-sync data prefetches through the same window, workers, and promise-cache dedup as the voice — and playback NEVER waits on lip-sync (a late timeline lands mid-sentence; until then the **fallback** animates: `amplitude` (default) drives a coarse 4-shape mouth from a WebAudio analyser, `hide` shows the idle face). In **recorded** mode the overlay loads per-slide sidecars from the track's dir — `slide-NN.visemes.json` / `slide-NN.mp4`, generated by `tools/lipsync.mjs` (rhubarb + optional SadTalker/Wav2Lip batch, hash-incremental like voiceover.mjs) — preferring an inline `<script type="application/json" data-decklight-visemes="slide-NN">` block when present (`decklight bundle` inlines viseme JSONs; fetch is blocked on `file://`). `⇧V` exports `slide-NN.visemes.json` alongside each stitched WAV (same sentence cache, same silence gaps) so a recorded set is character-ready with zero extra synthesis. **Solo** (`N` → Character… → Solo, or palette → "Character solo"): the narrator takes the stage — the slide content, progress bar and slide number step aside (`visibility: hidden` on `.decklight-stage`, which the overlay is a sibling of) and the character centers, sized to the stage (`--character-solo-size`, default `min(74vh, 74vw)`). A talking-head slide with nothing else on it, without authoring one. Works with either render mode, persists per deck alongside `mode`, and is a *presentation* state, not a layout: the root's `decklight-solo` class is only ever set while the character is actually on screen, so turning the character off — or stopping the narration — can never leave a blank stage behind. Turning solo ON shows the character immediately (idling, blinking) rather than waiting for `V`. Config (`narration.character`, all optional): `mode: 'off'|'viseme'|'video'` (picker overrides, persisted), `solo: boolean` (default false; picker overrides, persisted), `bridgeUrl`, `position: 'br'|'bl'|'tr'|'tl'`, `size` (design px, default 220), `svg` (custom art: inline markup, `'#id'` ref, or URL — contract: `[data-mouth="A"…"X"]` groups; optional `[data-eyelid]`/`[data-idle]` get the blink/sway), `sprites: {A: url, …}` (image frames instead), `engine`/`portrait` (video mode; Wav2Lip suits live — static pose, seamless per-sentence cuts; SadTalker suits batch clips), `fallback: 'amplitude'|'hide'`. Bundles: viseme JSONs inline (1–4 KB/slide); per-slide MP4s stay external with a CLI notice — video cannot inline sanely.
- **Command palette**: `/` opens a Claude-style palette — every command with its shortcut, type-to-filter, `Enter` runs, `Esc` clears then closes. Argument commands (Theme…, Font…, Narration voice…, Module…, Find slide…) drill into their pickers; contextual commands appear only when applicable (Save generated theme, Module). Inline arguments work: `goto 27` — or just typing `27` — surfaces a “Go to slide 27 / N” row (clamped to the deck), and selecting the bare “Go to slide…” command keeps the palette open with `goto ` prefilled. Text matching no command falls back to a “Search slides for …” row that opens the finder with the query prefilled.
- **Slide finder**: reached from the palette (`/` → Enter, or the search fallback) — a find-a-slide overlay with the picker's anatomy — a query bar and result list on the left, a live preview of the selected slide on the right. Typing filters as an AND over the query's words against each slide's text; slides whose **title** contains every word rank first, body-only matches follow, and every match is listed as `<slide number> · <title>` (slides without a heading fall back to their leading text). `↑/↓`/hover browse (the preview swaps live), `Enter`/click jumps to the slide, `Backspace` edits, `Esc` clears the query then closes. The preview reuses the picker's lazy embedded-deck mechanism — the iframe boots once (carrying the active theme, generated/custom included via `?gen=`), then selections postMessage `{__decklightPreview: {goto: [slide, step]}}` into it; no reload per candidate.
- **Playlist (multi-deck navigation)**: `Decklight.init({ playlist: { modules: [{title, href}…], index: n } })`. Advancing past the last build of the last slide navigates to the next module (`href#/1/0`); reversing before slide 1 goes to the previous module's end (`href#/999/999` — oversized hashes clamp to the last slide/step). The other modules appear as rows in the **slide finder** (`G`) — marked `▸ <title> — module`, previewed like any slide, and `Enter` loads that file; the slide-number chrome shows the module title and opens the finder on click. There is no separate module menu: "go somewhere" is one question with one answer. Works on `file://` with relative hrefs; embedded instances never chain.
- **Speaker view**: `S` opens a popup (synced via BroadcastChannel): current + next slide thumbnails, notes (with `⟨CLICK⟩` markers highlighted as the matching build lands), elapsed timer, build step list (provider labels). **Rehearse mode**: pressing `S` again (in the deck or in the popup; the header badge also toggles) swaps the prose notes for the slide's `aside.rehearse` cue cards (§1) — rendered large and bold, one cue per segment, same said/now/next highlighting. Slides without rehearse notes fall back to the full prose. `S` in the deck only opens a new popup when none is connected; while one is open it toggles the mode.
- **Print/PDF**: `?print` renders all slides sequentially, every build complete, terminal casts fully expanded, one slide per page (`@media print` CSS). No JS needed after layout.
- **Overflow guardrail**: content that exceeds the slide flex-shrinks into a scroll box and reads as clipped. The engine warns (`console.warn`) and marks the section with a `data-overflow` attribute — on each slide activation, and for the whole deck in `?print` — so authoring agents can assert `[data-overflow]` is absent in their headless verification.
- **Pinned titles**: `pinTitles: true | false | <px>` keeps slide titles at one vertical position instead of drifting with content height. **On by default** (`true`); `pinTitles: false` restores the drift-with-content centering deck-wide. `true` pins at **99px** from the stage top (design coordinates — the natural title position of the course's "The Single-Agent Limit" diagram slide, the chosen reference); a number pins at that Y. The leading `h1`/`h2` of each **pinnable** section is absolutely positioned at the pin Y; the section reserves `pin Y + measured title height + 18px` of top padding so the remaining content centers below. Pinnable = has a leading `h1`/`h2` AND content beyond it (`ul, ol, svg, pre, table, .terminal, img, .columns` outside the notes) — title cards and quote/statement slides stay centered. Per-slide: `data-pin` forces a pin (even when the config is off), `data-pin="none"` opts out, `data-pin="<px>"` overrides the Y. Titles are re-measured on `sync()` and when webfonts finish loading; print uses the same layout. A detected **subtitle** (§1) joins the pinned header block — absolutely positioned directly beneath the title (6px gap) and included in the reserved padding, so content centers below title + subtitle.
- **Terminal footprint**: a terminal's screen area has a stable size — a **16:9 aspect floor** (width-driven) clamped by the `data-rows` cap as the max — so the box arrives full-size before anything plays and never resizes as steps stream in (output beyond the box scrolls). Real print expands casts fully.
- `Decklight.init(config)` options: `transition`, `hash` (default true), `controls` (default true: prev/next chevrons; the progress bar is the `H` toggle, above), `slideNumber` (default `false | 'n' | 'n/N'`), `width/height` design resolution (default 1280×720, scaled to fit), `themes` (array of theme names for the picker/cycle; default: all shipped themes), `playlist` (multi-deck navigation, above), `pinTitles` (pinned titles, above), `concepts` (diagram concept-color pinning, §3), `logo` (brand mark, above).
- **Single-file bundling**: `decklight bundle <deck.html> [-o out.html] [--themes current|all|a,b,…]` flattens a deck into one self-contained HTML — runtime and structure CSS inlined, selected themes embedded as inline-theme blocks, `data-cast` terminals converted to `data-cast-inline`, images to data: URIs. Playlist links can't resolve inside a single file; the CLI lists them as a notice.
- **Merged single-file presentation**: `decklight bundle <deck.html> --all [--title "…"]` follows the deck's playlist and concatenates EVERY module's sections into one deck (explicit form: `decklight bundle a.html b.html … -o one.html`). Each module's first section is marked `data-module="<title>"`; embedded cast ids are prefixed per module to stay unique; relative asset refs are rebased onto the first deck's directory; the per-module `playlist` config is stripped. **In-file module navigation**: `data-module` sections are ordinary slides, so the finder (`G`) already finds them by title or body text and `goto()`s them with no page load; the chrome module tag shows the module of the current slide (nearest preceding marker).

## 9. Public JS API

```js
Decklight.init(config) → instance
instance.next() / .prev() / .goto(slide, step)
instance.on('slide'|'build'|'ready', fn)
Decklight.registerBuildProvider(el, provider)   // available pre- and post-init
instance.state → { slide, step, totalSlides }
instance.sync()                                // re-scan DOM (for dynamic decks)
instance.theme(name)                           // switch theme programmatically
instance.themePicker.open() / .close()
instance.generateTheme()                       // ⌃T programmatically; returns the autoname
instance.cycleFont(dir)                        // [ / ] programmatically (±1)
instance.cycleLayout(dir)                      // L / ⇧L programmatically (±1; dev mode only)
instance.layoutRing(slide?)                    // the layout ring a slide would cycle (skips applied)
instance.toggleNarration()                     // V programmatically
instance.saveGeneratedTheme(name?)             // ⌃⇧T; a name argument skips the prompt
```

## 10. Repository layout & tooling

```
decklight/
  SPEC.md  README.md  package.json
  src/core/      engine: init, nav, builds, transitions, auto-animate, notes, print, svg-ns
  src/md/        markdown slide support (marked)
  src/code/      highlight bundling + line stepping provider
  src/terminal/  ansi.mjs (parser), player.mjs (provider + modes)
  cli/           decklight.mjs (dispatcher: rec/refresh/export/bundle/tts/lipsync/edit/dev) + rec.mjs, bundle.mjs, edit.mjs, dev.mjs, agents.mjs (AI-agent roster)
  tools/         voiceover.mjs (batch TTS) + voiceover-server.mjs (tts bridge), lipsync.mjs (batch visemes/video) + lipsync-server.mjs (lipsync bridge), visemes.mjs (timeline v1)
  themes/        30 × <name>.css + gallery.html
  dist/          decklight.js (IIFE, global Decklight), decklight.css
  demo/          kitchen-sink.html + casts/
  test/          node:test units (ansi, md, builds math, cast format) + render.mjs (headless Chrome assertions) + contrast.mjs (theme validation)
```

- Build: `npm run build` = esbuild bundle (`src/index.js` → `dist/decklight.js`, minified + sourcemap) + CSS copy. Node ≥ 20. Runtime has **zero** runtime dependencies (marked + highlight.js are bundled at build time); `node-pty`, `js-yaml` are CLI-only deps.
- Verification culture: `npm test` runs units; `npm run verify` builds, launches headless Chrome against `demo/kitchen-sink.html`, and asserts: slide count, build counts per slide, provider steps, ANSI render output, theme token presence, no console errors.

## 11. Non-goals (v1)

Vertical slide nesting · full terminal emulation (vim/htop) · multiplex/follow-along · plugin system (providers + events cover extension) · PPTX export · mobile authoring.
