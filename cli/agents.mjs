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
import path, { dirname, join } from 'node:path';
import { configHome } from './marketplace.mjs';
import { listUnits } from './units.mjs';

export const AGENTS = [
  {
    name: 'claude', label: 'Claude Code', bin: 'claude',
    // -p is print (headless) mode; acceptEdits lets it write the deck file
    // without an interactive approval it has no TTY to ask on.
    args: (prompt) => ['-p', prompt, '--permission-mode', 'acceptEdits'],
    // no --permission-mode: an ASK is read-only by construction, and a
    // commit-message call has no business being able to edit the deck.
    ask: (prompt) => ['-p', prompt],
  },
  {
    name: 'codex', label: 'Codex CLI', bin: 'codex',
    // exec is the non-interactive subcommand; --full-auto keeps it inside
    // the workspace sandbox while allowing file writes.
    args: (prompt) => ['exec', '--full-auto', prompt],
    ask: (prompt) => ['exec', '--sandbox', 'read-only', prompt],
  },
  {
    name: 'bob', label: 'IBM Bob', bin: 'bob',
    // -p is Bob Shell's non-interactive prompt mode; --accept-license keeps
    // it from hanging on the license prompt when there is no TTY.
    args: (prompt) => ['-p', prompt, '--accept-license'],
    ask: (prompt) => ['-p', prompt, '--accept-license'],
  },
  {
    name: 'gemini', label: 'Gemini CLI', bin: 'gemini',
    args: (prompt) => ['--yolo', '-p', prompt],
    ask: (prompt) => ['-p', prompt],
  },
  {
    name: 'copilot', label: 'GitHub Copilot CLI', bin: 'copilot',
    args: (prompt) => ['-p', prompt, '--allow-all-tools'],
    ask: (prompt) => ['-p', prompt],
  },
  {
    name: 'opencode', label: 'OpenCode', bin: 'opencode',
    args: (prompt) => ['run', prompt],
    ask: (prompt) => ['run', prompt],
  },
  {
    name: 'goose', label: 'Goose', bin: 'goose',
    args: (prompt) => ['run', '-t', prompt],
    ask: (prompt) => ['run', '-t', prompt],
  },
  {
    name: 'aider', label: 'Aider', bin: 'aider',
    // aider wants the file on the command line; --no-auto-commits because
    // dev's own autocommit (and the undo stack) owns history here.
    args: (prompt, deck) => ['--yes-always', '--no-auto-commits', '--message', prompt, deck],
    // no deck on the command line either: aider edits what it is given
    ask: (prompt) => ['--yes-always', '--no-auto-commits', '--message', prompt],
  },
  {
    name: 'cursor', label: 'Cursor CLI', bin: 'cursor-agent',
    args: (prompt) => ['-p', prompt, '--force'],
    ask: (prompt) => ['-p', prompt],
  },
  {
    name: 'qwen', label: 'Qwen Code', bin: 'qwen',
    args: (prompt) => ['--yolo', '-p', prompt],
    ask: (prompt) => ['-p', prompt],
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

/**
 * Where `bin` resolves — the file $PATH would find, or null.
 *
 * The Windows extension list is the one Windows itself searches, in its order,
 * and the empty string is in it because a unit descriptor may name a file that
 * genuinely has no extension. WHICH one matched is the thing this returns and
 * `onPath` throws away, and it is exactly what `spawnSpec` below needs.
 */
export function whichBin(bin, env = process.env, platform = process.platform, exists = existsSync) {
  if (!bin) return null;
  // An explicit path, spelled either way — a Windows one carries backslashes,
  // and treating it as a bare name would send it looking down $PATH instead.
  if (bin.includes('/') || bin.includes('\\')) return exists(bin) ? bin : null;
  // PATH, whatever the case of the variable: Windows spells it `Path`, and a
  // child env built by hand may carry either.
  const list = env.PATH ?? env.Path ?? env.path ?? '';
  // The path grammar of the platform being DESCRIBED, not the one running —
  // test/soak-platform.mjs learned this the hard way. The host's `join` and
  // `delimiter` would split a Windows PATH on `:` (cutting `C:` off the drive)
  // and answer in the wrong separator, from a function whose whole contract is
  // to be pure over its `platform` argument.
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of list.split(p.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = p.join(dir, bin + ext);
      if (exists(file)) return file;
    }
  }
  return null;
}

/** Is `bin` on this machine at all? Detection, not runnability — see `canRun`. */
export function onPath(bin, env = process.env) {
  return whichBin(bin, env) !== null;
}

/**
 * The JS file a `.cmd`/`.bat` shim runs, or null if it does not run one.
 *
 * npm installs every JS CLI on Windows as a generated batch shim whose last
 * line hands a script to node; `npx`, `pnpm` and this repo's own test stubs
 * write the same shape with different spelling. So rather than pattern-match
 * one vendor's template, this takes every JS-looking token in the file, expands
 * whichever "the directory I am in" spelling it uses (`%~dp0`, `%dp0%`,
 * `$basedir`), and returns the first that is really there. A batch file that
 * names no such script is not a shim, and gets null.
 */
export function shimTarget(text, dir, { exists = existsSync, platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  for (const m of String(text).matchAll(/(?:"([^"\r\n]+?\.[cm]?js)"|(\S+?\.[cm]?js))(?=["\s]|$)/gi)) {
    const token = (m[1] ?? m[2])
      .replaceAll(/%~dp0\\?|%dp0%\\?|\$basedir\//gi, `${dir}${p.sep}`)
      .replaceAll('"', '');
    const file = p.resolve(dir, token);
    // The existence check is what makes the loose match safe: npm's own
    // template mentions `.JS` in a PATHEXT edit several lines above the one
    // that matters, and no such file is ever on disk.
    if (exists(file)) return file;
  }
  return null;
}

/**
 * How to spawn `bin` AS ARGV — `{ bin, prefix }` — or null when this machine
 * cannot run it that way.
 *
 * The whole point is that `shell` is never part of the answer. Since
 * CVE-2024-27980 Node refuses to spawn a `.cmd` or `.bat` without `shell:
 * true`, and turning that on would stop the arguments being arguments: they
 * become one command line for `cmd.exe` to re-split, and one of them is the
 * user's PROMPT — untrusted text that may hold `"`, `&`, `|`, `^` or `%VAR%`.
 * `cmd.exe` quoting cannot make that safe (percent expansion happens before
 * any escaping the caller can do), so decklight does not try: it resolves the
 * shim to the script it would have run and spawns node on it directly. argv
 * stays argv, on both platforms, and a prompt is never anything but one
 * argument.
 *
 * A `.cmd` that is a real batch program rather than a shim resolves to null —
 * DETECTED BUT NOT RUNNABLE is the state #307 is about, and reporting it as
 * available is what made it a bug rather than a gap.
 */
export function spawnSpec(bin, {
  env = process.env, platform = process.platform, node = process.execPath,
  read = (f) => readFileSync(f, 'utf8'), exists = existsSync,
} = {}) {
  const found = whichBin(bin, env, platform, exists);
  if (!found) return null;
  // POSIX is untouched: the name goes to spawn exactly as it always did, so
  // $PATH resolution, shebangs and argv all behave as before.
  if (platform !== 'win32') return { bin, prefix: [] };
  const p = path.win32;
  if (!/\.(cmd|bat)$/i.test(found)) return { bin: found, prefix: [] };
  let target = null;
  try { target = shimTarget(read(found), p.dirname(found), { exists, platform }); } catch { /* unreadable */ }
  return target ? { bin: node, prefix: [target] } : null;
}

/** Can an agent whose command is `bin` actually be run here? */
export const canRun = (bin, env = process.env) => spawnSpec(bin, { env }) !== null;

/**
 * Every agent this machine can actually run, in preference order.
 *
 * Built-ins first, then installed units (SPEC `AGENT_UNITS`) — a unit whose
 * name collides with a built-in is dropped rather than shadowing it, because
 * silently replacing how `claude` is invoked is not something a catalog
 * should be able to do to a machine.
 */
export function detectAgents({ env = process.env, hasBin = canRun, home } = {}) {
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
export function agentUnavailable(name, roster, home = configHome(),
  { env = process.env, spec = spawnSpec, platform = process.platform, exists = existsSync } = {}) {
  const have = roster.length
    ? `available here: ${roster.map((a) => a.name).join(', ')}`
    : 'no agent CLI is detected on this machine';
  if (!name) return `${have} — install one (claude, codex, bob, …), or: decklight agent add <name>`;
  const entry = AGENTS.find((a) => a.name === name) ?? installedAgents(home).find((a) => a.name === name);
  if (!entry) return `no agent named "${name}" — ${have}; a marketplace can teach decklight a new one: decklight agent add ${name}`;
  // Found but not runnable is its own answer, and it names the reason rather
  // than the symptom: telling someone their agent "is not on PATH" while
  // `where claude` prints a path is how #307 stayed invisible.
  const where = whichBin(entry.bin, env, platform, exists);
  if (where && !spec(entry.bin, { env, platform, exists })) {
    return `"${name}" is installed at ${where}, but decklight cannot run it as a program: `
      + 'that file is a batch shim and the script it runs cannot be found. '
      + 'decklight will not hand your prompt to cmd.exe instead — reinstall the agent, '
      + `or point one at its real entry point: decklight agent add ${name}`;
  }
  return `"${name}" is known but its command is not on PATH — install it, or pick another (${have})`;
}

/**
 * The exact spawn for one editing task: `name` picks the agent (or the first
 * detected one when omitted), `instruction` is the user's ask, `deck` the
 * file it should edit. Returns { bin, args, label } or null when the agent
 * isn't available.
 */
/**
 * The same agent, asked a QUESTION rather than told to edit (SPEC `PRESENTING`).
 *
 * Two things differ from `agentCommand` and both matter. There is no
 * deck-editing preamble — the prompt is passed through verbatim, because the
 * caller is asking about a diff, not about a file. And the argv comes from the
 * agent's `ask` template, which drops every write permission the edit path
 * turns on: `claude` loses `--permission-mode acceptEdits`, `codex` gains
 * `--sandbox read-only`, `aider` is handed no deck at all. An agent invoked to
 * write a commit message has no business being able to change what it is
 * describing.
 *
 * Falls back to the edit argv for an INSTALLED agent (SPEC `AGENT_UNITS`),
 * whose unit declares one template and cannot be asked for a second — noted
 * rather than hidden, since it is the one path here that stays writable.
 */
export function agentAsk(name, prompt, { env = process.env, hasBin = canRun, home, spec = spawnSpec } = {}) {
  const roster = detectAgents({ env, hasBin, home });
  const wanted = name ?? preferredAgent(home);
  const agent = wanted ? roster.find((a) => a.name === wanted) : roster[0];
  if (!agent) return null;
  const how = spec(agent.bin, { env }) ?? { bin: agent.bin, prefix: [] };
  const build = agent.ask ?? agent.args;
  return {
    bin: how.bin,
    args: [...how.prefix, ...build(prompt)],
    label: agent.label,
    name: agent.name,
    readOnly: !!agent.ask,
  };
}

export function agentCommand(name, instruction, deck, { env = process.env, hasBin = canRun, home, spec = spawnSpec } = {}) {
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
  // The spawn spec, not the bare name: on Windows an npm-installed agent is a
  // batch shim, and `prefix` is the script node has to be handed for the
  // arguments below to stay arguments (#307). On POSIX it is empty and this is
  // the same command it always was.
  const how = spec(agent.bin, { env }) ?? { bin: agent.bin, prefix: [] };
  return {
    bin: how.bin,
    args: [...how.prefix, ...agent.args(prompt, deck)],
    label: agent.label,
    name: agent.name,
  };
}
