#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// CLI transcript evidence for #221: a hostile `.decklight` filename stays
// *data* in the macOS association launcher. Nothing about this ticket shows in
// a browser — the surface is the generated `Decklight.app` launcher — so the
// shot IS the terminal: the launcher below is the real generated file, the
// "double-click" is the real launcher run under `sh` against an `osascript`
// stub that records its argv instead of running it, and the `ls` lines are the
// real directory before and after. If either `touch` payload in the filename
// had executed, the evidence run aborts as invalid.
//
//   node shots/associate-hostile-filename.mjs
//     → .shots/associate-hostile-filename.png

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeBin, chromeArgs } from '../tools/chrome.mjs';
import { darwinFiles } from '../cli/associate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderShot(title, blocks, out, width, height) {
  const body = blocks.map(({ cmd, output }) =>
    `<div class="b"><div class="c"><span class="p">$</span> ${esc(cmd)}</div>`
    + (output ? `<pre>${esc(output)}</pre>` : '') + '</div>').join('\n');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #0d1117; font: 15px/1.45 ui-monospace, "SF Mono", Menlo, monospace; color: #c9d1d9; }
    .win { padding: 18px 22px; }
    .t { color: #8b949e; margin-bottom: 12px; } .t::before { content: "● ● ●  "; color: #30363d; letter-spacing: 2px; }
    .b { margin-bottom: 10px; } .c { color: #e6edf3; font-weight: 600; } .p { color: #3fb950; }
    pre { margin: 2px 0 0 0; color: #9ea7b3; white-space: pre-wrap; }
  </style><div class="win"><div class="t">${esc(title)}</div>${body}</div>`;
  const tmp = path.join(tmpdir(), `decklight-transcript-${process.pid}.html`);
  writeFileSync(tmp, html);
  try {
    execFileSync(chromeBin('transcript-shot'), chromeArgs(
      '--hide-scrollbars', `--window-size=${width},${height}`,
      `--screenshot=${path.resolve(out)}`, `file://${tmp}`,
    ), { stdio: ['ignore', 'ignore', 'ignore'] });
  } finally { rmSync(tmp, { force: true }); }
  console.log(out);
}

mkdirSync(path.resolve(here, '../.shots'), { recursive: true });

// The attack filename from the ticket: `'` to break a single-quoted splice,
// `"` for the AppleScript string level, `$()` and `;` for the shell.
const HOSTILE = `talk'; touch PWNED; '"$(touch PWNED2)".decklight`;

const dir = mkdtempSync(path.join(tmpdir(), 'decklight-assoc-demo-'));
const deck = path.join(dir, HOSTILE);
writeFileSync(deck, '<!doctype html>');

// The real generated launcher, with representative install paths.
const launcher = darwinFiles('/Users/casey', '/usr/local/bin/node', '/usr/local/lib/decklight/cli/decklight.mjs')
  .find((f) => f.path.endsWith('Contents/MacOS/decklight'));
const launcherPath = path.join(dir, 'decklight-launcher');
writeFileSync(launcherPath, launcher.text);
chmodSync(launcherPath, 0o755);

// osascript stub: record argv, run nothing — the same boundary the fix moved
// the filename behind, and the same stub the regression test uses.
const bin = path.join(dir, 'bin');
mkdirSync(bin);
writeFileSync(path.join(bin, 'osascript'), `#!/bin/sh
: > "$OSASCRIPT_SPY.argv"
for a in "$@"; do printf '%s\\n' "argv: $a" >> "$OSASCRIPT_SPY.argv"; done
cat > "$OSASCRIPT_SPY.stdin"
`);
chmodSync(path.join(bin, 'osascript'), 0o755);

const ls = () => execFileSync('ls', ['-1'], { cwd: dir, encoding: 'utf8' })
  .split('\n').filter((l) => l && l !== 'bin' && l !== 'decklight-launcher' && !l.startsWith('spy'))
  .join('\n');

const blocks = [];
blocks.push({ cmd: 'cat ~/Applications/Decklight.app/Contents/MacOS/decklight', output: launcher.text.trimEnd() });
blocks.push({ cmd: 'ls   # the deck someone sent — its NAME is the payload', output: ls() });

const spy = path.join(dir, 'spy');
const r = spawnSync('sh', [launcherPath, deck], {
  cwd: dir, encoding: 'utf8',
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OSASCRIPT_SPY: spy },
});
if (r.status !== 0) { console.error('EVIDENCE INVALID: launcher failed\n' + r.stderr); process.exit(1); }
blocks.push({
  cmd: `sh Decklight.app/Contents/MacOS/decklight "$PWD/${HOSTILE.replace(/"/g, '\\"')}"   # the double-click (osascript stubbed to record)`,
  output: '',
});
blocks.push({
  cmd: 'cat osascript-argv.log   # the path arrived as an ARGUMENT, byte for byte',
  output: readFileSync(spy + '.argv', 'utf8').trimEnd(),
});
const after = ls();
blocks.push({ cmd: 'ls   # no PWNED, no PWNED2 — nothing in the name executed', output: after });

// Whole lines only: the deck's own name contains the string "PWNED" by design.
if (/^PWNED2?$/m.test(after)) { console.error('EVIDENCE INVALID: the hostile filename executed'); process.exit(1); }
if (readFileSync(spy + '.stdin', 'utf8').includes(HOSTILE)) {
  console.error('EVIDENCE INVALID: the filename was spliced into the AppleScript source'); process.exit(1);
}

renderShot("issue #221 — a hostile .decklight filename stays data in the macOS launcher (osascript argv + quoted form of, never spliced into do script)",
  blocks, '.shots/associate-hostile-filename.png', 1280, 740);
rmSync(dir, { recursive: true, force: true });
