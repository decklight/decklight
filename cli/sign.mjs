// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Sigstore signing and verification for decks (MARKETPLACE.md INTEGRITY).
 *
 * The premise the whole wave rests on: **a file cannot vouch for itself.** An
 * attacker who can edit the payload edits any checker embedded beside it in the
 * same pass, and `file://` HTML gets no OS signature UI at all. So verification
 * has to come from outside the file — which is what a detached signature is.
 *
 * **There are no keys.** Not "the keys are managed elsewhere" — there is no key
 * file anywhere in this design, ever. Sigstore keyless mints a short-lived
 * certificate bound to an OIDC identity, uses it for one signature, and lets it
 * expire minutes later; the transparency log is what makes the signature
 * checkable after that certificate is long dead. It is the same trust root the
 * npm release's provenance already uses, so this adds a use, not a posture.
 *
 * Where that identity comes from is worth stating exactly, because the obvious
 * assumption is wrong: `sigstore@5` has **no interactive browser flow**. It
 * takes the ambient OIDC token in CI (GitHub Actions with `id-token: write`,
 * which is what `release.yml` already grants npm) or an identity token handed
 * to it explicitly — `SIGSTORE_ID_TOKEN`, the variable cosign uses. On a
 * workstation with neither, signing fails in a fraction of a second saying so.
 * Describing a sign-in this client cannot perform would send someone looking
 * for a browser window that is never going to open.
 *
 * **The sidecar is the authority.** `talk.html` is signed; `talk.html.sig`
 * carries the Sigstore bundle. Nothing is embedded in the deck: a copy inside
 * the payload cannot cover the payload that contains it, so it could only ever
 * be a convenience — and a convenience that looks like a signature is worse
 * than no signature at all.
 *
 * The client is an OPTIONAL dependency, loaded lazily and never at import time.
 * The runtime keeps zero dependencies (CLAUDE.md) and CI installs with
 * `--omit=optional`, so every path here has to behave sensibly when `sigstore`
 * is simply not there — and "sensibly" means saying so, never quietly deciding
 * an unverified deck is fine.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';

/** Where a file's signature lives. Detached, adjacent, and boringly named. */
export const sidecarFor = (file) => `${file}.sig`;

/** How to get the client, said once, so every caller says it the same way. */
export const INSTALL_HINT = 'run: npm install sigstore';

/**
 * The sigstore client, or null when it is not installed.
 *
 * Lazy on purpose: an import at module load would make `present` — which needs
 * this only when a sidecar exists — pay for it on every start, and would make
 * the whole CLI unloadable on an install that skipped optional dependencies.
 */
export async function loadClient() {
  try { return await import('sigstore'); } catch { return null; }
}

/**
 * Sign bytes; return the Sigstore bundle to write as a sidecar.
 *
 * Throws rather than returning a failure, and the caller is expected to have
 * written NOTHING yet: `bundle --sign` signs the deck it is about to write, so
 * a signing failure leaves no unsigned artifact behind to be picked up later
 * and mistaken for a finished one. That ordering is the whole reason this takes
 * bytes instead of a path.
 */
export async function signBytes(bytes, { client, token = process.env.SIGSTORE_ID_TOKEN } = {}) {
  // `undefined` means "go find one"; an explicit null means "there isn't one",
  // which is how a caller (and a test) says so without hiding node_modules.
  const sigstore = client === undefined ? await loadClient() : client;
  if (!sigstore) {
    throw new Error(`signing needs the sigstore client, which is not installed — ${INSTALL_HINT}`);
  }
  try {
    return await sigstore.sign(Buffer.from(bytes), token ? { identityToken: token } : {});
  } catch (e) {
    // Two different things fail here and both deserve naming. Fulcio issues the
    // certificate and Rekor records the entry, so keyless signing cannot happen
    // offline — and before either, something has to say who you are. Reporting
    // a bare socket error or "error retrieving identity token" would leave
    // someone auditing their deck for a fault that is not in it.
    throw new Error(`signing failed: ${e.message}\n`
      + '  Sigstore keyless needs two things: an OIDC identity to sign as — the\n'
      + '  ambient token in CI (GitHub Actions needs `permissions: id-token: write`),\n'
      + '  or SIGSTORE_ID_TOKEN set explicitly; this client has no browser sign-in —\n'
      + '  and the network, for Fulcio to issue the certificate and Rekor to record\n'
      + '  it. Nothing was written.');
  }
}

/**
 * The states a deck's signature can be in, and what each one means.
 *
 * `unsigned` is NOT a failure — most decks are unsigned, and treating "nobody
 * attested to this" as an alarm would train people to ignore the one case that
 * matters. `unchecked` is not a pass either: a sidecar we could not evaluate
 * tells us nothing, and calling that "fine" would be the manufactured
 * confidence the ingredients label refuses everywhere else. Both `tampered` and
 * `unchecked` therefore mean "not verified", and callers that gate on
 * verification gate on exactly that.
 */
export const VERIFIED = 'verified';
export const TAMPERED = 'tampered';
export const UNCHECKED = 'unchecked';
export const UNSIGNED = 'unsigned';

/** Did verification actually establish who signed these bytes? */
export const isVerified = (r) => r.state === VERIFIED;

/**
 * When the signature was recorded, read straight out of the bundle.
 *
 * From the transparency log entry rather than from anything self-reported: a
 * timestamp a signer could choose is not evidence of when they signed.
 */
function signedAt(bundle) {
  const secs = bundle?.verificationMaterial?.tlogEntries?.[0]?.integratedTime;
  return secs ? new Date(Number(secs) * 1000).toISOString().replace(/\.\d+Z$/, 'Z') : null;
}

/**
 * Verify `bytes` against a sidecar bundle.
 *
 * The identity comes from what the verifier RETURNS, not from reading the
 * bundle: the bundle is the attacker-supplied half of this exchange, and the
 * subject printed on screen has to be the one the trust chain actually
 * established, or the line is theatre.
 */
export async function verifyBytes(bytes, bundle, { client } = {}) {
  const sigstore = client === undefined ? await loadClient() : client;
  if (!sigstore) {
    return { state: UNCHECKED, reason: `the sigstore client is not installed — ${INSTALL_HINT}` };
  }
  try {
    const signer = await sigstore.verify(bundle, Buffer.from(bytes));
    return {
      state: VERIFIED,
      identity: signer?.identity?.subjectAlternativeName ?? null,
      issuer: signer?.identity?.extensions?.issuer ?? null,
      at: signedAt(bundle),
    };
  } catch (e) {
    // A verification failure and an unreachable trust root are different facts
    // and must not print the same line. The first says these bytes are not the
    // bytes that were signed; the second says we could not find out.
    const offline = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|network|TUF/i.test(e.message ?? '');
    return offline
      ? { state: UNCHECKED, reason: `the trust root could not be reached (${e.message})` }
      : { state: TAMPERED, reason: e.message };
  }
}

/**
 * Verify a file against its sidecar, if it has one.
 *
 * Returns `unsigned` when there is no sidecar — the ordinary case, and not
 * something to sound an alarm about.
 */
export async function verifyFile(file, { client, sidecar = sidecarFor(file) } = {}) {
  if (!existsSync(sidecar)) return { state: UNSIGNED, sidecar };
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(sidecar, 'utf8'));
  } catch (e) {
    // A sidecar that is not a bundle is a broken claim, not an absent one.
    return { state: TAMPERED, sidecar, reason: `the sidecar is not a readable Sigstore bundle (${e.message})` };
  }
  return { ...await verifyBytes(readFileSync(file), bundle, { client }), sidecar };
}

/** Write a sidecar beside `file`. Pretty-printed — it is meant to be readable. */
export function writeSidecar(file, bundle) {
  const sidecar = sidecarFor(file);
  writeFileSync(sidecar, `${JSON.stringify(bundle, null, 2)}\n`);
  return sidecar;
}

/**
 * One line about the signature, for the terminal.
 *
 * Names WHO, not merely that a signature exists — "signed" on its own is the
 * kind of reassurance that gets read as "safe", and an attacker can sign a deck
 * too. The identity is the part a person can actually judge.
 */
export function formatSignature(result, { indent = '  ' } = {}) {
  const who = result.identity ?? 'an identity the certificate does not name';
  switch (result.state) {
    case VERIFIED:
      return `${indent}signature — verified: signed by ${who}`
        + `${result.issuer ? ` via ${result.issuer}` : ''}${result.at ? `, ${result.at}` : ''}`;
    case TAMPERED:
      return `${indent}signature — DOES NOT VERIFY: these are not the bytes that were signed (${result.reason})`;
    case UNCHECKED:
      return `${indent}signature — present but NOT checked here: ${result.reason}`;
    default:
      return `${indent}signature — none; nothing attests to these bytes`;
  }
}
