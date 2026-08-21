#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight record — capture the deck's narration in YOUR voice.
//
//   decklight record <deck.html> [--port 8788] [--dir voiceover] [--no-open]
//
// WHY THIS IS A COMMAND AND NOT JUST A KEY. The recorder itself lives in the
// deck (⇧R): it has to, because the notes, the builds and the microphone are
// all in the browser. But a browser will not open a microphone for a page it
// loaded from `file://` — getUserMedia needs a secure context, and a local file
// is not one, no matter how many times you click Allow. `http://127.0.0.1` IS
// one. So this command's whole job is to put the deck on that origin and open
// it there with the recorder up.
//
// The second half of the job is the writing. A recorded take is only useful
// next to the deck — that is the one place `narration.files` can name and the
// one place `decklight bundle` looks — and only a server that owns the deck
// file may write there. That is the edit server, which this runs, in-process:
// one command, one Ctrl-C, and the files land in the folder the deck already
// plays from.
//
// Deliberately NOT `decklight author`: recording is not editing. Git is off,
// no bridge is started, nothing is spent. You are reading your own notes aloud.

import { editMain } from './edit.mjs';
import { openUrl } from './init.mjs';
import { argReader, isMain } from '../tools/args.mjs';
import { exitWhenOrphaned } from './supervise.mjs';

const USAGE = `usage: decklight record <deck.html> [--port 8788] [--dir voiceover] [--no-open]
  serves the deck over http://127.0.0.1 and opens it with the voice recorder up

  the deck reads you its notes one ⟨CLICK⟩ beat at a time; → ends a beat, which
  both closes that file and reveals the next build — so your voice paces the
  deck exactly as it will when you present it

  --port N     port to serve on (taken? moves to the next free one)     [8788]
  --dir NAME   folder to write into, relative to the deck   [the deck's own
               narration.files, else voiceover]
  --no-open    don't launch a browser — print the URL and wait

  writes <dir>/slide-NN.wav (the whole slide) and <dir>/slide-NN-KK.wav (one
  per beat); play them back with:
      narration: { files: '<dir>', ext: 'wav', segments: true }

  a microphone needs a secure context, which is why this serves the deck rather
  than opening the file — and why ⇧R on a file:// deck says so instead of failing
`;

/**
 * The folder name the recorder should write into, or null to let the deck
 * decide from its own `narration.files`.
 *
 * Refused here rather than at the server, so a typo costs a message instead of
 * a 400 per beat halfway through a take: the same three shapes the server
 * rejects (absolute, drive-lettered, containing `..`), plus the empty string.
 */
export function dirProblem(name) {
  if (name === undefined || name === null) return null;
  if (!name || !name.trim()) return '--dir needs a folder name';
  if (name.length > 200) return '--dir is too long';
  if (/^[/\\]/.test(name) || /^[a-zA-Z]:/.test(name)) {
    return `--dir must be relative to the deck, not an absolute path (${name})`;
  }
  if (name.split(/[/\\]/).includes('..')) {
    return `--dir must stay inside the deck's own directory (${name})`;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(name)) return `--dir is a folder, not a URL (${name})`;
  return null;
}

/**
 * The URL to open: the deck, on the server that is running, with `record` set.
 *
 * `?record` rather than a fragment because the runtime reads `location.search`,
 * and rather than a separate page because the deck IS the teleprompter — you
 * record against the slides your audience will see, at the build they will see
 * them at.
 */
export function recordUrl(port, deckUrl, dir) {
  const q = dir ? `?record&dir=${encodeURIComponent(dir)}` : '?record';
  return `http://127.0.0.1:${port}${deckUrl}${q}`;
}

export async function recordMain(args, { open = openUrl, out = process.stdout, onListen = null } = {}) {
  if (args.includes('--help') || args.includes('-h') || !args.filter((a) => !a.startsWith('-')).length) {
    out.write(USAGE);
    return 0;
  }
  const { opt } = argReader(args);
  const dir = opt('--dir');
  const bad = dirProblem(dir);
  if (bad) { process.stderr.write(`decklight record: ${bad}\n`); return 2; }

  const deck = args.find((a) => !a.startsWith('-'));
  let started;
  // `--no-git`, always: recording is not editing, and a take that happens to
  // coincide with the autocommit cadence has no business creating a commit.
  await editMain([deck, '--port', String(opt('--port', 8788)), '--no-git'], {
    // the same seam editMain offers, passed through: this server outlives the
    // call (it is the whole point), so a caller that is not a terminal — a
    // test — needs a handle to close it
    onListen: (info) => { started = info; onListen?.(info); },
  });
  // editMain reports its own reason and sets process.exitCode when the deck is
  // missing or outside the served root — say nothing on top of it.
  if (!started) return process.exitCode ?? 1;

  const url = recordUrl(started.port, started.deckUrl, dir);
  out.write(`decklight record on ${url}\n`);
  out.write('  ⇧R opens the recorder · → ends a beat and reveals the next build · Esc stops\n');
  out.write(`  files land in ${dir ?? "the deck's narration folder"}, next to the deck. Ctrl-C when you are done.\n`);
  if (!args.includes('--no-open')) await open(url, { out, what: url });
  return 0;
}

if (isMain(import.meta.url)) {
  exitWhenOrphaned();
  recordMain(process.argv.slice(2)).then((code) => { if (code) process.exitCode = code; });
}
