// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Every decision test/soak.mjs makes about the operating system it is running
// on, in one place and pure over an injected `platform`.
//
// It is a separate module for one reason: the soak is a SCRIPT — importing it
// runs the journey — so nothing can unit-test what is inside it. And the
// Windows branches are precisely what this machine can never execute, which is
// the tools/local-voice.mjs argument verbatim: "the whole point is branching on
// an operating system that CI is not running". A branch nothing can reach is a
// branch nobody can check, which is how tools/chrome.mjs came to have no
// Windows paths at all.
//
// So the platform logic lives here, test/soak-platform.test.mjs reaches all of
// it from any machine, and the soak keeps only the parts that need a real
// filesystem and a real process.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The installed CLI, as a spawnable command.
 *
 * npm writes THREE shims into node_modules/.bin on Windows — `decklight`
 * (a shell script for MSYS/Cygwin), `decklight.cmd` and `decklight.ps1` — and
 * the extensionless one is the only one Windows itself will not execute. So the
 * soak names the `.cmd`, and `shell` says how it must be spawned: since the
 * CVE-2024-27980 fix, Node refuses to spawn a `.cmd` without a shell, and the
 * failure is an opaque EINVAL rather than anything that names the cause.
 *
 * Driving the shim rather than `node node_modules/decklight/cli/decklight.mjs`
 * is deliberate — the shim IS part of what "installed the package" means, and
 * it is the half a `bin` field regression breaks.
 */
export function cliCommand(project, platform = process.platform) {
  const bin = join(project, 'node_modules', '.bin', platform === 'win32' ? 'decklight.cmd' : 'decklight');
  return { bin, shell: platform === 'win32' };
}

/** Same story for npm itself: `npm` is a shell script, `npm.cmd` is the program. */
export function npmCommand(platform = process.platform) {
  return { bin: platform === 'win32' ? 'npm.cmd' : 'npm', shell: platform === 'win32' };
}

/**
 * A local directory as a git URL.
 *
 * `file://${dir}` is fine on POSIX and wrong on Windows twice over: a drive
 * letter needs a third slash (`file:///C:/…`) and backslashes are not path
 * separators in a URL. pathToFileURL knows both, and also percent-encodes the
 * space this soak deliberately puts in its paths.
 */
export const gitFileUrl = (dir) => pathToFileURL(dir).href;

/**
 * An offline speech synthesiser to MAKE narration with — not decklight's own
 * TTS, which needs an engine and a key.
 *
 * macOS has `say`; Windows has SAPI, which is a .NET API with no speech CLI in
 * front of it, so it is reached through PowerShell exactly as
 * tools/local-voice.mjs reaches it. Both write a WAV the soak then encodes.
 * Anywhere else there is nothing to narrate with and the leg skips — silence
 * pretending to be a voice is the one outcome that would make the step
 * meaningless.
 */
export function narrator(platform = process.platform) {
  if (platform === 'darwin') return { kind: 'say', bin: 'say', ext: 'aiff' };
  if (platform === 'win32') return { kind: 'sapi', bin: 'powershell.exe', ext: 'wav' };
  return null;
}

/** The argv that writes `text` to `out` with the platform's synthesiser. */
export function narrateArgs(platform, out, text) {
  const n = narrator(platform);
  if (!n) throw new Error(`no offline synthesiser on ${platform}`);
  if (n.kind === 'say') return [n.bin, ['-o', out, text]];
  // -NoProfile so a slow user profile cannot hang the step; single quotes are
  // PowerShell's literal string, and doubling escapes one inside.
  return [n.bin, ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Speech; '
    + `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; `
    + `$s.SetOutputToWaveFile('${out.replaceAll("'", "''")}'); `
    + `$s.Speak('${text.replaceAll("'", "''")}'); $s.Dispose()`]];
}

/**
 * Is this a platform the soak has actually been run on?
 *
 * Windows support here is written, unit-tested and NEVER EXECUTED — there is no
 * Windows machine behind it. Saying so in the run's own output is the honest
 * alternative to either refusing to run or implying it is proven.
 */
export const unverifiedPlatform = (platform = process.platform) => platform === 'win32';
