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

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { onPath, detectAgents } from './agents.mjs';

export { onPath }; // historical home — dev grew it, agents.mjs owns it now

const CLI = fileURLToPath(new URL('./decklight.mjs', import.meta.url));

const USAGE = `usage: decklight dev <deck.html> [--port 8788] [--tts-port 8787] [--lipsync-port 8789]
                    [--project <id>] [--no-tts] [--no-lipsync]
                    [--git | --no-git] [--commit-every <s>] [--agent <name>]
  brings up the edit server plus every bridge this machine can run, under one Ctrl-C

  --port N          edit server (live reload + edit write-back)       [8788]
  --tts-port N      live voice bridge                                 [8787]
  --lipsync-port N  lip-sync bridge (visemes + talking head)          [8789]
  --no-tts          don't start the voice bridge
  --no-lipsync      don't start the lip-sync bridge
  --git / --no-git  auto-commit the deck on a cadence / never touch git
                    (no repo + no flag: dev ASKS whether to create one)
  --commit-every N  autocommit cadence in seconds                     [300]
  --agent <name>    preferred AI agent for A (default: first detected)

  tts flags     --project <id> (or $GOOGLE_CLOUD_PROJECT), --tts-model, --location
  lipsync flags --rhubarb <bin>, --portrait <name=img.png>…, --wav2lip-dir,
                --wav2lip-ckpt, --sadtalker-dir, --python, --cache-dir
  (all passed straight through — see decklight tts --help / lipsync --help)`;

// flags that take a value (so the deck argument can be found past them)
const VALUE_FLAGS = new Set([
  '--port', '--tts-port', '--lipsync-port', '--project', '--tts-model', '--location',
  '--rhubarb', '--portrait', '--wav2lip-dir', '--wav2lip-ckpt', '--sadtalker-dir',
  '--python', '--cache-dir', '--commit-every', '--agent',
]);

/**
 * Decide what to bring up, WITHOUT starting anything — the whole capability
 * policy in one pure function, so it can be tested without binding a port.
 * Returns { deck, run: [{name, tag, args, url}], skip: [{name, why}],
 * agents: [names the machine can run] }.
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
    args: ['edit', deck, '--port', editPort,
      ...(has('--git') ? ['--git'] : []), ...(has('--no-git') ? ['--no-git'] : []),
      ...pass('--commit-every'), ...pass('--agent')],
    url: `http://127.0.0.1:${editPort}/${deck ?? ''}`,
  });

  // live voice — the bridge exits without a GCP project, so don't even start it
  const ttsPort = opt('--tts-port', '8787');
  const project = opt('--project', env.GOOGLE_CLOUD_PROJECT);
  if (has('--no-tts')) {
    skip.push({ name: 'voice', why: 'disabled with --no-tts' });
  } else if (!project) {
    skip.push({ name: 'voice', why: 'no GCP project — pass --project <id> or set GOOGLE_CLOUD_PROJECT' });
  } else {
    run.push({
      name: 'tts',
      tag: 'voice',
      args: ['tts', '--port', ttsPort, '--project', project, ...pass('--tts-model'), ...pass('--location')],
      url: `http://127.0.0.1:${ttsPort}`,
    });
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

  return { deck, run, skip, agents: detectAgents({ env, hasBin }).map((a) => a.name) };
}

/** Is `dir` inside a git work tree? (execFile injectable for tests) */
export function inGitRepo(dir, exec = execFileSync) {
  try {
    return exec('git', ['rev-parse', '--is-inside-work-tree'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === 'true';
  } catch { return false; }
}

const COLORS = { deck: '\x1b[36m', voice: '\x1b[35m', lips: '\x1b[33m' };
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export async function devMain(args) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }

  let plan = planServices({ args });
  const deck = plan.deck;
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

  // No repo, no flag: offer one. A repo is where the regular autocommits go —
  // the durable record behind the player's fast undo/redo loop. Only a TTY
  // can be asked; headless runs stay git-less until --git says otherwise.
  if (!args.includes('--git') && !args.includes('--no-git') && !inGitRepo(process.cwd())) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('  no git repository here — create one and auto-commit the deck as you edit? [Y/n] ');
      rl.close();
      if (!/^n/i.test(answer.trim())) plan = planServices({ args: [...args, '--git'] });
      else plan = planServices({ args: [...args, '--no-git'] });
    } else {
      console.log('  git: no repository here — pass --git to create one and auto-commit the deck');
    }
  }
  const { run, skip, agents } = plan;

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
  if (!agents.length) console.log(note('  agents   none detected — install claude, codex, or bob to ask an agent from the deck (A)'));
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
