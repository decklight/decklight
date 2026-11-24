// Is a viseme timeline as long as the audio it is played beside? (#1244)
//
// Pure, and shared by the runtime (src/core/character.js, which can measure
// the playing audio and nothing else) and the export (tools/viseme-match.mjs,
// which checks the stronger things first). A take of a different length is a
// different take: its sidecar would have the mouth stop early, or keep moving
// after the voice has stopped.

/**
 * How far a timeline's end may sit from its audio's before it is another
 * recording's. Rhubarb's duration IS the audio's, and the deck's stitched
 * timeline is built to equal its WAV; a second is far past any rounding.
 */
export const DRIFT_S = 1;

/** Where a timeline says its audio ends, or null when it says nothing. */
export function timelineEnd(tl) {
  if (Number.isFinite(tl?.duration) && tl.duration > 0) return tl.duration;
  const cues = Array.isArray(tl?.cues) ? tl.cues : [];
  return cues.length ? Math.max(...cues.map((c) => Number(c?.t) || 0)) : null;
}

/** False only when both lengths are known and they disagree by more than DRIFT_S. */
export function timelineFits(tl, duration) {
  const end = timelineEnd(tl);
  return !(Number.isFinite(duration) && duration > 0 && end != null && Math.abs(end - duration) > DRIFT_S);
}
