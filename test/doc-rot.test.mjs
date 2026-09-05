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

test('no shipped file still names a key that was retired', () => {
  // ⇧V (the synthesized recorder) and ⇧R (the your-voice recorder) stopped
  // being keys in #421: both live in V's panel as `Record this deck…`. The
  // keymap test keeps the HELP TABLE honest, but a retired key survives just
  // as well in a --help string, an error a tool prints, or a comment the next
  // person reads as fact — thirteen of them did, one of them in the line
  // `decklight record` prints to every user. A key that no longer exists is a
  // command that exits 1, spelled differently.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const shipped = [];
  for (const dir of ['cli', 'tools', 'src/core']) {
    for (const f of fs.readdirSync(path.join(root, dir))) {
      if (/\.(m?js)$/.test(f)) shipped.push(path.join(dir, f));
    }
  }
  shipped.push('README.md', 'SPEC.md', 'site/index.html');
  for (const f of fs.readdirSync(path.join(root, 'docs'))) if (f.endsWith('.md')) shipped.push(path.join('docs', f));
  for (const f of fs.readdirSync(path.join(root, 'demo'))) if (f.endsWith('.html')) shipped.push(path.join('demo', f));
  const hits = [];
  for (const rel of shipped) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    text.split('\n').forEach((line, i) => {
      // history is allowed to name the old key while saying it is old
      if (/⇧[VR]|\\u21e7[VR]/.test(line) && !/\bwas\b|used to|retired|removed|renamed|no longer|before #421/.test(line)) {
        hits.push(`${rel}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(hits, [], 'a shipped file names ⇧V or ⇧R, keys that were retired in #421');
});

test('no doc or deck still tells anyone to run a command that was removed', () => {
  // `decklight edit` was folded into `author` (#182). The public site was still
  // demonstrating it in its terminal cast, and docs/architecture.svg still
  // labelled a box with it — both of which a reader would reasonably copy.
  //
  // This matters MORE now that neither removed command carries a refusal stub:
  // a reader who copies one gets `unknown command`, with no hint of what
  // replaced it. The docs are the only thing left pointing at the new name, so
  // a doc that points at the old one is the whole failure.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = ['README.md', 'SPEC.md', 'site/index.html', 'docs/architecture.svg',
    'cli/skill-content.mjs', 'demo/intro.html', 'demo/showcase.html', 'demo/features.html', 'demo/pitch.html'];
  const hits = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    text.split('\n').forEach((line, i) => {
      // the README names it once, to say it is gone — that mention is the fix,
      // not the rot, so only an INVOCATION counts
      // `decklight rec` joined it: renamed to `cast` because `decklight record`
      // (the author's voice) made a three-letter abbreviation of "record" mean
      // the other recorder, and dropped rather than aliased for exactly that
      // reason — a surviving `rec` would quietly mean the opposite of what a
      // reader assumes. A doc that still teaches either is a doc a reader will
      // copy into a command that exits 1.
      for (const gone of ['edit', 'rec']) {
        const re = new RegExp(`(decklight|npx decklight|decklight@latest)\\s+${gone}\\b`);
        if (re.test(line) && !/refuses|folded|removed|renamed|alias|was\s+/.test(line)) {
          hits.push(`${rel}:${i + 1} (${gone})`);
        }
      }
    });
  }
  assert.deepEqual(hits, [], 'a shipped file invokes a command that was removed and now refuses');
});

test('restoring stays two steps — no path writes the deck without arming first', () => {
  // A SOURCE assertion rather than a behavioural one, and deliberately so: the
  // confirmation is browser-only state in an overlay no headless harness opens,
  // so the regression it guards against — ⏎ or a click restoring on the spot,
  // which is how this worked before — would be completely silent. What can be
  // checked cheaply is that the write is gated, and that nothing calls the
  // writer except the two places allowed to.
  // endsWith, not equality: these paths come from `path.relative`, which
  // answers `core\\editmode.js` on Windows — a `===` against a forward-slash
  // literal passes on two platforms out of three and fails only in CI.
  const [, editmode] = files.find(([f]) => f.endsWith('editmode.js'));
  assert.match(editmode, /if \(!entry \|\| !restoreArmed\) return;/,
    'commitRestore no longer refuses to run unarmed — a mis-aimed ⏎ now writes the deck');
  assert.match(editmode, /restoreArmed \? commitRestore\(\) : armRestore\(\)/,
    '⏎ no longer asks before it restores');
  assert.match(editmode, /restoreArmed \? disarmRestore\(\) : closeRestore\(\)/,
    'Esc no longer cancels the question before it closes the overlay');
  // Every call site of the writer, so a new one cannot appear unnoticed: the
  // keyboard, the confirm button, and its own definition.
  const calls = [...editmode.matchAll(/commitRestore/g)].length;
  assert.equal(calls, 3,
    `commitRestore is referenced ${calls} times, expected 3 — its definition, the`
    + ' armed ⏎, and the confirm button. A new caller must go through armRestore.');
});
