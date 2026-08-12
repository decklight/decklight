// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// tools/publish-voices.mjs — the decisions it makes before gcloud is involved:
// what the duration means, where the files land, which of them actually need
// uploading, and what the manifest that ships with the deck ends up saying.
// The signing itself is gcloud's, so what is left to test here is everything
// that would silently publish a broken track.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { rmTemp } from './helpers.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  V4_MAX_SECONDS, parseDuration, parseBucket, trackPrefix, changedFiles,
  signedManifest, signedUrlFrom, positional,
} from '../tools/publish-voices.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(here, '../tools/publish-voices.mjs');

test('durations are read in the units an author would type', () => {
  assert.equal(parseDuration('7d'), 604800);
  assert.equal(parseDuration('12h'), 43200);
  assert.equal(parseDuration('30m'), 1800);
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('3600'), 3600, 'bare is seconds');
  assert.equal(parseDuration(' 7d '), 604800);
  assert.equal(parseDuration('0'), null, 'a zero-length signature is a typo');
  assert.equal(parseDuration('-1d'), null);
  assert.equal(parseDuration('7 days'), null, 'a shape we do not understand is a message, not a guess');
  assert.equal(parseDuration(undefined), null);
});

test('seven days is the V4 ceiling', () => {
  assert.equal(V4_MAX_SECONDS, 604800);
  assert.equal(parseDuration('7d'), V4_MAX_SECONDS, 'the documented maximum is expressible');
  assert.ok(parseDuration('8d') > V4_MAX_SECONDS, 'and one day more is over it');
});

test('the destination is split into a bucket and a prefix', () => {
  assert.deepEqual(parseBucket('gs://dl-voices/showcase'), { bucket: 'dl-voices', prefix: 'showcase' });
  assert.deepEqual(parseBucket('gs://dl-voices'), { bucket: 'dl-voices', prefix: '' });
  assert.deepEqual(parseBucket('gs://dl-voices/a/b/'), { bucket: 'dl-voices', prefix: 'a/b' });
  assert.equal(parseBucket('https://storage.googleapis.com/x'), null, 'an https URL is not a bucket');
  assert.equal(parseBucket('dl-voices'), null);
});

test('the track keeps its own folder name inside the prefix', () => {
  // so two voices published to one prefix cannot overwrite each other
  assert.equal(trackPrefix({ bucket: 'b', prefix: 'showcase' }, 'algenib'), 'gs://b/showcase/algenib');
  assert.equal(trackPrefix({ bucket: 'b', prefix: '' }, 'algenib'), 'gs://b/algenib');
});

test('only the slides whose audio actually moved are uploaded', () => {
  // the track's manifest already hashes each slide — that is how the
  // pre-render tool skips unchanged audio — so the last published manifest is
  // a record of exactly which bytes are up there already
  const manifest = { slides: [
    { file: 'slide-01.m4a', hash: 'aaa' },
    null,                                    // no notes, no file, nothing to send
    { file: 'slide-03.m4a', hash: 'ccc' },
  ] };
  const previous = { slides: [
    { file: 'slide-01.m4a', hash: 'aaa' },
    null,
    { file: 'slide-03.m4a', hash: 'OLD' },
  ] };
  assert.deepEqual(changedFiles(manifest, previous).map((s) => s.file), ['slide-03.m4a']);
  // a first publish has no record, so everything goes
  assert.equal(changedFiles(manifest, null).length, 2);
  // and --all is the escape hatch when the bucket and the record disagree
  assert.equal(changedFiles(manifest, previous, { all: true }).length, 2);
});

test('the shipped manifest carries a url per slide and how to renew them', () => {
  const manifest = {
    engine: 'gemini', voice: 'Algenib',
    slides: [{ file: 'slide-01.m4a', hash: 'a' }, null, { file: 'slide-03.m4a', hash: 'c' }],
  };
  const urls = new Map([['slide-01.m4a', 'https://x/1?sig=A'], ['slide-03.m4a', 'https://x/3?sig=C']]);
  const out = signedManifest(manifest, {
    urls, expires: '2026-07-24T09:00:00Z',
    source: 'voices/algenib', bucket: 'gs://dl-voices/showcase', signDuration: '7d',
  });

  assert.equal(out.engine, 'gemini', 'the source manifest survives intact');
  assert.equal(out.slides[0].url, 'https://x/1?sig=A');
  assert.equal(out.slides[0].hash, 'a', 'and so does the hash the next publish compares against');
  assert.equal(out.slides[1], null, 'a silent slide stays silent');
  assert.equal(out.expires, '2026-07-24T09:00:00Z');
  // these three are what lets a lapsed deck print its own fix instead of a shape
  assert.equal(out.source, 'voices/algenib');
  assert.equal(out.bucket, 'gs://dl-voices/showcase');
  assert.equal(out.signDuration, '7d');
});

test('an unsigned publish writes no expiry at all', () => {
  // a public bucket has nothing to renew, and a manifest claiming an expiry it
  // does not have would stop a deck that was working fine
  const out = signedManifest({ slides: [{ file: 'a.m4a' }] }, {
    urls: new Map([['a.m4a', 'https://storage.googleapis.com/b/a.m4a']]),
    expires: null, source: 'v', bucket: 'gs://b', signDuration: null,
  });
  assert.equal('expires' in out, false);
  assert.equal('signDuration' in out, false);
});

test('gcloud has spelled the signed URL more than one way — read all of them', () => {
  assert.equal(signedUrlFrom({ signed_url: 'https://a' }), 'https://a');
  assert.equal(signedUrlFrom([{ signed_url: 'https://b' }]), 'https://b', 'some versions answer with a list');
  assert.equal(signedUrlFrom({ signedUrl: 'https://c' }), 'https://c');
  assert.equal(signedUrlFrom({ nothing: true }), null, 'and an answer we cannot read is not a URL');
});

test('--sign 7d is a duration, not a directory called 7d', () => {
  assert.deepEqual(positional(['voices/algenib', '--bucket', 'gs://b/p', '--sign', '7d']), ['voices/algenib']);
  assert.deepEqual(positional(['--sign', '7d', 'voices/x', '--dry-run']), ['voices/x']);
  assert.deepEqual(positional(['--bucket', 'gs://b']), []);
});

test('the tool refuses a signature longer than V4 allows, and says whose rule it is', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-pv-'));
  try {
    writeFileSync(path.join(dir, 'manifest.json'),
      JSON.stringify({ engine: 'gemini', voice: 'Algenib', slides: [{ file: 'slide-01.m4a', hash: 'a' }] }));

    const over = spawnSync('node', [TOOL, dir, '--bucket', 'gs://b/p', '--sign', '8d'], { encoding: 'utf8' });
    assert.equal(over.status, 1);
    assert.match(over.stderr, /longer than 7d/);
    assert.match(over.stderr, /V4 signatures cannot outlive seven days/);
    assert.match(over.stderr, /public bucket/, 'and it names the way to host audio that must outlive a week');

    const bad = spawnSync('node', [TOOL, dir, '--bucket', 'not-a-bucket', '--sign', '7d'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /must be a gs:\/\/ URL/);

    const noDir = spawnSync('node', [TOOL, '--bucket', 'gs://b/p'], { encoding: 'utf8' });
    assert.equal(noDir.status, 1);
    assert.match(noDir.stderr, /needs a voice directory/);

    const noManifest = spawnSync('node', [TOOL, path.join(dir, 'nope'), '--bucket', 'gs://b/p'], { encoding: 'utf8' });
    assert.equal(noManifest.status, 1);
    assert.match(noManifest.stderr, /manifest\.json not found/);
    assert.match(noManifest.stderr, /voiceover\.mjs/, 'and it names the tool that makes one');
  } finally {
    rmTemp(dir);
  }
});

test('--dry-run reaches gcloud for nothing and writes nothing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'decklight-pv-'));
  try {
    writeFileSync(path.join(dir, 'manifest.json'),
      JSON.stringify({ engine: 'gemini', voice: 'Algenib', slides: [{ file: 'slide-01.m4a', hash: 'a' }] }));
    writeFileSync(path.join(dir, 'slide-01.m4a'), 'not really audio');

    // PATH is emptied so any attempt to actually run gcloud fails loudly.
    // process.execPath, not 'node' — with no PATH there is no node to find either.
    const dry = spawnSync(process.execPath, [TOOL, dir, '--bucket', 'gs://b/p', '--sign', '7d', '--dry-run'],
      { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /would upload 1 changed file/);
    assert.match(dry.stdout, /would sign 1 slide URL\(s\) for 7d/);
    assert.match(dry.stdout, /would write .*manifest\.signed\.json/);

    const wrote = spawnSync('node', ['-e', `process.exit(require('fs').existsSync(${JSON.stringify(path.join(dir, 'manifest.signed.json'))}) ? 1 : 0)`]);
    assert.equal(wrote.status, 0, 'a dry run leaves no manifest behind');
  } finally {
    rmTemp(dir);
  }
});

test('the help is reachable and names what it needs', () => {
  const help = execFileSync('node', [TOOL, '--help'], { encoding: 'utf8' });
  assert.match(help, /usage: node tools\/publish-voices\.mjs/);
  assert.match(help, /--bucket/);
  assert.match(help, /max 7d/);
  assert.match(help, /needs gcloud on PATH/);
});
