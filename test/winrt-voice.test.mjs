// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The WinRT path, EXECUTED — on the one machine class that can.
//
// Every other test of Windows' natural-voice bridge injects PowerShell's
// answers, which proves the parsing and the argv and nothing about whether
// the WinRT projection actually works from PowerShell 5.1. This one runs the
// real scripts on a real Windows: list the voices, synthesize one sentence
// with the first of them, and read back a RIFF/WAVE. windows-latest carries
// the OneCore classics (David, Zira, Mark), so the enumeration and the
// synthesis are exercised for real; the natural voices are a download the
// runner does not have, and the tiering of those is pinned in
// local-voice.test.mjs from a recorded listing.
//
// Skipped anywhere else, with the reason — never a silent pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers.mjs';

import { WINRT_LIST, parseWinrtVoices, winrtArgs } from '../tools/local-voice.mjs';

test('Windows PowerShell projects WinRT: the roster lists, and a voice speaks into a WAV', (t) => {
  if (process.platform !== 'win32') { t.skip('WinRT is Windows — the parsing and argv are pinned elsewhere'); return; }

  const listing = execFileSync('powershell.exe', WINRT_LIST, { encoding: 'utf8', timeout: 60000 });
  const voices = parseWinrtVoices(listing);
  assert.ok(voices.length >= 1, `no WinRT voices parsed from:\n${listing.slice(0, 400)}`);
  assert.ok(voices.every((v) => v.name && v.locale), 'every row has a name and a locale');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-winrt-'));
  t.after(() => rmTemp(dir));
  const file = path.join(dir, 'out.wav');
  execFileSync('powershell.exe', winrtArgs('Decklight speaks through WinRT.', voices[0].name, file),
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
  const wav = fs.readFileSync(file);
  assert.ok(wav.length > 44, `no audio came back (${wav.length} bytes)`);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF', 'not a WAV');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');

  // a voice this machine does not have must THROW, never speak as the default
  assert.throws(() => execFileSync('powershell.exe', winrtArgs('hi', 'No Such Voice 9000', path.join(dir, 'no.wav')),
    { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 }));
});
