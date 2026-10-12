// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight setup voice` with flags saves exactly those settings, no
// questions: where a flag that used to ride on every `decklight <deck>` run
// is given once now (ROADMAP section 1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceSettings } from '../cli/setup.mjs';

test('setup voice flags become tts.json keys; no flags means the guided setup', () => {
  assert.equal(voiceSettings([]), null, 'nothing given: the wizard asks');
  assert.deepEqual(voiceSettings(['--engine', 'elevenlabs', '--model', 'eleven_v3', '--stability', 'natural']),
    { engine: 'elevenlabs', model: 'eleven_v3', stability: 'natural' });
  assert.deepEqual(voiceSettings(['--format', 'mp3', '--lang', 'fr-FR', '--location', 'europe-west4', '--data-dir', '/m', '--voice', 'Anna', '--project', 'p-1']),
    { format: 'mp3', lang: 'fr-FR', location: 'europe-west4', dataDir: '/m', voice: 'Anna', project: 'p-1' });
});

test('a flag with no value is not a setting', () => {
  assert.equal(voiceSettings(['--voice']), null);
  assert.deepEqual(voiceSettings(['--voice', '--engine', 'say']), { engine: 'say' });
});
