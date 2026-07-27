#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Put a recorded voice track in a bucket and sign it, so the megabytes of
// audio stop travelling with the deck.
//
//   node tools/publish-voices.mjs voices/algenib \
//     --bucket gs://decklight-voices/showcase --sign 7d
//
// What ships next to the deck afterwards is manifest.signed.json — a few KB of
// JSON naming one URL per slide. The runtime plays those URLs verbatim, which
// is the entire reason this exists: a presigned URL carries its signature in
// the query string, and the older `dir:` form has nowhere to put one. A PUBLIC
// bucket never needed this and still doesn't (`dir: 'https://storage.googleapis.com/…'`
// has always worked) — signing is for audio that should not be world-readable.
//
// Signing is `gcloud storage sign-url`, not our own node:crypto. V4 signing is
// twenty lines, but it means a service-account private key passing through a
// repo tool; gcloud already owns those credentials and should keep owning them.
// Same posture as tools/publish-site-voices.mjs shelling out to `gh`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { argReader, isMain } from './args.mjs';

const USAGE = `usage: node tools/publish-voices.mjs <voice-dir> --bucket gs://bucket/prefix [--sign 7d]
  uploads a recorded track's audio to Cloud Storage and writes a manifest of
  per-slide URLs to deploy next to the deck

  --bucket gs://…  destination; the track's own folder name is appended
  --sign <dur>     mint V4 signed URLs valid this long (max 7d, the V4 cap)
                   omit for a public bucket — plain object URLs, no expiry
  --all            re-upload every file, not just the ones whose hash moved
  --dry-run        print what would happen; touch nothing

  needs gcloud on PATH, authenticated for the bucket`;

/** GCS caps V4 signatures at seven days. Not our rule, but ours to enforce. */
export const V4_MAX_SECONDS = 7 * 24 * 3600;

const VALUE_FLAGS = new Set(['--bucket', '--sign']);

/**
 * The bare words in argv — the voice directory, here. Skipping each value
 * flag's argument by name is what keeps `--sign 7d` from being mistaken for a
 * directory called `7d`.
 */
export function positional(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (VALUE_FLAGS.has(argv[i])) { i += 1; continue; }
    if (argv[i].startsWith('-')) continue;
    out.push(argv[i]);
  }
  return out;
}

/**
 * `7d`, `12h`, `30m`, `3600s`, or bare seconds → seconds.
 * Returns null for anything else, so a typo is a message and not a surprise.
 */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  return Math.round(n * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2]] ?? 1));
}

/**
 * Split `gs://bucket/some/prefix` into its parts. A destination that is not a
 * gs:// URL is worth catching here rather than inside gcloud's error text.
 */
export function parseBucket(dest) {
  const m = /^gs:\/\/([a-z0-9][a-z0-9._-]*)(?:\/(.*))?$/i.exec(String(dest ?? '').trim());
  if (!m) return null;
  return { bucket: m[1], prefix: (m[2] ?? '').replace(/\/+$/, '') };
}

/** The gs:// path a track's files live under — the dir's own name, appended. */
export const trackPrefix = ({ bucket, prefix }, dirName) =>
  `gs://${bucket}/${[prefix, dirName].filter(Boolean).join('/')}`;

/**
 * Which files this run has to upload.
 *
 * The track's manifest already carries a content hash per slide — that is how
 * the pre-render tool skips regenerating unchanged audio — so a previous
 * manifest.signed.json is a record of exactly which bytes are already up
 * there. No bucket listing, no re-hashing: files whose hash moved, plus any
 * the last publish never saw.
 */
export function changedFiles(manifest, previous, { all = false } = {}) {
  const was = new Map((previous?.slides ?? []).filter(Boolean).map((s) => [s.file, s.hash]));
  return (manifest?.slides ?? [])
    .filter(Boolean)
    .filter((s) => all || was.get(s.file) !== s.hash);
}

/**
 * The manifest that ships with the deck: the source manifest, plus a URL per
 * slide and the facts a lapsed deck needs to name its own fix.
 */
export function signedManifest(manifest, {
  urls, expires, source, bucket, signDuration,
}) {
  return {
    ...manifest,
    ...(expires ? { expires } : {}),
    source,
    bucket,
    ...(signDuration ? { signDuration } : {}),
    slides: (manifest.slides ?? []).map((s) => (s ? { ...s, url: urls.get(s.file) ?? s.url } : null)),
  };
}

/**
 * `gcloud storage sign-url --format=json` has answered with a bare object and
 * with a list across versions, and has spelled the field both ways. Read all
 * of them rather than pinning a gcloud release.
 */
export function signedUrlFrom(json) {
  const one = Array.isArray(json) ? json[0] : json;
  return one?.signed_url ?? one?.signedUrl ?? one?.signed_uri ?? null;
}

const gcloud = (argv) => execFileSync('gcloud', argv, { encoding: 'utf8', maxBuffer: 1 << 26 });

export async function publishVoicesMain(args = []) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(USAGE); return args.length ? 0 : 1; }
  const { opt } = argReader(args);
  const [dir] = positional(args);
  if (!dir) { console.error(`publish-voices: needs a voice directory\n\n${USAGE}`); return 1; }
  const src = resolve(dir);
  const manifestPath = join(src, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(`publish-voices: ${dir}/manifest.json not found`);
    console.error('  generate the track first: node tools/voiceover.mjs deck.html --engine gemini -o ' + dir);
    return 1;
  }

  const dest = parseBucket(opt('--bucket'));
  if (!dest) { console.error(`publish-voices: --bucket must be a gs:// URL\n\n${USAGE}`); return 1; }

  const signArg = opt('--sign');
  let signSeconds = null;
  if (args.includes('--sign') && (signArg === undefined || signArg.startsWith('-'))) {
    console.error(`publish-voices: --sign needs a duration (try 7d)\n\n${USAGE}`);
    return 1;
  }
  if (signArg !== undefined) {
    signSeconds = parseDuration(signArg);
    if (signSeconds === null) {
      console.error(`publish-voices: --sign ${signArg} is not a duration (try 7d, 12h, 30m)`);
      return 1;
    }
    if (signSeconds > V4_MAX_SECONDS) {
      console.error(`publish-voices: --sign ${signArg} is longer than 7d`);
      console.error('  V4 signatures cannot outlive seven days — that is the signing scheme\'s own');
      console.error('  limit, not ours. For audio that must stay reachable indefinitely, use a');
      console.error('  public bucket and point the deck at it with dir: instead of signing.');
      return 1;
    }
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const outPath = join(src, 'manifest.signed.json');
  let previous = null;
  try { previous = JSON.parse(readFileSync(outPath, 'utf8')); } catch { /* first publish */ }

  const dirName = basename(src);
  const at = trackPrefix(dest, dirName);
  const dry = args.includes('--dry-run');
  const changed = changedFiles(manifest, previous, { all: args.includes('--all') });
  const missing = changed.filter((s) => !existsSync(join(src, s.file)));
  if (missing.length) {
    console.error(`publish-voices: ${missing.length} file(s) in the manifest are not on disk:`);
    for (const s of missing.slice(0, 5)) console.error(`  ${s.file}`);
    console.error('  regenerate the track, or delete manifest.json to start clean');
    return 1;
  }

  if (!changed.length) console.log(`nothing to upload — every slide's audio is already at ${at}`);
  else {
    const bytes = changed.reduce((n, s) => n + statSync(join(src, s.file)).size, 0);
    console.log(`${dry ? 'would upload' : 'uploading'} ${changed.length} changed file(s)`
      + ` (${(bytes / 1048576).toFixed(1)} MB) → ${at}`);
    if (!dry) {
      for (const s of changed) gcloud(['storage', 'cp', join(src, s.file), `${at}/${s.file}`]);
    }
  }

  // EVERY slide is signed, not only the changed ones: signatures expire on
  // their own schedule, so a re-sign that skipped the untouched files would
  // publish a manifest where most slides had already lapsed.
  const all = (manifest.slides ?? []).filter(Boolean);
  const urls = new Map();
  let expires = null;
  if (signSeconds === null) {
    for (const s of all) urls.set(s.file, `https://storage.googleapis.com/${dest.bucket}/${[dest.prefix, dirName, s.file].filter(Boolean).join('/')}`);
    console.log(`wrote ${all.length} public URL(s) — no signature, no expiry`);
  } else if (dry) {
    console.log(`would sign ${all.length} slide URL(s) for ${signArg}`);
  } else {
    for (const s of all) {
      const out = gcloud(['storage', 'sign-url', `${at}/${s.file}`,
        `--duration=${signSeconds}s`, '--format=json']);
      const url = signedUrlFrom(JSON.parse(out));
      if (!url) { console.error(`publish-voices: gcloud signed nothing for ${s.file}`); return 1; }
      urls.set(s.file, url);
    }
    expires = new Date(Date.now() + signSeconds * 1000).toISOString();
    console.log(`signed ${all.length} slide URL(s) · valid until ${expires}`
      + (signSeconds === V4_MAX_SECONDS ? ' (7 days — the V4 maximum)' : ''));
  }

  if (dry) { console.log(`would write ${outPath}`); return 0; }
  const out = signedManifest(manifest, {
    urls, expires, source: dir, bucket: opt('--bucket'),
    signDuration: signSeconds === null ? null : signArg,
  });
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`wrote ${outPath} — deploy it next to the deck`);
  console.log(`  narration: { files: [{ label: '${manifest.voice ?? dirName}', manifest: '${dir}/manifest.signed.json' }] }`);
  return 0;
}

if (isMain(import.meta.url)) process.exit(await publishVoicesMain(process.argv.slice(2)));
