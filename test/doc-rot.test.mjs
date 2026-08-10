// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Comment rot (#238) — the version-drift pattern from cli.test.mjs applied to
// pointers in comments: a pointer nobody checks is read as a fact, which is
// what makes a stale one worse than none. Each sweep here caught a real
// leftover — charts.js citing `initMarkdown` long after the markdown removal,
// the subtitle notes still offering two authoring surfaces, speaker.js sending
// a reader to `/edit/ping` for a QR the author server refuses to serve — and
// failing in one line under `npm test` beats a reader discovering the drift
// wherever the pointer eventually misleads them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files.push([path.relative(srcDir, p), fs.readFileSync(p, 'utf8')]);
  }
})(srcDir);

test('every init* pipeline function src mentions is defined somewhere in src', () => {
  // Comments narrate the init pipeline by function name (charts.js places
  // itself relative to its neighbours), so a rename or removal that misses a
  // mention leaves a pointer to a function that no longer exists.
  const defined = new Set();
  for (const [, text] of files)
    for (const m of text.matchAll(/\bfunction (init[A-Z]\w*)/g)) defined.add(m[1]);
  const stale = [];
  for (const [file, text] of files)
    for (const m of text.matchAll(/\binit[A-Z]\w*\b/g))
      if (!defined.has(m[0])) stale.push(`${file}: ${m[0]}`);
  assert.deepEqual(stale, [],
    'a src file cites an init* function that is defined nowhere in src — fix the pointer');
});

test('no src file still describes slides as markdown-or-HTML authored', () => {
  // Markdown slides were removed in 0.3.0 (SPEC DECK_ANATOMY): HTML is the one
  // authoring surface, and a comment still offering both keeps the removed one
  // alive for whoever reads it. reportMarkdownSlides may talk ABOUT the
  // removal; nothing may present markdown as a live alternative.
  const stale = files
    .filter(([, text]) => /markdown-? ?or ?-?HTML|HTML-? ?or ?-?markdown/i.test(text))
    .map(([file]) => file);
  assert.deepEqual(stale, []);
});

test('speaker.js does not attribute the phone-remote QR to /edit/ping', () => {
  // PRESENT#REMOTE moved the clicker to `decklight present`: the QR is set
  // from /present/ping, and the author server deliberately serves no /remote/*
  // at all — a comment pointing at /edit/ping sends a reader to the one server
  // that refuses to offer one.
  const [, speaker] = files.find(([file]) => file === path.join('core', 'speaker.js'));
  assert.ok(!speaker.includes('/edit/ping'),
    'speaker.js points at /edit/ping — the QR comes from /present/ping (PRESENT#REMOTE)');
});

test('no cli or tools comment still describes EXTENSIONS#ADAPTEREXEC as pending', () => {
  // UNITS#REST closed with the adapter half landed: an installed import
  // adapter RUNS (cli/loader.mjs runImporter, SPEC EXTENSIONS_ADAPTERS), and
  // the calling convention that work was said to wait on is frozen, with its
  // own IMPORTER_API_VERSION. A comment still saying "not built" or "once the
  // contract is frozen" re-opens a settled question for whoever reads it —
  // the same drift the sweeps above catch in src/, here for the CLI side,
  // where the marketplace subsystem actually lives.
  const stale = [];
  for (const d of ['cli', 'tools']) {
    const dir = path.resolve(srcDir, '..', d);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      if (/ADAPTEREXEC[^)\n]*not built/.test(text)) stale.push(`${d}/${name}: "not built"`);
      if (/installed adapter does not execute/.test(text)) stale.push(`${d}/${name}: "does not execute"`);
      if (/once [^\n]*(?:calling convention is frozen|have their own contract|freezes that contract)/.test(text)) {
        stale.push(`${d}/${name}: "once … frozen"`);
      }
    }
  }
  assert.deepEqual(stale, [],
    'a comment still describes EXTENSIONS#ADAPTEREXEC as unbuilt or its contract as unfrozen — both landed (SPEC EXTENSIONS_ADAPTERS)');
});

test('no doc or deck claims a theme count the repo does not have', () => {
  // The theme count is the single most-repeated fact in this project — README,
  // the site, four decks, and the AGENT SKILL's indexed description, which is
  // the string agents match on and is baked into every installed copy. It has
  // now gone stale twice: #162 fixed 61 → 62 in that description, and #216
  // moved the homage packs to the marketplace and made it 46 everywhere except
  // where nobody looked. A showcase quiz was still grading the audience
  // against "62 themes in 5 packs".
  //
  // So it is checked rather than remembered. Any "<n> themes" in a shipped
  // doc, deck or the skill must be the number of themes actually in themes/,
  // and any pack count the number of packs in packs.json.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const themes = fs.readdirSync(path.join(root, 'themes')).filter((f) => f.endsWith('.css')).length;
  const packs = Object.keys(JSON.parse(
    fs.readFileSync(path.join(root, 'themes/packs.json'), 'utf8')).packs).length;

  // CHANGELOG.md is exempt: its older entries describe what WAS true at 0.2.0,
  // which is the one place a superseded number is the correct one.
  const files = ['README.md', 'SPEC.md', 'site/index.html', 'cli/skill-content.mjs',
    'demo/intro.html', 'demo/showcase.html', 'demo/features.html', 'demo/pitch.html'];

  const wrong = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    text.split('\n').forEach((line, i) => {
      // a quiz's WRONG answers are deliberately wrong numbers — skip the rows
      // that are not the marked one (they carry value="n" with n != answer)
      if (/<label><input type="radio"/.test(line) && !/value="2"/.test(line)) return;
      for (const m of line.matchAll(/(\d+)\s+(?:built-in\s+|shipped\s+)?themes\b/g)) {
        if (Number(m[1]) !== themes) wrong.push(`${rel}:${i + 1} says ${m[1]} themes (${themes})`);
      }
      for (const m of line.matchAll(/(\d+)\s+packs\b/g)) {
        if (Number(m[1]) !== packs) wrong.push(`${rel}:${i + 1} says ${m[1]} packs (${packs})`);
      }
    });
  }
  assert.deepEqual(wrong, [], 'a shipped file states a theme/pack count the repo does not have');
});

test('no doc or deck still tells anyone to run a command that was removed', () => {
  // `decklight edit` was folded into `author` (#182) and now refuses out loud.
  // The public site was still demonstrating it in its terminal cast, and
  // docs/architecture.svg still labelled a box with it — both of which a
  // reader would reasonably copy.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = ['README.md', 'SPEC.md', 'site/index.html', 'docs/architecture.svg',
    'cli/skill-content.mjs', 'demo/intro.html', 'demo/showcase.html', 'demo/features.html', 'demo/pitch.html'];
  const hits = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    text.split('\n').forEach((line, i) => {
      // the README names it once, to say it is gone — that mention is the fix,
      // not the rot, so only an INVOCATION counts
      if (/(decklight|npx decklight)\s+edit\b/.test(line) && !/refuses|folded|removed|was\s+/.test(line)) {
        hits.push(`${rel}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(hits, [], 'a shipped file invokes `decklight edit`, which refuses');
});
