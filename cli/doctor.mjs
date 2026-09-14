// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight doctor — what this machine can do, and how to make it do the rest.
 *
 * Every optional capability used to announce itself only by failing: you
 * learned Chrome was missing when `pdf` said so, node-pty when `cast` refused,
 * ffmpeg after `video` had rendered every frame. This asks all of it up front,
 * and for each thing missing says two things the refusals never did together —
 * which commands it unlocks, and the one line that installs it.
 *
 * It is an inventory, like the ingredients label: no score, no verdict, exit 0.
 * A machine with none of the optional pieces is a perfectly good machine for
 * writing and presenting a deck, and the output should read that way.
 */

import { findChrome } from '../tools/chrome.mjs';
import { detectAgents, whichBin } from './agents.mjs';
import { resolves } from './report-bug.mjs';

/** The package manager's install line for `name`, per platform. */
export function installLine(name, platform = process.platform) {
  if (platform === 'darwin') return `brew install ${name}`;
  if (platform === 'win32') return `winget install ${name}`;
  return `sudo apt install ${name}`;
}

/**
 * The rows, pure over what was found. Every input is injectable so the table
 * for a machine with nothing on it can be checked from a machine with
 * everything, and the other way round.
 */
export function diagnose({
  platform = process.platform,
  which = (bin) => whichBin(bin),
  has = resolves,
  chrome = findChrome(),
  agents = detectAgents().map((a) => a.label),
} = {}) {
  const bin = (name) => which(name);
  const rows = [];
  const row = (label, found, unlocks, fix) => rows.push({ label, ok: !!found, found: found || null, unlocks, fix });

  row('Chrome', chrome, 'pdf · pptx · video · screenshots · the headless render checks',
    'install Google Chrome or Chromium, or point $CHROME at one');
  const ffmpeg = bin('ffmpeg'), ffprobe = bin('ffprobe');
  row('ffmpeg', ffmpeg && ffprobe ? ffmpeg : null, 'video (a narrated mp4 of the deck)',
    installLine('ffmpeg', platform));
  row('git', bin('git'), 'auto-commits in author mode · history · restore · publish · review submit',
    installLine('git', platform));
  row('gh', bin('gh'), "init's GitHub remote offer · review submit --pr",
    installLine('gh', platform));
  row('node-pty + js-yaml', has('node-pty') && has('js-yaml') ? 'installed' : null,
    'cast · refresh (recording a terminal in a real PTY)',
    'npm install -g decklight --include=optional   (node-pty builds a native module: needs a C toolchain)');
  row('sigstore', has('sigstore') ? 'installed' : null, 'bundle --sign · publish (signed by default)',
    'npm install -g decklight --include=optional');
  row('an AI agent', agents.length ? agents.join(', ') : null,
    'A in author mode (ask an agent to edit the deck) · agent-written commit subjects',
    'install one: claude (npm i -g @anthropic-ai/claude-code), codex, gemini, copilot, aider …');
  const local = platform === 'darwin' ? 'say (built in)' : platform === 'win32' ? 'Windows speech (built in)' : null;
  row('a local voice', local ?? (bin('piper') ? 'piper' : null), 'narration with no account and no network',
    'uv tool install piper-tts   (or a cloud engine: decklight tts --setup)');
  row('rhubarb', bin('rhubarb'), 'lipsync (mouth shapes for the talking-head character)',
    'https://github.com/DanielSWolf/rhubarb-lip-sync/releases — put the binary on PATH');
  return rows;
}

/** The table, as lines. Marks are text, so a log and a terminal read the same. */
export function formatDoctor(rows, { color = false } = {}) {
  const GREEN = '\x1b[32m', DIM = '\x1b[2m', RESET = '\x1b[0m';
  const paint = (s, c) => (color ? `${c}${s}${RESET}` : s);
  const width = Math.max(...rows.map((r) => r.label.length)) + 2;
  const lines = ['decklight doctor — what this machine can do', ''];
  for (const r of rows) {
    const mark = r.ok ? paint('ok', GREEN) : paint('--', DIM);
    lines.push(`  ${mark}  ${r.label.padEnd(width)}${r.ok ? r.found : 'not found'}`);
    lines.push(`      ${paint(r.unlocks, DIM)}`);
    if (!r.ok) lines.push(`      ${paint('→ ' + r.fix, DIM)}`);
  }
  const missing = rows.filter((r) => !r.ok).length;
  lines.push('');
  lines.push(missing
    ? `${rows.length - missing} of ${rows.length} present. Writing and presenting a deck needs none of the missing ones.`
    : `everything present — every command has what it needs`);
  return lines;
}

const HELP = `decklight doctor — what this machine can do

Usage:
  decklight doctor

Checks for Chrome, ffmpeg, git, gh, the optional npm dependencies, a coding
agent, a local voice and rhubarb, and for each one missing says which commands
it unlocks and the line that installs it. Reads PATH and the filesystem only:
no network, nothing written, exit 0 either way.`;

export async function doctorMain(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0; }
  const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
  for (const line of formatDoctor(diagnose(), { color })) console.log(line);
  return 0;
}
