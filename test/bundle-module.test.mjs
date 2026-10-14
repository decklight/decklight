// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `bundle --module` bundles one chapter of a deck: the sections from its
// data-module marker up to the next one. Its narration comes along renumbered,
// because a track's files are named by slide number and the chapter's slides
// are numbered from 1 again in the bundle: slide-04 of the deck is slide-01 of
// the file, and the runtime asks for slide-01.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmp as scratch } from './helpers.mjs';
import { deckModules, pickModule, renumber, sliceManifest } from '../cli/bundle-module.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'cli/decklight.mjs');

const SLIDES = '<section><h1>Title</h1></section>'
  + '<section data-module="Basics"><h2>B1</h2></section><section><h2>B2</h2><svg><g><text>x</text></g></svg></section>'
  + '<section data-module="Going &quot;further&quot;"><h2>F1</h2></section><section data-hidden><h2>F2</h2></section>';

/** A deck-as-data in three parts: an unmarked title slide, then two chapters of two slides. */
function deck(t, config = { narration: { files: [{ label: 'Me', dir: 'voices' }, { label: 'Cloud', manifest: 'cloud/manifest.json' }] } }) {
  const dir = scratch('bundle-module', t);
  mkdirSync(path.join(dir, 'voices'));
  for (const f of ['slide-01.m4a', 'slide-02.m4a', 'slide-03-01.wav', 'slide-04.m4a', 'slide-05-01.wav', 'slide-05-02.wav']) {
    writeFileSync(path.join(dir, 'voices', f), f);
  }
  writeFileSync(path.join(dir, 'voices', 'slide-02.visemes.json'), '{"for":2}');
  writeFileSync(path.join(dir, 'voices', 'slide-05-02.visemes.json'), '{"for":"5-2"}');
  mkdirSync(path.join(dir, 'cloud'));
  for (const f of ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3', 'e.mp3']) writeFileSync(path.join(dir, 'cloud', f), f);
  writeFileSync(path.join(dir, 'cloud', 'manifest.json'), JSON.stringify({ slides: ['a', 'b', 'c', 'd', 'e'].map((x) => ({ file: `${x}.mp3` })) }));
  const file = path.join(dir, 'talk.html');
  writeFileSync(file, `<!doctype html><html><head><title>Talk</title></head><body><div class="decklight">${SLIDES}</div>`
    + `<script type="application/json" data-decklight-config>${JSON.stringify(config)}</script></body></html>`);
  return { dir, file };
}

const run = (...args) => spawnSync(process.execPath, [CLI, 'bundle', ...args], { encoding: 'utf8' });
const audioKeys = (html) => [...html.matchAll(/data-decklight-audio="([^"]+)"/g)].map((m) => m[1]).sort();
const headings = (html) => [...html.matchAll(/<h[12]>([^<]*)<\/h[12]>/g)].map((m) => m[1]);

test('the chapters are the sections from one data-module marker to the next', () => {
  const html = `<div class="decklight">${SLIDES}</div>`;
  const bounds = { contentStart: html.indexOf('>') + 1, contentEnd: html.lastIndexOf('</div>') };
  const { modules, spans } = deckModules(html, bounds);
  assert.equal(spans.length, 5, 'a section with an svg inside is still one section');
  assert.deepEqual(modules, [
    { n: 1, title: 'Basics', offset: 1, count: 2 },
    { n: 2, title: 'Going "further"', offset: 3, count: 2 },
  ], 'the title slide before the first marker belongs to no chapter');
  assert.equal(pickModule(modules, '2').title, 'Going "further"', 'by number');
  assert.equal(pickModule(modules, '  basics ').n, 1, 'by title, case and space ignored');
  assert.throws(() => pickModule(modules, 'Advanced'), /no chapter "Advanced" in this deck — its chapters are:\n {4}1 {2}Basics \(2 slides\)/);
  assert.throws(() => pickModule([], 'x'), /this deck has no chapters — a chapter starts at a <section data-module/);
});

test('a track file moves down by the chapter offset, and one outside it is left out', () => {
  const mod = { offset: 3, count: 2 };
  assert.equal(renumber('slide-04.m4a', mod), 'slide-01.m4a');
  assert.equal(renumber('voices/slide-05-02.wav', mod), 'voices/slide-02-02.wav');
  assert.equal(renumber('slide-05-02', mod), 'slide-02-02', 'a viseme stem');
  assert.equal(renumber('slide-03.m4a', mod), null, 'before the chapter');
  assert.equal(renumber('slide-06.m4a', mod), null, 'after it');
  assert.equal(renumber('slide-104.m4a', { offset: 100, count: 9 }), 'slide-004.m4a', 'keeps the width it was written with');
  assert.equal(renumber('slide-04.m4a', null), 'slide-04.m4a', 'no chapter, no change');
  assert.deepEqual(sliceManifest({ v: 1, slides: [1, 2, 3, 4, 5] }, mod), { v: 1, slides: [4, 5] });
});

test('bundle --module keeps only the chapter, renumbers its narration and carries it with --audio', (t) => {
  const { dir, file } = deck(t);
  const r = run(file, '--module', 'going "further"', '--audio');
  assert.equal(r.status, 0, r.stderr);
  const out = path.join(dir, 'talk-going-further.html');
  assert.ok(existsSync(out), 'named after the chapter by default');
  const html = readFileSync(out, 'utf8');
  assert.deepEqual(headings(html).filter((h) => /^[TBF]/.test(h)), ['F1', 'F2'], 'the chapter\'s slides and nothing else, hidden ones included');
  assert.match(html, /<title>Talk · Going &quot;further&quot;<\/title>/, 'the chapter names the file, escaped');
  assert.deepEqual(audioKeys(html), ['cloud/d.mp3', 'cloud/e.mp3', 'voices/slide-01.m4a', 'voices/slide-02-01.wav', 'voices/slide-02-02.wav'],
    'slide 4 of the deck is slide 1 of the bundle; slides 1–3 are not in it');
  const one = html.match(/data-decklight-audio="voices\/slide-01\.m4a">([^<]*)</)[1];
  assert.equal(JSON.parse(one), `data:audio/mp4;base64,${Buffer.from('slide-04.m4a').toString('base64')}`, 'the same bytes, under the new number');
  assert.match(html, /data-decklight-visemes="slide-02-02">\s*\{"for":"5-2"\}/, 'the beat\'s viseme timeline, renumbered');
  assert.doesNotMatch(html, /data-decklight-visemes="slide-02">/, 'a timeline outside the chapter is left out');
  const manifest = JSON.parse(html.match(/data-decklight-voices="cloud\/manifest\.json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(manifest.slides.map((e) => e.file), ['d.mp3', 'e.mp3'], 'the manifest cut to the chapter');
  assert.match(r.stdout, /module 2 of 2: Going "further" — slides 4–5 of the deck, 1–2 in the bundle/);
});

test('bundle --module by number, and the files stay beside it without --audio', (t) => {
  const { dir, file } = deck(t);
  const out = path.join(dir, 'basics.html');
  const r = run(file, '--module', '1', '-o', out);
  assert.equal(r.status, 0, r.stderr);
  const html = readFileSync(out, 'utf8');
  assert.deepEqual(headings(html).filter((h) => /^[TBF]/.test(h)), ['B1', 'B2']);
  assert.deepEqual(audioKeys(html), []);
  assert.match(r.stdout, /narration audio: 4 file\(s\) stay beside the deck, in voices\/ \(2\), cloud\/ \(2\)/,
    'the count is the chapter\'s, not the deck\'s');
});

test('bundle --module refuses what it cannot bundle, and says why', (t) => {
  const { dir, file } = deck(t);
  let r = run(file, '--module', 'Advanced');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no chapter "Advanced" in this deck — its chapters are:[\s\S]*1 {2}Basics \(2 slides\)[\s\S]*2 {2}Going "further" \(2 slides\)/);
  r = run(file, '--module');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--module takes a chapter: its title, or its number/);
  r = run(file, file, '--module', '1');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--module takes a single deck/);

  const flat = path.join(dir, 'flat.html');
  writeFileSync(flat, '<!doctype html><html><head></head><body><div class="decklight"><section><h2>One</h2></section></div>'
    + '<script type="application/json" data-decklight-config>{}</script></body></html>');
  r = run(flat, '--module', '1');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /this deck has no chapters/);
});

test('bundle --all --module points at the playlist module\'s own file', (t) => {
  const { dir } = deck(t);
  const list = path.join(dir, 'course.html');
  writeFileSync(list, '<!doctype html><html><head></head><body><div class="decklight"><section><h2>Intro</h2></section></div>'
    + "<script>const PLAYLIST = { modules: [{ title: 'Intro', href: 'course.html' }, { title: 'Deep dive', href: 'talk.html' }] };</script></body></html>");
  const r = run(list, '--all', '--module', 'deep dive');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /a playlist module is a file of its own — bundle it as one:\n {2}decklight bundle .*talk\.html/);
});
