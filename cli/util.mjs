// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Helpers shared by the CLI commands. Generic Node-CLI plumbing (argv reading,
// entry-point detection) lives in tools/args.mjs; this file is the pieces that
// are specific to *these* commands — the failure convention and the one HTML
// escape whose exact form is load-bearing.

/**
 * A command's refusal, with the message a human reads. Thrown rather than
 * printed, so that the same failure can be reported by whoever is running the
 * command — the dispatcher, a direct `node cli/bundle.mjs` run, or a test
 * calling the main function in-process.
 */
export class CommandError extends Error {
  constructor(message, command) {
    super(message);
    this.name = 'CommandError';
    this.command = command;
  }
}

/**
 * A command's failure. `makeFail('bundle')` returns a `fail` that raises
 * `decklight bundle: <msg>`.
 *
 * WHY IT THROWS INSTEAD OF EXITING. It used to call `process.exit(1)` right
 * here, which meant a command that used it could not be called in-process at
 * all: any test touching a failure path took the test runner down with it. So
 * six commands (init, skills, rec, upgrade, publish, bundle) were reachable
 * only by spawning a subprocess, while eleven newer ones returned an exit code
 * and were testable directly — two conventions, and the older one taxed every
 * test that came near it.
 *
 * Throwing keeps the property callers actually depend on — `fail()` never
 * returns, so the code after it is unreachable — and hands the decision about
 * exit codes to the boundary, where it belongs. Every existing call site sits
 * either at the top level of a main or inside a `catch`, so nothing that used
 * to exit now gets swallowed by an intervening `try`.
 */
export const makeFail = (cmd) => (msg) => { throw new CommandError(msg, cmd); };

/**
 * Print a failure the way a command does: `decklight <cmd>: <message>`.
 *
 * A `CommandError` is a refusal the command wrote for a human, so it prints as
 * itself. Anything else is a bug — a stack is the useful thing there, but not
 * as the first thing the user sees, so the message leads and the stack follows
 * only under DECKLIGHT_DEBUG. Before this, an unexpected throw reached the
 * terminal as a raw Node stack: `decklight import` greeted a Windows user with
 * `Error: ENOENT … scandir '…/space%20dir/decklight/themes'` (#275).
 */
export function reportFailure(e, cmd) {
  const name = e instanceof CommandError ? (e.command ?? cmd) : cmd;
  const where = name ? `decklight ${name}: ` : 'decklight: ';
  if (e instanceof CommandError) {
    process.stderr.write(`${where}${e.message}\n`);
    return;
  }
  process.stderr.write(`${where}${e?.message ?? e}\n`);
  if (process.env.DECKLIGHT_DEBUG) process.stderr.write(`${e?.stack ?? ''}\n`);
  else process.stderr.write('  (set DECKLIGHT_DEBUG=1 for the stack — this one is a bug, please report it)\n');
}

/**
 * Run a command main as a program: await it, turn a failure into the printed
 * message plus exit 1, and pass a returned exit code straight through. The one
 * boundary every entry point uses — `cli/decklight.mjs` for a dispatched
 * command, and each module's own `isMain` block for a direct run.
 */
export async function runMain(cmd, fn) {
  try {
    return (await fn()) ?? 0;
  } catch (e) {
    reportFailure(e, cmd);
    return 1;
  }
}

// Inline <script> content must never contain "</script" (terminates the tag)
// NOR "<!--" (flips the HTML tokenizer into script-data-escaped mode, after
// which closers mis-parse — marked's comment regexes contain it). "\/" is an
// identity escape everywhere. "<!--" is broken by rewriting the bang as a
// backslash-u0021 unicode escape, NOT as backslash-bang: the latter is fine
// in strings and flagless regexes but an INVALID escape inside u-flagged
// regexes — highlight.js composes its XML grammar's comment regex with /imu
// the first time a deck highlights language-html, which turned the old
// escape into a lazy SyntaxError. The unicode escape is valid in strings,
// templates, JSON, and regexes with or without the u flag.
export const scriptSafe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\u0021--');
