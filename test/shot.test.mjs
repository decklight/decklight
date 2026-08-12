// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/shot.mjs — the serving contract, without a browser. The claim worth
// pinning after #229 is a negative one: shot renders a deck over an
// http://127.0.0.1 origin under the present CSP, and NEVER over file:// with
// --allow-file-access-from-files — the flag that let an unvetted deck read
// arbitrary local files. The browser-level proof that the origin actually
// contains the deck lives in test/shot-render.mjs; this locks the argv shot
// hands Chrome and the response the loopback server writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers.mjs';
import { shotMain } from '../tools/shot.mjs';
import { CSP } from '../cli/present.mjs';

/**
 * Run shotMain against a deck in a temp cwd with a fake renderer that never
 * launches a browser — it captures the argv and fetches the served URL, then
 * writes the output file so shot's own existence check passes. Returns what the
 * renderer saw.
 */
async function runShot(extraArgs = [], deckBody = '<div class="decklight"><section><h2>Hi</h2></section></div>') {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-shot-'));
  const cwd = process.cwd();
  const chrome = process.env.CHROME;
  // chromeBin() only READS $CHROME here — the fake renderer never runs it — but
  // it exits the process when unset, so give it any value.
  process.env.CHROME = chrome ?? '/bin/true';
  writeFileSync(path.join(dir, 'deck.html'),
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${deckBody}</body></html>`);
  process.chdir(dir);

  let seen;
  const render = async (bin, chromeArgv, meta) => {
    const res = await fetch(meta.url);
    seen = {
      bin, chromeArgv, meta,
      csp: res.headers.get('content-security-policy'),
      body: await res.text(),
    };
    writeFileSync(meta.out, 'PNG');
  };

  try {
    await shotMain(['deck.html', '-o', path.join(dir, 'out.png'), ...extraArgs], { render });
  } finally {
    process.chdir(cwd);
    if (chrome === undefined) delete process.env.CHROME; else process.env.CHROME = chrome;
    rmTemp(dir);
  }
  return seen;
}

test('shot renders over an http loopback origin, never file://', async () => {
  const seen = await runShot();
  assert.match(seen.meta.url, /^http:\/\/127\.0\.0\.1:\d+\/deck\.html/, 'the deck URL is a loopback http origin');
  assert.ok(!seen.chromeArgv.some((a) => a.startsWith('file://')), 'no file:// URL is handed to Chrome');
});

test('shot never passes --allow-file-access-from-files (#229)', async () => {
  const seen = await runShot();
  assert.ok(!seen.chromeArgv.includes('--allow-file-access-from-files'),
    'the flag that grants arbitrary local file reads is gone');
});

test('every served response carries the present CSP header', async () => {
  const seen = await runShot();
  assert.equal(seen.csp, CSP, 'the deck is served under the same policy present enforces');
});

test('--drive and --theme are injected into the deck response in memory', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-shot-drive-'));
  writeFileSync(path.join(dir, 'run.mjs'), 'window.__DROVE__ = 1;');
  const seen = await runShot(['--theme', 'aurora', '--drive', path.join(dir, 'run.mjs')]);
  assert.match(seen.body, /window\.__DROVE__ = 1;/, 'the driver snippet is in the served deck');
  assert.match(seen.body, /themes\/aurora\.css/, 'the --theme link is injected');
  assert.match(seen.body, /window\.__deck/, 'the boot shim (press/sleep/__deck) is present');
  rmTemp(dir);
});

test('a deck outside the current directory is refused, not served', async () => {
  const outside = mkdtempSync(path.join(tmpdir(), 'decklight-shot-outside-'));
  writeFileSync(path.join(outside, 'far.html'), '<!doctype html><html></html>');
  const cwd = process.cwd();
  const here = mkdtempSync(path.join(tmpdir(), 'decklight-shot-here-'));
  process.chdir(here);
  const origExit = process.exit;
  let exitCode;
  process.exit = (c) => { exitCode = c; throw new Error('exit'); };
  try {
    await shotMain([path.join(outside, 'far.html'), '-o', path.join(here, 'o.png')], { render: async () => {} });
  } catch { /* the stubbed exit throws to stop shotMain */ } finally {
    process.exit = origExit;
    process.chdir(cwd);
    rmTemp(outside);
    rmTemp(here);
  }
  assert.equal(exitCode, 1, 'shot exits non-zero rather than serving a deck outside the served root');
});
