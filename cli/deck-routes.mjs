// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The deck's own channel (SPEC PRESENTING): what every served deck gets,
// whichever way it was opened, and the one place it is implemented.
//
//   GET /deck/ping     the one probe every served deck makes: `readOnly` says
//                      which mode answered, `locked` whether anything writes
//                      right now, `review` what a page needs to know before it
//                      comments (review-routes.mjs), and then whatever the
//                      mode adds (the edit server: history, git, agents, the
//                      commit chip; the read-only server: whether the phone
//                      remote is on)
//   GET /deck/events   the stream every tab of the deck listens on; what
//                      travels on it is the mode's (reload, lock and export
//                      events from the edit server, the remote's taps and the
//                      upstream's news from the read-only one)
//
// Two servers used to answer the probe with two literals that drifted apart
// — one said `present: true`, the other `readOnly: false`, and the page had
// to know both. Now the shape is this function's, and a mode contributes its
// extras rather than its own copy of the whole.
//
// Nothing here writes. The lock, the upstream, the review's owner routes and
// everything under /edit/ are the modes' own and registered beside these.

import { basename } from 'node:path';
import { sseChannel } from './serve.mjs';

/**
 * The routes for one served deck.
 *
 * `readOnly` is the mode; `locked` says whether anything writes right now
 * (always true under read-only, the editing lock under write mode); `review`
 * is the review routes' object, for the probe's `review` block; `extras` is
 * what the mode adds to the probe, computed on every call so a ping is never
 * stale.
 */
export function createDeckRoutes(deckPath, { readOnly, locked = () => readOnly, review, extras = async () => ({}) }) {
  const name = basename(deckPath);
  const channel = sseChannel();

  /** The probe's answer, whole. */
  async function ping() {
    return { ok: true, name, readOnly, locked: locked(), review: review.ping(), ...(await extras()) };
  }

  /** `METHOD /path` → handler({ req, res, url, json, CORS }), the same shape as the edit server's table. */
  const routes = new Map([
    // CORS on both: a deck opened from disk probes the default port
    // cross-origin, and the phone's origin differs from the deck's
    ['GET /deck/ping', async ({ json, CORS }) => json(200, await ping(), CORS)],
    ['GET /deck/events', ({ req, res, CORS }) => { channel.add(req, res, CORS); }],
  ]);

  return {
    routes,
    channel,
    /** Tell every open tab of the deck. */
    broadcast: (event, data) => channel.broadcast(event, data),
    ping,
    name,
  };
}
