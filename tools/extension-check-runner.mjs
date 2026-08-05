// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The child half of `extension check`'s process boundary (SPEC
// EXTENSIONS_CHECK) — the ONLY process in which the checked submission ever
// executes. Spawned by tools/extension-check.mjs under Node's permission
// model (reads limited to decklight's package and the submission's own
// directory, no writes, no child processes, no workers), with a replaced
// environment, a temp cwd and a wall-clock kill. Never run by hand.
//
// Protocol: argv[2] is the transform file; the fixture arrives in
// $DECKLIGHT_CHECK_FIXTURE (env, not argv — spawnSync replaces the whole
// environment, so this is also what proves nothing else crossed); the
// verdict leaves on stdout as one JSON object after RESULT_DELIM. After,
// because the submission shares this stdout and whatever it prints must not
// be mistaken for the verdict: the parent reads past the LAST marker, so a
// forged one is overwritten by the real one, and a submission that kills the
// process before the marker becomes a refusal, not a pass.

import path from 'node:path';
import { runTransformAt, LoaderError } from '../cli/loader.mjs';
import { RESULT_DELIM } from './extension-check.mjs';

const report = (verdict) => process.stdout.write(`${RESULT_DELIM}${JSON.stringify(verdict)}\n`);

const file = process.argv[2];
const fixture = process.env.DECKLIGHT_CHECK_FIXTURE;
if (!file || typeof fixture !== 'string') {
  report({ ok: false, error: 'extension-check-runner: spawned without a file and a fixture'
    + ' — this is tools/extension-check.mjs\'s child, not a command' });
  process.exit(1);
}

try {
  const html = await runTransformAt(path.resolve(file), fixture, path.basename(file));
  report({ ok: true, html });
} catch (e) {
  report({ ok: false, error: e instanceof LoaderError ? e.message
    : `transform "${path.basename(file)}" failed: ${e.message}` });
  process.exitCode = 1;
}
