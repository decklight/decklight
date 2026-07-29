// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The .decklight container (MARKETPLACE.md DECK_FILE) and the file association
// that makes double-clicking one land in `present` (DECK_FILE#ASSOC).
//
// The claim that carries the most weight is the least obvious one: a container
// renamed to .html still plays. That is what keeps the format from being a
// wall in front of the recipient who has none of this tooling — so it is
// asserted structurally here and rendered for real in test/deckfile-render.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DECK_EXT, MANIFEST, OPEN, CLOSE, isContainer, containerFor, packContainer, readContainer, formatManifest,
} from '../cli/deckfile.mjs';
import { unzip } from '../tools/zip.mjs';
import { zipSync } from '../cli/zip.mjs';
import { linuxFiles, darwinFiles, windowsCommands, planFor, MIME_TYPE, UTI } from '../cli/associate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const CLI = path.join(ROOT, 'cli/decklight.mjs');
const DEMO = path.join(ROOT, 'demo/intro.html');

const SIG = { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', messageSignature: { signature: 'zz' } };
const stubClient = {
  sign: async () => SIG,
  verify: async () => ({ identity: { subjectAlternativeName: 'me@example.com', extensions: { issuer: 'https://id.example' } } }),
};

const tmp = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-deckfile-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const DECK = '<!doctype html><html><body><div class="decklight"><section><h2>A</h2></section></div>'
  + '<script>Decklight.init()</script></body></html>';

// ── the format ─────────────────────────────────────────────────────────────

test('the extension is .decklight, and the container is named after the deck', () => {
  assert.equal(DECK_EXT, '.decklight', 'not .deck — Decker owns that, and its files are also HTML decks');
  assert.equal(containerFor('/x/talk.html'), '/x/talk.decklight');
  assert.ok(isContainer('talk.DECKLIGHT'), 'the check is case-insensitive, like a filesystem');
  assert.equal(isContainer('talk.html'), false);
});

test('the deck comes FIRST, verbatim — which is what makes the rename work', () => {
  const { bytes } = packContainer({ payload: DECK, signature: SIG, name: 'talk.html' });
  assert.equal(bytes.subarray(0, DECK.length).toString('utf8'), DECK,
    'byte-for-byte, at offset 0: an HTML parser stops caring after </html> and never sees the rest');
  assert.ok(bytes.length > DECK.length, 'and the metadata is appended, not merged in');
});

test('it is still a real zip — offsets are file-relative, prefix and all', () => {
  const { bytes } = packContainer({ payload: DECK, signature: SIG, name: 'talk.html' });
  // This is how a self-extracting archive has always worked, and it is why an
  // ordinary unzip reads the container without being told about the prefix.
  const parts = unzip(bytes);
  assert.deepEqual([...parts.keys()].sort(), [MANIFEST, 'talk.html.sig']);
  assert.deepEqual(JSON.parse(parts.get('talk.html.sig').toString('utf8')), SIG);
});

test('an unsigned container is refused — it would be an archive wearing the name of an attestation', () => {
  assert.throws(() => packContainer({ payload: DECK, signature: null }), /nothing to pack without a signature/);
});

test('the manifest describes the payload, and the digest is checked against it', () => {
  const { bytes, manifest } = packContainer({
    payload: DECK, signature: SIG, name: 'talk.html', runtime: '0.3.0',
    origin: { repo: 'https://github.com/decklight/decklight', commit: 'abc1234def' },
    extensions: ['charts'],
  });
  assert.equal(manifest.payload.bytes, DECK.length);
  assert.equal(manifest.runtime, '0.3.0');

  const dir = tmp();
  const file = path.join(dir, `talk${DECK_EXT}`);
  writeFileSync(file, bytes);
  const read = readContainer(file);
  assert.equal(read.payload.toString('utf8'), DECK);
  assert.deepEqual(read.signature, SIG);
  assert.equal(read.digestOk, true);
  assert.match(formatManifest(read.manifest), /runtime 0\.3\.0 · from https:\/\/github\.com\/decklight\/decklight@abc1234/);
  assert.match(formatManifest(read.manifest), /declares 1 extension: charts/);
  // "says", never "is" — the manifest is the container's own claim, and only
  // the signature was checked by anybody.
  assert.match(formatManifest(read.manifest), /says:/);
});

test('a tampered payload breaks the digest the manifest carries', () => {
  const { bytes } = packContainer({ payload: DECK, signature: SIG, name: 'talk.html' });
  const dir = tmp();
  const file = path.join(dir, `talk${DECK_EXT}`);
  // Flip a byte inside the deck, leaving every offset — and so the zip — intact.
  const poisoned = Buffer.from(bytes);
  poisoned[DECK.indexOf('<h2>A') + 4] = 'B'.charCodeAt(0);
  writeFileSync(file, poisoned);
  assert.equal(readContainer(file).digestOk, false);
});

/** Hand-build a container with an arbitrary manifest — the shape a tamperer
 *  would produce, which pack() will not make. */
function forge(payload, manifest, sig = SIG) {
  const body = Buffer.from(payload, 'utf8');
  const open = Buffer.from(OPEN, 'utf8');
  const entries = [];
  if (sig) entries.push({ name: manifest.signature, data: JSON.stringify(sig) });
  entries.push({ name: MANIFEST, data: JSON.stringify(manifest) });
  return Buffer.concat([body, open, zipSync(entries, { prefix: body.length + open.length, comment: CLOSE })]);
}

test('the payload length is read from the zip, not from the manifest that claims it', () => {
  // The manifest is the half a tamperer edits. A reader that took its byte
  // count on trust could be handed a short slice with a matching digest and
  // would then verify a deck nobody sent.
  const short = DECK.slice(0, 40);
  const dir = tmp();
  const file = path.join(dir, `talk${DECK_EXT}`);
  writeFileSync(file, forge(DECK, {
    decklight: 1,
    payload: { name: 'talk.html', bytes: short.length, sha256: createHash('sha256').update(short).digest('hex') },
    signature: 'talk.html.sig',
  }));

  const read = readContainer(file);
  assert.equal(read.payload.length, DECK.length, 'structure wins over the label');
  assert.equal(read.digestOk, false, 'and the disagreement is reported, not resolved in the label\'s favour');
});

test('a file that is not a container says so, rather than half-reading one', () => {
  const dir = tmp();
  const plain = path.join(dir, `nope${DECK_EXT}`);
  writeFileSync(plain, '<html>just a deck</html>');
  assert.throws(() => readContainer(plain), /not a \.decklight container/);
});

// ── bundle --deck / publish --deck ─────────────────────────────────────────

test('bundle --deck writes the container, and it implies --sign', async () => {
  const dir = tmp();
  const out = path.join(dir, 'out.html');
  const { bundleMain } = await import('../cli/bundle.mjs');
  await bundleMain([DEMO, '-o', out, '--deck'], { client: stubClient });

  assert.ok(existsSync(out), 'the deck');
  assert.ok(existsSync(`${out}.sig`), 'its sidecar — --deck implies --sign, it does not replace it');
  const container = containerFor(out);
  assert.ok(existsSync(container));

  const read = readContainer(container);
  assert.equal(read.digestOk, true);
  assert.equal(read.payload.toString('utf8'), readFileSync(out, 'utf8'),
    'the container wraps exactly the deck that was written beside it');
  assert.deepEqual(read.signature, SIG);
});

test('the container is a working deck when renamed .html', async () => {
  const dir = tmp();
  const out = path.join(dir, 'out.html');
  const { bundleMain } = await import('../cli/bundle.mjs');
  await bundleMain([DEMO, '-o', out, '--deck'], { client: stubClient });

  const renamed = readFileSync(containerFor(out), 'utf8');
  const deck = readFileSync(out, 'utf8');
  // Everything a browser needs is before the trailing archive, and the document
  // is complete: a parser that stops at </html> has already seen the whole deck.
  assert.ok(renamed.startsWith(deck), 'the container opens with the deck, unmodified');
  assert.match(deck, /<\/html>/);
  assert.ok(renamed.indexOf('</html>') < renamed.indexOf('PK'), 'the archive begins after the document ends');
});

test('--deck and --no-sign together are refused before anything happens', () => {
  let code = 0; let err = '';
  try {
    execFileSync(process.execPath, [CLI, 'publish', DEMO, '--deck', '--no-sign'],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; err = String(e.stderr); }
  assert.equal(code, 1);
  assert.match(err, /--deck packs the SIGNED deck/);
});

// ── present on a container ─────────────────────────────────────────────────

test('present --check reads a container like the deck it wraps', async () => {
  const dir = tmp();
  const out = path.join(dir, 'out.html');
  const { bundleMain } = await import('../cli/bundle.mjs');
  await bundleMain([DEMO, '-o', out, '--deck'], { client: stubClient });

  let code = 0; let log = '';
  try {
    log = execFileSync(process.execPath, [CLI, 'present', containerFor(out), '--check'],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; log = String(e.stdout); }

  assert.match(log, /ingredients — what this file will execute/, 'same audit as a plain deck');
  assert.match(log, /container — says:/, 'plus what the container claims about itself');
  // The stub signature cannot verify for real, so this degrades — which is the
  // point: an unverifiable container is not treated as a verified one.
  assert.equal(code, 1);
  assert.match(log, /signature —/);
});

test('a container with no signature inside degrades — it is not read as "unsigned"', () => {
  // pack() refuses to build this, so it is the shape someone would forge: a
  // container whose manifest names a sidecar that is not in the archive.
  const dir = tmp();
  const file = path.join(dir, `talk${DECK_EXT}`);
  writeFileSync(file, forge(DECK, {
    decklight: 1,
    payload: { name: 'talk.html', bytes: DECK.length, sha256: createHash('sha256').update(DECK).digest('hex') },
    signature: 'talk.html.sig',
  }, null));
  assert.equal(readContainer(file).signature, null, 'the reader reports the absence rather than inventing one');

  let code = 0; let log = '';
  try {
    log = execFileSync(process.execPath, [CLI, 'present', file, '--check'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; log = String(e.stdout); }
  assert.equal(code, 1, 'a container that attests to nothing does not pass a gate about attestation');
  assert.match(log, /DOES NOT VERIFY|carries no signature/);
});

// ── the file association ───────────────────────────────────────────────────

test('the linux entry runs present on the double-clicked file, and declares the type', () => {
  const [desktop, mime] = linuxFiles('/home/x', '/usr/bin/node', '/opt/decklight/cli/decklight.mjs');
  assert.match(desktop.path, /\.local\/share\/applications\/decklight\.desktop$/);
  assert.match(desktop.text, /Exec=\/usr\/bin\/node \/opt\/decklight\/cli\/decklight\.mjs present %f/);
  assert.match(desktop.text, /%f\b/, 'one file — present takes one deck');
  assert.doesNotMatch(desktop.text, /%F\b/, 'not a multi-select that would silently present the first');
  assert.match(desktop.text, /Terminal=true/, 'the label prints to a terminal someone can read');
  assert.match(desktop.text, new RegExp(`MimeType=${MIME_TYPE}`));

  assert.match(mime.path, /\.local\/share\/mime\/packages\/decklight\.xml$/);
  assert.match(mime.text, /<glob pattern="\*\.decklight"\/>/);
  assert.match(mime.text, /sub-class-of type="text\/html"/, 'it IS html underneath, and says so');
});

test('the macOS bundle exports a UTI, because only an application can', () => {
  const [plist, launcher] = darwinFiles('/Users/x', '/usr/local/bin/node', '/opt/decklight/cli/decklight.mjs');
  assert.match(plist.path, /Applications\/Decklight\.app\/Contents\/Info\.plist$/);
  assert.match(plist.text, new RegExp(`<string>${UTI}</string>`));
  assert.match(plist.text, /UTExportedTypeDeclarations/);
  assert.match(plist.text, /<string>public\.html<\/string>/, 'conforming to html, which is what it is');
  assert.match(plist.text, /<string>decklight<\/string>/);

  assert.match(launcher.path, /Contents\/MacOS\/decklight$/);
  assert.equal(launcher.mode, 0o755, 'a launcher the OS cannot execute is not a launcher');
  assert.match(launcher.text, /present/);
});

test('windows writes per-user classes — no administrator anywhere in this', () => {
  const cmds = windowsCommands('C:\\node\\node.exe', 'C:\\decklight\\cli\\decklight.mjs');
  const flat = cmds.map((c) => c.join(' ')).join('\n');
  assert.match(flat, /HKCU\\Software\\Classes\\\.decklight/);
  assert.doesNotMatch(flat, /HKLM|HKEY_LOCAL_MACHINE/, 'per-user only: no admin rights are needed or asked for');
  assert.match(flat, /shell\\open\\command/);
  assert.match(flat, /present "%1"/);
});

test('an unknown platform is refused by name, not silently skipped', () => {
  assert.equal(planFor('sunos').unsupported, true);
  for (const os of ['linux', 'darwin', 'win32']) assert.ok(!planFor(os).unsupported, os);
});

test('--print writes nothing and says what it would do', () => {
  const out = execFileSync(process.execPath, [CLI, 'associate', '--print'], { encoding: 'utf8' });
  assert.match(out, /would (write|run)/);
  assert.doesNotMatch(out, /^wrote /m);
});

test('associate is routed and documented by the dispatcher', () => {
  const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.match(help, /^  associate /m);
  const sub = execFileSync(process.execPath, [CLI, 'help', 'associate'], { encoding: 'utf8' });
  assert.match(sub, /usage: decklight associate/);
  assert.match(sub, /--uninstall/);
  // The honest caveat: the association buys the verified path, not the only one.
  assert.match(sub, /renamed to \.html still opens/);
});
