#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Evidence for UNITS#REST (issue #197): the demo from the ticket, run for
// real. A local marketplace carrying one entry of each data kind plus an
// import adapter registers offline; `marketplace list` shows each entry BY
// KIND with its install command, not a flat bag of names; `init --from` with
// nothing installed refuses and names the install command (never "unknown
// flag value"); after `template add` the same command scaffolds a deck from a
// template that was never in this repo. Then the ENGINES pattern at the point
// of failure: `import talk.marp` with no adapter names the one that reads
// `.marp` and the command that installs it, and after `importer add` the same
// import runs it (EXTENSIONS#ADAPTEREXEC). A marketplace skill installs into
// ~/.decklight/skills/ — beside the base authoring skill, never over it — and
// a voice installs as a JSON POINTER (SPEC VOICE_UNITS): the `find` at the
// end shows everything that landed on disk, and the voice line is one small
// .json, no model, no audio, nothing executable.
//
// Every command runs against a throwaway DECKLIGHT_HOME; the captured output
// is rendered as a terminal window and screenshotted with tools/shot.mjs. A
// second shot opens the scaffolded deck itself in headless Chrome — the
// pixel-level half of "a deck scaffolded from a template that was not in this
// repo".
//
//   node shots/units-rest-transcript.mjs
//     → .shots/units-rest.png
//     → .shots/units-rest-template-deck.png

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CLI = path.join(root, 'cli', 'decklight.mjs');

// --- fixtures: a fresh home, and a marketplace with one of each kind --------

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decklight-units-rest-shot-'));
const home = path.join(dir, 'home');
const market = path.join(dir, 'pitch-market');
const work = path.join(dir, 'work');
fs.mkdirSync(path.join(market, '.decklight'), { recursive: true });
fs.mkdirSync(path.join(market, 'units', 'conference-cfp'), { recursive: true });
fs.mkdirSync(work, { recursive: true });

// The template is a REAL deck — scaffolded by decklight itself so it carries
// a working runtime — with its slides swapped for the marketplace author's
// own. That is exactly what a template IS: someone's deck, offered by name.
execFileSync('node', [CLI, 'init', 'Startup Pitch', '-o', 'startup-pitch.html',
  '--dir', path.join(market, 'units'), '--themes', 'aurora', '--no-skill', '--no-git'],
{ stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECKLIGHT_HOME: home } });
const tpl = path.join(market, 'units', 'startup-pitch.html');
fs.writeFileSync(tpl, fs.readFileSync(tpl, 'utf8').replace(
  /<section>[\s\S]*<\/section>/,
  `<section>
      <h1>Startup Pitch</h1>
      <p>The problem, the wedge, the ask — one slide each</p>
    </section>

    <section>
      <h2>The problem</h2>
      <ul data-build="fade-up">
        <li>Decks start from a blank page</li>
        <li>Every team rebuilds the same skeleton</li>
      </ul>
    </section>

    <section>
      <h2>The ask</h2>
      <p>decklight template add startup-pitch</p>
    </section>`,
));

const ADAPTER = `export const apiVersion = 1;
export default async function importDeck(bytes) {
  const text = Buffer.from(bytes).toString('utf8');
  return text.split(/^---$/m).map((s) =>
    '<section>' + s.trim().split('\\n').map((l) =>
      l.startsWith('# ') ? '<h2>' + l.slice(2) + '</h2>' : '<p>' + l + '</p>'
    ).join('') + '</section>').join('\\n');
}
`;
fs.writeFileSync(path.join(market, 'units', 'importer.mjs'), ADAPTER);
const sha256 = createHash('sha256').update(ADAPTER).digest('hex');

fs.writeFileSync(path.join(market, 'units', 'conference-cfp', 'SKILL.md'),
  '# Conference CFP\n\nTurn a deck outline into a talk proposal.\n');

fs.writeFileSync(path.join(market, '.decklight', 'marketplace.json'), JSON.stringify({
  name: 'pitchmarket',
  entries: [
    { name: 'startup-pitch', type: 'template', source: 'units/startup-pitch.html',
      description: 'a three-slide seed pitch skeleton' },
    { name: 'marp-import', type: 'importer', source: 'units',
      extensions: ['.marp'], apiVersion: 1, sha256,
      description: 'reads Marp markdown decks' },
    { name: 'conference-cfp', type: 'skill', source: 'units/conference-cfp',
      description: 'turn a deck into a CFP submission' },
    { name: 'narrator-anna', type: 'voice', engine: 'elevenlabs', voiceId: 'aZk2…demo',
      description: 'warm, unhurried narrator' },
  ],
}, null, 2));

fs.writeFileSync(path.join(work, 'talk.marp'),
  '# The old deck\nIt lived in Marp\n---\n# The new deck\nNow it is decklight\n');

// --- run the real commands, keep the real output ----------------------------

const runs = [];
const run = (expect, label, ...args) => {
  const r = spawnSync('node', [CLI, ...args], {
    cwd: work, encoding: 'utf8', env: { ...process.env, DECKLIGHT_HOME: home },
  });
  if (r.status !== expect) {
    process.stderr.write(`expected exit ${expect} from ${args.join(' ')}, got ${r.status}:\n${r.stderr}${r.stdout}`);
    process.exit(1);
  }
  runs.push({
    label,
    out: (r.stderr + r.stdout)
      .replace(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~')
      .replace(/^decklight \d+\.\d+\.\d+\n/, ''),
  });
};

run(0, 'decklight marketplace add ~/pitch-market      # a local path never touches the network',
  'marketplace', 'add', market);
run(0, 'decklight marketplace list                    # entries BY KIND, each with its install command',
  'marketplace', 'list');
run(1, 'decklight init "Seed Round" --from startup-pitch     # not installed: named, not "unknown flag"',
  'init', 'Seed Round', '--from', 'startup-pitch', '--no-skill', '--no-git');
run(0, 'decklight template add startup-pitch',
  'template', 'add', 'startup-pitch');
run(0, 'decklight init "Seed Round" --from startup-pitch     # scaffolded from the installed template',
  'init', 'Seed Round', '--from', 'startup-pitch', '--no-skill', '--no-git');
run(1, 'decklight import talk.marp                    # the offer at the point of failure (ENGINES pattern)',
  'import', 'talk.marp');
run(0, 'decklight importer add marp-import',
  'importer', 'add', 'marp-import');
run(0, 'decklight import talk.marp                    # the installed adapter runs (EXTENSIONS#ADAPTEREXEC)',
  'import', 'talk.marp');
run(0, 'decklight skills add conference-cfp           # lands beside the authoring skill, never over it',
  'skills', 'add', 'conference-cfp');
run(0, 'decklight voice add narrator-anna             # a reference, never a model — works offline',
  'voice', 'add', 'narrator-anna');

// What actually landed: the library, with the voice as one small pointer file.
const lib = spawnSync('sh', ['-c',
  `cd "${home}" && find importers skills templates voices -type f | sort && echo && cat voices/narrator-anna.json`],
{ encoding: 'utf8' });
runs.push({ label: 'find ~/.decklight -type f && cat …/voices/narrator-anna.json', out: lib.stdout });

// --- shot 2: the scaffolded deck itself, before the fixture dir goes --------

fs.mkdirSync(path.join(root, '.shots'), { recursive: true });
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), path.join(work, 'deck.html'),
  '-o', path.join(root, '.shots', 'units-rest-template-deck.png'), '--wait', '1200'],
{ stdio: 'inherit' });

fs.rmSync(dir, { recursive: true, force: true });

// --- render the transcript as a terminal window and shoot it ----------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const paint = (s) => esc(s)
  .replace(/^(registered .*|installed .*|created .*|fetched .*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(\/[^\n]* · \d+ slide.*)$/gm, '<span class="ok">$1</span>')
  .replace(/^(decklight (?:init|import): .*)$/gm, '<span class="err">$1</span>')
  .replace(/^( {2}no adapter for .*|.*a registered marketplace offers it:)$/gm, '<span class="hint">$1</span>')
  .replace(/^( {4}decklight (?:template|importer) add .*)$/gm, '<span class="hint">$1</span>')
  .replace(/^( {2}(?:importer|skill|template|voice)\b.*)$/gm, '<span class="kind">$1</span>');
const block = ({ label, out }) =>
  `<div class="run"><span class="prompt">~/work $</span> ${esc(label)}\n${paint(out.replace(/\n+$/, ''))}</div>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>decklight — UNITS#REST</title><style>
  body { margin: 0; display: grid; place-items: center; min-height: 100vh; padding: 30px 0;
         box-sizing: border-box; background: linear-gradient(135deg, #1b2735, #090a0f); }
  .term { width: 1180px; background: #10141b; border-radius: 12px;
          box-shadow: 0 24px 70px rgba(0,0,0,.55); overflow: hidden;
          font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 11px 14px; background: #1a202b; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; }
  .bar .t { margin-left: 10px; color: #8b98ab; font-size: 13px; }
  .body { padding: 16px 22px 22px; color: #cdd6e4; white-space: pre-wrap; overflow-wrap: anywhere; }
  .run + .run { display: block; margin-top: 1em; }
  .prompt { color: #67e8f9; font-weight: 700; }
  .ok { color: #86efac; }
  .err { color: #f87171; }
  .hint { color: #fbbf24; }
  .kind { color: #93c5fd; }
</style></head><body>
<div class="term">
  <div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i>
    <span class="t">UNITS#REST — templates, skills, importers and voices over one install seam (issue #197)</span></div>
  <div class="body">${runs.map(block).join('\n')}</div>
</div>
</body></html>
`;

const page = path.join(root, '.shots', 'units-rest-transcript.html');
fs.writeFileSync(page, html);
execFileSync('node', [path.join(root, 'tools', 'shot.mjs'), page,
  '-o', path.join(root, '.shots', 'units-rest.png'), '--size', '1280x1560', '--wait', '800'],
  { stdio: 'inherit' });
fs.rmSync(page, { force: true });
