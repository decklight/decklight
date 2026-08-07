// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// ElevenLabs TTS — the engine you reach for when the voice should be YOURS.
//
// The other three engines offer a fixed roster: Google's thirty star names, or
// whichever piper model is on disk. ElevenLabs is the one whose roster is your
// account's, so a voice you cloned shows up in the deck's N picker beside the
// stock ones. That is the whole reason it is here, and it is why this engine
// alone fetches its voices instead of shipping them: they are not knowable
// until someone's key is in hand.
//
// The key is read from $ELEVENLABS_API_KEY and is NEVER written to
// ~/.config/decklight/tts.json. That file records choices (which engine, which
// project, which voice) in plain text and is meant to be boring enough to sit
// in a dotfiles repo. A key is not boring, so decklight remembers that you
// chose ElevenLabs and lets your environment remember the secret.

import { wavFromPcm } from './gemini-tts.mjs';

export const KEY_ENV = 'ELEVENLABS_API_KEY';
const API = 'https://api.elevenlabs.io/v1';

// eleven_multilingual_v2 is the quality default and speaks every voice a
// clone produces; --tts-model eleven_turbo_v2_5 trades a little of it for
// latency, which live narration may prefer on a long deck.
export const DEFAULT_MODEL = 'eleven_multilingual_v2';

// The only ElevenLabs model that reads bracketed audio tags ([excited],
// [whispers], …) as performance direction instead of words to pronounce — v3
// joins the same style channel gemini has always had, opt-in only, because
// every other model would read the brackets aloud (SPEC PRESENTING).
export const V3_MODEL = 'eleven_v3';

// v3's stability slider is not the continuous 0–1 knob older models expose —
// ElevenLabs documents exactly these three named positions. Creative follows
// a tag hardest and drifts most; Robust barely moves and mostly ignores tags;
// Natural is the middle ground. Unnamed values are refused rather than
// silently rounded to the nearest preset.
export const STABILITY_PRESETS = { creative: 0, natural: 0.5, robust: 1 };

// A tag this long stops being a short performance cue and starts being a
// second sentence — cut it back rather than let it run on. 40 chars covers
// every named ElevenLabs tag with room for a typed phrase like "on the verge
// of tears" and still reads as direction, not dialogue.
const MAX_TAG_LEN = 40;

/**
 * A `style` string, or free-typed text, as a single ElevenLabs v3 audio tag —
 * or '' if there is nothing to say.
 *
 * Someone who already knows v3 syntax can type `[whispers]` and get exactly
 * that cue: the first well-formed bracketed group survives untouched (and
 * only the first — a second `[…]` later in the string would be a second cue
 * riding along uninvited, so everything after the first close-bracket is
 * dropped). Anyone else just types a word or a short phrase, which is wrapped
 * in brackets for them. Either way the result is capped to MAX_TAG_LEN so a
 * persona too long to be a cue is cut back rather than spoken.
 */
export function styleTag(style, maxLen = MAX_TAG_LEN) {
  const raw = String(style ?? '').trim();
  if (!raw) return '';
  const bracketed = raw.match(/^\[([^[\]]+)\]/);
  const cue = (bracketed ? bracketed[1] : raw).trim().slice(0, maxLen).trim();
  return cue ? `[${cue}]` : '';
}

// PCM is what the rest of decklight is built on: ⇧V stitches per-slide WAVs
// out of the sentence cache, and rhubarb reads WAV to find visemes. mp3 plays
// perfectly well in the deck but does neither, so it is opt-in rather than a
// silent downgrade. PCM output needs a paid ElevenLabs tier; see synthError.
export const FORMATS = ['pcm', 'mp3'];
const OUTPUT = { pcm: 'pcm_24000', mp3: 'mp3_44100_128' };
const PCM_RATE = 24000;

export const apiKey = (env = process.env) => env[KEY_ENV]?.trim() || null;

/**
 * The account's voices as the picker wants them: `[[name, flavor], …]`.
 *
 * YOUR voices come first. The picker lists them in order and preselects the
 * first, and someone who cloned a voice came here to use that voice — burying
 * it under twenty stock ones would make the feature technically present and
 * practically useless. Within a group the API's own order is kept.
 */
export function shapeVoices(json) {
  const rank = { cloned: 0, professional: 1, generated: 2, premade: 3 };
  return (json?.voices ?? [])
    .map((v, i) => ({
      name: String(v.name ?? '').trim() || v.voice_id,
      id: v.voice_id,
      // `category` is ElevenLabs' own word for where a voice came from, and
      // "cloned" is exactly the label that makes yours findable at a glance
      flavor: v.category === 'premade'
        ? (v.labels?.description || v.labels?.accent || 'premade')
        : (v.category ?? 'voice'),
      order: [rank[v.category] ?? 2, i],
    }))
    .filter((v) => v.id)
    .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
}

/**
 * Which voice the player meant. It sends a NAME — that is what it persists per
 * deck and what a human recognises — but a raw voice_id is accepted too, so an
 * id pasted from the ElevenLabs dashboard works without a lookup. Matching is
 * case- and space-insensitive because the name came from a text field.
 */
export function pickVoice(roster, requested) {
  if (!roster.length) return null;
  if (!requested) return roster[0];
  const want = String(requested).trim().toLowerCase();
  return roster.find((v) => v.id === requested)
    ?? roster.find((v) => v.name.toLowerCase() === want)
    ?? roster.find((v) => v.name.toLowerCase().replace(/\s+/g, '') === want.replace(/\s+/g, ''))
    ?? null;
}

/**
 * Turn an API failure into a sentence that names the way out. The two that
 * actually happen are a key that isn't one (401) and PCM on a tier that does
 * not include it (422) — and the second is worth catching by hand, because
 * ElevenLabs phrases it as a validation error on a query parameter and nobody
 * would guess that means "upgrade, or pass --tts-format mp3".
 */
export function synthError(status, body, { format = 'pcm' } = {}) {
  const text = String(body ?? '').slice(0, 300);
  if (status === 401 || status === 403) {
    return `ElevenLabs rejected the key (${status}) — check $${KEY_ENV}`;
  }
  if (format === 'pcm' && /output_format|pcm|tier|subscription/i.test(text)) {
    return 'ElevenLabs will not serve pcm_24000 on this plan (PCM output is a paid tier). '
      + 'Pass --tts-format mp3 to use mp3 instead — the deck plays it fine, but ⇧V offline '
      + 'recording and the lip-sync bridge both need WAV and will not work with it.';
  }
  if (status === 429) return 'ElevenLabs rate limit (429) — the lookahead buffer is bursty; try a smaller deck or wait';
  return `${status} ${text}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Returns `{ listVoices, synth }`.
 *
 * `listVoices()` resolves the account roster once and caches the promise — the
 * bridge's /ping, its /voices, and every synth share that one call. A failure
 * evicts itself, so a key fixed in another terminal is picked up on the next
 * probe rather than needing a restart.
 */
export function createSynth({
  key, model = DEFAULT_MODEL, format = 'pcm', stability, fetchImpl = fetch,
} = {}) {
  if (!key) {
    throw new Error(`ElevenLabs needs an API key — set $${KEY_ENV} `
      + '(create one at https://elevenlabs.io/app/settings/api-keys)');
  }
  if (!FORMATS.includes(format)) throw new Error(`unknown --tts-format '${format}' — use ${FORMATS.join(' or ')}`);
  // A stability preset means nothing to a model with no such slider — refused
  // up front, at construction, rather than accepted and quietly doing nothing.
  let stabilityValue;
  if (stability != null) {
    if (model !== V3_MODEL) {
      throw new Error(`--tts-stability is a v3 feature — pass --tts-model ${V3_MODEL}, or drop --tts-stability`);
    }
    stabilityValue = STABILITY_PRESETS[stability];
    if (stabilityValue == null) {
      throw new Error(`unknown --tts-stability '${stability}' — use ${Object.keys(STABILITY_PRESETS).join(', ')}`);
    }
  }
  const headers = { 'xi-api-key': key };

  let roster = null;
  function listVoices() {
    roster ??= (async () => {
      const res = await fetchImpl(`${API}/voices`, { headers });
      if (!res.ok) throw new Error(synthError(res.status, await res.text(), { format }));
      const shaped = shapeVoices(await res.json());
      if (!shaped.length) throw new Error('ElevenLabs returned no voices for this key');
      return shaped;
    })();
    roster.catch(() => { roster = null; });
    return roster;
  }

  async function call(text, voice) {
    const payload = { text, model_id: model };
    // Unasked, the account's own voice settings are left alone — sending a
    // voice_settings object at all overrides them, even to "no opinion".
    if (stabilityValue != null) payload.voice_settings = { stability: stabilityValue };
    const res = await fetchImpl(
      `${API}/text-to-speech/${encodeURIComponent(voice.id)}?output_format=${OUTPUT[format]}`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      const e = new Error(synthError(res.status, await res.text(), { format }));
      e.status = res.status;
      throw e;
    }
    const body = Buffer.from(await res.arrayBuffer());
    // pcm_24000 is headerless 16-bit mono; mp3 is already a container
    return format === 'pcm' ? wavFromPcm(body, PCM_RATE) : body;
  }

  async function synth(text, { voice, style } = {}) {
    const list = await listVoices();
    const picked = pickVoice(list, voice);
    if (!picked) {
      throw new Error(`no ElevenLabs voice named ${JSON.stringify(voice)} on this key — have: `
        + list.map((v) => v.name).join(', '));
    }
    // Audio tags are a v3-only delivery channel (SPEC PRESENTING). Sent to any
    // other model the brackets are read aloud as words, so a tone is NEVER
    // attached unless this is the model that can act on it.
    const tag = model === V3_MODEL ? styleTag(style) : '';
    const sent = tag ? `${tag} ${text}` : text;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return {
          wav: await call(sent, picked),
          usage: {
            model,
            // Billed on what actually went out — the tag rides inside the same
            // text field ElevenLabs meters, so a report that ignored it would
            // undercount every styled sentence.
            chars: sent.length,
            // ElevenLabs meters CHARACTERS against a monthly plan allowance, and
            // the per-character rate depends on a tier we cannot see. Reporting a
            // dollar figure would be inventing one, so the bridge shows characters.
            cost: 0,
            note: tag ? `${sent.length} chars · ${picked.name} · ${tag}` : `${sent.length} chars · ${picked.name}`,
          },
        };
      } catch (e) {
        lastErr = e;
        if (e.status === 429 || e.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
        break;
      }
    }
    throw lastErr;
  }
  synth.mimeType = format === 'pcm' ? 'audio/wav' : 'audio/mpeg';
  return { listVoices, synth };
}
