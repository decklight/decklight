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
 * Three things now ride on that one capability, in the order they run: the
 * ingredients label names what the file will execute (PRESENT#AUDIT), strict
 * mode removes what it could not account for on the way out (PRESENT#STRICT),
 * and the CSP header bounds whatever is left.
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { argReader, isMain } from '../tools/args.mjs';
import { allowRemote, lanAddress, staticFiles, sseChannel, listenTakingOverIfNeeded, withHeaders } from './serve.mjs';
import { createRemoteRelay } from './remote.mjs';
import { corsHeaders } from '../tools/bridge.mjs';

// The phone is a different origin from the deck (a LAN address, not localhost),
// so the remote's own endpoints need CORS. Nothing else here does — the deck is
// same-origin with the server that serves it.
const CORS = corsHeaders();
import { auditDeck, formatLabel, stripUnaccounted } from './audit.mjs';
import { loadLibrary, injectChrome } from './plugin.mjs';
import { verifyFile, verifyBytes, formatSignature, isVerified, UNSIGNED, TAMPERED, VERIFIED } from './sign.mjs';
import { isContainer, readContainer, formatManifest } from './deckfile.mjs';

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

const USAGE = `usage: decklight present <deck.html|deck.decklight> [--port 8790] [--strict]
                        [--remote] [--host <addr>] [--check] [--no-plugins]

  plays a deck read-only over localhost — the safe way to open one you did not
  author. Serves ONLY GET, only under the current directory (which the deck must
  be inside, so its assets resolve), and writes nothing.

  A .decklight container (bundle --deck) is unwrapped in memory and treated
  exactly like the deck it wraps: same audit, same policy, same strict rule. Its
  signature is verified and its manifest is printed as what it is — the
  container's own claim about itself, next to the one thing that was checked.
  The manifest's origin (repo and commit) is never printed: the signature
  covers the deck alone, so even on a verified container the origin is whatever
  the packer wrote, and a provenance line nobody vouches for does not belong
  one skim away from a verified identity. It stays in the manifest for tooling
  to read.

  --port N   port to bind; a taken port offers to take over that session
             (on a TTY) or moves on to the next free one            [8790]
  --strict   serve with every script block that is not the runtime removed,
             along with every inline on*= handler, javascript: URL and srcdoc
             document. The removal happens on the way out — the file on disk
             is never touched. Turns itself on when the label finds something.
  --remote   also listen on the LAN for the phone remote. Off this machine ONLY
             /remote/* answers, and only with the per-run token the printed URL
             and its QR carry — the deck itself, and every file beside it, stay
             unreachable from the LAN whether or not this flag is passed.
  --host A   the address --remote binds                            [0.0.0.0]
  --check    print the ingredients label and exit — no server. Exits non-zero
             if the deck runs any script that is not the runtime — a block or
             an executable attribute — so CI can gate on a deck before it is
             forwarded or published.
  --no-plugins  present without your own chrome, whatever is installed.

  Your presenter plugins (decklight plugin) are layered on at serve time from
  ~/.decklight/plugins/ — a timer, a teleprompter, a confidence monitor. They
  are YOURS: the deck on disk is untouched, nothing is written into it, and the
  same file presented on a machine without them is identical slides and no
  warning. Each one renders inside a sandboxed frame with an opaque origin, so
  it draws chrome and cannot reach the slides — a plugin that asks for slide
  content is refused by name, because a deck has to stay a deterministic
  artifact or two people presenting the same file present different decks.

  A plugin is never part of the ingredients label: the label counts what is in
  the file, the chrome is listed under it as what it is. Loading one registers
  no route and does not widen the policy below by a single source.

  Every start prints the ingredients label: which runtime is embedded and
  whether its bytes are the ones this install ships, how many inert data blocks
  the runtime will read, and — named, with line numbers — every script block
  that will execute and is NOT accounted for, plus every executable attribute
  (an inline on*= handler, a javascript: or data:text/html URL, an inline
  srcdoc document — the vectors 'unsafe-inline' below would otherwise let run
  unnamed). It is an inventory, not a verdict:
  there is no "safe" here, because the scan is a heuristic over a file someone
  may have edited and a green check would promise more than it can keep.

  A deck with a detached signature beside it (talk.html.sig) is verified BEFORE
  it renders, and the terminal names who signed it — an identity you can judge,
  not a check mark. Sigstore keyless, so there are no keys: the certificate was
  minted for one signature against the signer's OIDC identity and expired
  minutes later; the transparency log is what keeps it checkable. A deck with no
  sidecar is not an alarm — most decks are unsigned, and treating that as a
  finding would train you to ignore the one that matters. Verifying needs the
  sigstore client and the network; when it cannot be done here, that is said as
  its own state and never as a pass.

  When the label finds an unaccounted block — or a signature does not verify,
  or cannot be checked here — strict mode turns ITSELF on and says so in the
  terminal. It does not ask, and there is no --force to turn it
  back off: ten minutes before a talk is the worst possible moment for a
  refusal, and an escape hatch would be reached for exactly then — so the deck
  always plays, and the part nobody can account for is the part that doesn't.
  Removed blocks are named in the terminal, never on the audience's screen.

  What survives strict is what a deck needs to render itself: the runtime, the
  Decklight.init call, JSON data blocks and templates. Builds, layouts, themes,
  charts and background media are markup, CSS and attributes — never at risk. A
  clean deck under --strict is byte-identical to the same deck without it.

  There is no editing surface: the /edit/* routes are not registered at all, so
  a POST to one is as unknown as a POST to anything else. That is also why the
  phone remote lives here rather than on the author server — getting a clicker
  should not mean running write endpoints against your deck while you are on
  stage and not looking at it.

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

  // --remote widens the LISTENER and nothing else (PRESENT#REMOTE). The point
  // of moving the phone remote here is that getting a clicker should not mean
  // running an editing server against your deck while you are on stage and not
  // looking at it — so this server still registers no /edit/* route, and the
  // only paths a caller off this machine can reach are /remote/*, with the
  // per-run token. allowRemote is the same classifier the author server uses;
  // one implementation, tested once.
  const remote = args.includes('--remote') || opt('--host') !== undefined;
  const host = remote ? opt('--host', '0.0.0.0') : '127.0.0.1';
  const token = remote ? randomBytes(16).toString('base64url') : null;

  const root = process.cwd();
  const deckPath = resolve(root, positional[0]);
  if (!existsSync(deckPath)) {
    console.error(`deck not found: ${deckPath}`);
    return 1;
  }
  // A .decklight is the same deck with its signature and manifest stapled on
  // (DECK_FILE), so it is unwrapped here and everything below treats it exactly
  // like the HTML it wraps — same audit, same CSP, same strict rule. Nothing is
  // written to unwrap it: the payload is a slice of the bytes already read.
  let container = null;
  if (isContainer(deckPath)) {
    try { container = readContainer(deckPath); } catch (e) { console.error(e.message); return 1; }
  }
  const payload = container ? container.payload : readFileSync(deckPath);

  // The audit runs because it is the only way in (PRESENT): a standalone
  // `verify` is a step people skip, so folding it into the command you already
  // use to present means it runs every time, at no extra effort.
  const report = auditDeck(payload.toString('utf8'));

  // The signature, if the deck came with one (INTEGRITY#SIGNING). Costs nothing
  // when there is no sidecar — the common case returns without touching the
  // network — and the audit above runs either way, because the two answer
  // different questions: a signature says WHO vouched for these bytes, the label
  // says what the bytes will do. A signed deck can still run something nobody
  // should, and the label is what would name it.
  let signature;
  if (container) {
    signature = container.signature
      ? await verifyBytes(container.payload, container.signature)
      : { state: TAMPERED, reason: 'the container carries no signature' };
    // The manifest is the container's own label. When it does not describe the
    // deck it is stapled to, something rewrote one half — which is the same
    // conclusion as a signature that does not verify, so it is the same state.
    if (!container.digestOk && signature.state === VERIFIED) {
      signature = { state: TAMPERED, reason: 'the manifest digest does not match the payload' };
    }
  } else {
    signature = await verifyFile(deckPath);
  }

  if (args.includes('--check')) {
    for (const line of formatLabel(report, { indent: '' })) console.log(line);
    if (container) console.log(formatManifest(container.manifest, { indent: '' }));
    if (signature.state !== UNSIGNED) console.log(formatSignature(signature, { indent: '' }));
    // Non-zero means "this deck executes something I could not account for", or
    // "it carries a signature I could not stand behind" — not "this deck is
    // malicious", which is a call no exit code should make. `unchecked` counts:
    // a gate that passes when it could not evaluate the claim is not a gate.
    return report.counts.unaccounted || report.counts.handlers
      || (signature.state !== UNSIGNED && !isVerified(signature)) ? 1 : 0;
  }

  // The cwd is the served root, and the deck must live under it — the author
  // server's rule, for its reason: a deck's assets are not always siblings. A source
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

  // Strict is not a mode you opt into after reading the label — it is what the
  // label DOES when it finds something (PRESENT#STRICT). The alternative
  // designs both fail at the same moment: refusing to serve leaves someone with
  // no talk ten minutes before they give it, and offering a --force turns the
  // finding into a prompt that will be clicked through precisely then. Playing
  // the deck without the part nobody could account for is the only option that
  // is still the right one under time pressure, so it is the automatic one.
  //
  // A signature that does not verify feeds the SAME path (INTEGRITY#SIGNING):
  // signing adds a source of failure, not a new behaviour. There is deliberately
  // no third state where a bad signature means something else — one degrade is
  // one thing to understand at the moment you have no time to understand two.
  const unverified = signature.state !== UNSIGNED && !isVerified(signature);
  const strict = args.includes('--strict') || report.counts.unaccounted > 0
    || report.counts.handlers > 0 || unverified;

  // The rewrite covers every html response, not only the deck: strict that
  // stopped at one file would be walked around by a second page under the same
  // root, and the deck can reach one — the theme picker, the slide finder and
  // the speaker view all boot documents into same-origin iframes.
  // The presenter's own chrome (PRESENT#PLUGINS) — a timer, a teleprompter,
  // a confidence monitor. It is loaded from ~/.decklight/plugins/, which is
  // the presenter's library and not the deck's: the installer is the
  // risk-bearer and nothing here travels, which is the same trust model that
  // makes a build-time transform defensible (MARKETPLACE.md EXTENSIONS).
  //
  // Two orderings below are load-bearing rather than incidental:
  //   - it loads AFTER `auditDeck` has read the bytes, so a plugin is never
  //     counted as an unaccounted script block in the ingredients label. The
  //     label describes the file; a plugin is not in the file.
  //   - it injects AFTER `stripUnaccounted`, so strict mode never strips the
  //     chrome as if the deck had smuggled it in.
  // With an empty library `injectChrome` returns its input, so this whole
  // paragraph is a no-op and `present` is byte-for-byte the command it was.
  const chrome = args.includes('--no-plugins') ? { plugins: [], refused: [] } : loadLibrary();
  const strip = strict ? (text) => stripUnaccounted(text).html : null;

  // Only the deck gets chrome. Every OTHER html file under the root still gets
  // the strict rewrite — strict that stopped at one file would be walked
  // around by a second page under the same root, and the deck can reach one
  // (the theme picker, the slide finder and the speaker view all boot
  // documents into same-origin iframes). Those same iframes are why the chrome
  // is deck-only: presenter chrome belongs to the document the presenter is
  // looking at, and the shim removes itself if it finds it is framed anyway.
  const rewrite = (strip || chrome.plugins.length)
    ? (text, file) => {
      const out = strip ? strip(text) : text;
      return file === deckPath ? injectChrome(out, chrome.plugins) : out;
    }
    : null;
  // No `index` here: "/" is the deck, and the deck is answered from memory
  // before this handler is consulted — a fallthrough should 404, not reopen
  // the disk read this route exists to avoid.
  const files = staticFiles(root, { html: rewrite });

  // The deck itself is served from MEMORY — container and plain HTML alike —
  // from the bytes the audit read and the signature covered. The label, the
  // signature verdict and `strict` were all decided against those bytes at
  // startup and printed as a verdict; re-reading the file per request would
  // let a deck edited on disk AFTER that moment ride out under it (#235). For
  // a container this also avoids the one write this command does not make —
  // unpacking to a temp file that would sit somewhere after the talk, which is
  // precisely the file nobody meant to keep. Everything else about the
  // response is identical to any other file under the root: same strict
  // rewrite, same policy header, same GET-only server around it. If live
  // reload of the deck under `present` is ever wanted, it must re-run the
  // audit and re-print the verdict — never silently serve new bytes.
  const servePayload = (req, res) => {
    if (req.method !== 'GET') return false;
    const body = rewrite
      ? Buffer.from(rewrite(payload.toString('utf8'), deckPath), 'utf8')
      : payload;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(body);
    return true;
  };

  // Is this URL the deck? Matched on the RESOLVED path, exactly as staticFiles
  // would resolve it, so a percent-encoded spelling of the same file cannot
  // slip past this route into the per-request disk read below it.
  const isDeck = (url) => {
    if (url.pathname === '/') return true;
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return false; }
    return resolve(root, '.' + rel) === deckPath;
  };

  // Two one-way channels, kept apart on purpose. `decks` is what a deck served
  // by this server subscribes to, and the ONLY event it ever carries is
  // `remote` — no `reload`, no `agent`, because neither exists here and a
  // presenting server that could tell a deck to reload would be an editing
  // server with the writes left out. The phone's own stream lives in the relay.
  const decks = sseChannel();
  let actualPort = null;
  const relay = createRemoteRelay({
    deckName: basename(deckPath),
    token,
    remoteUrl: () => `http://${lanAddress() ?? host}:${actualPort}/remote?t=${token}`,
    relayToDeck: (event, data) => decks.broadcast(event, data),
    deckCount: () => decks.size,
    CORS,
  });

  // The CSP is set once, out here, for EVERY response this server writes —
  // the deck and its assets, but also the 403/404/405 pages, the control-
  // channel JSON and SSE, and the remote controller. Every body below is a
  // fixed string or first-party content, so no uncovered response was
  // exploitable — but "every response carries the header" is only worth
  // stating if it holds by construction, not by each writeHead remembering.
  const server = createServer(withHeaders({ 'content-security-policy': CSP }, (req, res) => {
    // Loopback always; off-loopback only /remote/* carrying the per-run token,
    // and only when --remote asked for a listener at all. Every other path is
    // refused off this machine unconditionally — flag or no flag, token or no
    // token — which is why the static files and the deck itself cannot be
    // reached from the LAN even while the remote can.
    if (!allowRemote(req, token)) {
      res.writeHead(403);
      res.end('forbidden: this deck is served to this machine only; off it, only /remote/* answers, with the session token');
      return;
    }
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end('bad request'); return; }
    // The deck's own path answers from the audited bytes (servePayload above).
    // For a container that also means the URL a person sees is the file they
    // double-clicked — serving the raw archive bytes there would hand a
    // browser something it cannot render.
    if (isDeck(url)) {
      if (servePayload(req, res)) return;
      res.writeHead(405); res.end('method not allowed'); return;
    }
    // staticFiles answers GET (200/403/404) and declines everything else. A
    // POST to /edit/notes lands here exactly like a POST to /anything — there
    // is no route to have refused it, which is the point of the ticket.
    // The presenting control channel. `/present/ping` is how a deck discovers
    // it is being presented rather than authored, and the answer deliberately
    // carries no agent roster and no edit capability — there is nothing here to
    // report about editing, because there is nothing here that edits.
    if (req.method === 'GET' && url.pathname === '/present/ping') {
      res.writeHead(200, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-cache' });
      res.end(JSON.stringify({ ok: true, name: basename(deckPath), remote: !!token, present: true }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/present/events') { decks.add(req, res, CORS); return; }
    // The phone remote: controller, QR, readout channel. These are the only
    // paths allowRemote let through from off this machine, and not one of them
    // writes anything — the phone asks the deck to move, it never edits.
    let body = '';
    if (req.method === 'POST') {
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        try {
          if (relay.handle(req, res, url, body)) return;
        } catch {
          res.writeHead(400, { ...CORS, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad payload' }));
          return;
        }
        res.writeHead(405);
        res.end('method not allowed');
      });
      return;
    }
    if (relay.handle(req, res, url, '')) return;
    if (files(req, res, url)) return;
    res.writeHead(405);
    res.end('method not allowed');
  }));

  const actual = await listenTakingOverIfNeeded(server, port, host);
  actualPort = actual;
  console.log(`decklight present on http://127.0.0.1:${actual}${deckUrl} — read-only, CSP enforced. Ctrl-C stops`);
  console.log(`  serving ${root} — no /edit/* routes, nothing is written`);
  if (token) {
    console.log(`  remote: listening on ${host} — http://${lanAddress() ?? host}:${actual}/remote?t=${token}`);
    console.log('  off this machine ONLY /remote/* answers, with that token — the deck itself does not');
  }
  // Before the first slide renders, not after — the point is to be able to
  // decide not to open it.
  for (const line of formatLabel(report)) console.log(line);
  if (container) console.log(formatManifest(container.manifest));
  console.log(formatSignature(signature));
  // Reported UNDER the label and never inside it. The label is an inventory of
  // the file; a plugin is not in the file, and folding one into those counts
  // would make the label start describing things the deck does not contain —
  // which is exactly the honesty the label exists for. Naming which plugins
  // read the speaker notes is the other half of `needs: ["notes"]` being a
  // declaration rather than a silent grant.
  for (const p of chrome.plugins) {
    console.log(`  chrome: ${p.name} (${p.slot}) — yours, not in the deck`
      + `${p.needs.includes('notes') ? '; reads your speaker notes' : ''}`);
  }
  for (const r of chrome.refused) {
    console.log(`  chrome: ${r.name} REFUSED — not loaded, the deck plays without it`);
    console.log(`    ${r.reason.replace(/\n/g, '\n    ')}`);
  }
  // Here and nowhere else. The audience is looking at the deck; a banner on the
  // page would tell them something they cannot act on, about a file they did
  // not choose to open, in the middle of someone's talk.
  if (strict) {
    const n = report.counts.unaccounted, h = report.counts.handlers;
    if (unverified) console.log('  the signature did not verify — serving strict');
    const removed = [
      n ? `${n} unaccounted script block${n === 1 ? '' : 's'}` : '',
      h ? `${h} executable attribute${h === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' and ');
    console.log(removed
      ? `  ${removed} stripped — serving strict. The file on disk is untouched`
      : `  nothing to strip — this deck is served exactly as ${container ? 'the container carries it' : 'it was read from disk'}`);
  }

  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await presentMain(process.argv.slice(2));
