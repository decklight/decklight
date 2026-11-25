// What the synthesized recorder does when a sentence does not come back (#1253).
//
// One slide is many sentences, and before this one failed request cost the
// whole slide: no retry, no time limit, and a done card that said "4 / 6
// saved" long after the toast naming the cause had gone. These are the pieces
// that fix it, kept out of narration.js so they can be tested on their own:
//
//   - withTimeout:  a request that does not answer in TTS_TIMEOUT_MS has failed,
//                   so one stuck connection cannot hold a take for minutes
//   - retrying:     a failed sentence is asked for again, after a short back-off,
//                   before its slide is given up on
//   - failureReason / notSavedLine: what the done card says about the slides
//                   that still did not make it

/** How long one sentence may take before it counts as not answered. */
export const TTS_TIMEOUT_MS = 60_000;
/** Attempts per sentence, and the waits between them. */
export const TTS_TRIES = 3;
export const TTS_BACKOFF_MS = [1000, 3000];

/**
 * `promise`, or a rejection once `ms` have passed without it settling. The
 * rejection carries `timedOut: true`; `onTimeout` runs first (abort the fetch).
 */
export function withTimeout(promise, ms, onTimeout) {
  let timer;
  const late = new Promise((_, no) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* the abort is best effort */ }
      const e = new Error(`no answer in ${Math.round(ms / 1000)}s`);
      e.timedOut = true;
      no(e);
    }, ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Worth asking again? A timeout, a dropped connection (no status at all), a
 * 408, a 429 or a 5xx can pass. Any other 4xx is the request itself — a voice
 * the engine does not know, a missing key — and asking again only repeats it.
 */
export function retryableTts(e) {
  if (e?.timedOut) return true;
  const s = Number(e?.status);
  if (!s) return true;
  return s === 408 || s === 429 || s >= 500;
}

/**
 * Run `attempt()` up to `tries` times, waiting `backoff[n]` before retry n+1.
 * Stops early, rethrowing, when the error is not `retryable` or `cancelled()`
 * says the take is over. The final error carries `tries`: how many were made.
 */
export async function retrying(attempt, {
  tries = TTS_TRIES, backoff = TTS_BACKOFF_MS, retryable = retryableTts,
  cancelled = () => false, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), onRetry,
} = {}) {
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (e) {
      if (n >= tries || !retryable(e) || cancelled()) {
        if (e && typeof e === 'object') e.tries = n;
        throw e;
      }
      onRetry?.(e, n);
      await sleep(backoff[Math.min(n - 1, backoff.length - 1)] ?? 0);
      if (cancelled()) {
        if (e && typeof e === 'object') e.tries = n;
        throw e;
      }
    }
  }
}

/**
 * Why a slide was not saved, as one short clause: "ElevenLabs did not answer
 * in 60s", "ElevenLabs answered 429: Quota exceeded", "the voice bridge could
 * not be reached (Failed to fetch)" — with "after 3 tries" when it was retried.
 */
export function failureReason(e, engine) {
  const who = engine || 'the voice service';
  const msg = String(e?.message || e || '').trim();
  let why;
  if (e?.timedOut) why = `${who} did not answer in ${Math.round(TTS_TIMEOUT_MS / 1000)}s`;
  else if (e?.status) why = `${who} answered ${e.status}${msg && msg !== String(e.status) ? `: ${msg}` : ''}`;
  else if (e?.tts) why = `the voice bridge could not be reached${msg ? ` (${msg})` : ''}`;
  else why = msg || 'recording failed';
  if (why.length > 160) why = `${why.slice(0, 157)}…`;
  return e?.tries > 1 ? `${why}, after ${e.tries} tries` : why;
}

/** "slide 3", "slides 33 and 34", "slides 1, 3 and 4". */
export function slidesPhrase(slides) {
  const s = [...slides].sort((a, b) => a - b);
  if (s.length === 1) return `slide ${s[0]}`;
  return `slides ${s.slice(0, -1).join(', ')} and ${s[s.length - 1]}`;
}

/**
 * The done card's line for the slides a take did not save, or '' when it saved
 * them all: "slides 33 and 34 not saved: ElevenLabs did not answer in 60s".
 * The FIRST reason, because the slides of one run almost always share it.
 */
export function notSavedLine(failed) {
  if (!failed?.length) return '';
  return `${slidesPhrase(failed.map((f) => f.slide))} not saved: ${failed[0].reason}`;
}
