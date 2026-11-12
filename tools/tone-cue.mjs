// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A tone, as each engine can take it. Gemini reads a delivery instruction as a
// prompt prefix, so a tone there is a sentence of prose. ElevenLabs v3/v4 read
// a bracketed audio tag in front of the text, and a tag is a short performance
// cue: a paragraph cut to fit one is a fragment the model cannot act on, and
// in front of a four-word sentence it is the shape ElevenLabs warns makes a
// take stutter (#1005).
//
// In tools/ because the deck's tone picker (src/core/narration.js), the bridge
// and `decklight narrate` (tools/elevenlabs-tts.mjs) all need the same tones
// and the same cut. Pure, so the runtime bundles it.

/**
 * The built-in tones: `[label, Gemini directive, ElevenLabs cue, group]`.
 *
 * The directives are single instruction clauses: instruction-shaped text
 * steers, while persona sentences ("You're a…") can stochastically be read
 * aloud. Each cue is the SAME tone in a few words, short enough to reach
 * ElevenLabs whole, and close to the tags ElevenLabs documents: an invented
 * cue is one the model ignores or reads aloud. The group is the heading the
 * V panel lists it under: ways to present first, then moods, then the ones
 * for a laugh.
 */
const PRESENTING = 'presenting';
const MOODS = 'moods';
const FOR_A_LAUGH = 'for a laugh';
export const TONES = [
  ['Warm senior engineer', 'Read in a warm, welcoming tone, like a friendly battle-hardened senior engineer who is still curious about new technology.', 'warmly, like a seasoned engineer', PRESENTING],
  ['Professional', 'Read in a clear, professional tone — measured, confident, and articulate.', 'clear and professional', PRESENTING],
  ['Calm explainer', 'Read in a calm, patient tone, like a teacher walking a class through something for the first time, pausing on the key words.', 'calm, patient', PRESENTING],
  ['Conversational', 'Read in a relaxed, conversational tone, as if talking to one colleague across a desk rather than to a room.', 'conversational, relaxed', PRESENTING],
  ['Keynote', 'Read in a confident, energetic tone with clear emphasis, like a speaker opening a conference.', 'confident, energetic', PRESENTING],
  ['Documentary', "Read in a measured, unhurried narrator's voice, with weight on the facts and no sales pitch.", 'narrating a documentary', PRESENTING],
  ['Storyteller', 'Read as a storyteller, with warmth and a sense of anticipation, letting each sentence land before the next.', 'storytelling, warm', PRESENTING],
  ['Plain and brisk', 'Read in a plain, brisk tone with no flourish, like release notes read aloud.', 'neutral, brisk', PRESENTING],
  ['Joyful', 'Read in a joyful, light-hearted tone, smiling through every sentence.', 'joyfully, smiling', MOODS],
  ['Super excited', 'Read in a super-excited, high-energy tone, barely containing your enthusiasm.', 'super excited', MOODS],
  ['Sad', 'Read in a somber, melancholic tone, on the verge of a sigh.', 'sadly, on the verge of a sigh', MOODS],
  ['Too serious', 'Read in an extremely grave, deadly serious tone, as if announcing news of the utmost importance.', 'gravely serious', FOR_A_LAUGH],
  ['Deadpan', 'Read in a completely flat, deadpan tone, never acknowledging that anything is funny.', 'deadpan', FOR_A_LAUGH],
  ['Breaking news', 'Read in an urgent, breathless tone, like a reporter breaking a story live.', 'urgent, breaking news', FOR_A_LAUGH],
  ['Whisper', 'Read in a hushed whisper, as if sharing a secret in a library.', 'whispers', FOR_A_LAUGH],
  ['Sports commentator', 'Read like a sports commentator calling the final minute of a close match, fast and rising.', 'excited sports commentary', FOR_A_LAUGH],
  ['Noir detective', "Read in a low, world-weary noir detective's voice, slow and full of pauses.", 'low, world-weary', FOR_A_LAUGH],
];

// A tag this long stops being a short performance cue and starts being a
// second sentence. 40 chars covers every named ElevenLabs tag with room for a
// typed phrase like "on the verge of tears" and still reads as direction.
export const MAX_TAG_LEN = 40;

/**
 * The cue a style stands for on an engine that reads tags: a built-in tone's
 * Gemini directive is its short cue, anything else is itself. So a deck or a
 * track that saved the directive (picked on Gemini, then moved to ElevenLabs)
 * still sends the tone, not the first forty characters of its prose.
 */
export function cueFor(style) {
  const raw = String(style ?? '').trim();
  return TONES.find(([, directive]) => directive === raw)?.[2] ?? raw;
}

// Words a cut cue cannot end on: "like a" is not direction, "warm" is.
const DANGLING = /(?:[\s,;:—–-]+|\s+(?:a|an|the|and|or|but|nor|as|like|of|to|with|who|which|that|is|are|in|on|at|for|from|by|than|while|your|my|its|very|so|quite|really|most|more|just))+$/i;

/**
 * A style as one ElevenLabs audio tag, and whether it had to be cut to be one:
 * `{ tag, cut }`, `tag` '' when there is nothing to say.
 *
 * Someone who already knows the syntax can type `[whispers]` and get exactly
 * that cue: the first well-formed bracketed group survives untouched (and only
 * the first: a second `[…]` would be a second cue riding along uninvited).
 * Anyone else types a word or a phrase, which is wrapped in brackets for them.
 * A cue longer than `maxLen` is cut at the last word that fits, and a trailing
 * comma or connective goes with the cut, so the tag ends on a word that stands.
 */
export function cutTag(style, maxLen = MAX_TAG_LEN) {
  const raw = cueFor(style);
  if (!raw) return { tag: '', cut: false };
  const bracketed = raw.match(/^\[([^[\]]+)\]/);
  const whole = (bracketed ? bracketed[1] : raw).trim().replace(/\s+/g, ' ');
  if (whole.length <= maxLen) return { tag: whole ? `[${whole}]` : '', cut: false };
  // the slice ends on a word when the character after it is a space
  const space = whole[maxLen] === ' ' ? maxLen : whole.lastIndexOf(' ', maxLen);
  // one word longer than the cap has no boundary to cut at: cut it there
  let cue = space > 0 ? whole.slice(0, space) : whole.slice(0, maxLen);
  for (let was; was !== cue;) { was = cue; cue = cue.replace(DANGLING, ''); }
  cue = cue.trim();
  return { tag: cue ? `[${cue}]` : '', cut: true };
}

/** {@link cutTag}'s tag alone. */
export const styleTag = (style, maxLen = MAX_TAG_LEN) => cutTag(style, maxLen).tag;

/**
 * The line that tells an author their tone will not reach ElevenLabs as they
 * wrote it, or null when it does. One wording for the deck's tone row and for
 * `decklight narrate`.
 */
export function cutNote(style, maxLen = MAX_TAG_LEN) {
  const { tag, cut } = cutTag(style, maxLen);
  if (!cut) return null;
  return tag
    ? `cut to ${tag} for ElevenLabs — tones here are short cues`
    : 'too long for an ElevenLabs cue and dropped — tones here are short cues';
}
