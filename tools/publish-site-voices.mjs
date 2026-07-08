#!/usr/bin/env node
// Sync the locally generated voice tracks (demo/voiceover-site/<dir>/) to the
// decklight.github.io repo under voices/<dir>/, in ONE commit via the Git
// Data API. Only files whose git blob sha differs from the remote are
// uploaded, so a regen that skipped unchanged slides uploads nothing for
// them either. Audio lives ONLY in the site repo; this repo keeps the
// staging dir gitignored.
//
//   node tools/publish-site-voices.mjs [--repo decklight/decklight.github.io]
//
// Requires gh (authenticated) on PATH.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
const REPO = opt('--repo', 'decklight/decklight.github.io');
const STAGING = 'demo/voiceover-site';

const gh = (argv, input) =>
  JSON.parse(execFileSync('gh', ['api', ...argv], { encoding: 'utf8', input, maxBuffer: 1 << 28 }));

// git blob sha1: sha1("blob <len>\0" + content)
const blobSha = (buf) =>
  createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

const { voices } = JSON.parse(readFileSync('site/voices.json', 'utf8'));

const head = gh([`repos/${REPO}/git/ref/heads/main`]).object.sha;
const baseTree = gh([`repos/${REPO}/git/commits/${head}`]).tree.sha;
const remote = new Map(
  gh([`repos/${REPO}/git/trees/${baseTree}?recursive=1`]).tree
    .filter((e) => e.type === 'blob')
    .map((e) => [e.path, e.sha]),
);

const changed = [];
for (const v of voices) {
  const local = join(STAGING, v.dir.split('/').pop());
  if (!existsSync(local)) { console.warn(`skip ${v.voice}: ${local} missing (not generated yet)`); continue; }
  for (const f of readdirSync(local).sort()) {
    if (!/\.(m4a|json)$/.test(f)) continue; // .txt is a regen artifact, stays local
    const buf = readFileSync(join(local, f));
    const path = `${v.dir}/${f}`;
    if (remote.get(path) !== blobSha(buf)) changed.push({ path, buf });
  }
}

if (!changed.length) {
  console.log('site voices are up to date, nothing to upload');
  process.exit(0);
}

console.log(`uploading ${changed.length} changed file(s):`);
const tree = [];
for (const { path, buf } of changed) {
  const { sha } = gh([`repos/${REPO}/git/blobs`, '-f', `content=${buf.toString('base64')}`, '-f', 'encoding=base64']);
  tree.push({ path, mode: '100644', type: 'blob', sha });
  console.log(`  ${path}`);
}
const newTree = gh([`repos/${REPO}/git/trees`, '--input', '-'], JSON.stringify({ base_tree: baseTree, tree }));
const commit = gh([`repos/${REPO}/git/commits`, '--input', '-'], JSON.stringify({
  message: `voices: sync ${changed.length} file(s) from demo/voiceover-site`,
  tree: newTree.sha,
  parents: [head],
}));
gh([`repos/${REPO}/git/refs/heads/main`, '-X', 'PATCH', '-f', `sha=${commit.sha}`]);
console.log(`done → ${REPO}@${commit.sha.slice(0, 7)}`);
