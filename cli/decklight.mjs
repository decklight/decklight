#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight — the Decklight command line.
 *
 * This file is the boundary and nothing else: it prints the banner, reads the
 * command name, and hands the rest of argv to the command's main. The roster
 * of commands — which module, which export, and the help text — lives in
 * cli/commands.mjs, so adding a command is one row and one paragraph there.
 * Every command module is also runnable directly (`node cli/bundle.mjs …`).
 */

import { readFileSync, existsSync } from 'node:fs';
import { versionLine, parseDescribe } from './util.mjs';
import { GLOBAL_HELP, resolveCommand } from './commands.mjs';


function globalHelp(exitCode = 0) {
  process.stdout.write(GLOBAL_HELP);
  process.exit(exitCode);
}

const argv = process.argv.slice(2);
let cmd = argv[0];
let rest = argv.slice(1);

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
// which BUILD of that version — commits past the release tag and the sha.
// TWO sources, strictly ordered: a git CHECKOUT answers live (one ~10ms
// describe, dev machines only), because the stamped dist/build-info.json
// describes the tree at BUILD time and dist/ survives `git checkout` — a
// stale stamp once named the feature-branch build while main was the thing
// actually running, which is the exact misdirection this banner exists to
// prevent. A tarball ships no .git, pays nothing, and reads the stamp its
// build froze beside the code — there the two cannot diverge.
let buildInfo = null;
if (existsSync(new URL('../.git', import.meta.url))) {
  try {
    const { execFileSync } = await import('node:child_process');
    buildInfo = parseDescribe(execFileSync('git', ['describe', '--tags', '--long', '--dirty=.dirty'],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { buildInfo = null; }   // a tagless clone: plain is the whole truth
} else {
  try { buildInfo = JSON.parse(readFileSync(new URL('../dist/build-info.json', import.meta.url), 'utf8')); }
  catch { buildInfo = null; }
}
const banner = versionLine(version, buildInfo);

if (!cmd || cmd === '--help' || cmd === '-h') globalHelp();
// A newer decklight than the one npx pinned (#314). Read from a cache the last
// run left behind — never a fetch on this path — and written to stderr like the
// banner below, for the same reason: piped output stays clean.
const { updateNotice, refreshInBackground } = await import('./update-check.mjs');
const notice = updateNotice(version);
refreshInBackground();

if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  process.stdout.write(`${banner}\n`);
  if (notice) process.stderr.write(`${notice}\n`);
  process.exit(0);
}
if (cmd === 'help') {
  if (!rest[0]) globalHelp();
  cmd = rest[0];
  rest = ['--help'];
}

// every real command announces the version it runs as — on stderr, so piped
// output (export, bundle) stays clean.
//
// EXCEPT under author, which spawns this same CLI two or three times: the
// parent has already said which version everything runs as, and repeating it
// once per child was the first third of author's startup wall.
if (!process.env.DECKLIGHT_BANNER) {
  process.stderr.write(`${banner}\n`);
  if (notice) process.stderr.write(`${notice}\n`);
}

// When a parent supervises us (author runs the deck server and the bridges), go when it
// goes — a SIGKILLed parent never gets to reap its children. No-op otherwise.
const { exitWhenOrphaned } = await import('./supervise.mjs');
exitWhenOrphaned();

// The first-party marketplace is REGISTERED on first run, never fetched
// (SPEC MARKETPLACE_REGISTRY): this writes two files under ~/.decklight/ and
// touches nothing else — offline first run is silent and instant. A config
// home that cannot be written must never cost a command.
try {
  const { ensureFirstPartyRegistered } = await import('./marketplace.mjs');
  ensureFirstPartyRegistered();
} catch { /* registration is a courtesy, not a dependency */ }

// ONE ERROR BOUNDARY FOR EVERY COMMAND. A command refuses by throwing a
// CommandError (cli/util.mjs) and it is printed here, once, in the shape
// commands have always printed: `decklight <cmd>: <message>`. Anything else
// reaching this point is a bug rather than a refusal, and prints as a message
// with the stack behind DECKLIGHT_DEBUG — never as the raw Node stack a user
// used to get (`decklight import` did exactly that on any install path with a
// space in it, #275).
const command = resolveCommand(cmd);
if (!command) {
  process.stderr.write(`decklight: unknown command "${cmd}"\n\n`);
  globalHelp(1);
}
try {
  if (command.spawn) {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const script = fileURLToPath(new URL(command.spawn, import.meta.url));
    const r = spawnSync(process.execPath, [script, ...rest], { stdio: 'inherit' });
    process.exitCode = r.status ?? 1;
  } else {
    const mod = await import(new URL(command.module, import.meta.url));
    const code = await mod[command.main](...(command.args ? command.args(rest, cmd) : [rest]));
    // A main that returns a number is naming its exit code; one that returns
    // nothing exits 0 unless it threw. Both conventions exist today, and this
    // is the one place that has to know.
    if (typeof code === 'number') process.exitCode = code;
  }
} catch (e) {
  const { reportFailure } = await import('./util.mjs');
  reportFailure(e, cmd);
  process.exitCode = 1;
}
