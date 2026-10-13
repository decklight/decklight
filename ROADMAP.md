# Roadmap: simplifying the surface

Decklight does what it set out to do. What it costs is surface area: the same
capability is reachable from three or four doors, and every door carries its own
flags, keys, preferences and documentation. This file tracks the work of
closing doors without losing capabilities. An item is removed when its PR
merges; the PRs that closed the first pass are #772 to #799, and the release
CHANGELOG is compiled from their titles.

Baseline, counted from the code on 2026-10-12 (0.9.0), before that pass:

| Surface | Then | Target |
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

## Reviewed and kept as they are

Two items from the first pass were looked at and deliberately left alone.
They stay listed so the reasoning is not re-done.

- [ ] **Overlay letters inside a focused panel.** Inside a panel that has the
      keyboard, its letters are its own (`D` hides done comments, `R`
      resolves), as in any focused app. The risky ones are already safe:
      submitting a review is two presses, and every delete has an undo. Revisit
      only if someone trips on one.
- [ ] **Three slide pickers.** With every action at the root, the palette's
      `goto 27` is the same kind of thing as VS Code's "Go to line"; the
      finder (`G`) searches by name and the overview (`O`) rearranges. Three
      doors for three jobs.

## What is left

Nothing is open. New items go under a new section above this one.
