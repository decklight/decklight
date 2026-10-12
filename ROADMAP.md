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
- [x] **Delete the git-mode follow-up question.** (#773) `agent` is already the default
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
- [x] **Take the TTS, lip-sync and Veo pass-through flags off the help.** (#773)
      `decklight <deck> --help` is 27 lines instead of 70; `--help --all`
      keeps the full list. The flags are still accepted, because the saved
      configuration does not hold all of them: Veo, `--tts-format`,
      `--tts-stability`, `--location` and `--data-dir` exist only as flags.
      Removing them outright needs those in `tts.json` and `lipsync.json`
      first.
- [x] **Take `--tts-port`, `--lipsync-port`, `--host` and `--commit-every` off
      the help.** (#773) Still accepted: open passes the bridge ports to the
      edit server when it moves a bridge off a squatted port, and a `file://`
      deck still knocks on 8787.
- [x] **Document the flags help did not list.** (#773) `--remote` and
      `--no-remote` on init; `--veo-prompt` and `--veo-location` on open.
- [x] **Fix the banner row order.** (#772) `runtime` and `skill` are missing from
      `ROW_ORDER` (`cli/banner.mjs:60`) and sort below `reviews`, against the
      stated rule. The no-agent row names three of the ten supported agents
      (`cli/open.mjs:752`).

## 2. The palette and the keys (one PR each, land together)

- [x] **Every action at the root, prefixed with its category.** (#775) The way
      VS Code's command palette reads: `Voice: Live voice…`, `Slide: Duplicate
      this slide`, `Share: Export to PDF…`. The five drill-in groups are gone;
      with nothing typed the list runs Go to, Slide, Edit, Look, Voice,
      Present, Review, Git, Share, Help, Preferences. Typing the category
      narrows to it, every typed word must match in any order, and a name that
      starts with the query leads. Labels kept their established wording,
      since the SPEC, the README and the harnesses name them.
- [x] **Rows that duplicate a panel: revised.** (#775) With every action at the
      root, a row that opens the `V` panel on one of its views is an action of
      its own, found by its name, so the rows stay. What was wrong was the
      `V` hint on four of them, which taught a key that opens the panel, not
      that view; only the panel row carries it now.
- [x] **One write-mode rule.** (#775) A row that changes the file or needs the
      edit server exists only while the deck can be written, and carries a
      `write` tag. The lock row is the one exception: it stays while locked,
      because it is how you unlock.
- [x] **One key per action.** (#775) `R` (history's second key), `P` (`⎵`'s
      alias), `J` (progress bar) and `D` (debug log) are unbound; the last two
      are palette rows.
- [x] **No bare letter writes the file.** (#775) `L` and `Z` / `⇧Z` are unbound.
      Undo and redo are the platform's chord (`⌘Z` / `Ctrl+Z`), named in every
      "takes it back" message through `src/core/undo-chord.js`; layout is the
      bar's button, ⇧-click backwards, and a palette row. A lint pins it: no
      `case` in the deck's key switch may call an edit.
- [ ] **Overlay collisions: reviewed, left as they are.** Inside a panel that
      has the keyboard, its letters are its own (`D` hides done comments, `R`
      resolves), as in any focused app. The risky ones are already safe:
      submitting a review is two presses, and every delete has an undo. Revisit
      only if someone trips on one.
- [ ] **One log.** Not done. Merging Messages (`` ` ``) and the debug log into
      one panel is a UI redesign, not a key change: the two hold different
      things (what the deck told you, and the event stream). `D` is free now;
      the debug log is `Help: Debug log`.
- [x] **Help card lists everything bound.** (#775) A "Write mode, in context"
      section names the keys that answer only on a selection, while typing, in
      the overview or in the inspector.
- [x] ~~Bug: Esc does not close the `?` help in write mode.~~ Not a bug. The
      reproduction ran against a stale `dist/`; after `npm run build`, Esc
      closes it in write mode and from a file.

## 3. Panels, styling, settings, onboarding

- [x] **One side panel with tabs instead of six docks.** (#779) Notes,
      Inspector, Sources, Comments, Agent and the HTML editor share one slot
      and one placement per deck (`decklight-panel-dock:`); opening one closes
      the other, and every header carries tabs to the rest (`src/core/dock.js`).
      Still open: whether a docked panel takes the keyboard depends on the
      panel (the comments are modal only while you work in them, the notes
      while you type). Unifying that is the next step, and needs a decision on
      what `←`/`→` mean while a panel has focus.
- [ ] **The inspector is the only styling surface: revised.** The Copy style
      and Paste style rows stay: with every action at the root (section 2)
      they are actions, and the palette is where actions live. The HTML
      editor now shares the inspector's slot (above), so it no longer stacks
      a seventh panel beside it; making it an inspector tab is still open.
- [x] **Settings is the home for knobs.** (#779) Clock, Progress bar,
      Captions, Voice speed and, in write mode, the Editing bar are Settings
      rows; each reads what the deck remembers and ⏎ changes it. The palette
      keeps its rows: the palette does a thing, Settings shows how the deck is
      set up. Also added at the user's request: **Arrows and slide number in
      fullscreen**, with `⇧F` and a palette row.
- [x] **`prefs.js` is the one storage door.** (#779) The edit bar and the
      export choices go through it, and a lint keeps every other module off
      `localStorage`. `sessionStorage` (per-tab state, not preferences) stays.
- [x] **Two onboarding cards, nothing else.** (#779) The twelve tips, their
      three palette rows, `instance.tips` and their storage keys are gone, and
      the welcome card teaches `⌃T` only on a Mac. **Revised:** the press-`V`
      chip stays, because it says that THIS deck has a voice-over, which a
      once-per-browser card cannot.
- [ ] **One slide picker: revised, kept.** With every action at the root, the
      palette's `goto 27` is the same kind of thing as VS Code's "Go to line";
      the finder (`G`) searches by name and the overview (`O`) rearranges.
      Three doors for three jobs.
- [ ] **One place to read notes.** Not done: folding Transcript into the
      speaker view moves a feature between windows, and wants its own PR.

## 4. The command roster (release-sized)

- [x] **Fold `refresh` and `export` back under `cast`.** (#778)
      `decklight cast refresh` and `cast export`; the top-level words are gone.
- [x] **One grammar for the library.** (#781) `decklight library
      add|remove|list|gate <kind>` replaced `importer`, `transform`, `engine`,
      `voice`, `agent`, `plugin`, `extension` and the unit half of `skills`.
      **Revised:** `library add`, not a bare `add`, because `theme add`,
      `font add` and `design-system add` put a reference into a deck and a
      top-level `add` installing into the library would read as the same act.
- [ ] **One grammar for what a deck references.** Still open. `theme add`,
      `font add` and `design-system add` each take a different shape, theme
      lacks `list`, and the three reference modules are one pattern written
      three times (`cli/theme-refs.mjs`, `cli/font-refs.mjs`,
      `cli/design-system-refs.mjs`). A reference-kind table like `UNIT_TYPES`
      collapses them. A refactor across serve, edit and bundle, so its own PR.
- [ ] **`tts` and `lipsync` become internals.** Still open. Planned as
      `decklight setup voice` and `setup face` (replacing `tts --setup` and
      `lipsync … --save`), with `tts` and `lipsync` kept runnable but out of
      the help: write mode spawns them, and a `file://` deck still talks to a
      bridge run on its own.
- [x] **`record` folds into one narrate command.** (#782) `decklight narrate
      <deck> --mic`. **Revised:** a command rather than open plus `V`,
      because a microphone needs the deck served on 127.0.0.1, which is the
      one thing `--mic` does.
- [x] **One way to narrate.** (#782) `decklight narrate <deck> [--engine E |
      --mic] [--slides a-b] [--dir NAME]` replaced `voiceover` and `record`.
      `video --voiceover` stays a flag of `video`, and `enhance` stays: it
      rewrites the script rather than voicing it. `tools/lipsync.mjs` batch
      still has no command.
- [x] **One documented shape for `narration.files`.** (#780) One track is
      `files: '<dir>', ext, segments`; several are a list of the same fields.
- [ ] **CLI commands as thin clients of shared modules.** Still open: split
      `cli/edit.mjs` (about 4,100 lines, 81 routes) along the groups already
      used for `edit-slides.mjs`: git, review, hand-over, look.

## 5. Vocabulary

- [x] **record versus cast.** (#782) `record` is gone; `cast` records a
      terminal and `narrate --mic` records you, and each help names the other.
- [x] **layout versus template.** (#785) The global help says `templates`
      and `apply`. The palette row was already right; the review read a stale
      `dist/`.
- [x] **check means seven things.** (#785) Bare `check` is the deck lint. The
      marketplace admission gates are `gate` (`theme`, `font`,
      `design-system`, `library gate transform|plugin`), and `--no-trust
      --check` is `--audit`. The old spellings still answer, unadvertised, so
      a catalog's CI keeps working.
- [x] **Presenter plugins load in write mode too.** (#784) Same sandboxed
      chrome, named in the banner; `--no-plugins` turns it off in either mode.
- [x] **unit, extension, plugin.** (#781, #785) The commands name the kind
      (`library add plugin`, `library gate transform`); "unit" and "extension"
      no longer appear in any command, and the glossary defines library and
      plugin.
- [x] **Help drift.** (#785) `trust` and `associate` each carry their own
      example, the engine count says six everywhere, and the short help has
      no row for `trust`.

## 6. Docs and the installed skill

- [x] **Split the SPEC into an authoring contract and a platform contract.**
      (#SPLIT) `MARKETPLACE_REGISTRY` through `VOICE_UNITS` (641 lines) live in
      `PLATFORM.md`, shipped beside `SPEC.md`, which points at it and lists
      its mnemonics. `PRESENTING` is eight subsections, each with a mnemonic
      (`PRESENTING_NAVIGATION`, `_CHROME`, `_LOOK`, `_MODES`, `_EDITING`,
      `_VOICE`, `_FIT`, `_OUTPUT`). `SPEC.md` went from about 1,800 lines to
      1,180.
- [x] **Fix the stale slice comment.** (#783)
- [x] **Trim SKILL.md to what an author does weekly.** (#783) **Revised:**
      shortened rather than moved, keeping every rule (design system slots,
      prompting ElevenLabs v4, committing through the edit server), because
      the ElevenLabs guidance is not in the SPEC to point at. About 2,390
      words became 2,050; `reference.md` dropped from about 1,690 lines to
      1,054.
- [x] **Init's header says it asks one question.** (#773) It can ask four
      (`cli/init.mjs:14`).
- [x] **Stale text in the intro deck.** (#783) 46 themes in 2 packs, `S` for
      notes, and the showcase diagram no longer lists `rec`.
- [x] **Stale code comments.** (#783)
- [x] **A glossary.** (#785) `docs/GLOSSARY.md`, linked from the README.

## What is left

From the sections above, still open:

- **Section 1:** the voice setup questions move from startup into the deck's
  `V` panel (an in-deck setup flow), and the voice, lip-sync and Veo flags
  can be removed once their settings are savable.
- **Section 2:** one log panel for Messages and the debug log.
- **Section 3:** the keyboard rule for docked panels (needs a decision on
  what `←`/`→` mean while a panel has focus), the HTML editor as an
  inspector tab, and Transcript in the speaker view.
- **Section 4:** `setup voice|face` with `tts` and `lipsync` out of the help,
  one grammar for deck references, and splitting the edit server.
