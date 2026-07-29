// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Outliving your parent is the one way a decklight server leaks.
 *
 * `author` runs the deck server and the bridges as child processes and reaps
 * them on its way out — but only for the signals it can catch. SIGKILL it (a
 * test harness, the OOM killer, an impatient `kill -9`) and author vanishes
 * with no chance to pass the signal on: the servers are reparented to init and
 * go on holding their ports, and the next `decklight author` finds a port
 * taken by something nobody remembers starting.
 *
 * The fix is a channel the OS closes for us. author opens a pipe to each
 * child's stdin and never writes a byte to it; the child reads it and exits at
 * EOF. However author dies, the write end dies with it and every child hears
 * about it at once — no polling, no pid to watch, no signal to catch, and
 * nothing for a dying parent to remember to do.
 *
 * Opt-in, because stdin means something else to a server you started
 * yourself: `node cli/edit.mjs deck.html < /dev/null` would EOF immediately,
 * and a terminal never EOFs at all. author sets LEASH in the child's
 * environment; only then does anything here read stdin.
 */

/** Set to '1' by a supervising parent in the child's environment. */
export const LEASH = 'DECKLIGHT_PARENT_PIPE';

/** Is this process on a parent's leash? */
export const onLeash = (env = process.env) => env[LEASH] === '1';

/** The environment a supervising parent hands a child. */
export const leashEnv = (env = process.env) => ({ ...env, [LEASH]: '1' });

/**
 * Exit when the supervising parent goes away. A no-op when unsupervised, so
 * the dispatcher can call it unconditionally. Returns whether it armed.
 *
 * stdin is resumed (nothing else is reading it, so without a consumer the
 * `end` never arrives) and then unref'd, so holding the leash cannot by itself
 * keep a command alive that would otherwise have finished.
 */
export function exitWhenOrphaned({
  env = process.env,
  stdin = process.stdin,
  exit = (code) => process.exit(code),
} = {}) {
  if (!onLeash(env)) return false;
  // An orphan is not a failure — the parent asked for this by dying.
  const done = () => exit(0);
  stdin.on('end', done);
  stdin.on('close', done);
  stdin.on('error', done); // a broken pipe says the same thing as EOF
  stdin.resume();
  stdin.unref?.();
  return true;
}
