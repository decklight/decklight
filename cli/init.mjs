#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight init — scaffold a starter deck, plus an agent skill so Claude
 * Code (and any AGENTS.md-reading agent) knows the authoring contract
 * without a web search or a guess from Reveal.js memory.
 *
 *   decklight init ["My Deck"] [-o deck.html] [--dir path] [--themes …]
 *                  [--from <template>] [--git | --no-git] [--open] [--force]
 *                  [--no-skill | --global-skill]
 *
 * Run bare in a terminal it asks one question — the deck's title — with
 * "My Deck" as the default; a title argument (or a non-TTY run) never prompts.
 * A terminal run is also asked where the skill should live: the project
 * (today's install, the default) or globally in each PATH-detected agent's
 * config home — the same files `decklight skills --global` installs.
 * --global-skill preselects global, --no-skill skips skill and question,
 * and a non-TTY run keeps the project install without asking.
 *
 * The deck is fully self-contained (runtime + every theme inlined, like
 * `decklight bundle --themes all` produces) — double-click it, it presents,
 * no sibling files, and the in-deck picker is fully stocked. Pass --themes to
 * ship a narrower set. The runtime blocks are marked data-decklight-runtime
 * so `decklight upgrade` can swap them for a newer installed version later.
 * The skill is regenerated every run (it's derived, not
 * authored content) so re-running after an upgrade refreshes it; the deck
 * file is only touched with --force.
 *
 * init ends like the start of an authoring session: outside a repository it
 * offers `git init` (the same question `decklight author` asks, at the natural
 * moment — the repo starts with the shared starter .gitignore), prints an
 * accent-colored epilogue — the deck's file:// URL and the `decklight author`
 * line, which is the command that starts editing. `--open` launches the deck
 * in the default browser (the file IS the presentation).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

import {
  PKG, PKG_ROOT, AGENTS_MARKER, agentsSection, claudeSkillMd, referenceDoc,
} from './skill-content.mjs';
import { THEMES_DIR, themeCss, runtimeCss, runtimeJs } from './pkg.mjs';
import { TARGETS, detectedTargets, installGlobalSkill, display } from './skills.mjs';
import { onPath } from './agents.mjs';
import { escapeHtml } from './edit.mjs';
import { inGitRepo, createRepo, isIdentityError, oneline } from './git.mjs';
import { makeFail, runMain } from './util.mjs';
import { isMain } from '../tools/args.mjs';

const fail = makeFail('init');

/**
 * Is this HTML a decklight deck, and which runtime does it carry?
 * Keys on the markers init itself writes — the `class="decklight"` stage div
 * plus the `Decklight.init(` call — and reads the version from the bundle's
 * `/*! Decklight vX.Y.Z … ` banner (stamped by build.mjs; minification makes
 * the exported const unfindable).
 *
 * @returns the runtime version string; `null` for a decklight deck whose
 *          version can't be extracted; `undefined` for a non-deck.
 */
export function deckRuntimeVersion(html) {
  const isDeck = /<[a-z][^>]*\bclass=["'](?:[^"']*\s)?decklight(?:\s[^"']*)?["']/i.test(html)
    && /Decklight\.init\s*\(/.test(html);
  if (!isDeck) return undefined;
  const banner = /\/\*!\s*Decklight v(\d+\.\d+\.\d+[^\s*]*)/.exec(html);
  return banner ? banner[1] : null;
}

// aurora is the deck's starting look; init ships every theme by default so the
// in-deck picker (/ → themes) is fully stocked, unless --themes narrows it.
const STARTER_THEME = 'aurora';

// 'all' → every shipped theme; otherwise a comma list of names (validated).
function resolveThemes(sel) {
  if (sel === 'all') {
    return fs.readdirSync(THEMES_DIR)
      .filter((f) => f.endsWith('.css'))
      .map((f) => f.slice(0, -4))
      .sort();
  }
  const names = sel.split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) fail('--themes: no theme names given');
  for (const n of names) {
    if (!fs.existsSync(path.join(THEMES_DIR, `${n}.css`))) {
      fail(`--themes: theme not found: ${n} (see themes/ for the full list)`);
    }
  }
  return names;
}

/**
 * The deck body for `--from <template>`: an installed template, or a refusal
 * that names how to install one (`UNITS#REST`).
 *
 * It **refuses rather than fetching**, and that is the point of the flag's
 * design. `init` scaffolds; installing is a separate, explicit act, exactly as
 * it is for `theme add` and `plugin add`. The alternative — resolve the name
 * in a catalog and download it right here — would make the one command people
 * run first into a command that reaches the network, and would do it on the
 * machine least likely to have been asked. So an uninstalled name is met with
 * the install line, and a name nothing offers is met with that instead.
 *
 * The lookup is cache-only, so this stays as offline as `init` has always been.
 */
export function templateDeck(name, { home, listInstalled, offered } = {}) {
  const found = listInstalled(name, home);
  if (found) return { ok: true, html: fs.readFileSync(found.path, 'utf8') };

  // Returns the refusal rather than exiting, the way planGit and planSkill
  // return a decision — the caller acts. A helper that ends the process is a
  // helper that can only be tested by starting one.
  const any = offered(home);
  const candidate = any.find((e) => e.name === name);
  if (candidate) {
    return { ok: false, message: `no template "${name}" installed — a registered marketplace offers it:\n`
      + `    decklight template add ${candidate.qualified}\n`
      + '  then run this again. Installing is its own step on purpose: init does not\n'
      + '  reach the network, and a scaffold command should not start now.' };
  }
  return { ok: false, message: `no template "${name}" installed, and no registered marketplace offers one`
    + (any.length ? `\n  available: ${any.map((e) => e.qualified).join(', ')}` : '')
    + '\n  decklight template list         — what is installed and what is offered'
    + '\n  decklight marketplace add <owner/repo>  — register a catalog to install from' };
}

/**
 * Put the title into a template's `<title>` and first `<h1>`, and nothing else.
 *
 * A template is someone's deck, so this is deliberately the smallest possible
 * edit: two substitutions that are true of every deck, rather than a
 * templating language that would make a template a program. Neither is
 * required — a template that wants its own title keeps it by not having an
 * `<h1>`, and the deck still scaffolds.
 */
export function titleTemplate(html, title) {
  const safe = escapeHtml(title);
  // A function replacement, not a string one: a title is user input and may
  // contain `$&` or `$1`, which a string replacement would expand into the
  // matched text instead of printing.
  const put = (_m, open, _inner, close) => open + safe + close;
  return html
    .replace(/(<title>)([\s\S]*?)(<\/title>)/i, put)
    .replace(/(<h1[^>]*>)([\s\S]*?)(<\/h1>)/i, put);
}

// No title argument: ask on a TTY (the one thing every run would have passed
// had the author known), scaffold the default silently everywhere else.
export async function resolveTitle(arg, { isTTY = false, ask } = {}) {
  if (arg != null) return arg || 'My Deck';
  if (!isTTY) return 'My Deck';
  const answer = (await ask('deck title [My Deck]: ')).trim();
  return answer || 'My Deck';
}

// ── git: offer the repository at the natural moment ─────────────────────────
// The same policy `decklight author` applies later, decided here as a pure
// function so the table (--git / --no-git / TTY / repo-present) is testable
// without a repository or a terminal.
export function planGit({ args = [], tty = false, inRepo = false } = {}) {
  if (args.includes('--no-git')) return { action: 'skip' };
  if (args.includes('--git')) return { action: inRepo ? 'skip' : 'create' };
  if (inRepo) return { action: 'skip' };
  return { action: tty ? 'ask' : 'hint' };
}

// ── the skill scope: project by default, global as a proposition ────────────
// The same shape as planGit: a pure decision table over flags and the TTY
// gate. --no-skill skips skill AND question, --global-skill preselects the
// global install (skills.mjs's machinery), a bare terminal run is asked, and
// a headless run keeps today's project install byte-for-byte.
export function planSkill({ args = [], tty = false } = {}) {
  if (args.includes('--no-skill')) return { action: 'skip' };
  if (args.includes('--global-skill')) return { action: 'global' };
  return { action: tty ? 'ask' : 'project' };
}

/**
 * Create the repository (via the shared createRepo seam, so it starts with
 * the starter .gitignore) and commit everything init just wrote. The deck is
 * the product: every failure is reported as a one-line note, never an exit.
 * No Signed-off-by and no identity fallback — the commit is the player's, so
 * a machine with no identity leaves the files staged and says so.
 */
export function initRepo(root, { exec = execFileSync, mkRepo = createRepo } = {}) {
  const git = (a) => exec('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let seeded = false;
  try { seeded = mkRepo(root); } catch (e) { return `  git: init failed — ${oneline(e)}`; }
  const created = `repository created${seeded ? ' (with a starter .gitignore)' : ''}`;
  try { git(['add', '-A']); } catch (e) { return `  git: add failed — ${oneline(e)}`; }
  try {
    git(['commit', '-m', 'decklight init']);
    return `  git: ${created}, everything committed`;
  } catch (e) {
    if (isIdentityError(e)) {
      return `  git: ${created}; no identity configured — files staged, commit once git config user.name/user.email is set`;
    }
    return `  git: commit failed — ${oneline(e)} (the files are staged)`;
  }
}

// ── epilogue: the player's next action, one click or one paste away ─────────
const ACCENT = '\x1b[36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** OSC 8 hyperlink — progressive enhancement: the URL is always the text. */
const osc8 = (url) => `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`;

/**
 * The colored "next steps" block init ends with. Pure: every environment
 * input is a parameter. Escape codes (color AND the OSC 8 link) appear only
 * on a TTY without NO_COLOR — piped output is plain text, and the raw URL is
 * always present so copy-paste works everywhere.
 */
export function epilogue({ deckPath, tty = false, noColor = false }) {
  const color = tty && !noColor;
  const a = (s) => (color ? `${ACCENT}${s}${RESET}` : s);
  const url = pathToFileURL(deckPath).href;
  const deck = path.relative('.', deckPath) || deckPath;
  return [
    '',
    `  ${a('open to present')}   ${color ? osc8(url) : url}`,
    `  ${a('start editing')}     decklight author ${deck}`,
    '',
  ].join('\n') + '\n';
}

// ── --open: hand the deck's file:// URL to the platform launcher ────────────

/**
 * Platform → launcher invocation for a URL, as pure data so it can be tested
 * without spawning anything. macOS ships `open`; Windows goes through cmd's
 * `start` builtin (the empty '' fills the window-title slot, or the URL would
 * become the title); everything else gets freedesktop's xdg-open. Zero new
 * dependencies by design.
 */
export function openCommand(platform, url) {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * Launch the default browser on the deck's file:// URL — the deck is
 * self-contained, so the file IS the presentation. Spawned detached with
 * stdio ignored (the dev.mjs idiom) so init exits promptly. A machine that
 * cannot launch (headless, no xdg-open) gets one dim line and a normal exit:
 * the deck was created, which is the product.
 */
export async function openDeck(deckPath, { platform = process.platform, spawnFn = spawn, out = process.stdout } = {}) {
  const url = pathToFileURL(deckPath).href;
  const { cmd, args } = openCommand(platform, url);
  const rel = path.relative('.', deckPath) || deckPath;
  const dim = (s) => (out.isTTY && !process.env.NO_COLOR ? `${DIM}${s}${RESET}` : s);
  const skipped = (err) =>
    out.write(dim(`--open: could not launch a browser (${cmd}: ${err.code ?? err.message}) — open ${rel} yourself\n`));
  await new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(cmd, args, { stdio: 'ignore', detached: true });
    } catch (err) { skipped(err); resolve(); return; }
    child.once('error', (err) => { skipped(err); resolve(); });
    child.once('spawn', () => {
      child.unref();
      out.write(`opening ${rel} in your default browser\n`);
      resolve();
    });
  });
}

function starterDeck(title, themeNames, activeTheme) {
  title = escapeHtml(title); // a prompt invites &, < and quotes
  const css = runtimeCss();
  // one <style data-theme> per theme; only the active one applies (the rest
  // carry media="not all", which the runtime's inline-theme mode toggles).
  const themeBlocks = themeNames.map((name) => {
    const theme = themeCss(name);
    const media = name === activeTheme ? '' : ' media="not all"';
    return `  <style data-theme="${name}"${media}>\n${theme}\n  </style>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style data-decklight-runtime="css">
${css}
  </style>
${themeBlocks}
</head>
<body>
  <div class="decklight">

    <section>
      <h1>${title}</h1>
      <p>Made with Decklight — press → to advance, ? for every key</p>
      <aside class="notes">
        <p>Welcome. This is the title slide — say a line or two about what this deck covers.</p>
      </aside>
    </section>

    <section>
      <h2>A slide with a build</h2>
      <ul data-build="fade-up">
        <li>One attribute on the container: <code>data-build</code></li>
        <li>Each direct child becomes one build step, in document order</li>
        <li>Speaker notes segment with ⟨CLICK⟩ to match — see below</li>
      </ul>
      <aside class="notes">
        <p>The container opts in and the engine does the rest — not a single class on the items themselves.</p>
        <p>⟨CLICK⟩</p>
        <p>Every press of the arrow reveals the next one, in order.</p>
        <p>⟨CLICK⟩</p>
        <p>And that's it — replace this slide's content, duplicate the section for more, and you have a deck.</p>
      </aside>
    </section>

  </div>
  <script data-decklight-runtime="js">${runtimeJs()}</script>
  <script>Decklight.init({});</script>
</body>
</html>
`;
}

export async function initMain(argv = process.argv.slice(2), { hasBin = onPath, env = process.env } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`decklight init — scaffold a starter deck + agent skill

Usage:
  decklight init ["Deck Title"] [-o deck.html] [--dir path] [--themes …]
                 [--from <template>] [--git | --no-git] [--open] [--force]
                 [--no-skill | --global-skill]

Options:
  -o <file>       deck output path (default: deck.html)
  --dir <path>    target directory (default: current directory)
  --from <name>   scaffold from an installed deck template instead of the
                  starter deck (decklight template list). The title argument
                  replaces the template's <title> and first <h1>; everything
                  else is the template's. Not installed? init names the
                  install command rather than fetching — installing is its own
                  step, and init does not reach the network.
                  Cannot be combined with --themes: a template brings its own.
  --themes <sel>  which themes to inline into the deck:
                    all           every shipped theme (default)
                    name,name,…   an explicit list (aurora stays active when
                                  included, else the first listed)
  --git           create a git repository (with a starter .gitignore) and
                  commit everything init wrote
                  (outside a repo + no flag: init ASKS on a TTY)
  --no-git        never touch git
  --open          open the scaffolded deck in your default browser
                  (the deck is self-contained — the file is the presentation)
  --force         overwrite an existing deck file (default: refuses)
  --no-skill      skip the agent skill entirely (project and global), and the
                  where-should-it-go question with it
  --global-skill  install the agent skill globally — into each PATH-detected
                  agent's config home (~/.claude, ~/.codex, …), exactly what
                  \`decklight skills --global\` installs — instead of into the
                  project; suppresses the question

Without a title argument, a terminal run asks for one (empty keeps "My Deck");
non-interactive runs scaffold "My Deck" without asking.

A terminal run is also asked where the skill should go ("where should the
skill go? [P/g]"): project — .claude/skills/decklight/ + AGENTS.md next to
the deck (Enter keeps it) — or global, each detected agent's config home.
Non-interactive runs keep the project install without asking.

Always writes/refreshes the skill files (they're generated from the
installed version's SPEC.md, so re-running after an upgrade updates them)
unless --no-skill is given. The deck file is only touched with --force.
`);
    return 0;
  }

  let title = null, outFile = 'deck.html', dir = '.', force = false, themesSel = 'all', openAfter = false;
  let from = null;
  const args = [...argv];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o') outFile = args[++i];
    else if (a === '--dir') dir = args[++i];
    else if (a === '--from') from = args[++i];
    else if (a === '--themes') themesSel = args[++i];
    else if (a === '--force') force = true;
    else if (a === '--open') openAfter = true;
    else if (a === '--no-skill' || a === '--global-skill') ; // consumed by planSkill below
    else if (a === '--git' || a === '--no-git') ; // consumed by planGit below
    else if (!a.startsWith('-')) title = title ?? a;
    else fail(`unknown argument: ${a}`);
  }
  if (argv.includes('--no-skill') && argv.includes('--global-skill')) {
    fail('--no-skill and --global-skill are mutually exclusive');
  }

  // ONE readline interface for every question this run asks (title, git,
  // handoff). Lines arriving BETWEEN questions (answers typed ahead) are
  // buffered — readline drops them otherwise — and EOF/Ctrl-D at any prompt
  // keeps the default / declines, never throws.
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = tty ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const typedAhead = [];
  rl?.on('line', (l) => typedAhead.push(l)); // only fires with no question pending
  let stdinGone = false;
  rl?.once('close', () => { stdinGone = true; });
  const question = (q) => {
    if (typedAhead.length) {
      const answer = typedAhead.shift();
      process.stdout.write(q + answer + '\n'); // the transcript still records the decision
      return Promise.resolve(answer);
    }
    if (!rl || stdinGone) return Promise.resolve('');
    // rl.question's promise never settles when the input ends mid-question
    // (observed on Node 20), so the close event doubles as the empty answer
    return new Promise((res) => {
      rl.once('close', () => res(''));
      rl.question(q).then(res, () => res(''));
    });
  };
  const askYes = async (q) => !/^n/i.test((await question(q)).trim());

  if (from && themesSel !== 'all') {
    // A template carries its own themes — it is a whole deck, not a body to
    // dress. Silently ignoring --themes would be the kind of no-op that gets
    // reported as a bug six months later.
    fail('--from and --themes are mutually exclusive — a template brings its own themes');
  }

  title = await resolveTitle(title, { isTTY: tty, ask: question });
  const themeNames = resolveThemes(from ? 'all' : themesSel);
  const activeTheme = themeNames.includes(STARTER_THEME) ? STARTER_THEME : themeNames[0];

  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });

  // status lines are dim so the epilogue's accent reads as THE next step
  const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
  const note = (s) => process.stdout.write(color ? `${DIM}${s}${RESET}\n` : `${s}\n`);

  const deckPath = path.resolve(root, outFile);
  if (fs.existsSync(deckPath) && !force) {
    const rel = path.relative('.', deckPath) || outFile;
    // a collision with a decklight deck almost always means "refresh my deck's
    // runtime", not "destroy my slides" — lead with upgrade, not --force
    const deckVer = deckRuntimeVersion(fs.readFileSync(deckPath, 'utf8'));
    if (deckVer !== undefined) {
      const versions = deckVer ? ` (deck has runtime ${deckVer}, installed is ${PKG.version})` : '';
      fail(`${rel} is already a decklight deck${versions}
  run \`decklight upgrade ${rel}\` to refresh its runtime and keep your slides,
  or pass --force to replace it with a fresh starter deck`);
    }
    fail(`${rel} already exists — pass --force to overwrite`);
  }
  let body, themeNote;
  if (from) {
    const { findUnit, catalogEntriesOfType } = await import('./units.mjs');
    const found = templateDeck(from, {
      listInstalled: (name, home) => findUnit('template', name, home),
      offered: (home) => catalogEntriesOfType('template', home),
    });
    if (!found.ok) fail(found.message);
    body = titleTemplate(found.html, title);
    themeNote = `from template ${from}`;
  } else {
    body = starterDeck(title, themeNames, activeTheme);
    themeNote = themeNames.length === 1
      ? `theme: ${themeNames[0]}`
      : `${themeNames.length} themes, ${activeTheme} active`;
  }
  fs.writeFileSync(deckPath, body);
  note(`created ${path.relative('.', deckPath) || outFile} (${themeNote})`);

  // ── the skill — project scope by default, global as a proposition ────────
  let skill = planSkill({ args: argv, tty }).action;
  if (skill === 'ask' || skill === 'global') {
    // global targets the PATH-detected set, exactly like bare `decklight
    // skills`; nothing detected falls back to Claude — init's existing bias
    const detected = detectedTargets(hasBin);
    const targets = detected.length ? detected : ['claude'];
    if (skill === 'ask') {
      const projDir = path.relative('.', path.join(root, '.claude', 'skills', 'decklight')) || '.';
      const homes = targets.map((k) => display(TARGETS[k].home(env))).join(', ');
      note('  the agent skill teaches AI coding agents how to author this deck. two scopes:');
      note(`    project (p)  ${projDir}/ + AGENTS.md — this directory only`);
      note(`    global  (g)  ${homes} — every project (${targets.map((k) => TARGETS[k].label).join(', ')})`);
      skill = /^g/i.test((await question('  where should the skill go? [P/g] ')).trim())
        ? 'global' : 'project';
    }
    // the skill is derived content (same rationale as the project refresh
    // below), so init forces past skills' clobber guard on a re-run
    if (skill === 'global') installGlobalSkill(targets, { env, force: true, detected: detected.length > 0 });
  }

  if (skill === 'project') {
    const skillDir = path.join(root, '.claude', 'skills', 'decklight');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), claudeSkillMd());
    fs.writeFileSync(path.join(skillDir, 'reference.md'), referenceDoc());
    note(`wrote .claude/skills/decklight/{SKILL.md,reference.md} (v${PKG.version})`);

    const agentsPath = path.join(root, 'AGENTS.md');
    const section = agentsSection();
    if (!fs.existsSync(agentsPath)) {
      fs.writeFileSync(agentsPath, `# Agent notes\n\n${section}`);
      note('created AGENTS.md');
    } else {
      const existing = fs.readFileSync(agentsPath, 'utf8');
      const markerRe = new RegExp(`${AGENTS_MARKER}[\\s\\S]*?${AGENTS_MARKER}\\n?`);
      if (markerRe.test(existing)) {
        fs.writeFileSync(agentsPath, existing.replace(markerRe, section));
        note('refreshed the Decklight section in AGENTS.md');
      } else {
        fs.writeFileSync(agentsPath, existing.replace(/\n*$/, '\n\n') + section);
        note('appended a Decklight section to AGENTS.md');
      }
    }
  }

  // ── the git offer — dev's question, asked at the natural moment ──────────
  const plan = planGit({ args: argv, tty, inRepo: inGitRepo(root) });
  let { action } = plan;
  if (action === 'ask') {
    action = (await askYes('  create a git repository so your edits are auto-committed? [Y/n] '))
      ? 'create' : 'skip';
  }
  if (action === 'create') {
    note(initRepo(root));
    // Stated, not asked: the mode is already the default, so a fifth prompt
    // would only offer what is on. The line names the flag that turns it off.
    note("  commits land one per agent edit, with the agent's own message"
      + ' (--git-mode timer for a plain cadence)');
  }
  else if (action === 'hint') note('  git: no repository here — pass --git to create one and auto-commit the deck');

  process.stdout.write(epilogue({ deckPath, tty: !!process.stdout.isTTY, noColor: !!process.env.NO_COLOR }));

  // last of the writes, so every "created/wrote" line is on screen before the
  // browser steals focus; opens the deck FILE, not a served URL — the deck is
  // self-contained by design
  if (openAfter) await openDeck(deckPath);

  // No handoff. init scaffolds and gets out of the way: the epilogue above
  // prints `decklight author <deck>` under "start editing", and that command IS
  // the handoff. Starting a server for you means init does not return until
  // you stop it — you cannot look at what it made, or read the lines it just
  // printed, without first killing something.
  rl?.close();
}

if (isMain(import.meta.url)) process.exitCode = await runMain('init', initMain);
