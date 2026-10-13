# Glossary

The words Decklight uses, each defined once. The README, the help and
`SPEC.md` use them in these senses. Where a SPEC section says more, its
mnemonic is named.

## Decks

**Deck.** One HTML file of slides: `<section>` children of a
`<div class="decklight">`. What you author is data: the slides plus one JSON
configuration block, with no runtime in the file (`DECK_ANATOMY`).

**Bundle.** The self-contained shape of a deck, for handing it over: the
runtime, stylesheet, themes, fonts and pictures embedded, so the file opens
from disk. `decklight bundle` writes it; `decklight upgrade --link` turns one
back into data.

**Publish.** Bundle a deck and push it somewhere with a URL: GitHub Pages,
Netlify, Vercel or a folder (`decklight publish`).

**Build.** One step of a slide revealed on the next advance, Keynote style;
`data-build` on a container makes each child a build (`BUILDS`).

**Notes.** The speaker notes, `<aside class="notes">`. They are also the
narration script. `[click]` cuts them into beats, one per build; `[pause]`
holds a beat of silence.

**Sources.** `<aside class="sources">`: what a slide stands on, named facts
and links, hidden on the slide and shown in the inspector (`SLIDE_SOURCES`).

**Layout.** How one slide places its content: `auto`, `centered`, `top`,
`split`. Cycled from the bar's Layout button and written as `data-layout`.

**Template.** A design system's slide: a structure with named **slots**. A
slide names it with `data-template` and fills the slots; the structure comes
from the design system when the deck renders (`DESIGN_SYSTEMS`). Not a layout.

## Opening a deck

**Write mode.** `decklight <deck.html>`: the deck served on this machine with
live reload, editing on, an AI agent on `A`, and every edit written to the
file. The default way to open a deck you wrote.

**No-trust mode.** `decklight <deck.html> --no-trust`: the same server for a
deck you did not write. Every edit route refuses, the deck is served under a
Content-Security-Policy, and the **ingredients label** (what the file would
execute) is printed first. `--audit` prints the label and exits.

**Lock.** Write mode with changes turned off, from the palette or the bar,
until it is unlocked. For presenting a deck you are also editing.

**Panel.** The one slot beside the slide. Notes, Inspector, Sources,
Comments and Agent share it, each a tab, in one remembered placement; the
inspector's HTML tab edits the slide's source there too.

**Palette.** `/`: every command, named `Category: name` (`Share: Export to
PDF…`), filtered as you type. The palette does a thing.

**Settings.** The palette's *Preferences: Settings…*: how the deck is set
up to show itself (clock, progress bar, captions, voice speed, the editing
bar, the arrows and slide number in fullscreen), each row read back from
what the deck remembers and changed with `⏎`.

## Voice

**Live voice.** Narration synthesized while the deck plays, through the
voice bridge a write-mode session starts.

**Track.** Narration recorded into a folder beside the deck, one file per
slide and per `[click]` beat, played back by the deck. `narration.files`
names it.

**Narrate.** Make a track: `decklight narrate <deck>` has an engine read the
notes; `--mic` has you read them, one beat at a time; `--face` gives the
track its lip-sync, so the character plays it with no bridge running.

**Engine.** A speech engine: six are built in (gemini, chirp, piper,
elevenlabs, and the system voice, `say` or `sapi`); more install into the
library.

**Setup.** `decklight setup voice` and `decklight setup face`: this
machine's voice and talking head, chosen once and saved. Every deck you open
uses them, and `decklight <deck>` asks nothing about them at startup.

**Character.** An animated narrator whose lips follow the voice, or a
talking head made from a photo or a clip of you.

## Recording a terminal

**Cast.** A truthful terminal recording: `decklight cast` runs a YAML script
in a real terminal and the deck replays it, typing and output. Not a video,
and not narration (`TERMINAL_RECORDINGS`).

## Sharing things between decks

**Marketplace.** A git repository with a catalog
(`.decklight/marketplace.json`) of themes, design systems, fonts and library
units. Registered with `decklight marketplace add`, read from a local cache:
registering is not fetching (`MARKETPLACE_REGISTRY`).

**Library.** What this machine installs from a marketplace for its own use,
under `~/.decklight/`: plugins, skills, importers, transforms, engines,
voices and agents. Managed with `decklight library add|remove|list|gate`.
Nothing in the library travels inside a deck.

**Plugin.** Presenter chrome from your library: a timer, a teleprompter.
Shown over any deck you open, in a sandboxed frame; never bundled.

**Reference.** How a deck uses a theme, a design system or a font from a
marketplace: it names it, and the server serves it in. `decklight theme add`,
`font add` and `design-system add` write the reference into the deck; a
bundle embeds what it references.

**Design system.** A company's look as a package: tokens, art, slide
templates and a palette, referenced by a deck (`DESIGN_SYSTEMS`).

**Palette of scales.** A design system's brand colours, each a scale of
weights (`blue-100` to `blue-1000`), and the themes it ships drawn only from
them (`BRAND_PALETTE`).

**Brand lock.** A deck on a design system that ships themes is held to them:
the picker lists only the brand's themes, the deck opens on one of them, and
`check` warns about a colour off the brand. `"brandThemesOnly": false` in the
configuration lifts it (`BRAND_PALETTE`).

**Role.** A named colour a design system declares (`text-accent`,
`surface-card`) and every one of its themes sets, read as
`var(--<prefix>color-<role>)`. On a brand deck with roles, slides and
components colour through them alone (`DESIGN_SYSTEM_ROLES`).

## Checking

**Check.** The deck lint: `decklight check <deck>` and the palette's *Check
deck…* say, slide by slide, what is clipped, crowded, missing, out of step or off the brand.

**Gate.** The admission gate a marketplace's CI runs before listing an entry:
`decklight theme gate`, `font gate`, `design-system gate`, and
`library gate transform|plugin`.

**Verify.** `npm run verify` in a checkout of Decklight itself: the headless
render assertions behind every change to the runtime.
