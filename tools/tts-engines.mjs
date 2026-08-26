#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The voices decklight can speak with. One factory, four engines, one shape:
//
//   createEngine({ engine, … }) → { name, model, voices, needsProject,
//                                   synth(text, { voice, style }) → { wav, usage } }
//
// `voices` is the roster the player's picker offers. Three engines know theirs
// up front; ElevenLabs cannot, because the interesting ones are the voices YOU
// made — so it also returns `listVoices()`, an async, cached lookup the bridge
// awaits before answering /ping. An engine without it just has `voices`.
//
//   gemini — gemini-2.5-{pro,flash}-tts on Vertex AI. Best delivery, and the
//            only engine that takes a STYLE instruction. No free tier, and a
//            fresh project's per-minute quota is small: bursty narration 429s.
//            pro is slow (~20s a sentence); flash is the one to reach for.
//   chirp  — Chirp 3: HD on the Cloud Text-to-Speech API. A DIFFERENT API from
//            Vertex, with a permanent free tier (1M chars/month), ~1s a
//            sentence, and — conveniently — the same 30 star-named voices as
//            Gemini, so a deck keeps its voice when it changes engine. Style is
//            ignored: Chirp has no delivery-instruction channel.
//   piper  — local neural TTS. Free, offline, unlimited, no credentials. One
//            voice per installed model, so the picker's roster doesn't apply.
//   elevenlabs — the one whose roster is YOUR account's, cloned voices included.
//            Needs $ELEVENLABS_API_KEY (never saved to disk). Metered in
//            characters against a plan allowance we cannot see, so it reports
//            characters and no dollar estimate. Style is ignored on every
//            model except the opt-in --tts-model eleven_v3 (its own delivery
//            channel: bracketed audio tags read as direction, not words), so
//            `stylable` here depends on the model chosen, not just the engine.
//
// Cost is always an ESTIMATE from published list prices. Chirp's estimate is
// the list price *ignoring* the free tier — we cannot see your monthly usage,
// so the bridge reports characters too, which is what the free tier is
// denominated in.
//
// A seventh engine is whatever the machine INSTALLED (SPEC ENGINE_UNITS):
// `resolveEngine` at the bottom of this file takes any name, answers the six
// above itself, and hands anything else to the unit library. The six stay
// core and unversioned — they need no marketplace, so a machine with none
// registered reaches its own voice exactly as it always did.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createSynth as createGemini, GEMINI_VOICES, gcloudToken, validProjectId, authHeaders } from './gemini-tts.mjs';
import {
  createSynth as createElevenLabs, apiKey as elevenLabsKey, KEY_ENV as ELEVENLABS_KEY_ENV,
  DEFAULT_MODEL as ELEVENLABS_MODEL, V3_MODEL as ELEVENLABS_V3_MODEL,
} from './elevenlabs-tts.mjs';
import { detectLocalVoice, sayArgs, sapiArgs, TIER_LABEL } from './local-voice.mjs';

export const ENGINES = ['gemini', 'chirp', 'piper', 'elevenlabs', 'say', 'sapi'];
/** The two engines that are already on the machine — nothing to install. */
export const NATIVE_ENGINES = ['say', 'sapi'];

// Piper's defaults, shared with the setup wizard (tools/tts-setup.mjs) so the
// model it checks for is the model createPiper will load.
export const PIPER_DEFAULT_VOICE = 'en_US-ryan-high';
export const piperModelDir = (env = process.env) =>
  join(env.HOME || homedir(), '.local', 'share', 'piper');

const onPath = (bin) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch { return false; }
};
const canImportPiper = (py) => {
  try { execFileSync(py, ['-c', 'import piper.download_voices'], { stdio: 'ignore' }); return true; }
  catch { return false; }
};

/**
 * How to fetch a piper voice model ON THIS MACHINE.
 *
 * This used to be a constant — `python -m piper.download_voices …` — and it did
 * not work for the install decklight itself recommends. `uv tool install
 * piper-tts` puts piper in an ISOLATED virtualenv, on purpose; the ambient
 * python cannot import from it, so the printed command fails with
 * ModuleNotFoundError on a machine where piper is installed and working fine.
 *
 * So the command is chosen rather than assumed: a python that can already
 * import piper (a pip install into the active environment) gets the plain form,
 * and otherwise `uvx --from piper-tts` runs it inside the venv `uv` made.
 * Returns null when neither is possible, which is a different message.
 */
/**
 * Where a piper voice model lives. A voice given as a PATH is already the
 * answer; a bare name only resolves against a data dir — the same rule
 * createPiper applies when it decides whether to pass --data-dir.
 */
export function piperModelPath(voice = PIPER_DEFAULT_VOICE, dataDir = piperModelDir()) {
  return (voice.includes('/') || voice.endsWith('.onnx')) ? voice : join(dataDir, `${voice}.onnx`);
}

export function piperDownloadCmd(voice = PIPER_DEFAULT_VOICE, models = piperModelDir(), {
  hasBin = onPath, canImport = canImportPiper,
} = {}) {
  const tail = ['-m', 'piper.download_voices', voice, '--data-dir', models];
  for (const py of ['python3', 'python']) if (canImport(py)) return { bin: py, args: tail };
  if (hasBin('uvx')) return { bin: 'uvx', args: ['--from', 'piper-tts', 'python', ...tail] };
  return null;
}

/** A chosen command as the line a human would type, or the way to get one. */
export const piperDownloadLine = (cmd) => (cmd
  ? [cmd.bin, ...cmd.args].join(' ')
  // piper may well be installed — what is missing is a way to REACH its
  // downloader, which is a different problem and a different fix
  : 'no python here can import piper, and uvx is not on PATH — '
    + 'install uv (https://docs.astral.sh/uv) or: pip install piper-tts');

// Chirp 3: HD ships the same roster as Gemini TTS (verified against
// texttospeech.googleapis.com/v1/voices) — one name, two engines.
const CHIRP_PRICE_PER_1M = 30.0; // USD, list, after the 1M chars/month free tier
const chirpVoice = (voice, lang) => `${lang}-Chirp3-HD-${voice}`;

function createChirp({ project, lang = 'en-US' }) {
  if (!project) throw new Error('chirp needs a GCP project — pass --project <id> or set GOOGLE_CLOUD_PROJECT');
  if (!validProjectId(project)) throw new Error(`not a GCP project id: ${JSON.stringify(project)}`);
  let token = null;

  async function call(text, voice) {
    const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: authHeaders(token, project),
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: lang, name: chirpVoice(voice, lang) },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
      }),
    });
    if (!res.ok) { const e = new Error(`${res.status} ${(await res.text()).slice(0, 200)}`); e.status = res.status; throw e; }
    const { audioContent } = await res.json();
    if (!audioContent) throw new Error('no audio in response');
    // LINEAR16 comes back as a complete RIFF/WAVE — no header to bolt on
    return Buffer.from(audioContent, 'base64');
  }

  return async function synth(text, { voice = 'Alnilam' } = {}) {
    token ??= gcloudToken();
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return {
          wav: await call(text, voice),
          usage: {
            model: 'chirp3-hd',
            chars: text.length,
            cost: (text.length / 1e6) * CHIRP_PRICE_PER_1M,
            note: `${text.length} chars`,
          },
        };
      } catch (e) {
        lastErr = e;
        if (e.status === 401) { token = gcloudToken(); continue; }
        if (e.status === 429 || e.status >= 500) { await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1))); continue; }
        break;
      }
    }
    throw lastErr;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Piper, kept RESIDENT.
 *
 * piper reloads its model on every start — ~13s for en_US-ryan-high (116 MB),
 * against ~1.6s of interpreter startup — so a process per sentence would make
 * the offline engine slower than the cloud one and useless for live narration.
 * Held open it pays that once, and a warm sentence costs about twice its own
 * playing time (~4s for 2s of speech on a laptop CPU) — which the player's
 * lookahead buffer covers, since it synthesizes ahead of the playhead.
 *
 * Its stream interface is line-oriented: one line of text in, one WAV out, into
 * a spool dir, in order. So requests are serialized and the next unseen file is
 * ours — which also means the text must be flattened to a single line, or one
 * request would silently become several utterances.
 */
function createPiper({ voice = PIPER_DEFAULT_VOICE, dataDir }) {
  try { execFileSync('piper', ['--help'], { stdio: 'ignore' }); }
  catch { throw new Error('piper not found — install with: uv tool install piper-tts'); }
  // A bare model NAME only resolves against a data dir — without one, piper
  // searches its own default and calls the voice missing even when it is
  // sitting right there. A model PATH needs no dir at all.
  const models = dataDir ?? piperModelDir();
  const byPath = voice.includes('/') || voice.endsWith('.onnx');

  let proc = null, spool = null;
  let fatal = null;      // a config error (missing voice) — retrying cannot fix it
  let chain = Promise.resolve();
  const finished = [];   // paths piper has announced as written, in order
  let wake = null;

  function ensure() {
    if (proc) return;
    if (fatal) throw new Error(fatal);
    spool = mkdtempSync(join(tmpdir(), 'decklight-piper-'));
    finished.length = 0;
    const p = spawn('piper', [
      '-m', voice, ...(byPath ? [] : ['--data-dir', models]),
      '-d', spool, '--output-dir-naming', 'timestamp',
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    let tail = '';
    p.stderr.on('data', (b) => {
      err = (err + b).slice(-4000);
      // `INFO:__main__:Wrote <path>` — piper's end-of-utterance signal
      tail += b;
      const lines = tail.split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        const m = /Wrote (.+\.wav)\s*$/.exec(line);
        if (m) { finished.push(m[1].trim()); wake?.(); }
      }
    });
    p.on('exit', (code) => {
      if (proc === p) proc = null;
      rmSync(spool, { recursive: true, force: true });
      if (/Unable to find voice/.test(err)) {
        fatal = `piper voice '${voice}' not in ${models} — fetch it with: `
          + piperDownloadLine(piperDownloadCmd(voice, models));
      } else if (code) {
        // a crash is not necessarily terminal: the next call respawns
        lastExit = `piper exited (${code}) ${err.trim().split('\n').pop() ?? ''}`.trim();
      }
    });
    proc = p;
  }
  let lastExit = null;

  // The FILE cannot tell you when an utterance is done — only piper can.
  //
  // The obvious signal is a lie. Piper keeps the RIFF header in sync as it
  // streams, so "the header's declared length matches the bytes on disk" is
  // already true at the FIRST sentence boundary. And because piper synthesizes
  // sentence by sentence, the file then sits at exactly that size for as long
  // as the next sentence takes to generate — so "wait until it stops growing"
  // fails too, however long you wait. Any file-watching heuristic hands back a
  // well-formed WAV holding only the first sentence, and nothing downstream can
  // tell: the deck just says half the line, in a clip whose duration looks
  // plausible. (Measured on en_US-ryan-high: header first matched at 151084
  // bytes of a 301612-byte file — half the utterance.)
  //
  // Piper announces each finished utterance on stderr:
  //     INFO:__main__:Wrote /tmp/decklight-piper-XXXX/1234567890.wav
  // That says no further sentence is coming — the one thing the file cannot.
  // It does NOT mean every byte is on disk (piper logs it before closing the
  // handle, so reading immediately still truncates at the last flush boundary:
  // a 7.44s and a 7.24s clip both came back as the same 314924 bytes). So the
  // two signals compose, and neither alone would do: stderr ends the utterance,
  // and only THEN does header-match + settled-size mean "closed" rather than
  // "between sentences".
  const headerMatches = (b) => b.length > 44 && b.readUInt32LE(4) + 8 === b.length;

  async function drain(f, timeoutMs = 10_000) {
    const t0 = Date.now();
    let last = -1;
    for (;;) {
      const b = readFileSync(f);
      if (headerMatches(b) && b.length === last) return b;   // closed
      last = b.length;
      if (Date.now() - t0 >= timeoutMs) return b;            // never settled — take it
      await sleep(20);
    }
  }

  // Requests are serialized (one line in → one file out, in order), so the next
  // announced path is ours.
  async function nextWav(timeoutMs = 180_000) {
    const t0 = Date.now();
    for (;;) {
      if (!proc) throw new Error(fatal ?? lastExit ?? 'piper stopped');
      const f = finished.shift();
      if (f) {
        const b = await drain(f);
        rmSync(f, { force: true });
        return b;
      }
      if (Date.now() - t0 >= timeoutMs) throw new Error('piper timed out');
      await new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, 50);   // also covers a missed wake
      });
      wake = null;
    }
  }

  function synth(text) {
    const line = String(text).replace(/\s+/g, ' ').trim(); // one utterance, one line
    chain = chain.catch(() => {}).then(async () => {
      ensure();
      proc.stdin.write(`${line}\n`);
      return {
        wav: await nextWav(),
        usage: { model: voice, chars: line.length, cost: 0, note: `${line.length} chars · local` },
      };
    });
    return chain;
  }
  // Start the model loading NOW rather than on the first sentence — otherwise
  // the presenter's first keypress pays the whole ~13s load, which reads as a
  // hung deck. By the time anyone has opened a slide, piper is warm.
  synth.warm = () => { try { ensure(); } catch { /* reported at synth time */ } };
  // The resident process outlives the work: its piped stdio keeps Node's event
  // loop alive, so a BATCH caller that simply stops calling synth() never exits
  // (the bridge doesn't care — it is a server — but tools/voiceover.mjs hung on
  // its own success). Batch callers close when they are done.
  synth.close = () => { proc?.kill(); proc = null; };
  return synth;
}

/**
 * One engine, one shape. `voices` is what the player should offer: the star
 * roster for the cloud engines, and for piper the single installed model —
 * offering 30 Gemini names it cannot speak would just be a lie.
 */

/**
 * The voice the operating system already has.
 *
 * macOS `say` and Windows SAPI are one implementation with two spellings: both
 * are "hand a line of text and a file path to a program, get a WAV back". No
 * credentials, no download, no resident process — a fresh child per sentence,
 * which is affordable because neither loads a 120 MB model to start.
 *
 * Neither takes a delivery instruction, so both are `stylable: false` and the
 * picker skips the tone step, exactly as it does for piper and ElevenLabs.
 */
function createNative({ kind, voice, shell = 'powershell.exe', voices = [] }) {
  const bin = kind === 'say' ? 'say' : shell;
  const build = kind === 'say' ? sayArgs : sapiArgs;
  // The roster this machine actually has, for the guard below. Held as names
  // because that is what the player sends and what `say -v` takes.
  const known = new Set(voices.map((v) => v?.name ?? v).filter(Boolean));
  /**
   * `(text, { voice })` — the SECOND argument is the voice for THIS sentence,
   * and it is the whole contract every other engine here implements.
   *
   * This used to be `async (text) =>`, closing over the voice chosen when the
   * bridge started. So the picker offered 184 macOS voices, the log printed
   * whichever one you picked, and all 184 played the same one — the failure was
   * invisible in the logs because the log line quotes the REQUEST.
   */
  return async (text, { voice: asked } = {}) => {
    const pick = asked || voice;
    // A name this machine cannot say is an ERROR, not a shrug. `say -v Zephyr`
    // exits 0 and quietly produces the SYSTEM DEFAULT voice — so a typo, a
    // stale saved voice, or a roster from another engine all sound like
    // success while giving you somebody else's voice. (PowerShell's
    // SelectVoice already throws on an unknown name; this makes the two agree.)
    if (kind === 'say' && known.size && pick && !known.has(pick)) {
      throw new Error(`no ${kind} voice named ${JSON.stringify(pick)} on this machine`
        + ` — this bridge speaks ${known.size} others (GET /voices)`);
    }
    // one line: `say` treats newlines as pauses and PowerShell quoting gets
    // harder the moment a string spans lines
    const line = String(text).replace(/\s+/g, ' ').trim();
    if (!line) throw new Error('nothing to say');
    const dir = mkdtempSync(join(tmpdir(), 'decklight-native-'));
    const file = join(dir, 'out.wav');
    try {
      execFileSync(bin, build(line, pick, file), { stdio: ['ignore', 'ignore', 'pipe'] });
      const wav = readFileSync(file);
      if (!wav.length) throw new Error(`${kind} produced no audio`);
      // `{ wav, usage }`, like every other engine and like this file's own
      // contract at the top. It returned a bare Buffer, so a caller that
      // destructured `{ wav }` — tools/voiceover.mjs does — got undefined and
      // wrote it to disk. Nobody had ever reached this line: detectLocalVoice's
      // default probe answered "no synthesizer" first, so the shape was wrong
      // behind a door that never opened.
      return {
        wav,
        // the voice that SPOKE, not the one the bridge booted with
        usage: { model: pick ?? kind, chars: line.length, cost: 0, note: `${line.length} chars · local` },
      };
    } catch (e) {
      throw new Error(`${kind}: ${String(e.stderr ?? e.message).trim().split('\n')[0] || 'synthesis failed'}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export function createEngine({
  engine = 'gemini', project, model, location, voice, dataDir, lang, format, stability, env = process.env,
  // Injected like every other probe in this file, so a native engine can be
  // built — and its voice handling asserted — on a machine that is not the one
  // the test happens to run on.
  detect = detectLocalVoice,
} = {}) {
  if (!ENGINES.includes(engine)) {
    throw new Error(`unknown engine '${engine}' — use ${ENGINES.join(', ')},`
      + ` or install one: decklight engine add ${engine}`);
  }

  // `cost` is the human-facing price note — the bridge's startup line and the
  // setup wizard's test-synthesis report both quote it.
  if (engine === 'piper') {
    const m = voice ?? PIPER_DEFAULT_VOICE;
    return {
      name: 'piper', model: m, needsProject: false, stylable: false,
      cost: 'free · offline',
      voices: [[m, 'local']],
      synth: createPiper({ voice: m, dataDir }),
    };
  }
  if (engine === 'say' || engine === 'sapi') {
    const detected = detect({ lang });
    const pick = voice ?? detected.voices?.[0]?.name;
    if (!pick) throw new Error(detected.why ?? `no ${engine} voices on this machine`);
    return {
      name: engine, model: pick, needsProject: false, stylable: false,
      cost: 'free · offline · already on this machine',
      // [name, flavor, group]: the quality category travels as a STRUCTURED
      // third element (best · good · average) and the picker draws it as a
      // labelled separator over each shelf — the roster mixes this year's
      // neural voices with 1990s robots under names that reveal nothing. The
      // flavor stays the locale alone; repeating the category on every row
      // was the suffix wallpaper the separators replace.
      voices: (detected.voices ?? []).map((v) => [
        v.name,
        v.locale || 'system',
        Number.isInteger(v.tier) ? TIER_LABEL[v.tier] : undefined,
      ]),
      // "download a Siri voice" rides the same channel every engine caveat
      // does: the bridge's startup line and the deck's toast on switching
      ...(detected.caveat ? { caveat: detected.caveat } : {}),
      synth: createNative({
        kind: engine, voice: pick, shell: detected.shell, voices: detected.voices ?? [],
      }),
    };
  }
  if (engine === 'elevenlabs') {
    const m = model ?? ELEVENLABS_MODEL;
    const isV3 = m === ELEVENLABS_V3_MODEL;
    const { listVoices, synth } = createElevenLabs({
      key: elevenLabsKey(env), model: m, format: format ?? 'pcm', stability,
    });
    return {
      name: 'elevenlabs', model: m, needsProject: false,
      // v3 alone reads audio tags as direction — every other ElevenLabs model
      // would read a tag's brackets aloud as words, so the tone step is v3-only,
      // decided here from the model rather than the picker guessing by name.
      stylable: isV3,
      cost: 'metered in characters against your plan',
      // Stated once, at startup, where the presenter is still choosing —
      // v3 trades latency and consistency for expressiveness, and ElevenLabs'
      // own guidance targets prompts over ~250 characters against decklight's
      // one spoken sentence at a time, read live rather than pre-rendered.
      caveat: isV3
        ? 'eleven_v3: higher latency, more variable consistency, and ElevenLabs '
          + 'recommends prompts over ~250 characters — a live decklight sentence is '
          + 'shorter than that, so delivery may vary more than a ⇧V recording.'
        : undefined,
      // the real roster arrives from the account; until it does the picker has
      // nothing truthful to show, which is better than thirty names it cannot say
      voices: [], listVoices,
      synth,
    };
  }
  if (engine === 'chirp') {
    return {
      name: 'chirp', model: 'chirp3-hd', needsProject: true, stylable: false,
      cost: 'first 1M chars/month free',
      voices: GEMINI_VOICES,
      synth: createChirp({ project, lang: lang ?? 'en-US' }),
    };
  }
  const m = model ?? 'gemini-2.5-pro-tts';
  return {
    name: 'gemini', model: m, needsProject: true, stylable: true,
    cost: 'billed per call — no free tier',
    voices: GEMINI_VOICES,
    synth: createGemini({ project, ttsModel: m, location }),
  };
}

/**
 * Is `bin` on PATH? The bare-name probe the readiness check needs.
 *
 * `cli/agents.mjs` has the full version (explicit paths, execute bits); this
 * one is here rather than there because `tools/` cannot import from `cli/`,
 * and `tools/tts-setup.mjs` shares it so the wizard and the readiness check
 * cannot disagree about whether piper is installed.
 */
export function binOnPath(bin, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return (env.PATH || '').split(delimiter)
    .some((dir) => dir && exts.some((ext) => existsSync(join(dir, bin + ext))));
}

/**
 * Can this machine speak with `name` right now, and if not, what is missing?
 *
 * WHY THIS IS NOT `createEngine` THROWING. Two of the six build perfectly well
 * and fail later: `gemini` and `chirp` construct a synth against a project id
 * nobody has checked, so the bridge would come up looking healthy and only die
 * on the first keypress — with a 403 naming a project the presenter never
 * typed. Readiness is a question about the MACHINE (a binary, a model file, a
 * key, a project), and it has to be asked before anything is constructed.
 *
 * WHY IT LIVES HERE. Two callers now ask it: `decklight author`, deciding
 * whether to start the bridge at all, and the bridge itself, listing what the
 * deck may switch to (SPEC `NARRATION`). They must not disagree — a picker
 * offering an engine that `author` would have refused is a picker that lies.
 * So the DECISION is shared and only the presentation differs: `reason` is a
 * code the caller phrases for its own audience.
 *
 * Every probe is injected, so this is testable without a PATH, a filesystem,
 * or a credential.
 */
export function engineStatus(name, {
  // `project` defaults from the environment rather than to null: a caller that
  // passes only `env` means "decide from this machine", and answering
  // no-project on a machine whose GOOGLE_CLOUD_PROJECT is right there would be
  // a wrong answer that looks like a correct one. A caller with its own
  // precedence ladder (flags > env > saved config) passes the settled value.
  env = process.env, project = env.GOOGLE_CLOUD_PROJECT ?? null,
  voice = null, dataDir = null, lang = null,
  hasBin = binOnPath, exists = existsSync, detect = detectLocalVoice,
} = {}) {
  const no = (reason, detail) => ({ name, ready: false, reason, ...detail });
  if (!ENGINES.includes(name)) return no('unknown');

  if (name === 'piper') {
    if (!hasBin('piper', env)) return no('no-binary');
    const v = voice ?? PIPER_DEFAULT_VOICE;
    const models = dataDir ?? piperModelDir(env);
    if (!exists(piperModelPath(v, models))) return no('no-model', { voice: v, dataDir: models });
    return { name, ready: true, reason: 'ok' };
  }
  if (NATIVE_ENGINES.includes(name)) {
    // A system voice needs no setup at all — but the wrong OS has none, and
    // `say` on a machine with no configured voices is a silent bridge.
    const d = detect({ lang });
    if (d?.engine !== name || !d?.voices?.length) return no('no-native-voice', { why: d?.why });
    return { name, ready: true, reason: 'ok' };
  }
  if (name === 'elevenlabs') {
    return elevenLabsKey(env)?.trim() ? { name, ready: true, reason: 'ok' } : no('no-key');
  }
  // gemini and chirp
  if (!project) return no('no-project');
  if (!validProjectId(project)) return no('bad-project', { project });
  return { name, ready: true, reason: 'ok' };
}

/**
 * A blocker in two short sentences: what is missing, and what fixes it.
 *
 * These are the PICKER's words — one line each, because they are drawn under a
 * greyed row in a deck. `decklight author` phrases the same codes at length
 * (it has a terminal, and it is the place a presenter is still setting up).
 * Both read the same `reason`, so they can be worded for their audience
 * without being able to disagree about the facts.
 *
 * Every fix is something you do in a TERMINAL, and that is deliberate: the
 * deck lists what is missing and never collects it. A key or a project id
 * typed into a web page — even one on loopback — is a different thing from one
 * exported in a shell, and a presented deck is reachable from a phone.
 */
export function engineBlocker(status, { env = process.env } = {}) {
  const { reason } = status ?? {};
  if (!reason || reason === 'ok') return null;
  switch (reason) {
    case 'no-binary':
      return { why: 'not installed', fix: 'uv tool install piper-tts' };
    case 'no-model':
      return {
        why: `the voice ${status.voice} is not downloaded (~120 MB, one time)`,
        fix: piperDownloadLine(piperDownloadCmd(status.voice, status.dataDir,
          { hasBin: (b) => binOnPath(b, env) })),
      };
    case 'no-key':
      return { why: `needs $${ELEVENLABS_KEY_ENV}`, fix: 'export it, then restart decklight author' };
    case 'no-project':
      return {
        why: 'needs a Google Cloud project',
        fix: 'export GOOGLE_CLOUD_PROJECT=<id>, then restart decklight author',
      };
    case 'bad-project':
      // Named rather than generic: this one is nearly always a copy-paste that
      // brought punctuation with it, and seeing the value is the whole fix.
      return { why: `not a GCP project id: ${JSON.stringify(status.project)}`, fix: 'stray punctuation from a copy-paste?' };
    case 'no-native-voice':
      return { why: status.why ?? 'no system voice on this machine', fix: null };
    default:
      return { why: `unknown engine — use ${ENGINES.join(', ')}`, fix: null };
  }
}

/**
 * What a presenter could switch to, with the price note and the blocker.
 *
 * Order is a RECOMMENDATION and deliberately not `ENGINES` order (which keeps
 * gemini first for history): free and already-on-this-machine first, then the
 * ones with a bill. The native engine is folded to whichever of say/sapi this
 * OS actually has, because "sapi" on a Mac is not a choice, it is noise.
 *
 * `cost` comes from the engine itself where it can be built, so the picker
 * quotes the same sentence the bridge's startup line does rather than a second
 * copy of it. An engine that cannot be built has no cost to quote — it has a
 * blocker, which is what the row shows instead.
 */
export function engineMenu(opts = {}) {
  // Settled once, and shared with the construction below: `createEngine` for a
  // cloud engine REFUSES a missing project, so a menu that probed readiness
  // with the environment's project but built with `undefined` would quietly
  // drop the price note off every row it had just called ready.
  const env = opts.env ?? process.env;
  const settled = { ...opts, env, project: opts.project ?? env.GOOGLE_CLOUD_PROJECT ?? null };
  const native = NATIVE_ENGINES.includes(process.platform === 'win32' ? 'sapi' : 'say')
    ? (process.platform === 'win32' ? 'sapi' : 'say') : null;
  const order = [native, 'piper', 'chirp', 'gemini', 'elevenlabs'].filter(Boolean);
  return order.map((name) => {
    const status = engineStatus(name, settled);
    let cost;
    // Building it is the only way to learn the price note, and it is cheap —
    // no network, no process. It can still throw (a native engine with no
    // voices), which is not an error here: the row already carries the blocker.
    try { cost = createEngine({ ...settled, engine: name }).cost; } catch { cost = undefined; }
    return { ...status, cost, ...(engineBlocker(status, settled) ?? {}) };
  });
}

/**
 * The engine for `name`, whether decklight ships it or the machine installed
 * it (SPEC `ENGINE_UNITS`).
 *
 * The six above are resolved first and synchronously — they are not units,
 * they need no library and no catalog, and a machine with no marketplace
 * registered must reach its own voice by exactly the path it always did.
 * Only a name that is NOT one of them reaches the unit library, so the
 * loader (and the `cli/` half of the tree it pulls in) is imported lazily:
 * `decklight tts --engine piper` should not pay to read a registry it will
 * not consult.
 *
 * Async because loading an installed engine means `import()`ing it. Callers
 * that only ever speak with a built-in can keep calling `createEngine`
 * directly; the bridge cannot know which it has been given, so it awaits this.
 */
export async function resolveEngine(opts = {}) {
  const name = opts.engine ?? 'gemini';
  if (ENGINES.includes(name)) return createEngine(opts);
  const { loadEngine } = await import('../cli/loader.mjs');
  return loadEngine(name, opts);
}
