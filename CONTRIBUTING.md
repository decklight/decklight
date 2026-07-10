# Contributing to Decklight

Thanks for your interest in contributing! Decklight is free and open source
under the [Apache License 2.0](LICENSE), and contributions of all kinds are
welcome — bug reports, themes, docs, and code.

## Development setup

Decklight is plain JavaScript (ESM) with no runtime dependencies.

- Node.js >= 20
- `npm install` — dev dependencies (esbuild, highlight.js, marked)
- `npm test` — run the test suite (`node --test`)
- `npm run build` — bundle `src/index.js` → `dist/decklight.js`

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
