# create-decklight

```sh
npm create decklight my-talk
```

That runs the latest `decklight init` in a new `my-talk` directory, with the
title taken from the directory name ("My Talk"). Anything after `--` goes to
`init` unchanged:

```sh
npm create decklight q3-review -- --no-git --themes fjord
```

Why a separate package: `npx decklight` reuses whatever version npx unpacked
the first time you ran it, so the first version you try is the one you keep.
`npm create` always fetches the latest `create-*` package, and this one is a
one-line shim that runs `decklight@latest`. Nothing else lives here; the
project is [decklight](https://github.com/decklight/decklight).
