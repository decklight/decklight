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

## Conventions

- Commit subjects are lowercase, `area: what changed` (`tts:`, `lipsync:`,
  `character:`, `dev:`), and say the *effect*, not the file list.
- `dist/` is generated (`npm run build`) and not versioned — never hand-edit it.
- The runtime has **zero dependencies**. Anything new belongs in `tools/` or
  `cli/`, which are Node-only.
- PRs are based on `main`. Keep a bug fix and a feature in separate PRs.
