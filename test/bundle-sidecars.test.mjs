// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A bundle inlines a recorded track's lip-sync sidecars and a manifest track's
// manifest, because fetch is dead on file://. A deck as data (#520) names its
// tracks in a JSON configuration block — `"dir": "voices"`, `"manifest": "…"`,
// keys in quotes — and the bundle has to find them there exactly as it finds
// `dir: 'voices'` in a boot call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'cli/decklight.mjs');

const SECTIONS = '<div class="decklight"><section><h2>One</h2></section></div>';

function deck(t, { data }) {
  const dir = scratch('bundle-sidecars', t);
  mkdirSync(path.join(dir, 'voices'));
  writeFileSync(path.join(dir, 'voices', 'slide-01.visemes.json'), '{"v":1,"cues":[]}');
  writeFileSync(path.join(dir, 'voices', 'slide-01-02.visemes.json'), '{"v":1,"cues":[]}');
  writeFileSync(path.join(dir, 'take.json'), '{"slides":[{"file":"slide-01.m4a"}]}');
  const narration = { files: [{ label: 'Me', dir: 'voices' }, { label: 'Cloud', manifest: 'take.json' }] };
  const file = path.join(dir, 'talk.html');
  writeFileSync(file, data
    ? `<!doctype html><html><head></head><body>${SECTIONS}`
      + `<script type="application/json" data-decklight-config>${JSON.stringify({ narration }, null, 2)}</script></body></html>`
    : `<!doctype html><html><head></head><body>${SECTIONS}`
      + `<script>Decklight.init({ narration: { files: [{ label: 'Me', dir: 'voices' }, { label: 'Cloud', manifest: 'take.json' }] } });</script></body></html>`);
  return { dir, file };
}

for (const data of [true, false]) {
  test(`bundle inlines the visemes and the manifest a ${data ? 'configuration block' : 'boot call'} names`, (t) => {
    const { dir, file } = deck(t, { data });
    const out = path.join(dir, 'out.html');
    const r = spawnSync(process.execPath, [CLI, 'bundle', file, '-o', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /data-decklight-visemes="slide-01"/, 'the slide sidecar');
    assert.match(html, /data-decklight-visemes="slide-01-02"/, 'and the beat sidecar');
    assert.match(html, /data-decklight-voices="take\.json"/, 'the manifest, under its own path');
    assert.match(r.stdout, /character visemes: inlined 2 timeline\(s\)/);
    assert.match(r.stdout, /narration: inlined 1 voice manifest\(s\)/);
  });
}
