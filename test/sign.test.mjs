// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Deck signing (MARKETPLACE.md INTEGRITY#SIGNING). The real Sigstore round trip
// needs an OIDC identity and the network, so the client is injectable and these
// drive it with a stub — which is the right seam anyway: what is worth pinning
// is not that sigstore works, it is what THIS code concludes from each answer
// it can get back. The states pull against each other on purpose: "unsigned" is
// not a finding, "could not check" is not a pass, and neither is allowed to
// drift into the other.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmTemp } from './helpers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sidecarFor, signBytes, verifyBytes, verifyFile, writeSidecar, formatSignature,
  isVerified, VERIFIED, TAMPERED, UNCHECKED, UNSIGNED,
} from '../cli/sign.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');

/** A bundle shaped like the real thing in the one place this code reads it. */
const BUNDLE = (integratedTime = '1785000000') => ({
  mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
  verificationMaterial: { tlogEntries: [{ integratedTime }] },
  messageSignature: { signature: 'zzz' },
});

const SIGNER = {
  identity: {
    subjectAlternativeName: 'gilles@example.com',
    extensions: { issuer: 'https://accounts.example.com' },
  },
};

const stub = (impl) => ({ sign: async () => BUNDLE(), verify: async () => SIGNER, ...impl });

const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-sign-'));
  process.on('exit', () => rmTemp(dir));
  return dir;
};

// ── signing ────────────────────────────────────────────────────────────────

test('the sidecar sits beside the file it covers, under a predictable name', () => {
  assert.equal(sidecarFor('/x/talk.html'), '/x/talk.html.sig');
});

test('signing passes the exact bytes and hands back the bundle', async () => {
  let seen = null;
  const bundle = await signBytes('deck bytes', { client: stub({ sign: async (b) => { seen = b; return BUNDLE(); } }) });
  assert.equal(seen.toString(), 'deck bytes');
  assert.equal(bundle.mediaType, BUNDLE().mediaType);
});

test('without the client, signing says which client and how to get it', async () => {
  await assert.rejects(() => signBytes('x', { client: null }), /not installed/);
});

test('a signing failure names the identity AND the network, and says nothing was written', async () => {
  const client = stub({ sign: async () => { throw new Error('error retrieving identity token'); } });
  await assert.rejects(() => signBytes('x', { client }), (e) => {
    assert.match(e.message, /error retrieving identity token/, 'the underlying cause survives');
    assert.match(e.message, /id-token: write|SIGSTORE_ID_TOKEN/, 'and where an identity comes from');
    assert.match(e.message, /Fulcio|Rekor/, 'and that this needs the network');
    assert.match(e.message, /Nothing was written/, 'no partial artifact');
    // The claim the client cannot back: sigstore@5 has no interactive flow.
    assert.doesNotMatch(e.message, /browser sign-?in(?! —)/i);
    return true;
  });
});

test('an explicit identity token is passed through; absent, none is invented', async () => {
  let opts = null;
  const client = stub({ sign: async (b, o) => { opts = o; return BUNDLE(); } });
  await signBytes('x', { client, token: 'tok-123' });
  assert.deepEqual(opts, { identityToken: 'tok-123' });
  await signBytes('x', { client, token: undefined });
  assert.deepEqual(opts, {}, 'no token means ambient CI credentials, not a fabricated one');
});

// ── verifying ──────────────────────────────────────────────────────────────

test('a good signature names who signed, through whom, and when', async () => {
  const r = await verifyBytes('deck', BUNDLE('1785000000'), { client: stub({}) });
  assert.equal(r.state, VERIFIED);
  assert.ok(isVerified(r));
  assert.equal(r.identity, 'gilles@example.com');
  assert.equal(r.issuer, 'https://accounts.example.com');
  assert.equal(r.at, '2026-07-25T17:20:00Z', 'from the transparency log entry, not from anything self-reported');
});

test('the identity comes from the verifier, never from the bundle', async () => {
  // The bundle is the attacker-supplied half. A deck that carries a bundle
  // claiming a famous signer must not be able to get that name printed.
  const lying = { ...BUNDLE(), signedBy: 'torvalds@kernel.org', identity: 'torvalds@kernel.org' };
  const r = await verifyBytes('deck', lying, { client: stub({}) });
  assert.equal(r.identity, 'gilles@example.com');
  assert.doesNotMatch(formatSignature(r), /torvalds/);
});

test('a failed verification is tampered, and keeps the reason', async () => {
  const client = stub({ verify: async () => { throw new Error('signature verification failed'); } });
  const r = await verifyBytes('deck', BUNDLE(), { client });
  assert.equal(r.state, TAMPERED);
  assert.match(r.reason, /signature verification failed/);
});

test('an unreachable trust root is UNCHECKED, not tampered — different facts', async () => {
  for (const msg of ['getaddrinfo ENOTFOUND tuf-repo-cdn.sigstore.dev', 'TUF refresh failed', 'connect ETIMEDOUT']) {
    const client = stub({ verify: async () => { throw new Error(msg); } });
    const r = await verifyBytes('deck', BUNDLE(), { client });
    assert.equal(r.state, UNCHECKED, msg);
  }
});

test('a verified result that names nobody is not verified — nothing to judge', async () => {
  // A signature can check out cryptographically while the verifier resolves
  // no name (older sigstore majors returned no Signer at all). The state stays
  // VERIFIED — the bytes did verify — but the gate must not pass it: the whole
  // design is "print the name, the human judges it", and a nameless identity
  // gives the presenter nothing to judge.
  const r = await verifyBytes('deck', BUNDLE(), { client: stub({ verify: async () => ({}) }) });
  assert.equal(r.state, VERIFIED);
  assert.equal(r.identity, null);
  assert.equal(isVerified(r), false, 'verified with unknown identity gates exactly like unchecked');

  const line = formatSignature(r);
  assert.match(line, /verified with unknown identity/, 'the one standard phrase for this condition');
  assert.doesNotMatch(line, /signed by/, 'no name is claimed where none was established');
  assert.equal(line.split('\n').length, 1);
});

test('no client means UNCHECKED — never a pass', async () => {
  const r = await verifyBytes('deck', BUNDLE(), { client: null });
  assert.equal(r.state, UNCHECKED);
  assert.equal(isVerified(r), false, 'a claim nobody evaluated is not a claim anybody verified');
  assert.match(r.reason, /npm install sigstore/);
});

// ── files ──────────────────────────────────────────────────────────────────

test('a deck with no sidecar is UNSIGNED, and nothing is asked of the client', async () => {
  const dir = tmp();
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, '<html></html>');
  const client = stub({ verify: async () => { throw new Error('must not be called'); } });
  const r = await verifyFile(deck, { client });
  assert.equal(r.state, UNSIGNED);
});

test('a sidecar that is not a bundle is a broken claim, not an absent one', async () => {
  const dir = tmp();
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, '<html></html>');
  writeFileSync(sidecarFor(deck), 'not json at all');
  const r = await verifyFile(deck, { client: stub({}) });
  assert.equal(r.state, TAMPERED);
  assert.match(r.reason, /not a readable Sigstore bundle/);
});

test('the sidecar written is the sidecar read back', async () => {
  const dir = tmp();
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, '<html>deck</html>');
  const written = writeSidecar(deck, BUNDLE());
  assert.equal(written, sidecarFor(deck));
  assert.deepEqual(JSON.parse(readFileSync(written, 'utf8')), BUNDLE());
  assert.equal((await verifyFile(deck, { client: stub({}) })).state, VERIFIED);
});

// ── what the terminal says ─────────────────────────────────────────────────

test('the printed line names an identity, and never claims safety', async () => {
  const verified = formatSignature(await verifyBytes('d', BUNDLE(), { client: stub({}) }));
  assert.match(verified, /signed by gilles@example\.com/, 'who — not merely that a signature exists');
  assert.match(verified, /via https:\/\/accounts\.example\.com/);

  const all = [
    verified,
    formatSignature({ state: TAMPERED, reason: 'bad' }),
    formatSignature({ state: UNCHECKED, reason: 'no client' }),
    formatSignature({ state: UNSIGNED }),
  ];
  for (const line of all) {
    assert.doesNotMatch(line, /\bsafe\b|✔|trusted/i, 'no verdict vocabulary — the label refuses it too');
    assert.equal(line.split('\n').length, 1, 'one line each, so a start stays readable');
  }
  assert.match(all[1], /DOES NOT VERIFY/, 'the failure is loud');
  assert.match(all[2], /NOT checked/, 'and "could not check" reads as its own thing');
  assert.match(all[3], /none/, 'while unsigned is stated flatly, not alarmingly');
});

// ── the invariants the ticket is actually about ────────────────────────────

test('there are no keys — no key file is read, written, or named', () => {
  const src = readFileSync(path.join(ROOT, 'cli/sign.mjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /privateKey|\.pem\b|passphrase|keyPath|generateKeyPair/,
    'keyless means there is nothing to manage, not that management moved');
});

test('the runtime keeps zero dependencies — sigstore stays in cli/', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.optionalDependencies?.sigstore, 'declared, and optional — CI installs --omit=optional');
  assert.equal(pkg.dependencies, undefined, 'the package still has no hard dependencies at all');

  for (const f of ['src', 'tools']) {
    let hits = '';
    // grep exits 1 on no match, which is the passing case here.
    try { hits = execFileSync('grep', ['-rl', 'sigstore', path.join(ROOT, f)], { encoding: 'utf8' }); }
    catch (e) { assert.equal(e.status, 1, String(e.stderr)); }
    assert.equal(hits.trim(), '', `${f}/ must not reach for the signing client`);
  }
  const dist = path.join(ROOT, 'dist/decklight.js');
  if (existsSync(dist)) assert.doesNotMatch(readFileSync(dist, 'utf8'), /sigstore/, 'and it never reaches dist/');
});

// ── end to end, without a network or an identity ───────────────────────────

/** The ambient OIDC credentials cleared, so signing fails the same way anywhere. */
function noIdentityEnv() {
  const env = { ...process.env };
  for (const k of ['SIGSTORE_ID_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) delete env[k];
  return env;
}

// A real deck: bundling refuses one with no theme link, and a fixture that
// cannot be bundled would test the refusal instead of the signing.
const DECK = path.join(ROOT, 'demo/intro.html');

test('bundle --sign with no identity fails, and leaves NO artifact behind', () => {
  const dir = tmp();
  const out = path.join(dir, 'out.html');
  const deck = DECK;

  let code = 0; let err = '';
  try {
    execFileSync(process.execPath, [CLI, 'bundle', deck, '-o', out, '--sign'],
      { encoding: 'utf8', stdio: 'pipe', env: noIdentityEnv(), timeout: 60000 });
  } catch (e) { code = e.status; err = String(e.stderr); }

  assert.equal(code, 1, err);
  assert.match(err, /signing (failed|needs)/);
  // The whole point of signing before writing: a failed sign cannot leave an
  // unsigned deck to be found later and forwarded as if it were finished.
  assert.equal(existsSync(out), false, 'no bundled deck');
  assert.equal(existsSync(sidecarFor(out)), false, 'and no sidecar');
});

test('bundle --sign writes the deck and its sidecar, and verifies its own work', async () => {
  const dir = tmp();
  const out = path.join(dir, 'out.html');
  const { bundleMain } = await import('../cli/bundle.mjs');
  await bundleMain([DECK, '-o', out, '--sign'], { client: stub({}) });

  assert.ok(existsSync(out), 'the deck');
  assert.deepEqual(JSON.parse(readFileSync(sidecarFor(out), 'utf8')), BUNDLE(), 'and its detached signature');
  // What is signed is what is written: the sidecar has to cover these exact
  // bytes, or a recipient's verification fails on a deck nobody tampered with.
  assert.equal((await verifyFile(out, { client: stub({}) })).state, VERIFIED);
});

test('plain bundle neither signs nor warns — offline-clean by default', () => {
  const dir = tmp();
  const out = path.join(dir, 'out.html');
  const log = execFileSync(process.execPath, [CLI, 'bundle', DECK, '-o', out],
    { encoding: 'utf8', env: noIdentityEnv() });
  assert.ok(existsSync(out));
  assert.equal(existsSync(sidecarFor(out)), false);
  assert.doesNotMatch(log, /signed|signing|\.sig\b/i, 'no nag: the default is a choice, not an oversight');
});

test('present --check fails a deck whose signature does not verify', () => {
  const dir = tmp();
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, '<html><body><script>Decklight.init()</script></body></html>');
  writeFileSync(sidecarFor(deck), 'not a bundle');

  let code = 0; let out = '';
  try {
    out = execFileSync(process.execPath, [CLI, 'present', deck, '--check'],
      { encoding: 'utf8', stdio: 'pipe', env: noIdentityEnv() });
  } catch (e) { code = e.status; out = String(e.stdout); }
  assert.equal(code, 1, 'a gate that passes what it could not stand behind is not a gate');
  assert.match(out, /DOES NOT VERIFY/);
});

test('--check routes a nameless verified signature the same as unchecked', async () => {
  // Both consequential call sites — --check's exit code and the strict-mode
  // degrade — gate on the same `state !== UNSIGNED && !isVerified(signature)`
  // expression, so exercising --check through the injectable client covers the
  // one choke point they share.
  const { presentMain } = await import('../cli/present.mjs');
  const dir = tmp();
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, '<html><body><script>Decklight.init()</script></body></html>');
  writeSidecar(deck, BUNDLE());

  const check = async (client) => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try { return { code: await presentMain([deck, '--check'], { client }), out: lines.join('\n') }; }
    finally { console.log = orig; }
  };

  const named = await check(stub({}));
  assert.equal(named.code, 0, `a named identity passes: ${named.out}`);
  assert.match(named.out, /signed by gilles@example\.com/);

  const nameless = await check(stub({ verify: async () => ({}) }));
  assert.equal(nameless.code, 1, 'the same sidecar with no established name fails the gate');
  assert.match(nameless.out, /verified with unknown identity/);
});

test('an unsigned deck passes --check — most decks are unsigned', () => {
  const dir = tmp();
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, '<html><body><script>Decklight.init()</script></body></html>');
  const out = execFileSync(process.execPath, [CLI, 'present', deck, '--check'],
    { encoding: 'utf8', env: noIdentityEnv() });
  assert.doesNotMatch(out, /signature/, 'and nothing is said about a signature that was never claimed');
});
