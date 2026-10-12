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
- [x] **Init's header says it asks one question.** (#773) It can ask four
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
