# Decklight — Specification v1

A presentation library in the Reveal.js tradition, designed to be **authored by AI agents and humans alike**: a deck is a single HTML file, the runtime is one JS + one CSS + one theme CSS, no build step. Every feature is designed to be **verifiable by a headless render** (the authoring agent can prove a deck works).

This document is the contract. All subsystems (core, themes, terminal, demos) build against it.

**Sections are named, not numbered.** Every heading below carries a `MNEMONIC` — that is
the identifier a code comment, a commit message, a review or a skill file cites, and it is
the only form that should ever be used. Chapter numbers move whenever a section is
inserted or split, which silently rots every reference that named one; a mnemonic survives
being moved, and it says what it points at.

| Mnemonic | Section |
|---|---|
| `DECK_ANATOMY` · `SLIDE_DENSITY` · `COMPARISON_SLIDES` | how a deck and a slide are put together |
| `BUILDS` · `BUILD_AUTHORING` · `BUILD_SEMANTICS` · `BUILD_ENTRANCES` · `BUILD_PROVIDER_API` | progressive reveals |
| `SVG_DIAGRAMS` · `CHARTS` | diagrams and data |
| `MOTION` · `SLIDE_TRANSITIONS` · `AUTO_ANIMATE` · `ELEMENT_ANIMATIONS` | movement |
| `THEMING` · `THEME_DISTRIBUTION` | the token contract, and sharing a theme |
| `CODE_AND_MATH` | code blocks and LaTeX |
| `TERMINAL_RECORDINGS` · `RECORDER_CLI` · `CAST_FORMAT` · `TERMINAL_PLAYER` · `ASCIICAST_INTEROP` | truthful terminals |
| `PRESENTING` | keys, speaker view, narration, print/PDF, overflow |
| `JS_API` · `DECK_IMPORT` | the public API, and bringing a deck across |
| `MARKETPLACE_REGISTRY` | catalogs of themes, templates, skills and engines — registered, not fetched |
| `REPO_LAYOUT` · `NON_GOALS` | for contributors |

---

## DECK_ANATOMY — Deck anatomy

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
  </div>
  <script src="decklight/dist/decklight.js"></script>
  <script>Decklight.init({ transition: 'fade' });</script>
</body>
</html>
```

- Slides are `<section>` children of `.decklight`. Flat list (no vertical nesting in v1).
- **Markdown slides were removed in 0.4.0.** `data-markdown` + a `<script type="text/template">` body was a second authoring surface for the same DOM, and it earned its bundle: `marked`, a `::: build` directive, a parallel notes syntax, a `` ```chart `` fence that existed only because a nested `</script>` cannot live in a template, and a math path that had to extract every span *before* the parse so TeX underscores would not become emphasis. HTML is the one surface now. A deck still carrying `data-markdown` sections would render them EMPTY — the template is a `<script>` no browser paints — so the engine recognises the attribute for exactly long enough to refuse out loud: it marks the section `data-markdown-removed` (assertable headlessly) and warns per slide, naming the slide number. It parses nothing.
- Speaker notes: `<aside class="notes">`.
- **Rehearse notes** (optional, build-time authored): a condensed cue-card variant of the notes for the speaker view's rehearse mode (PRESENTING) — a few words per segment instead of full prose, with **exactly the same ⟨CLICK⟩ segmentation** as the notes so build-step highlighting aligns. `<aside class="rehearse">` as a sibling of the notes aside. Slides without a rehearse aside fall back to the full notes in rehearse mode.
- **Subtitle**: the `<p>` immediately following a slide's leading `h1`/`h2` is auto-marked `.subtitle` and gets one canonical look (muted, 0.72em). Opt out per slide with `data-subtitle="none"` on the section; an author-placed `class="subtitle"` is respected as-is. Don't bake subtitle text into diagram SVGs — author it as this `<p>` so it themes and scales with the deck.
- **Background media**: `data-background-image="hero.jpg"` on a section renders the image full-bleed behind the slide's content — `data-background-size="cover|contain"` (default cover), `data-background-position` (default center). `data-background-dim="0.5"` lays a canvas-colored (`--bg`) overlay between the media and the content so text stays readable over arbitrary photos. `data-background-video="clip.mp4"` plays a muted looping `playsinline` clip while the slide is active — play/pause is driven from the engine's slide event, so a deactivated slide's video is *paused*, not merely hidden; `data-background-poster="poster.jpg"` is its stand-in still (required for print, PRESENTING). The engine injects the layer as an idempotent `.slide-bg` first child on `sync()` — absolutely positioned below the content, so backgrounds never count against the overflow guardrail (PRESENTING) and transitions/auto-animate carry them for free. `class="full-bleed"` on an `<img>` gives a *content* image the same cover-the-slide treatment (absolute inset-0, object-fit cover, under the in-flow text); images inside split layouts (PRESENTING) are capped (object-fit contain, max-height) so a tall photo can't blow the slide. `decklight bundle` inlines `data-background-image`/`data-background-poster` as data: URIs like `<img src>`; background videos stay external with a CLI notice (PRESENTING).

### SLIDE_DENSITY — How much goes on a slide

The overflow guardrail (PRESENTING) is the **late** failure. It fires once content is
already clipped, which is a different and worse problem than "fits, but nobody
can read it from the back of the room". Nothing catches the second one for you,
so it is a rule rather than a check:

- **One idea per slide.** If the title needs an "and", it is two slides.
- **~3–4 bullets, or ~2 short paragraphs, per column.** Past that, split the
  slide rather than shrinking the type.
- **Prefer one slide per item being compared** over grouping two or three items
  onto a single slide with sub-columns each. Grouping multiplies
  content-per-slide fast, and it is how a deck ends up technically renderable
  and practically unreadable.
- A slide that has been adapted with `style="font-size:0.85em"` to make things
  fit is telling you something. Take the note.

This matters most for an agent authoring twenty slides in one pass with no
human looking until the end — the failure is invisible to every check that
exists, because every slide renders.

### COMPARISON_SLIDES — Comparison slides (pros / cons, this-vs-that)

The most common structured slide, and the one with a trap in it. Use `split`
(PRESENTING) with **two sibling blocks and an optional third as a footer**:

```html
<section data-layout="split">
  <h2>git</h2>
  <p>Distributed version control — the substrate everything else sits on.</p>

  <div>
    <h3>Pros</h3>
    <ul><li>Fast, offline, ubiquitous</li><li>Scriptable end to end</li></ul>
  </div>

  <div>
    <h3>Cons</h3>
    <ul><li>Sharp edges around rebase</li><li>Submodules</li></ul>
  </div>

  <p><strong>Alternatives:</strong> Mercurial; Jujutsu</p>

  <aside class="notes">Pros first, then the two that bite. ⟨CLICK⟩ Alternatives briefly.</aside>
</section>
```

The two `<div>`s become the columns and **share a top edge**; the trailing `<p>`
becomes a full-width centred footer under both. Nothing else is needed — in
particular:

> **Do not combine `data-layout="split"` with your own column flexbox.** A
> hand-rolled `display:flex` shell inside a section that also carries
> `data-layout="split"` gives the slide two layout systems arguing: the split
> row's own alignment overrides the space `[data-pinned]` reserves for the
> pinned title, the columns shrink, every bullet wraps, and the footer is
> pushed off the bottom. Pick one — `split`, or your own shell with **no**
> `data-layout`. This is a real deck that shipped that way; the overflow
> guardrail caught it, which is why PRESENTING asks you to check.

Three columns is deliberately not a shape here (PRESENTING). Two and a footer, or
another slide — see SLIDE_DENSITY for why.

## BUILDS — Builds (Keynote-style; Reveal calls these fragments)

Design goal: **the container opts in, the engine does the rest** — one attribute on the
container, zero classes on the items.

### BUILD_AUTHORING — Authoring

| Syntax | Meaning |
|---|---|
| `data-build` on a container (`ul`, `ol`, `table`, `svg`, `g`, `div.columns`, …) | each **direct child** (li / tbody tr / g or shape / column) becomes one build step, in DOM order |
| `data-build` on a leaf element (`p`, `img`, `blockquote`, `pre`, one `g`) | the element itself is one build step |
| `data-build="fade-up"` | entrance style (see 2.3) |
| `data-build-order="3"` | explicit step index within the slide (default: document order) |
| `data-build-stay` on a child of a `data-build` container | child is exempt (stays static) |

### BUILD_SEMANTICS — Engine semantics

- All build steps on a slide form one ordered sequence (document order, overridden by `data-build-order`; ties advance together).
- Navigation: `→`/`Space`/click advances one step; `←` reverses; arriving from the previous slide shows step 0 (nothing built); arriving *backwards* from the next slide shows all steps built.
- Hidden steps: `visibility: hidden` (not `display:none` — layout must not shift).
- Events: `decklight:build` fires with `{slide, index, total, direction}`.
- URL: `#/<slide>/<step>` deep-links to a build state.

### BUILD_ENTRANCES — Entrance styles

`fade` (default) · `fade-up` · `fade-down` · `zoom` · `pop` (overshoot) · `draw` (SVG paths/lines: stroke-dashoffset animation; non-stroke elements fall back to fade) · `highlight` (element already visible; step emphasizes it: accent outline + others dim) · `none` (instant).

All entrance styles are CSS-driven (`.build-step[data-build-state="done|current|pending"]`), duration via `--build-duration` (theme-overridable, default 300ms).

### BUILD_PROVIDER_API — Build Provider API (for subsystems)

Complex widgets (code stepping, terminal player) register **build providers** instead of DOM steps:

```js
Decklight.registerBuildProvider(element, {
  count: 4,                 // number of steps this widget contributes
  apply(i) { ... },         // called with current step index (0 = nothing, count = all)
  label(i) { return 'git status' }  // optional, for the speaker view step list
});
```

The engine interleaves provider steps into the slide's sequence at the element's document position. Providers must be idempotent (`apply` may be called with any index in any order — e.g. deep links).

## SVG_DIAGRAMS — SVG diagrams (first-class)

- Inline SVG is the canonical diagram format. `data-build` on `<svg>` or a `<g>` makes direct-child groups progressive (exactly the pattern from BUILD_AUTHORING).
- **Theme-aware diagrams**: themes define diagram tokens (THEMING). Diagrams authored with
  `var(--d-stroke)`, `var(--d-fill-1)`…`var(--d-fill-6)`, `var(--d-text)`, `var(--d-muted)`,
  `var(--d-accent)` re-color automatically across all 30 themes.
  Hardcoded-color SVGs still work; they just don't adapt.
- `data-build="draw"` on groups animates strokes (paths, lines, polylines) via dash-offset.
- The runtime namespaces `id` attributes inside each inline `<svg>` at init (prefix `svg{n}-`, rewriting `url(#…)` and `href="#…"` refs) — the defs-collision bug class is eliminated at the engine level.
- **Concept colors**: `data-concept="agent"` on a shape (or a group — its direct-child shapes recolor; text never does) pins that concept to ONE diagram-fill slot deck-wide, so a recurring concept never changes color between diagrams. A shape recolors its fill; an unfilled outline (`fill="none"` — a line-chart stroke, a wire shape) recolors its stroke instead, since painting its fill would close it. Resolution: `init({ concepts: { agent: 3 } })` pins a slot (1–6) or any raw CSS color (`'var(--d-accent)'`); unconfigured names fall back to a stable hash of the name, identical across sessions and decks. The indirection targets a slot (`var(--d-fill-N)`), not a color, so concept identity survives all themes, generated ones included. Two concepts hashing to the same slot get a console warning telling the author to pin one explicitly. Applied on `sync()` (idempotent, covers dynamic slides).

### CHARTS — Charts (`data-chart`)

Declarative charts from inline JSON — a chart IS a theme-aware SVG diagram, generated at init instead of drawn by hand. No chart library, no images, no new theme tokens.

```html
<div class="chart" data-chart="bar" data-title="Latency by release" data-build="draw">
  <script type="application/json">
  { "labels": ["v1", "v2", "v3"],
    "series": [ { "name": "p50", "data": [120, 80, 45] },
                { "name": "p99", "data": [340, 260, 190], "concept": "agent" } ] }
  </script>
</div>
```

- **Types**: `bar` (grouped), `line`, `area`, `pie` (`donut` is an alias; `"donut": true` also works). Category x-axis; ~5-tick linear y-axis with nice-number bounds, zero always on the grid; pie/donut renders slices with outside name labels and on-slice percentage labels. An inline legend appears automatically on multi-series axis charts (`"legend": false` opts out, `true` forces one). Out of scope in v1: CSV input, stacked bars, dual axes, tooltips/interactivity.
- **Colors come exclusively from the THEMING diagram tokens**: series *i* → `--d-fill-i` (cycling past 6), axes `--d-stroke`, labels `--d-text`, gridlines `--d-muted`. Value labels sit on the slice fills, which is exactly the `--d-text`-against-every-fill contrast gate `test/contrast.mjs` already enforces — every shipped and generated theme colors charts correctly with zero chart-specific work.
- **Ink**: the `--d-fill` panels sit deliberately close to the canvas (gated for text ON them, never against `--bg`), so charts use the hand-drawn-diagram box idiom — bars, slices and legend swatches are outlined with `--d-stroke`, and every line/area stroke rides on a `--d-stroke` casing under its fill-colored core. Series identity lives in the fill slot; legibility lives in the ink, in every theme.
- **Concepts**: `"concept": "agent"` on a series emits `data-concept` on that series' `<g>`, resolved by the ordinary SVG_DIAGRAMS concept pinning — bar/slice/area fills and dot fills repaint, a line's core stroke recolors via the `fill="none"` rule above, and the casing sits one group deeper so the ink is never repainted.
- **Builds**: the wrapper's authored `data-build` moves onto the generated `<svg>`, which emits one `<g>` per series — the BUILD_AUTHORING SVG-container semantics apply untouched, so series step in per ⟨CLICK⟩ with no build provider. `data-build="draw"` draws each series' ink (bar/slice outlines, line casings and cores) via the BUILD_ENTRANCES dash-offset machinery, while fills, dots and labels materialize on the existing `draw-fade` channel — nothing of a series is visible before its step.
- **Sizing**: `viewBox` 640×360 by default; `data-aspect="4:3"` (or an `"aspect"` JSON key, `"w:h"`) overrides the height. The chart scales to its container width and behaves as an ordinary content block in split layouts and `?print`.
- **Errors are visible**: invalid input (bad JSON, unknown type, a pie with two series, …) renders a `.chart-broken` error box naming the problem — the terminal player's broken-box idiom — never a blank slide, never a console explosion.

## MOTION — Motion

### SLIDE_TRANSITIONS — Slide transitions
`transition: 'none' | 'fade' | 'slide' | 'scale' | 'flip'` — deck-level config, per-slide override `data-transition`. Duration `--transition-duration` (default 350ms). Reduced-motion: all transitions collapse to `none` under `prefers-reduced-motion`.

### AUTO_ANIMATE — Auto-animate (Magic Move)
- `data-auto-animate` on two adjacent sections.
- Matching: elements sharing `data-id`; unmatched elements fade in/out.
- Animated properties: position/size (FLIP transform), opacity, color, background, border-radius, font-size. Works for HTML and inline-SVG elements (x/y/width/height via transform).
- Duration `--auto-animate-duration` (default 500ms).

### ELEMENT_ANIMATIONS — Element animations
`data-animate="pulse | float | shake | spin | blink | bounce | swing | glow | breathe"` — looping attention animations, start when the slide becomes active (and only then; pause on inactive slides). Respect reduced-motion.

## THEMING — the token contract

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

Runtime-**generated** themes (PRESENTING, `⌃T`) satisfy the same contract: `src/core/themegen.js` derives every token with WCAG luminance math and iterates until all of `test/contrast.mjs`'s gates pass — a generated theme can never fail validation (property-tested across seeds in `test/themegen.test.mjs`).

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

### THEME_DISTRIBUTION — Distributing a theme

A theme travels as what it already is: **one CSS file**. There is no registry and no version number — the distribution unit is the file (a repo, a gist, the `.css` that `⌃⇧T` downloads), and compatibility with a runtime *is* passing that runtime's check. When the contract grows a token, the check names exactly what an older theme is missing.

- **`decklight theme check <file|url>`** runs the token contract and the WCAG gates (`tools/theme-check.mjs` — the same function `test/contrast.mjs` runs over the shipped themes, so the two can never drift) on any file, so a theme author outside this repo can prove their file is contract-complete before sharing it.
- **`decklight theme add <file|url> <deck.html>`** validates and then installs, refusing anything the shipped set would not be allowed to contain — a deck is never left carrying a broken theme, and a file that fails leaves the deck byte-for-byte unchanged. It reads from disk or over https, takes `--name` to install under another name, and `--dry-run` to report without writing.

An installed theme becomes a `<style data-theme="<name>" data-theme-added media="not all">` block appended last in `<head>`, so an active one wins the cascade over the deck's own link or inline theme. `data-theme-added` is what distinguishes it from the deck's own inline theme blocks: without that distinction a link-mode deck that gained one added theme would flip to inline mode and its whole theme list would collapse to that single file. Added themes therefore behave like saved customs — extra entries in the list, applied by media toggle — and work identically in both modes. They appear in the picker under a dynamic **Added** pack (tagged `added`), cycle with `,`/`.`, resolve from `?theme=`, and travel with `decklight bundle` because they are already inline in the deck. Re-running `add` for the same name replaces the block in place: re-adding **is** the update path.

## CODE_AND_MATH — Code & math

- `<pre><code class="language-sql">…</code></pre>` — highlighting via bundled highlight.js
  (languages: sql, js, ts, python, bash/shell, yaml, json, java, go, rust, html/xml, css, plaintext), themed through the `--hl-*` tokens (no separate hljs theme files).
- **Line stepping**: `data-lines="1|3-5|all"` on the `<pre>` → registers a build provider with one step per segment; non-highlighted lines get `--dim-opacity`. `data-lines-numbers` shows line numbers.
- Escaping rule for authors: use `&lt;` inside code blocks.
- **Math** (`data-math` on the section): LaTeX math renders at init to MathML Core via
  bundled [Temml](https://temml.org) — no per-deck build step, no network fetch, no
  webfonts (evergreen browsers render MathML natively; `?print` output included).
  Delimiters: `$$…$$` display, `\(…\)` inline.
  Single-`$` is **deliberately not a delimiter** (currency false positives:
  "between $5 and $10" is prose, not math); a literal dollar next to real math is
  written `\$`. Math inside code — fenced blocks, inline spans, `<pre><code>` — is
  left alone, as are speaker asides (notes are spoken) and SVG text. Sections without `data-math`
  are never scanned — zero cost, zero behavior change. A TeX parse error renders as
  a visible red error span, never a broken init. Math is core, not a plugin (NON_GOALS).

## TERMINAL_RECORDINGS — Terminal recordings

### RECORDER_CLI — Recorder CLI (authoring-time; the only part with native deps)

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

### CAST_FORMAT — Cast format (`.cast.json`, version 1)

```json
{
  "decklightCast": 1,
  "meta": { "shell": "zsh", "cols": 100, "rows": 28, "recorded": "ISO-8601", "prompt": "$ " },
  "script": { /* the source YAML as JSON (secrets scrubbed — see RECORDER_CLI) */ },
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

### TERMINAL_PLAYER — Player (runtime; zero native deps)

```html
<div class="terminal" data-cast="casts/demo.cast.json" data-mode="step"></div>
<!-- or, for decks that must work on file:// (fetch of local files is blocked): -->
<div class="terminal" data-cast-inline="#my-cast" data-mode="step"></div>
<script type="application/json" id="my-cast">{ "decklightCast": 1, … }</script>
```

- `data-mode="step"` (default): registers a build provider — each advance **types the command**
  (synthesized keystrokes, 80–135ms jitter, each landing with a synthesized switch sound: data-type-sound="thocky" (default) | "creamy" | "clacky" | "off") then streams its real
  output with recorded pacing compressed to ≤2.5s per step (`data-max-step` override).
  Provider is idempotent: `apply(i)` renders steps `< i` instantly-complete, animates step `i` if
  reached by a forward advance, clears the rest.
- **Typing sound**: a subtle synthesized key click accompanies each typed character
  (WebAudio — a ~35ms bandpassed noise tick with jittered pitch/level, no asset;
  spaces land deeper, with more bass). Three voicings, `data-type-sound="thocky"`
  (default) | `"creamy"` | `"clacky"`, or `"off"` to mute. A `♪ voice` titlebar button
  lets the presenter cycle thocky → creamy → clacky → off live; that choice persists per
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

### ASCIICAST_INTEROP — asciicast v2 interop

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

## PRESENTING — Presenting & output

- Keyboard: `→/←/Space` steps+slides, `Home/End`, `O` overview grid, `B` blackout, `F` fullscreen, `T` theme picker (`,`/`.` cycle the theme, `[`/`]` cycle the font), `L`/`⇧L` cycle the current slide's layout (author mode — a persisted deck edit), `Z`/`⇧Z` undo/redo deck edits (author mode), `A` ask an AI agent to edit the deck (author mode), `/` command palette, `V` narration (`N` picks track / live voice / tone; `P` pauses/resumes; `<`/`>` change the voice speed in 0.25× steps, 0.25–2×, persisted per deck — YouTube's shortcut), `C` captions, `W` pen / `⇧W` laser pointer (draw on the slide, `⌫` clears), `K` presenter clock, `H` progress bar, `D` debug log, `` ` `` messages, `G` slide/module finder (deliberately not `⌘F` — browser find stays untouched), `R` restore a version from git history (author mode), `?` help overlay.
- **Captions** (`C`): a YouTube-style bar at the bottom showing the current notes segment — the same ⟨CLICK⟩-segmented text the live voice speaks — synced to slide/step, with narration on or off. Slides/steps without notes show no bar. Persists per deck in localStorage.
- **Presenter clock** (`K`): the wall-clock time (HH:MM) and the elapsed talk time, directly below the slide number — positioned so it never covers the slide number, the message window, or the default logo/controls corners. The elapsed count starts at the deck's **first advance after load**, not at page load — a deck idling on its title slide while the room fills is not a talk yet. Off by default, persists per deck in localStorage, never rendered in `?print`. `instance.toggleClock()` programmatically.
- **Progress bar** (`H`): a hairline along the bottom edge of the deck whose width tracks the position through the deck (slide plus build step, slide 1 empty → last slide full), updated on every navigation — keys, `G`, `Home`/`End`, deep links. A passive readout of the deck state: it never drives navigation or auto-advance. Sits at the very bottom edge, below the captions bar, the character overlay and the corner chrome, so it covers none of them. Off by default, persists per deck in localStorage, never rendered in `?print`. `instance.toggleProgress()` programmatically.
- **Ink annotations** (`W` / `⇧W`): Keynote-style presenter ink on a canvas overlay above the slides. `W` toggles the **pen** — the cursor becomes a crosshair and pointer drags (mouse, touch, stylus) draw strokes in the theme's `--accent`; `⇧W` toggles the **laser pointer** — a glowing accent dot with a ~300 ms fading trail follows the pointer. `Backspace` clears the canvas while a tool is active. Annotations are EPHEMERAL: cleared on every slide change, never persisted, never rendered in `?print` (the annotator is not instantiated there — the clock pattern, exclusion by construction). Strokes are stored in **design coordinates** and redrawn at the engine's scale, so a window resize or rescale never drifts them off their slide positions; the ink color is read live from the applied theme, so switching themes recolors the next stroke. With no tool active the canvas is `pointer-events: none` — slide clicks and touch swipes work exactly as before. `instance.annotate = { toggle, laser, clear, stroke }` programmatically (`stroke(points)` draws one from design-coordinate points — the headless-harness and demo-driver hook).
- **Transcript** (palette → Transcript…): the deck's full spoken script — every slide's notes segments in order, slide titles jump on click — with export to plain text or markdown (`<deck>-transcript.txt|.md`). Also programmatic: `instance.transcript.text()` / `.markdown()` / `.open()`.
- **Author mode (edit server)**: `decklight author <deck.html>` serves the deck over localhost with live reload and accepts persisted edits from the player. Endpoints: `GET /edit/ping` (capabilities: deck name, undo/redo depths, git state, detected agents, `agentBusy`), SSE `GET /edit/events` (`reload` on any file change; named `agent` events for job status), `POST /edit/notes {slide, text}`, `POST /edit/layout {slide, layout}` (writes `data-layout` into the slide's `<section>` tag; `auto` removes it; a no-change write is skipped), `POST /edit/undo` / `POST /edit/redo`, and `POST /edit/agent {prompt, agent?}`. The server binds `127.0.0.1` only; `--remote` (or a chosen `--host <addr>`) additionally listens on the LAN for the phone remote control, printing a LAN URL (IP from `os.networkInterfaces()`) that carries a per-run random token. Off-loopback access is decided by one exported classifier, `allowRemote(req, token)`: loopback always answers; a non-loopback caller reaches **only** `/remote/*` paths carrying the token (`?t=` or `x-decklight-token`); everything else — every `/edit/*` mutation and the static files — refuses non-loopback callers **unconditionally**, flag or no flag. Without `--remote` nothing changes.
- **Present mode (read-only server)**: `decklight present <deck.html> [--port 8790]` plays a deck you did **not** author. It serves the current directory (which the deck must sit inside, so a source deck's `../dist/decklight.js` still resolves) over `127.0.0.1`, **GET only**, with the same port-conflict handling as the edit server (`listenTakingOverIfNeeded`). It exists because a deck travels: code inlined into one runs in front of an audience that installed nothing, and a deck opened over `file://` gets no policy at all. Serving it instead buys a **`Content-Security-Policy` HTTP header**, which the document cannot override the way it could a `<meta>` tag an attacker edited in the same pass as the payload. The policy is `default-src 'none'` plus exactly what a SPEC'd deck needs: `media-src`/`connect-src` reach `https:` (a recorded track's `dir` may be an absolute URL, background video stays external, and a manifest track's presigned URL has no knowable origin to pin), `frame-src`/`frame-ancestors` are `'self'` (the theme picker, slide finder and speaker view boot the deck into same-origin iframes), `style-src` allows inline (themes are inline `<style data-theme>` blocks and the engine writes inline custom properties), and `object-src`/`base-uri`/`form-action` are `'none'`. `script-src` must allow inline — a bundled deck **is** inline script — so the header does not stop a deck from executing; it constrains where that execution can reach. Naming what runs is `PRESENT#AUDIT`, removing it is `PRESENT#STRICT`. The **`/edit/*` routes are not registered at all**: a POST to one is answered exactly like a POST to any unknown path, because there is no route to have refused it. Nothing in the command writes a file. The local TTS/lipsync bridges are deliberately unreachable — live synthesis is an authoring-path engine, and recorded narration needs no bridge. No `--remote` here; the relay moves in `PRESENT#REMOTE`.
- **Undo/redo** (`Z`/`⇧Z`): the server keeps ONE in-memory edit history — whole-file snapshots, capped at 200 — fed by every mutation it performs (layout picks, notes saves, agent runs). Undo/redo rewrites the deck file; the watcher's reload shows the result (the hash keeps the position). The history is deliberately **independent of git**: commits never consume or reset it, and undoing never touches the repository. A file edited externally between an edit and its undo isn't lost — the current content rides the opposite stack. Empty stacks answer 409, and the player toasts the remaining depths.
- **Git autocommit**: with `--git` (or automatically when the deck already sits inside a repository; `--no-git` opts out) the server commits the deck on a regular basis — every `--commit-every` seconds (default 300) when it actually changed, plus an opening commit and a final one on Ctrl-C. `--git` creates the repository when none exists; `decklight author` ASKS first on a TTY ("no git repository here — create one and auto-commit?"). A repository decklight creates starts with a starter `.gitignore` — `.shots/` (screenshot evidence), `.DS_Store`, and, behind a delete-this-line comment naming the tradeoff (bulky vs. cloud narration costing money to regenerate), `voiceover/` — written between `git init` and any initial commit; an existing `.gitignore` is never touched, and a repository decklight didn't create never gets one. Only the deck file is staged (`git add -- <deck>`), and a machine with no git identity gets a per-commit `-c user.name/user.email` fallback rather than a silent failure. **When to commit** is chosen by `--git-mode`: `agent` (the **default**), `timer`, or `off`. In `agent` mode a completed agent edit produces one commit carrying the agent's own summary as the subject — a failed run or one that changed nothing commits nothing — **and** the cadence keeps running underneath as a backstop, held back only while a job is in flight so no commit ever captures a half-finished agent run. `agent` is therefore a superset of `timer`, which is what makes it safe to default to: nobody loses the periodic safety net. A timer is the wrong boundary for agent-authored work on its own — the commits land on a clock that lines up with nothing the agent did and every message reads `autosave` — but it is the right backstop, because an agent job only ever sees edits it made.

Authorship is **structural, not detected**: the server spawns the agent itself and diffs the deck around that process. An agent driven from OUTSIDE that flow — a `claude` session in another terminal — is indistinguishable from a hand edit, and nothing in the filesystem could tell them apart. Such an agent declares itself instead, by `POST /edit/commit { message }` when it finishes a logical change; the installed authoring skill instructs agents to do exactly that. The same endpoint is how a multi-step agent marks intermediate boundaries. Uncommitted work is committed before an agent job starts, so the agent's commit holds only the agent's work. Agent-supplied messages are untrusted text: collapsed to a single line, length-capped, and never allowed to begin with `-`. `decklight init` states the policy when it creates a repository rather than asking about it.
- **Ask an agent** (`A`): author mode drives whichever AI coding agent CLIs the authoring machine has installed — the roster (`cli/agents.mjs`) covers **Claude Code** (`claude -p … --permission-mode acceptEdits`), **Codex CLI** (`codex exec --full-auto …`), and **IBM Bob** (`bob -p … --accept-license`), plus Gemini CLI, GitHub Copilot CLI, OpenCode, Goose, Aider, Cursor CLI, and Qwen Code — each as a headless one-shot invocation, detected by probing `$PATH`. A opens a prompt overlay (agent picker when several are detected; `--agent` sets the default); the server snapshots the deck, spawns the agent in the serving directory with the instruction wrapped in deck context, and streams start/done status over SSE (toasts in the player; 10-minute timeout; strictly one job at a time — `agentBusy` survives reloads via ping). If the agent changed the file, the watcher reloads every browser and `Z` takes the edit back like any other.
- **Notes editor** (`E`): E opens a notes editor — ⟨CLICK⟩-separated plain text — whose Save rewrites the slide's `<aside class="notes">` in the file (one `<p>` per segment, HTML-escaped; the aside is inserted if the slide had none). The server watches the deck file and broadcasts a reload to every connected browser on ANY change — the player's edits and external editors alike — and the `#/slide/step` hash restores the position. `file://`-opened decks probe the server at its default localhost port (CORS-open endpoints, like the tts bridge) so the printed URL and a double-clicked file both work; `config.edit.url` overrides, and a basename guard refuses a server that's editing a different deck.
- **Messages** (`` ` `` — the key left of `1`, matched on `code` so it is the same physical key on every layout; or the palette's "Messages"): the deck talks back in the **top-left corner** — 20px, high-contrast, stacked newest-last (at most 4 at a time), each fading after a few seconds. Every message is also KEPT: that key opens the log — the full history with arrival times — because a message that explains why the voice stopped is worthless if it faded while you were looking at the slide. The shortcut is handled BEFORE the typing guard, so `` ⌃` ``/`` ⌥` `` reach you even while the notes editor (`E`) has focus and owns every bare keystroke; the bare key works whenever you are not typing. `instance.messages()` returns `[{ at, text }]`, `instance.toggleMessages()` opens the log.
- **Debug log** (`D`): a passive monospace panel over the deck (keys keep driving the presentation) showing a timestamped event stream — ready/slide/build with direction, theme and font applies, narration on/off and config changes, every TTS call with its duration and estimated cost (`slide 3 seg 1 · Alnilam · 214 chars → 2.4s · ~$0.0041`, previews included) and failures, and window `error` events — plus a live state line (slide/step/theme/narration incl. the active voice · tone or track, the voice rate, and the running TTS spend). Cost is an ESTIMATE: the Gemini API returns token counts (`usageMetadata`), never dollars; the bridge prices them at published Vertex list rates, sends `x-tts-cost` on each fresh synthesis (0 on cache replays), and prints a per-call line plus session total on its console. Events ring-buffer (last 200) from init, so the panel shows history from before it was opened.
- **Font cycling**: `[`/`]` walk a curated list of offline-safe system stacks (sans, rounded, humanist, geometric, two serifs, slab, mono; entry 0 = the theme's own type) applied to `--font-body` + `--font-heading` as inline root properties — they win over any theme and survive theme switches. The choice persists per deck path in localStorage and is restored before the first layout pass; every change re-measures pinned titles and re-runs the overflow guardrail (type metrics differ). `instance.cycleFont(±1)` programmatically.
- **Slide layout cycling** (author mode only): `L`/`⇧L` walk the CURRENT slide through the layout ring — `auto` (deck default: the `pinTitles` config, **on by default**, + the pinnable heuristic — so out of the box a pinnable slide pins) → `centered` (title in flow, content vertically centered) → `pinned` (title pinned at the pin Y) → `top` (everything flows from the top of the slide) → `split` → `split-flip`. Ring entries that cannot change the slide's look are SKIPPED so every press shows something new: `pinned` when `auto` already pins, `split-flip` when there aren't two content blocks to swap sides. **Split layouts**: the first two content blocks — everything after the title + subtitle header (which spans the full width, pinned or in flow) — become ~half-width sides in a wrapping flex row, first block left and second right; `split-flip` mirrors (bullets left · diagram right ⇄ diagram left · bullets right). The two sides **share a top edge** (`align-items: stretch`): columns of unequal height used to centre independently, so the shorter one's heading floated down the slide and the pair stopped reading as a pair — authors were hand-rolling `display:flex; flex-direction:column; height:100%` on each column to get this back. Images opt out of the stretch (`align-self: center`) so a picture is never letterboxed inside a box taller than itself. A **third block is a footer, not a third column**: it spans both sides, centred, below them (`.split-footer`, applied by the engine to every block past the second). The shape that asks for this is the comparison slide — two columns and a note that applies to both — and treating it as "everything else right" hung that note under one side of a comparison it was about equally. Three side-by-side columns are deliberately **not** a shape: grouping three items onto one slide multiplies content-per-slide, which is what the density guidance exists to discourage; use two and a footer, or another slide. A slide whose ONLY content block is a list can't take sides — the engine marks it `.split-columns` and the list itself splits across two CSS columns (`break-inside: avoid` per item). The pick lands on the section as a `data-layout` attribute — the same attribute an author can write in the file, and headless probes can assert on — and it wins over `data-pin` (`pinned` forces the pin, a numeric `data-pin` still sets the Y; `centered`/`top` lay out in flow; the split pair keeps the deck's auto pin resolution for its header). `auto` removes the attribute. A layout pick is a PERSISTED deck edit, so cycling requires author mode: the pick applies to the DOM instantly and is written back into the file through the edit server (debounced ~600ms, so a cycling burst costs one write/reload, and a pick pending when the slide changes is flushed, not dropped) — the file is the ONLY persistence (no localStorage). Without the server, L toasts what it needs and changes nothing — a presenter can't silently fork the deck from what's on disk. Every change re-measures pinned titles and re-runs the overflow guardrail. `instance.cycleLayout(±1)` programmatically (same gate); `instance.layoutRing(n)` exposes a slide's ring — skips included — so headless probes can assert the skip logic without a server; also in the `/` palette ("Cycle slide layout").
- Touch: swipe navigation.
- URL: `#/<slide>[/<step>]`; back/forward supported. `?theme=<name>` loads any theme at startup.
- **Theme switching**: the theme is the stylesheet link into `themes/`; the engine swaps its href in place, so every token cascades and the deck restyles live. `T` opens the **theme picker**: the theme list (config `themes: [...]`, defaulting to the shipped set baked in at build time) beside a live preview of the *current slide at the current step* — a real embedded deck (`?embedded&theme=<name>#/<slide>/<step>`). `↑/↓`/hover browse (debounced), `Enter`/click applies, `Esc` closes. **Packs** (themes/packs.json, baked in at build; the build fails if a shipped theme is missing from the manifest): the picker opens on the pack list (name + count; the active theme's pack is marked), `Enter` drills in, the `← packs` row or `Esc` goes back, `✳ all themes` flattens; saved-custom and generated themes form dynamic packs at the end. An active filter always searches globally and tags each hit with its pack. **Pack-aware cycling**: `,`/`.` walk the pack-grouped order; a step that would cross into another pack pends instead of applying — a toast names the pack and target theme, the same key confirms, the opposite key or `Esc` cancels, and the pending step times out after 4s. **Quick filter**: printable keys type into a filter bar that narrows the list (substring match; the generate row hides while a filter is active); `Backspace` edits, `Esc` clears the filter first and closes on the second press. Because keystrokes feed the filter, the picker has no letter shortcuts (`⌃T` re-rolls the generate-row candidate; the former `R`/`T` bindings are gone). The applied choice persists per deck path in `localStorage`; **embedded instances never persist** (previews can't pollute the saved choice).
- **Inline-theme mode** (bundled single-file decks): when `<style data-theme="name">` blocks exist, they replace the link — `applyTheme` toggles which block applies (via `media="not all"`; the HTML `disabled` attribute on `<style>` is non-functional per spec, and the engine normalizes either form at init). The picker lists the embedded names (config `themes` narrows), `?theme=` works, and everything else is unchanged.
- **Theme generator**: `⌃T` generates a brand-new contract-complete theme (THEMING note) and applies it instantly — press again to re-roll. The roll lives as a `<style data-theme data-generated>` block appended last in `<head>` (wins the cascade over the link/inline base); cycling `<`/`>` or picking another theme deactivates it but keeps it in the theme list under its autoname (`gen-<word>-<hex4>`) until the next roll replaces it. The picker's first row is **“✨ Generate new…”**: selecting it rolls a candidate and previews it live like any other theme (`⌃T` re-rolls while selected; `Enter` applies). Previews for generated and saved-custom themes carry their tokens in the URL — `?gen=<base64url {name, tokens}>` — which the engine applies statelessly at init (works on `file://` and inside bundles). The preview deck loads **once per picker session**; subsequent selections are postMessage'd into the embedded instance (`{__decklightPreview: {theme|gen}}`, parent-origin-guarded) and applied in place — no document reload per candidate, which matters in bundles where each reload would re-parse the whole payload. `⌃⇧T` **saves** the applied generated theme: prompts for a name (sanitized `[a-z0-9-]{1,40}`, `custom-` prefixed on collision with a shipped name), persists `{name → tokens}` into `localStorage['decklight-custom-themes']`, and downloads `<name>.css` (a normal theme file). Saved customs appear in the theme list and picker (tagged “custom”), survive reload, and apply via the same inline-style mechanism — but localStorage is per-origin/per-browser: **the downloaded .css is the portable artifact** (drop it into `themes/` and commit). Unsaved generated autonames are never persisted as the deck's theme choice.
- **Brand logo**: `init({ logo: { onLight, onDark, src?, height?, position? } })` renders a mark as chrome on every slide (default `bottom-left`; also `top-left|top-right|bottom-right`; default height 30px). `onLight`/`onDark` are the variants for light/dark canvases: the engine reads the applied theme's real background luminance (first gradient stop for gradient canvases), sets `data-canvas="dark|light"` on the root, and the matching variant shows — following theme cycling, the picker, and generated themes ( `src` alone shows always). Refs resolve as `'#id'` (clones an inline element — bundle- and `file://`-safe, the `data-cast-inline` idiom), `'<svg…'` raw markup, or an `<img>` URL. In `?print`, every slide gets its own copy. **Hero variant**: `data-logo` on a section prepends a larger in-flow copy of the mark above the slide's content (default 96 design px; `data-logo="128"` overrides) — module openers and cover slides. Hero slides hide the corner chrome (and skip the print copy), the mark doesn't count as pinnable content, and the same on-light/on-dark variant switching applies.
- **Narration**: `V` toggles voice-over; `N` opens the picker (persisted per deck). Two sources. **Recorded**: pre-rendered per-slide audio (`<dir>/slide-NN.m4a`, 1-based like `state.slide`), synced to slide changes; the deck configures `narration: { files: '<dir>' }` or `[{ label, dir }, …]` for several takes. A `dir` may be an absolute URL, so a **public** bucket has always served a track with no extra machinery (`dir: 'https://storage.googleapis.com/…/algenib'` — media elements load cross-origin without asking). **Manifest tracks** exist for the case a `dir` cannot express: `[{ label, manifest: 'voices/algenib/manifest.signed.json' }, …]` fetches a small JSON list once when narration starts and plays each slide's URL **verbatim**, because a presigned URL carries its signature in the query string and a query string can never be a directory prefix. The manifest is the file `tools/voiceover.mjs` already writes (`{engine, voice, style, slides: [{file, hash}]}`), extended with an optional per-slide `url` and a top-level `expires` (ISO 8601); a slide with no `url` resolves its `file` next to the manifest, so an unsigned `manifest.json` in a public bucket is a track for free, and a `null` slide (no notes, no file) is silence rather than a failure. `tools/publish-voices.mjs <dir> --bucket gs://… [--sign 7d]` uploads the slides whose hash moved (the last `manifest.signed.json` is the record of what is already up there; `--all` overrides), signs every slide through `gcloud storage sign-url` — never our own key handling — and writes `manifest.signed.json` to deploy beside the deck while the megabytes stay in the bucket. It refuses a `--sign` longer than **7 days**, the V4 signing scheme's own ceiling, and names the public-bucket alternative for audio that must outlive a week. Signatures expiring is one more way for the voice to be unplayable, so it behaves like all the others: the expiry is checked before the first clip, narration turns off, auto-advance stops, and the message names the track, the date, and the literal re-sign command (the manifest records the `source`, `bucket` and `signDuration` it was made with, so it is a line to re-run and not a shape to fill in). A signed file that fails to load is treated the same way — a media element cannot report an HTTP status, so a 403 for a lapsed signature is indistinguishable from any other failure, and naming the only cause worth naming beats staying silent. `N` shows a manifest track with a ☁ and the time left. `decklight bundle` **inlines the manifest** under its own path (`data-decklight-voices`), like the viseme sidecars, because `fetch` is dead on `file://`; the audio stays in the bucket, which is the whole point. One honest caveat: the character overlay's `amplitude` fallback reads the audio through WebAudio, and cross-origin media taints that unless the bucket sends CORS headers — viseme sidecars are same-origin JSON and are unaffected. **Live voice**: the player synthesizes each slide's notes on the fly through the local bridge (`decklight tts`, default `http://127.0.0.1:8787/tts`, override via `narration.liveUrl`). The bridge speaks with one of four engines (`--engine`, tools/tts-engines.mjs): **gemini** (gemini-2.5-{pro,flash}-tts on Vertex AI — the only engine that honors a delivery style; no free tier, and a fresh project's per-minute quota 429s under the lookahead's bursts), **chirp** (Chirp 3: HD on the Cloud Text-to-Speech API — the same 30 star-named voices, ~1s a sentence, 1M characters a month free, no style channel), **piper** (a local neural model — offline, unlimited, free, no credentials; one voice per installed model, and the process is held RESIDENT because piper reloads its ~120 MB model on every start), or **elevenlabs** (your own ElevenLabs account's voices — the ones you *cloned* included, which is the reason it exists). The first three know their roster up front; ElevenLabs cannot, because the interesting voices are yours, so it fetches the account's list once and `/ping` and `/voices` await it — **your** voices first (cloned, then professional, then premade), each tagged with where it came from, and the picker's default is the first of them. The player sends a voice NAME; a `voice_id` pasted from the dashboard resolves too. Its key is read from `$ELEVENLABS_API_KEY` and is **never written to `tts.json`** — decklight remembers the choice and leaves the secret to your environment. It has no delivery-instruction channel (`stylable: false`), and it is metered in characters against a plan rate decklight cannot see, so the bridge reports characters rather than inventing a dollar figure. Audio is `pcm_24000` wrapped as WAV like every other engine; `--tts-format mp3` is the escape hatch for plans without PCM output and costs you `⇧V` offline recording and the lip-sync bridge, both of which read WAV — so it is opt-in, never a silent downgrade. `GET /ping` reports `{engine, model, voices, stylable}` and the picker offers exactly those voices, skipping the tone step when the engine cannot be told how to speak — a roster the bridge cannot pronounce would be a silent lie. The bridge is probed when live narration **starts**, not only when the picker opens, and a saved voice the live bridge does not have is treated as **stale rather than chosen**: it came from a different engine (the star roster is the default, and an ElevenLabs key knows none of those names), so the bridge's first voice takes over, is persisted, and the swap is announced — a voice changing on its own must never be silent. **The voice already on the machine**: with no engine chosen, none saved, and no cloud project, `decklight author` asks the operating system what it can speak with before defaulting to an engine that would only be skipped. **macOS** is read through `say -v '?'` — the roster mixes twenty years of engines, so voices are ranked by the tier macOS itself labels (a **Personal Voice** the user recorded first, then Premium/Neural, then Enhanced, then built-in) and filtered to the deck's language, because a Mac whose best voice speaks Italian must not narrate an English deck with it. **Windows** is read through PowerShell (`System.Speech`), preferring the newer `(Natural)` voices. Both become real bridge engines (`--tts-engine say|sapi`), synthesizing 24 kHz PCM in a WAV like every other engine, `stylable: false` so the picker skips the tone step. **Android** is detected and refused with the reason: Termux reports `android` and runs Node, but Android's TextToSpeech is an in-process Java API with no command line behind it, so there is nothing for a bridge to call — the honest path there is a recorded track, which needs no bridge. A native voice is the ONLY engine claimed automatically, because it is the only one that needs no setup at all; **piper is never auto-selected even when it is on PATH**, since it needs a toolchain and a ~120 MB model and that choice belongs to the first-run wizard, which saves it. Any `--tts-engine`, `--project`, `GOOGLE_CLOUD_PROJECT` or saved config wins outright and detection is never consulted. When a machine has nothing, the skip line says what THIS machine lacks and names piper; and if **Ollama** is answering on 127.0.0.1:11434 (a ~300 ms probe, raced against a timeout so a hung socket cannot stall startup) it adds that Ollama serves LLMs and has no speech endpoint — the single most common thing a local-AI user expects to cover this. **A missing piper voice is caught before the bridge starts, not by it**: piper installed and chosen but with no model on disk used to bring the bridge up looking healthy and fail on the first sentence — a keypress into silence, for a file that was never there. `decklight author` now checks, names the model, its directory and its size, and on a **TTY** offers to fetch it; accepting re-plans so the bridge joins the session, declining or a non-TTY run keeps the skip line. **Nothing is ever downloaded silently.** The command it runs is chosen for the machine (`tools/tts-engines.mjs`): a python that can already import piper gets `python -m piper.download_voices`, and otherwise `uvx --from piper-tts` runs it inside the isolated venv `uv tool install piper-tts` creates — the plain form cannot work there, which is why it used to fail with `ModuleNotFoundError` on a machine that had just followed decklight's own install instruction. **First-run setup**: the first time the bridge cannot start — a bare `decklight tts`, or `decklight author` about to skip the voice because nothing is configured — decklight asks a few plain questions on the terminal (TTY only) instead of exiting with the engine's error: the engine, with the free/offline/cloud trade-offs stated and the default following what the machine already has (an `$ELEVENLABS_API_KEY` outranks everything — nobody exports one by accident; else piper on `PATH`, else a project visible in the environment or gcloud config), then only that engine's prerequisites — a GCP project id (prefilled, validated with the same rule the flags enforce) plus a credentials probe for the cloud engines; for piper the install and voice-model download commands, run only on an explicit yes; for elevenlabs nothing at all when the key is exported (the roster answers "which voice", so it is not asked) and otherwise where to make a key and why setup will not save it for you. Setup proves the choice with one real synthesis of the picker's preview sentence, reporting duration and the engine's cost note, and only a config that has spoken is saved — to `~/.config/decklight/tts.json` (`$XDG_CONFIG_HOME` honored), which both `decklight tts` and `decklight author` read from then on; precedence is flags > environment > saved config > built-in default. `decklight tts --setup` re-runs the questions, deleting the file resets to first-run, and non-TTY invocations never prompt — exit codes and messages stay as they were. **The voice is the clock**: auto-advance is driven by narration finishing, so when the voice CANNOT be played — a quota 429, an unreachable bridge, a browser that blocked autoplay, a recorded track with no file for this slide — the deck **stops advancing** rather than walking the talk past slides nobody has heard, and says why in a message (`I`) naming the cause and the way out (`--tts-engine chirp` for a 429, `decklight tts` for a dead bridge, one click for blocked audio). Narration switches itself off; `V` retries — the picker drills tracks → Gemini voice (30 prebuilt, flavor-tagged) → tone (six presets or a custom typed instruction, sent as an in-prompt delivery-style prefix). Every voice row carries a ▶ **preview** that speaks an editable test sentence (default "Hey, this is Decklight", input at the top of the voices view, ↺ restores the default) through the bridge in that voice; tone rows preview the drafted voice in that delivery style, and the custom-tone input has a ▶ to audition a typed instruction before committing it. After a preview plays, the rest of its roster prefetches sequentially in the background (all voices neutrally, or all tones for the drafted voice). Two preview caches: the default sentence's cache is permanent once built; the custom sentence's cache holds exactly one sentence and is swapped (old audio freed) when the text changes. **Build-synced auto-advance**: the ⟨CLICK⟩ markers that segment the notes for the speaker view segment the audio too — segment k is synthesized as its own clip and narrates build step k (0 = arrival); when a clip ends the deck reveals the next build, and after the last segment it moves to the next slide, so a deck with well-segmented notes presents itself beat by beat. A segment with no words advances after a short beat; a slide with no notes is skipped; manual navigation mid-clip wins over the pending advance and re-syncs the voice to the new step. **`data-narration="hold"`** on a section marks it interactive (quiz, exercise, live demo): narration plays whatever notes it has and builds still sync, but the deck never auto-advances *off* it — the presenter moves on manually and narration resumes on the next slide. The spoken unit is a **sentence**: each ⟨CLICK⟩ segment splits into sentences, every sentence is its own TTS call and cache entry (slide, segment, sentence, voice, style), playback chains them and advances only after the segment's last one — so first audio arrives after one short synthesis, never a whole paragraph. While narration is on, a **lookahead buffer** keeps the next 10 sentences synthesized in the background (a few parallel low-priority workers, window re-derived from the current position, results landing in the same cache); an unreachable bridge toasts once and pauses the buffer until the next event. `⇧V` downloads per-slide `slide-NN.wav` files **stitched from this same sentence cache** (short silences joining sentences and builds) — already-heard clips cost nothing, only unheard sentences synthesize. **`P` pauses/resumes** narration — audio freezes mid-sentence and resumes exactly there, and auto-advance holds while paused. Captions (`C`) follow the voice **sentence by sentence** during live narration (segment-level when narration is off). With nothing configured, `V` opens the picker instead of failing. **The deck announces its own voice**: when a recorded track is configured, a small pill fades in bottom-center about a second after load — *🔊 this deck has a voice-over — `V` plays it* — and clicking it starts narration (the click is itself the user gesture, so the audio is never the blocked-autoplay case). It fades out on its own after ~12s and is written to the message log (`I`) rather than toasted, since the pill is already on screen saying it. It never appears in `?print`, in embedded previews (the theme picker and slide finder boot real decks in iframes), under `?voiceover` (which starts on the first gesture anyway), while captions (`C`) hold that same corner, or once narration has been started on this deck — remembered per deck path like every other narration preference. Without it the only proactive surface was the touch sound button, which CSS shows on `pointer: coarse` alone, so a viewer on a laptop could only learn the deck talks from a key nobody had mentioned. Files are generated by `tools/voiceover.mjs`: notes → optional local-LLM rewrite → `--engine piper` (local neural TTS; `--voice` = piper model name) or `--engine gemini` (gemini-2.5-pro-tts on Vertex AI; `--voice` = prebuilt voice name). The built-in speech-synthesis voices were removed — not good enough. `?voiceover` starts narration on the first user gesture. `instance.toggleNarration()` programmatically.
- **Character** (`N` → Character…, or palette → Character…): an animated narrator in a stage corner whose lips sync to the narration — fully offline, no cloud service. Two render modes behind one overlay (`.decklight-character`, persisted per deck): **🎭 2D character** — a layered SVG bust (theme-aware clothing/backdrop, blink, idle sway) with one mouth group per Rhubarb shape (`A–H` + `X` rest); a 30 Hz loop maps `narrAudio.currentTime` onto a **viseme timeline** and shows the matching `[data-mouth]` group, so pause (`P`) and voice speed (`<`/`>`) sync for free. **🎥 Neural video** — a muted picture-in-picture `<video>` talking head (audio always comes from the narration element; muted video is immune to autoplay policy) generated by Wav2Lip or SadTalker on the presenter's own GPU, drift-corrected against the audio clock (±150 ms) and mirroring its play/pause/rate. Timelines and clips come from the **lipsync bridge** (`decklight lipsync`, default `http://127.0.0.1:8789`, override via `narration.character.bridgeUrl`; CORS-open, 127.0.0.1-only, disk-cached in `~/.cache/decklight/lipsync` keyed by audio+params hash): `GET /ping` reports which engines actually resolve (the picker greys out the rest), `POST /viseme?text=` (raw WAV body → timeline JSON v1: `{v, duration, cues: [{t, v}]}` — start-time cues, each shape holds until the next), `POST /video?engine=&portrait=` (raw WAV → muted faststart MP4; strictly serial GPU queue). In **live voice** mode the sentence is the unit here too: the lookahead buffer that keeps 10 sentences of audio warm hands each synthesized sentence's WAV to the bridge, so lip-sync data prefetches through the same window, workers, and promise-cache dedup as the voice — and playback NEVER waits on lip-sync (a late timeline lands mid-sentence; until then the **fallback** animates: `amplitude` (default) drives a coarse 4-shape mouth from a WebAudio analyser, `hide` shows the idle face). In **recorded** mode the overlay loads per-slide sidecars from the track's dir — `slide-NN.visemes.json` / `slide-NN.mp4`, generated by `tools/lipsync.mjs` (rhubarb + optional SadTalker/Wav2Lip batch, hash-incremental like voiceover.mjs) — preferring an inline `<script type="application/json" data-decklight-visemes="slide-NN">` block when present (`decklight bundle` inlines viseme JSONs; fetch is blocked on `file://`). `⇧V` exports `slide-NN.visemes.json` alongside each stitched WAV (same sentence cache, same silence gaps) so a recorded set is character-ready with zero extra synthesis. **Solo** (`N` → Character… → Solo, or palette → "Character solo"): the narrator takes the stage — the slide content, progress bar and slide number step aside (`visibility: hidden` on `.decklight-stage`, which the overlay is a sibling of) and the character centers, sized to the stage (`--character-solo-size`, default `min(74vh, 74vw)`). A talking-head slide with nothing else on it, without authoring one. Works with either render mode, persists per deck alongside `mode`, and is a *presentation* state, not a layout: the root's `decklight-solo` class is only ever set while the character is actually on screen, so turning the character off — or stopping the narration — can never leave a blank stage behind. Turning solo ON shows the character immediately (idling, blinking) rather than waiting for `V`. **Motion** (`decklight lipsync --veo`, SPEC PRESENTING): Wav2Lip repaints the lip region and leaves the rest of its source untouched — from a still photo that is a frozen stare with a moving mouth. With `--veo` the bridge animates each portrait ONCE through Veo image-to-video on Vertex AI (`veo-3.1-lite-generate-001` by default; 4/6/8s; `generateAudio: false` — the deck owns the voice, and it is the cheaper rate) and gives Wav2Lip that clip as its `--face`, so the head turns and blinks under the new mouth. The unit is the PORTRAIT, not the sentence: the player asks for video once per sentence through a 10-sentence lookahead, so a Veo call per sentence would be both unusably slow (~40s) and a runaway bill — instead each portrait's motion clip is bought on first use, deduped in flight, and cached on disk (keyed by portrait+model+seconds+prompt), so a deck of any length costs exactly one call per portrait, ever. Delete the cache entry to re-roll the performance. The clip is cropped square around the head (the overlay is a circle) and scaled to 640px (s3fd misses faces in a large frame). SadTalker is excluded — it generates its own head motion and wants a still. A refusal by Veo's person-generation filter surfaces as an error naming the cause, never an empty clip; a misconfigured `--veo` disables only itself and leaves visemes and still-portrait video working. It is the only part of the bridge that leaves the machine, so it is opt-in, and `decklight author` passes it straight through. Config (`narration.character`, all optional): `mode: 'off'|'viseme'|'video'` (picker overrides, persisted), `solo: boolean` (default false; picker overrides, persisted), `bridgeUrl`, `position: 'br'|'bl'|'tr'|'tl'`, `size` (design px, default 220), `svg` (custom art: inline markup, `'#id'` ref, or URL — contract: `[data-mouth="A"…"X"]` groups; optional `[data-eyelid]`/`[data-idle]` get the blink/sway), `sprites: {A: url, …}` (image frames instead), `engine`/`portrait` (video mode; Wav2Lip suits live — static pose, seamless per-sentence cuts; SadTalker suits batch clips), `fallback: 'amplitude'|'hide'`. Bundles: viseme JSONs inline (1–4 KB/slide); per-slide MP4s stay external with a CLI notice — video cannot inline sanely.
- **Command palette**: `/` opens a Claude-style palette — every command with its shortcut, type-to-filter, `Enter` runs, `Esc` clears then closes. Argument commands (Theme…, Font…, Narration voice…, Module…, Find slide…) drill into their pickers; contextual commands appear only when applicable (Save generated theme, Module). Inline arguments work: `goto 27` — or just typing `27` — surfaces a “Go to slide 27 / N” row (clamped to the deck), and selecting the bare “Go to slide…” command keeps the palette open with `goto ` prefilled. Text matching no command falls back to a “Search slides for …” row that opens the finder with the query prefilled.
- **Slide finder**: reached from the palette (`/` → Enter, or the search fallback) — a find-a-slide overlay with the picker's anatomy — a query bar and result list on the left, a live preview of the selected slide on the right. Typing filters as an AND over the query's words against each slide's text; slides whose **title** contains every word rank first, body-only matches follow, and every match is listed as `<slide number> · <title>` (slides without a heading fall back to their leading text). `↑/↓`/hover browse (the preview swaps live), `Enter`/click jumps to the slide, `Backspace` edits, `Esc` clears the query then closes. The preview reuses the picker's lazy embedded-deck mechanism — the iframe boots once (carrying the active theme, generated/custom included via `?gen=`), then selections postMessage `{__decklightPreview: {goto: [slide, step]}}` into it; no reload per candidate.
- **Playlist (multi-deck navigation)**: `Decklight.init({ playlist: { modules: [{title, href}…], index: n } })`. Advancing past the last build of the last slide navigates to the next module (`href#/1/0`); reversing before slide 1 goes to the previous module's end (`href#/999/999` — oversized hashes clamp to the last slide/step). The other modules appear as rows in the **slide finder** (`G`) — marked `▸ <title> — module`, previewed like any slide, and `Enter` loads that file; the slide-number chrome shows the module title and opens the finder on click. There is no separate module menu: "go somewhere" is one question with one answer. Works on `file://` with relative hrefs; embedded instances never chain.
- **Restore a version** (`R`, author mode): an overlay listing the deck's git history — short hash, subject, age, newest first — with the selected commit's deck **rendered live** in the preview pane, because a hash and a subject are not enough to recognise the version you meant. `↑`/`↓` browse (wrap-around, debounced so holding a key does not fire a page load per row), `⏎` restores, `Esc` cancels, a backdrop click closes; only one overlay is up at a time, like every other. Restoring goes through the same non-destructive path as `decklight restore` — a **new commit on top**, never a rewrite — and lands on the undo stack, so `Z` takes a restore back like any other edit. This is the git-level sibling of `Z`/`⇧Z`: `Z` takes back a keystroke, `R` takes back a session. Without an edit server the keystroke says so and does nothing; embedded preview instances and `?print` never render it. `instance.restore = { open, close, list }` programmatically.
- **Speaker view**: `S` opens a popup (synced via BroadcastChannel): current + next slide thumbnails, notes (with `⟨CLICK⟩` markers highlighted as the matching build lands), elapsed timer, build step list (provider labels). **Rehearse mode**: pressing `S` again (in the deck or in the popup; the header badge also toggles) swaps the prose notes for the slide's `aside.rehearse` cue cards (DECK_ANATOMY) — rendered large and bold, one cue per segment, same said/now/next highlighting. Slides without rehearse notes fall back to the full prose. `S` in the deck only opens a new popup when none is connected; while one is open it toggles the mode. **Phone remote**: when the edit server was started with `--remote` (PRESENTING, below), the speaker view also shows a QR of the controller URL — click it to enlarge for scanning across a lectern. It appears only when a remote is actually on, since without it there is no LAN URL to encode.
- **Phone remote** (`decklight author <deck.html> --remote`): the edit server also listens on the LAN and serves `GET /remote` — a self-contained controller page with prev/next and a live "slide x/N" readout. A tap is relayed as a named `remote` event on the SSE stream the deck already holds, and the deck POSTs its position back, so the readout tracks the deck however it moved (phone, keyboard, or click). Without the flag the server binds `127.0.0.1` exactly as before. Off-loopback, **only** `/remote/*` answers and only with the per-run random token printed at startup; every `/edit/*` mutation refuses non-loopback callers unconditionally, flag or no flag. The QR is generated server-side with no dependencies, and decks that never use author mode grow by zero bytes.
- **Print/PDF**: `?print` renders all slides sequentially, every build complete, terminal casts fully expanded, one slide per page (`@media print` CSS). No JS needed after layout. Background media (DECK_ANATOMY) prints as a still: no `<video>` element is ever created in print — the slide's `data-background-poster` renders as the background image instead. Two handout variants restructure the same fully-built render onto portrait pages (one `.print-page` per sheet): `?print=handout` groups slides three to a page, each scaled slide beside a column of ruled note-taking lines (page count = ⌈N/3⌉); `?print=notes` gives one page per slide with that slide's speaker notes rendered underneath — slides without notes keep their page with an empty notes block. **Page count equals slide count** (⌈N/3⌉ for handout): the page box has no margin, so the document has none either — the UA's default body margin would push the last slide's final pixels past the last page box and emit a blank final sheet. **`decklight pdf <deck.html>`** writes that render to a file without a print dialog: headless Chrome over the deck's own `?print`, one slide per 1280×720 page (960×540 pt), `-o` for the path, `--theme` to export in another theme (it rides `?theme=`), `--wait` for decks that need longer to settle. Slides the overflow guardrail flagged are named on stderr by slide number — the PDF is still written, because a clipped slide is worth knowing about, not worth refusing. No Chrome, or no file produced, exits non-zero rather than leaving a silent empty PDF.
- **Video export**: `decklight video deck.html -o deck.mp4` (tools/video.mjs) renders the deck to one narrated mp4 — a full-resolution still per slide (final build state: each frame is a one-shot headless Chrome against `#/<n>/999`, the shot.mjs mechanism), held for the duration of that slide's narration audio plus a 0.4s tail, muxed with the audio into a single file. Narration resolves `--narration <dir>` → `<deckdir>/voiceover/manifest.json` (the artifact tools/voiceover.mjs writes) → a fully silent deck; slides without narration hold `--hold` seconds (default 5, per-slide override `data-video-hold="8"` on the section) over a silent audio segment (anullsrc), so the concatenated audio track stays continuous. Flags: `-o/--out`, `--narration`, `--size 1280x720`, `--fps 30`, `--hold`, `--theme <name>`, `--slides a-b`, `--voiceover` (runs the voiceover batch first). Needs ffmpeg + ffprobe — missing tools are a hard, friendly error naming what to install (the voiceover encoder-detection policy). Honest MVP limits: frames are stills, so the **character overlay appears but frozen** and terminals render fully expanded rather than typing (animated capture needs a CDP screencast — a named Node ≥22 follow-up), and **timing is per-slide, not per-build-step** (the whole slide shows fully built while its segments narrate).
- **Overflow guardrail**: content that exceeds the slide flex-shrinks into a scroll box and reads as clipped. The engine warns (`console.warn`) and marks the section with a `data-overflow` attribute — on each slide activation, and for the whole deck in `?print`. The mark is **live, not latched**: layout is not final when a slide activates (a webfont resolves, an image decodes, a chart or terminal mounts), so the active slide is watched and the check re-runs whenever its content changes size or shape. It never waits on a frame — headless renders run out of frames once the page goes idle, and an unmeasured slide is indistinguishable from a clean one. The warning fires on the way in only, so one clipped slide is one line, not one per re-check — so authoring agents can assert `[data-overflow]` is absent in their headless verification (`decklight pdf` does this for a whole deck in one pass and names the offending slides). Overflow always goes **down**, never up: a slide centers its content with `safe center`, so content taller than the slide falls back to top alignment instead of overflowing symmetrically. Plain centering would push half the excess out of the top of the box, through the padding a pinned title reserves for itself, and render the first content element on top of the title.
- **Pinned titles**: `pinTitles: true | false | <px>` keeps slide titles at one vertical position instead of drifting with content height. **On by default** (`true`); `pinTitles: false` restores the drift-with-content centering deck-wide. `true` pins at **99px** from the stage top (design coordinates — the natural title position of the course's "The Single-Agent Limit" diagram slide, the chosen reference); a number pins at that Y. The leading `h1`/`h2` of each **pinnable** section is absolutely positioned at the pin Y; the section reserves `pin Y + measured title height + 18px` of top padding so the remaining content centers below. Pinnable = has a leading `h1`/`h2` AND content beyond it (`ul, ol, svg, pre, table, .terminal, img, .columns` outside the notes) — title cards and quote/statement slides stay centered. Per-slide: `data-pin` forces a pin (even when the config is off), `data-pin="none"` opts out, `data-pin="<px>"` overrides the Y. Titles are re-measured on `sync()` and when webfonts finish loading; print uses the same layout. A detected **subtitle** (DECK_ANATOMY) joins the pinned header block — absolutely positioned directly beneath the title (6px gap) and included in the reserved padding, so content centers below title + subtitle.
- **Terminal footprint**: a terminal's screen area has a stable size — a **16:9 aspect floor** (width-driven) clamped by the `data-rows` cap as the max — so the box arrives full-size before anything plays and never resizes as steps stream in (output beyond the box scrolls). Real print expands casts fully.
- `Decklight.init(config)` options: `transition`, `hash` (default true), `controls` (default true: prev/next chevrons; the progress bar is the `H` toggle, above), `slideNumber` (default `false | 'n' | 'n/N'`), `width/height` design resolution (default 1280×720, scaled to fit), `themes` (array of theme names for the picker/cycle; default: all shipped themes), `playlist` (multi-deck navigation, above), `pinTitles` (pinned titles, above), `concepts` (diagram concept-color pinning, SVG_DIAGRAMS), `logo` (brand mark, above).
- **Single-file bundling**: `decklight bundle <deck.html> [-o out.html] [--themes current|all|a,b,…]` flattens a deck into one self-contained HTML — runtime and structure CSS inlined, selected themes embedded as inline-theme blocks, `data-cast` terminals converted to `data-cast-inline`, images (`<img src>`, `data-background-image`, `data-background-poster`) to data: URIs. Background videos stay external with a notice — the same posture as character MP4s. Playlist links can't resolve inside a single file; the CLI lists them as a notice.
- **Runtime upgrade**: `decklight upgrade <deck.html> [--dry-run]` brings a self-contained deck's inlined runtime up to the installed package: the runtime css + js blocks are swapped for the installed `dist/` builds and re-marked `data-decklight-runtime="css|js"` (decks from before the marker are recognized too — the first head `<style>` carrying the structural css, and the `<script>` defining `Decklight` before the `Decklight.init` call), and `<style data-theme>` blocks refresh from the installed `themes/`, preserving which one is active; a theme that no longer ships is kept as-is with a warning. Everything the author wrote survives byte-for-byte. In place, `<deck>.html.bak` written first; `--dry-run` prints the plan and touches nothing; a second run reports "already current". Non-decklight files (no `Decklight.init`) and merged multi-module bundles are refused. `init` marks the blocks it writes with the same attribute.
- **Merged single-file presentation**: `decklight bundle <deck.html> --all [--title "…"]` follows the deck's playlist and concatenates EVERY module's sections into one deck (explicit form: `decklight bundle a.html b.html … -o one.html`). Each module's first section is marked `data-module="<title>"`; embedded cast ids are prefixed per module to stay unique; relative asset refs are rebased onto the first deck's directory; the per-module `playlist` config is stripped. **In-file module navigation**: `data-module` sections are ordinary slides, so the finder (`G`) already finds them by title or body text and `goto()`s them with no page load; the chrome module tag shows the module of the current slide (nearest preceding marker).
- **Publish (GitHub Pages)**: `decklight publish <deck.html> [--branch gh-pages] [--remote origin] [--no-bundle] [--path <subdir>]` — bundles the deck (single-file, via the bundler above; `--no-bundle` pushes the file as-is) to `index.html` + `.nojekyll` and pushes them to the branch on the remote, then prints the site URL derived from the remote URL: `git@github.com:owner/repo.git` and `https://github.com/owner/repo(.git)` both → `https://owner.github.io/repo/`, an `owner.github.io` repo → `https://owner.github.io/`, and a non-GitHub remote just prints the pushed ref. The commit is built with git plumbing (`hash-object → mktree → commit-tree → push <sha>:refs/heads/<branch>`), so the author's working tree, index, and checked-out branch are never touched. The first publish creates the branch as an orphan and prints where to enable Pages in the repo Settings; every later publish fetches the remote branch and parents on it — history, not force-push — and the sign-off in the commit message comes from `git config user.name/user.email`. `--path <subdir>` publishes under a subdirectory, preserving whatever else the branch already carries. Zero new dependencies: plain git.

## JS_API — Public JS API

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
instance.cycleLayout(dir)                      // L / ⇧L programmatically (±1; author mode only)
instance.layoutRing(slide?)                    // the layout ring a slide would cycle (skips applied)
instance.toggleNarration()                     // V programmatically
instance.annotate                              // ink: .toggle() / .laser() / .clear() / .stroke(points)
instance.saveGeneratedTheme(name?)             // ⌃⇧T; a name argument skips the prompt
```

## DECK_IMPORT — Importing an existing deck

`decklight import <deck.pptx | deck.key | google-slides-url>` converts a
presentation you already have into a self-contained decklight deck (runtime and
theme inlined, images as `data:` URIs — the `init` output shape). It is a
**content importer, not a pixel renderer**: the original template's look is
deliberately replaced by decklight theming, which is what buys the deck
everything downstream — themes, builds, narration, the notes editor, `dev`.

**Three front doors, one parser.** `.pptx` is the only one of the three that is
a readable format. `.key` is an undocumented binary archive, and a Google Slides
deck is not a local file at all — so both are turned into a `.pptx` first, by
the only software entitled to do it: Keynote exports one via `osascript` on
macOS (elsewhere the command prints the manual export path), and Google serves
one from `/export/pptx` for any deck that is link-shared. `.ppt`, the pre-2007
binary format, is refused with instructions rather than guessed at.

| PowerPoint | decklight |
|---|---|
| slide | `<section>`, in `<p:sldIdLst>` order (not archive order); hidden slides skipped and reported |
| title placeholder | `<h2>`; `<h1>` when it is the title layout's centred title (`ctrTitle`) |
| subtitle placeholder | the following `<p>`, which feeds the DECK_ANATOMY subtitle rule |
| body bullets | `<ul>`/`<ol>`, indent levels as real nesting **inside** the parent `<li>`; bold/italic/links preserved |
| `<p:bldP>` (PowerPoint's own per-paragraph build list) | `data-build="fade-up"` on that list — `--build all\|none` overrides |
| speaker notes | `<aside class="notes">`, one `<p>` per paragraph |
| pictures | `<img>` with the bytes inlined as a `data:` URI |
| tables | `<table>`, first row as `<thead>` |
| SmartArt, charts, embedded media, transitions | **dropped, and named** with the slide number and what to rebuild them as |

Drops never fail the command — only an unreadable file, a non-presentation, or
a deck whose every slide is hidden do. A silent drop is the failure that
matters here: a chart that quietly vanishes from slide 14 is discovered on
stage, so every drop is reported with its slide number and, where decklight has
a native answer, what to rebuild it with (`chart dropped — rebuild as
data-chart`). PPTX **export** remains a v1 non-goal (NON_GOALS); this is import only.

The runtime is not involved: `import` is CLI-only, adds nothing to
`dist/`, and reads the archive with `tools/zip.mjs` + `tools/ooxml.mjs` — about
200 lines over `node:zlib` — rather than taking a dependency.


## MARKETPLACE_REGISTRY — Marketplaces: registered, not fetched

A marketplace is a git repo (or a local directory) with
`.decklight/marketplace.json` at its root — decentralized, no central registry,
mirroring Claude Code's layout deliberately (MARKETPLACE.md MARKETPLACES). The
manifest names the catalog and its entries:

```json
{
  "name": "nord-pack",
  "description": "cool blues",
  "entries": [
    { "name": "nord-deep", "type": "theme", "source": "./themes/nord-deep.css", "description": "deep blues" }
  ]
}
```

`name` and each entry's `name`/`type`/`source` are required (`description`
optional; versions and compat ranges arrive with code-carrying extensions —
versions for code, none for data). A malformed manifest is refused **naming the
line and the field** (`line 7: entries[1].type — missing`), never with a stack
trace — a typo in somebody's catalog is not an internal error.

`decklight marketplace add <owner/repo | git url | path>` reads the manifest at
the source's root and registers the catalog; `list`, `update <name>` and
`remove <name>` complete the roster. State lives under `~/.decklight/`
(`DECKLIGHT_HOME` overrides): one registry file, `marketplaces.json`, plus a
`marketplaces/` directory of cached manifests — the config home the engine
wizard (MARKETPLACE.md ENGINES) shares.

**The invariant everything above serves: registering is not fetching.** The
network is touched only by an explicit `add` or `update` of a remote source —
never at registration, never when a deck loads, never while presenting. The
first-party marketplace is registered on first CLI run as a pure filesystem
write; its first fetch happens at the first browse or `update`, so first run
offline is silent and instant, and a deck on conference wifi, on a plane, or
air-gapped behaves identically to one at a desk. Nothing on the deck-load or
presenting path imports the marketplace module at all (pinned by
`test/marketplace.test.mjs`). Offline is a first-class state, not an error
state: `list` reads only the cache, and a fetch failure is fast and names the
marketplace and the reason — no spinner, no hang.

Entry names are qualified `name@marketplace`. A bare name resolves only while
it exists in exactly one registered marketplace; the same bare name in two is
reported as ambiguous with the qualified forms to use instead — never silently
resolved to either. The registry registers, caches and names; installing what
an entry points at is each install surface's own contract (theme browse
installs through `theme add`, THEME_DISTRIBUTION). Nothing here executes in a
deck: the marketplace distributes data and authoring-side units, and the
no-plugin-system line (NON_GOALS) stands.


## REPO_LAYOUT — Repository layout & tooling

```
decklight/
  SPEC.md  README.md  package.json
  src/core/      engine.js (init, nav, builds, transitions, stage, chrome, input) + the features that own their own
                 state and keyboard: themes.js (switching, packs, generator, picker), narration.js (voice, captions,
                 character, ⇧V recorder), editmode.js (live reload, notes editor, agents, undo/redo, restore),
                 hud.js (clock, progress, ink, transcript), plus auto-animate, notes, print, svg-ns, charts
  src/math/      LaTeX math on data-math slides (Temml → MathML Core)
  src/code/      highlight bundling + line stepping provider
  src/terminal/  ansi.mjs (parser), player.mjs (provider + modes)
  cli/           decklight.mjs (dispatcher: init/rec/refresh/export/bundle/upgrade/pdf/theme/import/publish/tts/lipsync/video/edit/dev) + init.mjs, rec.mjs, bundle.mjs, upgrade.mjs, theme.mjs (validate + install a theme, THEMING), import.mjs (PowerPoint/Keynote/Google Slides → deck, JS_API), publish.mjs, marketplace.mjs (register catalogs, MARKETPLACE_REGISTRY), edit.mjs, dev.mjs, agents.mjs (AI-agent roster)
  tools/         theme-check.mjs (the THEMING token contract + WCAG gates, as a function) + color.mjs (contrast math), local-voice.mjs (what this OS can say: macOS say / Windows SAPI, PRESENTING), zip.mjs (read an Office archive) + ooxml.mjs (a small XML reader) + pptx.mjs (PowerPoint → sections, JS_API), voiceover.mjs (batch TTS) + voiceover-server.mjs (tts bridge), publish-voices.mjs (track → bucket + signed manifest, PRESENTING), tts-engines.mjs (gemini/chirp/piper/elevenlabs/say/sapi) + gemini-tts.mjs, elevenlabs-tts.mjs, lipsync.mjs (batch visemes/video) + lipsync-server.mjs (lipsync bridge), visemes.mjs (timeline v1), video.mjs (deck → narrated mp4, PRESENTING)
  themes/        30 × <name>.css + gallery.html
  dist/          decklight.js (IIFE, global Decklight), decklight.css
  demo/          kitchen-sink.html + casts/
  test/          node:test units (ansi, md, builds math, cast format) + render.mjs (headless Chrome assertions) + contrast.mjs (every shipped theme through tools/theme-check.mjs)
```

- Build: `npm run build` = esbuild bundle (`src/index.js` → `dist/decklight.js`, minified + sourcemap) + CSS copy. Node ≥ 20. Runtime has **zero** runtime dependencies (highlight.js + temml are bundled at build time; Temml's stylesheet is appended to `decklight.css` with its optional woff2 `@font-face` stripped); `node-pty`, `js-yaml` are CLI-only deps.
- Verification culture: `npm test` runs units; `npm run verify` builds, launches headless Chrome against `demo/kitchen-sink.html`, and asserts: slide count, build counts per slide, provider steps, ANSI render output, theme token presence, no console errors.

## NON_GOALS — Non-goals (v1)

Vertical slide nesting · full terminal emulation (vim/htop) · multiplex/follow-along · plugin system (providers + events cover extension) · PPTX export · mobile authoring.

The phone remote (PRESENTING) is not an exception to multiplex/follow-along: it is a **controller**, not a second screen. The phone renders no slides — two buttons and a position readout — and nothing in it broadcasts a deck to an audience's own devices.
