#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for issue #231 (isVerified treated a nameless identity as fully
// trusted). Nothing changes in the browser, so the shot is the CLI transcript
// surface itself, the deckfile-provenance pattern: the same deck and sidecar
// run through `present --check` twice — once with a verifier that resolves a
// named signer, once with one that resolves no name at all. The second run is
// the case this ticket gates: the signature checks out, the certificate names
// nobody, and the exit code now refuses it instead of waving it through.
//
// The sigstore client is stubbed (the test suite's seam): producing a REAL
// bundle whose certificate names nobody needs a live signing ceremony, which
// the ticket explicitly scopes out. The stub drives the exact code path both
// call sites share — verifyFile → isVerified — through presentMain itself.
//
//   node shots/sign-unknown-identity-transcript.mjs → .shots/sign-unknown-identity.png

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const { writeSidecar } = await import(path.join(root, 'cli/sign.mjs'));
const { presentMain } = await import(path.join(root, 'cli/present.mjs'));

// --- fixture: one deck, one sidecar, two verifier answers ---------------------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-identity-shot-'));
const deck = path.join(dir, 'talk.html');
fs.writeFileSync(deck, '<html><body><script>Decklight.init()</script></body></html>');
writeSidecar(deck, {
  mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
  verificationMaterial: { tlogEntries: [{ integratedTime: '1785000000' }] },
  messageSignature: { signature: 'zzz' },
});

const named = {
  verify: async () => ({ identity: {
    subjectAlternativeName: 'gilles@example.com',
    extensions: { issuer: 'https://accounts.example.com' },
  } }),
};
const nameless = { verify: async () => ({}) };

const check = async (client) => {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    const code = await presentMain([deck, '--check'], { client });
    return { code, out: `${lines.join('\n')}\n(exit ${code})` };
  } finally { console.log = orig; }
};

const good = await check(named);
const bad = await check(nameless);
fs.rmSync(dir, { recursive: true, force: true });
if (good.code !== 0) throw new Error(`the named control must pass: ${good.out}`);
if (bad.code !== 1) throw new Error('the nameless run passed — the gate this shot evidences is gone');
if (!bad.out.includes('verified with unknown identity')) throw new Error('the standard phrase is missing');

// --- render the transcript as a terminal window and shoot it ------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paint = (s) => esc(s)
  .replace(/^(signature — verified: signed by.*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(signature — verified with unknown identity.*)$/gm, '<span class="bad">$1</span>')
  .replace(/^(\(exit 0\))$/gm, '<span class="ok">$1</span>')
  .replace(/^(\(exit 1\))$/gm, '<span class="bad">$1</span>');
const block = (note, out) => `<div class="run"><span class="hint"># ${esc(note)}</span>
<span class="prompt">~/inbox $</span> decklight present talk.html --check
${paint(out)}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight present — a nameless identity is not verified</title><style>
  body { margin: 0; display: grid; place-items: center; height: 100vh;
         background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1060px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 16px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 18px 22px 24px; color: #cdd6e4; white-space: pre-wrap; }
  .run + .run { display: block; margin-top: 1.2em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .ok { color: #86efac; }
  .bad { color: #f87171; }
  .hint { color: #8b98ab; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">the same deck and sidecar, two verifier answers — a signature that names nobody now fails the gate (#231; verifier stubbed: a real nameless bundle needs a signing ceremony)</span></div>
  <div class="body">${block('the verifier resolves a named signer — the human has a name to judge', good.out)}
${block('the verifier resolves NO name — the bytes verify, the signer is nobody the presenter can judge', bad.out)}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'sign-unknown-identity-transcript.html');
fs.mkdirSync(path.dirname(page), { recursive: true });
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'sign-unknown-identity.png'), '--size', '1280x760', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
