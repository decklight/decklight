# Contributing to Decklight

Thanks for your interest in contributing! Decklight is free and open source
under the [Apache License 2.0](LICENSE), and contributions of all kinds are
welcome — bug reports, themes, docs, and code.

## Development setup

Decklight is plain JavaScript (ESM) with no runtime dependencies.

- Node.js >= 20
- `npm install` — dev dependencies (esbuild, highlight.js, marked, temml), and
  it builds `dist/` for you via the `prepare` script
- `npm test` — run the test suite (`node --test`)
- `npm run build` — bundle `src/index.js` → `dist/decklight.js`

`dist/` is build output and is **not** in git — it is derived from `src/`, so
versioning it would only buy unreviewable minified diffs and source/dist drift.
`npm install` builds it, `npm publish`/`npm pack` rebuild it, and CI rebuilds it
before both the npm release and the site deploy. It is still shipped in the npm
package (`package.json`'s `files`). If the demos under `demo/` come up blank in
a fresh checkout, you skipped `npm install`.

## The loops

An issue opened here is read, sorted, and worked on by a chain of agent loops.
Each one hands to the next through a **label**, and the labels are the only
controls: apply one by hand at any point to route, re-run, or skip a step.

```
                       issue opened
                            │
                    ┌───────▼────────┐
                    │  issue-analyzer│  is it a bug or a feature?
                    └───┬────────┬───┘
                 `bug`  │        │  `needs-spec`
                    ┌───▼──┐  ┌──▼────────────┐
                    │ bug- │  │ spec-refine   │  does it already exist?
                    │ repro│  │               │  draft the spec + mockups
                    └───┬──┘  └──┬────────────┘
      `repro-confirmed` │        │ `needs-po-review`
        / `cannot-repro`│        │
                        │     ┌──▼──────────────┐
                        │     │  YOU review it  │  edit the ticket freely
                        │     └──┬──────────────┘
                        └────────┤  you label `ready-to-dev`
                            ┌────▼────────┐
                            │ ready-to-dev│  implement, test, screenshot, PR
                            └────┬────────┘
                                 │ auto-merges on green
                    ┌────────────▼──────────┐
                    │ pr-babysitter (hourly)│  notices a stalled PR
                    └────────────┬──────────┘
                                 │ you label `fix-it`
                            ┌────▼───┐
                            │ pr-fix │  fixes what broke
                            └────────┘
```

**Nothing is built without a human.** Every path to `ready-to-dev` runs through
someone with write access applying that label — the loops before it only ever
research, propose, and gather evidence.

### issue-analyzer — triage

Every new issue gets read against the code and answered. It renders a verdict —
bug, feature, or question — applies the routing label, and starts the next loop.
Bug reports also get the checklist: which version, what error, is the repro
enough for someone else to follow, and which files are likely involved.

### bug-repro — evidence

A **`bug`** ticket gets tried, not just discussed: Claude builds current `main`,
follows the repro steps in a real browser, and reports what actually happened —
verbatim failing output, screenshots, and a hypothesis of the cause. The verdict
lands as `repro-confirmed` or `cannot-repro`. It never fixes anything; the fix is
your decision, taken with the evidence in the thread.

### spec-refine — the proposal

A **`needs-spec`** ticket gets turned into something reviewable. The loop asks
first whether the ask *already exists* (decklight is small; half of all asks are
a keypress away from something shipped), and if it doesn't, rewrites the ticket
in the house style — outcome, user flow, acceptance criteria, prior art with file
paths — and renders **mockups** of the proposed UI as real screenshots.

It ends at **`needs-po-review`**: the ticket is yours. Edit the body however you
like, then label `ready-to-dev` to queue the build — or leave your notes in a
comment and cycle `needs-spec` for another pass; the loop reads the thread and
revises rather than starting over.

### ready-to-dev — the build

A ticket labelled **`ready-to-dev`** is picked up automatically:

1. **Claude implements it** on `ticket/<n>`, having read `SPEC.md` first — a change
   that contradicts the spec is a change *to* it, and updates it in the same commit.
2. **`npm test` and `npm run verify` must pass.** `verify` drives a real headless
   browser; a test that would pass without the change is treated as a bug.
3. **It has to be seen.** The agent exercises the feature in a browser and
   screenshots it (`tools/shot.mjs`, whose `--drive` runs a snippet inside the page
   so the shot shows the *feature*, not the title slide). The driver is committed
   under `shots/` so a reviewer can see how it was exercised.
4. **A PR opens with those screenshots inline**, review requested from the Product
   Owner ([@gphilipp](https://github.com/gphilipp)).
5. **It merges itself.** Auto-merge is armed when the PR opens, so it lands as
   soon as CI goes green. A green suite says the code does what its tests say;
   only a picture says the feature is the one the ticket asked for — which is why
   the screenshots stay in the PR for him to look at, before or after it lands.

Write the ticket so step 3 is possible: the issue template asks *"how would you demo
it?"* precisely because that answer becomes the screenshot.

Kicking it off by hand: label an issue `ready-to-dev`, or run the workflow with an
issue number (`gh workflow run ready-to-dev.yml -f issue=42`).

Screenshots live on an orphan `shots` branch — evidence, never source — so a year of
PNGs never lands in the history everyone clones. Each loop keeps its own corner:
`issue-<n>/` for implementation shots, `spec-<n>/` for mockups, `bug-<n>/` for
repro evidence.

### pr-babysitter and pr-fix — after the PR opens

Every hour, **pr-babysitter** looks at the open agent PRs and comments when one
is stuck: CI red (with the error, not just the fact), a conflict with `main`, or
review comments nobody answered. A quiet hour costs nothing — no agent runs. It
only ever comments.

When a finding is worth acting on, label the PR **`fix-it`** and **pr-fix**
attempts it: it reproduces the failure on the branch, fixes the cause, and pushes
one signed-off commit. One label, one attempt — the label comes off afterwards,
so a wrong fix leaves the PR no worse than it was. It fixes the failure, never
the ticket, and never makes a test pass by weakening it.

> **Why the split?** The babysitter runs on a schedule, so nothing gates it, and
> the text it reads — comments, review threads, CI logs — is writable by anyone
> with a browser. Giving *that* trigger a shell and a push token would let a
> stranger's comment steer a commit into the repo. `fix-it` costs write access to
> apply. The schedule has no hands; the hands have no schedule.

### Label reference

| Label | Meaning |
|---|---|
| `bug` | Triage says it's a defect; the repro loop tries it |
| `needs-spec` | Feature ask queued for spec refinement |
| `repro-confirmed` / `cannot-repro` | What the repro loop found |
| `needs-po-review` | A spec is drafted and waiting on the Product Owner |
| `ready-to-dev` | Spec'd and approved — the build loop implements it |
| `in-dev` | The build loop is working on it |
| `fix-it` | Ask the pr-fix loop to attempt a fix on this PR |

## Submitting changes

1. Fork the repo and create a branch.
2. Make your change, with tests where it makes sense.
3. Make sure `npm test` and `npm run build` pass.
4. Sign off every commit (see below) and open a pull request.

## Developer Certificate of Origin (DCO)

Contributions are accepted under the Apache License 2.0. Instead of a CLA,
this project uses the [Developer Certificate of Origin](https://developercertificate.org)
(DCO): by signing off a commit you certify that you wrote the change or
otherwise have the right to submit it under the project's open source license.

Every commit in a pull request must carry a `Signed-off-by:` line matching
the commit author. Git adds it for you with the `-s` flag:

```sh
git commit -s -m "Add aurora theme"
```

which appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

A CI check enforces this on every pull request.

### Fixing a missing sign-off

- Last commit only: `git commit --amend -s --no-edit`
- Multiple commits: `git rebase --signoff origin/main`

then force-push your branch: `git push --force-with-lease`.

### DCO v1.1 text

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## License

By contributing to Decklight, you agree that your contributions will be
licensed under the [Apache License 2.0](LICENSE).
