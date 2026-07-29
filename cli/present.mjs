// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `decklight present <deck>` — play a deck you did not author.
 *
 * The asymmetry this answers (MARKETPLACE.md WHY): a plugin runs on the
 * machine of the person who chose to install it, but a DECK travels — emailed,
 * published, presented — so anything inlined into one runs in front of an
 * audience that installed nothing and consented to nothing. Opening someone
 * else's deck straight off the filesystem gives that content `file://` origin
 * and no policy at all.
 *
 * Serving it over localhost instead buys the one thing a file cannot have: a
 * `Content-Security-Policy` **HTTP header**, which the document cannot
 * override. A `<meta>` CSP inside the deck is worth nothing here — an attacker
 * who can edit the payload edits the meta tag in the same pass.
 *
 * This module registers exactly one capability: GET a file under the deck's
 * directory. There is no `/edit/*` route to refuse, because none is ever
 * registered (#168 split `cli/serve.mjs` out of `cli/edit.mjs` for precisely
 * this), and nothing here writes to disk.
 *
 * Scope note: the ingredients label (PRESENT#AUDIT) and `--strict`
 * (PRESENT#STRICT) stack on this command in their own tickets. This one is the
 * server.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { argReader, isMain } from '../tools/args.mjs';
import { isLoopback, staticFiles, listenTakingOverIfNeeded } from './serve.mjs';
import { auditDeck, formatLabel } from './audit.mjs';

/**
 * The policy, and honestly what it is worth.
 *
 * `script-src` has to carry `'unsafe-inline'`: a bundled deck IS inline script
 * (the runtime is inlined by `decklight bundle`) and even a source deck calls
 * `Decklight.init()` from an inline block. So this header does NOT stop a deck
 * from running script — that is what PRESENT#AUDIT names and PRESENT#STRICT
 * strips, and claiming otherwise here would manufacture confidence the
 * mechanism cannot back.
 *
 * What it does stop is what a hostile deck would want to DO with that script:
 * `default-src 'none'` denies every fetch destination not listed below,
 * `object-src` kills plugin embedding, `base-uri` stops relative-URL
 * hijacking, and `form-action 'none'` means a credential form pasted into a
 * deck has nowhere to post. Exfiltration is narrowed to `https:` rather than
 * closed, because that is where SPEC'd narration lives (below).
 *
 * Each opening is a SPEC'd feature, not a convenience:
 * - `media-src https:` — a recorded track's `dir` may be an absolute URL, and
 *   background video stays external by design (PRESENTING). `blob:` is the
 *   stitched/`createObjectURL` audio path.
 * - `connect-src https:` — manifest tracks fetch `manifest.signed.json` from a
 *   bucket; a presigned URL's origin is not knowable ahead of time, so it
 *   cannot be pinned to an allowlist here.
 * - `frame-src`/`frame-ancestors 'self'` — the theme picker, the slide finder
 *   and the speaker view all boot the deck into same-origin iframes. `'none'`
 *   would break the picker preview; `'self'` still refuses embedding by
 *   another site.
 * - `style-src 'unsafe-inline'` — themes are inline `<style data-theme>`
 *   blocks and the engine writes inline custom properties (`--pin-y`).
 *
 * Deliberately absent: the local TTS/lipsync bridges (`127.0.0.1:8787/8789`).
 * Live synthesis is an authoring-path engine, and MARKETPLACE.md ENGINES is
 * explicit that engines never come up outside author mode — a deck you were
 * emailed asking to reach a local service is the shape of a probe. Recorded
 * narration needs no bridge and is unaffected.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const USAGE = `usage: decklight present <deck.html> [--port 8790] [--check]

  plays a deck read-only over localhost — the safe way to open one you did not
  author. Serves ONLY GET, only under the current directory (which the deck must
  be inside, so its assets resolve), and writes nothing.

  --port N   port to bind; a taken port offers to take over that session
             (on a TTY) or moves on to the next free one            [8790]
  --check    print the ingredients label and exit — no server. Exits non-zero
             if the deck runs any script that is not the runtime, so CI can
             gate on a deck before it is forwarded or published.

  Every start prints the ingredients label: which runtime is embedded and
  whether its bytes are the ones this install ships, how many inert data blocks
  the runtime will read, and — named, with line numbers — every script block
  that will execute and is NOT accounted for. It is an inventory, not a verdict:
  there is no "safe" here, because the scan is a heuristic over a file someone
  may have edited and a green check would promise more than it can keep.

  There is no --remote and no editing surface: the /edit/* routes are not
  registered at all, so a POST to one is as unknown as a POST to anything else.

  Every response carries this Content-Security-Policy as an HTTP header, which
  the deck cannot override the way it could a <meta> tag:

    ${CSP.replace(/; /g, ';\n    ')}

  Recorded narration from a bucket and external background video still play —
  that is what the https: sources in media-src/connect-src are for. Live voice
  does not: synthesis needs the local bridge, which is an authoring-mode engine
  and is deliberately not reachable from here.

  Read the policy honestly: script-src carries 'unsafe-inline' because a
  bundled deck IS inline script, so this does not stop a deck from running
  code. It stops that code from reaching anywhere it shouldn't.`;

export async function presentMain(args) {
  const positional = args.filter((a) => !a.startsWith('-'));
  if (args.includes('--help') || args.includes('-h') || !positional.length) {
    console.log(USAGE);
    return 0;
  }
  const { opt } = argReader(args);
  const port = Number(opt('--port', 8790));

  const root = process.cwd();
  const deckPath = resolve(root, positional[0]);
  if (!existsSync(deckPath)) {
    console.error(`deck not found: ${deckPath}`);
    return 1;
  }
  // The audit runs because it is the only way in (PRESENT): a standalone
  // `verify` is a step people skip, so folding it into the command you already
  // use to present means it runs every time, at no extra effort.
  const report = auditDeck(readFileSync(deckPath, 'utf8'));

  // --check reads one file and exits. It is deliberately ahead of the
  // served-root guard below: that rule is about what a SERVER exposes, and
  // auditing a deck sitting anywhere on disk exposes nothing. Making CI cd
  // somewhere first to read a file would be a rule with no reason behind it.
  if (args.includes('--check')) {
    for (const line of formatLabel(report, { indent: '' })) console.log(line);
    // Non-zero means "this deck executes something I could not account for" —
    // not "this deck is malicious", which is a call no exit code should make.
    return report.counts.unaccounted ? 1 : 0;
  }

  // The cwd is the served root, and the deck must live under it — `edit`'s rule,
  // for `edit`'s reason: a deck's assets are not always its siblings. A source
  // deck reaches up for the runtime (`demo/showcase.html` loads
  // `../dist/decklight.js`), so rooting at the deck's own directory would 403
  // the engine and serve a page that never boots.
  //
  // The exposure is therefore chosen by where you run the command, which is why
  // startup prints the directory rather than only the URL. A deck handed to you
  // is usually a bundled single file with no external refs at all — for those,
  // `cd` to its directory and the served root is exactly it.
  if (!deckPath.startsWith(root + sep)) {
    console.error('deck must live under the current directory');
    return 1;
  }
  const deckUrl = '/' + deckPath.slice(root.length + 1).split(sep).join('/');

  const files = staticFiles(root, { index: deckUrl, headers: { 'content-security-policy': CSP } });

  const server = createServer((req, res) => {
    // Loopback only, by construction as well as by binding: nothing here has a
    // token to widen with, so this is a flat refusal rather than a classifier.
    if (!isLoopback(req.socket?.remoteAddress)) { res.writeHead(403); res.end('forbidden'); return; }
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end('bad request'); return; }
    // staticFiles answers GET (200/403/404) and declines everything else. A
    // POST to /edit/notes lands here exactly like a POST to /anything — there
    // is no route to have refused it, which is the point of the ticket.
    if (files(req, res, url)) return;
    res.writeHead(405);
    res.end('method not allowed');
  });

  const actual = await listenTakingOverIfNeeded(server, port, '127.0.0.1');
  console.log(`decklight present on http://127.0.0.1:${actual}${deckUrl} — read-only, CSP enforced. Ctrl-C stops`);
  console.log(`  serving ${root} — GET only, no /edit/* routes, nothing is written`);
  // Before the first slide renders, not after — the point is to be able to
  // decide not to open it.
  for (const line of formatLabel(report)) console.log(line);

  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await presentMain(process.argv.slice(2));
