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
| `MARKETPLACE_REGISTRY` · `VOICE_UNITS` · `AGENT_UNITS` · `ENGINE_UNITS` · `ENGINE_PREREQUISITES` · `UNIT_COMPAT` · `UNIT_PINNING` · `EXTENSIONS_TRANSFORMS` · `EXTENSIONS_CHECK` · `EXTENSIONS_ADAPTERS` | catalogs of themes, templates, skills and engines — registered, not fetched; the unit library; voices as references; agents as descriptors, and the remembered preference; the speech-engine factory contract and installing one; what an engine needs from the machine before a key is worth asking for; compat for code-carrying units; the digest pin they install against; the transform calling convention; the marketplace admission gate for it; the import adapter calling convention, and running one |
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
- **Markdown slides were removed in 0.3.0.** `data-markdown` + a `<script type="text/template">` body was a second authoring surface for the same DOM, and it earned its bundle: `marked`, a `::: build` directive, a parallel notes syntax, a `` ```chart `` fence that existed only because a nested `</script>` cannot live in a template, and a math path that had to extract every span *before* the parse so TeX underscores would not become emphasis. HTML is the one surface now. A deck still carrying `data-markdown` sections would render them EMPTY — the template is a `<script>` no browser paints — so the engine recognises the attribute for exactly long enough to refuse out loud: it marks the section `data-markdown-removed` (assertable headlessly) and warns per slide, naming the slide number. It parses nothing.
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

The engine flags the mixed state itself, not just its symptom: a `split`
section with a content block that computes to a **row** flexbox is marked
`data-split-conflict` — assertable headlessly exactly like `data-overflow`
(PRESENTING) — with one console warning naming the slide, and `decklight pdf`'s
audit names such slides beside the overflowing ones. Cycling a layout onto such
a slide with `L`/`⇧L` says so in the toast. Column-direction flex inside a
block is fine: it stacks, it does not take sides.

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
  `var(--d-accent)` re-color automatically across all 46 shipped themes.
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

**Browsing a marketplace for one** (`THEME_BROWSE#UI`, author mode only — the picker's Browse row, `PRESENTING`). Registered marketplaces are listed from the **cache only** — `marketplace update` is the one thing that fetches a catalog, so a deck on conference wifi, a plane, or air-gapped lists exactly what it has and **names the marketplaces it could not read** rather than showing an empty list that looks like an empty marketplace. (The first-party marketplace is registered-not-fetched by design and therefore always in that state on a fresh install, which is why silence there would be the common case looking broken.) Installing goes through `theme add`'s own functions — the token contract, the WCAG gates, the block shape — so **a theme the command line would refuse is refused here, by the same code**, and a failed install leaves the deck byte-for-byte unchanged. It lands as the same `<style data-theme data-theme-added>` block, so the picker treats it identically to a CLI-added one, and re-adding a name replaces the block in place. A manifest's `source` is relative to its **marketplace**, not to whoever is installing: by the time a catalog is a cached file the repo it came from is not the cwd, so a relative entry resolves against the marketplace's recorded source (a local path joins; `owner/repo` becomes a raw URL at `HEAD`, unpinned from a branch name nobody chose). That resolution lives in `cli/theme.mjs` rather than the author server, because fetching an **artifact** on an explicit install and fetching a **catalog** are different permissions on a deck-serving path, and keeping them in separate files is what lets the invariant sweep tell them apart.

**Sharing a deck, as opposed to a theme**: prefer the link. A published deck is served from an origin, over https, by a host the recipient already trusts — the channel is the attestation, and nothing about a URL asks them to decide whether a file is safe to open. When a file has to travel instead (email, an air-gapped room, a conference laptop), send a `.decklight`: it carries the signature with it, and `decklight present` on the other end checks it. A bare `.html` attachment is the weakest of the three and should be the last resort — it attests to nothing and runs with no policy at all.

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

`cli/rec.mjs`, invoked as `npx decklight@latest rec <script.term.yaml> [-o out.cast.json]`
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

- Keyboard: `→/←/Space` steps+slides, `Home/End`, `O` overview grid, `B` blackout, `F` fullscreen, `T` theme picker (`,`/`.` cycle the theme, `[`/`]` cycle the font), `L`/`⇧L` cycle the current slide's layout (author mode — a persisted deck edit), `E` toggle element edit mode — right-click a slide element or its background for a menu (author mode), `Z`/`⇧Z` undo/redo deck edits (author mode), `A` ask an AI agent to edit the deck (author mode), `/` command palette, `V` narration (`N` picks track / live voice / tone; `P` pauses/resumes; `<`/`>` change the voice speed in 0.25× steps, 0.25–2×, persisted per deck — YouTube's shortcut), `C` captions, `W` pen / `⇧W` laser pointer (draw on the slide, `⌫` clears), `K` presenter clock, `H` progress bar, `D` debug log, `` ` `` messages, `G` slide/module finder (deliberately not `⌘F` — browser find stays untouched), `R` restore a version from git history (author mode), `?` help overlay.
- **Captions** (`C`): a YouTube-style bar at the bottom showing the current notes segment — the same ⟨CLICK⟩-segmented text the live voice speaks — synced to slide/step, with narration on or off. Slides/steps without notes show no bar. Persists per deck in localStorage.
- **Presenter clock** (`K`): the wall-clock time (HH:MM) and the elapsed talk time, directly below the slide number — positioned so it never covers the slide number, the message window, or the default logo/controls corners. The elapsed count starts at the deck's **first advance after load**, not at page load — a deck idling on its title slide while the room fills is not a talk yet. Off by default, persists per deck in localStorage, never rendered in `?print`. `instance.toggleClock()` programmatically.
- **Progress bar** (`H`): a hairline along the bottom edge of the deck whose width tracks the position through the deck (slide plus build step, slide 1 empty → last slide full), updated on every navigation — keys, `G`, `Home`/`End`, deep links. A passive readout of the deck state: it never drives navigation or auto-advance. Sits at the very bottom edge, below the captions bar, the character overlay and the corner chrome, so it covers none of them. Off by default, persists per deck in localStorage, never rendered in `?print`. `instance.toggleProgress()` programmatically.
- **Ink annotations** (`W` / `⇧W`): Keynote-style presenter ink on a canvas overlay above the slides. `W` toggles the **pen** — the cursor becomes a crosshair and pointer drags (mouse, touch, stylus) draw strokes in the theme's `--accent`; `⇧W` toggles the **laser pointer** — a glowing accent dot with a ~300 ms fading trail follows the pointer. `Backspace` clears the canvas while a tool is active. Annotations are EPHEMERAL: cleared on every slide change, never persisted, never rendered in `?print` (the annotator is not instantiated there — the clock pattern, exclusion by construction). Strokes are stored in **design coordinates** and redrawn at the engine's scale, so a window resize or rescale never drifts them off their slide positions; the ink color is read live from the applied theme, so switching themes recolors the next stroke. With no tool active the canvas is `pointer-events: none` — slide clicks and touch swipes work exactly as before. `instance.annotate = { toggle, laser, clear, stroke }` programmatically (`stroke(points)` draws one from design-coordinate points — the headless-harness and demo-driver hook).
- **Transcript** (palette → Transcript…): the deck's full spoken script — every slide's notes segments in order, slide titles jump on click — with export to plain text or markdown (`<deck>-transcript.txt|.md`). Also programmatic: `instance.transcript.text()` / `.markdown()` / `.open()`.
- **Author mode (edit server)**: `decklight author <deck.html>` serves the deck over localhost with live reload and accepts persisted edits from the player. Endpoints: `GET /edit/ping` (capabilities: deck name, undo/redo depths, git state, detected agents, `agentBusy`), SSE `GET /edit/events` (`reload` on any file change; named `agent` events for job status), `POST /edit/notes {slide, text}`, `POST /edit/layout {slide, layout}` (writes `data-layout` into the slide's `<section>` tag; `auto` removes it; a no-change write is skipped), `GET /edit/element/source?slide=&index=` (an element's outerHTML, read fresh from the FILE — never the live DOM), `POST /edit/element/remove {slide, index}`, `POST /edit/element/content {slide, index, html}`, `POST /edit/element/effect {slide, index, effect}` (writes `data-build`; `effect: null` strips it), `POST /edit/undo` / `POST /edit/redo`, and `POST /edit/agent {prompt, agent?}`. **The server binds `127.0.0.1`, and has no flag that widens it.** That is the enforcement rather than a check: there is no off-machine caller for a classifier to have to refuse. It served the phone remote behind `--remote` until `PRESENT#REMOTE` moved the clicker to `decklight present`, which is a server with no edit surface to widen — so `author` now takes neither `--remote` nor `--host`, and **refuses both out loud** (exit 2, naming `decklight present <deck> --remote`) rather than binding loopback and leaving someone holding a phone that never connects. No `/remote/*` route is registered here at all, mirroring the way `present` registers no `/edit/*`.
- **Present mode (read-only server)**: `decklight present <deck.html> [--port 8790]` plays a deck you did **not** author. It serves **the deck's own directory** — never the cwd — over `127.0.0.1`, with the same port-conflict handling as the author server (`listenTakingOverIfNeeded`). Everything under the served root is fetchable by the deck's own script same-origin, and with `connect-src https:` open (below), fetchable means exfiltratable — so the root is the exposure you accepted by opening the file, not whatever directory the command happened to run from (`$HOME` via file association, a project checkout with its sources). Two refusals are unconditional on top of that: **no path segment may start with a dot** (`.env`, `.git/config` — decoded or percent-encoded), and **no file type outside the server's MIME table is served** (a deck plays HTML, CSS, JS, JSON, images, fonts, audio and video; `id_rsa` or a `.pem` beside a travelled deck is only ever fetched to be exfiltrated). A **source** deck whose assets are not siblings — `demo/showcase.html` reaches up for `../dist/decklight.js` — needs **`--root <dir>`**: the deck must live under it, the same dotfile and file-type rules still apply, and the wider exposure is a flag someone typed and a directory startup prints, never a default. GET only, except the phone remote's own `POST /remote/{key,pos}` (below). It exists because a deck travels: code inlined into one runs in front of an audience that installed nothing, and a deck opened over `file://` gets no policy at all. Serving it instead buys a **`Content-Security-Policy` HTTP header**, which the document cannot override the way it could a `<meta>` tag an attacker edited in the same pass as the payload. The header rides on **every** response the server writes — the deck and its assets, but also the error pages, the control-channel JSON and SSE, and the remote controller — set at one seam ahead of the routes, so the coverage holds by construction rather than by each route's `writeHead` remembering. The policy is `default-src 'none'` plus exactly what a SPEC'd deck needs: `media-src`/`connect-src` reach `https:` (a recorded track's `dir` may be an absolute URL, background video stays external, and a manifest track's presigned URL has no knowable origin to pin), `frame-src`/`frame-ancestors` are `'self'` (the theme picker, slide finder and speaker view boot the deck into same-origin iframes), `style-src` allows inline (themes are inline `<style data-theme>` blocks and the engine writes inline custom properties), and `object-src`/`base-uri`/`form-action` are `'none'`. `script-src` must allow inline — a bundled deck **is** inline script — so the header does not stop a deck from executing; it constrains where that execution can reach. Naming what runs is `PRESENT#AUDIT`, removing it is `PRESENT#STRICT`. The **`/edit/*` routes are not registered at all**: a POST to one is answered exactly like a POST to any unknown path, because there is no route to have refused it. Nothing in the command writes a file. **The deck itself is served from the audited in-memory bytes** — a container's verified payload slice and a plain `.html` alike — so a file edited on disk after startup can never ride out under the verdict already printed and read; every *other* file under the root is read per request, because the ingredients label is an inventory of the deck, not of the directory. If live reload of the deck under `present` is ever wanted, it must re-run the audit and re-print the verdict, never silently serve new bytes under the old one. The local TTS/lipsync bridges are deliberately unreachable — live synthesis is an authoring-path engine, and recorded narration needs no bridge. **The phone remote and speaker view live here** (`PRESENT#REMOTE`), not on the author server, and the reason is the whole point: they used to sit in `cli/edit.mjs` behind `allowRemote`, so getting a clicker meant running `/edit/notes`, `/edit/layout` and `/edit/commit` against your deck while you were on stage and not looking at it. `present --remote` widens the **listener** only — off this machine **only `/remote/*` answers**, and only carrying the per-run token the printed URL and its QR embed; the deck itself and every file beside it stay unreachable from the LAN whether or not the flag is passed. `allowRemote` is the same classifier the author server uses, not a second one. The deck discovers it is being *presented* rather than authored via **`GET /present/ping`**, whose answer carries no agent roster and no edit capability because there is nothing here that edits, and subscribes to **`/present/events`**, which carries exactly one event — `remote`. There is no unnamed `reload` message: a presenting server has no file watcher, and one that could tell a deck to reload would be an editing server with the writes left out. The runtime wires this in its own path rather than through the edit path with a flag, since a shared path with a boolean in it is how a presenting server quietly acquires an editing capability later; `editAvailable` stays **false**, so `E`, `A`, `Z` and layout picks all still say they need author mode. Without `--remote` the QR **404s rather than encoding `127.0.0.1`** — a code that scans cleanly and goes nowhere is worse than no code — while `/present/ping` and the position readout still answer, because those are loopback business.
- **Ingredients label** (printed by every `present` start, before the first slide renders; `decklight present --check <deck>` prints it and exits instead of serving). A decklight deck's shape is predictable — content is HTML, themes are CSS, charts and casts are JSON read by the runtime — so the executable surface is short and everything else that executes is worth naming. The label states: the embedded runtime's banner version and the first bytes of its SHA-256, compared against the build this install ships (**three-valued**: `identical to this install` / `DIFFERS from this install's build of X` / `not comparable here` when the deck carries another version — a package can only vouch for the build it has, and calling an older release a mismatch would read as an accusation); the inert counts (JSON data blocks — casts, viseme sidecars, voice manifests — plus `<style data-theme>` blocks, templates, and the `Decklight.init` call); and then **every unaccounted script block, named with its line number, byte size and opening line**. Script blocks are not the whole executable surface — the `'unsafe-inline'` a bundled deck forces into `script-src` also lets an inline handler and a `javascript:` navigation run — so the label names **executable attributes** on their own lines, with the same coordinates: any `on*=` handler attribute carrying a value; any URL attribute (`href`, `src`, `action`, `formaction`, `xlink:href`, `data`) whose value resolves to `javascript:` or `data:text/html` — resolved the way a browser would read it, character references decoded and scheme whitespace stripped, so `jav&#x61;script:` does not pass on spelling; and any non-empty `srcdoc`, an inline document that inherits the deck's CSP. A handler *mentioned* in prose, an HTML comment, an escaped code sample or the runtime's own strings is not a handler on a tag and is not named — comments and script/style text are masked before the tag scan, offsets preserved. When there are none, the label says `0 inline handlers or executable URLs in attributes` out loud, because the zero line is what states this class of content was examined at all. Accounted for = the runtime (by `data-decklight-runtime`, or the unmarked block defining `Decklight` before the init call — the same locator `upgrade` uses, so the two commands never disagree about which block is the engine), a `src=` naming `decklight.js`, `type="application/json"` or `text/template` data, and a `<script>` whose entire body is one `Decklight.init(…)` call. That last one is matched by **shape, not by mention**: `Decklight.init(); fetch('//evil')` mentions it too, so the call's parentheses are walked (skipping string literals) and anything after the closing paren but a semicolon disqualifies it. A source deck's runtime lives in a separate file the audit never sees, and the label says so rather than reporting a hash it did not compute. **It is an inventory, never a verdict** — no "safe", no check mark, no score. The scan is a heuristic over a file someone may have edited, and a green mark would promise more than the mechanism can keep; a list of what will run promises nothing and is still what you needed. `--check` exits non-zero on any unaccounted block or executable attribute, which means "this deck executes something I could not account for", not "this deck is malicious". The crypto path — a signature over the whole file — is `INTEGRITY#SIGNING` and is deliberately separate: this audit needs no signature, no network, and no cooperation from whoever produced the file.
- **Strict mode** (`decklight present --strict <deck>`, and **automatic** whenever the label finds an unaccounted block or an executable attribute): the deck is served with every unaccounted block removed — each replaced by a fixed HTML comment carrying only a byte count, since interpolating any of the removed bytes into the page would hand the payload a second way in. Executable attributes (`PRESENT#AUDIT`) go in the same pass, spliced out of their tag with nothing in their place — a comment cannot live inside a tag, and the fixed-text rule holds either way. The removal happens **on the way out**, never on disk: the deck you were sent stays byte-for-byte the deck you were sent, so you can still diff it or forward it. It applies to every `text/html` response, not only the named deck — the picker, finder and speaker view all boot documents into same-origin iframes, so a mode that stopped at one file would have a door beside it. What survives is what a deck needs to render itself (runtime, the `Decklight.init` call, JSON data, templates); builds, layouts, themes, `data-chart` JSON and background media are markup, CSS and inert attributes — nothing a browser executes — and were never in the blast radius. A clean deck under `--strict` is **byte-identical** to the same deck without it. Two failure modes are rejected outright: it never refuses to serve, and it never serves the unaccounted block. There is deliberately **no `--force`** — ten minutes before a talk is the worst moment for a refusal, and an escape hatch would be reached for at exactly that moment, so the deck always plays and the part nobody could account for is the part that doesn't. What was stripped is named **in the terminal, never on the page**: the audience did not choose to open this file and cannot act on the finding. The label and the stripper share one scanner and move together, since a printed inventory that disagreed with the served bytes would be worse than a limit you can read. The honest limit that remains is that both are heuristics over markup: a parser trick the scan does not see is a parser trick strict serves, which is why the label is an inventory and never a verdict. A signature that does not verify degrades exactly the same way (`INTEGRITY#SIGNING`) — signing adds a source of failure, not a second behaviour to understand.
- **Signing** (`decklight publish` **by default**, `--no-sign` opts out; `decklight bundle --sign`; verified by `present`). A file cannot vouch for itself — an attacker who edits the payload edits any embedded checker in the same pass, and `file://` HTML gets no OS signature UI — so the attestation is **detached**: `talk.html` is signed and `talk.html.sig` carries the Sigstore bundle, which is the authority. Nothing is embedded in the deck, because a copy inside the payload cannot cover the payload containing it and a convenience that *looks* like a signature is worse than none. **Sigstore keyless: there are no keys**, not "the keys live elsewhere" — a short-lived certificate is minted against an OIDC identity, used once, and left to expire; the transparency log is what keeps the signature checkable afterwards, and it is the same trust root the npm release's provenance already uses. The identity is the ambient OIDC token in CI (GitHub Actions `id-token: write`) or `SIGSTORE_ID_TOKEN` — the client has **no interactive browser flow**, and saying otherwise would send someone waiting for a window that never opens. **`publish` signs by default and `bundle` does not**, which is one decision and not an inconsistency: `publish` is already a network action, so signing adds no failure mode it did not already have, while `bundle` is offline-clean and would gain one. Neither is ever *silently* unsigned — signing runs **before anything is written or pushed**, so a failure leaves no artifact and no commit, and names `--no-sign` as the deliberate way past. `present` verifies before rendering and prints **who** signed (identity, issuer, and the log's own timestamp — never a timestamp the signer chose), read from what the verifier established rather than from the bundle, which is the attacker-supplied half. A signature can check out while the certificate names nobody; that prints as **verified with unknown identity** — precise about what is and is not known: the bytes did verify, the signer did not resolve to a name — and it *gates* as unverified, because the name is the part a person can judge and a nameless one leaves nothing to judge. Four states, and the distinctions are the point: `verified`; `tampered` (these are not the bytes that were signed); `unchecked` (a sidecar that could not be evaluated here — no client, no network — which is **not a pass**, because a gate that passes what it could not evaluate is not a gate); and `unsigned`, which is **not a finding** — most decks are unsigned, and alarming on that would train people to ignore the one case that matters. Anything but `verified` with a named identity on a deck that carries a sidecar feeds the **same degrade-to-strict path** as an unaccounted script block: signing adds a source of failure, not a new behaviour. `present --check` exits non-zero on it, for CI. The client is an **optional** dependency loaded lazily and confined to `cli/` — the runtime keeps zero dependencies, and CI installs `--omit=optional`, so every path behaves sensibly when it is simply absent.
- **The `.decklight` container** (`decklight bundle --deck`, `decklight publish --deck`; played by `decklight present <file>.decklight`). A signed deck travels as *two* files — the deck and its sidecar — and two is one more than people forward, so the container carries the pair as one artifact: the bundled deck, its Sigstore sidecar, and a `manifest.json` (runtime version, origin repo and commit when a repository can be read — never guessed — and declared extensions). Opt-in on both commands until the container proves itself, and `--deck` **implies `--sign`**: the container *is* the signed artifact, so an unsigned one would be an archive wearing the name of an attestation (`--deck --no-sign` is refused). **The extension is `.decklight`**, decided against the obvious `.deck`, which belongs to Decker — an active cross-platform HyperCard revival whose files are *also* interactive decks exported as single HTML documents — while `.dck` is Forge/XMage. Zero-collision verbosity is the feature. **Layout**: the bundled deck verbatim at offset 0, then `\n<!--\n`, then a ZIP of the two metadata files, closed by `\n-->\n` carried in the ZIP's own archive-comment field. That shape satisfies the requirement the format exists to meet — **a `.decklight` renamed to `.html` plays in a plain browser**, degrading to the artifact it wraps rather than to garbage, because the recipient without the tooling is who the container must not become a wall for. The HTML comment is load-bearing, not decoration: character tokens after `</html>` are reprocessed into the body, so a bare append puts raw archive bytes on screen (a render harness caught precisely that); a comment token is never rendered. Offsets are written file-relative, as a self-extracting archive's are, so `unzip` reads the container without complaint. Packing pads the manifest until the compressed bytes contain no `-->`, keeping the wrapper intact and the output byte-reproducible. The manifest sits **outside** the payload so editing the deck and editing its label are not one action, and carries the payload's SHA-256 — but it *describes*, it does not attest: the signature is the only part anyone checked, and `present` prints the manifest as what the container **says** about itself — **except its origin (repo and commit), which is recorded but never printed**. The signature covers the payload alone, so even on a *verified* container the origin is whatever the packer wrote: an Alice-signed payload repacked with a trusted repo's name still verifies as Alice and still passes the digest, and the borrowed provenance would print one skim away from her verified identity. The runtime claim survives on the line because the ingredients label measures the embedded runtime independently, so a lie there sits next to its own contradiction; the origin has no such check, and a claim nobody vouches for adds nothing beside an identity somebody did — it stays in the manifest for tooling to read, and earns a printed line only if it ever comes inside the signed bytes. `present` unwraps in memory (nothing is written, ever), then applies the same audit, the same CSP and the same strict rule as the plain HTML; the payload's length is taken from the ZIP's own first offset, never from the manifest that claims it, and a manifest whose digest disagrees degrades exactly like a signature that does not verify.
- **File association** (`decklight associate`, `--uninstall`, `--print`): wires a double-clicked `.decklight` to `decklight present`, so a deck someone sent opens *verified* rather than raw. Per-user everywhere — nothing needs administrator rights and nothing is written outside the user's home. Linux gets a `.desktop` entry (`Exec=… present %f`, `Terminal=true` so the label is readable, and `%f` not `%F` because `present` takes one deck) plus a shared-MIME-info XML declaring `application/vnd.decklight` as a subclass of `text/html`; macOS gets a minimal `~/Applications/Decklight.app` because a UTI can only be **exported by an application** (`io.decklight.deck`, conforming to `public.html`); Windows gets `HKCU\Software\Classes` entries. The double-clicked path is **untrusted input** — it is the filename of a file someone sent, and the launcher runs before `present` checks a byte — so the macOS launcher hands it to `osascript` as an *argument* (`on run argv`, shell-quoted by AppleScript's `quoted form of`), never spliced into the `do script` text where a quote in the name would become shell. An unsupported platform is refused by name rather than silently doing nothing. The association buys the verified path, **not the only path** — a renamed container still opens in any browser whether or not this ever ran.
- **Presenter plugins** (`decklight plugin add|list|check|remove`; loaded by `present`, never by `bundle`). Chrome the *presenter* installs for themselves — a talk timer, a teleprompter, a confidence monitor — layered on at serve time from `~/.decklight/plugins/`, so the deck on disk is untouched and the same file presented on a machine without them is identical slides with no warning. This is defensible for the reason a build-time transform is (`EXTENSIONS`): **the installer is the risk-bearer, and nothing travels**. A plugin is two files, `plugin.json` and `plugin.js`. **Scope is chrome only, and the browser is what enforces it**: the code runs inside `<iframe sandbox="allow-scripts" srcdoc=…>` with no `allow-same-origin`, so the frame holds an **opaque origin** and `parent.document` throws — there is no handle on a slide to misuse, which is a different thing from a rule against reaching for one. A deck has to stay a deterministic artifact, or two people presenting the same file are presenting different decks. Two checks sit *in front* of that boundary and neither carries it: the manifest vocabulary is **closed** the way the wizard's field types are (`slot` from a fixed list so a plugin cannot place itself over the stage, sizes clamped for the same reason, unknown keys refused rather than ignored), and a **lint** rejects source that reaches for the deck's document — which already fails at run time, so catching it at install turns a `SecurityError` nobody is watching into a sentence. What crosses into the frame is a one-way push with no request channel: deck position, build step, elapsed time, and **speaker notes only to a plugin that declared `needs: ["notes"]`**, which `plugin list` and the `present` startup line both name. Reading notes is not transforming them, and the speaker view already shows those words on that machine — but a timer never sees a line of the talk. A plugin **never enters the ingredients label**: the label is an inventory of the file (`PRESENT#AUDIT`), the chrome is injected after the audit has read the bytes and after strict mode has stripped what it could not account for, and it is reported on its own line as the presenter's own. It **registers no route and widens no policy** — a `srcdoc` frame is never fetched, so `frame-src` has no URL to judge and it loads under the deck's existing CSP untouched. A broken plugin is skipped with a reason rather than being fatal (`PRESENT#STRICT`'s argument: nothing about a timer should cost someone their talk), `--no-plugins` presents without the library, and with nothing installed `present` serves a deck byte for byte as it did before any of this existed.
- **Engine wizard** (`ENGINES#WIZARD`; author mode only). A capability ships with its affordance always present (`V`/`N`, `A`, the palette entries) and **no bundled provider**; first use opens a wizard that installs and configures one. **The door is the `/` palette**: the author server's ping advertises every engine a registered marketplace declares a wizard for (`wizards`, beside its `agents`), and each gets a contextual `Configure ⟨engine⟩… (dev)` row that opens the form — named by **qualified** ref (`engine@marketplace`), so two catalogs sharing a bare name cannot silently resolve to whichever registered first. Without a server the list is empty and the rows are ABSENT, not disabled — same reasoning as the gate below. `instance.wizard(⟨engine⟩)` is the programmatic door, for drivers that cannot click. **Core renders; a plugin only declares** — a schema of questions, field types and a validation path, never markup. The field vocabulary is **closed** (`secret`, `text`, `choice`, `path`, `boolean`) and that is the mechanism, not a style rule: "the wizard appears only in author mode" is enforceable exactly as long as no plugin can put its own markup on a slide. Unknown keys are refused rather than ignored (a silently dropped key is a wizard asking for less than its author believed), a `secret` may not carry a `default` (a placeholder to be pasted over, or a key baked into a catalog — the second is bad enough to refuse the first), and `validate` is a **path** the plugin chooses on an origin it does not (a schema that could name where to send a freshly pasted key would be an exfiltration primitive with a config file for a delivery mechanism). A schema is vetted on the way **out** of the server as well as on the way in, because a catalog is a file someone else wrote. **Credentials**: pasted in the player, posted to the author server, and stored under the config home beside `marketplaces.json` **restricted to the account that pasted them** — and re-restricted on every write, since `writeFileSync`'s mode is ignored for a path that already exists. What that restriction IS is per-platform, and decklight says which: `0600` on POSIX, where the mode is the whole of the protection; on Windows an explicit ACL, because a mode there is a number with no meaning and inheriting whatever the user profile hands out is not a decision decklight ever made. That ACL is set in three steps and the third is the one that matters: `/inheritance:r` drops what was inherited, `/grant:r` puts this account on, and then **every other principal is removed by name** — including `SYSTEM` and the Administrators group, since an administrator can take ownership whatever the DACL says. The usual one-line recipe stops after the first two and silently does nothing at all on a file whose entries are already explicit; a Windows CI run is the only thing that can tell the difference, which is why one gates this. Every sentence printed about this — the wizard's own destination line, the author server's log, `report-bug`'s environment block — is derived from the file **read back**, never from what the write intended: a key with weak permissions is bad, and a key with weak permissions under a CLI reporting `0600` is worse. A machine with no ACLs to set (a FAT volume, a share) is not an error and is not silently accepted either — it is reported as inherited, in those words. Never logged, never in the response (redaction is **one** function, so a key cannot reach a debug panel two features later), never written into the deck, never read by `bundle`. **Never outside author mode**: the routes are `/edit/*`, so `allowRemote` refuses them off-loopback unconditionally and `present` registers nothing resembling them — a credential prompt in a deck you were emailed is a phishing primitive, and the player gate refuses *before* it builds a single input. Install and configure are one flow with **three distinguishable answers**: `unreachable` (wait), `rejected` (fix the key, the answers, or the plugin's schema), and "no such engine" (add the marketplace — named, not one of the two failures). Nothing is stored on any failing path, and answers that fail the schema never cost a network call. Recorded narration needs none of this: a deck with a voice track plays from files with no engine installed.
- **Undo/redo** (`Z`/`⇧Z`): the server keeps ONE in-memory edit history — whole-file snapshots, capped at 200 — fed by every mutation it performs (layout picks, notes saves, agent runs). Undo/redo rewrites the deck file; the watcher's reload shows the result (the hash keeps the position). The history is deliberately **independent of git**: commits never consume or reset it, and undoing never touches the repository. A file edited externally between an edit and its undo isn't lost — the current content rides the opposite stack. Empty stacks answer 409, and the player toasts the remaining depths.
- **Git autocommit**: with `--git` (or automatically when the deck already sits inside a repository; `--no-git` opts out) the server commits the deck on a regular basis — every `--commit-every` seconds (default 300) when it actually changed, plus an opening commit and a final one on Ctrl-C. `--git` creates the repository when none exists; `decklight author` ASKS first on a TTY ("no git repository here — create one and auto-commit?"). A repository decklight creates starts with a starter `.gitignore` — `.shots/` (screenshot evidence), `.DS_Store`, and, behind a delete-this-line comment naming the tradeoff (bulky vs. cloud narration costing money to regenerate), `voiceover/` — written between `git init` and any initial commit; an existing `.gitignore` is never touched, and a repository decklight didn't create never gets one. Only the deck file is staged (`git add -- <deck>`), and a machine with no git identity gets a per-commit `-c user.name/user.email` fallback rather than a silent failure. **When to commit** is chosen by `--git-mode`: `agent` (the **default**), `timer`, or `off`. In `agent` mode a completed agent edit produces one commit carrying the agent's own summary as the subject — a failed run or one that changed nothing commits nothing — **and** the cadence keeps running underneath as a backstop, held back only while a job is in flight so no commit ever captures a half-finished agent run. `agent` is therefore a superset of `timer`, which is what makes it safe to default to: nobody loses the periodic safety net. A timer is the wrong boundary for agent-authored work on its own — the commits land on a clock that lines up with nothing the agent did and every message reads `autosave` — but it is the right backstop, because an agent job only ever sees edits it made.

Authorship is **structural, not detected**: the server spawns the agent itself and diffs the deck around that process. An agent driven from OUTSIDE that flow — a `claude` session in another terminal — is indistinguishable from a hand edit, and nothing in the filesystem could tell them apart. Such an agent declares itself instead, by `POST /edit/commit { message }` when it finishes a logical change; the installed authoring skill instructs agents to do exactly that. The same endpoint is how a multi-step agent marks intermediate boundaries. Uncommitted work is committed before an agent job starts, so the agent's commit holds only the agent's work. Agent-supplied messages are untrusted text: collapsed to a single line, length-capped, and never allowed to begin with `-`. `decklight init` states the policy when it creates a repository rather than asking about it.
- **Ask an agent** (`A`): author mode drives whichever AI coding agent CLIs the authoring machine has installed — the roster (`cli/agents.mjs`) covers **Claude Code** (`claude -p … --permission-mode acceptEdits`), **Codex CLI** (`codex exec --full-auto …`), and **IBM Bob** (`bob -p … --accept-license`), plus Gemini CLI, GitHub Copilot CLI, OpenCode, Goose, Aider, Cursor CLI, and Qwen Code — each as a headless one-shot invocation, detected by probing `$PATH`. A opens a prompt overlay (agent picker when several are detected; `--agent` sets the default); the server snapshots the deck, spawns the agent in the serving directory with the instruction wrapped in deck context, and streams start/done status over SSE (toasts in the player; 10-minute timeout; strictly one job at a time — `agentBusy` survives reloads via ping). If the agent changed the file, the watcher reloads every browser and `Z` takes the edit back like any other.
- **Notes editor** (right-click a slide's background, or the `/` palette): opens a notes editor — ⟨CLICK⟩-separated plain text — whose Save rewrites the slide's `<aside class="notes">` in the file (one `<p>` per segment, HTML-escaped; the aside is inserted if the slide had none). `E` used to open this directly; it now arms element edit mode instead (below), and the background right-click is where notes editing moved to — the same `toggleEditor()`, unchanged, reached a different way. The server watches the deck file and broadcasts a reload to every connected browser on ANY change — the player's edits and external editors alike — and the `#/slide/step` hash restores the position. `file://`-opened decks probe the server at its default localhost port so the printed URL and a double-clicked file both work; `config.edit.url` overrides, and a basename guard refuses a server that's editing a different deck. **The `/edit/*` surface is not CORS-open.** Binding loopback is the wrong boundary for the threat: the dangerous caller is the user's *own* browser, where any open tab can `fetch()` the port, and a wildcard `access-control-allow-origin` waves that through — a `text/plain` POST is a "simple" request the browser sends with no preflight, so a coding agent has already run against the deck's directory by the time CORS is consulted on the way back. So every request is gated on its `Origin` **before** any handler runs (`allowEditRequest`, `cli/serve.mjs`): a loopback web origin (the deck this server serves), `null` (the `file://` double-click above), and a missing header (the CLI, the port-conflict probe, `curl` — not a browser cross-origin call) are admitted; a foreign site is refused with no CORS grant, so it cannot even read the refusal. The one residual is that `null` is also a sandboxed iframe's origin — closing it would cost the `file://` path a token it has no way to receive, so the double-click affordance is kept and the residual named here.
- **Messages** (`` ` `` — the key left of `1`, matched on `code` so it is the same physical key on every layout; or the palette's "Messages"): the deck talks back in the **top-left corner** — 20px, high-contrast, stacked newest-last (at most 4 at a time), each fading after a few seconds. Every message is also KEPT: that key opens the log — the full history with arrival times — because a message that explains why the voice stopped is worthless if it faded while you were looking at the slide. The shortcut is handled BEFORE the typing guard, so `` ⌃` ``/`` ⌥` `` reach you even while the notes editor has focus and owns every bare keystroke; the bare key works whenever you are not typing. `instance.messages()` returns `[{ at, text }]`, `instance.toggleMessages()` opens the log.
- **Onboarding — the first-run welcome and the tips that follow it**: the two moments a deck can afford to teach the tool, and they never share a load.
  - **First-run welcome**: the first time a browser opens *any* deck, a card introduces Decklight — the single-file/agent-authorable model, `/` for the palette, `?` for shortcuts, `T`/`⌃T` for themes, `S`/`V` for speaker view and narration, and author mode (`decklight author`, `A` to ask an agent, `E`, `Z`). Themed through the token contract (`--bg`, `--fg`, `--accent`, `--accent-contrast`, `--muted`), so it reads on every theme. **Any key dismisses it and does nothing else** — a newcomer pressing `→` clears the card, then advances on the next press — and any real advance (touch swipe, the on-screen chevrons, a programmatic `next()`) retires it for good, so it can never sit over a talk in progress. A click dismisses without advancing, even though a bare click on the deck is "next" everywhere else. Reopen from the palette ("Welcome to Decklight") or `instance.showWelcome()`.
  - **Tips**: every load after the welcome shows at most **one** tip through the message facility (Messages, above) — same look, same fade, same kept log — drawn in order from a fixed rotation that starts with the most basic (`/`, then `?`, then `G`, …). Each tip shows **at most once, ever**; once all are read the deck is silent, with no "no more tips" message to announce it. The palette carries `Tips on`/`Tips off` (persisted) and `Reset tips` (contextual — absent when nothing has been read yet).
  - Neither ever appears in `?print` or `?embedded` (a printout and a preview teach nobody), nor when the URL deep-links past slide 1 / step 0, which is somebody presenting from a link rather than a first run. Both seen-flags are **global** (`localStorage['decklight-onboarded']`, `decklight-tips-seen`, `decklight-tips-off`), not path-scoped like the theme/font/clock keys: they remember what a *person* has been told, not what a *deck* should look like — the same reasoning as `decklight-custom-themes`. Every write is best-effort, so `file://` and private mode play normally and simply forget.
- **Debug log** (`D`): a passive monospace panel over the deck (keys keep driving the presentation) showing a timestamped event stream — ready/slide/build with direction, theme and font applies, narration on/off and config changes, every TTS call with its duration and estimated cost (`slide 3 seg 1 · Alnilam · 214 chars → 2.4s · ~$0.0041`, previews included) and failures, and window `error` events — plus a live state line (slide/step/theme/narration incl. the active voice · tone or track, the voice rate, and the running TTS spend). Cost is an ESTIMATE: the Gemini API returns token counts (`usageMetadata`), never dollars; the bridge prices them at published Vertex list rates, sends `x-tts-cost` on each fresh synthesis (0 on cache replays), and prints a per-call line plus session total on its console. Events ring-buffer (last 200) from init, so the panel shows history from before it was opened.
- **Font cycling**: `[`/`]` walk a curated list of offline-safe system stacks (sans, rounded, humanist, geometric, two serifs, slab, mono; entry 0 = the theme's own type) applied to `--font-body` + `--font-heading` as inline root properties — they win over any theme and survive theme switches. The choice persists per deck path in localStorage and is restored before the first layout pass; every change re-measures pinned titles and re-runs the overflow guardrail (type metrics differ). `instance.cycleFont(±1)` programmatically.
- **Element edit mode** (`E`, author mode): `E` arms (and disarms) the mode; the editing surface itself is right-clicking the current slide. Right-clicking a specific element — found by walking up from the click to the section's direct child that contains it, so a click anywhere inside a bullet list or a chart still resolves to that top-level element — opens a menu: Edit speaker notes, Remove element, Edit content (HTML), Add text effect ▸. Right-clicking the bare slide background (nothing under the cursor but the `<section>` itself) shows only Edit speaker notes. Elements are addressed by **raw position among the slide's direct children** (`[...section.children].indexOf(el)`, title included, never filtered as chrome the way the engine's own `splitContent()` filters a *live* DOM) — no per-element ID scheme, so a hand-authored deck needs no new markup to become editable. `tools/deck-html.mjs`'s `sectionChildRanges()` is the walker the server-side transforms share with `locateSlide`: it treats `<script>`/`<style>` bodies as opaque (a chart's embedded JSON is not markup) and nests by genuine recursion rather than a same-tag-name counter, so self-closing SVG children and same-name nested tags still resolve correctly. "Edit content (HTML)" reads the element's outerHTML fresh from the **file** via `GET /edit/element/source` — never the live DOM, which the engine mutates in place (pinned-title classes, namespaced SVG ids, chart/code/math subtree replacement) — in the same textarea-and-⌘⏎-saves shape as the notes editor. "Add text effect ▸" drills into a submenu offering the spec's 7 entrance styles (`MOTION`) plus `none` (an explicit, instant build step — one more advance still reveals the element, it just carries no animation, which is why it is distinct from "remove effect", the separate action that strips `data-build` entirely). Remove / edit-content / add-effect all land on the SAME undo/redo stack as layout and notes edits, through the same `applyEdit`. A slide with no per-element source mapping declines the whole menu rather than opening one that cannot honestly save anything — markdown-authored slides (`data-markdown`, removed in 0.3.0, above) are the one case of this today, marked `data-markdown-removed` at parse time. The menu is the first **cursor-anchored** overlay in the engine — every other one dims the screen and centers a card; this one keeps a transparent backdrop (dimming would hide the very slide the menu is about) and positions the card at the click, clamped to stay on-screen. It still reuses the shared `closeOnBackdrop`/`selectInList` machinery: arrow keys navigate, `Escape` and a backdrop click both close it, exactly like every other overlay. `instance.toggleElementEdit()` programmatically (same gate).
- **Slide layout cycling** (author mode only): `L`/`⇧L` walk the CURRENT slide through the layout ring — `auto` (deck default: the `pinTitles` config, **on by default**, + the pinnable heuristic — so out of the box a pinnable slide pins) → `centered` (title in flow, content vertically centered) → `pinned` (title pinned at the pin Y) → `top` (everything flows from the top of the slide) → `split` → `split-flip`. Ring entries that cannot change the slide's look are SKIPPED so every press shows something new: `pinned` when `auto` already pins, `split-flip` when there aren't two content blocks to swap sides. **Split layouts**: the first two content blocks — everything after the title + subtitle header (which spans the full width, pinned or in flow) — become ~half-width sides in a wrapping flex row, first block left and second right; `split-flip` mirrors (bullets left · diagram right ⇄ diagram left · bullets right). The two sides **share a top edge** (`align-items: stretch`): columns of unequal height used to centre independently, so the shorter one's heading floated down the slide and the pair stopped reading as a pair — authors were hand-rolling `display:flex; flex-direction:column; height:100%` on each column to get this back. Images opt out of the stretch (`align-self: center`) so a picture is never letterboxed inside a box taller than itself. A **third block is a footer, not a third column**: it spans both sides, centred, below them (`.split-footer`, applied by the engine to every block past the second). The shape that asks for this is the comparison slide — two columns and a note that applies to both — and treating it as "everything else right" hung that note under one side of a comparison it was about equally. Three side-by-side columns are deliberately **not** a shape: grouping three items onto one slide multiplies content-per-slide, which is what the density guidance exists to discourage; use two and a footer, or another slide. A slide whose ONLY content block is a list can't take sides — the engine marks it `.split-columns` and the list itself splits across two CSS columns (`break-inside: avoid` per item). The pick lands on the section as a `data-layout` attribute — the same attribute an author can write in the file, and headless probes can assert on — and it wins over `data-pin` (`pinned` forces the pin, a numeric `data-pin` still sets the Y; `centered`/`top` lay out in flow; the split pair keeps the deck's auto pin resolution for its header). `auto` removes the attribute. A layout pick is a PERSISTED deck edit, so cycling requires author mode: the pick applies to the DOM instantly and is written back into the file through the edit server (debounced ~600ms, so a cycling burst costs one write/reload, and a pick pending when the slide changes is flushed, not dropped) — the file is the ONLY persistence (no localStorage). Without the server, L toasts what it needs and changes nothing — a presenter can't silently fork the deck from what's on disk. Every change re-measures pinned titles and re-runs the overflow guardrail. `instance.cycleLayout(±1)` programmatically (same gate); `instance.layoutRing(n)` exposes a slide's ring — skips included — so headless probes can assert the skip logic without a server; also in the `/` palette ("Cycle slide layout").
- Touch: swipe navigation.
- URL: `#/<slide>[/<step>]`; back/forward supported. `?theme=<name>` loads any theme at startup.
- **Theme switching**: the theme is the stylesheet link into `themes/`; the engine swaps its href in place, so every token cascades and the deck restyles live. `T` opens the **theme picker**: the theme list (config `themes: [...]`, defaulting to the shipped set baked in at build time) beside a live preview of the *current slide at the current step* — a real embedded deck (`?embedded&theme=<name>#/<slide>/<step>`). `↑/↓`/hover browse (debounced), `Enter`/click applies, `Esc` closes. **Packs** (themes/packs.json, baked in at build; the build fails if a shipped theme is missing from the manifest): the picker opens on the pack list (name + count; the active theme's pack is marked), `Enter` drills in, the `← packs` row or `Esc` goes back, `✳ all themes` flattens; saved-custom and generated themes form dynamic packs at the end. An active filter always searches globally and tags each hit with its pack. **Browse** is a fourth row under the pack list (`THEME_BROWSE#UI`) and appears **only in author mode** — not greyed out, absent: it is a write to the deck on disk, and a presented deck never reaches the network for a theme, so there would be nothing behind a disabled row to explain. It drills into the themes of the marketplaces already registered, each tagged with the marketplace it came from and already-installed ones tagged `installed`; the filter narrows that list instead of the installed one, since the two are disjoint. A marketplace row is the one row with **no preview** — the theme is not in this deck yet, and previewing it would mean fetching it to look at. `Enter` installs through `theme add`, and a refusal keeps the picker up with the contract problems in the caption rather than closing on a failure; a successful install lands on disk and the watcher's reload is what brings the deck back with it, as an **Added** theme like any other. **Pack-aware cycling**: `,`/`.` walk the pack-grouped order; a step that would cross into another pack pends instead of applying — a toast names the pack and target theme, the same key confirms, the opposite key or `Esc` cancels, and the pending step times out after 4s. **Quick filter**: printable keys type into a filter bar that narrows the list (substring match; the generate row hides while a filter is active); `Backspace` edits, `Esc` clears the filter first and closes on the second press. Because keystrokes feed the filter, the picker has no letter shortcuts (`⌃T` re-rolls the generate-row candidate; the former `R`/`T` bindings are gone). The applied choice persists per deck path in `localStorage`; **embedded instances never persist** (previews can't pollute the saved choice).
- **Inline-theme mode** (bundled single-file decks): when `<style data-theme="name">` blocks exist, they replace the link — `applyTheme` toggles which block applies (via `media="not all"`; the HTML `disabled` attribute on `<style>` is non-functional per spec, and the engine normalizes either form at init). The picker lists the embedded names (config `themes` narrows), `?theme=` works, and everything else is unchanged.
- **Theme generator**: `⌃T` generates a brand-new contract-complete theme (THEMING note) and applies it instantly — press again to re-roll. The roll lives as a `<style data-theme data-generated>` block appended last in `<head>` (wins the cascade over the link/inline base); cycling `<`/`>` or picking another theme deactivates it but keeps it in the theme list under its autoname (`gen-<word>-<hex4>`) until the next roll replaces it. The picker's first row is **“✨ Generate new…”**: selecting it rolls a candidate and previews it live like any other theme (`⌃T` re-rolls while selected; `Enter` applies). Previews for generated and saved-custom themes carry their tokens in the URL — `?gen=<base64url {name, tokens}>` — which the engine applies statelessly at init (works on `file://` and inside bundles). The preview deck loads **once per picker session**; subsequent selections are postMessage'd into the embedded instance (`{__decklightPreview: {theme|gen}}`, parent-origin-guarded) and applied in place — no document reload per candidate, which matters in bundles where each reload would re-parse the whole payload. `⌃⇧T` **saves** the applied generated theme: prompts for a name (sanitized `[a-z0-9-]{1,40}`, `custom-` prefixed on collision with a shipped name), persists `{name → tokens}` into `localStorage['decklight-custom-themes']`, and downloads `<name>.css` (a normal theme file). Saved customs appear in the theme list and picker (tagged “custom”), survive reload, and apply via the same inline-style mechanism — but localStorage is per-origin/per-browser: **the downloaded .css is the portable artifact** (drop it into `themes/` and commit). Unsaved generated autonames are never persisted as the deck's theme choice.
- **Brand logo**: `init({ logo: { onLight, onDark, src?, height?, position? } })` renders a mark as chrome on every slide (default `bottom-left`; also `top-left|top-right|bottom-right`; default height 30px). `onLight`/`onDark` are the variants for light/dark canvases: the engine reads the applied theme's real background luminance (first gradient stop for gradient canvases), sets `data-canvas="dark|light"` on the root, and the matching variant shows — following theme cycling, the picker, and generated themes ( `src` alone shows always). Refs resolve as `'#id'` (clones an inline element — bundle- and `file://`-safe, the `data-cast-inline` idiom), `'<svg…'` raw markup, or an `<img>` URL. In `?print`, every slide gets its own copy. **Hero variant**: `data-logo` on a section prepends a larger in-flow copy of the mark above the slide's content (default 96 design px; `data-logo="128"` overrides) — module openers and cover slides. Hero slides hide the corner chrome (and skip the print copy), the mark doesn't count as pinnable content, and the same on-light/on-dark variant switching applies.
- **Narration**: `V` toggles voice-over; `N` opens the picker (persisted per deck). Two sources. **Recorded**: pre-rendered per-slide audio (`<dir>/slide-NN.m4a`, 1-based like `state.slide`), synced to slide changes; the deck configures `narration: { files: '<dir>' }` or `[{ label, dir }, …]` for several takes. A `dir` may be an absolute URL, so a **public** bucket has always served a track with no extra machinery (`dir: 'https://storage.googleapis.com/…/algenib'` — media elements load cross-origin without asking). **Manifest tracks** exist for the case a `dir` cannot express: `[{ label, manifest: 'voices/algenib/manifest.signed.json' }, …]` fetches a small JSON list once when narration starts and plays each slide's URL **verbatim**, because a presigned URL carries its signature in the query string and a query string can never be a directory prefix. The manifest is the file `tools/voiceover.mjs` already writes (`{engine, voice, style, slides: [{file, hash}]}`), extended with an optional per-slide `url` and a top-level `expires` (ISO 8601); a slide with no `url` resolves its `file` next to the manifest, so an unsigned `manifest.json` in a public bucket is a track for free, and a `null` slide (no notes, no file) is silence rather than a failure. `tools/publish-voices.mjs <dir> --bucket gs://… [--sign 7d]` uploads the slides whose hash moved (the last `manifest.signed.json` is the record of what is already up there; `--all` overrides), signs every slide through `gcloud storage sign-url` — never our own key handling — and writes `manifest.signed.json` to deploy beside the deck while the megabytes stay in the bucket. It refuses a `--sign` longer than **7 days**, the V4 signing scheme's own ceiling, and names the public-bucket alternative for audio that must outlive a week. Signatures expiring is one more way for the voice to be unplayable, so it behaves like all the others: the expiry is checked before the first clip, narration turns off, auto-advance stops, and the message names the track, the date, and the literal re-sign command (the manifest records the `source`, `bucket` and `signDuration` it was made with, so it is a line to re-run and not a shape to fill in). A signed file that fails to load is treated the same way — a media element cannot report an HTTP status, so a 403 for a lapsed signature is indistinguishable from any other failure, and naming the only cause worth naming beats staying silent. `N` shows a manifest track with a ☁ and the time left. `decklight bundle` **inlines the manifest** under its own path (`data-decklight-voices`), like the viseme sidecars, because `fetch` is dead on `file://`; the audio stays in the bucket, which is the whole point. One honest caveat: the character overlay's `amplitude` fallback reads the audio through WebAudio, and cross-origin media taints that unless the bucket sends CORS headers — viseme sidecars are same-origin JSON and are unaffected. **Live voice**: the player synthesizes each slide's notes on the fly through the local bridge (`decklight tts`, default `http://127.0.0.1:8787/tts`, override via `narration.liveUrl`). The bridge speaks with one of four engines (`--engine`, tools/tts-engines.mjs): **gemini** (gemini-2.5-{pro,flash}-tts on Vertex AI — a delivery style always reaches it; no free tier, and a fresh project's per-minute quota 429s under the lookahead's bursts), **chirp** (Chirp 3: HD on the Cloud Text-to-Speech API — the same 30 star-named voices, ~1s a sentence, 1M characters a month free, no style channel), **piper** (a local neural model — offline, unlimited, free, no credentials; one voice per installed model, and the process is held RESIDENT because piper reloads its ~120 MB model on every start), or **elevenlabs** (your own ElevenLabs account's voices — the ones you *cloned* included, which is the reason it exists). The first three know their roster up front; ElevenLabs cannot, because the interesting voices are yours, so it fetches the account's list once and `/ping` and `/voices` await it — **your** voices first (cloned, then professional, then premade), each tagged with where it came from, and the picker's default is the first of them. The player sends a voice NAME; a `voice_id` pasted from the dashboard resolves too. Its key is read from `$ELEVENLABS_API_KEY` and is **never written to `tts.json`** — decklight remembers the choice and leaves the secret to your environment. Style reaches it only through `--tts-model eleven_v3` (`stylable` follows the model chosen, not just the engine): v3 reads a short bracketed **audio tag** ahead of the sentence as performance direction — never the Gemini-shaped prose instruction, and never sent to any other ElevenLabs model, where the brackets would just be read aloud as words instead of shaping them. An optional `--tts-stability creative|natural|robust` (v3 only; refused up front on any other model rather than silently doing nothing) trades how hard v3 follows the tag against how much it drifts, and is left alone entirely — no `voice_settings` sent at all — when unasked. Both the tag and the sentence it directs are billed as the characters actually sent, and it is metered in characters against a plan rate decklight cannot see, so the bridge reports characters rather than inventing a dollar figure. Audio is `pcm_24000` wrapped as WAV like every other engine; `--tts-format mp3` is the escape hatch for plans without PCM output and costs you `⇧V` offline recording and the lip-sync bridge, both of which read WAV — so it is opt-in, never a silent downgrade. `GET /ping` reports `{engine, model, voices, stylable}` and the picker offers exactly those voices, skipping the tone step when the engine cannot be told how to speak — a roster the bridge cannot pronounce would be a silent lie. The bridge is probed when live narration **starts**, not only when the picker opens, and a saved voice the live bridge does not have is treated as **stale rather than chosen**: it came from a different engine (the star roster is the default, and an ElevenLabs key knows none of those names), so the bridge's first voice takes over, is persisted, and the swap is announced — a voice changing on its own must never be silent. **The voice already on the machine**: with no engine chosen, none saved, and no cloud project, `decklight author` asks the operating system what it can speak with before defaulting to an engine that would only be skipped. **macOS** is read through `say -v '?'` — the roster mixes twenty years of engines, so voices are ranked by the tier macOS itself labels (a **Personal Voice** the user recorded first, then Premium/Neural, then Enhanced, then built-in) and filtered to the deck's language, because a Mac whose best voice speaks Italian must not narrate an English deck with it. **Windows** is read through PowerShell (`System.Speech`), preferring the newer `(Natural)` voices. Both become real bridge engines (`--tts-engine say|sapi`), synthesizing 24 kHz PCM in a WAV like every other engine, `stylable: false` so the picker skips the tone step. **Android** is detected and refused with the reason: Termux reports `android` and runs Node, but Android's TextToSpeech is an in-process Java API with no command line behind it, so there is nothing for a bridge to call — the honest path there is a recorded track, which needs no bridge. A native voice is the ONLY engine claimed automatically, because it is the only one that needs no setup at all; **piper is never auto-selected even when it is on PATH**, since it needs a toolchain and a ~120 MB model and that choice belongs to the first-run wizard, which saves it. Any `--tts-engine`, `--project`, `GOOGLE_CLOUD_PROJECT` or saved config wins outright and detection is never consulted. When a machine has nothing, the skip line says what THIS machine lacks and names piper; and if **Ollama** is answering on 127.0.0.1:11434 (a ~300 ms probe, raced against a timeout so a hung socket cannot stall startup) it adds that Ollama serves LLMs and has no speech endpoint — the single most common thing a local-AI user expects to cover this. **A missing piper voice is caught before the bridge starts, not by it**: piper installed and chosen but with no model on disk used to bring the bridge up looking healthy and fail on the first sentence — a keypress into silence, for a file that was never there. `decklight author` now checks, names the model, its directory and its size, and on a **TTY** offers to fetch it; accepting re-plans so the bridge joins the session, declining or a non-TTY run keeps the skip line. **Nothing is ever downloaded silently.** The command it runs is chosen for the machine (`tools/tts-engines.mjs`): a python that can already import piper gets `python -m piper.download_voices`, and otherwise `uvx --from piper-tts` runs it inside the isolated venv `uv tool install piper-tts` creates — the plain form cannot work there, which is why it used to fail with `ModuleNotFoundError` on a machine that had just followed decklight's own install instruction. **First-run setup**: the first time the bridge cannot start — a bare `decklight tts`, or `decklight author` about to skip the voice because nothing is configured — decklight asks a few plain questions on the terminal (TTY only) instead of exiting with the engine's error: the engine, with the free/offline/cloud trade-offs stated and the default following what the machine already has (an `$ELEVENLABS_API_KEY` outranks everything — nobody exports one by accident; else piper on `PATH`, else a project visible in the environment or gcloud config), then only that engine's prerequisites — a GCP project id (prefilled, validated with the same rule the flags enforce) plus a credentials probe for the cloud engines; for piper the install and voice-model download commands, run only on an explicit yes; for elevenlabs nothing at all when the key is exported (the roster answers "which voice", so it is not asked) and otherwise where to make a key and why setup will not save it for you. Setup proves the choice with one real synthesis of the picker's preview sentence, reporting duration and the engine's cost note, and only a config that has spoken is saved — to `~/.config/decklight/tts.json` (`$XDG_CONFIG_HOME` honored), which both `decklight tts` and `decklight author` read from then on; precedence is flags > environment > saved config > built-in default. `decklight tts --setup` re-runs the questions, deleting the file resets to first-run, and non-TTY invocations never prompt — exit codes and messages stay as they were. **The voice is the clock**: auto-advance is driven by narration finishing, so when the voice CANNOT be played — a quota 429, an unreachable bridge, a browser that blocked autoplay, a recorded track with no file for this slide — the deck **stops advancing** rather than walking the talk past slides nobody has heard, and says why in a message (`I`) naming the cause and the way out (`--tts-engine chirp` for a 429, `decklight tts` for a dead bridge, one click for blocked audio). Narration switches itself off; `V` retries — the picker drills tracks → voice (30 prebuilt Gemini/Chirp names, one piper model, an OS voice, or the ElevenLabs account's own roster) → tone, on any engine `/ping` reports as `stylable` (six presets or a custom typed instruction — a prompt prefix for gemini, a short bracketed audio tag for ElevenLabs `eleven_v3`). Every voice row carries a ▶ **preview** that speaks an editable test sentence (default "Hey, this is Decklight", input at the top of the voices view, ↺ restores the default) through the bridge in that voice; tone rows preview the drafted voice in that delivery style, and the custom-tone input has a ▶ to audition a typed instruction before committing it. After a preview plays, the rest of its roster prefetches sequentially in the background (all voices neutrally, or all tones for the drafted voice). Two preview caches: the default sentence's cache is permanent once built; the custom sentence's cache holds exactly one sentence and is swapped (old audio freed) when the text changes. **Build-synced auto-advance**: the ⟨CLICK⟩ markers that segment the notes for the speaker view segment the audio too — segment k is synthesized as its own clip and narrates build step k (0 = arrival); when a clip ends the deck reveals the next build, and after the last segment it moves to the next slide, so a deck with well-segmented notes presents itself beat by beat. A segment with no words advances after a short beat; a slide with no notes is skipped; manual navigation mid-clip wins over the pending advance and re-syncs the voice to the new step. **`data-narration="hold"`** on a section marks it interactive (quiz, exercise, live demo): narration plays whatever notes it has and builds still sync, but the deck never auto-advances *off* it — the presenter moves on manually and narration resumes on the next slide. The spoken unit is a **sentence**: each ⟨CLICK⟩ segment splits into sentences, every sentence is its own TTS call and cache entry (slide, segment, sentence, voice, style), playback chains them and advances only after the segment's last one — so first audio arrives after one short synthesis, never a whole paragraph. While narration is on, a **lookahead buffer** keeps the next 10 sentences synthesized in the background (a few parallel low-priority workers, window re-derived from the current position, results landing in the same cache); an unreachable bridge toasts once and pauses the buffer until the next event. `⇧V` downloads per-slide `slide-NN.wav` files **stitched from this same sentence cache** (short silences joining sentences and builds) — already-heard clips cost nothing, only unheard sentences synthesize. **`P` pauses/resumes** narration — audio freezes mid-sentence and resumes exactly there, and auto-advance holds while paused. Captions (`C`) follow the voice **sentence by sentence** during live narration (segment-level when narration is off). With nothing configured, `V` opens the picker instead of failing. **The deck announces its own voice**: when a recorded track is configured, a small pill fades in bottom-center about a second after load — *🔊 this deck has a voice-over — `V` plays it* — and clicking it starts narration (the click is itself the user gesture, so the audio is never the blocked-autoplay case). It fades out on its own after ~12s and is written to the message log (`I`) rather than toasted, since the pill is already on screen saying it. It never appears in `?print`, in embedded previews (the theme picker and slide finder boot real decks in iframes), under `?voiceover` (which starts on the first gesture anyway), while captions (`C`) hold that same corner, or once narration has been started on this deck — remembered per deck path like every other narration preference. Without it the only proactive surface was the touch sound button, which CSS shows on `pointer: coarse` alone, so a viewer on a laptop could only learn the deck talks from a key nobody had mentioned. Files are generated by `tools/voiceover.mjs`: notes → optional local-LLM rewrite → `--engine piper` (local neural TTS; `--voice` = piper model name) or `--engine gemini` (gemini-2.5-pro-tts on Vertex AI; `--voice` = prebuilt voice name). The built-in speech-synthesis voices were removed — not good enough. `?voiceover` starts narration on the first user gesture. `instance.toggleNarration()` programmatically.
- **Character** (`N` → Character…, or palette → Character…): an animated narrator in a stage corner whose lips sync to the narration — fully offline, no cloud service. Two render modes behind one overlay (`.decklight-character`, persisted per deck): **🎭 2D character** — a layered SVG bust (theme-aware clothing/backdrop, blink, idle sway) with one mouth group per Rhubarb shape (`A–H` + `X` rest); a 30 Hz loop maps `narrAudio.currentTime` onto a **viseme timeline** and shows the matching `[data-mouth]` group, so pause (`P`) and voice speed (`<`/`>`) sync for free. **🎥 Neural video** — a muted picture-in-picture `<video>` talking head (audio always comes from the narration element; muted video is immune to autoplay policy) generated by Wav2Lip or SadTalker on the presenter's own GPU, drift-corrected against the audio clock (±150 ms) and mirroring its play/pause/rate. Timelines and clips come from the **lipsync bridge** (`decklight lipsync`, default `http://127.0.0.1:8789`, override via `narration.character.bridgeUrl`; CORS-open, 127.0.0.1-only, disk-cached in `~/.cache/decklight/lipsync` keyed by audio+params hash): `GET /ping` reports which engines actually resolve (the picker greys out the rest), `POST /viseme?text=` (raw WAV body → timeline JSON v1: `{v, duration, cues: [{t, v}]}` — start-time cues, each shape holds until the next), `POST /video?engine=&portrait=` (raw WAV → muted faststart MP4; strictly serial GPU queue). In **live voice** mode the sentence is the unit here too: the lookahead buffer that keeps 10 sentences of audio warm hands each synthesized sentence's WAV to the bridge, so lip-sync data prefetches through the same window, workers, and promise-cache dedup as the voice — and playback NEVER waits on lip-sync (a late timeline lands mid-sentence; until then the **fallback** animates: `amplitude` (default) drives a coarse 4-shape mouth from a WebAudio analyser, `hide` shows the idle face). In **recorded** mode the overlay loads per-slide sidecars from the track's dir — `slide-NN.visemes.json` / `slide-NN.mp4`, generated by `tools/lipsync.mjs` (rhubarb + optional SadTalker/Wav2Lip batch, hash-incremental like voiceover.mjs) — preferring an inline `<script type="application/json" data-decklight-visemes="slide-NN">` block when present (`decklight bundle` inlines viseme JSONs; fetch is blocked on `file://`). `⇧V` exports `slide-NN.visemes.json` alongside each stitched WAV (same sentence cache, same silence gaps) so a recorded set is character-ready with zero extra synthesis. **Solo** (`N` → Character… → Solo, or palette → "Character solo"): the narrator takes the stage — the slide content, progress bar and slide number step aside (`visibility: hidden` on `.decklight-stage`, which the overlay is a sibling of) and the character centers, sized to the stage (`--character-solo-size`, default `min(74vh, 74vw)`). A talking-head slide with nothing else on it, without authoring one. Works with either render mode, persists per deck alongside `mode`, and is a *presentation* state, not a layout: the root's `decklight-solo` class is only ever set while the character is actually on screen, so turning the character off — or stopping the narration — can never leave a blank stage behind. Turning solo ON shows the character immediately (idling, blinking) rather than waiting for `V`. **Motion** (`decklight lipsync --veo`, SPEC PRESENTING): Wav2Lip repaints the lip region and leaves the rest of its source untouched — from a still photo that is a frozen stare with a moving mouth. With `--veo` the bridge animates each portrait ONCE through Veo image-to-video on Vertex AI (`veo-3.1-lite-generate-001` by default; 4/6/8s; `generateAudio: false` — the deck owns the voice, and it is the cheaper rate) and gives Wav2Lip that clip as its `--face`, so the head turns and blinks under the new mouth. The unit is the PORTRAIT, not the sentence: the player asks for video once per sentence through a 10-sentence lookahead, so a Veo call per sentence would be both unusably slow (~40s) and a runaway bill — instead each portrait's motion clip is bought on first use, deduped in flight, and cached on disk (keyed by portrait+model+seconds+prompt), so a deck of any length costs exactly one call per portrait, ever. Delete the cache entry to re-roll the performance. The clip is cropped square around the head (the overlay is a circle) and scaled to 640px (s3fd misses faces in a large frame). SadTalker is excluded — it generates its own head motion and wants a still. A refusal by Veo's person-generation filter surfaces as an error naming the cause, never an empty clip; a misconfigured `--veo` disables only itself and leaves visemes and still-portrait video working. It is the only part of the bridge that leaves the machine, so it is opt-in, and `decklight author` passes it straight through. Config (`narration.character`, all optional): `mode: 'off'|'viseme'|'video'` (picker overrides, persisted), `solo: boolean` (default false; picker overrides, persisted), `bridgeUrl`, `position: 'br'|'bl'|'tr'|'tl'`, `size` (design px, default 220), `svg` (custom art: inline markup, `'#id'` ref, or URL — contract: `[data-mouth="A"…"X"]` groups; optional `[data-eyelid]`/`[data-idle]` get the blink/sway), `sprites: {A: url, …}` (image frames instead), `engine`/`portrait` (video mode; Wav2Lip suits live — static pose, seamless per-sentence cuts; SadTalker suits batch clips), `fallback: 'amplitude'|'hide'`. Bundles: viseme JSONs inline (1–4 KB/slide); per-slide MP4s stay external with a CLI notice — video cannot inline sanely.
- **Command palette**: `/` opens a Claude-style palette — every command with its shortcut, type-to-filter, `Enter` runs, `Esc` clears then closes. Argument commands (Theme…, Font…, Narration voice…, Module…, Find slide…) drill into their pickers; contextual commands appear only when applicable (Save generated theme, Browse marketplace themes, the Configure ⟨engine⟩ wizard rows, Module). Inline arguments work: `goto 27` — or just typing `27` — surfaces a “Go to slide 27 / N” row (clamped to the deck), and selecting the bare “Go to slide…” command keeps the palette open with `goto ` prefilled. Text matching no command falls back to a “Search slides for …” row that opens the finder with the query prefilled.
- **Slide finder**: reached from the palette (`/` → Enter, or the search fallback) — a find-a-slide overlay with the picker's anatomy — a query bar and result list on the left, a live preview of the selected slide on the right. Typing filters as an AND over the query's words against each slide's text; slides whose **title** contains every word rank first, body-only matches follow, and every match is listed as `<slide number> · <title>` (slides without a heading fall back to their leading text). `↑/↓`/hover browse (the preview swaps live), `Enter`/click jumps to the slide, `Backspace` edits, `Esc` clears the query then closes. The preview reuses the picker's lazy embedded-deck mechanism — the iframe boots once (carrying the active theme, generated/custom included via `?gen=`), then selections postMessage `{__decklightPreview: {goto: [slide, step]}}` into it; no reload per candidate.
- **Playlist (multi-deck navigation)**: `Decklight.init({ playlist: { modules: [{title, href}…], index: n } })`. Advancing past the last build of the last slide navigates to the next module (`href#/1/0`); reversing before slide 1 goes to the previous module's end (`href#/999/999` — oversized hashes clamp to the last slide/step). The other modules appear as rows in the **slide finder** (`G`) — marked `▸ <title> — module`, previewed like any slide, and `Enter` loads that file; the slide-number chrome shows the module title and opens the finder on click. There is no separate module menu: "go somewhere" is one question with one answer. Works on `file://` with relative hrefs; embedded instances never chain.
- **Restore a version** (`R`, author mode): an overlay listing the deck's git history — short hash, subject, age, newest first — with the selected commit's deck **rendered live** in the preview pane, because a hash and a subject are not enough to recognise the version you meant. `↑`/`↓` browse (wrap-around, debounced so holding a key does not fire a page load per row), `⏎` restores, `Esc` cancels, a backdrop click closes; only one overlay is up at a time, like every other. Restoring goes through the same non-destructive path as `decklight restore` — a **new commit on top**, never a rewrite — and lands on the undo stack, so `Z` takes a restore back like any other edit. This is the git-level sibling of `Z`/`⇧Z`: `Z` takes back a keystroke, `R` takes back a session. Without an edit server the keystroke says so and does nothing; embedded preview instances and `?print` never render it. `instance.restore = { open, close, list }` programmatically.
- **Speaker view**: `S` opens a popup (synced via BroadcastChannel): current + next slide thumbnails, notes (with `⟨CLICK⟩` markers highlighted as the matching build lands), elapsed timer, build step list (provider labels). **Rehearse mode**: pressing `S` again (in the deck or in the popup; the header badge also toggles) swaps the prose notes for the slide's `aside.rehearse` cue cards (DECK_ANATOMY) — rendered large and bold, one cue per segment, same said/now/next highlighting. Slides without rehearse notes fall back to the full prose. `S` in the deck only opens a new popup when none is connected; while one is open it toggles the mode. **Phone remote**: when the deck is being played by `decklight present --remote` (below), the speaker view also shows a QR of the controller URL — click it to enlarge for scanning across a lectern. It appears only when a remote is actually on, since without it there is no LAN URL to encode.
- **Phone remote** (`decklight present <deck.html> --remote`): the presenting server also listens on the LAN and serves `GET /remote` — a self-contained controller page with prev/next and a live "slide x/N" readout, no external asset of any kind (a phone is off-loopback, so anything it fetched from elsewhere would be a hole). A tap is relayed as a named `remote` event on the SSE stream the deck already holds, and the deck POSTs its position back, so the readout tracks the deck however it moved (phone, keyboard, or click). `POST /remote/pos` is the deck→phones direction and **accepts only loopback callers**: the deck is the one thing that knows the position, it reports from this machine, and a phone — or anyone who obtained the QR token — posting a fabricated `{i,n}` would desync the readout every other phone shows. `--remote` widens the **listener** and nothing else: off this machine **only** `/remote/*` answers, and only with the per-run random token the printed URL and its QR embed — the deck itself and every file beside it stay unreachable from the LAN either way. One exported classifier decides it, `allowRemote(req, token)`, and `PRESENT#REMOTE` is why it lives on this server: the remote used to sit on the **author** server, so a clicker meant running `/edit/notes`, `/edit/layout` and `/edit/agent` on the LAN during a talk you were not watching. The QR is generated server-side with no dependencies, and a deck that never uses a remote grows by zero bytes.
- **Print/PDF**: `?print` renders all slides sequentially, every build complete, terminal casts fully expanded, one slide per page (`@media print` CSS). No JS needed after layout. Background media (DECK_ANATOMY) prints as a still: no `<video>` element is ever created in print — the slide's `data-background-poster` renders as the background image instead. Two handout variants restructure the same fully-built render onto portrait pages (one `.print-page` per sheet): `?print=handout` groups slides three to a page, each scaled slide beside a column of ruled note-taking lines (page count = ⌈N/3⌉); `?print=notes` gives one page per slide with that slide's speaker notes rendered underneath — slides without notes keep their page with an empty notes block. **Page count equals slide count** (⌈N/3⌉ for handout): the page box has no margin, so the document has none either — the UA's default body margin would push the last slide's final pixels past the last page box and emit a blank final sheet. **`decklight pdf <deck.html>`** writes that render to a file without a print dialog: headless Chrome over the deck's own `?print`, one slide per 1280×720 page (960×540 pt), `-o` for the path, `--theme` to export in another theme (it rides `?theme=`), `--wait` for decks that need longer to settle. Slides the overflow guardrail flagged are named on stderr by slide number — the PDF is still written, because a clipped slide is worth knowing about, not worth refusing. No Chrome, or no file produced, exits non-zero rather than leaving a silent empty PDF.
- **Video export**: `decklight video deck.html -o deck.mp4` (tools/video.mjs) renders the deck to one narrated mp4 — a full-resolution still per FRAME (each a one-shot headless Chrome against `#/<n>/<step>`, the shot.mjs mechanism), muxed with the audio into a single file. A **narrated** slide is one still, fully built, held for the duration of its audio plus a 0.4s tail. A **silent** slide BUILDS as it goes: one still per build step, then the finished slide. How far each slide builds is asked of the deck itself in one extra load — the grouping is the runtime's (`src/core/builds.js`), and a second counter written in Node would be a copy that drifts; a deck that does not answer falls back to one fully-built still per slide, and every slide's final frame is captured at the oversized `#/<n>/999` regardless, so a miscount can shorten a build-up but can never lose the finished slide. Both render tools (video and `tools/shot.mjs`) capture the deck **served over `http://127.0.0.1` under the `PRESENT` CSP** — the same loopback core `present` uses (`serveForRender`) — never over `file://` with `--allow-file-access-from-files`: that flag lets an unvetted deck's own JavaScript read any local file it can name and exfiltrate it, and these tools run on decks nobody has audited (a repro deck off an issue, or one screenshot before it is presented). As with `present`, the served root is the current directory and the deck must sit inside it, so its relative assets resolve as URLs and a read cannot escape the served tree. Narration resolves `--narration <dir>` → `<deckdir>/voiceover/manifest.json` (the artifact tools/voiceover.mjs writes) → a fully silent deck; slides without narration hold `--hold` seconds (default 5, per-slide override `data-video-hold="8"` on the section) over a silent audio segment (anullsrc), so the concatenated audio track stays continuous. **Every frame of a silent slide holds that long, builds included**, so a build lands at the pace the rest of the deck moves at and a deck gets longer the more it builds; `--build-hold <s>` paces the build-up frames alone, for builds quicker (or slower) than the slides around them. Splitting the hold across a slide's frames instead — fixing the deck's length — reads far too fast: the more a slide has to say, the less time each beat of it gets, which is backwards. Flags: `-o/--out`, `--narration`, `--size 1280x720`, `--fps 30`, `--hold`, `--build-hold`, `--theme <name>`, `--slides a-b`, `--voiceover` (runs the voiceover batch first). Needs ffmpeg + ffprobe — missing tools are a hard, friendly error naming what to install (the voiceover encoder-detection policy). Honest MVP limits: frames are stills, so the **character overlay appears but frozen** and terminals render fully expanded rather than typing (animated capture needs a CDP screencast — a named Node ≥22 follow-up), and a build **cuts rather than animating** (the frame is a still of each step, not a capture of the transition between them). A **narrated** slide builds too where its notes say so: `⟨CLICK⟩` segments the speaker notes, `tools/voiceover.mjs` synthesises one audio file per segment (same characters, so the same cost — the per-slide `slide-NN.m4a` is *concatenated* from them, and every existing consumer of it is untouched), and segment k narrates build step k for that segment's ffprobe'd duration. This is the recorded mirror of a rule that already ships: `src/core/narration.js` speaks live narration the same way, and captions, rehearse mode and the notes editor share the segmentation. A marker count that does not match the build count **warns naming the slide and renders the old way** — a wrong sync baked into an mp4 is worse than no sync — and a manifest written before this renders exactly as it did.
- **Overflow guardrail**: content that exceeds the slide flex-shrinks into a scroll box and reads as clipped. The engine warns (`console.warn`) and marks the section with a `data-overflow` attribute — on each slide activation, and for the whole deck in `?print`. The mark is **live, not latched**: layout is not final when a slide activates (a webfont resolves, an image decodes, a chart or terminal mounts), so the active slide is watched and the check re-runs whenever its content changes size or shape. It never waits on a frame — headless renders run out of frames once the page goes idle, and an unmeasured slide is indistinguishable from a clean one. The warning fires on the way in only, so one clipped slide is one line, not one per re-check — so authoring agents can assert `[data-overflow]` is absent in their headless verification (`decklight pdf` does this for a whole deck in one pass and names the offending slides). Overflow always goes **down**, never up: a slide centers its content with `safe center`, so content taller than the slide falls back to top alignment instead of overflowing symmetrically. Plain centering would push half the excess out of the top of the box, through the padding a pinned title reserves for itself, and render the first content element on top of the title.
- **Pinned titles**: `pinTitles: true | false | <px>` keeps slide titles at one vertical position instead of drifting with content height. **On by default** (`true`); `pinTitles: false` restores the drift-with-content centering deck-wide. `true` pins at **99px** from the stage top (design coordinates — the natural title position of the course's "The Single-Agent Limit" diagram slide, the chosen reference); a number pins at that Y. The leading `h1`/`h2` of each **pinnable** section is absolutely positioned at the pin Y; the section reserves `pin Y + measured title height + 18px` of top padding so the remaining content centers below. Pinnable = has a leading `h1`/`h2` AND content beyond it (`ul, ol, svg, pre, table, .terminal, img, .columns` outside the notes) — title cards and quote/statement slides stay centered. Per-slide: `data-pin` forces a pin (even when the config is off), `data-pin="none"` opts out, `data-pin="<px>"` overrides the Y. Titles are re-measured on `sync()` and when webfonts finish loading; print uses the same layout. A detected **subtitle** (DECK_ANATOMY) joins the pinned header block — absolutely positioned directly beneath the title (6px gap) and included in the reserved padding, so content centers below title + subtitle.
- **Terminal footprint**: a terminal's screen area has a stable size — a **16:9 aspect floor** (width-driven) clamped by the `data-rows` cap as the max — so the box arrives full-size before anything plays and never resizes as steps stream in (output beyond the box scrolls). Real print expands casts fully.
- `Decklight.init(config)` options: `transition`, `hash` (default true), `controls` (default true: prev/next chevrons; the progress bar is the `H` toggle, above), `slideNumber` (default `false | 'n' | 'n/N'`), `width/height` design resolution (default 1280×720, scaled to fit), `themes` (array of theme names for the picker/cycle; default: all shipped themes), `playlist` (multi-deck navigation, above), `pinTitles` (pinned titles, above), `concepts` (diagram concept-color pinning, SVG_DIAGRAMS), `logo` (brand mark, above).
- **Single-file bundling**: `decklight bundle <deck.html> [-o out.html] [--themes current|all|a,b,…]` flattens a deck into one self-contained HTML — runtime and structure CSS inlined, selected themes embedded as inline-theme blocks, `data-cast` terminals converted to `data-cast-inline`, images (`<img src>`, `data-background-image`, `data-background-poster`) to data: URIs. Background videos stay external with a notice — the same posture as character MP4s. Playlist links can't resolve inside a single file; the CLI lists them as a notice.
- **Runtime upgrade**: `decklight upgrade <deck.html> [--dry-run]` brings a self-contained deck's inlined runtime up to the installed package: the runtime css + js blocks are swapped for the installed `dist/` builds and re-marked `data-decklight-runtime="css|js"` (decks from before the marker are recognized too — the first head `<style>` carrying the structural css, and the `<script>` defining `Decklight` before the `Decklight.init` call), and `<style data-theme>` blocks refresh from the installed `themes/`, preserving which one is active. A block naming a theme not in `themes/` is always kept as-is, with a warning that says which of two things this is (MARKETPLACE.md `OPEN` 1): carrying `data-theme-added` (`theme add`/Browse's own marker, THEME_DISTRIBUTION) means the theme was never decklight's to begin with, so there is no "upstream" copy to refresh it from — `upgrade` never fetches one, the same registered-not-fetched posture `MARKETPLACE_REGISTRY` already holds elsewhere, and a theme carries no version to pin or refuse a stale one against (deliberate — THEMING); without the marker, it is a theme decklight's own shipped set has since dropped. Everything the author wrote survives byte-for-byte. In place, `<deck>.html.bak` written first; `--dry-run` prints the plan and touches nothing; a second run reports "already current". Non-decklight files (no `Decklight.init`) and merged multi-module bundles are refused. `init` marks the blocks it writes with the same attribute.
- **Merged single-file presentation**: `decklight bundle <deck.html> --all [--title "…"]` follows the deck's playlist and concatenates EVERY module's sections into one deck (explicit form: `decklight bundle a.html b.html … -o one.html`). Each module's first section is marked `data-module="<title>"`; embedded cast ids are prefixed per module to stay unique; relative asset refs are rebased onto the first deck's directory; the per-module `playlist` config is stripped. **In-file module navigation**: `data-module` sections are ordinary slides, so the finder (`G`) already finds them by title or body text and `goto()`s them with no page load; the chrome module tag shows the module of the current slide (nearest preceding marker).
- **Publish (GitHub Pages)**: `decklight publish <deck.html> [--branch gh-pages] [--remote origin] [--no-bundle] [--path <subdir>]` — bundles the deck (single-file, via the bundler above; `--no-bundle` pushes the file as-is) to `index.html` + `.nojekyll` and pushes them to the branch on the remote, then prints the site URL derived from the remote URL: `git@github.com:owner/repo.git` and `https://github.com/owner/repo(.git)` both → `https://owner.github.io/repo/`, an `owner.github.io` repo → `https://owner.github.io/`, and a non-GitHub remote just prints the pushed ref. The commit is built with git plumbing (`hash-object → mktree → commit-tree → push <sha>:refs/heads/<branch>`), so the author's working tree, index, and checked-out branch are never touched. The first publish creates the branch as an orphan and prints where to enable Pages in the repo Settings; every later publish fetches the remote branch and parents on it — history, not force-push — and the sign-off in the commit message comes from `git config user.name/user.email`. `--path <subdir>` publishes under a subdirectory, preserving whatever else the branch already carries. Zero new dependencies: plain git.
- **Publish targets** (`--target gh-pages|netlify|vercel`, default `gh-pages`; MARKETPLACE.md ENGINES): where the bundled page goes is a choice, not only a place. gh-pages — the bullet above, unchanged — needs git auth and no credential, so it stays core. Netlify and Vercel need a token, so they follow the rule anything on the authoring path needing a credential becomes a marketplace engine behind a core affordance: the affordance is `--target`, and each declares a real `ENGINES#WIZARD` schema (`cli/wizard.mjs` `validateSchema`), so a missing or malformed answer is refused by the exact validation a browser-wizard engine goes through, not a bespoke check. **The token is never a terminal prompt and never the browser wizard** — `publish` is a one-shot, often-headless command (CI has no browser to paste a key into, and no `/edit/wizard` to post it to, since that endpoint is served by the author server, which `publish` never starts) — so it is read from the **provider's own CLI env var** (`NETLIFY_AUTH_TOKEN` + `NETLIFY_SITE_ID`, `VERCEL_TOKEN` + `VERCEL_PROJECT` + optional `VERCEL_TEAM_ID`), matching the ElevenLabs precedent (`tools/elevenlabs-tts.mjs`): a key is not boring, so the environment remembers it and it is never written to `~/.decklight/`. `--branch`/`--remote` are refused alongside a non-gh-pages target rather than silently ignored, since they would otherwise appear to do something. Netlify deploys as a single zip (`cli/zip.mjs`, the `skills --pack` container plumbing); Vercel takes the same files inline as base64 in one JSON POST, per its own API shape. **S3 is deliberately not a target yet** — the one provider needing request signing (SigV4) rather than a bearer token, and a hand-rolled signer nobody can exercise against a real bucket in CI is a correctness claim not worth shipping unverified; Netlify and Vercel are what prove the shape generalizes (MARKETPLACE.md `OPEN`).

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
instance.toggleElementEdit()                   // E programmatically; author mode only
instance.toggleNarration()                     // V programmatically
instance.annotate                              // ink: .toggle() / .laser() / .clear() / .stroke(points)
instance.showWelcome()                         // reopen the first-run welcome card
instance.tips                                  // .show() / .reset() / .set(on) / .status() → { tipsOn, tipsLeft }
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
versions for code, none for data — see `UNIT_COMPAT`). The one exception is a reference-only kind,
which carries no `source` because it carries nothing at all — see `VOICE_UNITS`. A malformed manifest is refused **naming the
line and the field** (`line 7: entries[1].type — missing`), never with a stack
trace — a typo in somebody's catalog is not an internal error.

**A kind may declare extra required fields, and an unknown kind is accepted
rather than refused.** An `importer` entry must carry `extensions` — the file
extensions its adapter reads — because that is what lets `decklight import
talk.marp` name the adapter **from the cache, offline**; an adapter whose
extensions were only discoverable by installing it could never be offered at
the moment it is needed. A `type` this decklight does not know is *not* an
error: a catalog is a file someone else wrote, quite possibly against a newer
version, and refusing the whole manifest over one unrecognised kind would make
every catalog un-addable the day it grows an entry. `marketplace list` groups
entries by kind and prints the install command for each, so an unknown kind
reads as "not yet" rather than as a typo — the two must never look alike.

`decklight marketplace add <owner/repo | git url | path>` reads the manifest at
the source's root and registers the catalog; `list`, `update <name>` and
`remove <name>` complete the roster. State lives under `~/.decklight/`
(`DECKLIGHT_HOME` overrides): one registry file, `marketplaces.json`, plus a
`marketplaces/` directory holding, per marketplace, its cached manifest
(`<name>.json`) and the checkout that manifest came with (`<name>/`) — the
config home the engine wizard (MARKETPLACE.md ENGINES) shares.

**A remote marketplace is read by cloning it** (MARKETPLACE.md
`MARKETPLACES#CLONE`), never by fetching one file at a time off a raw-content
host, and `owner/repo` is shorthand for that clone rather than for a URL. Three
things follow, and each was a bug before it did. A clone uses **the caller's own
git credentials**, so a marketplace in a private repo works exactly as `git
clone` does in that terminal — a credential helper for HTTPS (`gh auth
setup-git`, the macOS Keychain), or the SSH form of the URL; an anonymous fetch
had none, so a private catalog could register and then 404 on every install.
The manifest and every entry's bytes come from **one commit**, recorded in the
registry and printed by `list`, where fetching each artifact separately at
`HEAD` could produce an install matching no single commit of the marketplace.
And because the clone is kept — `~/.decklight/marketplaces/<name>/`, its `.git`
dropped, replaced wholesale by the next `update` and removed by `remove` —
**installing an entry reads the disk**, not the network. A local-path
marketplace keeps no checkout: its own directory already is one. An entry whose
`source` is an absolute `https://` URL (a gist, a release asset) is still
fetched as written.

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

**The unit library** (`UNITS#REST`) is where the installable kinds land:
`~/.decklight/templates/`, `.../skills/`, `.../importers/`, `.../voices/`,
beside the `plugins/` that `PRESENT#PLUGINS` writes. One seam installs all of
them (`decklight template|importer|voice add`, `decklight skills add`), and
each is used by the command that needs it. **`decklight init --from <name>` scaffolds from
an installed template** — replacing only its `<title>` and first `<h1>`, so a
template is a deck and not a program — and a name that is not installed is met
with the install command rather than a download: `init` is the first command
anyone runs, and it does not reach the network. A marketplace skill installs
into the library and therefore sits **alongside** the authoring skill
`decklight skills` writes into a project, never replacing it. An import adapter
is **offered at the point of failure** — `decklight import talk.marp` names the
adapter that reads `.marp` and how to get it, which is the ENGINES pattern
(offer at the moment of need) rather than a setup step nobody performs in
advance. Installing an adapter does not yet make it *run*: executing a
marketplace module is `EXTENSIONS#TRANSFORMS`, and until that lands `import`
says so plainly instead of failing in a way that reads like a bug.

### UNIT_COMPAT — Compat for code-carrying units: an API version, not an engine version

A build-time transform (and, later, an executed import adapter) is Node code,
so its catalog entry declares a version — unlike a theme or a voice, which
carry none. What that version is checked *against* is deliberately **not**
decklight's own package version:

```json
{ "name": "grammar-check", "type": "transform", "source": "./grammar.mjs", "apiVersion": 1 }
```

**Why not decklight's version.** `src/core/engine.js` has been split apart
repeatedly — four feature modules pulled out in one PR alone — without any of
those reorganisations ever being a promise to anyone outside the repo. Pinning
a transform's compatibility to decklight's package version would tie it to
that same internal churn: a patch release could break every installed
transform for a reason the transform never touched.

**The alternative:** `apiVersion` names a version of the transform *invocation
contract* alone — the narrow "HTML in, HTML out" calling convention
`EXTENSIONS#TRANSFORMS` declares — and that number moves the way
`CAST_FORMAT`'s `decklightCast` does: **additive only**, bumped only when the
calling convention itself would break an existing transform, never for an
internal reorganisation elsewhere in the codebase. A transform declares the
lowest contract version it needs; decklight is compatible with anything at or
below its own `TRANSFORM_API_VERSION` (`cli/marketplace.mjs`), because nothing
additive-only ever removes what an older transform relied on.

**Validated for shape, not for currency.** `apiVersion` must be a positive
integer — that is checked the moment a catalog is registered (`marketplace
add`/`update`), by the same `ENTRY_SHAPES` mechanism that requires an
`importer`'s `extensions`. It is never refused merely for naming a version
ahead of what this decklight currently implements: a catalog is a file someone
else wrote, quite possibly against a newer decklight, and the same reasoning
that leaves an unrecognised `type` accepted rather than refused applies here
too. Whether a *particular* transform can actually run on *this* decklight is
answered by the loader (`EXTENSIONS#LOADER`, `cli/loader.mjs`) — this section
only settled what it checks against; running an installed import adapter
(`EXTENSIONS#ADAPTEREXEC`) still owes the same question on that surface.

### UNIT_PINNING — Code-carrying units install pinned, or not at all

A `transform` or `importer` entry carries the SHA-256 of its module file's
bytes — lowercase hex, exactly as `sha256sum` prints it:

```json
{ "name": "grammar-check", "type": "transform", "source": "./grammar.mjs",
  "apiVersion": 1, "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }
```

**Why the pin exists.** An entry's relative `source` resolves against the
marketplace's checkout, cloned at whatever the default branch pointed to when
`add`/`update` ran (`resolveSource`; no branch name is guessed at) — so the
bytes an install writes are whatever the file said at that moment, not
whatever it said when the marketplace admitted the entry (`EXTENSIONS_CHECK`).
Cloning closed the narrower gap of manifest and artifact disagreeing with each
other; it cannot close this one, which is between the admission and the
install. For a theme that gap is closed by `theme add` re-running
the entire THEMING contract at install; for Node code the loader runs
unsandboxed at author privilege (`EXTENSIONS_TRANSFORMS`,
`EXTENSIONS_ADAPTERS`) there is no equivalent re-check — the digest is what
makes the code that installs the code that was screened.

**A content digest, not a commit SHA.** A commit pin only reaches sources a
host can serve by commit, and verifying it means trusting that host; a digest
of the bytes holds identically for a raw URL, a git URL and a local
directory, and holds against the math rather than the server. `decklight
extension check` prints the digest on a pass, so the gate that admits a
submission also emits the pin its catalog entry carries; `sha256sum
<file>` produces the same value.

**Enforced at install, with two named refusals** (`cli/units.mjs`).
`decklight transform add` / `importer add` refuse a pinned kind's entry that
carries no `sha256` — *before* anything is fetched, since without a pin there
is no fact to hold the fetched bytes to — and refuse a fetched module whose
digest does not match, *before* anything is written, naming both digests. A
mismatch means the file changed since the catalog was cached: possibly a
legitimate re-pin (`marketplace update <name>` and try again), possibly the
exact substitution the pin exists to stop — either way nothing lands in the
library, the same fetch-first-write-second rule every other refusal there
keeps.

**Validated for shape when present, required only at install.** The same
split `apiVersion` already made (`UNIT_COMPAT`): a *malformed* `sha256` fails
`marketplace add` naming the line and the field, but an *absent* one does not
invalidate the manifest — refusing a whole catalog over one unpinned
transform would cost its theme entries too, the blast-radius reasoning that
already leaves an unknown `type` accepted. The refusal lands at the one
moment the risk does: installing the executable entry.

**What is deliberately not pinned.** Data kinds (themes, templates, skills)
install unpinned — nothing in them executes, and a theme re-passes its whole
contract at install. A unit placed in the library by hand still runs
(`EXTENSIONS#LOADER`'s decision, unchanged): the pin governs what an
*install* may write into the library, and the trust model for *running* what
is there stays `EXTENSIONS_TRANSFORMS`'s — the installer is the risk-bearer.

### EXTENSIONS_TRANSFORMS — Build-time transforms: the v1 contract

A transform is a single file, `transform.mjs`, exporting one function:

```js
export default async function transform(html, opts) {
  return html; // HTML in, HTML out (MARKETPLACE.md EXTENSIONS) — nothing else crosses
}
```

- **`html` is the deck's own source** — the file as the author wrote it,
  *before* `bundle` inlines themes, images, casts or narration. A transform
  compiling `<pre class="mermaid">…</pre>` into inline SVG needs the markup
  the author wrote, not decklight's own runtime already spliced in; running
  before that inlining also keeps a transform's test fixture small — a
  two-line HTML snippet, not a full bundled deck — and keeps decklight's own
  inlining regexes untouched by whatever a transform's output contains.
- **`opts` is reserved and empty in v1.** Nothing populates it yet. A later
  version MAY add a field (deck title, target theme, …), and doing so is an
  *additive* change under `UNIT_COMPAT` — it does not bump
  `TRANSFORM_API_VERSION`, because an existing transform that ignores an
  unrecognised field keeps working exactly as it did before. Only a change
  that would break an existing transform's assumptions bumps the version.
- **Loaded by dynamic `import()`, in the same process as `bundle`/`import` —
  no subprocess, no VM sandbox.** This is not a gap: `MARKETPLACE.md
  EXTENSIONS` already decided the trust model for build-time code — the
  installer is the risk-bearer, the same defensible model Claude's own plugin
  marketplace uses — so isolating a transform from the process that invoked
  it would defend against a threat this design already accepted. Contrast
  `PRESENT#PLUGINS`, which sandboxes because *that* code runs on a
  presenter's machine at a stranger's request — a different actor, a
  different risk.
- **The return value must be a string**, or a thrown/rejected value the
  *loader* reports by naming the transform — a transform has no other
  contract obligation. Turning a throw into a clean refusal rather than a raw
  stack trace is the loader's job (`EXTENSIONS#LOADER`, `cli/loader.mjs`,
  called from `bundle --transform <name>`), the same UX every other
  unit-installing surface in this codebase already gives.

This is the contract `apiVersion` (`UNIT_COMPAT`) names a version *of*.
Freezing it here, ahead of the loader that will call it, is deliberate: the
loader is comparatively mechanical once this is fixed, and fixing it after
the loader existed would mean the first version number was never actually
pinned to anything.

### EXTENSIONS_CHECK — The marketplace admission gate for build-time code

`decklight extension check <file> [--type transform]` (`--type transform` is
both the default and, in v1, the only kind implemented) validates ONE
transform source file and reports 0 or 1, the same shape `theme check`
already gives. It is not part of `bundle`, `import` or `publish` — those run
an already-*installed*, catalog-backed unit (`EXTENSIONS#LOADER`) and never
re-check it. `extension check` instead runs against a bare FILE, because its
job is admitting an entry to a marketplace catalog in the first place: a
marketplace repo's own CI runs it on every PR that adds or updates a
`transform` entry, and a failing check blocks that PR — which is what
"failure blocks publish" means (MARKETPLACE.md `EXTENSIONS#CHECK`):
publishing the *extension*, not `decklight publish`ing a deck.

Three phases, checking three different things:

- **Lint the source text — advisory, not a boundary.** Refused if the file
  contains `fetch(`, `eval(`, `XMLHttpRequest`, or a dynamic `import(`,
  anywhere — a shallow source-text scan, the same kind `PRESENT#PLUGINS`
  already runs on a presenter plugin's source. It catches the honest mistake
  and states the bar in a sentence, and that is ALL it does: a static
  `import { execSync } from 'node:child_process'`, a `new Function('return
  fetch')()`, a `globalThis['fet' + 'ch']` all pass a regex unmatched, and
  no source-text scan closes that class. What constrains the submission
  during the check is the process boundary below; what constrains it after
  admission is nothing — an installed transform runs as trusted, unsandboxed
  Node (`EXTENSIONS_TRANSFORMS`), because the trust model for build-time
  code is that the installer bears the risk (MARKETPLACE.md `EXTENSIONS`).
  Admission screens; it does not absolve.
- **The submission only ever executes behind a process boundary.** The
  checker itself never `import()`s the checked file — a marketplace's CI
  would be executing a stranger's code at its own privilege *before*
  deciding whether to admit it. The transform runs in a SEPARATE Node
  process under the permission model (`--permission`, or
  `--experimental-permission` back to the `engines` floor of Node 20;
  a Node with neither is a named refusal, never a silent unsandboxed run):
  filesystem reads limited to decklight's own package and the submitted
  file's directory, no filesystem writes, no child processes, no workers, no
  native addons; a REPLACED environment (the fixture is the only variable
  that crosses, so a CI runner's secrets never enter the child); a temp
  working directory; and its own 15s wall-clock kill, because a transform
  that never returns must become a refusal, not a hang. Stated plainly,
  what the boundary does NOT cover: Node's permission model does not
  restrict the network, so a hostile submission can still phone home during
  the check — the boundary protects the checking machine's files, processes
  and environment, not its network egress.
- **A headless load of the OUTPUT, not the source.** The transform is run
  against ONE small fixture this command owns — RANDOMISED per check, a
  fresh nonce in its title, heading and body, so a submission cannot
  recognise the fixture and behave only while being checked — never the
  submitter's own deck: proving the CONTRACT, not "does it handle some
  particular author's markup" (the same "a small fixture beats a full
  bundled deck" reasoning `EXTENSIONS_TRANSFORMS` already uses to justify
  testing against the pre-`bundle` source). The output is then rendered
  headlessly and refused if it contains a `<script>` block OR an inline
  event handler (an `on…=` attribute) — the second is exactly as executable
  as the first, just waiting for a click, and a `<script>`-only grep missed
  it entirely. Both refuse for the same reason: "build-time transforms
  produce output, not code; nothing executable travels" (MARKETPLACE.md
  `EXTENSIONS`, SUPERSEDED) is the one invariant this phase can actually
  prove a given transform honors, rather than merely being asked to.
  `apiVersion` currency plays no part here: that is `EXTENSIONS#LOADER`'s
  question at USE time, on an installed unit, not this command's question at
  ADMISSION time, on a bare file.

What this gate is, honestly: a screen, not a proof. Code that behaves during
one check can behave differently once installed, and no admission-time
analysis of Turing-complete code closes that gap — the randomised fixture
and the scrubbed, temp-cwd child merely remove the cheap tells a submission
could key on. The load-bearing decisions remain the catalog's digest pin
(`UNIT_PINNING`) and the trust model (`EXTENSIONS`: the installer
bears the risk); this command exists so that the obvious failures never
reach either.

Needs a real browser to run the last phase — the same Chrome dependency
`npm run verify`'s render harnesses already carry — and answers the same way
they already do when Chrome is absent: a named refusal, never a silent pass.

**Both executions carry a hard wall-clock kill (15s each), and the headless
load's is separate from `--virtual-time-budget`.** That flag bounds Chrome's
own clock, not the real one: a synchronous `alert()`/`confirm()`/`prompt()`
in the OUTPUT opens a native dialog that blocks the render loop outside
virtual time entirely, and an infinite loop blocks it the same way —
measured directly, not a theoretical concern. Every other transform failure
this section refuses is a *string* found in an *output*; a hang is the one
shape that would otherwise have no output to refuse, and this command's
whole premise is running code nobody has vetted yet — so a submission that
never returns, in its own run or in its output's load, has to become a
refusal too, not an unbounded hang in whatever is running the check (a
marketplace's own CI).

### EXTENSIONS_ADAPTERS — Import adapters: the v1 contract, and running one

An import adapter is a single file, `importer.mjs`, exporting one function —
the same shape `EXTENSIONS_TRANSFORMS` gives a build-time transform, with the
one difference its different input forces:

```js
export default async function importAdapter(bytes, opts) {
  return html; // bytes in, HTML out — the deck's <section> markup, nothing else crosses
}
```

- **`bytes` is the source file's raw contents** (a `Buffer`, read by `cli/
  import.mjs` before the adapter ever runs) — never a path, so an adapter's
  contract needs no filesystem access of its own and stays as pure as a
  transform's `html in, html out`. What the built-in importer calls "a
  CONTENT importer, not a pixel renderer" (`DECK_IMPORT`) applies here too:
  the adapter owns turning its format into markup, and decklight themes it
  same as anything else.
- **The return value is the deck's section markup — one HTML string**, not
  the `{ sections, report }` pair `cli/import.mjs`'s own PowerPoint path uses
  internally. Requiring a third-party adapter to reproduce that pair would
  leak an implementation detail of one specific importer into a contract
  every future adapter has to match; a single string is the same minimal
  surface `EXTENSIONS_TRANSFORMS` chose for the same reason. Per-slide drop
  reporting (`DECK_IMPORT`'s "every drop is reported with its slide number")
  is therefore not part of the v1 adapter contract — an adapter that wants it
  is free to `console.error` its own, since it runs at the same trust level
  as anything else in `EXTENSIONS`.
- **`opts` is reserved and empty in v1**, for the identical reason
  `EXTENSIONS_TRANSFORMS`'s is: a later version may add a field, and doing so
  is *additive* under `UNIT_COMPAT` rather than a version bump, because an
  adapter that ignores an unrecognised field keeps working exactly as before.
- **Loaded by dynamic `import()`, in the same process as `decklight import` —
  no subprocess, no VM sandbox.** Identical reasoning to
  `EXTENSIONS_TRANSFORMS`: an import adapter is Node code at author
  privilege, the trust model `MARKETPLACE.md EXTENSIONS` already settled
  (the installer is the risk-bearer), and isolating it from the process that
  invoked it would defend against a threat this design already accepted.
- **An independent `apiVersion`, `IMPORTER_API_VERSION` — not
  `TRANSFORM_API_VERSION`.** The two are different calling conventions
  (`html, opts → html` versus `bytes, opts → html`) that will each change on
  their own schedule; sharing one counter would bump every installed
  transform's compatibility number the day the *importer* contract grew a
  field it never asked for. Both move the same way `UNIT_COMPAT` already
  established — additive-only, bumped only when that ONE contract would
  break an existing unit — they just count separately.
- **The return value must be a string**, or a thrown/rejected value the
  loader reports by naming the adapter — the same clean, never-a-raw-stack
  collapse `EXTENSIONS#LOADER` already gives a transform's failures
  (`cli/loader.mjs`'s `runImporterAt`, called from `cli/import.mjs` once
  `sourceKind` finds no built-in reader for the file but a cached catalog
  entry names an installed adapter for its extension).

`import` still says exactly what it always said when no adapter is known, or
when one is known but not installed (`decklight importer add <name>`); only
an INSTALLED adapter's extension now actually runs, rather than reporting
that it does not yet (`EXTENSIONS#ADAPTEREXEC`, MARKETPLACE.md).

### ENGINE_UNITS — Speech engines: the v1 contract, and installing one

Six engines ship in core (`PRESENTING`: gemini, chirp, piper, elevenlabs, say,
sapi) and are **not units** — they need no marketplace, no library and no
catalog, so a machine with nothing registered reaches its own voice exactly as
it always did. A seventh is whatever you installed. An engine unit is a single
file, `engine.mjs`, exporting a **factory** rather than the `(input, opts) →
string` pass the other two code-carrying kinds export:

```js
export default function createEngine(opts) {
  return {
    name, voices,                       // the roster the N picker offers
    stylable,                           // may the tone step be shown for it?
    synth(text, { voice, style }) {},   // → { wav, usage }
  };
}
```

- **`decklight engine add <name>` installs one**, into `~/.decklight/engines/`
  like any other unit; `decklight tts --engine <name>` then speaks with it and
  the picker treats it exactly as it treats a built-in. An engine is Node code
  at author privilege, so it is **pinned** by `sha256` on the same terms as a
  transform or an adapter (`UNIT_PINNING`) — refused before any fetch without
  one, refused before any write on a mismatch.
- **An independent `apiVersion`, `ENGINE_API_VERSION`** — a third counter
  beside `TRANSFORM_API_VERSION` and `IMPORTER_API_VERSION`, for the third
  reason they are separate (`UNIT_COMPAT`): this convention is not `input →
  string` at all, so the day either of the others grows a field, an engine's
  contract is untouched and must not be invalidated alongside them. Additive
  only, bumped only when the factory or `synth` convention itself would break
  an installed engine — never for a reorganisation of `tools/tts-engines.mjs`,
  whose six built-ins this number does not version.
- **`capability` says which affordance it answers for** (`tts` today).
  Validated for *shape* in the catalog and checked against what this decklight
  runs only at LOAD time — a catalog declaring an engine for a capability this
  version cannot run must stay addable, so the refusal names the one engine
  rather than invalidating the catalog it arrived in and taking its themes
  down with it. Same reasoning an unknown `type` already gets
  (`MARKETPLACE_REGISTRY`).
- **The returned object is checked once, at load, not at the first sentence.**
  A missing `synth`, a factory that is not a function, one that throws while
  starting, one whose roster is neither a `voices` array nor a `listVoices()`
  — each is a `LoaderError` naming the engine, never a raw stack, and never a
  crash mid-talk. `stylable` defaults to **false** when an engine does not say:
  a plugin with no delivery-instruction channel that forgets to declare one
  must not have the tone step offered for it, which is the same silent lie
  `PRESENTING` refuses when it skips that step for chirp and piper.
- **Loaded by dynamic `import()`, in the same process as the bridge** — no
  subprocess, no VM sandbox, identical reasoning to `EXTENSIONS_TRANSFORMS`.
- **Author-time only.** Installing and configuring both happen through the
  author server; `present` registers nothing that could reach either, and a
  credential still comes from the wizard (`ENGINES#WIZARD`) and is still
  stored restricted to the account that pasted it — the platform's own form of
  that, named in `ENGINES#WIZARD` — never into a deck.
### ENGINE_PREREQUISITES — What an engine needs before a key is worth asking for

TTS made two failure states look like enough — "could not reach it" and "that
key was refused" — because a credential is the only thing a TTS provider ever
needs. Lipsync is the case that proves otherwise (`ENGINES#LIPSYNC`): rhubarb
is a **binary**, Wav2Lip is a **python checkout plus model weights**, and only
Veo is the paste-a-key shape. So a wizard schema may declare what it needs
from the machine, beside what it needs from the person:

```json
"requires": [
  { "kind": "binary", "name": "rhubarb", "hint": "brew install rhubarb-lip-sync" },
  { "kind": "file",   "name": "~/models/wav2lip.pth", "hint": "download the checkpoint" }
]
```

- **Two kinds, and deliberately no third.** `binary` (a command that must be
  on `PATH`) and `file` (a path that must exist — a checkout, a checkpoint, a
  model). Everything a talking-head engine needs is one of those two, and a
  vocabulary that grew past them would stop being a declaration and start
  being a build script. Closed for the same reason `FIELD_TYPES` is: a
  prerequisite core cannot check is refused **by name**, never rendered as a
  best guess.
- **`hint` is displayed, never executed.** It is the line a human would type,
  shown so it can be copied. Decklight does not run it — and that is the only
  reason it can be catalog-supplied at all. A plugin able to get a shell
  command run at author privilege merely by declaring a "prerequisite" would
  make the wizard a remote-code-execution primitive with a config file for a
  delivery mechanism, the exact inversion `MARKETPLACE.md WHY` exists to
  refuse. The piper offer-to-fetch (`PRESENTING`) looks similar and is not:
  that command is chosen by decklight's own code, against a package decklight
  names, and no catalog can put a string in it.
- **A third state, `prerequisite`, beside `unreachable` and `rejected`** —
  `412` on the wire, its own line in the player. Someone missing rhubarb must
  not be told to check their key, exactly as someone with a wrong key must not
  be told to check their network.
- **The gate runs first.** Before the answers are checked, before the network
  is touched, and before anything is written: an engine that cannot run here
  never has a credential collected for it, and a provider outage can never
  mask a missing binary.
- **Nothing is ever downloaded, and non-TTY runs never prompt** — unchanged
  from the offer-to-fetch precedents, because nothing here fetches at all.
- **`capability: "lipsync"`** is a runnable engine kind alongside `tts`
  (`ENGINE_UNITS`): the factory contract is identical, and what differs is
  exactly the prerequisites above.

### AGENT_UNITS — AI agents: a descriptor, and a remembered preference

`A` (PRESENTING) hands an installed coding agent one editing task. The roster
of agents decklight knows how to invoke ships in core, and a marketplace can
extend it — but an agent unit is a **descriptor, never code**:

```json
{ "name": "my-agent", "type": "agent",
  "bin": "my-agent", "args": ["-p", "{prompt}", "--yes"] }
```

- **`bin` is a command you already installed**, the way its own documentation
  says. `decklight agent add <name>` fetches nothing and runs nothing of the
  catalog's — it only teaches decklight how to *call* something already on
  your `PATH`. That is why `agent` is `REFERENCE_ONLY` beside `voice`, carries
  no `sha256`, and is the second kind whose `add` works offline. The reason
  differs from a voice's: not consent, but blast radius — an open roster that
  required downloading a module would put every new agent in `UNIT_PINNING`'s
  risk class for no gain, when the thing being described is a binary the user
  chose and installed themselves.
- **The whole template vocabulary is `{prompt}` and `{deck}`**, each
  substituted into one argv element. The result is spawned as an **argv
  array, never a shell string**, so a deck path containing a space or a
  semicolon is an argument and can never become a command. A descriptor whose
  `args` never mentions `{prompt}` is refused: an agent handed no instruction
  is not a working entry. The three shapes the built-in roster already covers
  (`-p …`, `exec --full-auto …`, `run -t …`) are the evidence this vocabulary
  is closed enough to stay declarative.
- **A unit may not shadow a built-in.** An installed descriptor whose name
  collides with one of the core agents is dropped rather than replacing it —
  silently changing how `claude` is invoked is not something a catalog should
  be able to do to a machine. A malformed descriptor is skipped, not thrown
  on: one broken third-party entry must not take `A` down for the agents
  beside it.
- **The preferred agent is remembered** (`~/.decklight/agent.json`), so `A`
  opens on the agent you chose rather than on whichever was detected first.
  Precedence matches every other saved choice: `--agent` > the remembered
  preference > the first detected agent. Choosing one in the `A` dialog
  persists it (`POST /edit/agent/prefer`); it is a fact about the machine, so
  it is written beside the unit library and **never into the deck**.
- **A remembered agent that is missing is named, never substituted.** Which
  agent edits your deck is not an interchangeable detail, so an unavailable
  preference does not quietly fall back to another one: the author server says
  so once at startup, and `A` answers with a line naming what is missing, what
  is available, and how to get it back.
- **An agent is offered only if it can be RUN, and it is run as argv.** On
  Windows every agent that installs from npm lands as a `.cmd` batch shim, and
  Node refuses to spawn one without a shell. decklight does not turn one on:
  with a shell the arguments stop being arguments and become a command line for
  `cmd.exe` to re-split, and one of them is the user's prompt — `%VAR%` there
  is expanded before any escaping the caller could apply, so no quoting makes
  it safe. Instead the shim is resolved back to the script it runs and node is
  spawned on that, which keeps the guarantee above (argv is argv) identical on
  both platforms. A batch file that names no such script is **not offered at
  all** — detected-but-unrunnable is a worse answer than absent, and the
  refusal names the file rather than claiming the command is missing.

### VOICE_UNITS — Voices: a reference, never a payload

A marketplace distributes voices as **references**. A `voice` entry names an
engine and one of that engine's own voice identifiers — `{ "name":
"narrator-anna", "type": "voice", "engine": "elevenlabs", "voiceId": "…" }` —
and carries no `source`. There are no model weights, no sample audio, and
nothing else that could reproduce a person's voice on a machine that never
asked. `decklight voice add` therefore fetches nothing at all: it writes the
pointer it already had in the catalog cache, which makes it the one install
that works offline, and speaking through it still needs that engine and the
installer's own credential.

**The rule is enforced by subtraction.** A `source` on a `voice` entry is
*refused*, not ignored, so the field through which bytes would arrive does not
exist — the same shape as the runtime having no plugin system rather than a
disabled one (NON_GOALS). An ignored field would still let a catalog carry a
model that merely never loads.

**There is deliberately no consent attestation.** A `consent: true` field would
be one boolean an uploader types and no one can verify, and printing it back
would manufacture exactly the confidence the ingredients label refuses to
manufacture (PRESENTING: an inventory, never a verdict). Distributing only
references puts the consent relationship where it can actually be held and
withdrawn: a cloned voice lives in a provider account under terms that governed
the cloning, it is useless to anyone the owner has not shared it with, and
unsharing it revokes every reference at once — which no file, once downloaded,
can be made to do.

**The limit, stated rather than papered over:** this does not stop a catalog
naming a voice after a person, or pointing at a provider voice that imitates
one. What it stops is decklight becoming the thing that *hands out the
likeness*. The rest is the provider's terms and the marketplace's own tier
(first-party vetted, community screened, third-party unreviewed) — the same
place every other unreviewable claim about a catalog entry already lives.

Piper voice models are unaffected and stay what they were: downloads offered by
the engine when a model is missing, not marketplace units.

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
                 character, ⇧V recorder), editmode.js (live reload, notes editor, element edit mode, agents,
                 undo/redo, restore), hud.js (clock, progress, ink, transcript), onboarding.js (the first-open card
                 and tips) + the decidable pieces engine.js's init() no longer holds, each unit-tested without a
                 browser: overflow.js (the guardrail's watch), playlist.js (module navigation), finder.js (the
                 finder's index + ranking), layout.js (the L ring + its write-through), palette.js (what a typed
                 string means), debuglog.js (the D ring buffer), overlay.js (backdrop, list selection, the
                 typeahead keyboard), escape.js — plus autoanimate, builds, print, svg, charts, media, speaker,
                 annotate, character, devmode, themegen, voicetrack
  src/math/      LaTeX math on data-math slides (Temml → MathML Core)
  src/code/      highlight bundling + line stepping provider
  src/terminal/  ansi.mjs (parser), player.mjs (provider + modes)
  cli/           decklight.mjs (dispatcher: init/skills/rec/refresh/export/bundle/restore/upgrade/pdf/import/theme/
                 publish/marketplace/plugin/template/importer/transform/engine/extension/voice/agent/tts/lipsync/
                 video/author/present/associate/report-bug; `dev` is a hidden alias for `author`, `edit` refuses out
                 loud) + pkg.mjs (the package root and the one runtime-inlining transform) and util.mjs (CommandError
                 + runMain: every command fails one way), init.mjs, rec.mjs, bundle.mjs, upgrade.mjs, restore.mjs,
                 theme.mjs (validate + install a theme, THEMING), import.mjs (PowerPoint/Keynote/Google Slides →
                 deck, JS_API), publish.mjs, marketplace.mjs (register catalogs, MARKETPLACE_REGISTRY), units.mjs
                 (templates/skills/importers/voices/engines/agents), plugin.mjs (presenter chrome, PRESENT#PLUGINS),
                 loader.mjs + extension.mjs (build-time transforms and their admission gate), wizard.mjs (the
                 credential wizard, ENGINES#WIZARD), sign.mjs + deckfile.mjs + associate.mjs (signing, the
                 .decklight container, the double-click), audit.mjs (the ingredients label), serve.mjs (the server
                 core), present.mjs, edit.mjs, dev.mjs, remote.mjs, agents.mjs (AI-agent roster)
  tools/         theme-check.mjs (the THEMING token contract + WCAG gates, as a function) + color.mjs (contrast math), local-voice.mjs (what this OS can say: macOS say / Windows SAPI, PRESENTING), zip.mjs (read an Office archive) + ooxml.mjs (a small XML reader) + pptx.mjs (PowerPoint → sections, JS_API), voiceover.mjs (batch TTS) + voiceover-server.mjs (tts bridge), publish-voices.mjs (track → bucket + signed manifest, PRESENTING), publish-targets.mjs (Netlify/Vercel deploy adapters, PRESENTING), tts-engines.mjs (gemini/chirp/piper/elevenlabs/say/sapi) + gemini-tts.mjs, elevenlabs-tts.mjs, lipsync.mjs (batch visemes/video) + lipsync-server.mjs (lipsync bridge), visemes.mjs (timeline v1), video.mjs (deck → narrated mp4, PRESENTING)
  themes/        46 × <name>.css (the graded + reveal-compat sets; the homage packs moved to the
                 marketplace, THEME_DISTRIBUTION) + packs.json + gallery.html
  dist/          decklight.js (IIFE, global Decklight), decklight.css
  demo/          smoke.html (the render harnesses' deck — every feature, including deliberate regression
                 fixtures) + intro.html, features.html, pitch.html, showcase.html + assets/
  test/          node:test units (ansi, builds, math, cast format, the CLI, the marketplace, the pieces lifted out
                 of engine.js), found by run.mjs rather than a shell glob + 15 headless-Chrome harnesses (render,
                 player, narration, character, engine, pin, overflow, split, strict, shot, plugin, extension-check,
                 deckfile, pdf, import) + contrast.mjs and palette-rules.mjs (every shipped theme through
                 tools/theme-check.mjs, and the house palette bar) + the two manual end-to-end scripts neither
                 blessed suite runs: soak.mjs (pack, install, walk the journey — the release gate) with its
                 soak-platform.mjs, and video-e2e.mjs (a real ffmpeg render)
```

- Build: `npm run build` = esbuild bundle (`src/index.js` → `dist/decklight.js`, minified + sourcemap) + CSS copy. Node ≥ 20. Runtime has **zero** runtime dependencies (highlight.js + temml are bundled at build time; Temml's stylesheet is appended to `decklight.css` with its optional woff2 `@font-face` stripped); `node-pty`, `js-yaml` are CLI-only deps.
- Verification culture: `npm test` runs the units; `npm run verify` builds and then runs **all 17 harnesses** — the 15 headless-Chrome ones against `demo/smoke.html` and the decks each covers, plus the two theme graders — reporting every harness rather than stopping at the first failure. A feature is verified against a real render, not only unit-tested.
- Release gate: **`npm run soak`** packs this repo, installs the tarball into an empty project whose path contains a space, and drives the INSTALLED `decklight` through one user journey — create, import, marketplace, author, present, bundle, transform, pdf, publish, validate, open, record, film — plus a cross-version `upgrade` of a deck scaffolded by a decklight that actually shipped. Manual, in neither blessed suite (it runs a real `npm install`, and skipping inside them would let "green" mean "not actually run"); anything it cannot do here — no Chrome, no network, no ffmpeg, no toolchain — skips **by name**, so a green run with skips is never mistaken for a complete one.

## NON_GOALS — Non-goals (v1)

Vertical slide nesting · full terminal emulation (vim/htop) · multiplex/follow-along · **in-deck runtime extensions** · PPTX export · mobile authoring.

**On that third-from-last one.** "No plugin system" was the v1 non-goal, and 0.3.0 shipped marketplaces — so the line is narrowed rather than deleted, because what it was protecting is still protected. A deck travels, so code inlined into it runs in front of an audience that installed nothing and consented to nothing (MARKETPLACE.md `WHY`). Everything a marketplace distributes therefore runs somewhere else: a build-time transform runs in Node during `bundle` and returns HTML (`EXTENSIONS_TRANSFORMS`), a presenter plugin runs on the presenter's own machine in a sandboxed frame and may not touch slide content (PRESENT#PLUGINS), an engine or import adapter runs at author time, and a theme or template is data. The runtime still has no plugin API, no `<script>` a catalog can put in a deck, and no execution surface for a recipient to be surprised by — providers + events remain the only extension inside the deck.

The phone remote (PRESENTING) is not an exception to multiplex/follow-along: it is a **controller**, not a second screen. The phone renders no slides — two buttons and a position readout — and nothing in it broadcasts a deck to an audience's own devices.
