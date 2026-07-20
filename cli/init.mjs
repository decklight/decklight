#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight init — scaffold a starter deck, plus an agent skill so Claude
 * Code (and any AGENTS.md-reading agent) knows the authoring contract
 * without a web search or a guess from Reveal.js memory.
 *
 *   decklight init ["My Deck"] [-o deck.html] [--dir path] [--themes …]
 *                  [--git | --no-git] [--open] [--force] [--no-skill]
 *
 * Run bare in a terminal it asks one question — the deck's title — with
 * "My Deck" as the default; a title argument (or a non-TTY run) never prompts.
 *
 * The deck is fully self-contained (runtime + every theme inlined, like
 * `decklight bundle --themes all` produces) — double-click it, it presents,
 * no sibling files, and the in-deck picker is fully stocked. Pass --themes to
 * ship a narrower set. The skill is regenerated every run (it's derived, not
 * authored content) so re-running after an upgrade refreshes it; the deck
 * file is only touched with --force.
 *
 * init ends like the start of an authoring session: outside a repository it
 * offers `git init` (the same question `decklight dev` asks, at the natural
 * moment — the repo starts with the shared starter .gitignore), prints an
 * accent-colored epilogue — the deck's file:// URL and the `decklight dev`
 * line — and on a TTY offers to hand off to dev right away. `--open` launches
 * the deck in the default browser (the file IS the presentation).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

import {
  PKG, PKG_ROOT, AGENTS_MARKER, agentsSection, claudeSkillMd, referenceDoc,
} from './skill-content.mjs';
import { escapeHtml, inGitRepo, createRepo } from './edit.mjs';

const CLI = fileURLToPath(new URL('./decklight.mjs', import.meta.url));

function fail(msg) {
  process.stderr.write(`decklight init: ${msg}\n`);
  process.exit(1);
}

const scriptSafe = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\u0021--');

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
const THEMES_DIR = path.join(PKG_ROOT, 'themes');

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

// No title argument: ask on a TTY (the one thing every run would have passed
// had the author known), scaffold the default silently everywhere else.
export async function resolveTitle(arg, { isTTY = false, ask } = {}) {
  if (arg != null) return arg || 'My Deck';
  if (!isTTY) return 'My Deck';
  const answer = (await ask('deck title [My Deck]: ')).trim();
  return answer || 'My Deck';
}

// ── git: offer the repository at the natural moment ─────────────────────────
// The same policy `decklight dev` applies later, decided here as a pure
// function so the table (--git / --no-git / TTY / repo-present) is testable
// without a repository or a terminal. `forward` is what the dev handoff
// passes down so the player is never asked the git question twice.
export function planGit({ args = [], tty = false, inRepo = false } = {}) {
  if (args.includes('--no-git')) return { action: 'skip', forward: '--no-git' };
  if (args.includes('--git')) return { action: inRepo ? 'skip' : 'create', forward: '--git' };
  if (inRepo) return { action: 'skip', forward: null };
  return { action: tty ? 'ask' : 'hint', forward: null };
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
  const oneline = (e) => String(e.stderr || e.message || e).replace(/\s+/g, ' ').trim().slice(0, 160);
  let seeded = false;
  try { seeded = mkRepo(root); } catch (e) { return `  git: init failed — ${oneline(e)}`; }
  const created = `repository created${seeded ? ' (with a starter .gitignore)' : ''}`;
  try { git(['add', '-A']); } catch (e) { return `  git: add failed — ${oneline(e)}`; }
  try {
    git(['commit', '-m', 'decklight init']);
    return `  git: ${created}, everything committed`;
  } catch (e) {
    if (/user\.(name|email)|tell me who you are|auto-detect/i.test(String(e.stderr || e))) {
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
    `  ${a('start editing')}     decklight dev ${deck}`,
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
  const css = fs.readFileSync(path.join(PKG_ROOT, 'dist/decklight.css'), 'utf8');
  // one <style data-theme> per theme; only the active one applies (the rest
  // carry media="not all", which the runtime's inline-theme mode toggles).
  const themeBlocks = themeNames.map((name) => {
    const theme = fs.readFileSync(path.join(THEMES_DIR, `${name}.css`), 'utf8');
    const media = name === activeTheme ? '' : ' media="not all"';
    return `  <style data-theme="${name}"${media}>\n${theme}\n  </style>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
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
  <script>${scriptSafe(fs.readFileSync(path.join(PKG_ROOT, 'dist/decklight.js'), 'utf8').replace(/\/\/# sourceMappingURL=.*$/m, ''))}</script>
  <script>Decklight.init({});</script>
</body>
</html>
`;
}

export async function initMain(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`decklight init — scaffold a starter deck + agent skill

Usage:
  decklight init ["Deck Title"] [-o deck.html] [--dir path] [--themes …]
                 [--git | --no-git] [--open] [--force] [--no-skill]

Options:
  -o <file>       deck output path (default: deck.html)
  --dir <path>    target directory (default: current directory)
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
  --no-skill      skip .claude/skills/decklight/ and AGENTS.md

Without a title argument, a terminal run asks for one (empty keeps "My Deck");
non-interactive runs scaffold "My Deck" without asking.

Always writes/refreshes the skill files (they're generated from the
installed version's SPEC.md, so re-running after an upgrade updates them)
unless --no-skill is given. The deck file is only touched with --force.
`);
    process.exit(0);
  }

  let title = null, outFile = 'deck.html', dir = '.', force = false, withSkill = true, themesSel = 'all', openAfter = false;
  const args = [...argv];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o') outFile = args[++i];
    else if (a === '--dir') dir = args[++i];
    else if (a === '--themes') themesSel = args[++i];
    else if (a === '--force') force = true;
    else if (a === '--open') openAfter = true;
    else if (a === '--no-skill') withSkill = false;
    else if (a === '--git' || a === '--no-git') ; // consumed by planGit below
    else if (!a.startsWith('-')) title = title ?? a;
    else fail(`unknown argument: ${a}`);
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

  title = await resolveTitle(title, { isTTY: tty, ask: question });
  const themeNames = resolveThemes(themesSel);
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
  fs.writeFileSync(deckPath, starterDeck(title, themeNames, activeTheme));
  const themeNote = themeNames.length === 1
    ? `theme: ${themeNames[0]}`
    : `${themeNames.length} themes, ${activeTheme} active`;
  note(`created ${path.relative('.', deckPath) || outFile} (${themeNote})`);

  if (withSkill) {
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
  let { action, forward } = plan;
  if (action === 'ask') {
    forward = (await askYes('  create a git repository so your edits are auto-committed? [Y/n] '))
      ? '--git' : '--no-git';
    action = forward === '--git' ? 'create' : 'skip';
  }
  if (action === 'create') note(initRepo(root));
  else if (action === 'hint') note('  git: no repository here — pass --git to create one and auto-commit the deck');

  process.stdout.write(epilogue({ deckPath, tty: !!process.stdout.isTTY, noColor: !!process.env.NO_COLOR }));

  // last of the writes, so every "created/wrote" line is on screen before the
  // browser steals focus; opens the deck FILE, not a served URL — the deck is
  // self-contained by design
  if (openAfter) await openDeck(deckPath);

  // ── the handoff — the served URL is the genuine click-to-edit link ───────
  const editNow = tty && await askYes('start editing now? [Y/n] ');
  rl?.close();
  if (editNow) {
    const child = spawn(process.execPath,
      [CLI, 'dev', path.relative(root, deckPath), ...(forward ? [forward] : [])],
      { cwd: root, stdio: 'inherit' });
    process.exitCode = await new Promise((res) => child.on('exit', (code) => res(code ?? 0)));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await initMain();
