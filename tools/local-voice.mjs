// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

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
 * Rank a macOS voice by how good it is likely to sound.
 *
 * The roster mixes twenty years of engines — 1990s formant voices sit in the
 * same list as this year's neural ones — and picking the first alphabetically
 * means picking Agnes. The parenthesised tier is macOS's own label, and a
 * Personal Voice (the one the user recorded themselves, Apple's
 * accessibility/Apple-Intelligence-era feature) outranks everything.
 */
export function sayTier(name) {
  if (/\(Personal Voice\)/i.test(name)) return 0;
  if (/\(Premium\)/i.test(name)) return 1;
  if (/\(Neural\)|\(Siri\)/i.test(name)) return 1;
  if (/\(Enhanced\)/i.test(name)) return 2;
  return 3;
}

const TIER_LABEL = ['personal voice', 'premium', 'enhanced', 'built-in'];

/**
 * Parse `say -v '?'`.
 *
 * A voice NAME may contain spaces and a parenthesised tier, so the locale — the
 * one token that always looks like `en_US` and always precedes the `#` — is the
 * anchor, not a column position.
 */
export function parseSayVoices(stdout, { lang } = {}) {
  const out = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const m = /^(.*?)\s{2,}([a-z]{2}(?:[-_][A-Za-z0-9]{2,8})*)\s*#/.exec(line)
      ?? /^(.*?)\s+([a-z]{2}[-_][A-Z]{2})\s+#/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    if (!name) continue;
    out.push({ name, locale: m[2].replace('-', '_'), tier: sayTier(name) });
  }
  const want = (lang ?? 'en').slice(0, 2).toLowerCase();
  // English (or the asked-for language) first, then by tier: a machine whose
  // best voice speaks Italian should not narrate an English deck with it
  return out.sort((a, b) =>
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
export function detectLocalVoice({
  platform = process.platform,
  hasBin = () => false,
  exec = () => '',
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
        label: `macOS ${TIER_LABEL[voices[0].tier]}: ${voices[0].name}`,
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
