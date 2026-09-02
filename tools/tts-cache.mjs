// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The synthesis cache on disk — one clip per (engine, model, format, voice,
 * style, text), shared by everything that speaks.
 *
 * It lived inside tools/voiceover-server.mjs and served only the free local
 * engines, on the argument that a cloud engine's output drifts with the
 * server's model and a stale clip is worse than re-billing one preview
 * sentence. That argument was answering the wrong question: it treated the
 * MODEL as invisible, so the only way to avoid serving audio from last
 * quarter's model was to keep no audio at all. Put the model in the key and
 * the drift is not a risk, it is a cache miss — a new model is new bytes under
 * a new name, and yesterday's clip is unreachable rather than wrong.
 *
 * What that buys is the thing the memory cache never could: the live bridge
 * and `decklight voiceover` are SEPARATE PROCESSES, so a deck previewed
 * sentence by sentence in the browser and then batch-recorded paid ElevenLabs
 * twice for identical text. They now meet here, because the key is derived
 * from what was said and how — not from who is asking.
 *
 * The key deliberately does NOT include the deck, the slide number or the
 * output directory. The same sentence in two decks is the same audio, and a
 * second take into a different `-o` should cost nothing.
 *
 * Nothing here throws. A cache that cannot be read is a cache miss and a cache
 * that cannot be written is a cache — read-only media, a full disk and a
 * locked-down $HOME all degrade to "synthesize it again", never to a failed
 * talk.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * How much audio is allowed to accumulate before the oldest is dropped.
 *
 * A per-sentence cache grows forever, and a silent 10 GB in ~/.cache is not a
 * cache, it is a leak with a euphemism.
 */
export const CACHE_LIMIT = 400 * 1024 * 1024;

/** Where clips live. `$XDG_CACHE_HOME` wins, so a test never touches the real one. */
export function cacheHome(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'decklight', 'tts');
}

/**
 * The file extension for what an engine returned.
 *
 * ElevenLabs' `--tts-format mp3` is the only path that is not a WAV, and
 * filing an mp3 under `.wav` would make the cache dir a pile of lies — playable
 * by nothing that trusts the name, prunable only by accident.
 */
export function extFor(mime) {
  return mime === 'audio/mpeg' ? 'mp3' : 'wav';
}

/** Every extension the cache is allowed to own, for pruning. */
export const CACHE_EXTS = ['.wav', '.mp3'];

/**
 * The name a clip is filed under.
 *
 * Everything that changes the AUDIO is in here and nothing else is. `model` is
 * the addition that lets cloud engines be cached at all; `format` is here
 * because pcm and mp3 of one sentence are different bytes with the same words.
 *
 * NUL joins the fields so they cannot run together — a style ending in a space
 * and a text starting with one must not hash like their neighbours — but
 * written as an ESCAPE, not a raw byte: git calls any file with a NUL in its
 * first 8 KB binary, and this file would silently become undiffable.
 */
export function cacheKey({ engine, model, format, voice, style, text } = {}) {
  return createHash('sha256')
    .update([engine, model, format, voice, style, text].map((f) => f ?? '').join('\u0000'))
    .digest('hex');
}

/**
 * The key for one sentence on one ENGINE — the form both callers use.
 *
 * `cacheKey` above takes loose fields, which is what makes it testable; this
 * takes the engine object and derives them, which is what makes the live
 * bridge and `decklight voiceover` agree. They used to assemble the fields
 * separately, and separately is how a cache that spans two processes quietly
 * stops hitting: one of them starts sending a field the other does not, every
 * lookup misses, and nothing fails — you just pay twice again.
 *
 * Two rules are worth naming, because both were bugs before they were rules.
 *
 * WHAT `model` MEANS DIFFERS BY ENGINE, and only gemini, chirp and ElevenLabs
 * mean by it what the word says. For say and SAPI it is the voice the process
 * booted with, while the voice that actually speaks arrives per sentence — so
 * a bridge started without `--voice` and a recorder started with one hashed
 * the same sentence, in the same voice, two different ways, and the batch
 * recording missed every clip the browser had just filed. For piper it is the
 * loaded model and the per-sentence voice is ignored entirely, which is the
 * opposite mistake: keying on the request would let two runs under different
 * `--voice` models collide on one key and serve the wrong voice. Each engine
 * declares which it is (`modelIsDefaultVoice`, `voiceIsFixed`) rather than
 * this file guessing from the name.
 *
 * STYLE only counts when the engine can act on it. Only gemini and ElevenLabs
 * v3 read a delivery instruction; the rest are handed one and ignore it. The
 * bridge gets its style from the deck (usually none) and the CLI defaults to a
 * paragraph about a warm senior engineer — so keying on a style neither engine
 * read would make identical audio hash two ways. `stylable` is the engine's
 * own answer to "can this change the sound", and only then does it change the
 * name.
 */
export function clipKey(engine, { voice, style, text } = {}) {
  // The voice that will SPEAK this sentence, and the model that will speak it
  // — never the same axis twice, and never an axis the engine does not have.
  const voiceId = engine?.voiceIsFixed ? engine?.model
    : engine?.modelIsDefaultVoice ? (voice ?? engine?.model)
      : voice;
  const modelId = (engine?.voiceIsFixed || engine?.modelIsDefaultVoice) ? undefined : engine?.model;
  return cacheKey({
    engine: engine?.name,
    model: modelId,
    format: extFor(engine?.synth?.mimeType ?? 'audio/wav'),
    voice: voiceId,
    style: engine?.stylable ? style : undefined,
    text,
  });
}

/**
 * A cache bound to a directory.
 *
 * `enabled: false` returns the same shape doing nothing, so a caller never
 * grows an `if` around every read and write — `--no-cache` is one construction
 * argument rather than a condition threaded through two files.
 */
export function createTtsCache({ dir = cacheHome(), limit = CACHE_LIMIT, enabled = true } = {}) {
  const path = (key, ext) => join(dir, `${key}.${ext}`);

  /** The clip, or null. A miss and an unreadable file are the same answer. */
  function read(key, ext = 'wav') {
    if (!enabled) return null;
    try {
      const bytes = readFileSync(path(key, ext));
      return bytes.length ? bytes : null;
    } catch { return null; }
  }

  /** File a clip. Empty audio is never cached: it would poison the key forever. */
  function write(key, bytes, ext = 'wav') {
    if (!enabled || !bytes?.length) return false;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path(key, ext), bytes);
      return true;
    } catch { return false; }
  }

  /**
   * Drop the oldest clips until the directory fits.
   *
   * Called once at startup rather than on every write: the bound is on what a
   * machine keeps, not on what a single run may add, and stat-ing the whole
   * directory per sentence would cost more than the synthesis it saves.
   *
   * Oldest-first by mtime also retires stale keys for free. Changing the key
   * formula (adding `model`, say) orphans every clip filed under the old one;
   * those are by definition never touched again, so they age to the front of
   * this queue and leave on their own.
   */
  function prune() {
    if (!enabled) return 0;
    try {
      const entries = readdirSync(dir)
        .filter((f) => CACHE_EXTS.some((e) => f.endsWith(e)))
        .map((f) => ({ f, ...statSync(join(dir, f)) }))
        .sort((a, b) => a.mtimeMs - b.mtimeMs);
      let total = entries.reduce((sum, e) => sum + e.size, 0);
      let dropped = 0;
      for (const e of entries) {
        if (total <= limit) break;
        try { unlinkSync(join(dir, e.f)); total -= e.size; dropped++; } catch { break; }
      }
      return dropped;
    } catch { return 0; }
  }

  return { dir, enabled, read, write, prune };
}
