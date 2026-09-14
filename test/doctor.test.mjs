// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight doctor`: an inventory of what this machine can do, pure over
// injected probes so the table for a bare machine and for a full one can both
// be checked from here. It never fails the run — writing and presenting a deck
// needs none of the optional pieces, and the output has to read that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, formatDoctor, installLine } from '../cli/doctor.mjs';

const nothing = { which: () => null, has: () => false, chrome: null, agents: [], platform: 'linux' };
const everything = {
  which: (b) => `/usr/bin/${b}`, has: () => true, chrome: '/usr/bin/google-chrome',
  agents: ['Claude Code', 'Codex CLI'], platform: 'linux',
};

test('a bare machine gets a fix line for every row, and the closing line is reassuring', () => {
  const rows = diagnose(nothing);
  assert.ok(rows.length >= 8);
  for (const r of rows) {
    assert.equal(r.ok, false, r.label);
    assert.ok(r.fix && r.unlocks, `${r.label} says what it unlocks and how to get it`);
  }
  const lines = formatDoctor(rows);
  assert.match(lines.at(-1), /0 of \d+ present\. Writing and presenting a deck needs none of the missing ones\./);
  assert.ok(lines.some((l) => /→ sudo apt install ffmpeg/.test(l)), 'the install line is the platform’s');
});

test('a full machine has every row present and no fix lines', () => {
  const rows = diagnose(everything);
  assert.ok(rows.every((r) => r.ok), rows.filter((r) => !r.ok).map((r) => r.label).join(', '));
  const lines = formatDoctor(rows);
  assert.ok(!lines.some((l) => l.includes('→')), 'nothing to fix, nothing suggested');
  assert.match(lines.at(-1), /everything present/);
  assert.ok(lines.some((l) => /an AI agent.*Claude Code, Codex CLI/.test(l)), 'the agents are named');
});

test('ffmpeg counts only with ffprobe beside it — video needs both', () => {
  const rows = diagnose({ ...everything, which: (b) => (b === 'ffprobe' ? null : `/usr/bin/${b}`) });
  assert.equal(rows.find((r) => r.label === 'ffmpeg').ok, false);
});

test('the local voice row knows what each platform ships', () => {
  assert.match(diagnose({ ...nothing, platform: 'darwin' }).find((r) => r.label === 'a local voice').found, /say/);
  assert.match(diagnose({ ...nothing, platform: 'win32' }).find((r) => r.label === 'a local voice').found, /Windows speech/);
  const linux = diagnose({ ...nothing, platform: 'linux' }).find((r) => r.label === 'a local voice');
  assert.equal(linux.ok, false);
  assert.match(linux.fix, /piper/);
  assert.equal(diagnose({ ...nothing, which: (b) => (b === 'piper' ? '/usr/bin/piper' : null) })
    .find((r) => r.label === 'a local voice').found, 'piper', 'piper is a local voice on any platform');
});

test('install lines follow the platform', () => {
  assert.equal(installLine('ffmpeg', 'darwin'), 'brew install ffmpeg');
  assert.equal(installLine('ffmpeg', 'win32'), 'winget install ffmpeg');
  assert.equal(installLine('ffmpeg', 'linux'), 'sudo apt install ffmpeg');
});

test('color is opt-in and never changes the words', () => {
  const rows = diagnose(nothing);
  const plain = formatDoctor(rows).join('\n');
  const colored = formatDoctor(rows, { color: true }).join('\n');
  assert.doesNotMatch(plain, /\x1b\[/);
  assert.equal(colored.replace(/\x1b\[[0-9;]*m/g, ''), plain);
});
