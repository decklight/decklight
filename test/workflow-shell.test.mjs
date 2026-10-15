// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Every `run:` block in .github/workflows parses as bash. A step's script is
// only ever executed on a runner, after a merge, so a syntax error in it is
// found by a broken deploy rather than by a review: an apostrophe in a comment
// inside the site deploy's `node -e '…'` closed the shell's quote, and
// decklight.io stopped publishing for two merges (#835). `bash -n` reads the
// script without running it; `${{ … }}` expressions are text to it.
//
// The blocks are read as text, not with a YAML library: js-yaml is an optional
// dependency and CI installs with --omit=optional, so a guard that needed it
// would skip on exactly the machines it is for. The workflows use two forms,
// `run: |` blocks and one-line `run: cmd`, and both are read here; a step that
// names another shell (`shell: pwsh`) is left out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { have } from './helpers.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const indentOf = (line) => line.match(/^ */)[0].length;

/** Every `run:` script in a workflow's text: `{ line, step, shell, script }`. */
export function runBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(/^( *)(- )?run:\s*(.*)$/);
    if (!m) return;
    const keyIndent = m[1].length + (m[2] ? 2 : 0);
    // the step this key belongs to: its `- ` line, and where the next one starts
    let start = i;
    if (!m[2]) while (start > 0 && !(lines[start].startsWith(' '.repeat(keyIndent - 2) + '- ') && indentOf(lines[start]) === keyIndent - 2)) start--;
    let end = i + 1;
    while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) >= keyIndent)) end++;
    const step = lines.slice(start, end);
    const name = step.join('\n').match(/^\s*(?:- )?name:\s*(.+)$/m)?.[1]?.trim();
    const shell = step.join('\n').match(/^\s*(?:- )?shell:\s*(\S+)/m)?.[1] ?? 'bash';
    let script;
    if (/^[|>]/.test(m[3])) {
      const body = [];
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > keyIndent); j++) body.push(lines[j]);
      const cut = Math.min(...body.filter((l) => l.trim()).map(indentOf));
      script = body.map((l) => l.slice(cut)).join('\n');
    } else {
      script = m[3];
    }
    out.push({ line: i + 1, step: name ?? `line ${i + 1}`, shell, script });
  });
  return out;
}

test('runBlocks reads both forms, keeps a block whole and knows the step\'s shell', () => {
  const blocks = runBlocks([
    'jobs:', '  a:', '    steps:',
    '      - run: npm ci',
    '      - name: two lines', '        run: |', '          echo one', '', '          echo two', '        env:', '          X: 1',
    '      - name: windows only', '        shell: pwsh', '        run: Write-Host hi',
  ].join('\n'));
  assert.deepEqual(blocks.map((b) => [b.step, b.shell, b.script]), [
    ['line 4', 'bash', 'npm ci'],
    ['two lines', 'bash', 'echo one\n\necho two'],
    ['windows only', 'pwsh', 'Write-Host hi'],
  ]);
});

// Skipped on Windows: `bash` there can be the WSL launcher rather than Git
// Bash, and the Linux CI job already reads every workflow.
const skip = process.platform === 'win32' ? 'Windows: bash may be WSL; Linux CI covers it' : !have('bash') && 'no bash on this machine';
test('every workflow run: block is valid bash', { skip }, () => {
  const broken = [];
  let checked = 0;
  for (const file of fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    for (const b of runBlocks(fs.readFileSync(path.join(DIR, file), 'utf8'))) {
      if (!/^bash\b/.test(b.shell)) continue;   // pwsh, python: not ours to parse here
      checked++;
      const r = spawnSync('bash', ['-n'], { input: b.script, encoding: 'utf8' });
      if (r.status !== 0) broken.push(`${file}:${b.line} › ${b.step}\n    ${r.stderr.trim().replace(/^bash: /, '')}`);
    }
  }
  assert.ok(checked > 30, `only ${checked} run blocks found — is the workflow directory where this test thinks?`);
  assert.deepEqual(broken, [], `these steps would fail before running a command:\n  ${broken.join('\n  ')}`);
});
