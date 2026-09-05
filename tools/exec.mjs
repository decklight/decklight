// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * One bounded child exec, for the sixteen places a hang could sit forever.
 *
 * #431 found a `say` with 0.31s of CPU after eight minutes, blocked in macOS's
 * speech server, and an execFileSync above it with no timeout — so
 * `decklight voiceover` waited with it, silently. That was one call of forty-
 * three. The others are the same shape with different daemons behind them:
 * gcloud waiting on a login that expired, gh waiting on the network, ffmpeg
 * spinning on a file that is not what its extension says, Chrome waiting on
 * a resource a slide points at. None of them ever say so.
 *
 * `run` is execFileSync with two things that should never be optional: a
 * timeout, and SIGKILL rather than SIGTERM when it fires — a wedged process
 * is blocked in a syscall and a polite signal is exactly what it is not
 * answering. A timeout throws an error that names the binary, the wait, and
 * WHY (the caller's word for what is probably stuck), because the person
 * reading it will otherwise reword the sentence, re-encode the file, or
 * reinstall the tool — anything but restart the daemon that is the actual
 * problem.
 *
 * Every OTHER error is rethrown untouched. Callers inspect `.status`,
 * `.stderr` and `.code === 'ENOENT'` — a probe that treats "present but
 * exiting 1" as present depends on that — and wrapping them would break every
 * one.
 *
 * Budgets, named for what they are rather than how long: a probe answers in
 * milliseconds, the network in seconds, a codec in as long as the audio is.
 */

import { execFileSync } from 'node:child_process';

/** `--version` and its kin. Anything slower than this is not answering. */
export const PROBE_MS = 15_000;
/** gcloud, gh: a login prompt nobody can see, or a network that is not there. */
export const NETWORK_MS = 60_000;
/** ffmpeg, afconvert, Chrome: a whole slide's audio, a whole deck's render. */
export const CODEC_MS = 5 * 60_000;

export function run(bin, args, { timeout = NETWORK_MS, why = '', ...opts } = {}) {
  try {
    return execFileSync(bin, args, { ...opts, timeout, killSignal: 'SIGKILL' });
  } catch (e) {
    if (e.code === 'ETIMEDOUT' || (e.signal === 'SIGKILL' && e.status == null)) {
      const err = new Error(`${bin} hung for ${Math.round(timeout / 1000)}s and was killed`
        + (why ? ` — ${why}` : ''));
      err.code = 'ETIMEDOUT'; err.bin = bin; err.cause = e;
      throw err;
    }
    throw e;
  }
}
