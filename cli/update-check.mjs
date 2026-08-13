#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * "A newer decklight exists" — the one line that reaches a user npx has pinned.
 *
 * `npx decklight` with no version reuses whatever tree npm already unpacked
 * into `~/.npm/_npx/<hash>/`; it does not re-resolve the `latest` dist-tag. So
 * the first version someone runs is the version they keep, and 0.4.0 could be
 * on the registry within minutes of the publish while their terminal still
 * printed 0.3.0 (#314). Teaching `npx decklight@latest` in the README fixes it
 * for people who come back and read the README. This is for everyone else.
 *
 * THE CHECK IS NEVER ON THE CRITICAL PATH. A command reads a cache file it
 * already has and prints from that; the refresh happens in a DETACHED child
 * that the parent does not wait for and does not read. So the notice a run
 * shows is the previous run's answer, which is the point — nothing about this
 * feature can make `decklight bundle` slower, or hang it on a registry that is
 * down, or leave a network call deciding when the process may exit.
 *
 * Everything here is pure over an injected env/clock/home, because the whole
 * feature is a set of conditions under which decklight must stay SILENT — and a
 * condition nothing can reach is a condition nobody can check.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configHome } from './marketplace.mjs';
import { isMain } from '../tools/args.mjs';

/** How long an answer stays good. A day: this is a courtesy, not telemetry. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** The dist-tag this asks about, and where. No dependency, just one GET. */
export const REGISTRY_URL = 'https://registry.npmjs.org/decklight/latest';

export const cachePath = (home = configHome()) => join(home, 'update-check.json');

/**
 * Why this run must say nothing — a string, or false to speak.
 *
 * Returning the REASON rather than a boolean is deliberate: it is what makes
 * the test read like the rule ("suppressed under CI") instead of like its
 * implementation, and what lets `decklight report-bug` say why nobody has been
 * told about a new version.
 */
export function suppressed({ env = process.env, isTty = process.stderr.isTTY } = {}) {
  if (env.DECKLIGHT_NO_UPDATE_CHECK) return 'DECKLIGHT_NO_UPDATE_CHECK is set';
  // The ecosystem's own opt-out, honoured because someone who set it once meant
  // it for every CLI on the machine, not for whichever ones knew the name.
  if (env.NO_UPDATE_NOTIFIER) return 'NO_UPDATE_NOTIFIER is set';
  if (env.CI) return 'CI';
  if (!isTty) return 'stderr is not a terminal';
  return false;
}

/**
 * `latest` if it is genuinely newer than `current`, else null.
 *
 * Numeric compare on the three parts, and any prerelease on either side is
 * ignored outright: nobody running a stable build should be nudged onto a
 * `-rc.1`, and a machine on a prerelease already knows what it is doing.
 */
export function newerVersion(current, latest) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(current); const b = parse(latest);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) return latest;
    if (b[i] < a[i]) return null;
  }
  return null;
}

/** The cached answer, or null when there isn't a usable one. */
export function readCache(home = configHome()) {
  try {
    const c = JSON.parse(readFileSync(cachePath(home), 'utf8'));
    return typeof c?.latest === 'string' && Number.isFinite(c?.checkedAt) ? c : null;
  } catch { return null; }
}

export function writeCache(latest, home = configHome(), now = Date.now()) {
  mkdirSync(home, { recursive: true });
  writeFileSync(cachePath(home), `${JSON.stringify({ latest, checkedAt: now }, null, 2)}\n`);
}

export const stale = (cache, now = Date.now()) => !cache || (now - cache.checkedAt) > CACHE_TTL_MS;

/** What the user reads. One line, and it says what to type. */
export const noticeLine = (current, latest) =>
  `  update: decklight ${latest} is out (you have ${current}) — npx decklight@latest …`;

/**
 * The notice for this run, or null.
 *
 * Reads only what is already on disk. A machine that has never refreshed sees
 * nothing, which is correct: the first run of a new install has nothing to be
 * behind on, and the answer arrives for the next one.
 */
export function updateNotice(current, { home = configHome(), env = process.env, isTty = process.stderr.isTTY, now = Date.now() } = {}) {
  if (suppressed({ env, isTty })) return null;
  const cache = readCache(home);
  if (!cache) return null;
  const newer = newerVersion(current, cache.latest);
  return newer ? noticeLine(current, newer) : null;
}

/**
 * Refresh the cache without the caller waiting, or caring.
 *
 * A detached child with no stdio: the parent's exit is unaffected, and a
 * registry that hangs holds nothing open in the process that matters. Fully
 * silent on failure — an offline machine gets no notice, no delay and no stack
 * trace, which is the whole contract.
 */
export function refreshInBackground({ home = configHome(), env = process.env, isTty = process.stderr.isTTY, now = Date.now() } = {}) {
  if (suppressed({ env, isTty })) return false;
  if (!stale(readCache(home), now)) return false;
  try {
    spawn(process.execPath, [fileURLToPath(import.meta.url), '--refresh'], {
      detached: true, stdio: 'ignore', env: { ...env, DECKLIGHT_HOME: home },
    }).unref();
    return true;
  } catch { return false; }
}

/** The child: ask the registry, write the answer, say nothing either way. */
export async function refreshMain({ home = configHome(), fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  try {
    const r = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const { version } = await r.json();
    if (!/^\d+\.\d+\.\d+/.test(String(version ?? ''))) return false;
    writeCache(version, home);
    return true;
  } catch { return false; }
}

if (isMain(import.meta.url)) {
  // Never a non-zero exit and never a word on either stream: nothing is
  // watching, and a background process that complains is a background process
  // that shows up in somebody's logs for no reason.
  await refreshMain();
  process.exit(0);
}

// `existsSync` is imported for the cache-dir check callers may want; keep the
// surface honest if it stops being used.
export const cacheExists = (home = configHome()) => existsSync(cachePath(home));
