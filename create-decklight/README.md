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

Why a separate package: `npm create` is the command people already reach for
to start a project, and this is a one-line shim behind it. It always runs
`decklight@latest`, a tag npx re-resolves against the registry on every run,
so a decklight installed in your project or globally never stands in for the
current release (a bare `npx decklight` would run that installed copy, however
old). And one folder name does what `npx decklight@latest init "My Talk" --dir
my-talk` spells out. Nothing else lives here; the project is
[decklight](https://github.com/decklight/decklight).
