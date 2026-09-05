// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { run, PROBE_MS } from './exec.mjs';

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
  // both spellings: modern macOS lists 'Trinoids', older docs say 'Trinoid' —
  // the singular alone let the plural rank as a plain voice
  'Deranged', 'Fred', 'Good News', 'Hysterical', 'Jester', 'Junior', 'Kathy',
  'Organ', 'Pipe Organ', 'Princess', 'Ralph', 'Superstar', 'Trinoid', 'Trinoids',
  'Victoria', 'Whisper', 'Wobble', 'Zarvox',
]);

/**
 * The 2022-era character voices — two locales each, mediocre by design, and
 * alphabetically ahead of every classic. They read as personas, not
 * narrators, so they shelve with the novelty voices: on a real Mac they are
 * most of what an alphabetical list shows first, which is how "which voice
 * is good here" became unanswerable.
 */
export const SAY_PERSONAS = new Set([
  'Eddy', 'Flo', 'Grandma', 'Grandpa', 'Reed', 'Rocko', 'Sandy', 'Shelley',
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
  const bare = name.replace(/\s*\(.*\)$/, '').trim();
  if (SAY_ROBOTS.has(bare) || SAY_PERSONAS.has(bare)) return 4;
  return 3;
}

/**
 * What each tier is CALLED where a person is choosing: the categories, not
 * the engine trivia. Two tiers share "good" and two share "average" — the
 * ranking stays finer than the vocabulary so the sort still puts an Enhanced
 * voice above a plain one and a plain one above a robot.
 */
export const TIER_LABEL = ['best', 'good', 'good', 'average', 'novelty'];

/**
 * The `average` shelf — the plain compact voice every locale ships.
 *
 * Derived from TIER_LABEL rather than written as 3, so inserting a shelf moves
 * this with it instead of silently re-pointing it at the wrong one.
 */
export const PLAIN_TIER = TIER_LABEL.indexOf('average');

/**
 * The quality suffix Apple appends to a voice that has a better build.
 *
 * Deliberately an ALLOW-LIST of the four markers sayTier scores on, not "a
 * trailing parenthetical": plenty of voices carry one that says nothing about
 * quality — `Eddy (English (UK))`, `Aman (English (India))` — and stripping
 * those would have `Aman` superseded by a novelty voice of the same name.
 */
const QUALITY_SUFFIX = /\s*\((?:Personal Voice|Siri[^)]*|Premium|Neural|Enhanced)\)\s*$/i;

/** `Daniel (Enhanced)` → `Daniel`; `Eddy (English (UK))` → unchanged. */
export const plainName = (name) => String(name ?? '').replace(QUALITY_SUFFIX, '').trim();

/**
 * Drop a plain voice that is the SAME VOICE as a better one beside it.
 *
 * A real Mac lists both `Daniel` and `Daniel (Enhanced)` in en_GB, and both
 * `Audrey` and `Audrey (Premium)` in fr_FR. That is one voice offered twice at
 * two build qualities, and the worse row is not a choice — nobody browsing a
 * picker means "the compact Daniel, specifically". Twelve of this machine's
 * 201 rows are that.
 *
 * The story of what this is NOT is the design.
 *
 * The first cut kept only `best` and `good`, took the roster to 59 rows, and
 * read as a far bigger win — until you notice it deletes the novelty shelf
 * entirely (130 of the 201) and leaves src/core/narration.js holding
 * expand/collapse machinery (`COLLAPSIBLE`) for a shelf that can no longer
 * exist. The picker already folds `novelty` and `other languages` to one
 * expandable row each, which is the same noise handled where it is
 * REVERSIBLE — a fold you can open, rather than a roster that never mentions
 * Zarvox again. Somebody who wants the robot is entitled to the robot.
 *
 * The second cut dropped a locale's plain voices whenever the LOCALE held
 * anything better. That is one step too far, and the names say why: it takes
 * `Daniel` (fine — `Daniel (Enhanced)` is right there) but it also takes
 * `Samantha`, `Rishi`, `Aman`, `Tara` and `Jacques`, which have no
 * better-quality namesake at all. They are distinct voices, deleted because
 * some OTHER voice in their language happens to be Premium. Samantha is the
 * most recognisable voice macOS has ever shipped.
 *
 * So the rule is a NAME match inside one locale, which is exactly the
 * duplicate and nothing else. `keep` spares the voice the bridge booted with,
 * which may have been named on the command line, and an untiered roster (SAPI,
 * WinRT) passes through whole: this ranks, it does not invent.
 */
export function withoutSupersededPlain(voices = [], { keep } = {}) {
  // `locale\u0000name` of every voice that is a BETTER build of that name — the
  // set a plain row has to be absent from to survive.
  const better = new Set();
  for (const v of voices) {
    if (!Number.isInteger(v?.tier) || v.tier >= PLAIN_TIER) continue;
    const bare = plainName(v.name);
    if (bare && bare !== v.name) better.add(`${(v.locale || '').toLowerCase()}\u0000${bare}`);
  }
  return voices.filter((v) => {
    if (!Number.isInteger(v?.tier) || v.tier !== PLAIN_TIER) return true;
    if (keep && v.name === keep) return true;
    return !better.has(`${(v.locale || '').toLowerCase()}\u0000${v.name}`);
  });
}

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
  // the unaddressable Siri duplicates (see above), and the `((null))`
  // artifacts an undownloaded Siri stub can leave in the listing — both are
  // rows `say -v` cannot actually select, so neither may be offered
  const names = new Map();
  for (const v of out) names.set(v.name, (names.get(v.name) ?? 0) + 1);
  const kept = out.filter((v) => !v.name.includes('((null))')
    && !(names.get(v.name) > 1 && /I[’']m Siri/i.test(v.sample)));
  const want = (lang ?? 'en').slice(0, 2).toLowerCase();
  // English (or the asked-for language) first, then by tier: a machine whose
  // best voice speaks Italian should not narrate an English deck with it
  return kept.sort((a, b) =>
    (a.locale.startsWith(want) ? 0 : 1) - (b.locale.startsWith(want) ? 0 : 1)
    || a.tier - b.tier
    || a.name.localeCompare(b.name));
}

/**
 * The WinRT speech stack — where Windows' NATURAL voices live.
 *
 * `System.Speech` (SAPI_LIST above) is the 2006 API: it sees David, Zira and
 * Mark, and it cannot see the neural voices Narrator and Edge use (Aria,
 * Jenny, Guy — the ones that sound like a person). Those are exposed through
 * `Windows.Media.SpeechSynthesis`, which Windows PowerShell 5.1 can reach by
 * projecting the WinRT type. So the roster is asked for HERE first, and
 * System.Speech is the fallback for a PowerShell that cannot project (pwsh 7
 * without the SDK assemblies, or an old Windows).
 *
 * One voice per line: DisplayName, Language, Id — tab-separated, because a
 * display name has spaces and parentheses in it.
 */
export const WINRT_LIST = [
  '-NoProfile', '-NonInteractive', '-Command',
  '$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]; '
  + '[Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices '
  + '| ForEach-Object { $_.DisplayName + "`t" + $_.Language + "`t" + $_.Id }',
];

/** Rank a WinRT voice: the neural ones are the best Windows can do. */
export function winrtTier(name, id = '') {
  return /\bNatural\b/i.test(name) || /Natural|Neural/i.test(id) ? 0 : 3;
}

/** Parse WINRT_LIST's output — `name<TAB>lang<TAB>id` per line. */
export function parseWinrtVoices(stdout, { lang } = {}) {
  const out = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const [name, language, id] = line.split('\t').map((x) => (x ?? '').trim());
    if (!name || !language) continue;
    out.push({ name, locale: language.replace('-', '_'), id: id || null, tier: winrtTier(name, id) });
  }
  const want = (lang ?? 'en').slice(0, 2).toLowerCase();
  return out.sort((a, b) =>
    (a.locale.toLowerCase().startsWith(want) ? 0 : 1) - (b.locale.toLowerCase().startsWith(want) ? 0 : 1)
    || a.tier - b.tier
    || a.name.localeCompare(b.name));
}

/**
 * The PowerShell that makes the WinRT stack speak a line into a WAV file.
 *
 * `SynthesizeTextToStreamAsync` answers a WinRT stream that IS a RIFF/WAVE;
 * it is bridged to a .NET stream and copied to the file whole. The one
 * async hop is awaited through `AsTask` looked up by reflection — the
 * projection has no `await` in PowerShell 5.1 — and a voice name this
 * machine does not have THROWS rather than falling back to the default
 * voice, the same rule `say` needed enforcing by hand.
 */
export function winrtArgs(text, voice, file) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;   // PowerShell escaping
  return ['-NoProfile', '-NonInteractive', '-Command',
    '$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]; '
    + 'Add-Type -AssemblyName System.Runtime.WindowsRuntime; '
    + '$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { '
    + "$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and "
    + "$_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]; "
    + '$s = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer; '
    + (voice
      ? `$v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object { $_.DisplayName -eq ${q(voice)} } | Select-Object -First 1; `
        + `if (-not $v) { throw ('no voice named ' + ${q(voice)}) }; $s.Voice = $v; `
      : '')
    + `$op = $s.SynthesizeTextToStreamAsync(${q(text)}); `
    + '$task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($op)); '
    + '$task.Wait(); $stream = $task.Result; '
    + '$in = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0)); '
    + `$out = [IO.File]::Create(${q(file)}); $in.CopyTo($out); $out.Dispose(); $in.Dispose(); $s.Dispose()`];
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
  try { return run(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_MS, why: "macOS's speech synthesizer is not answering; restart it: killall speechsynthesisd" }); }
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
    // Windows PowerShell first: it is the one that projects WinRT types, and
    // WinRT is where the natural voices are. pwsh (7+) cannot without the SDK
    // assemblies, so it is the fallback shell — and System.Speech, which sees
    // only the 2006 voices, the fallback API.
    const shells = ['powershell.exe', 'pwsh.exe'].filter((b) => hasBin(b));
    for (const shell of shells) {
      let voices = [];
      try { voices = parseWinrtVoices(exec(shell, WINRT_LIST), { lang }); } catch { /* not projectable here */ }
      if (voices.length) {
        return {
          engine: 'sapi', api: 'winrt', shell, voices,
          label: `Windows ${TIER_LABEL[voices[0].tier]} voice: ${voices[0].name}`,
          ...(voices.some((v) => v.tier === 0) ? {} : {
            caveat: 'the best voices here are Windows’ natural ones, a free download: Settings '
              + '→ Accessibility → Narrator → Add natural voices '
              + '(open it with: start ms-settings:easeofaccess-narrator) — then restart decklight tts',
          }),
        };
      }
    }
    const shell = shells[0];
    if (shell) {
      let voices = [];
      try { voices = parseSapiVoices(exec(shell, SAPI_LIST)); } catch { /* treated as none */ }
      if (voices.length) {
        return {
          engine: 'sapi', api: 'sapi', shell, voices,
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
