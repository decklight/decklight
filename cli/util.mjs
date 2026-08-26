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
/**
 * The two recorders take inputs as different as their outputs — `cast` a YAML
 * command script, `record` a deck — and the names invite the mix-up: they
 * differ by two letters and both mean "record".
 *
 * Getting it wrong used to be silent in the direction that mattered.
 * `decklight record demo.term.yaml` started a server, printed a URL and opened
 * a browser on a YAML file: no error anywhere, just a page that would never be
 * a deck. (The other way at least failed, if unhelpfully — `script has no
 * steps`, said of a perfectly good deck.)
 *
 * Returns the refusal, or null when the file is the right kind or a kind
 * neither command claims — an unusual extension is not evidence of a mistake,
 * and refusing one would break a deck somebody named `talk.htm5`.
 */
export function wrongRecorder(cmd, file) {
  const name = String(file ?? '');
  const isScript = /\.ya?ml$/i.test(name);
  const isDeck = /\.(html?|decklight)$/i.test(name);
  const wrong = (cmd === 'record' && isScript) || (cmd === 'cast' && isDeck);
  if (!wrong) return null;
  const what = isScript ? 'a terminal script, not a deck' : 'a deck, not a terminal script';
  // Both are named, because the whole reason this is worth refusing is that
  // either could have been meant — and the suggested line is the one they
  // typed, repaired, so it can be copied rather than reconstructed.
  return `${name} is ${what}.\n`
    + '  decklight cast    records a TERMINAL — a YAML command script, replayed in the deck\n'
    + "  decklight record  records YOU — your voice narrating a deck's notes\n\n"
    + `  did you mean:  decklight ${isScript ? 'cast' : 'record'} ${name}`;
}

export const scriptSafe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\u0021--');

/**
 * The banner's version, with the build's provenance when the build recorded
 * any (dist/build-info.json, written by build.mjs from `git describe`).
 *
 * `0.6.0+30.gd3307f4` — semver build-metadata syntax, so anything matching
 * "decklight 0.6.0" still matches, and the "+30" answers the question three
 * identically-named sandbox repacks in one afternoon could not: WHICH 0.6.0
 * is this? A release build (zero commits past the tag, clean) shows the
 * plain version — the tag is the whole truth there. A dirty tree says so,
 * because a build nobody can reproduce should not look like one somebody can.
 */
/**
 * `git describe --tags --long --dirty=.dirty` → {tag, commits, commit, dirty},
 * or null for anything that does not parse (no tags, not a repo, garbage).
 * Shared by build.mjs (stamping a tarball) and the banner's live path (a
 * checkout), so the two can never learn different spellings.
 */
export function parseDescribe(desc) {
  const m = /^v?(.+)-(\d+)-g([0-9a-f]+?)(\.dirty)?$/.exec(String(desc ?? '').trim());
  return m ? { tag: m[1], commits: Number(m[2]), commit: m[3], dirty: !!m[4] } : null;
}

export function versionLine(version, info) {
  if (!info || !Number.isInteger(info.commits) || !info.commit) return `decklight ${version}`;
  if (info.commits === 0 && !info.dirty) return `decklight ${version}`;
  return `decklight ${version}+${info.commits}.g${info.commit}${info.dirty ? '.dirty' : ''}`;
}
