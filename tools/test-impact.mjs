#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `npm run test:impact` — which tests does THIS change actually need?
 *
 * The suites are not the same shape, and the honest answer differs per suite.
 * Measured on a laptop (2026-08-27, 85 unit files / 19 harnesses):
 *
 *   unit    `npm test`        ~48s wall — 319s of work, run in parallel by node
 *   render  `npm run verify`  ~200s wall — strictly serial, one browser at a time
 *
 * So this script does NOT try to pick unit tests. 38 of the 85 files finish
 * under 0.3s and node already overlaps them 6.6×; selecting a subset would save
 * seconds and risk missing the one file that mattered. The unit suite is cheap
 * enough to always be right, and being right is what a test picker is for.
 *
 * The render harnesses are the opposite: serial, minutes long, and each one
 * pinned to a subsystem you can name. `narration-render` alone is 65s — a third
 * of the suite — and a change to `cli/pdf.mjs` has no business waiting for it.
 * That is the decision worth automating, so that is the only one made here.
 *
 * THE FALLBACK IS THE WHOLE SUITE. A path this map does not recognise selects
 * everything, loudly, and says why. A test picker that guesses "probably
 * nothing" on an unfamiliar path is worse than no picker: it turns an unrun
 * suite into a green line. Same rule as the ingredients label — unchecked is
 * its own answer and never a pass.
 *
 * This is a DEVELOPER shortcut for the edit-run loop, not a CI gate. CI keeps
 * running everything, because the map is a claim about the code and the map can
 * be wrong; the full suite is what notices.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './args.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

/** Every harness `verify` knows, in its running order. */
export const ALL = [
  'render', 'player-render', 'narration-render', 'record-render', 'review-render',
  'character-render', 'engine-render', 'pin-render', 'overflow-render', 'split-render',
  'strict-render', 'shot-render', 'plugin-render', 'extension-check-render',
  'deckfile-render', 'pdf-render', 'import-render', 'contrast', 'palette-rules',
];

/**
 * The two lint harnesses read `themes/` and `tools/`, never the built runtime —
 * so a change to `src/` does not implicate them, and a change to a theme does.
 * Kept as a named set because "every harness except the ones that never open a
 * browser" is the distinction the rules below keep needing.
 */
const LINT = ['contrast', 'palette-rules'];
const BROWSER = ALL.filter((h) => !LINT.includes(h));

/**
 * changed path → the harnesses that could see it.
 *
 * Ordered, first match wins, so the broad "this is core" rules sit at the top.
 * Every entry carries WHY, because the cost of this file being subtly wrong is
 * a harness that stops running and nobody noticing for a month.
 */
const RULES = [
  // ── everything the built bundle rests on ────────────────────────────────
  // Each browser harness loads dist/decklight.js, so these reach all of them.
  [/^src\/core\/engine\.js$/, BROWSER, 'the engine every harness boots'],
  [/^src\/core\/overlay\.js$/, BROWSER, 'the overlay contract every dialog registers through'],
  [/^src\/index\.js$/, BROWSER, 'the bundle entry'],
  [/^src\/decklight\.css$/, BROWSER, 'one stylesheet, every rendered deck'],
  [/^build\.mjs$/, ALL, 'the build that produces what the harnesses load'],
  [/^test\/harness\.mjs$/, ALL, 'the shared dump/assert helper'],
  [/^package\.json$/, ALL, 'scripts, deps and packed files'],

  // ── subsystems, each with a harness that is about it ────────────────────
  [/^src\/core\/narration\.js$/, ['narration-render', 'record-render', 'character-render'],
    'narration drives playback, the recorder and the character overlay'],
  [/^src\/core\/character\.js$/, ['character-render', 'narration-render'], 'the talking head'],
  [/^src\/core\/character-art\.js$/, ['character-render'], 'the head it draws'],
  [/^src\/core\/review\.js$/, ['review-render'], 'the review overlay and its anchor resolver'],
  [/^src\/core\/overflow\.js$/, ['overflow-render', 'pin-render'], 'the overflow guardrail and the pinned-title case'],
  [/^src\/core\/annotate\.js$/, ['engine-render', 'render'], 'ink rides the engine scale'],
  [/^src\/core\/themes\.js$/, ['render', 'contrast'], 'theme picking, and the contrast gate behind it'],
  [/^src\/core\/(editmode|history)\.js$/, ['engine-render'], 'the author surfaces the engine harness drives'],
  [/^src\/core\/hud\.js$/, ['engine-render'], 'clock and progress live on the engine'],
  [/^src\/core\/finder\.js$/, ['engine-render', 'review-render'], 'slide titles: the finder names them, review anchors by them'],
  [/^src\/terminal\//, ['player-render'], 'the cast player'],
  [/^src\/code\//, ['render'], 'code blocks render in the smoke deck'],
  [/^src\/core\//, BROWSER, 'an unmapped core module — assume every harness'],

  // ── the CLI and tools, each spawned by the harness that tests it ────────
  [/^cli\/audit\.mjs$/, ['strict-render'], 'the ingredients label and --strict stripping'],
  [/^cli\/bundle\.mjs$/, ['strict-render', 'render'], 'bundling, and the deck it produces'],
  [/^cli\/plugin\.mjs$/, ['plugin-render'], 'presenter plugins'],
  [/^cli\/import\.mjs$/, ['import-render'], 'deck import'],
  [/^cli\/deckfile\.mjs$/, ['deckfile-render'], 'the .decklight container'],
  [/^cli\/pdf\.mjs$/, ['pdf-render'], 'PDF export'],
  [/^cli\/(present|shot)\.mjs$/, ['shot-render'], 'present, and the screenshot containment it asserts'],
  [/^cli\/(comments|review-anchor|review-store|review-remote|review-submit)\.mjs$/, ['review-render'],
    'the CLI half of review — the harness cross-checks the browser against it'],
  [/^cli\/(units|marketplace|loader|pin)\.mjs$/, ['pin-render', 'extension-check-render'],
    'unit pinning and the admission check'],
  [/^tools\/extension-check\.mjs$/, ['extension-check-render'], 'the admission gate itself'],
  [/^tools\/(theme-check|color)\.mjs$/, LINT, 'the theme lints'],
  [/^tools\/chrome\.mjs$/, ALL, 'every harness starts a browser through it'],
  [/^tools\/review-anchor\.mjs$/, ['review-render'], 'the anchor resolver both halves share'],
  [/^tools\/(tts-engines|local-voice|voiceover-server|lipsync)\.mjs$/, ['narration-render', 'record-render'],
    'the voice bridge narration talks to'],
  [/^themes\//, ['render', ...LINT], 'a theme, and the gates that read every theme'],
  [/^demo\//, ['render'], 'the smoke deck itself'],

  // ── things no harness reads ────────────────────────────────────────────
  // Named explicitly rather than left to the fallback, so "nothing" is a
  // decision on the record and not an omission.
  [/^(docs|\.github|\.claude)\//, [], 'not read by any harness'],
  [/^(SPEC|README|CONTRIBUTING|CLAUDE|CHANGELOG)\.md$/, [], 'prose'],
  [/^test\/.*\.test\.mjs$/, [], 'a unit test — the unit suite covers it'],
];

/** Which harnesses a single path implicates, and why. */
export function forPath(p) {
  for (const [re, harnesses, why] of RULES) {
    if (re.test(p)) return { harnesses, why };
  }
  // A harness fixture is about its own harness; `foo-render.mjs` / `foo.html`.
  const m = /^test\/([a-z-]+?)(?:-render)?\.(?:mjs|html)$/.exec(p);
  if (m) {
    const hit = ALL.find((h) => h === m[1] || h === `${m[1]}-render`);
    if (hit) return { harnesses: [hit], why: 'its own harness' };
  }
  return { harnesses: ALL, why: 'UNMAPPED — falling back to everything' };
}

/** What changed: committed against the base, plus whatever is uncommitted. */
function changedFiles(base) {
  const git = (...a) => {
    try { return execFileSync('git', a, { cwd: repo, encoding: 'utf8' }); } catch { return ''; }
  };
  // A base that does not resolve makes `git diff` fail, and a swallowed failure
  // here would report "nothing changed" — the one answer that must never be
  // wrong. `origin/main` is missing in more checkouts than you would think: a
  // clone whose remote is named something else, or one fetched shallow.
  try {
    execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`],
      { cwd: repo, stdio: 'ignore' });
  } catch {
    process.stdout.write(`test:impact: cannot resolve "${base}" — `
      + `pass --since <ref> with a ref this clone has (or fetch it).\n`);
    process.exit(2);
  }
  const out = new Set();
  // `...` is deliberate: the merge base, so a stale branch does not report
  // every file main moved under it as something this change touched.
  for (const l of git('diff', '--name-only', `${base}...HEAD`).split('\n')) if (l.trim()) out.add(l.trim());
  for (const l of git('status', '--porcelain').split('\n')) {
    const f = l.slice(3).trim();
    if (f) out.add(f.includes(' -> ') ? f.split(' -> ')[1] : f);
  }
  return [...out];
}

// ── the command ───────────────────────────────────────────────────────────
// Guarded so the map above can be imported and asserted (test/test-impact.test.mjs)
// without this file running a suite as a side effect of being read.
if (!isMain(import.meta.url)) { /* imported for the map — the CLI below is inert */ } else {
const args = process.argv.slice(2);
const run = args.includes('--run');
const baseArg = args.indexOf('--since');
const base = baseArg !== -1 ? args[baseArg + 1] : 'origin/main';
// `i !== baseArg + 1` drops --since's VALUE, and only when --since is present:
// with no flag `baseArg` is -1 and the guard would silently eat argv[0], which
// is the first path somebody asked about.
const paths = args.filter((a, i) => !a.startsWith('--') && !(baseArg !== -1 && i === baseArg + 1));

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`decklight test:impact — which tests this change needs

  npm run test:impact                 what would run, against origin/main
  npm run test:impact -- --run        run it
  npm run test:impact -- --since main compare against another ref
  npm run test:impact -- src/core/review.js   ask about explicit paths

The unit suite ALWAYS runs: it is ~48s and parallel, so picking a subset saves
little and can be wrong. Only the render harnesses (~200s, serial) are selected.
An unrecognised path selects every harness. CI always runs everything.
`);
  process.exit(0);
}

const files = paths.length ? paths : changedFiles(base);
if (!files.length) {
  process.stdout.write(`test:impact: nothing changed against ${base} — nothing to run\n`);
  process.exit(0);
}

const picked = new Map();     // harness → the reasons it was picked
let unmapped = false;
for (const f of files) {
  const { harnesses, why } = forPath(f);
  if (why.startsWith('UNMAPPED')) unmapped = true;
  for (const h of harnesses) {
    if (!picked.has(h)) picked.set(h, new Set());
    picked.get(h).add(`${f} — ${why}`);
  }
}
const selected = ALL.filter((h) => picked.has(h));

// Measured on a laptop; a rough shape so the report can say what it saves.
const COST = {
  'narration-render': 65, 'extension-check-render': 23, 'engine-render': 17, render: 20,
  'pdf-render': 10, 'split-render': 9, 'review-render': 8, 'pin-render': 7, 'record-render': 7,
  'strict-render': 6, 'overflow-render': 6, 'plugin-render': 6, 'deckfile-render': 4,
  'shot-render': 4, 'player-render': 3, 'character-render': 2, 'import-render': 2,
  contrast: 1, 'palette-rules': 1,
};
const cost = (list) => list.reduce((n, h) => n + (COST[h] ?? 10), 0);

process.stdout.write(`\n─── test:impact ${'─'.repeat(52)}\n`);
process.stdout.write(`${files.length} changed file${files.length === 1 ? '' : 's'} against ${base}\n\n`);
for (const f of files.slice(0, 20)) process.stdout.write(`  ${f}\n`);
if (files.length > 20) process.stdout.write(`  … and ${files.length - 20} more\n`);

process.stdout.write(`\nunit suite     ALWAYS — npm test (~48s, parallel)\n`);
if (!selected.length) {
  process.stdout.write(`render         none — nothing changed that a harness reads\n`);
} else {
  process.stdout.write(`render         ${selected.length} of ${ALL.length} harnesses`
    + ` (~${cost(selected)}s of ~${cost(ALL)}s)\n`);
  for (const h of selected) {
    const [first] = [...picked.get(h)];
    process.stdout.write(`  ${h.padEnd(24)} ${first}\n`);
  }
}
if (unmapped) {
  process.stdout.write(`\n! an unmapped path selected everything. If that path has a harness that\n`
    + `  is really about it, add a rule to tools/test-impact.mjs.\n`);
}
if (!run) {
  process.stdout.write(`\n(--run to run it; CI still runs everything)\n`);
  process.exit(0);
}

process.stdout.write(`\n─── npm test ${'─'.repeat(55)}\n`);
const unit = spawnSync('npm', ['test'], { cwd: repo, stdio: 'inherit', shell: process.platform === 'win32' });
let bad = unit.status !== 0;
if (selected.length) {
  const verify = spawnSync('npm', ['run', 'verify'], {
    cwd: repo,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, VERIFY_ONLY: selected.join(',') },
  });
  bad = bad || verify.status !== 0;
}
process.exit(bad ? 1 : 0);
}
