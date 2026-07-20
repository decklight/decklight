// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Small fixtures several test files hand-rolled verbatim: the optional-dep and
// Windows skip guards, and the stub rhubarb the viseme tests run instead of the
// real binary.

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// node-pty and js-yaml are optional (CLI recording only); a checkout without
// them should SKIP the tests that need them, not fail. The value is a skip
// reason string (truthy) or false.
export const optionalDepSkip = (() => {
  const require = createRequire(import.meta.url);
  try { require.resolve('node-pty'); require.resolve('js-yaml'); return false; }
  catch { return 'node-pty/js-yaml not installed (optional deps)'; }
})();

// the stub rhubarb is a POSIX shell script, so the tests that write it can't
// run on Windows.
export const winShellSkip = process.platform === 'win32' ? 'stub rhubarb is a shell script' : false;

/**
 * Write a stub `rhubarb` into `dir`: it answers `--version`, and copies
 * `fixture` to whatever `-o` names, so the viseme pipeline runs end-to-end
 * without the real binary (or a GPU). Returns the stub's path.
 */
export function writeRhubarbStub(dir, fixture) {
  const stub = join(dir, 'rhubarb');
  writeFileSync(stub, `#!/bin/sh
[ "$1" = "--version" ] && { echo "Rhubarb stub"; exit 0; }
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cp "${fixture}" "$out"
`, { mode: 0o755 });
  return stub;
}
