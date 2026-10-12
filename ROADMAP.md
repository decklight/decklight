# Roadmap: simplifying the surface

Decklight does what it set out to do. What it costs is surface area: the same
capability is reachable from three or four doors, and every door carries its own
flags, keys, preferences and documentation. This file tracks the work of
closing doors without losing capabilities. Tick an item when its PR merges and
add the PR number after it.

Baseline, counted from the code on 2026-10-12 (0.9.0):

| Surface | Today | Target |
|---|---|---|
| CLI commands in the roster (`cli/commands.mjs`) | 39 | about 20 |
| Flags on `decklight <deck>` (`cli/open.mjs`) | 49 | about 12 |
| Command palette rows (`src/core/engine.js` `paletteCommands`) | 82 | fewer, all at the root, `Category: Action` |
| Key bindings on the help card | 37 | about 20 |
| Dockable panels, each with its own remembered placement | 6 | 1 |
| localStorage pref families, of which shown in Settings | 28, 4 | all in Settings |
| Onboarding moments for a newcomer | 15 | 2 |
| Ways to get narration into a deck | 6 | 1 command, 1 panel |
| Questions a first run can ask (init plus the open it spawns) | up to 11 | 1 (trust) |
| Edit-server routes (`cli/edit.mjs`) | 81 | same, split by subsystem |

Suggested order: startup questions and flags first, since they are cheap and
every user meets them. Then the palette regroup and the key diet together. Then
the single side panel. The roster fold and the SPEC split are release-sized and
can wait for 1.0.

## 1. Startup and flags (cheap, every user meets them)

- [x] **Init forwards a declined git answer.** (#772) Saying no to git at init is asked
      again by the `decklight <deck> --open` it spawns (`cli/init.mjs:660` does
      not pass `--no-git`; `cli/open.mjs:471` asks).
- [x] **Delete the git-mode follow-up question.** (#PR) `agent` is already the default
      (`cli/git.mjs` `resolveGitMode`), so the question at `cli/open.mjs:480`
      changes nothing.
- [ ] **Move the piper download and the TTS setup questions out of startup.**
      Ask at the first `V` press in the deck, which is the lazy design
      `cli/wizard.mjs` already describes in its header. Startup then asks only
      the trust question. Not cheap: with no engine configured the bridge is
      not started, and the deck's `V` panel then only says "no voice bridge is
      answering" (`src/core/narration.js:2443`). This needs the bridge to start
      with no engine and list what each one needs, plus an in-deck setup for a
      key, a project or the piper model. A feature PR of its own.
- [x] **Take the TTS, lip-sync and Veo pass-through flags off the help.** (#PR)
      `decklight <deck> --help` is 27 lines instead of 70; `--help --all`
      keeps the full list. The flags are still accepted, because the saved
      configuration does not hold all of them: Veo, `--tts-format`,
      `--tts-stability`, `--location` and `--data-dir` exist only as flags.
      Removing them outright needs those in `tts.json` and `lipsync.json`
      first.
- [x] **Take `--tts-port`, `--lipsync-port`, `--host` and `--commit-every` off
      the help.** (#PR) Still accepted: open passes the bridge ports to the
      edit server when it moves a bridge off a squatted port, and a `file://`
      deck still knocks on 8787.
- [x] **Document the flags help did not list.** (#PR) `--remote` and
      `--no-remote` on init; `--veo-prompt` and `--veo-location` on open.
- [x] **Fix the banner row order.** (#772) `runtime` and `skill` are missing from
      `ROW_ORDER` (`cli/banner.mjs:60`) and sort below `reviews`, against the
      stated rule. The no-agent row names three of the ten supported agents
      (`cli/open.mjs:752`).

## 2. The palette and the keys (one PR each, land together)

- [ ] **Every action at the root, prefixed with its category.** The way
      VS Code's command palette reads: `Voice: Live voice…`, `Slide: Duplicate`,
      `Share: Export as PDF`, `Look: Generate a theme`, `Review: Leave a
      comment…`. No drill-in groups: the five groups that collapse rows today
      (Slide…, Print…, Add audio tags…, Write for the ear…, Export & share…)
      flatten into prefixed rows, and the category is what a filter types to
      narrow the list (`voice`, `slide`). Categories to settle in the PR: Go to,
      Slide, Edit, Look, Voice, Review, Share, Check, View, Help. Rows live in
      `src/core/engine.js:913-1123`, grouping in `src/core/palette.js:51-83`.
- [ ] **Remove the rows that duplicate a panel.** The four rows that all open
      the `V` panel at different views, the six enhance rows the `V` panel and
      the notes editor already carry, Character solo, First slide and Last
      slide, and one of the Print and PDF triplets.
- [ ] **One write-mode rule.** Five rows are tagged `(dev)` without a server
      check (`engine.js:923-953`) and four write-only rows are untagged
      (`932`, `1031`, `1035`, `1038`). Gate everything on
      `editmode.available()` and drop the suffix convention.
- [ ] **One key per action.** Drop `R` for history, `P` for play, `J` for the
      progress bar, `D` for the debug log. Keep the chord and the letter only
      where the chord works while typing (`K`, `Z`).
- [ ] **No bare letter writes the file.** In write mode `L` edits the deck on a
      stray keypress, which is why Lock exists. Reserve bare letters for
      navigation and viewing; route edits through chords or the bar.
- [ ] **Resolve the overlay collisions.** `D` means four things, `S` three
      (including Submit all in the review panel), `R` three, `⌫` eight. Each
      overlay should reuse the deck's meaning or use a different key.
- [ ] **One log.** Merge Messages (`` ` ``) and the debug log (`D`) into one
      panel behind the palette.
- [ ] **Help card lists everything bound.** `E` in the inspector, `⌘B` `⌘I`
      `⌘E` while editing, `⏎` and `⌫` on a selection, and the overview's
      `N` `D` `⌫` are bound but not listed (`engine.js:2205-2245`).
- [ ] **Bug: Esc does not close the `?` help in write mode.** Reproduced
      headlessly on `demo/intro.html` (`src/core/engine.js:2508-2516`).

## 3. Panels, styling, settings, onboarding

- [ ] **One side panel with tabs instead of six docks.** Notes, Inspector,
      Sources, Comments, Agent and the HTML editor each remember their own
      placement (`decklight-*-dock:` keys) and are modal or not depending on
      dock state, so keys reach the deck only sometimes. One panel, one
      placement, one Esc. The largest UI change on this list and the one that
      removes the most confusion (`src/core/dock.js`, `editmode.js:2156-2178`).
- [ ] **The inspector is the only styling surface.** The element menu's
      Colors and Type rows already open inspector tabs
      (`src/core/editmode.js:1779-1780`). Drop the Copy style and Paste style
      palette rows (the chords stay) and make Edit content (HTML) an inspector
      tab rather than a seventh editor.
- [ ] **Settings is the home for knobs.** Move clock, progress bar, captions,
      voice speed, tips and dock placement into Settings; they are palette
      toggles today. Settings holds four rows while 28 pref families live
      elsewhere, against the intent stated at `engine.js:1226-1232`.
- [ ] **`prefs.js` is the one storage door.** `src/core/editbar.js:63-135`
      uses raw `localStorage`; everything should go through the helpers so
      Settings can list what exists.
- [ ] **Two onboarding cards, nothing else.** Keep the welcome card and the
      write-mode tour. Retire the twelve rotating tips, the press-`V` chip and
      the Tips on, Tips off and Reset tips rows (`src/core/onboarding.js`,
      `narration.js:1875-1900`). The welcome card teaches `⌃T`, which only
      works on a Mac.
- [ ] **One slide picker.** Fold Go to slide and the numeric query into the
      finder (`G`), keep the overview (`O`) as the write-mode rearranger.
- [ ] **One place to read notes.** `S`, the speaker view, Transcript and Print
      with notes are four. Fold Transcript into the speaker view.

## 4. The command roster (release-sized)

- [ ] **Fold `refresh` and `export` back under `cast`.** `export` as a top-level
      verb means asciicast, while the deck's Export and share means PDF, PPTX,
      video and bundle.
- [ ] **One grammar for the library.** `importer`, `transform`, `engine`,
      `voice`, `agent`, `plugin`, `extension` and the `skills add` unit kind
      become `decklight add <kind> <name>` and `decklight library list`,
      removing seven top-level commands. `plugin` is parallel code with its own
      add, list, check and remove (`cli/plugin.mjs`); `extension check` covers
      transforms only.
- [ ] **One grammar for what a deck references.** `theme add`, `font add` and
      `design-system add` each take a different shape, theme lacks `list`, and
      the three reference modules are one pattern written three times
      (`cli/theme-refs.mjs` 515, `cli/font-refs.mjs` 273,
      `cli/design-system-refs.mjs` 398 lines, three NAMESPACE regexes, three
      link and asset trios wired separately in `serve.mjs` and `edit.mjs`). A
      reference-kind table like `UNIT_TYPES` collapses them.
- [ ] **`tts` and `lipsync` become internals.** They exist as commands because
      open spawns them. One `decklight voice setup` replaces `tts --setup`.
- [ ] **`record` folds into open plus `V`.** It already runs the same server
      (`cli/record.mjs`).
- [ ] **One way to narrate.** Six producers today: live voice, `voiceover`,
      Record this deck, `video --voiceover`, the mic recorder and `enhance`,
      plus `tools/lipsync.mjs` batch with no command at all. One
      `decklight narrate <deck> [--engine X | --mic] [--slides a-b]`, and one
      Record view in the deck.
- [ ] **One documented shape for `narration.files`.** `tools/voiceover.mjs:66`
      and `cli/record.mjs:46` document two; `cli/edit.mjs:786-870` normalises
      both.
- [ ] **CLI commands as thin clients of shared modules.** Each hand-over and
      git feature exists twice, as a command and as an edit route:
      `history` and `restore`, `publish`, `bundle`, `pdf`, `pptx`, `video`,
      `theme add`, `enhance`, `comments`. Split `cli/edit.mjs` (4162 lines, 81
      routes) along the groups already used for `edit-slides.mjs`: git, review,
      hand-over, look.

## 5. Vocabulary

- [ ] **record versus cast.** Both help entries have to disclaim the other
      (`cli/commands.mjs:262`, `345`).
- [ ] **layout versus template.** The purge from #725 missed the palette row
      "Use design-system layout…" and the global help, which names the
      subcommand `layouts` (`commands.mjs:312`) when it is `templates`
      (`cli/design-system.mjs:411`) and omits `apply`.
- [ ] **check means seven things.** `check` (lint), `--no-trust --check`
      (ingredients label), `theme`, `font`, `design-system`, `plugin` and
      `extension check` (admission gates), and the palette's Check deck…
      (lint plus agent review). Rename the gates `verify` or `gate`.
- [ ] **Presenter plugins load in write mode too.** They load only under
      `--no-trust`, so presenting your own deck with a timer means opening it
      without trust. Loading them in both modes fixes that without reviving a
      `present` command.
- [ ] **unit, extension, plugin.** One word once the library grammar lands
      (section 4).
- [ ] **Help drift.** The `trust` paragraph carries `associate`'s example
      (`commands.mjs:351-353`); `engine` says "six built-in" while
      `tools/voiceover.mjs:14` says three; `SHORT.trust` exists though `trust`
      is not a start command (`commands.mjs:110-118`).

## 6. Docs and the installed skill

- [ ] **Split the SPEC into an authoring contract and a platform contract.**
      The block from `MARKETPLACE_REGISTRY` through `VOICE_UNITS` is 640
      lines, longer than every authoring section combined, and the skill
      install copies it into every project as `reference.md`. `PRESENTING` is
      one section of 40 KB in 112 lines; break its bullets into subsections.
- [ ] **Fix the stale slice comment.** `cli/skill-content.mjs:28` says the
      reference stops at `JS_API`; it runs through `FONTS`.
- [ ] **Trim SKILL.md to what an author does weekly.** About 40 percent is
      ElevenLabs prompting, committing through curl and design systems
      (`cli/skill-content.mjs:206-306`). Move it to the reference behind a
      pointer.
- [x] **Init's header says it asks one question.** (#PR) It can ask four
      (`cli/init.mjs:14`).
- [ ] **Stale text in the intro deck.** `demo/intro.html` says 62 themes in
      five packs (46 in 2) and that `E` edits notes (`S` does).
- [ ] **Stale code comments.** `src/core/editmode.js:42-45` and
      `editbar.js:7, 12, 363` describe the retired `E` key; `hud.js:3` says
      the clock is `K`; the comment near `engine.js:2160` says the message log
      is `I`.
- [ ] **A glossary.** One page naming write mode, no-trust, bundle, cast,
      record, narrate, template, unit, reference, marketplace, so the README,
      the help and the SPEC stop defining them each in their own words.
