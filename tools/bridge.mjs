// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The bits every localhost bridge repeats. A file://-opened deck probes these
// servers directly (origin "null"), so they answer wide-open CORS — but bind
// 127.0.0.1 only, so "open" means "open to this machine". The tts bridge, the
// lipsync bridge, and the edit live-reload server each carried their own copy.

/**
 * CORS headers for a bridge. `expose` is the comma-list of response headers the
 * player is allowed to read (cost estimates, cache flags); omit it when there
 * are none.
 */
export const corsHeaders = (expose = '') => ({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  ...(expose ? { 'access-control-expose-headers': expose } : {}),
});

/**
 * Read a request body to a Buffer. Call it INSIDE the route's try: a client
 * abort mid-request rejects the stream, and unguarded that would crash the
 * whole bridge. Callers that want text `.toString()` the result.
 */
/**
 * The whole request body, as bytes.
 *
 * `max` is opt-in, and which callers set it is the design. The lipsync bridge
 * receives a slide's WAV here and the TTS bridge a sentence; neither has a
 * size a cap could sensibly name. The phone remote in cli/present.mjs does:
 * it is the one route reachable from OFF this machine under --remote, its
 * payloads are a few dozen bytes of "go to slide 7", and a body past 4 KB is
 * not a bigger request, it is someone probing. So that caller passes `max`,
 * and past it the socket is destroyed — no response, no 413 to time against,
 * exactly what present.mjs did with its own reader before this shared one
 * could — and the caller gets an error it can recognise and drop.
 */
export async function readBody(req, { max = Infinity } = {}) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) {
      req.destroy();
      const err = new Error(`request body past ${max} bytes`);
      err.code = 'E2BIG';
      throw err;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
