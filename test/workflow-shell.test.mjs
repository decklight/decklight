// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Every `run:` block in .github/workflows parses as bash. A step's script is
// only ever executed on a runner, after a merge, so a syntax error in it is
// found by a broken deploy rather than by a review: an apostrophe in a comment
// inside the site deploy's `node -e '…'` closed the shell's quote, and
// decklight.io stopped publishing for two merges (#835). `bash -n` reads the
// script without running it; `${{ … }}` expressions are text to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { have } from './helpers.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');

test('every workflow run: block is valid bash', { skip: !have('bash') && 'no bash on this machine' }, () => {
  const broken = [];
  let checked = 0;
  for (const file of fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const doc = yaml.load(fs.readFileSync(path.join(DIR, file), 'utf8'));
    for (const [job, spec] of Object.entries(doc?.jobs ?? {})) {
      const jobShell = spec?.defaults?.run?.shell;
      (spec?.steps ?? []).forEach((step, i) => {
        if (typeof step?.run !== 'string') return;
        const shell = step.shell ?? jobShell ?? 'bash';
        if (!/^bash\b/.test(shell)) return;   // pwsh, python: not ours to parse here
        checked++;
        const r = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
        if (r.status !== 0) broken.push(`${file} › ${job} › ${step.name ?? `step ${i + 1}`}\n    ${r.stderr.trim().replace(/^bash: /, '')}`);
      });
    }
  }
  assert.ok(checked > 10, `only ${checked} run blocks found — is the workflow directory where this test thinks?`);
  assert.deepEqual(broken, [], `these steps would fail before running a command:\n  ${broken.join('\n  ')}`);
});
