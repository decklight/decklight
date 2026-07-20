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
export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
