// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// What can this machine say out loud, without a credential and without a
// download?
//
// Every desktop OS has shipped a speech synthesizer for twenty years, and on
// current ones they are neural and genuinely good — macOS's Premium and
// Personal Voices, Windows's mobile/neural SAPI voices. decklight already had
// a free offline engine (piper), but piper costs a toolchain install and a
// ~120 MB model download. The voice already on the machine costs nothing.
//
// So: look, and only propose piper when there is nothing to find. Everything
// here is pure over injected `exec`/`platform`, because the whole point is
// branching on an operating system that CI is not running.
//
// Android is detected and REFUSED, deliberately: Termux reports `android` and
// can run Node, but Android's TextToSpeech is an in-process Java API with no
// command line behind it, so there is nothing for a bridge to call. Saying so
// beats a bridge that starts and never speaks.

const PIPER_SUGGEST = 'piper is the free offline voice — install it with '
  + '`uv tool install piper-tts`, then run `decklight tts --engine piper`';

/** `say -v '?'` on macOS: one voice per line, name, locale, sample sentence. */
export const SAY_LIST = ['-v', '?'];

/**
 * PowerShell, because SAPI is a .NET API and there is no speech CLI on Windows.
 * `-NoProfile` so a slow user profile cannot hang the probe.
 */
export const SAPI_LIST = [
  '-NoProfile', '-NonInteractive', '-Command',
  'Add-Type -AssemblyName System.Speech; '
  + '(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() '
  + '| ForEach-Object { $_.VoiceInfo.Name }',
];

/**
 * The novelty and 1990s-formant roster — the voices everybody calls "the
 * robots". They ship on every Mac, they sort ALPHABETICALLY FIRST (Albert,
 * Agnes, Bad News…), and modern `say -v '?'` no longer prints the (Premium)/
 * (Enhanced) markers the old ranking leaned on — which is how Albert became
 * the default narrator on a machine with a hundred better voices. Named
 * explicitly so they land in "average" no matter what the listing says.
 */
export const SAY_ROBOTS = new Set([
  'Agnes', 'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos',
  'Deranged', 'Fred', 'Good News', 'Hysterical', 'Jester', 'Junior', 'Kathy',
  'Organ', 'Pipe Organ', 'Princess', 'Ralph', 'Superstar', 'Trinoid', 'Victoria',
  'Whisper', 'Wobble', 'Zarvox',
]);

/**
 * Rank a macOS voice by how good it is likely to sound.
 *
 * The roster mixes twenty years of engines — 1990s formant voices sit in the
 * same list as this year's neural ones. Siri voices are the best `say` can do
 * and rank with a Personal Voice (the one the user recorded themselves); on
 * current macOS they are recognisable only by their SAMPLE sentence
 * ("Hi, I'm Siri!"), the name markers having disappeared from the listing.
 * The robots are pinned to "average" by name — see SAY_ROBOTS.
 */
export function sayTier(name, sample = '') {
  if (/\(Personal Voice\)/i.test(name)) return 0;
  if (/^Siri\b|\(Siri\)/i.test(name) || /I[’']m Siri/i.test(sample)) return 0;
  if (/\(Premium\)|\(Neural\)/i.test(name)) return 1;
  if (/\(Enhanced\)/i.test(name)) return 2;
  if (SAY_ROBOTS.has(name.replace(/\s*\(.*\)$/, '').trim())) return 4;
  return 3;
}

/**
 * What each tier is CALLED where a person is choosing: the categories, not
 * the engine trivia. Two tiers share "good" and two share "average" — the
 * ranking stays finer than the vocabulary so the sort still puts an Enhanced
 * voice above a plain one and a plain one above a robot.
 */
export const TIER_LABEL = ['best', 'good', 'good', 'average', 'average'];

/**
 * Parse `say -v '?'`.
 *
 * A voice NAME may contain spaces and a parenthesised tier, so the locale — the
 * one token that always looks like `en_US` and always precedes the `#` — is the
 * anchor, not a column position. The sample sentence after the `#` rides along:
 * on current macOS it is the only place a Siri voice says what it is.
 *
 * A Siri row that shares its display NAME with a non-Siri row is DROPPED:
 * `say -v` addresses voices by name, so the Siri variant behind a duplicate
 * name cannot actually be selected, and a picker row that plays a different
 * voice than it names would be a lie. A Siri voice under its own name
 * ("Siri Voice 4") is kept, and is the best thing in the list.
 */
export function parseSayVoices(stdout, { lang } = {}) {
  const out = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const m = /^(.*?)\s{2,}([a-z]{2}(?:[-_][A-Za-z0-9]{2,8})*)\s*#\s*(.*)$/.exec(line)
      ?? /^(.*?)\s+([a-z]{2}[-_][A-Z]{2})\s+#\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    if (!name) continue;
    const sample = (m[3] ?? '').trim();
    out.push({ name, locale: m[2].replace('-', '_'), tier: sayTier(name, sample), sample });
  }
  // the unaddressable Siri duplicates (see above)
  const names = new Map();
  for (const v of out) names.set(v.name, (names.get(v.name) ?? 0) + 1);
  const kept = out.filter((v) => !(names.get(v.name) > 1 && /I[’']m Siri/i.test(v.sample)));
  const want = (lang ?? 'en').slice(0, 2).toLowerCase();
  // English (or the asked-for language) first, then by tier: a machine whose
  // best voice speaks Italian should not narrate an English deck with it
  return kept.sort((a, b) =>
    (a.locale.startsWith(want) ? 0 : 1) - (b.locale.startsWith(want) ? 0 : 1)
    || a.tier - b.tier
    || a.name.localeCompare(b.name));
}

/** Parse the PowerShell voice list — one name per line. */
export function parseSapiVoices(stdout) {
  return String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((name) => ({
      name,
      locale: /\b(en|fr|de|es|it|ja|zh|pt|nl|ko|ru)\b/i.exec(name)?.[1]?.toLowerCase() ?? '',
      // Windows names its newer voices "Microsoft Aria Online (Natural)"
      tier: /\bNatural\b/i.test(name) ? 1 : 3,
    }))
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
}

/** The argv that makes macOS speak a line into a WAV file. */
export const sayArgs = (text, voice, file) => [
  ...(voice ? ['-v', voice] : []),
  // LEI16@24000 is little-endian 16-bit PCM at 24 kHz — the same shape every
  // other engine hands the bridge, so nothing downstream has to care
  '--data-format=LEI16@24000', '-o', file, '--', text,
];

/** The PowerShell that makes Windows speak a line into a WAV file. */
export function sapiArgs(text, voice, file) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;   // PowerShell escaping
  return ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Speech; '
    + '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
    + (voice ? `$s.SelectVoice(${q(voice)}); ` : '')
    + `$s.SetOutputToWaveFile(${q(file)}); `
    + `$s.Speak(${q(text)}); $s.Dispose()`];
}

/**
 * What this machine can speak with, if anything.
 *
 * Returns `{ engine, voices, label }` when a native synthesizer is available,
 * or `{ engine: null, why, suggest }` when there is none — `why` being the
 * reason THIS machine has none, which differs enough between an Android
 * device, a bare Linux box and a Mac with a broken `say` to be worth saying.
 */
/**
 * Is `bin` runnable? The default for the probe below.
 *
 * This has to be a REAL answer, and that is the whole point of it existing:
 * `hasBin` defaulted to `() => false`, so every caller that did not inject one
 * — `tools/tts-engines.mjs` creating a `say`/`sapi` engine is the only one, and
 * it is the one that matters — was told the machine had no synthesizer, on a
 * Mac where `say -v '?'` lists forty voices. The seams here exist so the tests
 * can drive every OS from one OS; a seam whose DEFAULT is "no" turns the
 * production path into a stub that always refuses, and every test still passes
 * because every test injects.
 */
export function onPath(bin, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(join(dir, bin + ext))) return true;
  }
  return false;
}

/** Run a probe and return its stdout; anything at all going wrong is ''. */
export const probe = (bin, args) => {
  try { return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
};

export function detectLocalVoice({
  platform = process.platform,
  hasBin = onPath,
  exec = probe,
  lang,
} = {}) {
  if (platform === 'android') {
    return {
      engine: null,
      why: 'Android has a system voice, but only as an in-app Java API — there is no '
        + 'command line behind it, so nothing here can drive it',
      suggest: 'record the narration on a desktop (decklight tts, then ⇧V) and ship the '
        + 'audio with the deck — a recorded track needs no bridge at all',
    };
  }

  if (platform === 'darwin' && hasBin('say')) {
    let voices = [];
    try { voices = parseSayVoices(exec('say', SAY_LIST), { lang }); } catch { /* treated as none */ }
    if (voices.length) {
      return {
        engine: 'say', voices,
        label: `macOS ${TIER_LABEL[voices[0].tier]} voice: ${voices[0].name}`,
        // The one upgrade worth suggesting: Siri voices are the best thing
        // `say` can produce and a free download away — but only a person can
        // click through to them, so this rides the caveat channel (the
        // bridge's startup line, the picker's toast) rather than pretending
        // to be automatable.
        ...(voices.some((v) => v.tier === 0) ? {} : {
          caveat: 'the best voices here are Siri’s, a free download: System Settings '
            + '→ Accessibility → Spoken Content → System Voice → Manage Voices… '
            + '(open it with: open "x-apple.systempreferences:com.apple.preference.universalaccess") '
            + '— then restart decklight tts',
        }),
      };
    }
    return { engine: null, why: 'macOS `say` is installed but reported no voices', suggest: PIPER_SUGGEST };
  }

  if (platform === 'win32') {
    const shell = ['powershell.exe', 'pwsh.exe'].find((b) => hasBin(b));
    if (shell) {
      let voices = [];
      try { voices = parseSapiVoices(exec(shell, SAPI_LIST)); } catch { /* treated as none */ }
      if (voices.length) {
        return {
          engine: 'sapi', shell, voices,
          label: `Windows ${voices[0].tier === 1 ? 'natural' : 'built-in'} voice: ${voices[0].name}`,
        };
      }
    }
    return { engine: null, why: 'no SAPI voices are installed on this Windows machine', suggest: PIPER_SUGGEST };
  }

  return {
    engine: null,
    why: platform === 'linux'
      ? 'Linux ships no system speech synthesizer'
      : `no system speech synthesizer on ${platform}`,
    suggest: PIPER_SUGGEST,
  };
}

/**
 * Ollama, which is not a speech engine and is the single most common thing a
 * local-AI user expects to be one.
 *
 * It is probed only so the answer can be honest. Serving LLMs is not serving
 * speech: there is no audio endpoint, and the models people name in this
 * context (Kokoro, Orpheus) either are not Ollama models or need a separate
 * audio decoder Ollama does not run.
 */
export const OLLAMA_URL = 'http://127.0.0.1:11434/api/tags';

export async function ollamaRunning({ fetchImpl = fetch, timeoutMs = 300 } = {}) {
  // A machine without Ollama must not pay for the question. The signal alone is
  // not enough: it only helps if the implementation honors it, and a socket
  // that hangs before the abort lands would stall dev's startup — which is the
  // one thing this budget exists to prevent. So the timeout is RACED, and the
  // abort is the courtesy that lets the request stop early.
  const ac = new AbortController();
  let timer;
  const expired = new Promise((done) => {
    timer = setTimeout(() => { ac.abort(); done(null); }, timeoutMs);
  });
  try {
    const answered = Promise.resolve()
      .then(() => fetchImpl(OLLAMA_URL, { signal: ac.signal }))
      .catch(() => null);
    const r = await Promise.race([answered, expired]);
    return !!r?.ok;
  } finally {
    clearTimeout(timer);
  }
}

export const OLLAMA_NOTE = 'Ollama is running, but it serves LLMs and cannot speak — '
  + 'it has no speech endpoint';
