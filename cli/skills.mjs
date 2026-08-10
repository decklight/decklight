#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight skills — install the Decklight authoring skill for one or more
 * AI coding agents, each in the convention it reads.
 *
 *   decklight skills [agent…] [--dir path | --global] [--all] [--force]
  decklight skills claude --pack [-o <file>]
 *
 * `init` scaffolds a deck *and* hands Claude a skill; this command is the
 * skill on its own. Claude Code loads a real skill (`.claude/skills/`);
 * Codex, OpenCode and IBM Bob read the `AGENTS.md` convention. Both point at
 * a reference sliced from the installed version's SPEC.md so it can't drift.
 *
 * Two scopes. **Project** (default) installs into the current repo, next to
 * the deck. **--global** installs into each agent's user-level config home
 * (~/.claude, ~/.codex, …) so the skill is on hand in *every* project — a
 * Decklight deck is one self-contained HTML file that plays on any machine
 * for any purpose, so authoring it isn't tied to one codebase.
 *
 * The roster is data (see TARGETS): teaching a new agent its convention —
 * and where its config lives globally — is one entry, mirroring agents.mjs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { onPath } from './agents.mjs';
import { makeFail, runMain } from './util.mjs';
import { isMain } from '../tools/args.mjs';
import { zipSync } from './zip.mjs';
import {
  PKG, AGENTS_MARKER, agentsSection, claudeSkillMd, referenceDoc, reportBugSkillMd,
} from './skill-content.mjs';

// The reference doc, relative to whatever dir carries it. Skills keep their
// own copy next to SKILL.md; AGENTS.md agents keep one under .decklight/.
const SKILL_REF = 'reference.md';
const SHARED_REF = '.decklight/reference.md';
// Path from a project-root AGENTS.md to Claude's skill copy, so a repo with
// both installed shares one reference instead of carrying two.
const CLAUDE_REF = '.claude/skills/decklight/reference.md';

// An agent target is data: the label to print, the CLI `bin` to probe for
// auto-detection, the `kind` of layout it wants ('skill' is Claude's own
// .claude/skills/ format, 'agents' is the cross-agent AGENTS.md file), and
// `home(env)` — the user-level config dir it reads globally, honoring each
// agent's own override env var before falling back under $HOME.
export const TARGETS = {
  claude: {
    label: 'Claude Code', bin: 'claude', kind: 'skill',
    home: (env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  },
  codex: {
    label: 'OpenAI Codex', bin: 'codex', kind: 'agents',
    home: (env) => env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  },
  opencode: {
    label: 'OpenCode', bin: 'opencode', kind: 'agents',
    home: (env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode'),
  },
  bob: {
    label: 'IBM Bob', bin: 'bob', kind: 'agents',
    home: (env) => env.BOB_HOME || path.join(os.homedir(), '.bob'),
  },
};

const fail = makeFail('skills');

const HELP = `decklight skills — install the Decklight authoring skill for AI agents

Usage:
  decklight skills [agent…] [--dir path | --global] [--all] [--force]
  decklight skills add|list|remove <name>       marketplace skills

Agents:
${Object.entries(TARGETS).map(([k, t]) => `  ${k.padEnd(9)} ${t.label}`).join('\n')}

With no agent named, targets the ones detected on your PATH. Name one or
more explicitly (decklight skills claude codex) to override detection, or
--all to install for every supported agent.

Options:
  --dir <path>  target project directory (default: current directory)
  --global      install into each agent's user-level config home
                (~/.claude, ~/.codex, ~/.config/opencode, ~/.bob) so the
                skill is available in every project, not just this one
  --all         install for every supported agent
  --pack        write decklight-skill.zip to upload in your claude.ai skill
                settings — the account-level route, for every project at once
                (Claude's skill format only; -o names the file)
  -o <file>     where --pack writes                 [decklight-skill.zip]
  --force       overwrite files that already exist (default: refuses to
                clobber a SKILL.md/reference.md; the AGENTS.md section is
                always refreshed in place, never duplicated)

Claude Code gets a real skill (.claude/skills/decklight/); Codex, OpenCode
and IBM Bob get a marked section in AGENTS.md. Both point at a reference
sliced from this version's SPEC.md, so the contract never drifts from the
installed runtime.

Marketplace skills (decklight skills add <name>) are a different thing and
live somewhere else — ~/.decklight/skills/ — so they sit ALONGSIDE the
authoring skill above and never replace it. The command above always writes
the authoring skill; nothing installed from a catalog changes that.
`;

/** The agents found on PATH, in roster order (empty when none is). */
export function detectedTargets(hasBin = onPath) {
  return Object.keys(TARGETS).filter((k) => hasBin(TARGETS[k].bin));
}

/** The agents to target: an explicit list, everything (--all), or detected. */
function resolveTargets({ names, all, hasBin }) {
  if (all) return Object.keys(TARGETS);
  if (names.length) return names;
  const detected = detectedTargets(hasBin);
  if (detected.length) return { detected };
  return null;
}

/** A path for humans: relative to cwd when inside it, else `~/…`, else absolute. */
export function display(file) {
  const rel = path.relative(process.cwd(), file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  const home = os.homedir();
  if (home && (file === home || file.startsWith(home + path.sep))) return '~' + file.slice(home.length);
  return file;
}

/** Write a file, refusing to clobber an existing one without --force. */
function writeIfAbsent(file, content, force) {
  if (fs.existsSync(file) && !force) {
    fail(`${display(file)} already exists — pass --force to overwrite`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** Add/refresh the marked Decklight block in the AGENTS.md under `dir`. */
function mergeAgentsMd(dir, refHref) {
  const agentsPath = path.join(dir, 'AGENTS.md');
  const section = agentsSection(refHref);
  if (!fs.existsSync(agentsPath)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(agentsPath, `# Agent notes\n\n${section}`);
    return `created ${display(agentsPath)}`;
  }
  const existing = fs.readFileSync(agentsPath, 'utf8');
  const markerRe = new RegExp(`${AGENTS_MARKER}[\\s\\S]*?${AGENTS_MARKER}\\n?`);
  if (markerRe.test(existing)) {
    fs.writeFileSync(agentsPath, existing.replace(markerRe, section));
    return `refreshed the Decklight section in ${display(agentsPath)}`;
  }
  fs.writeFileSync(agentsPath, existing.replace(/\n*$/, '\n\n') + section);
  return `appended a Decklight section to ${display(agentsPath)}`;
}

/** Write Claude's self-contained skill (SKILL.md + reference) into skillDir. */
function installClaudeSkill(skillDir, force, written) {
  written.push(display(writeIfAbsent(path.join(skillDir, 'SKILL.md'), claudeSkillMd(SKILL_REF), force)));
  written.push(display(writeIfAbsent(path.join(skillDir, SKILL_REF), referenceDoc(), force)));
}

/**
 * The bug-reporting skill, a sibling of the authoring one (#73). Its own
 * directory because Claude indexes one skill per SKILL.md, and it carries no
 * reference doc — the authoring contract is not what filing a bug needs.
 */
function installReportBugSkill(skillsRoot, force, written) {
  const dir = path.join(skillsRoot, 'decklight-report-bug');
  written.push(display(writeIfAbsent(path.join(dir, 'SKILL.md'), reportBugSkillMd(), force)));
}

// --- project scope: one repo, one shared AGENTS.md for every agent ----------

function installProject(targets, dir, force) {
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });

  const wantsClaude = targets.includes('claude');
  const mdAgents = targets.filter((k) => TARGETS[k].kind === 'agents');
  const written = [];

  if (wantsClaude) {
    const skillsRoot = path.join(root, '.claude', 'skills');
    installClaudeSkill(path.join(skillsRoot, 'decklight'), force, written);
    installReportBugSkill(skillsRoot, force, written);
  }
  if (mdAgents.length) {
    // one reference copy: Claude's skill dir when Claude is also a target,
    // else a standalone .decklight/ copy the AGENTS.md agents point at.
    const refHref = wantsClaude ? CLAUDE_REF : SHARED_REF;
    if (!wantsClaude) written.push(display(writeIfAbsent(path.join(root, SHARED_REF), referenceDoc(), force)));
    written.push(mergeAgentsMd(root, refHref));
  }
  return written;
}

// --- global scope: each agent self-contained in its own config home ---------

function installGlobal(targets, env, force) {
  const written = [];
  for (const key of targets) {
    const t = TARGETS[key];
    const home = t.home(env);
    if (t.kind === 'skill') {
      installClaudeSkill(path.join(home, 'skills', 'decklight'), force, written);
      installReportBugSkill(path.join(home, 'skills'), force, written);
    } else {
      written.push(display(writeIfAbsent(path.join(home, SHARED_REF), referenceDoc(), force)));
      written.push(mergeAgentsMd(home, SHARED_REF));
    }
  }
  return written;
}

/**
 * The global install as one delegable step — what init's skill-scope question
 * runs on a `g`: the same "detected on PATH" notice and summary lines
 * `decklight skills --global` prints, over the same installGlobal machinery.
 * `force: true` is init's refresh semantics — the skill files are derived
 * content, so a re-run refreshes them instead of demanding --force.
 */
export function installGlobalSkill(targets, { env = process.env, force = false, detected = false, out = process.stdout } = {}) {
  if (detected) out.write(`detected on PATH: ${targets.map((k) => TARGETS[k].label).join(', ')}\n`);
  const written = installGlobal(targets, env, force);
  out.write(`installed the Decklight skill (v${PKG.version}) globally for ${targets.map((k) => TARGETS[k].label).join(', ')}\n`);
  for (const w of written) out.write(`  ${w}\n`);
}

/**
 * The account-level distribution artifact (#80): the same two files a project
 * install writes, in a standard archive you upload once instead of committing
 * per repo. Rendered from skill-content.mjs like every other install, so the
 * packed copy cannot drift from the installed one.
 *
 * The folder-with-SKILL.md-at-its-root shape is the ecosystem's interchange
 * form, and is also directly usable as `unzip -d ~/.claude/skills/` — so the
 * artifact stays useful even if an upload surface moves.
 */
export function packSkill() {
  return zipSync([
    { name: 'decklight/SKILL.md', data: claudeSkillMd(SKILL_REF) },
    { name: `decklight/${SKILL_REF}`, data: referenceDoc() },
  ]);
}

/**
 * `add`, `list` and `remove` are marketplace skills (`UNITS#REST`); every
 * other positional is an agent name. They share this command because they
 * are the same subject — a skill — and a separate `decklight skill` beside
 * `decklight skills` would be a footgun that reads as a typo either way.
 *
 * Unambiguous in practice: the agent roster is a closed set of nouns
 * (`claude`, `codex`, …) and these are verbs, so no name can be both. A
 * future agent called "list" would collide, and the roster is ours.
 */
const UNIT_SUBCOMMANDS = new Set(['add', 'list', 'remove']);

export async function skillsMain(argv = process.argv.slice(2), { hasBin = onPath, env = process.env } = {}) {
  if (UNIT_SUBCOMMANDS.has(argv[0])) {
    const { unitMain } = await import('./units.mjs');
    const code = await unitMain('skill', argv);
    if (code) process.exitCode = code;
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  let dir = null, all = false, force = false, global = false, pack = false, outFile = null;
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') dir = argv[++i];
    else if (a === '--global' || a === '-g') global = true;
    else if (a === '--all') all = true;
    else if (a === '--force') force = true;
    else if (a === '--pack') pack = true;
    else if (a === '-o' || a === '--out') outFile = argv[++i];
    else if (a.startsWith('-')) fail(`unknown argument: ${a}`);
    else if (TARGETS[a]) names.push(a);
    else fail(`unknown agent: ${a} (supported: ${Object.keys(TARGETS).join(', ')})`);
  }
  if (global && dir !== null) fail('--global and --dir are mutually exclusive');

  if (pack) {
    // --pack writes an artifact; the other flags describe installs. Rejecting
    // the combinations outright beats silently honouring one and ignoring the
    // rest, which is how you end up with a zip you think went somewhere.
    if (global) fail('--pack and --global are different routes: --pack writes an archive to upload, --global installs into this machine');
    if (dir !== null) fail('--pack and --dir are different things: --pack writes an archive, not a directory install — use -o to choose the file');
    if (all) fail("--pack targets Claude's skill format only — drop --all");
    const other = names.find((n) => n !== 'claude');
    if (other) fail(`--pack targets Claude's skill format only — ${TARGETS[other].label} has no upload surface (use --global for it)`);

    const file = path.resolve(outFile ?? 'decklight-skill.zip');
    if (fs.existsSync(file) && !force) fail(`${display(file)} already exists — pass --force to overwrite`);
    fs.writeFileSync(file, packSkill());
    process.stdout.write(
      `packed the Decklight skill (v${PKG.version}) → ${display(file)}\n`
      + `  decklight/SKILL.md\n  decklight/${SKILL_REF}\n\n`
      + 'Two ways to reach Claude Code on the web:\n'
      + '  this repo    commit .claude/skills/decklight/ — cloud sessions load it with the clone\n'
      + `  every project  upload ${path.basename(file)} in your claude.ai skill settings\n`
      + `                 (or: unzip ${path.basename(file)} -d ~/.claude/skills/ for local sessions)\n`,
    );
    return;
  }

  const resolved = resolveTargets({ names, all, hasBin });
  if (!resolved) {
    fail('no supported agent detected on PATH — name one '
      + `(${Object.keys(TARGETS).join(', ')}) or pass --all`);
  }
  const selected = Array.isArray(resolved) ? resolved : resolved.detected;
  if (resolved.detected) {
    process.stdout.write(`detected on PATH: ${selected.map((k) => TARGETS[k].label).join(', ')}\n`);
  }
  // de-dupe while keeping the roster's order for stable output
  const targets = Object.keys(TARGETS).filter((k) => selected.includes(k));

  const written = global ? installGlobal(targets, env, force) : installProject(targets, dir ?? '.', force);

  const where = global ? 'globally' : `in ${display(path.resolve(dir ?? '.'))}`;
  process.stdout.write(
    `installed the Decklight skill (v${PKG.version}) ${where} for ${targets.map((k) => TARGETS[k].label).join(', ')}\n`,
  );
  for (const w of written) process.stdout.write(`  ${w}\n`);
}

if (isMain(import.meta.url)) process.exitCode = await runMain('skills', skillsMain);
