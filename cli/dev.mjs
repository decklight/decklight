#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight author — one command for the whole authoring loop: the edit
// server plus whichever optional bridges this machine can actually run.
// (`decklight dev` is its permanent hidden alias, from before the rename.)
//
//   decklight author <deck.html> [--port 8788] [--tts-port 8787] [--lipsync-port 8789]
//                    [--project <id>] [--rhubarb <bin>] [--portrait <name=img.png>]…
//                    [--no-tts] [--no-lipsync]
//
// The bridges keep their OWN PROCESSES on their own ports, exactly as if you
// had started them by hand — author only owns their lifetime, so one Ctrl-C
// stops everything. That split is the point: the edit server needs nothing (no
// credentials, no cost), tts holds Google credentials and spends money per
// call, lipsync pins a GPU. Folding them into one process would let a Wav2Lip
// crash or an expired token take down the server you are editing through.
//
// A bridge whose prerequisites are missing is SKIPPED with the reason and the
// fix, never a hard failure: `decklight author deck.html` on a bare machine
// still gives you live reload and notes editing, and the player degrades on
// its own (each bridge is probed via /ping).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { onPath, detectAgents } from './agents.mjs';
import { validProjectId } from '../tools/gemini-tts.mjs';
import {
  ENGINES as TTS_ENGINES, PIPER_DEFAULT_VOICE, piperModelDir, piperModelPath,
  piperDownloadCmd, piperDownloadLine,
} from '../tools/tts-engines.mjs';
import { KEY_ENV as ELEVENLABS_KEY_ENV } from '../tools/elevenlabs-tts.mjs';
import { loadTtsConfig, runSetupWizard } from '../tools/tts-setup.mjs';
import { detectLocalVoice, OLLAMA_NOTE } from '../tools/local-voice.mjs';
import { argReader, isMain } from '../tools/args.mjs';
import { isPortOpen, resolvePortConflict } from './port-conflict.mjs';
import { leashEnv } from './supervise.mjs';

const CLI = fileURLToPath(new URL('./decklight.mjs', import.meta.url));
// The deck server's entry since `edit` stopped being a command: its module,
// run directly. The dispatcher would refuse `edit` out loud.
const EDIT = fileURLToPath(new URL('./edit.mjs', import.meta.url));

const USAGE = `usage: decklight author <deck.html> [--port 8788] [--tts-port 8787] [--lipsync-port 8789]
                    [--tts-engine gemini|chirp|piper|elevenlabs] [--project <id>] [--no-tts]
                    [--git | --no-git] [--commit-every <s>] [--agent <name>]
  brings up the edit server plus every bridge this machine can run, under one Ctrl-C

  --port N          edit server (live reload + edit write-back)       [8788]
                    (taken already? author offers to take over that session
                    on a TTY, or moves to the next free port otherwise)
  --tts-port N      live voice bridge                                 [8787]
  --lipsync-port N  lip-sync bridge (visemes + talking head)          [8789]
  --no-tts          don't start the voice bridge
  --no-lipsync      don't start the lip-sync bridge
  --git / --no-git  auto-commit the deck on a cadence / never touch git
  --git-mode M      when to commit: timer (a cadence), agent (one commit per
                    agent edit, with the agent's own message), off     [timer]
                    (no repo + no flag: author ASKS whether to create one)
  --commit-every N  autocommit cadence in seconds                     [300]
  --agent <name>    preferred AI agent for A (default: first detected)

  every server binds 127.0.0.1; for a phone remote: decklight present --remote

  --tts-engine E    gemini  Vertex AI, best delivery, honors a style — no free tier  [default]
                    chirp   Cloud TTS Chirp 3: HD — same voices, ~1s, 1M chars/month free
                    piper   local, offline, unlimited, no project needed
                    elevenlabs  your own account's voices, the ones you cloned first
                            in the picker — needs $ELEVENLABS_API_KEY
                    (nothing configured? on a terminal author offers a one-time
                    guided setup; decklight tts --setup re-runs it)

  tts flags     --project <id> (or $GOOGLE_CLOUD_PROJECT; gemini/chirp only),
                --tts-model, --location, --voice, --data-dir, --lang,
                --tts-format pcm|mp3 (elevenlabs)
  lipsync flags --rhubarb <bin>, --portrait <name=img.png>…, --wav2lip-dir,
                --wav2lip-ckpt, --sadtalker-dir, --python, --cache-dir,
                --veo (animate the portrait once through Vertex — BILLED),
                --veo-project, --veo-model, --veo-seconds, --veo-face-y
  (all passed straight through — see decklight tts --help / lipsync --help)`;

// flags that take a value (so the deck argument can be found past them)
const VALUE_FLAGS = new Set([
  '--port', '--tts-port', '--lipsync-port', '--tts-engine', '--project', '--tts-model',
  '--location', '--voice', '--data-dir', '--lang', '--tts-format',
  '--rhubarb', '--portrait', '--wav2lip-dir', '--wav2lip-ckpt', '--sadtalker-dir',
  '--python', '--cache-dir', '--commit-every', '--agent', '--git-mode',
  '--veo-project', '--veo-model', '--veo-seconds', '--veo-prompt', '--veo-location', '--veo-face-y',
]);

/**
 * Decide what to bring up, WITHOUT starting anything — the whole capability
 * policy in one pure function, so it can be tested without binding a port.
 * `saved` is the machine-level tts config (~/.config/decklight/tts.json,
 * written by the setup wizard) — injected, not read here, so the plan stays
 * pure; precedence is flags > environment > saved config > built-in default.
 * Returns { deck, run: [{name, tag, entry, args, url}], skip: [{name, why}],
 * agents: [names the machine can run] } — `entry` is the script to spawn:
 * the bridges go through the dispatcher, the edit server (no longer a
 * command there) runs its own module.
 */
export function planServices({
  args = [], env = process.env, hasBin = onPath, saved = null,
  detect = detectLocalVoice, ollama = false, exists = existsSync,
} = {}) {
  const { opt, opts } = argReader(args);
  const has = (flag) => args.includes(flag);
  const pass = (flag) => (opt(flag) !== undefined ? [flag, opt(flag)] : []);

  // first bare token is the deck — step over flags that consume a value, so
  // `author --port 8788 deck.html` doesn't mistake "8788" for the deck
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
    entry: EDIT,
    args: [deck, '--port', editPort,
      ...(has('--git') ? ['--git'] : []), ...(has('--no-git') ? ['--no-git'] : []),
      ...pass('--commit-every'), ...pass('--agent'), ...pass('--git-mode')],
    url: `http://127.0.0.1:${editPort}/${deck ?? ''}`,
  });

  // live voice — an engine that would exit for want of a credential should not
  // be started at all: the Google ones need a project, ElevenLabs needs a key,
  // and piper needs neither, only the binary
  const ttsPort = opt('--tts-port', '8787');
  const project = opt('--project', env.GOOGLE_CLOUD_PROJECT ?? saved?.project);

  // Nothing chosen, nothing saved, no cloud credential: rather than default to
  // an engine that will be skipped for want of a project, ask the machine what
  // it can already say. Every desktop OS ships a synthesizer, and on current
  // ones it is neural — free, offline, and nothing to download. An explicit
  // --tts-engine, a saved engine, or a project all win over this: flags decide,
  // detection only fills a vacuum.
  const chosen = opt('--tts-engine', saved?.engine);
  const native = chosen || project ? null : detect({ lang: opt('--lang') });
  // Only a NATIVE voice is claimed automatically. It is the one engine that
  // needs no setup at all — no install, no download, no credential — so using
  // it silently costs the presenter nothing. piper is deliberately NOT picked
  // here even when it is on PATH: it needs a toolchain and a ~120 MB model, and
  // choosing it behind the user's back would skip the first-run wizard that
  // exists to make (and save) exactly that choice.
  const ttsEngine = chosen ?? native?.engine ?? 'gemini';
  const cloudVoice = ttsEngine === 'gemini' || ttsEngine === 'chirp';
  const ttsArgs = () => [
    'tts', '--port', ttsPort,
    // also when DETECTION chose the engine: without this the bridge would be
    // started with no --engine and fall back to its own default, so a machine
    // picked for its system voice would try to reach Vertex AI instead
    ...(has('--tts-engine') || saved?.engine || ttsEngine !== 'gemini' ? ['--engine', ttsEngine] : []),
    ...(cloudVoice ? ['--project', project] : []),
    ...pass('--tts-model'), ...pass('--location'),
    ...pass('--voice'), ...pass('--data-dir'), ...pass('--lang'), ...pass('--tts-format'),
  ];
  if (has('--no-tts')) {
    skip.push({ name: 'voice', why: 'disabled with --no-tts' });
  } else if (!TTS_ENGINES.includes(ttsEngine)) {
    skip.push({ name: 'voice', why: `unknown --tts-engine '${ttsEngine}' — use ${TTS_ENGINES.join(', ')}` });
  } else if (ttsEngine === 'piper' && !hasBin('piper', env)) {
    skip.push({ name: 'voice', why: 'piper not on PATH — install it (uv tool install piper-tts)' });
  } else if (ttsEngine === 'piper' && !exists(piperModelPath(
    opt('--voice', saved?.voice ?? PIPER_DEFAULT_VOICE), opt('--data-dir', piperModelDir(env))))) {
    // piper is installed but has no voice to speak with. The bridge would come
    // up looking healthy and fail on the first sentence — a keypress into
    // silence — so it is caught here, where the fix can be offered instead.
    const voice = opt('--voice', saved?.voice ?? PIPER_DEFAULT_VOICE);
    const models = opt('--data-dir', piperModelDir(env));
    const download = piperDownloadCmd(voice, models, { hasBin: (b) => hasBin(b, env) });
    skip.push({
      name: 'voice',
      why: `the piper voice ${voice} is not in ${models} (~120 MB, one time)`
        + ` — ${piperDownloadLine(download)}`,
      download,   // author offers to run this on a TTY; nothing is ever pulled silently
    });
  } else if (ttsEngine === 'elevenlabs' && !env[ELEVENLABS_KEY_ENV]?.trim()) {
    // The key never lands in the saved config, so the environment is the only
    // place it can come from — say that, and where to make one.
    skip.push({ name: 'voice', why: `elevenlabs needs $${ELEVENLABS_KEY_ENV} — create a key at https://elevenlabs.io/app/settings/api-keys and export it` });
  } else if (cloudVoice && !project) {
    skip.push({
      name: 'voice',
      why: `${ttsEngine} needs a GCP project — pass --project <id> or set GOOGLE_CLOUD_PROJECT`
        + (native?.why ? `\n    this machine has no system voice either: ${native.why}` : '')
        + (native?.suggest ? `\n    ${native.suggest}` : ' — or use --tts-engine piper')
        // Ollama is the thing a local-AI user assumes covers this. It does not,
        // and being told why beats concluding decklight ignores their stack.
        + (ollama ? `\n    ${OLLAMA_NOTE}` : ''),
    });
  } else if (cloudVoice && !validProjectId(project)) {
    // caught here rather than at the first narration: the bridge would start,
    // look healthy, and only fail on a keypress — with a 403 naming a project
    // nobody typed
    skip.push({ name: 'voice', why: `not a GCP project id: ${JSON.stringify(project)} — stray punctuation from a copy-paste?` });
  } else {
    run.push({ name: 'tts', tag: 'voice', entry: CLI, args: ttsArgs(), url: `http://127.0.0.1:${ttsPort}` });
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
      entry: CLI,
      args: [
        'lipsync', '--port', lipPort,
        ...(has('--rhubarb') ? ['--rhubarb', rhubarb] : []),
        ...opts('--portrait').flatMap((p) => ['--portrait', p]),
        ...pass('--wav2lip-dir'), ...pass('--wav2lip-ckpt'),
        ...pass('--sadtalker-dir'), ...pass('--python'), ...pass('--cache-dir'),
        // --veo animates the portrait through Vertex (once, then cached) so the
        // narrator moves while you author; it is the one bridge flag that spends
        // money, so it is opt-in here exactly as it is on `decklight lipsync`
        ...(has('--veo') ? ['--veo'] : []),
        ...pass('--veo-project'), ...pass('--veo-model'),
        ...pass('--veo-seconds'), ...pass('--veo-prompt'), ...pass('--veo-location'),
        ...pass('--veo-face-y'),
      ],
      url: `http://127.0.0.1:${lipPort}`,
    });
  }

  // Reported, not passed through. The phone remote moved to `present`
  // (PRESENT#REMOTE), and a flag that quietly did nothing would leave someone
  // holding a phone that never connects. devMain is what prints and exits —
  // the plan stays pure so a test can ask what it decided.
  const gone = ['--remote', '--host'].filter((f) => args.some((a) => a === f || a.startsWith(f + '=')));
  return { deck, run, skip, gone, agents: detectAgents({ env, hasBin }).map((a) => a.name) };
}

/**
 * Should author OFFER the tts setup wizard instead of just printing the skip
 * line? Only when the skip is the fixable kind — no engine configured, no
 * project to run the default cloud engine with — never when a flag chose the
 * outcome (--no-tts, an unknown engine, a malformed --project: the user's
 * hand is on the wheel, and the skip line already names the fix).
 */
/** The voice is skipped only for want of a model, and we know how to fetch it. */
export const voiceModelOffer = (plan) => {
  const s = plan.skip.find((x) => x.name === 'voice');
  return s?.download ? s : null;
};

export const voiceSetupOffer = (plan) => {
  const s = plan.skip.find((x) => x.name === 'voice');
  return s && /needs a GCP project/.test(s.why) ? s : null;
};

// inGitRepo lives in git.mjs now; re-exported so importers (and the tests) keep
// finding it where dev grew it.
export { inGitRepo } from './git.mjs';
import { inGitRepo } from './git.mjs';

const COLORS = { deck: '\x1b[36m', voice: '\x1b[35m', lips: '\x1b[33m' };
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export async function devMain(args) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }

  let plan = planServices({ args, saved: loadTtsConfig() });
  if (plan.gone.length) {
    console.error(`decklight author no longer takes ${plan.gone.join(' or ')} — the phone remote moved to \`decklight present\`.`);
    console.error('  A clicker used to cost you an editing server on the LAN: /edit/notes, /edit/layout and');
    console.error('  /edit/agent were reachable from the same run you were not watching. present has no edit');
    console.error('  surface to widen, so that is where it lives.');
    console.error(`\n  decklight present ${plan.deck ?? '<deck.html>'} --remote`);
    process.exitCode = 2;
    return;
  }
  const deck = plan.deck;
  if (!deck) {
    console.error('decklight author needs a deck: decklight author <deck.html>\n');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(deck)) {
    console.error(`decklight author: no such deck: ${deck}`);
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
      const yes = !/^n/i.test(answer.trim());
      args = [...args, yes ? '--git' : '--no-git'];
      // Only while we are ALREADY setting git up, and only when an agent could
      // actually drive edits, offer the boundary that suits agent work. A
      // session in an existing repository gains no new question — that is the
      // one thing this must not cost, so `--git-mode agent` is how you reach it
      // there.
      if (yes && !args.includes('--git-mode') && detectAgents().length) {
        const mode = await rl.question("  commit once per agent edit, with the agent's own message, instead of on a timer? [y/N] ");
        if (/^y/i.test(mode.trim())) args = [...args, '--git-mode', 'agent'];
      }
      rl.close();
      plan = planServices({ args, saved: loadTtsConfig() });
    } else {
      console.log('  git: no repository here — pass --git to create one and auto-commit the deck');
    }
  }
  // piper is installed and chosen, but its voice model is not on disk. The
  // download is ~120 MB, so it is ASKED FOR, never silent — and only on a TTY,
  // so CI and pipes keep the skip line exactly as it was. Accepting re-plans,
  // so the bridge joins `run` and comes up in this same session.
  {
    const offer = voiceModelOffer(plan);
    if (offer && process.stdin.isTTY && process.stdout.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        console.log(`  ${offer.why}`);
        const answer = await rl.question('  download it now? [Y/n] ');
        if (!/^n/i.test(answer.trim())) {
          const { bin, args: dlArgs } = offer.download;
          const r = spawnSync(bin, dlArgs, { stdio: 'inherit' });
          if (r.status === 0) plan = planServices({ args });
          else console.log('  download failed — the voice stays skipped');
        }
      } finally { rl.close(); }
    }
  }
  // The voice would be skipped for the one reason setup can fix: nothing is
  // configured. Offer the guided setup (TTY only — headless runs keep the
  // skip line exactly as it was); a completed setup re-plans, so the bridge
  // joins `run` and comes up in this same session.
  if (voiceSetupOffer(plan) && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question('  no voice engine configured — set up live narration now? (V / N in the deck use it) [Y/n] ');
      if (!/^n/i.test(answer.trim())) {
        const result = await runSetupWizard({ ask: (q) => rl.question(q) });
        if (result) {
          // the wizard's test synthesis may hold a resident engine (piper);
          // author runs the bridge as its own child process, so let it go
          result.engine.synth.close?.();
          plan = planServices({ args, saved: result.config });
        }
      }
    } finally { rl.close(); }
  }
  // The edit port might already be held — often an earlier decklight session
  // left running. Resolved here, with author's OWN stdin, because the edit
  // child below is spawned with its stdin piped (not a terminal) and could
  // never ask on its own.
  const editSvc = plan.run.find((s) => s.name === 'edit');
  if (editSvc) {
    const portIdx = editSvc.args.indexOf('--port');
    const editPort = Number(editSvc.args[portIdx + 1]);
    if (await isPortOpen(editPort)) {
      const askTty = process.stdin.isTTY && process.stdout.isTTY;
      let rl;
      const ask = askTty ? (q) => (rl ??= createInterface({ input: process.stdin, output: process.stdout })).question(q) : undefined;
      const freshPort = await resolvePortConflict(editPort, { ask, log: console.log });
      rl?.close();
      editSvc.args[portIdx + 1] = String(freshPort);
      editSvc.url = `http://127.0.0.1:${freshPort}/${deck}`;
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
    // stdin is a pipe author never writes to — it is the leash (see supervise.mjs).
    // Holding it open is what tells the child we are still here; losing it is
    // how the child finds out we are not, even when we were SIGKILLed and
    // never reached shutdown() below.
    const child = spawn(process.execPath, [svc.entry, ...svc.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: leashEnv(),
    });
    children.set(svc.name, child);
    pipe(child.stdout, svc.tag, process.stdout);
    pipe(child.stderr, svc.tag, process.stderr);

    child.on('exit', (code) => {
      children.delete(svc.name);
      if (shuttingDown) return;
      if (svc.name === 'edit') {
        // the deck server is the one service author cannot run without
        console.error(`${paint(svc.tag)} exited (${code}) — stopping decklight author`);
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

if (isMain(import.meta.url)) devMain(process.argv.slice(2));
