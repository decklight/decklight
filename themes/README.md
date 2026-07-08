# Decklight themes

59 themes, one contract. A theme is **a single CSS file that defines tokens on `.decklight`** — the
runtime (`dist/decklight.css`) owns all structure; themes own only color, type, and mood. Link exactly
one theme per deck:

```html
<link rel="stylesheet" href="decklight/dist/decklight.css">
<link rel="stylesheet" href="decklight/themes/fjord.css">
```

Browse them: serve this directory (`python3 -m http.server`) and open [`gallery.html`](gallery.html).

## The token contract (SPEC §5)

Every theme must define **all** of these on `.decklight`:

| Group | Tokens | Notes |
|---|---|---|
| Canvas | `--bg` `--bg-accent` `--fg` `--muted` | `--bg`/`--bg-accent` may be gradients |
| Type | `--font-body` `--font-heading` `--font-mono` `--heading-color` `--heading-weight` `--link` | font stacks must degrade offline |
| Accent | `--accent` `--accent-contrast` | contrast = text placed *on* the accent |
| Blocks | `--block-bg` `--block-border` `--block-radius` `--shadow` | `--block-border` is a full border value |
| Code | `--code-bg` `--code-fg` `--hl-keyword` `--hl-string` `--hl-number` `--hl-comment` `--hl-function` `--hl-type` `--hl-punct` | no separate highlighter themes — these are it |
| Diagram | `--d-stroke` `--d-text` `--d-muted` `--d-accent` `--d-fill-1…6` | inline SVGs authored with `var(--d-*)` restyle across all themes |
| Terminal | `--term-bg` `--term-fg` `--term-prompt` `--term-cursor` `--term-selection` + 16 × `--ansi-*` | the 16 ANSI names map recorded output to the theme |
| Builds (optional) | `--build-duration` `--dim-opacity` `--term-chrome` | `--term-chrome: none` hides the window chrome |

## Accessibility gate

`node test/contrast.mjs` validates every theme (run from the repo root; part of `npm run verify`):

- `--fg`/`--bg` ≥ 4.5 · `--muted`, `--heading-color`, `--link`, `--d-text` ≥ 3.0 (gradient canvases: **every stop** must pass)
- `--code-fg` and all `--hl-*` ≥ 4.5 on `--code-bg` (`--hl-comment` ≥ 3.0)
- `--term-fg`, `--term-prompt`, and **all 16** `--ansi-*` ≥ 3.0 on `--term-bg` — yes, including `--ansi-black` on dark terminals: recorded output must stay readable on a projector, so "black" is a visible gray
- `--accent-contrast` ≥ 4.5 on `--accent`

A PR that adds or edits a theme must keep the validator green.

## Authoring a new theme

1. Copy the closest existing theme (dark → `fjord`, light → `porcelain`, gradient → `aurora`).
2. Rework **every** group — hue-rotating one palette produces a clone, not a theme. Decide the
   personality first (one line, like the taglines below), then pick canvas → type → accent →
   code mood → terminal mood in that order.
3. Fonts: system stacks preferred. A Google-font `@import` is allowed if the stack degrades
   gracefully offline (the import goes at the very top of the file).
4. Optional `.decklight h1/h2` cosmetic rules (letter-spacing, text-transform, font-style) are the
   only non-token CSS a theme should contain.
5. Run `node test/contrast.mjs` and fix until green; check your theme's card in `gallery.html`.

## The set

**Dark (14):** aurora · graphite · obsidian · midnight · fjord · cosmos · ember · moss · velvet · carbon · synthwave · ink · eclipse · storm
**Light (16):** porcelain · paper · meadow · glacier · citrus · dune · orchid · harvest · coastal · linen · berry · slate · latte · peony · mint · sepia
Plus the Classics, Old Machines, TV Series, and Movies packs (`packs.json` is the authoritative roster).

Serif-headed: moss, velvet, porcelain, dune, peony, sepia. Gradient canvases:
aurora, cosmos, synthwave, storm, coastal. Webfont-enhanced (all with offline fallbacks): carbon,
synthwave, porcelain, paper, peony, mint. Deliberately corporate-safe:
slate (and arguably graphite) — the rest have opinions.
