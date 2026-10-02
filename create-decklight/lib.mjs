// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `npm create decklight my-talk` → `decklight init --dir my-talk "My Talk"`.
 *
 * npm's `create` convention takes a DIRECTORY; `decklight init` takes a TITLE.
 * The directory names the title — `my-talk` is "My Talk", `q3-review` is "Q3
 * Review" — and anything else on the line passes straight through to init, so
 * `npm create decklight my-talk -- --no-git` still means what it says.
 */
export function titleFromDir(dir) {
  const base = String(dir ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const words = base.split(/[-_\s]+/).filter(Boolean);
  if (!words.length) return 'My Deck';
  // only an all-lowercase word is capitalised: `iOS` and `KubeCon` are spelled that way on purpose
  return words.map((w) => (/^[a-z][a-z0-9]*$/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

export function initArgs(argv = []) {
  const rest = argv.filter((a) => a !== '--');
  const i = rest.findIndex((a) => !a.startsWith('-'));
  if (i === -1) return ['init', ...rest];
  const dir = rest[i];
  const others = rest.filter((_, j) => j !== i);
  return ['init', '--dir', dir, titleFromDir(dir), ...others];
}

/** The command that runs the CURRENT decklight — never a cached one (SPEC REPO_LAYOUT). */
export function npxCommand(platform = process.platform) {
  return platform === 'win32'
    ? { cmd: 'npx.cmd', shell: true }
    : { cmd: 'npx', shell: false };
}

/**
 * The environment the inner npx runs in: ours, minus what the OUTER `npm exec`
 * left in it. `npm create decklight` runs this shim through `npm exec
 * --package=create-decklight`, which exports that as `npm_config_package` —
 * and an npx that inherits it runs inside create-decklight again, where
 * `decklight@latest` is not a package to fetch but a command to look for:
 * "sh: decklight@latest: command not found". `npm_config_call` is the same
 * kind of leftover. Matched without case: Windows environments are.
 */
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^npm_config_(package|call)$/i.test(k)));
}
