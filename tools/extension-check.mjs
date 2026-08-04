// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The marketplace admission gate for build-time code (MARKETPLACE.md
// EXTENSIONS#CHECK, SPEC EXTENSIONS_CHECK) — what `decklight extension check`
// runs. Lives under tools/, which ships, for the reason tools/theme-check.mjs
// already gives: test/ does not, so a marketplace's own CI needs this
// reachable from the installed package, not from a suite that never travels.
//
// Two phases, checking two different things:
//
//   THE LINT IS LOAD-BEARING HERE, UNLIKE PRESENT#PLUGINS'. A presenter
//   plugin's lint catches something that ALSO fails at run time — its
//   sandboxed frame's opaque origin throws on `parent.document` regardless.
//   A transform runs as trusted, unsandboxed Node (EXTENSIONS_TRANSFORMS), so
//   nothing else stops `fetch` or `eval` from working. This lint is the only
//   thing standing between "HTML in, HTML out" and a transform that quietly
//   does network I/O or loads code a marketplace's SHA pin never covered.
//
//   THE HEADLESS LOAD CHECKS THE OUTPUT, NOT THE SOURCE. The file is run
//   (through the same loader EXTENSIONS#LOADER uses) against ONE small
//   fixture this module owns, never the submitter's own deck — proving the
//   CONTRACT, not "does it handle some particular author's markup". Refused
//   if the rendered result carries a <script> block, full stop: the one
//   automatable proof that "build-time transforms produce output, not code;
//   nothing executable travels" (MARKETPLACE.md EXTENSIONS) actually holds
//   for a given transform.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTransformAt, LoaderError } from '../cli/loader.mjs';
import { chromeBin, chromeArgs } from './chrome.mjs';

/** Extension kinds `extension check` knows how to validate. Grows to include
 *  `importer` once EXTENSIONS#ADAPTEREXEC freezes that contract. */
export const TYPES = ['transform'];

/**
 * The pin a passing submission's catalog entry carries (SPEC UNIT_PINNING) —
 * the SHA-256 of the file's raw bytes, exactly as `sha256sum` prints it, so
 * the gate that admits a transform also emits the digest `decklight
 * transform add` will hold the fetched module to.
 */
export const artifactSha256 = (file) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

/** The fixture every check runs a transform against — small on purpose (SPEC
 *  EXTENSIONS_CHECK): this proves the calling convention, not any particular
 *  author's deck. */
export const FIXTURE_HTML = '<!doctype html>\n<html><head><title>fixture</title></head>'
  + '<body><section><h2>Fixture</h2><p>decklight extension check</p></section></body></html>\n';

/**
 * Reaches a build-time transform has no business making — not a sandbox
 * boundary (there isn't one here), the bar itself. A shallow source-text
 * scan, the same kind `cli/plugin.mjs`'s `pluginLint` already runs.
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
      timeout: 15_000, killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Validate one transform source file. Returns `{ ok: true }` or `{ ok:
 * false, phase, ... }` — `phase` is `'lint'` (with `lint`, the matches),
 * `'load'` (with `error`, a `LoaderError` message) or `'output'` (with
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

  let output;
  try {
    output = await runTransformAt(abs, FIXTURE_HTML, path.basename(abs));
  } catch (e) {
    if (e instanceof LoaderError) return { ok: false, phase: 'load', error: e.message };
    throw e;
  }

  let dumped;
  try {
    dumped = headlessLoad(output);
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
  return { ok: true, sha256: artifactSha256(abs) };
}
