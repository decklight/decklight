#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight report-bug — the mechanical half of a good bug report.
 *
 *   decklight report-bug
 *
 * Prints a ready-to-paste environment block and the new-issue URL, then exits.
 * That is the whole command: it makes NO network requests, files nothing,
 * opens nothing, and sends nothing anywhere. Everything it prints is on your
 * screen first, which is the only honest way to collect facts about somebody's
 * machine.
 *
 * The conversational half — what happened, what you expected, the smallest
 * repro, and an optional screenshot — belongs to the `decklight-report-bug`
 * agent skill, which drives this command and then asks. Keeping the command
 * print-and-exit is what makes it scriptable and testable; the agent is the
 * wizard, not the CLI.
 */

import os from 'node:os';
import { createRequire } from 'node:module';
import { isMain } from '../tools/args.mjs';
import { findChrome } from '../tools/chrome.mjs';
import { PKG } from './skill-content.mjs';

/** Is an optional dependency actually installed? Resolution only — never loaded. */
export function resolves(name, req = createRequire(import.meta.url)) {
  try { req.resolve(name); return true; } catch { return false; }
}

/**
 * The facts a triager asks for first, gathered from this machine. Pure inputs
 * are injectable so the block itself is testable without pretending to be a
 * different operating system.
 */
export function probe({ platform = os.platform(), release = os.release(), arch = os.arch(),
  node = process.version, chrome = findChrome(), pty = resolves('node-pty'),
  version = PKG.version } = {}) {
  return {
    decklight: version,
    node,
    os: `${platform} ${release} (${arch})`,
    chrome: chrome ? `yes (${chrome})` : 'not found',
    pty: pty ? 'installed' : 'not installed (terminal recording unavailable)',
  };
}

/** The paste-ready markdown. Pure — `probe()` supplies the facts. */
export function environmentBlock(facts) {
  return [
    '## Environment',
    '',
    `- decklight: ${facts.decklight}`,
    `- node: ${facts.node}`,
    `- os: ${facts.os}`,
    `- headless Chrome: ${facts.chrome}`,
    `- node-pty: ${facts.pty}`,
  ].join('\n');
}

/** The issues URL, taken from package.json rather than hardcoded twice. */
export function issuesUrl(pkg = PKG) {
  return typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url ?? '';
}

const HELP = `decklight report-bug — gather the facts a Decklight bug report needs

Usage:
  decklight report-bug

Prints a paste-ready environment block and the new-issue URL. It makes no
network requests and sends nothing anywhere — copy what you see, click the
link, paste.

A good report also needs three things this command cannot know: what happened
(verbatim output if there was any), what you expected instead, and the
smallest deck and keypresses that reproduce it.`;

export async function reportBugMain(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0; }

  console.log(environmentBlock(probe()));
  console.log();
  console.log('Also say, in the issue:');
  console.log('  - what happened (paste any error verbatim)');
  console.log('  - what you expected instead');
  console.log('  - the smallest deck + keypresses that reproduce it');
  console.log();
  console.log(`File it at: ${issuesUrl()}/new`);
  console.log('(nothing has been sent — this command only printed the above)');
  return 0;
}

if (isMain(import.meta.url)) process.exit(await reportBugMain());
