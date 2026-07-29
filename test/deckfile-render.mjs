#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The container's last acceptance criterion, checked by a browser rather than
 * by argument (MARKETPLACE.md DECK_FILE):
 *
 *   "A `.decklight` renamed to `.html` opens in a browser as a normal
 *    (unattested) deck — the container degrades to the artifact it wraps,
 *    never to garbage."
 *
 * This is the criterion the whole format hangs on, because it is the one that
 * covers the recipient who has none of the tooling. Every other guarantee here
 * — the audit, the signature, strict mode — reaches only people who installed
 * something. If the fallback were broken, the container would be a wall in
 * front of everyone else, and a wall is worse than the plain HTML file it
 * replaced.
 *
 * It is asserted structurally in test/deckfile.test.mjs (the deck is the
 * prefix, the archive follows `</html>`). What that cannot tell you is what
 * Chrome does with the trailing bytes. So: bundle a real deck, pack it, rename
 * the container to `.html`, render it, and compare against the same deck
 * rendered on its own. Anything but an exact match means the appended archive
 * reached the page.
 */
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dumpDom, resultsFrom } from './harness.mjs';
import { packContainer, containerFor, runtimeVersionOf } from '../cli/deckfile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'decklight-deckfile-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const bundled = path.join(dir, 'deck.html');
execFileSync(process.execPath,
  [path.join(root, 'cli/decklight.mjs'), 'bundle', path.join(root, 'demo/intro.html'), '-o', bundled],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const deck = readFileSync(bundled, 'utf8');

// A stand-in signature: what is under test is the FORMAT's fallback, and a real
// Sigstore bundle would need an identity this harness has no business needing.
// The container is bytes either way, and the browser cannot tell.
const { bytes } = packContainer({
  payload: deck,
  signature: { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', messageSignature: { signature: 'zz' } },
  name: 'deck.html',
  runtime: runtimeVersionOf(deck),
});
const container = path.join(dir, containerFor('deck.html'));
writeFileSync(container, bytes);

// The rename is the whole point: same bytes, a name a browser will open.
const renamed = path.join(dir, 'renamed.html');
copyFileSync(container, renamed);

const PROBE = `<pre id="test-sink">running…</pre><script>
setTimeout(() => {
  const sections = [...document.querySelectorAll('.decklight-stage > section')];
  document.getElementById('test-sink').textContent = 'DECKLIGHT-DECKFILE-RESULTS ' + JSON.stringify({
    mounted: !!document.querySelector('.decklight-stage'),
    sections: sections.length,
    fingerprint: sections.map((s) => [s.className, s.children.length,
      s.textContent.replace(/\\s+/g, ' ').trim()].join('|')).join('\\n'),
    // The archive is binary and begins with "PK". If a single byte of it
    // reached the document, it is in the body text — and the audience would be
    // looking at it.
    archiveOnPage: /PK\\u0003\\u0004/.test(document.body.textContent),
    trailing: document.body.textContent.trimEnd().slice(-40),
  });
}, 400);
</script>`;

/** Insert before the document's own </html> — the deck's, not the archive's. */
function probed(file) {
  const text = readFileSync(file, 'latin1'); // byte-preserving for the archive tail
  const at = text.lastIndexOf('</body>');
  const out = path.join(dir, `probe-${path.basename(file)}`);
  writeFileSync(out, `${text.slice(0, at)}${PROBE}\n${text.slice(at)}`, 'latin1');
  return out;
}

function render(name, file) {
  const dom = dumpDom(`file://${probed(file)}`,
    { fileAccess: true, budget: 8000, quietStderr: true, who: 'deckfile-render' });
  return resultsFrom(dom, 'DECKFILE', name);
}

const plain = render('deck', bundled);
const asHtml = render('renamed', renamed);

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(52)} ${detail}`);
};

check('the renamed container boots the engine', asHtml.mounted === true, `stage=${asHtml.mounted}`);
check('every slide is there', asHtml.sections === plain.sections, `${asHtml.sections} vs ${plain.sections} plain`);
check('it renders identically to the plain deck', asHtml.fingerprint === plain.fingerprint,
  asHtml.fingerprint === plain.fingerprint ? `${plain.sections} sections match` : 'DOM differs');
check('no archive bytes reached the page', asHtml.archiveOnPage === false,
  `trailing text: ${JSON.stringify(asHtml.trailing)}`);

if (asHtml.fingerprint !== plain.fingerprint) {
  const a = plain.fingerprint.split('\n'); const b = asHtml.fingerprint.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) console.error(`  slide ${i + 1}\n    plain:   ${a[i]}\n    renamed: ${b[i]}`);
  }
}

if (bad) { console.error('deckfile-render: FAILED'); process.exit(1); }
console.log('deckfile-render: PASS');
