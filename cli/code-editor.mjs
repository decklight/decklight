// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The author's code editor (PRESENTING_EDITING, Open in your editor): which
// one, where it is on this machine, and the argument list that opens a file
// at a line and a column in it.
//
// The command that runs is never the request's. It is built here from the
// author's saved choice and the deck being served, and it is spawned as an
// argument array with no shell, so a file name, a line or a template's words
// are always arguments and never a command line for a shell to re-split.
//
// The choice is remembered beside the voice settings (tools/tts-setup.mjs:
// ~/.config/decklight/, $XDG_CONFIG_HOME honoured), in editor.json:
//
//   { "editor": "vscode" | "cursor" | "zed" | "env" }
//   { "editor": "custom", "template": "myedit --line {line} {file}" }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import path, { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { ttsConfigPath } from '../tools/tts-setup.mjs';
import { whichBin } from './agents.mjs';

/** `file:line:column`, the address the VS Code family, Zed and Sublime Text read. */
const at = (f, l, c) => `${f}:${l}:${c}`;
const GOTO = (f, l, c) => ['-g', at(f, l, c)];
const PLAIN = (f, l, c) => [at(f, l, c)];

/**
 * The editors offered by name. `apps` are where macOS keeps each one's command
 * line tool inside its app bundle, for the common case of an editor installed
 * without its "shell command" put on PATH.
 */
export const EDITORS = [
  { id: 'vscode', label: 'VS Code', bin: 'code', args: GOTO,
    apps: ['Visual Studio Code.app/Contents/Resources/app/bin/code'] },
  { id: 'cursor', label: 'Cursor', bin: 'cursor', args: GOTO,
    apps: ['Cursor.app/Contents/Resources/app/bin/cursor'] },
  { id: 'zed', label: 'Zed', bin: 'zed', args: PLAIN,
    apps: ['Zed.app/Contents/MacOS/cli', 'Zed Preview.app/Contents/MacOS/cli'] },
];

/** $VISUAL / $EDITOR programs that open a window of their own, and how each is sent to a line. */
const GUI = {
  code: { label: 'VS Code', args: GOTO },
  'code-insiders': { label: 'VS Code Insiders', args: GOTO },
  codium: { label: 'VSCodium', args: GOTO },
  cursor: { label: 'Cursor', args: GOTO },
  windsurf: { label: 'Windsurf', args: GOTO },
  zed: { label: 'Zed', args: PLAIN },
  subl: { label: 'Sublime Text', args: PLAIN },
  mate: { label: 'TextMate', args: (f, l, c) => ['-l', `${l}:${c}`, f] },
};
/** Programs that need a terminal to draw in, which a server in the background does not have. */
const TERMINAL = new Set(['vi', 'vim', 'nvim', 'view', 'nano', 'pico', 'micro', 'hx', 'helix', 'kak', 'joe', 'ne', 'ed', 'mg', 'emacs', 'jed', 'vis']);
/** The flags that make an editor hold its caller until the file is closed: nobody here is waiting. */
const WAIT_FLAGS = new Set(['-w', '--wait', '-W']);

/** The three placeholders a template may carry. */
const PLACEHOLDERS = /\{(file|line|column)\}/g;

// ── the remembered choice ─────────────────────────────────────────────────

/** editor.json, beside tts.json: ~/.config/decklight/editor.json, $XDG_CONFIG_HOME honoured. */
export const editorConfigPath = (env = process.env) => join(dirname(ttsConfigPath(env)), 'editor.json');

/** The saved choice, or null: a missing, unreadable or malformed file is first use. */
export function loadEditorChoice(env = process.env) {
  let saved;
  try { saved = JSON.parse(readFileSync(editorConfigPath(env), 'utf8')); } catch { return null; }
  try { return checkChoice(saved); } catch { return null; }
}

/** Remember `choice` (checked first: a bad one is a throw, never a file); null forgets it. */
export function saveEditorChoice(choice, env = process.env) {
  const file = editorConfigPath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(choice === null ? {} : checkChoice(choice), null, 2)}\n`);
  return file;
}

/** `{ editor, template? }` if it is a choice this module can act on, or a throw that says why. */
export function checkChoice(choice) {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new Error('no editor named');
  const { editor } = choice;
  if (EDITORS.some((e) => e.id === editor) || editor === 'env') return { editor };
  if (editor !== 'custom') throw new Error(`no editor called ${JSON.stringify(String(editor)).slice(0, 40)}`);
  parseTemplate(choice.template);
  return { editor, template: choice.template.trim() };
}

// ── a command of your own ─────────────────────────────────────────────────

/**
 * A template's words, the way a shell would split them for the simple cases
 * (spaces, and "double" or 'single' quotes around a word with spaces), but
 * never handed to one. The first word is the program; `{file}` must be
 * somewhere, and the program itself carries no placeholder.
 */
export function parseTemplate(template) {
  if (typeof template !== 'string' || !template.trim()) throw new Error('the command is empty');
  if (template.length > 500) throw new Error('the command is too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(template)) throw new Error('the command is one line, with no control characters');
  const words = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(template); m; m = re.exec(template)) words.push(m[1] ?? m[2] ?? m[3]);
  if (/["']/.test(template.replace(/"[^"]*"|'[^']*'/g, ''))) throw new Error('a quote in the command is not closed');
  if (!words.length) throw new Error('the command is empty');
  if (/\{(file|line|column)\}/.test(words[0])) throw new Error('the command must start with a program, not a placeholder');
  if (!words.some((w) => w.includes('{file}'))) throw new Error('the command must say where the file goes: {file}');
  return words;
}

/** The template's words with `{file}`, `{line}` and `{column}` filled in, one argument each word. */
export const fillTemplate = (words, { file, line, column }) =>
  words.map((w) => w.replace(PLACEHOLDERS, (_, k) => String({ file, line, column }[k])));

/** A command line read as words (no shell), quotes kept off: for $VISUAL and $EDITOR. */
const splitWords = (s) => [...String(s).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

// ── $VISUAL / $EDITOR ─────────────────────────────────────────────────────

/** The program a path names, without a Windows extension: `/usr/local/bin/code` and `code.cmd` are `code`. */
const programName = (bin) => path.basename(String(bin).replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

/**
 * What $VISUAL (else $EDITOR) names, and whether it can be sent to a line
 * from here: `{ name, value, program, words, label, gui?, blocked? }`, or
 * null when neither is set. A terminal editor is `blocked` with the reason;
 * it is never run and left to fail where nobody can see it.
 */
export function envEditor(env = process.env) {
  const name = env.VISUAL?.trim() ? 'VISUAL' : env.EDITOR?.trim() ? 'EDITOR' : null;
  if (!name) return null;
  const value = env[name].trim();
  const [program, ...rest] = splitWords(value);
  const words = rest.filter((w) => !WAIT_FLAGS.has(w));
  const prog = programName(program);
  const gui = GUI[prog] ?? null;
  const label = `${gui?.label ?? prog} ($${name})`;
  const blocked = gui ? null
    : TERMINAL.has(prog) ? `${prog} runs in a terminal, and the deck's server has none to open it in`
      : `decklight does not know how to send ${prog} to a line`;
  return { name, value, program, words, label, gui, blocked };
}

// ── where each one is ─────────────────────────────────────────────────────

/** The app bundles' own command line tools, macOS only: /Applications and ~/Applications. */
function appPath(editor, { env, platform, exists }) {
  if (platform !== 'darwin') return null;
  const home = env.HOME || homedir();
  // posix joins throughout: these are macOS paths whatever machine is asking (the
  // host's own join wrote ~\Applications on Windows, and nothing was found there)
  for (const base of ['/Applications', path.posix.join(home, 'Applications')]) {
    for (const rel of editor.apps ?? []) {
      const file = path.posix.join(base, rel);
      if (exists(file)) return file;
    }
  }
  return null;
}

/** Where `editor` runs from here: on PATH first, else its app bundle; null when it is not installed. */
export function locate(editor, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const onPath = whichBin(editor.bin, env, platform, exists);
  if (onPath) return { bin: onPath, where: 'PATH' };
  const app = appPath(editor, { env, platform, exists });
  return app ? { bin: app, where: 'app' } : null;
}

/**
 * What the chooser lists: the named editors this machine has, then what
 * $VISUAL or $EDITOR names (blocked, with the reason, when it cannot be
 * sent to a line), then a command of your own. `[{ id, label, note?,
 * blocked? }]`; nothing here is a path to run.
 */
export function detectEditors({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const out = [];
  for (const e of EDITORS) {
    const found = locate(e, { env, platform, exists });
    if (found) out.push({ id: e.id, label: e.label, ...(found.where === 'app' ? { note: 'from its app' } : {}) });
  }
  const own = envEditor(env);
  // its label names the program, never the variable's whole value: the page needs no more of the server's environment
  if (own) out.push({ id: 'env', label: own.label, ...(own.blocked ? { blocked: own.blocked } : {}) });
  out.push({ id: 'custom', label: 'A command of your own…', note: 'with {file}, {line} and {column}' });
  return out;
}

/** The label a saved choice reads as, for the page. */
export function choiceLabel(choice, { env = process.env } = {}) {
  if (!choice) return null;
  if (choice.editor === 'custom') return `your command (${programName(parseTemplate(choice.template)[0])})`;
  if (choice.editor === 'env') return envEditor(env)?.label ?? '$VISUAL or $EDITOR';
  return EDITORS.find((e) => e.id === choice.editor)?.label ?? choice.editor;
}

// ── the command ───────────────────────────────────────────────────────────

/** The app a VS Code-style `bin\<name>.cmd` shim starts, by the shim's name. */
const ELECTRON_EXE = { code: 'Code.exe', cursor: 'Cursor.exe' };

/**
 * What a Windows VS Code or Cursor shim (`<install>\bin\code.cmd`) runs,
 * without cmd.exe: the app (`<install>\Code.exe`) as node, on its CLI script
 * (`<install>\resources\app\out\cli.js`), which is what the shim does
 * with ELECTRON_RUN_AS_NODE set. `{ exe, cli }`, or null when the shim is not
 * one of theirs or either file is not where that layout puts it.
 */
export function electronShim(cmd, { exists = existsSync } = {}) {
  const w = path.win32;
  const exeName = ELECTRON_EXE[programName(cmd)];
  if (!exeName || w.basename(w.dirname(cmd)).toLowerCase() !== 'bin') return null;
  const install = w.dirname(w.dirname(cmd));
  // Cursor has kept its shim inside the app (`<install>\resources\app\bin`):
  // the same two files, reached from there
  const roots = /\\resources\\app$/i.test(install) ? [install, w.dirname(w.dirname(install))] : [install];
  for (const root of roots) {
    const exe = w.join(root, exeName);
    const cli = w.join(root, 'resources', 'app', 'out', 'cli.js');
    if (exists(exe) && exists(cli)) return { exe, cli };
  }
  return null;
}

/**
 * The argument array that opens `file` at `line`:`column` in the saved
 * editor: `{ ok: true, bin, args, label }`, or `{ ok: false, reason, error }`
 * where `reason` is `unset`, `missing`, `terminal` or `unknown` and `error`
 * is a sentence for the page. Nothing is run.
 */
export function editorCommand(choice, { file, line, column }, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  if (!choice) return { ok: false, reason: 'unset', error: 'no code editor chosen yet' };
  const label = choiceLabel(choice, { env });
  const runnable = (bin, args) => {
    // Node starts a .cmd or a .bat only through cmd.exe, and nothing here
    // goes through a shell. VS Code's and Cursor's own shims are started the
    // way they start themselves (electronShim); any other is said, never half-run
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
      const shim = electronShim(bin, { exists });
      if (shim) return { ok: true, bin: shim.exe, args: [shim.cli, ...args], env: { ELECTRON_RUN_AS_NODE: '1' }, label };
      return { ok: false, reason: 'missing', error: `${label} is a batch file here, and decklight starts editors without a shell: choose a command that names the program itself` };
    }
    return { ok: true, bin, args, label };
  };
  if (choice.editor === 'custom') {
    const words = parseTemplate(choice.template);
    const bin = whichBin(words[0], env, platform, exists);
    if (!bin) return { ok: false, reason: 'missing', error: `your command's program, ${words[0]}, is not on this machine` };
    return runnable(bin, fillTemplate(words.slice(1), { file, line, column }));
  }
  if (choice.editor === 'env') {
    const own = envEditor(env);
    if (!own) return { ok: false, reason: 'missing', error: '$VISUAL and $EDITOR are not set for the deck\'s server' };
    if (own.blocked) return { ok: false, reason: TERMINAL.has(programName(own.program)) ? 'terminal' : 'unknown', error: own.blocked };
    const bin = whichBin(own.program, env, platform, exists);
    if (!bin) return { ok: false, reason: 'missing', error: `${own.label} names ${own.program}, which is not on this machine` };
    return runnable(bin, [...own.words, ...own.gui.args(file, line, column)]);
  }
  const editor = EDITORS.find((e) => e.id === choice.editor);
  if (!editor) return { ok: false, reason: 'unset', error: 'no code editor chosen yet' };
  const found = locate(editor, { env, platform, exists });
  if (!found) return { ok: false, reason: 'missing', error: `${editor.label} is not installed here, or not where decklight looks for it` };
  return runnable(found.bin, editor.args(file, line, column));
}

/**
 * Start the editor and let it go: detached, its output ignored, never
 * waited for (an editor's CLI hands the file to the open window and exits;
 * one that stays is its own). Resolves once it started, `{ ok: true }`, or
 * failed to, `{ ok: false, error }`; `spawn` is injected by the tests.
 */
export function launchEditor({ bin, args, env = null }, { spawn = nodeSpawn, cwd, baseEnv = process.env } = {}) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(bin, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true,
        ...(cwd ? { cwd } : {}), ...(env ? { env: { ...baseEnv, ...env } } : {}) });
    } catch (e) { done({ ok: false, error: String(e.message || e) }); return; }
    child.once('error', (e) => done({ ok: false, error: e.code === 'ENOENT' ? `${bin} was not found` : String(e.message || e) }));
    child.once('spawn', () => { child.unref?.(); done({ ok: true }); });
  });
}
