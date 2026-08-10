// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The marketplace admission gate for build-time code (MARKETPLACE.md
// EXTENSIONS#CHECK, SPEC EXTENSIONS_CHECK) — what `decklight extension check`
// runs. Lives under tools/, which ships, for the reason tools/theme-check.mjs
// already gives: test/ does not, so a marketplace's own CI needs this
// reachable from the installed package, not from a suite that never travels.
//
// Three phases, checking three different things:
//
//   THE LINT IS ADVISORY, NOT A BOUNDARY. A shallow source-text scan for the
//   reaches a build-time transform has no business making — the same kind
//   `cli/plugin.mjs`'s `pluginLint` runs. It catches the honest mistake and
//   states the bar in a sentence; it does not constrain a determined one. A
//   static `import { execSync } from 'node:child_process'`, a `new
//   Function('return fetch')()`, a `globalThis['fet' + 'ch']` all pass a
//   regex unmatched, and no source-text scan closes that class.
//
//   THE SUBMISSION ONLY EVER EXECUTES BEHIND A PROCESS BOUNDARY. This
//   process never `import()`s the checked file: `runTransformIsolated` runs
//   it in a separate Node process under the permission model, with reads
//   limited to decklight's own package and the submission's directory, no
//   filesystem writes, no child processes, no workers, a scrubbed
//   environment, a temp working directory, and a wall-clock kill. What the
//   boundary does NOT cover, stated plainly: Node's permission model does
//   not restrict the network, so a hostile submission can still phone home
//   during the check — the boundary protects the checking machine's files,
//   processes and environment, not its network. And admission proves nothing
//   about later: an installed transform runs as trusted, unsandboxed Node
//   (EXTENSIONS_TRANSFORMS) — the installer bears that risk (MARKETPLACE.md
//   EXTENSIONS). Admission screens; it does not absolve.
//
//   THE HEADLESS LOAD CHECKS THE OUTPUT, NOT THE SOURCE. The transform runs
//   against ONE small fixture this module owns — randomised per check, so a
//   submission cannot recognise the fixture and behave only for the checker —
//   never the submitter's own deck: proving the CONTRACT, not "does it
//   handle some particular author's markup". Refused if the rendered result
//   carries a <script> block or an inline event handler (`on…=` attribute):
//   both are "the deck now carries executable code", the invariant
//   "build-time transforms produce output, not code; nothing executable
//   travels" (MARKETPLACE.md EXTENSIONS) exists to refuse.

import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeBin, chromeArgs } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(here, '..');
const RUNNER = path.join(here, 'extension-check-runner.mjs');

/** Node's permission model grants on REAL paths — it resolves a symlink before
 *  it checks, so `--allow-fs-read` on a path that crosses one grants nothing.
 *  macOS makes that the common case, not the exotic one (`/tmp` is a symlink to
 *  `/private/tmp`, and `os.tmpdir()` is `/var/folders/…` → `/private/var/…`), so
 *  a submission checked from a temp directory was refused for the checker's own
 *  path handling — reported as the submission failing to load. Resolve before
 *  granting; fall back to the path as given when it does not exist yet, which
 *  `checkExtension` has already refused by name. */
const real = (p) => { try { return realpathSync(p); } catch { return p; } };

/** Extension kinds `extension check` knows how to validate. The import-adapter
 *  contract this would grow to is frozen (SPEC EXTENSIONS_ADAPTERS); an
 *  `importer` kind here is future work with its ticket still to file. */
export const TYPES = ['transform'];

/**
 * The pin a passing submission's catalog entry carries (SPEC UNIT_PINNING) —
 * the SHA-256 of the file's raw bytes, exactly as `sha256sum` prints it, so
 * the gate that admits a transform also emits the digest `decklight
 * transform add` will hold the fetched module to.
 */
export const artifactSha256 = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

/** How long the submission gets, in each of its two executions (the transform
 *  run and the headless load of its output), before a hard kill. */
export const CHECK_TIMEOUT_MS = 15_000;

/** What the runner's verdict on stdout follows — AFTER whatever the transform
 *  itself printed, so the parent reads past the LAST occurrence and a forged
 *  marker is overwritten by the real one. */
export const RESULT_DELIM = '\n__decklight_extension_check_result__';

/**
 * The fixture a check runs a transform against — small on purpose (SPEC
 * EXTENSIONS_CHECK: this proves the calling convention, not any particular
 * author's deck) and randomised per call, so a submission cannot recognise
 * the fixture and behave only while being checked.
 */
export function makeFixture() {
  const nonce = randomBytes(8).toString('hex');
  return `<!doctype html>\n<html><head><title>check ${nonce}</title></head>`
    + `<body><section><h2>Check ${nonce}</h2><p>decklight extension check ${nonce}</p></section></body></html>\n`;
}

/**
 * Reaches a build-time transform has no business making. Advisory (see the
 * header): the boundary is `runTransformIsolated`, not this scan.
 */
const LINT = [
  [/\bfetch\s*\(/, 'calls fetch()'],
  [/\beval\s*\(/, 'calls eval()'],
  [/\bXMLHttpRequest\b/, 'uses XMLHttpRequest'],
  [/\bimport\s*\(/, 'uses a dynamic import()'],
];

/** `[{ line, why, text }]` for a transform's source — empty when nothing matched. */
export function extensionLint(js) {
  const out = [];
  js.split('\n').forEach((text, i) => {
    for (const [re, why] of LINT) {
      if (re.test(text)) out.push({ line: i + 1, why, text: text.trim().slice(0, 90) });
    }
  });
  return out;
}

/** The permission-model flag this Node answers to (`--permission` from 22.13,
 *  `--experimental-permission` back to the `engines` floor of 20), probed once
 *  and cached — or null on a Node that has neither, which `checkExtension`
 *  turns into a named refusal, never a silent unsandboxed run. */
let cachedPermissionFlag;
function permissionFlag() {
  if (cachedPermissionFlag !== undefined) return cachedPermissionFlag;
  for (const flag of ['--permission', '--experimental-permission']) {
    if (spawnSync(process.execPath, [flag, '-e', '0'], { stdio: 'ignore' }).status === 0) {
      cachedPermissionFlag = flag;
      return flag;
    }
  }
  cachedPermissionFlag = null;
  return null;
}

/**
 * Run one transform file against `fixture` behind the process boundary the
 * header describes, via tools/extension-check-runner.mjs. Returns `{ ok:
 * true, html }`, or `{ ok: false, phase, error }` ready for `checkExtension`
 * to hand back — `phase` is `'boundary'` when the boundary itself cannot be
 * established, `'load'` for everything the submission did wrong.
 *
 * The env is REPLACED, not extended: the fixture is the only variable that
 * crosses, so whatever secrets the checking machine's environment holds (a
 * CI runner's tokens, say) never enter the process the submission runs in.
 */
export function runTransformIsolated(file, fixture, { timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const abs = path.resolve(file);
  const flag = permissionFlag();
  if (!flag) {
    return { ok: false, phase: 'boundary', error: 'this Node has no permission model'
      + ' (needs --permission or --experimental-permission, Node 20+) — refusing to run'
      + ' an unvetted transform without the process boundary' };
  }
  const cwd = mkdtempSync(path.join(tmpdir(), 'decklight-extension-run-'));
  try {
    const realAbs = real(abs);
    const res = spawnSync(process.execPath, [
      flag,
      `--allow-fs-read=${real(PKG_ROOT)}${path.sep}`,
      `--allow-fs-read=${path.dirname(realAbs)}${path.sep}`,
      RUNNER, realAbs,
    ], {
      cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs, killSignal: 'SIGKILL',
      env: { DECKLIGHT_CHECK_FIXTURE: fixture },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (res.error?.code === 'ETIMEDOUT' || res.signal) {
      return { ok: false, phase: 'load', error: `the transform did not finish within ${Math.round(timeoutMs / 1000)}s`
        + ' and was killed — a transform must return (an infinite loop, or waiting on something'
        + ' that never comes)' };
    }
    if (res.error) {
      return { ok: false, phase: 'load', error: `the transform could not be run — ${res.error.message}` };
    }
    const at = (res.stdout ?? '').lastIndexOf(RESULT_DELIM);
    let verdict;
    try {
      verdict = at < 0 ? null : JSON.parse(res.stdout.slice(at + RESULT_DELIM.length));
    } catch { verdict = null; }
    if (!verdict) {
      return { ok: false, phase: 'load', error: 'the transform exited without returning its output'
        + ' (a process.exit(), or a crash) — a transform must return a string' };
    }
    if (!verdict.ok) return { ok: false, phase: 'load', error: verdict.error };
    return { ok: true, html: verdict.html };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Headlessly render `html` and return the dumped DOM — a temp file, never
 * the checked file itself, since what is being loaded is the OUTPUT.
 *
 * `timeout`/`killSignal` are load-bearing, not a courtesy: `--virtual-time-
 * budget` bounds Chrome's own clock, but a synchronous `alert()`/`confirm()`
 * in the OUTPUT opens a native dialog that blocks the render loop outside
 * virtual time entirely, and an infinite loop blocks it the same way — and
 * this command's whole job is loading output from code nobody has vetted
 * yet. Without a hard wall-clock kill, one such submission hangs whatever is
 * running the check (a marketplace's own CI) forever.
 */
function headlessLoad(html) {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-extension-check-'));
  try {
    const file = path.join(dir, 'output.html');
    writeFileSync(file, html);
    return execFileSync(chromeBin('extension check'), chromeArgs(
      '--virtual-time-budget=2000', '--dump-dom', `file://${file}`,
    ), {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      timeout: CHECK_TIMEOUT_MS, killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Validate one transform source file. Returns `{ ok: true }` or `{ ok:
 * false, phase, ... }` — `phase` is `'lint'` (with `lint`, the matches),
 * `'boundary'` (the process boundary could not be established), `'load'`
 * (with `error`, what the submission did wrong when run) or `'output'` (with
 * `error`) — never a raw stack trace.
 */
export async function checkExtension(file, { type = 'transform' } = {}) {
  if (!TYPES.includes(type)) {
    return { ok: false, phase: 'type', error: `--type ${type} is not implemented yet`
      + ` — this decklight only checks: ${TYPES.join(', ')}` };
  }

  const abs = path.resolve(file);
  const lint = extensionLint(readFileSync(abs, 'utf8'));
  if (lint.length) return { ok: false, phase: 'lint', lint };

  const run = runTransformIsolated(abs, makeFixture());
  if (!run.ok) return run;

  let dumped;
  try {
    dumped = headlessLoad(run.html);
  } catch (e) {
    if (e.signal || e.code === 'ETIMEDOUT') {
      return { ok: false, phase: 'output', error: 'the headless load did not finish within 15s and was killed —'
        + ' the output must never block the page (a synchronous alert()/confirm()/prompt(), or an infinite loop)' };
    }
    throw e;
  }
  if (/<script[\s>]/i.test(dumped)) {
    return { ok: false, phase: 'output', error: 'the output contains a <script> block — a transform'
      + ' must produce HTML only; nothing executable may travel (MARKETPLACE.md EXTENSIONS)' };
  }
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(dumped)) {
    return { ok: false, phase: 'output', error: 'the output carries an inline event handler (an on…= attribute)'
      + ' — as executable as a <script> block, just waiting for a click; nothing executable'
      + ' may travel (MARKETPLACE.md EXTENSIONS)' };
  }
  return { ok: true, sha256: artifactSha256(abs) };
}
