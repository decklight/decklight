// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Hand a URL to the platform's launcher. Lived in init.mjs, which meant
// `record` and `review` imported the whole scaffolding module — the skill text,
// the template machinery — to open one browser tab. Nothing here reads a file.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * The platform's "open this URL" command — a description, so a unit test can
 * check the choice without spawning anything. macOS ships `open`; Windows goes
 * through cmd's `start` (the empty string is the window title, or the URL would
 * become the title); everything else gets freedesktop's xdg-open. Zero new
 * dependencies.
 */
export function openCommand(platform, url) {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * Open the deck FILE in the default browser. A machine that cannot launch
 * (headless, no xdg-open) gets one dim line and a normal exit: opening is a
 * courtesy, and its failure is not the command's.
 */
export async function openDeck(deckPath, opts = {}) {
  const rel = path.relative('.', deckPath) || deckPath;
  return openUrl(pathToFileURL(deckPath).href, { ...opts, what: rel, prefix: opts.prefix ?? '--open: ' });
}

/**
 * The same launcher, for a URL that is not a file — the author server's, or
 * `decklight record`'s, which serves the deck over http://127.0.0.1 precisely
 * because a browser will not open a microphone for a `file://` page.
 */
export async function openUrl(url, {
  platform = process.platform, spawnFn = spawn, out = process.stdout, what = url, prefix = '',
} = {}) {
  const { cmd, args } = openCommand(platform, url);
  const rel = what;
  const dim = (s) => (out.isTTY && !process.env.NO_COLOR ? `${DIM}${s}${RESET}` : s);
  const skipped = (err) =>
    out.write(dim(`${prefix}could not launch a browser (${cmd}: ${err.code ?? err.message}) — open ${rel} yourself\n`));
  await new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, { stdio: 'ignore', detached: true });
    } catch (err) { skipped(err); resolve(); return; }
    child.once('error', (err) => { skipped(err); resolve(); });
    child.once('spawn', () => {
      child.unref();
      out.write(`opening ${rel} in your default browser\n`);
      resolve();
    });
  });
}
