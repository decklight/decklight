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
/**
 * Write a stub `piper` into `dir`: answers `--help`, refuses a voice whose
 * .onnx is not in --data-dir with the real error string, and for every line
 * of text on stdin drops a small valid WAV into the -d spool dir, announcing
 * it on stderr exactly like the real piper (`INFO:__main__:Wrote <path>`) —
 * the signal createPiper's resident wrapper synchronizes on. Lets the whole
 * tts pipeline (wizard test synthesis included) run end-to-end without the
 * 120 MB model. Returns the stub's path.
 */
export function writeFakePiper(dir) {
  const stub = join(dir, 'piper');
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
if (args.includes('--help')) process.exit(0);
const get = (f) => args[args.indexOf(f) + 1];
const model = get('-m'), out = get('-d');
const dataDir = args.includes('--data-dir') ? get('--data-dir') : null;
if (dataDir && !fs.existsSync(path.join(dataDir, model + '.onnx'))) {
  process.stderr.write('Unable to find voice: ' + model + '\\n');
  process.exit(1);
}
let n = 0, buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  const lines = buf.split('\\n'); buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const pcm = Buffer.alloc(24000);           // half a second of 24 kHz silence
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    const f = path.join(out, Date.now() + '_' + (n++) + '.wav');
    fs.writeFileSync(f, Buffer.concat([h, pcm]));
    process.stderr.write('INFO:__main__:Wrote ' + f + '\\n');
  }
});
`, { mode: 0o755 });
  return stub;
}

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

// ── running a child on somebody else's operating system ────────────────────
// Three things every test that spawns a process gets wrong on Windows, in one
// place. They were found by the first Windows CI run, where 15 of the 25
// failures came from the first of them alone.

/**
 * A child environment with `overrides` applied — case-INSENSITIVELY.
 *
 * Windows spells it `Path`. `{ ...process.env, PATH: dir }` therefore produces
 * an object carrying BOTH keys, the real one and the override, and which one
 * the child sees is anybody's guess. Every test that narrows PATH to say "no
 * git and no agents here" was quietly still handing the child the whole real
 * PATH, so the thing it was proving absent was present.
 */
export function childEnv(overrides = {}, base = process.env) {
  const env = { ...base };
  for (const key of Object.keys(overrides)) {
    for (const existing of Object.keys(env)) {
      if (existing !== key && existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    }
    env[key] = overrides[key];
  }
  return env;
}

/**
 * A home directory every platform agrees on.
 *
 * `os.homedir()` reads `$HOME` on POSIX and `%USERPROFILE%` on Windows, so a
 * test that sets only HOME redirects nothing there — and then writes into the
 * real user profile while asserting about a temp one.
 */
export const homeEnv = (home) => ({ HOME: home, USERPROFILE: home });

/**
 * A fake executable on PATH, in whatever shape this OS will actually run.
 *
 * The logic goes in a `.mjs` and the shim only forwards to it, because the
 * alternative is maintaining the same behaviour twice — once in `sh` and once
 * in batch, whose quoting rules are their own adventure. Windows gets a `.cmd`
 * (which `onPath` already looks for); everything else gets a `#!/bin/sh` stub
 * with the executable bit.
 */
export function writeFakeBin(dir, name, js) {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(script, js);
  if (process.platform === 'win32') {
    const cmd = join(dir, `${name}.cmd`);
    writeFileSync(cmd, `@"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`);
    return cmd;
  }
  const sh = join(dir, name);
  writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return sh;
}
