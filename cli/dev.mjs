#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight dev — one command for the whole authoring loop: the edit server
// plus whichever optional bridges this machine can actually run.
//
//   decklight dev <deck.html> [--port 8788] [--tts-port 8787] [--lipsync-port 8789]
//                 [--project <id>] [--rhubarb <bin>] [--portrait <name=img.png>]…
//                 [--no-tts] [--no-lipsync]
//
// The bridges keep their OWN PROCESSES on their own ports, exactly as if you
// had started them by hand — dev only owns their lifetime, so one Ctrl-C
// stops everything. That split is the point: edit needs nothing (no
// credentials, no cost), tts holds Google credentials and spends money per
// call, lipsync pins a GPU. Folding them into one process would let a Wav2Lip
// crash or an expired token take down the server you are editing through.
//
// A bridge whose prerequisites are missing is SKIPPED with the reason and the
// fix, never a hard failure: `decklight dev deck.html` on a bare machine still
// gives you live reload and notes editing, and the player degrades on its own
// (each bridge is probed via /ping).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validProjectId } from '../tools/gemini-tts.mjs';
import { ENGINES as TTS_ENGINES } from '../tools/tts-engines.mjs';

const CLI = fileURLToPath(new URL('./decklight.mjs', import.meta.url));

const USAGE = `usage: decklight dev <deck.html> [--port 8788] [--tts-port 8787] [--lipsync-port 8789]
                    [--tts-engine gemini|chirp|piper] [--project <id>] [--no-tts] [--no-lipsync]
  brings up the edit server plus every bridge this machine can run, under one Ctrl-C

  --port N          edit server (live reload + notes write-back)      [8788]
  --tts-port N      live voice bridge                                 [8787]
  --lipsync-port N  lip-sync bridge (visemes + talking head)          [8789]
  --no-tts          don't start the voice bridge
  --no-lipsync      don't start the lip-sync bridge

  --tts-engine E    gemini  Vertex AI, best delivery, honors a style — no free tier  [default]
                    chirp   Cloud TTS Chirp 3: HD — same voices, ~1s, 1M chars/month free
                    piper   local, offline, unlimited, no project needed

  tts flags     --project <id> (or $GOOGLE_CLOUD_PROJECT; gemini/chirp only),
                --tts-model, --location, --voice, --data-dir, --lang
  lipsync flags --rhubarb <bin>, --portrait <name=img.png>…, --wav2lip-dir,
                --wav2lip-ckpt, --sadtalker-dir, --python, --cache-dir
  (all passed straight through — see decklight tts --help / lipsync --help)`;

// flags that take a value (so the deck argument can be found past them)
const VALUE_FLAGS = new Set([
  '--port', '--tts-port', '--lipsync-port', '--tts-engine', '--project', '--tts-model',
  '--location', '--voice', '--data-dir', '--lang',
  '--rhubarb', '--portrait', '--wav2lip-dir', '--wav2lip-ckpt', '--sadtalker-dir',
  '--python', '--cache-dir',
]);

/** Is `bin` runnable — an explicit path that exists, or a name on $PATH? */
export function onPath(bin, env = process.env) {
  if (!bin) return false;
  if (bin.includes('/')) return existsSync(bin);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(join(dir, bin + ext))) return true;
  }
  return false;
}

/**
 * Decide what to bring up, WITHOUT starting anything — the whole capability
 * policy in one pure function, so it can be tested without binding a port.
 * Returns { deck, run: [{name, tag, args, url}], skip: [{name, why}] }.
 */
export function planServices({ args = [], env = process.env, hasBin = onPath } = {}) {
  const opt = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
  const opts = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const has = (flag) => args.includes(flag);
  const pass = (flag) => (opt(flag) !== undefined ? [flag, opt(flag)] : []);

  // first bare token is the deck — step over flags that consume a value, so
  // `dev --port 8788 deck.html` doesn't mistake "8788" for the deck
  let deck;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) { if (VALUE_FLAGS.has(a)) i++; continue; }
    deck = a;
    break;
  }

  const run = [];
  const skip = [];

  const editPort = opt('--port', '8788');
  run.push({
    name: 'edit',
    tag: 'deck',
    args: ['edit', deck, '--port', editPort],
    url: `http://127.0.0.1:${editPort}/${deck ?? ''}`,
  });

  // live voice — the cloud engines exit without a GCP project, so don't even
  // start them; piper needs no credentials at all, only the binary
  const ttsPort = opt('--tts-port', '8787');
  const ttsEngine = opt('--tts-engine', 'gemini');
  const project = opt('--project', env.GOOGLE_CLOUD_PROJECT);
  const cloudVoice = ttsEngine === 'gemini' || ttsEngine === 'chirp';
  const ttsArgs = () => [
    'tts', '--port', ttsPort,
    ...(has('--tts-engine') ? ['--engine', ttsEngine] : []),
    ...(cloudVoice ? ['--project', project] : []),
    ...pass('--tts-model'), ...pass('--location'),
    ...pass('--voice'), ...pass('--data-dir'), ...pass('--lang'),
  ];
  if (has('--no-tts')) {
    skip.push({ name: 'voice', why: 'disabled with --no-tts' });
  } else if (!TTS_ENGINES.includes(ttsEngine)) {
    skip.push({ name: 'voice', why: `unknown --tts-engine '${ttsEngine}' — use ${TTS_ENGINES.join(', ')}` });
  } else if (ttsEngine === 'piper' && !hasBin('piper', env)) {
    skip.push({ name: 'voice', why: 'piper not on PATH — install it (uv tool install piper-tts)' });
  } else if (cloudVoice && !project) {
    skip.push({ name: 'voice', why: `${ttsEngine} needs a GCP project — pass --project <id>, set GOOGLE_CLOUD_PROJECT, or use --tts-engine piper` });
  } else if (cloudVoice && !validProjectId(project)) {
    // caught here rather than at the first narration: the bridge would start,
    // look healthy, and only fail on a keypress — with a 403 naming a project
    // nobody typed
    skip.push({ name: 'voice', why: `not a GCP project id: ${JSON.stringify(project)} — stray punctuation from a copy-paste?` });
  } else {
    run.push({ name: 'tts', tag: 'voice', args: ttsArgs(), url: `http://127.0.0.1:${ttsPort}` });
  }

  // lip-sync — starts degraded (it probes its own engines), so only bother when
  // something it can actually use is present
  const lipPort = opt('--lipsync-port', '8789');
  const rhubarb = opt('--rhubarb', 'rhubarb');
  const configured = has('--rhubarb') || has('--portrait') || has('--wav2lip-dir') || has('--sadtalker-dir');
  if (has('--no-lipsync')) {
    skip.push({ name: 'lip-sync', why: 'disabled with --no-lipsync' });
  } else if (!configured && !hasBin(rhubarb, env)) {
    skip.push({ name: 'lip-sync', why: 'rhubarb not on PATH — install it, or pass --rhubarb/--portrait' });
  } else {
    run.push({
      name: 'lipsync',
      tag: 'lips',
      args: [
        'lipsync', '--port', lipPort,
        ...(has('--rhubarb') ? ['--rhubarb', rhubarb] : []),
        ...opts('--portrait').flatMap((p) => ['--portrait', p]),
        ...pass('--wav2lip-dir'), ...pass('--wav2lip-ckpt'),
        ...pass('--sadtalker-dir'), ...pass('--python'), ...pass('--cache-dir'),
      ],
      url: `http://127.0.0.1:${lipPort}`,
    });
  }

  return { deck, run, skip };
}

const COLORS = { deck: '\x1b[36m', voice: '\x1b[35m', lips: '\x1b[33m' };
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export async function devMain(args) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }

  const { deck, run, skip } = planServices({ args });
  if (!deck) {
    console.error('decklight dev needs a deck: decklight dev <deck.html>\n');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(deck)) {
    console.error(`decklight dev: no such deck: ${deck}`);
    process.exitCode = 1;
    return;
  }

  const tty = process.stdout.isTTY;
  const paint = (tag) => (tty ? `${COLORS[tag] ?? ''}${tag.padEnd(5)}${RESET}` : `${tag.padEnd(5)}`);
  const note = (s) => (tty ? `${DIM}${s}${RESET}` : s);

  const children = new Map();
  let shuttingDown = false;

  // Children write their own startup/progress lines; prefix each so three
  // servers in one terminal stay readable.
  const pipe = (stream, tag, out) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(`${paint(tag)} ${line}\n`);
    });
  };

  for (const svc of run) {
    const child = spawn(process.execPath, [CLI, ...svc.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.set(svc.name, child);
    pipe(child.stdout, svc.tag, process.stdout);
    pipe(child.stderr, svc.tag, process.stderr);

    child.on('exit', (code) => {
      children.delete(svc.name);
      if (shuttingDown) return;
      if (svc.name === 'edit') {
        // the deck server is the one service dev cannot run without
        console.error(`${paint(svc.tag)} exited (${code}) — stopping decklight dev`);
        shutdown(code ?? 1);
      } else {
        console.error(`${paint(svc.tag)} exited (${code}) — carrying on without it; the deck degrades on its own`);
      }
    });
  }

  for (const s of skip) console.log(note(`  ${s.name.padEnd(8)} skipped — ${s.why}`));
  console.log(note('  Ctrl-C stops everything.\n'));

  function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children.values()) child.kill('SIGTERM');
    // give them a beat to close their listeners, then go
    setTimeout(() => {
      for (const child of children.values()) child.kill('SIGKILL');
      process.exit(code);
    }, 500).unref();
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
}

if (import.meta.url === `file://${process.argv[1]}`) devMain(process.argv.slice(2));
