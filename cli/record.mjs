#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight narrate --mic — capture the deck's narration in YOUR voice.
//
//   decklight narrate --mic <deck.html> [--port 8788] [--dir voices/me] [--no-open]
//
// WHY THIS IS A COMMAND AND NOT JUST A KEY. The recorder itself lives in the
// deck (V → Record this deck… → With your voice…): it has to, because the notes, the builds and the microphone are
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
// Deliberately NOT `decklight <deck>`: recording is not editing. Git is off,
// no bridge is started, nothing is spent. You are reading your own notes aloud.

import { editMain } from './edit.mjs';
import { openUrl } from './open-browser.mjs';
import { argReader, firstPositional, isMain } from '../tools/args.mjs';
import { runMain, wrongRecorder } from './util.mjs';
import { exitWhenOrphaned } from './supervise.mjs';

const USAGE = `usage: decklight narrate --mic <deck.html> [--port 8788] [--dir voices/me] [--slides a-b [--beats k-l]] [--countdown N] [--remote] [--no-open]
  serves the deck over http://127.0.0.1 and opens it with the voice recorder up

  the deck reads you its notes one [click] beat at a time; → ends a beat, which
  both closes that file and reveals the next build — so your voice paces the
  deck exactly as it will when you present it

  --port N     port to serve on (taken? moves to the next free one)     [8788]
  --dir NAME   folder to write into, relative to the deck          [voices/me]
  --slides a-b re-record only this range (1-based, inclusive; "7" for one
               slide). Every other slide's files are left untouched, so a
               fluffed beat costs one slide and not the whole deck
  --beats k-l  with --slides naming one slide: re-record only these beats of it
               ("3" for one). The other beats' files are left byte for byte, and
               slide-NN.wav is rebuilt from all of them. The recorder's card can
               also start from any beat: ← → pick it before you press Enter
  --countdown N  seconds of count-in before each take, 0 for none (0-9)
               [the recorder card's count-in: 3 s, 1 s or off, remembered]
  --remote     the phone remote too, so recording needs no keyboard: its next
               ends a beat and its retake redoes one, and a tap is not in the
               take the way a keystroke is. The recorder's card shows the QR;
               off this machine only the remote answers, as with decklight <deck> --remote
  --no-open    don't launch a browser — print the URL and wait

  writes <dir>/slide-NN.wav (the whole slide) and <dir>/slide-NN-KK.wav (one
  per beat); play them back with:
      narration: { files: '<dir>', ext: 'wav', segments: true }
  (the same one-track form decklight narrate prints; several tracks are a
  list of the same fields, each with a label)

  a microphone needs a secure context, which is why this serves the deck rather
  than opening the file — and why the recorder on a file:// deck says so instead of failing
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
export function recordUrl(port, deckUrl, dir, slides, beats, countdown) {
  const q = ['record',
    ...(dir ? [`dir=${encodeURIComponent(dir)}`] : []),
    ...(slides ? [`slides=${encodeURIComponent(slides)}`] : []),
    ...(beats ? [`beats=${encodeURIComponent(beats)}`] : []),
    ...(countdown != null ? [`countdown=${countdown}`] : [])].join('&');
  return `http://127.0.0.1:${port}${deckUrl}?${q}`;
}

/**
 * `7` or `3-9` → itself; anything else → a message.
 *
 * The deck's own slide count is not known here (the browser has it), so this
 * checks the SHAPE and leaves the bounds to the runtime, which simply records
 * the slides that exist in range. A range past the end records nothing and
 * says so on the card, which is a better answer than a CLI refusing to start.
 */
export function slidesProblem(range) {
  if (range === undefined || range === null) return null;
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(range).trim());
  if (!m) return `--slides must be a-b or a single slide number (got "${range}")`;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (from < 1) return '--slides is 1-based — there is no slide 0';
  if (to < from) return `--slides ${range} ends before it starts`;
  return null;
}

/**
 * `3` or `3-4` with `--slides` naming one slide → null; anything else → a
 * message. Beats are counted per slide, so a range of slides has no beat 3 to
 * name. Whether the slide HAS that many beats is the runtime's to say (it
 * reads the notes), and the card says it with the count.
 */
export function beatsProblem(beats, slides) {
  if (beats === undefined || beats === null) return null;
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(beats).trim());
  if (!m) return `--beats must be k-l or a single beat number (got "${beats}")`;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (from < 1) return '--beats is 1-based — there is no beat 0';
  if (to < from) return `--beats ${beats} ends before it starts`;
  const one = /^(\d+)(?:-(\d+))?$/.exec(String(slides ?? '').trim());
  if (!one || (one[2] && one[2] !== one[1])) {
    return `--beats needs --slides to name one slide, since beats are counted per slide (--slides 6 --beats ${beats})`;
  }
  return null;
}

/** `--countdown`: whole seconds, 0 to 9; anything else → a message. */
export function countdownProblem(value) {
  if (value === undefined || value === null) return null;
  return /^\d$/.test(String(value).trim()) ? null : `--countdown is whole seconds from 0 (none) to 9 (got "${value}")`;
}

export async function recordMain(args, { open = openUrl, out = process.stdout, onListen = null } = {}) {
  if (args.includes('--help') || args.includes('-h') || !args.filter((a) => !a.startsWith('-')).length) {
    out.write(USAGE);
    return 0;
  }
  const { opt } = argReader(args);
  const dir = opt('--dir');
  const slides = opt('--slides');
  const beats = opt('--beats');
  const countdown = opt('--countdown');
  for (const bad of [dirProblem(dir), slidesProblem(slides), beatsProblem(beats, slides), countdownProblem(countdown)]) {
    if (bad) { process.stderr.write(`decklight narrate --mic: ${bad}\n`); return 2; }
  }

  const deck = firstPositional(args, ['--dir', '--slides', '--beats', '--countdown', '--port']);
  // Before the server, not after: this used to serve the YAML file, print a
  // URL and open a browser on it, with no error anywhere.
  const mixedUp = wrongRecorder('narrate', deck);
  if (mixedUp) { process.stderr.write(`decklight narrate --mic: ${mixedUp}\n`); return 2; }
  let started;
  // `--no-git`, always: recording is not editing, and a take that happens to
  // coincide with the autocommit cadence has no business creating a commit.
  // `--remote` passes through untouched: the edit server owns the LAN
  // listener, the token and the line that prints its URL (NO_TRUST#REMOTE).
  const remote = args.includes('--remote');
  await editMain([deck, '--port', String(opt('--port', 8788)), '--no-git', ...(remote ? ['--remote'] : [])], {
    // the same seam editMain offers, passed through: this server outlives the
    // call (it is the whole point), so a caller that is not a terminal — a
    // test — needs a handle to close it
    onListen: (info) => { started = info; onListen?.(info); },
  });
  // editMain reports its own reason and sets process.exitCode when the deck is
  // missing or outside the served root — say nothing on top of it.
  if (!started) return process.exitCode ?? 1;

  const url = recordUrl(started.port, started.deckUrl, dir, slides, beats, countdown == null ? null : Number(countdown));
  out.write(`decklight narrate --mic on ${url}\n`);
  out.write('  V → Record this deck… → With your voice… opens the recorder · → ends a beat and reveals the next build · Esc stops\n');
  if (remote) out.write('  the phone remote is on: scan the QR on the recorder\'s card; next ends a beat, retake redoes it\n');
  out.write(`  files land in ${dir ?? 'voices/me'}, next to the deck.`
    + `${dir ? '' : ' Recording again refreshes it.'}`
    + `${slides ? ` Only slide${/-/.test(slides) ? 's' : ''} ${slides}${beats ? `, beat${/-/.test(beats) ? 's' : ''} ${beats}` : ''}.` : ''}`
    + ' Ctrl-C when you are done.\n');
  if (!args.includes('--no-open')) await open(url, { out, what: url });
  return 0;
}

if (isMain(import.meta.url)) {
  exitWhenOrphaned();
  process.exitCode = await runMain('record', () => recordMain(process.argv.slice(2)));
}
