#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight report-bug — print a triage-ready bug-report scaffold.
 *
 * Gathers the mechanical facts a triager always asks for — decklight
 * version, Node version, OS, whether headless Chrome and node-pty are
 * present — as a ready-to-paste markdown block, plus the new-issue URL
 * from package.json's `bugs`. It prints and exits: no questions, no
 * network, nothing filed or uploaded, Node builtins only. The
 * `decklight-report-bug` agent skill (installed by `init`/`skills`)
 * drives the interactive rest of the flow on top of this output.
 */

import os from 'node:os';
import { createRequire } from 'node:module';

import { PKG } from './skill-content.mjs';
import { makeFail } from './util.mjs';
import { findChrome } from '../tools/chrome.mjs';
import { isMain } from '../tools/args.mjs';

const fail = makeFail('report-bug');

const HELP = `decklight report-bug — print a triage-ready bug-report scaffold

Usage:
  decklight report-bug

Prints a markdown ## Environment block — decklight version, Node version,
OS, headless-Chrome availability, node-pty presence — a reminder of what a
complete report contains (what happened, what was expected, the smallest
repro), and the new-issue URL from package.json's "bugs".

It collects nothing else and sends nothing anywhere: no network requests,
no issue filed, no upload. Copy the block, click the URL, paste, submit.
`;

/** The repo's new-issue URL, from package.json's bugs (string or {url}). */
export function issuesUrl(pkg = PKG) {
  const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url;
  return bugs ? `${bugs.replace(/\/+$/, '')}/new` : null;
}

/** Is the optional node-pty dependency resolvable from this install? */
export function hasNodePty() {
  try { createRequire(import.meta.url).resolve('node-pty'); return true; }
  catch { return false; }
}

/** The markdown ## Environment block — pure, every fact a parameter. */
export function environmentBlock({ version, node, platform, release, arch, chrome, pty }) {
  return [
    '## Environment',
    '',
    `- decklight: ${version}`,
    `- node: ${node}`,
    `- os: ${platform} ${release} (${arch})`,
    `- headless chrome: ${chrome ? `found (${chrome})` : 'not found'}`,
    `- node-pty: ${pty ? 'installed' : 'not installed'}`,
  ].join('\n') + '\n';
}

export async function reportBugMain(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const stray = argv.find(Boolean);
  if (stray) fail(`unknown argument: ${stray} (report-bug takes none — it prints and exits)`);

  const block = environmentBlock({
    version: PKG.version,
    node: process.version,
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    chrome: findChrome(),
    pty: hasNodePty(),
  });
  process.stdout.write(`${block}
A complete report adds the three things only you know:

- **What happened** — the exact error or output, pasted verbatim.
- **What you expected** to happen instead.
- **The smallest repro** — the smallest deck (or the keys pressed) that shows it.

Nothing was collected or sent — copy the block above and file the report at:

  ${issuesUrl()}
`);
}

if (isMain(import.meta.url)) await reportBugMain();
