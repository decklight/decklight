#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for #233 — the engine wizard's player half is REACHABLE — and for
// #232 — the mounted card names its asker and its destination. The wizard only
// exists while an author server serves the deck, and tools/shot.mjs shoots
// file:// copies, so this generator bakes the same miniature server stand-in the
// engine-render harness uses (ping advertising one configurable engine, GET
// /edit/wizard handing over a vetted schema WITH its provenance — the player
// refuses to mount without it) into a small REAL deck. Everything on screen —
// palette row, form, password field, provenance line — is the real bundled
// engine rendering it; only the loopback server is stubbed, exactly as in
// test/engine.html.
//
//   node shots/wizard-open.gen.mjs
//   node tools/shot.mjs .shots/wizard-deck.html -o .shots/wizard-palette-row.png \
//     --drive shots/wizard-palette-row.mjs --wait 3000
//   node tools/shot.mjs .shots/wizard-deck.html -o .shots/wizard-open.png \
//     --drive shots/wizard-open.mjs --wait 3000
//   node tools/shot.mjs .shots/wizard-deck.html -o .shots/wizard-provenance.png \
//     --drive shots/wizard-provenance.mjs --wait 3000

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, '.shots');
fs.mkdirSync(shots, { recursive: true });

fs.writeFileSync(path.join(shots, 'wizard-deck.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>engine wizard — #233 evidence</title>
  <link rel="stylesheet" href="../dist/decklight.css">
  <script>
    // The author server, in miniature (as in test/engine.html mode=wizard):
    // enough of /edit/ping and GET /edit/wizard for the palette to grow its
    // Configure row and the wizard to mount a vetted schema.
    const SCHEMA = {
      engine: 'elevenlabs', title: 'ElevenLabs',
      fields: [
        { name: 'apiKey', label: 'API key', type: 'secret', required: true },
        { name: 'voice', label: 'Voice', type: 'choice', options: ['Rachel', 'Adam'], required: false },
        { name: 'cache', label: 'Cache audio', type: 'boolean', default: true, required: false },
      ],
      validate: '/validate',
    };
    // What the real server derives with cli/wizard.mjs provenance() (#232) —
    // without this pair beside the schema the player refuses to mount at all.
    const PROVENANCE = {
      askedBy: 'asked by elevenlabs@voices',
      sentTo: 'answers go to its own bridge on this machine (127.0.0.1:8787/validate), then ~/.decklight/credentials.json (0600)',
    };
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    window.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/edit/ping')) {
        return json({ ok: true, undo: 0, redo: 0, git: true, agents: [],
          wizards: [{ name: 'elevenlabs', qualified: 'elevenlabs@voices', title: 'ElevenLabs' }] });
      }
      if (u.includes('/edit/wizard') && init?.method !== 'POST') {
        return json({ ok: true, schema: SCHEMA, from: 'elevenlabs@voices', provenance: PROVENANCE });
      }
      return new Response('', { status: 404 });
    };
    window.EventSource = class { constructor() { this.readyState = 0; } addEventListener() {} close() {} };
  </script>
</head>
<body>
  <div class="decklight">
    <section>
      <h1>The engine wizard, reachable</h1>
      <p class="subtitle">/ → Configure ElevenLabs… (dev) — ENGINES#WIZARD, issue #233</p>
      <ul>
        <li>The author server's ping advertises the engines a marketplace declares a wizard for</li>
        <li>Each gets a contextual palette row; core renders the vetted schema</li>
        <li>A secret is a password field; without a server there is no row at all</li>
        <li>The card names who is asking and where the answer goes — words the plugin did not write (#232)</li>
      </ul>
    </section>
  </div>
  <script src="../dist/decklight.js"></script>
  <script>Decklight.init()</script>
</body>
</html>
`);

console.log(`page: ${path.join(shots, 'wizard-deck.html')}`);
