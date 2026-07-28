# Working in this repo

`SPEC.md` is the contract, `CONTRIBUTING.md` is the process. This file is only
the things an agent gets wrong on the way there.

## Every commit must be signed off

CI enforces the [DCO](https://developercertificate.org) on every commit in a PR
(`Check sign-offs`), and it fails the whole run — a green `build · test · render`
does not save you. The `Signed-off-by:` line must match the commit author.

```sh
git commit -s            # not `git commit`
```

Forgetting it means amending and force-pushing an already-open PR, so pass `-s`
the first time. To fix a branch after the fact:

```sh
git commit --amend -s --no-edit          # one commit
git rebase --signoff origin/main         # several
```

Sign-off is a certification *by the author* that they have the right to submit
the change. It is the human's to make: if the author is not you, ask before
adding it.

## Before pushing

```sh
npm test                 # node --test test/*.test.mjs
npm run verify           # build + headless render assertions (needs Chrome)
```

`npm run verify` is what catches the things unit tests can't see — clipped
slides, contrast gates, the character overlay actually mounting. Run it for any
change to `src/` or `themes/`.

## Opening a PR

Arm auto-merge the moment you open a PR, while its checks are still pending:

```sh
gh pr merge <n> --auto
```

**`main` is behind a merge queue** — do not pass a strategy flag. `--squash`
(and `--merge`) are rejected with "the merge strategy for main is set by the
merge queue": the queue owns the strategy, and it squashes, which is what keeps
the history linear. Armed, the PR enqueues itself the instant the CI + DCO
checks go green (no required review); the queue then re-runs CI against
queued-up `main` (`merge_group`) before landing it, so a PR that raced another
one gets retested, not trusted. If the checks have already passed by the time
you get around to merging, plain `gh pr merge <n>` enqueues it directly.

## Conventions

- Commit subjects are lowercase, `area: what changed` (`tts:`, `lipsync:`,
  `character:`, `dev:`), and say the *effect*, not the file list.
- `dist/` is generated (`npm run build`) and not versioned — never hand-edit it.
- The runtime has **zero dependencies**. Anything new belongs in `tools/` or
  `cli/`, which are Node-only.
- PRs are based on `main`. Keep a bug fix and a feature in separate PRs.
- **Cite SPEC sections by mnemonic, never by chapter number.** `PRESENTING`, not
  `§8`; `SLIDE_DENSITY`, not `§1.1`. Every SPEC heading carries its mnemonic and
  the index at the top of SPEC.md lists them all. This holds everywhere — code
  comments, commit messages, PR bodies, skill files, review notes. Numbers shift
  the moment a section is inserted or split, and every reference that named one
  goes quietly wrong; a mnemonic survives the move and says what it points at.
  A new section gets a new `SCREAMING_SNAKE_CASE` mnemonic in its heading.
