// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The AI-agent roster for `decklight dev` — which coding agents this machine
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

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

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

/** The subset of AGENTS this machine can actually run, in preference order. */
export function detectAgents({ env = process.env, hasBin = onPath } = {}) {
  return AGENTS.filter((a) => hasBin(a.bin, env));
}

/**
 * The exact spawn for one editing task: `name` picks the agent (or the first
 * detected one when omitted), `instruction` is the user's ask, `deck` the
 * file it should edit. Returns { bin, args, label } or null when the agent
 * isn't available.
 */
export function agentCommand(name, instruction, deck, { env = process.env, hasBin = onPath } = {}) {
  const roster = detectAgents({ env, hasBin });
  const agent = name ? roster.find((a) => a.name === name) : roster[0];
  if (!agent) return null;
  const prompt = `Edit the Decklight deck file "${deck}" — a single-file HTML presentation ` +
    '(one top-level <section> per slide; see SPEC.md or the decklight skill if present). ' +
    `Apply this change, editing the file in place: ${instruction}`;
  return { bin: agent.bin, args: agent.args(prompt, deck), label: agent.label, name: agent.name };
}
