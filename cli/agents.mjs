// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The AI-agent roster for `decklight author` — which coding agents this machine
// can run, and how to hand one a single editing task without a TTY.
//
// Every entry is a one-shot, non-interactive invocation: the agent gets the
// instruction, edits the deck file in place, and exits. The dev server's file
// watcher then reloads every connected browser, and the pre-run snapshot goes
// on the same undo stack as the player's own edits — Z takes an agent's edit
// back exactly like a layout change.
//
// The roster is data: adding an agent is one entry (bin to probe + the args
// of its headless mode). Order is preference order — the first detected
// agent is the default when the player doesn't name one.

// The roster is EXTENSIBLE the same way (SPEC AGENT_UNITS): an agent unit is a
// reference — a JSON descriptor naming a binary you already installed and the
// argv of its headless mode — never code decklight downloads and runs. That is
// what keeps this list open without putting it in UNIT_PINNING's risk class:
// the three shapes below (`-p …`, `exec --full-auto …`, `run -t …`) are a
// small, closed vocabulary, and a template expresses all of them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { configHome } from './marketplace.mjs';
import { listUnits } from './units.mjs';

export const AGENTS = [
  {
    name: 'claude', label: 'Claude Code', bin: 'claude',
    // -p is print (headless) mode; acceptEdits lets it write the deck file
    // without an interactive approval it has no TTY to ask on.
    args: (prompt) => ['-p', prompt, '--permission-mode', 'acceptEdits'],
  },
  {
    name: 'codex', label: 'Codex CLI', bin: 'codex',
    // exec is the non-interactive subcommand; --full-auto keeps it inside
    // the workspace sandbox while allowing file writes.
    args: (prompt) => ['exec', '--full-auto', prompt],
  },
  {
    name: 'bob', label: 'IBM Bob', bin: 'bob',
    // -p is Bob Shell's non-interactive prompt mode; --accept-license keeps
    // it from hanging on the license prompt when there is no TTY.
    args: (prompt) => ['-p', prompt, '--accept-license'],
  },
  {
    name: 'gemini', label: 'Gemini CLI', bin: 'gemini',
    args: (prompt) => ['--yolo', '-p', prompt],
  },
  {
    name: 'copilot', label: 'GitHub Copilot CLI', bin: 'copilot',
    args: (prompt) => ['-p', prompt, '--allow-all-tools'],
  },
  {
    name: 'opencode', label: 'OpenCode', bin: 'opencode',
    args: (prompt) => ['run', prompt],
  },
  {
    name: 'goose', label: 'Goose', bin: 'goose',
    args: (prompt) => ['run', '-t', prompt],
  },
  {
    name: 'aider', label: 'Aider', bin: 'aider',
    // aider wants the file on the command line; --no-auto-commits because
    // dev's own autocommit (and the undo stack) owns history here.
    args: (prompt, deck) => ['--yes-always', '--no-auto-commits', '--message', prompt, deck],
  },
  {
    name: 'cursor', label: 'Cursor CLI', bin: 'cursor-agent',
    args: (prompt) => ['-p', prompt, '--force'],
  },
  {
    name: 'qwen', label: 'Qwen Code', bin: 'qwen',
    args: (prompt) => ['--yolo', '-p', prompt],
  },
];

/**
 * Fill an installed agent's argv template (SPEC `AGENT_UNITS`).
 *
 * The whole vocabulary: `{prompt}` and `{deck}`, each substituted into ONE
 * argv element. Never a shell string — the result is spawned as an argv
 * array, so an agent name or a deck path containing a space, a quote or a
 * semicolon is an argument and can never become a command.
 */
export function expandArgs(template, prompt, deck) {
  return template.map((a) => String(a)
    .replaceAll('{prompt}', prompt)
    .replaceAll('{deck}', deck ?? ''));
}

/**
 * Agents installed as units, as roster entries shaped like the built-ins.
 *
 * Read from the library, never the network — the same offline guarantee every
 * other `findUnit`/`listUnits` lookup keeps. An installed descriptor that is
 * malformed is SKIPPED rather than thrown on: a broken third-party entry must
 * not take `A` down for the built-in agents beside it.
 */
export function installedAgents(home = configHome()) {
  const out = [];
  for (const unit of listUnits('agent', home)) {
    try {
      const d = JSON.parse(readFileSync(unit.path, 'utf8'));
      if (typeof d.bin !== 'string' || !Array.isArray(d.args)) continue;
      out.push({
        name: unit.name,
        label: typeof d.label === 'string' && d.label ? d.label : unit.name,
        bin: d.bin,
        installed: true,
        args: (prompt, deck) => expandArgs(d.args, prompt, deck),
      });
    } catch { /* a descriptor we cannot read is one agent, not the roster */ }
  }
  return out;
}

/** Is `bin` runnable — an explicit path that exists, or a name on $PATH? */
export function onPath(bin, env = process.env) {
  if (!bin) return false;
  if (bin.includes('/')) return existsSync(bin);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(join(dir, bin + ext))) return true;
  }
  return false;
}

/**
 * Every agent this machine can actually run, in preference order.
 *
 * Built-ins first, then installed units (SPEC `AGENT_UNITS`) — a unit whose
 * name collides with a built-in is dropped rather than shadowing it, because
 * silently replacing how `claude` is invoked is not something a catalog
 * should be able to do to a machine.
 */
export function detectAgents({ env = process.env, hasBin = onPath, home } = {}) {
  const builtIn = AGENTS.filter((a) => hasBin(a.bin, env));
  const known = new Set(AGENTS.map((a) => a.name));
  const extra = installedAgents(home).filter((a) => !known.has(a.name) && hasBin(a.bin, env));
  return [...builtIn, ...extra];
}

// ── the remembered preference (#125) ───────────────────────────────────────

/** Where the preferred agent is remembered — beside the unit library. */
export const agentConfigPath = (home = configHome()) => join(home, 'agent.json');

/** The remembered agent's name, or null. A missing file is first-run. */
export function preferredAgent(home = configHome()) {
  try {
    const saved = JSON.parse(readFileSync(agentConfigPath(home), 'utf8'));
    return typeof saved?.preferred === 'string' ? saved.preferred : null;
  } catch { return null; }
}

/** Remember `name` as the agent `A` reaches for; `null` forgets it. */
export function setPreferredAgent(name, home = configHome()) {
  const file = agentConfigPath(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ preferred: name ?? null }, null, 2)}\n`);
  return file;
}

/**
 * Why `name` cannot be run, as a line naming the way out (#125).
 *
 * Never a silent fallback to a different agent: which agent edits your deck
 * is not a substitutable detail, and one that quietly changed under a
 * remembered preference would be the worst version of this feature.
 */
export function agentUnavailable(name, roster, home = configHome()) {
  const have = roster.length
    ? `available here: ${roster.map((a) => a.name).join(', ')}`
    : 'no agent CLI is detected on this machine';
  if (!name) return `${have} — install one (claude, codex, bob, …), or: decklight agent add <name>`;
  const known = AGENTS.some((a) => a.name === name) || installedAgents(home).some((a) => a.name === name);
  return known
    ? `"${name}" is known but its command is not on PATH — install it, or pick another (${have})`
    : `no agent named "${name}" — ${have}; a marketplace can teach decklight a new one: decklight agent add ${name}`;
}

/**
 * The exact spawn for one editing task: `name` picks the agent (or the first
 * detected one when omitted), `instruction` is the user's ask, `deck` the
 * file it should edit. Returns { bin, args, label } or null when the agent
 * isn't available.
 */
export function agentCommand(name, instruction, deck, { env = process.env, hasBin = onPath, home } = {}) {
  const roster = detectAgents({ env, hasBin, home });
  // Precedence, matching how every other saved choice resolves (PRESENTING):
  // an explicit name > the remembered preference > the first detected agent.
  // A remembered agent that is NOT available falls through to null rather
  // than to roster[0] — `agentUnavailable` then says which one is missing,
  // because a different agent silently editing your deck is worse than none.
  const wanted = name ?? preferredAgent(home);
  const agent = wanted ? roster.find((a) => a.name === wanted) : roster[0];
  if (!agent) return null;
  const prompt = `Edit the Decklight deck file "${deck}" — a single-file HTML presentation ` +
    '(one top-level <section> per slide; see SPEC.md or the decklight skill if present). ' +
    `Apply this change, editing the file in place: ${instruction}`;
  return { bin: agent.bin, args: agent.args(prompt, deck), label: agent.label, name: agent.name };
}
