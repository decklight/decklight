// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The `.decklight` container (MARKETPLACE.md DECK_FILE).
 *
 * A signed deck travels as two files — `talk.html` and `talk.html.sig` — and
 * two files is one more than people forward. The container carries the pair as
 * one artifact, and a double-click on it opens `decklight present` rather than
 * a raw browser (DECK_FILE#ASSOC).
 *
 * **The extension is `.decklight`, not `.deck`** — decided after looking: `.deck`
 * belongs to Decker, an active cross-platform HyperCard revival whose files are
 * *also* interactive decks exported as single HTML documents, which is about as
 * adjacent as a collision gets; `.dck` is Forge/XMage Magic decks. Zero-collision
 * verbosity is the feature.
 *
 * ## The layout, and why it is this one
 *
 *     [ the bundled deck, verbatim HTML ]\n<!--\n[ ZIP of { <deck>.sig, manifest.json } ]\n-->\n
 *
 * The deck comes FIRST and untouched. That ordering is what makes the last
 * acceptance criterion possible — rename a `.decklight` to `.html` and a
 * browser plays it — because the recipient who cannot be relied upon to have
 * the tooling is the whole reason this wave exists, and a format that met them
 * with a wall would be worse than the plain HTML file it replaced.
 *
 * **The HTML comment around the archive is not decoration.** "A parser stops
 * caring after `</html>`" is a comfortable thing to assume and it is wrong:
 * character tokens in the "after after body" insertion mode are reprocessed
 * into the body, so a naive append puts the raw ZIP bytes on screen as text.
 * (A render harness caught exactly that — `deckfile-render` still asserts no
 * archive byte reaches `document.body.textContent`.) A comment token, by
 * contrast, is inserted into the document and never rendered.
 *
 * It is still a real ZIP. Every offset a ZIP records is measured from the start
 * of the FILE, so writing them with the prefix's length already added produces
 * an archive `unzip` reads happily — a self-extracting archive is built exactly
 * this way. And the closing `-->` lives in the archive's own **comment field**
 * rather than trailing after the end record, so there are no stray bytes for a
 * ZIP tool to complain about. One file, two readers, neither one lied to.
 *
 * The one thing that could break the wrapper is the byte sequence `-->` turning
 * up inside the compressed archive, which would close the comment early. So the
 * pack checks, and pads the manifest until it does not — deflate is
 * deterministic, so this converges immediately and produces the same bytes
 * every time.
 *
 * ## What the manifest is, and is not
 *
 * It sits OUTSIDE the payload so that editing the deck and editing its label are
 * not one action. But metadata is not evidence: the manifest carries the
 * payload's SHA-256, so a tamperer who edits the deck has to fix the digest
 * too — and the *signature*, which they cannot, is what makes that matter. The
 * manifest describes; the sidecar attests. Neither is asked to do the other's
 * job.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { zipSync } from './zip.mjs';
import { unzip, zipEntries } from '../tools/zip.mjs';

export const DECK_EXT = '.decklight';
export const MANIFEST = 'manifest.json';

/** The comment that hides the archive from an HTML parser. Fixed bytes, both
 *  ends: the opener is part of the format's structure (the reader subtracts it
 *  to find where the deck stops), and the closer rides in the ZIP's own
 *  archive-comment field so no byte trails the end record. */
export const OPEN = '\n<!--\n';
export const CLOSE = '\n-->\n';

/** Is this path a container, by name? (Contents are checked when it is read.) */
export const isContainer = (file) => path.extname(file).toLowerCase() === DECK_EXT;

/** The container `bundle -o out.html --deck` writes: out.decklight. */
export const containerFor = (file) => file.replace(/\.[^.\\/]+$/, '') + DECK_EXT;

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * Where this deck came from, when the answer is knowable.
 *
 * Read from the deck's own repository, and omitted entirely when there isn't
 * one — a manifest that guessed at provenance would be worse than one that says
 * nothing, because the guess is what someone would end up quoting.
 */
export function originOf(deckPath) {
  const cwd = path.dirname(path.resolve(deckPath));
  const git = (...args) => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return ''; }
  };
  const repo = git('remote', 'get-url', 'origin');
  const commit = git('rev-parse', 'HEAD');
  const origin = {};
  if (repo) origin.repo = repo;
  if (commit) origin.commit = commit;
  return Object.keys(origin).length ? origin : null;
}

/**
 * Build the container bytes.
 *
 * `payload` is the bundled deck, `signature` its Sigstore bundle. Both are
 * required: a container is the SIGNED artifact, and one without a signature
 * would be a zip file wearing the name of an attestation.
 */
export function packContainer({ payload, signature, name = 'deck.html', runtime = null, origin = null, extensions = [] }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  if (!signature) throw new Error('a .decklight container is the signed artifact — there is nothing to pack without a signature');
  const manifest = {
    decklight: 1,
    payload: { name, bytes: body.length, sha256: sha256(body) },
    runtime,
    origin,
    extensions,
    signature: `${name}.sig`,
  };
  const open = Buffer.from(OPEN, 'utf8');

  // Pad until the compressed bytes carry neither comment terminator. The pad
  // is whitespace in the manifest JSON, so it changes nothing a reader parses;
  // deflate is deterministic, so the same input always lands on the same
  // answer and the container stays byte-reproducible.
  for (let pad = 0; pad < 64; pad++) {
    const zip = zipSync([
      { name: `${name}.sig`, data: `${JSON.stringify(signature, null, 2)}\n` },
      { name: MANIFEST, data: `${JSON.stringify(manifest, null, 2)}${' '.repeat(pad)}\n` },
    ], { prefix: body.length + open.length, comment: CLOSE });
    if (!/--!?>/.test(zip.toString('latin1', 0, zip.length - CLOSE.length))) {
      return { bytes: Buffer.concat([body, open, zip]), manifest };
    }
  }
  // Not reachable in practice; a loud failure beats a container that renders
  // half an archive on someone's screen.
  throw new Error('could not pack a container whose archive stays inside an HTML comment');
}

/**
 * Split a container back into its parts.
 *
 * The payload's length comes from the ZIP's own first local-header offset — a
 * structural fact — and not from the manifest, which is the half a tamperer
 * would edit. The manifest's digest is then checked AGAINST that payload, so
 * disagreement is reported rather than resolved in either side's favour.
 *
 * Throws for a file that is not a container at all. Returns
 * `{ payload, signature, manifest, digestOk }` otherwise; `digestOk === false`
 * means the label does not describe the deck it is stapled to, which the caller
 * treats exactly like a signature that does not verify.
 */
export function readContainer(file) {
  const buf = readFileSync(file);
  let entries;
  try { entries = zipEntries(buf); } catch (e) {
    throw new Error(`${path.basename(file)} is not a .decklight container (${e.message})`);
  }
  if (!entries.length) throw new Error(`${path.basename(file)} carries no container entries`);
  // Where the deck stops is structural — the first local header's offset, less
  // the fixed opener — and not whatever the manifest claims, because the
  // manifest is the half a tamperer edits. The opener is then checked, so a
  // file that merely happens to end in a ZIP is rejected rather than sliced at
  // a boundary this format never wrote.
  const archiveAt = Math.min(...entries.map((e) => e.offset));
  const payloadEnd = archiveAt - OPEN.length;
  if (payloadEnd < 0 || buf.toString('utf8', payloadEnd, archiveAt) !== OPEN) {
    throw new Error(`${path.basename(file)} is not a .decklight container (its archive is not wrapped the way one is)`);
  }
  const payload = buf.subarray(0, payloadEnd);

  const parts = unzip(buf);
  const manifestRaw = parts.get(MANIFEST);
  if (!manifestRaw) throw new Error(`${path.basename(file)} has no ${MANIFEST} — not a .decklight container`);
  let manifest;
  try { manifest = JSON.parse(manifestRaw.toString('utf8')); } catch (e) {
    throw new Error(`${path.basename(file)}: ${MANIFEST} is not readable JSON (${e.message})`);
  }

  const sigName = typeof manifest.signature === 'string' ? manifest.signature : null;
  const sigRaw = sigName ? parts.get(sigName) : null;
  let signature = null;
  if (sigRaw) {
    try { signature = JSON.parse(sigRaw.toString('utf8')); } catch { signature = null; }
  }

  return {
    payload,
    signature,
    manifest,
    // Not "valid": just whether the two halves agree about what is here.
    digestOk: manifest?.payload?.sha256 === sha256(payload),
  };
}

/** One line naming what the container says about itself. Never a verdict. */
export function formatManifest(manifest, { indent = '  ' } = {}) {
  const bits = [];
  if (manifest?.runtime) bits.push(`runtime ${manifest.runtime}`);
  if (manifest?.origin?.repo) {
    bits.push(`from ${manifest.origin.repo}${manifest.origin.commit ? `@${manifest.origin.commit.slice(0, 7)}` : ''}`);
  }
  const ext = manifest?.extensions ?? [];
  bits.push(ext.length ? `declares ${ext.length} extension${ext.length === 1 ? '' : 's'}: ${ext.join(', ')}` : 'declares no extensions');
  // "says" and not "is" — the manifest is the container's own claim about
  // itself, and the signature is the only part of this that anyone checked.
  return `${indent}container — says: ${bits.join(' · ')}`;
}

/** The deck's own runtime version claim, for the manifest. */
export function runtimeVersionOf(html) {
  return /\/\*!\s*Decklight v(\d+\.\d+\.\d+[^\s*]*)/.exec(html)?.[1] ?? null;
}

/** Does a path exist and look like a container? (For the CLI's error paths.) */
export const containerExists = (file) => isContainer(file) && existsSync(file);
