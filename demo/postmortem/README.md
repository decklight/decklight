# The postmortem the showcase builds

The decklight.io showcase follows one developer from an empty folder to a
published talk: *The night the cache fell over*, a postmortem. Everything in
this folder is that journey, done for real.

| Path | What it is |
| --- | --- |
| `casts/NN-*.term.yaml` | the script for each step, recorded with `decklight cast` |
| `casts/NN-*.cast.json` | the recordings the showcase plays: a real PTY, real output |
| `stages/stage-NN-*.html` | the talk as each step left it |
| `published/index.html` | the published talk, voice inside: decklight.io/postmortem/ |

## How it was made

1. `npx decklight@latest init` in an empty folder (the skill, git, the server).
2. **One real Claude Code run** (`claude -p …`), recorded once and never re-run:
   the five slides it wrote are the talk's first draft, as they came.
3. A double-click retitle in the real editor, committed through the edit server.
4. Northwind (`demo/northwind/`, an invented company design system) registered
   with `marketplace add`, then added and applied in the deck (`/` → Design
   systems…), and the title moved onto its Cover template.
5. `decklight check` flagged the diagram colouring through generic tokens
   instead of Northwind's roles; they were mapped to roles and it passed.
6. `narrate --engine elevenlabs --voice Chris`, one clip per build step.
7. A reviewer, Sam (fictional, from a second clone), commented through the
   no-trust deck; the review came back as `review/sam-<date>`, was resolved
   with R, and K's *write it for me* wrote the commit messages.
8. `bundle --audio aac`, `pdf --handout`, `pptx`; the PDF render caught slide 4
   overflowing in print, which was fixed before the step was recorded.
9. `publish --target folder --audio aac` (from main: `--audio` is #843).

Steps 1 to 8 ran `npx decklight@latest` (0.9.0); step 9 ran this checkout.
The recordings ran in `/tmp/cache-postmortem` with `DECKLIGHT_HOME` isolated;
the hidden setup in `06-marketplace` copies `$DECKLIGHT_REPO/demo/northwind`.
The incident's details are invented, as the agent said when it wrote them.
