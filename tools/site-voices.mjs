#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The showcase's voice tracks for decklight.io: kept as ONE release asset on
// this repository, not as files in it, and re-voiced only where the notes
// changed.
//
//   node tools/site-voices.mjs pull      the asset → site/voices/ (the baseline)
//   node tools/site-voices.mjs refresh   voice every slide whose notes moved, per voice
//   node tools/site-voices.mjs check     every clip matches its notes, or say which do not
//   node tools/site-voices.mjs push      site/voices/ → the asset, when anything changed
//
// The site deploy runs these in that order (.github/workflows/publish-site.yml).
// `site/voices.json` names the release, the asset, the engine, the style and
// the voices; the audio itself never enters git history: a deploy pulls the
// last asset, tools/voiceover.mjs re-synthesizes only the slides whose
// manifest hash no longer matches the deck (and the shared clip cache under
// ~/.cache/decklight/tts, restored between runs, makes a slide that merely
// moved a cache hit), and the asset is uploaded back only if a byte changed.
// `check` is the gate: a deploy that cannot bring every clip in line with its
// notes fails here, before Pages, instead of publishing a deck that narrates
// one slide over another (what the site did for weeks, #803).
//
// The release's tag points at the repository's ROOT commit, never at main's
// tip: `git describe --tags` (the version string) would otherwise find it
// nearest. Both describe calls also match `v*` only, so this stays true even
// if the tag moves.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { argReader, isMain } from './args.mjs';
import { run, NETWORK_MS } from './exec.mjs';
import { slideTexts, staleSlides } from './narration-manifest.mjs';

const VOICEOVER = fileURLToPath(new URL('./voiceover.mjs', import.meta.url));
const PULLED = '.pulled';   // the digest of what `pull` extracted; `push` skips an upload that would change nothing

export const USAGE = `usage: node tools/site-voices.mjs <pull | refresh | check | push> [--deck demo/showcase.html]
                                 [--config site/voices.json] [--dir site/voices]

  pull     download the voices release asset and extract it into --dir
  refresh  re-voice, per voice, the slides whose notes changed (needs GOOGLE_CLOUD_PROJECT
           and gcloud application-default credentials; tools/voiceover.mjs does the work)
  check    exit 1 naming every slide whose clip is stale or missing, per voice
  push     pack --dir into the asset and upload it, when it differs from what was pulled

  pull and push need gh on PATH, authenticated for this repository`;

/** `site/voices.json`: the release, the asset, the engine, the style and the voices. */
export function loadConfig(file = 'site/voices.json') {
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  for (const key of ['release', 'asset', 'engine', 'style', 'voices']) {
    if (!cfg[key]) throw new Error(`${file}: no "${key}"`);
  }
  return cfg;
}

/** A voice's folder under the root: `voices/algenib` in the config is `<root>/algenib` on disk. */
export const voiceDir = (root, voice) => join(root, basename(voice.dir));

/**
 * The argv that voices one track: tools/voiceover.mjs, which is incremental
 * by manifest hash and shares the clip cache with every other producer of a
 * track. Engine, voice and style are given every time, so a track that does
 * not exist yet is made in the same voice the others speak in.
 */
export function refreshArgv(deck, cfg, voice, outDir) {
  return [VOICEOVER, deck, '--engine', cfg.engine, '--voice', voice.voice, '--style', cfg.style, '-o', outDir];
}

/** What travels in the asset: audio, manifests and the per-slide scripts; never temp files or the digest. */
export function packList(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const dir of readdirSync(root).sort()) {
    const abs = join(root, dir);
    if (!statSync(abs).isDirectory()) continue;
    for (const f of readdirSync(abs).sort()) {
      if (!/\.(m4a|mp3|wav|json|txt)$/.test(f) || f.includes('.tmp.')) continue;
      out.push(`${dir}/${f}`);
    }
  }
  return out;
}

/** One hash over every packed file's path and bytes: equal digests, nothing to upload. */
export function contentDigest(root) {
  const h = createHash('sha256');
  for (const rel of packList(root)) {
    h.update(rel).update('\0').update(readFileSync(join(root, rel))).update('\0');
  }
  return h.digest('hex');
}

/**
 * Per voice: the slides whose clip no longer matches the deck's notes
 * (`stale`), the slides with notes that have no clip (`missing`), and whether
 * the track exists at all (`absent`). Pure over the deck's HTML and the
 * manifests, so a test can hand it both.
 */
export function checkTracks(html, root, cfg) {
  const texts = slideTexts(html);
  const withNotes = texts.map((t, i) => (t ? i + 1 : 0)).filter(Boolean);
  return cfg.voices.map((voice) => {
    const file = join(voiceDir(root, voice), 'manifest.json');
    if (!existsSync(file)) return { voice: voice.voice, absent: true, stale: [], missing: withNotes };
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const { stale } = staleSlides(manifest, texts);
    const missing = withNotes.filter((n) => !manifest.slides?.[n - 1] && !stale.includes(n));
    return { voice: voice.voice, absent: false, stale, missing };
  });
}

const gh = (args, opts = {}) => run('gh', args, { encoding: 'utf8', timeout: NETWORK_MS, why: 'gh is waiting on the network or a login: run gh auth status', ...opts });

function pull({ cfg, root }) {
  const tmp = mkdtempSync(join(tmpdir(), 'decklight-site-voices-'));
  const tar = join(tmp, cfg.asset);
  try {
    gh(['release', 'download', cfg.release, '--pattern', cfg.asset, '--output', tar, '--clobber'], { stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (e) {
    console.error(`site-voices: no ${cfg.asset} on release ${cfg.release}: a machine that has the tracks runs \`push\` first`);
    rmSync(tmp, { recursive: true, force: true });
    return 1;
  }
  mkdirSync(root, { recursive: true });
  run('tar', ['-xzf', tar, '-C', root], { stdio: 'inherit' });
  rmSync(tmp, { recursive: true, force: true });
  const digest = contentDigest(root);
  writeFileSync(join(root, PULLED), digest);
  console.log(`pulled ${cfg.asset} → ${root} (${packList(root).length} files, ${digest.slice(0, 12)})`);
  return 0;
}

function refresh({ cfg, root, deck }) {
  for (const voice of cfg.voices) {
    const out = voiceDir(root, voice);
    console.log(`\n== ${voice.voice} → ${out}`);
    const r = spawnSync(process.execPath, refreshArgv(deck, cfg, voice, out), { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`site-voices: voicing ${voice.voice} failed (exit ${r.status ?? r.signal})`);
      return r.status ?? 1;
    }
  }
  return 0;
}

function check({ cfg, root, deck }) {
  const html = readFileSync(deck, 'utf8');
  let bad = 0;
  for (const r of checkTracks(html, root, cfg)) {
    if (r.absent) { bad++; console.error(`${r.voice}: no track at all (${r.missing.length} slides with notes)`); continue; }
    if (!r.stale.length && !r.missing.length) { console.log(`${r.voice}: every clip matches its notes`); continue; }
    bad++;
    const parts = [];
    if (r.stale.length) parts.push(`stale: ${r.stale.join(', ')}`);
    if (r.missing.length) parts.push(`missing: ${r.missing.join(', ')}`);
    console.error(`${r.voice}: ${parts.join(' · ')}`);
  }
  if (bad) console.error(`\nsite-voices: ${bad} track(s) do not match ${deck}: run \`refresh\` (GOOGLE_CLOUD_PROJECT set), then \`push\``);
  return bad ? 1 : 0;
}

/** The repository's first commit: a tag there is never the nearest one `git describe` sees. */
function rootCommit() {
  return run('git', ['rev-list', '--max-parents=0', 'HEAD'], { encoding: 'utf8' }).trim().split('\n').pop();
}

function push({ cfg, root }) {
  const files = packList(root);
  if (!files.length) { console.error(`site-voices: nothing under ${root} to push`); return 1; }
  const digest = contentDigest(root);
  const pulled = existsSync(join(root, PULLED)) ? readFileSync(join(root, PULLED), 'utf8').trim() : null;
  if (pulled === digest) { console.log(`site-voices: ${root} is what was pulled (${digest.slice(0, 12)}), nothing to upload`); return 0; }
  const tmp = mkdtempSync(join(tmpdir(), 'decklight-site-voices-'));
  const tar = join(tmp, cfg.asset);
  run('tar', ['-czf', tar, '-C', root, ...files], { stdio: 'inherit' });
  let exists = true;
  try { gh(['release', 'view', cfg.release], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { exists = false; }
  if (!exists) {
    gh(['release', 'create', cfg.release, '--prerelease', '--target', rootCommit(),
      '--title', 'Site voices (deploy asset, not a release of decklight)',
      '--notes', `The showcase deck's narration for decklight.io, as one ${cfg.asset}. The site deploy pulls it, re-voices the slides whose notes changed, and pushes it back (tools/site-voices.mjs). Not a version of decklight: the versions are the v* tags.`],
    { stdio: 'inherit' });
  }
  gh(['release', 'upload', cfg.release, tar, '--clobber'], { stdio: 'inherit' });
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(join(root, PULLED), digest);
  console.log(`pushed ${files.length} files as ${cfg.asset} on release ${cfg.release} (${digest.slice(0, 12)})`);
  return 0;
}

export async function siteVoicesMain(argv = process.argv.slice(2)) {
  const cmd = argv.find((a) => !a.startsWith('-'));
  if (!cmd || argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return cmd ? 0 : 1; }
  const { opt } = argReader(argv);
  const cfg = loadConfig(opt('--config', 'site/voices.json'));
  const ctx = { cfg, root: resolve(opt('--dir', cfg.dir ?? 'site/voices')), deck: opt('--deck', cfg.deck ?? 'demo/showcase.html') };
  const commands = { pull, refresh, check, push };
  if (!commands[cmd]) { console.error(`site-voices: "${cmd}" is not a command\n\n${USAGE}`); return 2; }
  return commands[cmd](ctx);
}

if (isMain(import.meta.url)) process.exitCode = await siteVoicesMain();
