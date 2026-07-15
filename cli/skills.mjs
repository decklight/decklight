#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight skills — install the Decklight authoring skill for one or more
 * AI coding agents, each in the convention it reads.
 *
 *   decklight skills [agent…] [--dir path] [--all] [--force]
 *
 * `init` scaffolds a deck *and* hands Claude a skill; this command is the
 * skill on its own, for any repo (a deck already exists, or the deck lives
 * elsewhere) and for agents beyond Claude. Claude Code loads a real skill
 * (\`.claude/skills/decklight/\`); Codex, OpenCode and IBM Bob read the
 * shared \`AGENTS.md\` convention. Both point at the same reference doc,
 * sliced from the installed version's SPEC.md so it can't drift.
 *
 * The roster is data (see TARGETS): teaching a new agent its convention is
 * one entry, mirroring cli/agents.mjs.
 */

import fs from 'node:fs';
import path from 'node:path';

import { onPath } from './agents.mjs';
import {
  PKG, AGENTS_MARKER, agentsSection, claudeSkillMd, referenceDoc,
} from './skill-content.mjs';

// Where the shared reference lives for the AGENTS.md-reading agents. When
// Claude is also a target its skill copy is canonical and everyone points
// there; otherwise the reference stands alone under .decklight/.
const CLAUDE_REF = '.claude/skills/decklight/reference.md';
const SHARED_REF = '.decklight/reference.md';

// An agent target is: the label to print, the CLI `bin` to probe for
// auto-detection, and the `kind` of layout it wants — 'skill' is Claude's
// own .claude/skills/ format, 'agents' is the cross-agent AGENTS.md file.
export const TARGETS = {
  claude:   { label: 'Claude Code',   bin: 'claude',   kind: 'skill'  },
  codex:    { label: 'OpenAI Codex',  bin: 'codex',    kind: 'agents' },
  opencode: { label: 'OpenCode',      bin: 'opencode', kind: 'agents' },
  bob:      { label: 'IBM Bob',       bin: 'bob',      kind: 'agents' },
};

function fail(msg) {
  process.stderr.write(`decklight skills: ${msg}\n`);
  process.exit(1);
}

const HELP = `decklight skills — install the Decklight authoring skill for AI agents

Usage:
  decklight skills [agent…] [--dir path] [--all] [--force]

Agents:
${Object.entries(TARGETS).map(([k, t]) => `  ${k.padEnd(9)} ${t.label}`).join('\n')}

With no agent named, targets the ones detected on your PATH. Name one or
more explicitly (decklight skills claude codex) to override detection, or
--all to install for every supported agent.

Options:
  --dir <path>  target directory (default: current directory)
  --all         install for every supported agent
  --force       overwrite files that already exist (default: refuses to
                clobber a SKILL.md/reference.md; the AGENTS.md section is
                always refreshed in place, never duplicated)

Claude Code gets a real skill (.claude/skills/decklight/); Codex, OpenCode
and IBM Bob get a marked section in AGENTS.md. Both point at a reference
sliced from this version's SPEC.md, so the contract never drifts from the
installed runtime.
`;

/** The agents to target: an explicit list, everything (--all), or detected. */
function resolveTargets({ names, all, hasBin }) {
  if (all) return Object.keys(TARGETS);
  if (names.length) return names;
  const detected = Object.keys(TARGETS).filter((k) => hasBin(TARGETS[k].bin));
  if (detected.length) return { detected };
  return null;
}

function writeIfAbsent(root, file, content, force, written) {
  if (fs.existsSync(file) && !force) {
    const rel = path.relative(root, file) || path.relative('.', file) || file;
    fail(`${rel} already exists — pass --force to overwrite`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  written.push(path.relative(root, file) || file);
}

/** Add/refresh the marked Decklight block in AGENTS.md, in place. */
function mergeAgentsMd(root, refHref) {
  const agentsPath = path.join(root, 'AGENTS.md');
  const section = agentsSection(refHref);
  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, `# Agent notes\n\n${section}`);
    return 'created AGENTS.md';
  }
  const existing = fs.readFileSync(agentsPath, 'utf8');
  const markerRe = new RegExp(`${AGENTS_MARKER}[\\s\\S]*?${AGENTS_MARKER}\\n?`);
  if (markerRe.test(existing)) {
    fs.writeFileSync(agentsPath, existing.replace(markerRe, section));
    return 'refreshed the Decklight section in AGENTS.md';
  }
  fs.writeFileSync(agentsPath, existing.replace(/\n*$/, '\n\n') + section);
  return 'appended a Decklight section to AGENTS.md';
}

export async function skillsMain(argv = process.argv.slice(2), { hasBin = onPath } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  let dir = '.', all = false, force = false;
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') dir = argv[++i];
    else if (a === '--all') all = true;
    else if (a === '--force') force = true;
    else if (a.startsWith('-')) fail(`unknown argument: ${a}`);
    else if (TARGETS[a]) names.push(a);
    else fail(`unknown agent: ${a} (supported: ${Object.keys(TARGETS).join(', ')})`);
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

  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });

  const wantsClaude = targets.includes('claude');
  const mdAgents = targets.filter((k) => TARGETS[k].kind === 'agents');
  // one reference copy: Claude's skill dir when Claude is a target (it's the
  // self-contained skill's own file), else a standalone .decklight/ copy.
  const refHref = wantsClaude ? CLAUDE_REF : SHARED_REF;

  const written = [];
  if (wantsClaude) {
    const skillDir = path.join(root, '.claude', 'skills', 'decklight');
    writeIfAbsent(root, path.join(skillDir, 'SKILL.md'), claudeSkillMd(), force, written);
    writeIfAbsent(root, path.join(skillDir, 'reference.md'), referenceDoc(), force, written);
  }
  if (mdAgents.length) {
    if (!wantsClaude) {
      writeIfAbsent(root, path.join(root, SHARED_REF), referenceDoc(), force, written);
    }
    const note = mergeAgentsMd(root, refHref);
    written.push(note);
  }

  process.stdout.write(
    `installed the Decklight skill (v${PKG.version}) for ${targets.map((k) => TARGETS[k].label).join(', ')}\n`,
  );
  for (const w of written) process.stdout.write(`  ${w}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await skillsMain();
