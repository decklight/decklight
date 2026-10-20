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
  PKG, AGENTS_MARKER, agentsSection, claudeSkillMd, homePath, referenceDoc, reportBugSkillMd, skillVersionOf,
} from './skill-content.mjs';
import { semverCompare } from '../tools/semver.mjs';
import { librarySkills } from './units.mjs';

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
  decklight library add skill|list|remove <name>       marketplace skills

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

Marketplace skills (decklight library add skill <name>) are a different thing and
live somewhere else — ~/.decklight/skills/ — so they sit ALONGSIDE the
authoring skill above and never replace it. The command above always writes
the authoring skill; nothing installed from a catalog changes that. It does
hand them on: each is copied into .claude/skills/<name>/ when missing (never
over one already there) and listed in the AGENTS.md section.
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

/**
 * Is the skill text on disk older than the one this build would write?
 * A file with no stamp predates the stamp (0.9.0) and counts as older.
 */
function staleSkill(file, content) {
  const mine = skillVersionOf(content);
  if (!mine) return false;
  let theirs = null;
  try { theirs = skillVersionOf(fs.readFileSync(file, 'utf8')); } catch { return false; }
  return theirs === null || (semverCompare(theirs, mine) ?? -1) < 0;
}

/**
 * Write a file. An existing one is refreshed when it is OLDER than this build
 * (the files are derived content, and an agent reading an old contract is
 * the failure this exists to prevent) or when `refresh` says its sibling was;
 * one that is already this version is left alone (null) without --force, and
 * the command fails only when NOTHING needed writing — a current install
 * asked for again, which is what --force is for.
 */
function writeIfAbsent(file, content, force, { refresh = null } = {}) {
  if (fs.existsSync(file) && !force) {
    const stale = refresh ?? staleSkill(file, content);
    if (!stale) return null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
/** `display` of a write, or nothing for a file left alone. */
const wrote = (file) => (file ? display(file) : null);

/** Add/refresh the marked Decklight block in the AGENTS.md under `dir`. */
function mergeAgentsMd(dir, refHref) {
  const agentsPath = path.join(dir, 'AGENTS.md');
  const section = agentsSection(refHref, { librarySkills: librarySkills() });
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
  const skill = path.join(skillDir, 'SKILL.md');
  // the reference carries no stamp of its own: it follows the SKILL.md beside it
  const refresh = fs.existsSync(skill) ? staleSkill(skill, claudeSkillMd(SKILL_REF)) : null;
  written.push(wrote(writeIfAbsent(skill, claudeSkillMd(SKILL_REF), force)));
  written.push(wrote(writeIfAbsent(path.join(skillDir, SKILL_REF), referenceDoc(), force, { refresh })));
}

/**
 * The bug-reporting skill, a sibling of the authoring one (#73). Its own
 * directory because Claude indexes one skill per SKILL.md, and it carries no
 * reference doc — the authoring contract is not what filing a bug needs.
 */
function installReportBugSkill(skillsRoot, force, written) {
  const dir = path.join(skillsRoot, 'decklight-report-bug');
  written.push(wrote(writeIfAbsent(path.join(dir, 'SKILL.md'), reportBugSkillMd(), force)));
}

// --- marketplace skills, handed on to the agents (#880) ----------------------
//
// A library skill lives in ~/.decklight/skills/, which no agent reads. Claude
// indexes one skill per directory under .claude/skills/, so each is COPIED
// there (a copy, not a link: a symlink is a privilege on Windows, and a copy
// is what `unzip -d ~/.claude/skills/` would leave too); an AGENTS.md agent
// reads only its file, so the section lists them (`agentsSection`). A copy
// carries LIBRARY_MARK, and only a marked directory is ever replaced or
// removed: a skill the user wrote that happens to share a name is theirs.

const LIBRARY_MARK = '.decklight-library';

/**
 * Copy one library skill under `skillsRoot`. `update` replaces a copy already
 * there (what `library add` does, to take a new version); without it an
 * existing copy is kept as it is (what a `decklight skills` re-run does).
 */
function copyLibrarySkill(skill, skillsRoot, { update }) {
  const dest = path.join(skillsRoot, skill.name);
  if (fs.existsSync(dest)) {
    if (!fs.existsSync(path.join(dest, LIBRARY_MARK))) {
      return `left ${display(dest)} alone — a skill of that name that the library did not put there`;
    }
    if (!update) return null;
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(skill.path, dest, { recursive: true });
  fs.writeFileSync(path.join(dest, LIBRARY_MARK),
    `copied from ${homePath(skill.path)} by decklight library add skill; decklight library remove skill ${skill.name} removes it\n`);
  return `copied ${skill.name} from your library to ${display(dest)}`;
}

/**
 * Bring the library skills under one Claude skills root up to the library:
 * add the missing ones, drop the copies whose skill was removed from it.
 * Never overwrites a copy — the authoring install re-run keeps them as they are.
 */
export function syncLibrarySkills(skillsRoot, written) {
  const skills = librarySkills();
  for (const skill of skills) written.push(copyLibrarySkill(skill, skillsRoot, { update: false }));
  if (!fs.existsSync(skillsRoot)) return;
  const have = new Set(skills.map((s) => s.name));
  for (const name of fs.readdirSync(skillsRoot)) {
    const dir = path.join(skillsRoot, name);
    if (have.has(name) || !fs.existsSync(path.join(dir, LIBRARY_MARK))) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    written.push(`removed ${display(dir)} — no longer in your library`);
  }
}

/**
 * Refresh every Decklight AGENTS.md section this command can find — the
 * project's under `dir` and each agent's global one — so its list of library
 * skills matches the library. Only a file already carrying the section is
 * touched: this never creates an AGENTS.md nobody asked for.
 */
function refreshAgentsSections({ dir = '.', env = process.env } = {}) {
  const out = [];
  const marked = (d) => {
    try { return fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8').includes(AGENTS_MARKER); } catch { return false; }
  };
  const root = path.resolve(dir);
  if (marked(root)) out.push(mergeAgentsMd(root, fs.existsSync(path.join(root, CLAUDE_REF)) ? CLAUDE_REF : SHARED_REF));
  for (const t of Object.values(TARGETS)) {
    const home = t.home(env);
    if (t.kind === 'agents' && marked(home)) out.push(mergeAgentsMd(home, SHARED_REF));
  }
  return [...new Set(out)];
}

/** Claude's skills root for a scope: the project's, or its config home's. */
const claudeSkillsRoot = ({ dir = '.', global = false, env = process.env }) =>
  (global ? path.join(TARGETS.claude.home(env), 'skills') : path.join(path.resolve(dir), '.claude', 'skills'));

/**
 * `library add skill <name>` hands the installed skill to the agents: a copy
 * in Claude's skills (the project's, or with `global` its config home's), and
 * a line in every AGENTS.md section. Returns the lines to print.
 */
export function placeLibrarySkill(name, { dir = '.', global = false, env = process.env } = {}) {
  const skill = librarySkills().find((s) => s.name === name);
  if (!skill) return [];
  const out = [copyLibrarySkill(skill, claudeSkillsRoot({ dir, global, env }), { update: true })];
  out.push(...refreshAgentsSections({ dir, env }));
  return out.filter(Boolean);
}

/**
 * `library remove skill <name>` takes it back from the same places: the
 * copy in this project's and in Claude's global skills (both, whatever scope
 * it was added with — only a marked copy is ours), and its AGENTS.md lines.
 */
export function unplaceLibrarySkill(name, { dir = '.', env = process.env } = {}) {
  const out = [];
  for (const global of [false, true]) {
    const copy = path.join(claudeSkillsRoot({ dir, global, env }), name);
    if (!fs.existsSync(path.join(copy, LIBRARY_MARK))) continue;
    fs.rmSync(copy, { recursive: true, force: true });
    out.push(`removed ${display(copy)}`);
  }
  out.push(...refreshAgentsSections({ dir, env }));
  return out;
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
    syncLibrarySkills(skillsRoot, written);
  }
  if (mdAgents.length) {
    // one reference copy: Claude's skill dir when Claude is also a target,
    // else a standalone .decklight/ copy the AGENTS.md agents point at.
    const refHref = wantsClaude ? CLAUDE_REF : SHARED_REF;
    if (!wantsClaude) written.push(wrote(writeIfAbsent(path.join(root, SHARED_REF), referenceDoc(), force)));
    written.push(mergeAgentsMd(root, refHref));
  }
  return written.filter(Boolean);
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
      syncLibrarySkills(path.join(home, 'skills'), written);
    } else {
      written.push(wrote(writeIfAbsent(path.join(home, SHARED_REF), referenceDoc(), force)));
      written.push(mergeAgentsMd(home, SHARED_REF));
    }
  }
  return written.filter(Boolean);
}

// --- what is on this machine, against this build ------------------------------

/**
 * The skill files older than this install, where `decklight <deck>` looks
 * before it serves (PRESENTING): the project's, under `dir` (Claude's
 * `.claude/skills/decklight/SKILL.md`, and an AGENTS.md carrying the marked
 * section), and every agent's global home, whether or not that agent is on
 * PATH today: a file that was installed is a file something reads. A stamp
 * older than this build, or missing (before 0.9.0), is stale. Each entry is
 * `{ scope: 'project' | 'global', target, file, version }`.
 */
export function staleSkills({ dir = '.', env = process.env } = {}) {
  const out = [];
  const look = (scope, target, file, kind) => {
    if (!fs.existsSync(file)) return;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    if (kind === 'agents' && !text.includes(AGENTS_MARKER)) return;
    const version = skillVersionOf(text);
    if (version === null || (semverCompare(version, PKG.version) ?? -1) < 0) out.push({ scope, target, file, version });
  };
  const root = path.resolve(dir);
  look('project', 'claude', path.join(root, '.claude', 'skills', 'decklight', 'SKILL.md'), 'skill');
  look('project', 'agents', path.join(root, 'AGENTS.md'), 'agents');
  for (const [key, t] of Object.entries(TARGETS)) {
    const home = t.home(env);
    if (t.kind === 'skill') look('global', key, path.join(home, 'skills', 'decklight', 'SKILL.md'), 'skill');
    else look('global', key, path.join(home, 'AGENTS.md'), 'agents');
  }
  return out;
}

/**
 * Bring the files `staleSkills` named up to this build, and nothing else: a
 * project whose AGENTS.md is stale gets its section refreshed, not a Claude
 * skill it never had. The same writers as `decklight skills`, so a refresh
 * from the prompt and one from the command cannot differ. Returns the lines
 * the command would print, one per file written.
 */
export function refreshSkills(stale, { dir = '.', env = process.env } = {}) {
  const written = [];
  const root = path.resolve(dir);
  const project = stale.filter((s) => s.scope === 'project');
  if (project.some((s) => s.target === 'claude')) {
    installClaudeSkill(path.join(root, '.claude', 'skills', 'decklight'), false, written);
    installReportBugSkill(path.join(root, '.claude', 'skills'), false, written);
  }
  if (project.some((s) => s.target === 'agents')) {
    const hasClaude = fs.existsSync(path.join(root, CLAUDE_REF));
    if (!hasClaude) written.push(wrote(writeIfAbsent(path.join(root, SHARED_REF), referenceDoc(), false)));
    written.push(mergeAgentsMd(root, hasClaude ? CLAUDE_REF : SHARED_REF));
  }
  const globals = [...new Set(stale.filter((s) => s.scope === 'global').map((s) => s.target))];
  if (globals.length) written.push(...installGlobal(Object.keys(TARGETS).filter((k) => globals.includes(k)), env, false));
  return written.filter(Boolean);
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
 * `add`, `list` and `remove` were marketplace skills (`UNITS#REST`) and lived
 * here; they are `decklight library <verb> skill` now, with every other kind
 * of unit. Said by name rather than read as an agent called "add": the
 * roster is a closed set of nouns and these are verbs.
 */
const UNIT_SUBCOMMANDS = new Set(['add', 'list', 'remove']);

export async function skillsMain(argv = process.argv.slice(2), { hasBin = onPath, env = process.env } = {}) {
  if (UNIT_SUBCOMMANDS.has(argv[0])) {
    console.error(`decklight skills ${argv[0]}: marketplace skills are in your library — decklight library ${argv[0]} skill ${argv.slice(1).join(' ')}`.trimEnd());
    process.exitCode = 1;
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
  // Every file was already this version: nothing to do, said as a refusal so a
  // script that expected a write learns it did not happen — --force rewrites.
  if (!written.some((w) => !/^refreshed the Decklight section/.test(w) || force)) {
    fail(`the Decklight skill is already this version (${PKG.version}) — pass --force to overwrite`);
  }

  const where = global ? 'globally' : `in ${display(path.resolve(dir ?? '.'))}`;
  process.stdout.write(
    `installed the Decklight skill (v${PKG.version}) ${where} for ${targets.map((k) => TARGETS[k].label).join(', ')}\n`,
  );
  for (const w of written) process.stdout.write(`  ${w}\n`);
}

if (isMain(import.meta.url)) process.exitCode = await runMain('skills', skillsMain);
