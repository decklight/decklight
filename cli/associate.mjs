#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `decklight associate` — make a double-clicked `.decklight` open in `present`
 * (MARKETPLACE.md DECK_FILE#ASSOC).
 *
 * Without this, the container's whole point leaks away: the person who receives
 * a deck double-clicks it, the OS has no idea what it is, and they end up
 * either renaming it to `.html` (which works — the container degrades on
 * purpose — but skips every check) or looking at a download dialog. The file
 * association is what makes `present` the default way in rather than the way in
 * for people who already read the docs.
 *
 * Three platforms, three unrelated mechanisms, and the honest summary is that
 * they are the fiddly part of this feature:
 *
 * - **Linux** — a `.desktop` entry plus a shared-MIME-info XML declaring
 *   `application/vnd.decklight`, both under `~/.local/share`, then the two
 *   database refreshers if they exist. Fully wired here.
 * - **macOS** — a UTI has to be *exported by an application bundle*; there is
 *   no per-user "declare a type" file. So a minimal `Decklight.app` is written
 *   (a directory with an `Info.plist` and a shell launcher) whose plist exports
 *   `io.decklight.deck` and claims the extension. `lsregister` is asked to
 *   notice it.
 * - **Windows** — `reg add` under `HKCU\\Software\\Classes`, which needs no
 *   administrator and is what per-user file associations actually are.
 *
 * Every writer prints the paths it touched, and `--uninstall` removes exactly
 * those. Nothing is written outside the user's own home.
 */

import { writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../tools/args.mjs';
import { DECK_EXT } from './deckfile.mjs';

export const MIME_TYPE = 'application/vnd.decklight';
export const UTI = 'io.decklight.deck';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'decklight.mjs');

const USAGE = `usage: decklight associate [--uninstall] [--print]

  wires a double-clicked ${DECK_EXT} file to \`decklight present\`, so a deck
  someone sent you opens verified instead of raw in a browser.

  --uninstall  remove what this command installed
  --print      show what would be written, and where; write nothing

  Per-user only: everything lands under your home directory and no step needs
  administrator rights. What gets written depends on the platform —
    linux    ~/.local/share/applications/decklight.desktop
             ~/.local/share/mime/packages/decklight.xml
    darwin   ~/Applications/Decklight.app (a minimal bundle: a UTI can only be
             exported by an application, so there has to be one)
    win32    HKCU\\Software\\Classes\\${DECK_EXT} and \\Decklight.Deck

  A ${DECK_EXT} renamed to .html still opens in a plain browser whether or not
  this ran — the container degrades to the deck it wraps by design. The
  association buys the verified path, not the only path.`;

// ── linux ──────────────────────────────────────────────────────────────────

/**
 * The launcher runs the CLI through the same node that is running now.
 * `%f` (single local file) rather than `%F`: present takes one deck, and a
 * multi-select that silently presented the first would be worse than one that
 * opens two windows.
 */
export function linuxFiles(home = homedir(), node = process.execPath, cli = CLI) {
  return [
    {
      path: path.join(home, '.local/share/applications/decklight.desktop'),
      text: `[Desktop Entry]
Type=Application
Name=Decklight
Comment=Play a Decklight deck, verified and read-only
Exec=${node} ${cli} present %f
Terminal=true
NoDisplay=true
MimeType=${MIME_TYPE};
Categories=Office;Presentation;
`,
    },
    {
      path: path.join(home, '.local/share/mime/packages/decklight.xml'),
      text: `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="${MIME_TYPE}">
    <comment>Decklight presentation</comment>
    <glob pattern="*${DECK_EXT}"/>
    <!-- The payload is HTML, so a magic match would collide with text/html;
         the extension is the only unambiguous signal a container has. -->
    <sub-class-of type="text/html"/>
  </mime-type>
</mime-info>
`,
    },
  ];
}

// ── macOS ──────────────────────────────────────────────────────────────────

export function darwinFiles(home = homedir(), node = process.execPath, cli = CLI) {
  const app = path.join(home, 'Applications/Decklight.app');
  return [
    {
      path: path.join(app, 'Contents/Info.plist'),
      text: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${UTI}.app</string>
  <key>CFBundleName</key><string>Decklight</string>
  <key>CFBundleExecutable</key><string>decklight</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>UTExportedTypeDeclarations</key>
  <array><dict>
    <key>UTTypeIdentifier</key><string>${UTI}</string>
    <key>UTTypeDescription</key><string>Decklight presentation</string>
    <key>UTTypeConformsTo</key><array><string>public.html</string></array>
    <key>UTTypeTagSpecification</key>
    <dict>
      <key>public.filename-extension</key><array><string>${DECK_EXT.slice(1)}</string></array>
      <key>public.mime-type</key><array><string>${MIME_TYPE}</string></array>
    </dict>
  </dict></array>
  <key>CFBundleDocumentTypes</key>
  <array><dict>
    <key>CFBundleTypeName</key><string>Decklight presentation</string>
    <key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSHandlerRank</key><string>Owner</string>
    <key>LSItemContentTypes</key><array><string>${UTI}</string></array>
  </dict></array>
</dict>
</plist>
`,
    },
    {
      path: path.join(app, 'Contents/MacOS/decklight'),
      mode: 0o755,
      // Through Terminal, because present is a server that prints the label and
      // then keeps running: launching it with no visible output would leave
      // someone staring at a bouncing icon while the thing they need to read
      // scrolls past in a log nobody opens.
      //
      // The deck path is the filename of a file someone *sent*, and this
      // script runs before `present` checks a byte — so it must never be
      // spliced into the `do script` text, where a quote in the name becomes
      // shell. It rides as an osascript argument the whole way and is quoted
      // by AppleScript's `quoted form of` at the last moment. The install
      // paths are ours, baked as AppleScript string literals via
      // JSON.stringify, the same escaping the Keynote import script uses.
      text: `#!/bin/sh
# Generated by \`decklight associate\`. Opens the double-clicked deck in
# \`decklight present\`, in a Terminal window so its output is readable.
# The deck path stays an argument the whole way down (Finder → $1 →
# osascript argv → quoted form of): a filename is data, never code.
deck="$1"
[ -n "$deck" ] || exit 0
dir=$(dirname "$deck")
osascript - "$dir" "$deck" <<'DECKLIGHT_LAUNCH'
on run argv
  set cmd to "cd " & quoted form of item 1 of argv & " && " & quoted form of ${JSON.stringify(node)} & " " & quoted form of ${JSON.stringify(cli)} & " present " & quoted form of item 2 of argv
  tell application "Terminal" to do script cmd
  tell application "Terminal" to activate
end run
DECKLIGHT_LAUNCH
`,
    },
  ];
}

// ── windows ────────────────────────────────────────────────────────────────

/** The registry writes, as argv arrays — printable, and testable without a registry. */
export function windowsCommands(node = process.execPath, cli = CLI) {
  const key = 'HKCU\\Software\\Classes';
  return [
    ['reg', 'add', `${key}\\${DECK_EXT}`, '/ve', '/d', 'Decklight.Deck', '/f'],
    ['reg', 'add', `${key}\\${DECK_EXT}`, '/v', 'Content Type', '/d', MIME_TYPE, '/f'],
    ['reg', 'add', `${key}\\Decklight.Deck`, '/ve', '/d', 'Decklight presentation', '/f'],
    ['reg', 'add', `${key}\\Decklight.Deck\\shell\\open\\command`, '/ve', '/d',
      `"${node}" "${cli}" present "%1"`, '/f'],
  ];
}

const windowsUninstall = () => [
  ['reg', 'delete', `HKCU\\Software\\Classes\\${DECK_EXT}`, '/f'],
  ['reg', 'delete', 'HKCU\\Software\\Classes\\Decklight.Deck', '/f'],
];

// ── the command ────────────────────────────────────────────────────────────

/** Refresh a desktop database if the tool is there; never fail over its absence. */
function refresh(argv) {
  try { execFileSync(argv[0], argv.slice(1), { stdio: 'ignore' }); return true; }
  catch { return false; }
}

export function planFor(os = platform()) {
  if (os === 'linux') return { files: linuxFiles(), commands: [], os };
  if (os === 'darwin') return { files: darwinFiles(), commands: [], os };
  if (os === 'win32') return { files: [], commands: windowsCommands(), os };
  return { files: [], commands: [], os, unsupported: true };
}

export async function associateMain(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const uninstall = args.includes('--uninstall');
  const dryRun = args.includes('--print');
  const plan = planFor();

  if (plan.unsupported) {
    console.error(`decklight associate: no file-association mechanism is wired for ${plan.os}`);
    return 1;
  }

  if (dryRun) {
    for (const f of plan.files) console.log(`would write ${f.path}`);
    for (const c of plan.commands) console.log(`would run   ${c.join(' ')}`);
    return 0;
  }

  if (uninstall) {
    for (const f of plan.files) {
      // The macOS bundle is a directory this command created wholesale, so it
      // goes wholesale; the two Linux files go individually.
      const target = f.path.includes('Decklight.app') ? f.path.replace(/(Decklight\.app).*/, '$1') : f.path;
      if (existsSync(target)) { rmSync(target, { recursive: true, force: true }); console.log(`removed ${target}`); }
    }
    for (const c of (plan.os === 'win32' ? windowsUninstall() : [])) refresh(c);
    if (plan.os === 'linux') {
      refresh(['update-mime-database', path.join(homedir(), '.local/share/mime')]);
      refresh(['update-desktop-database', path.join(homedir(), '.local/share/applications')]);
    }
    console.log('the association is gone; a .decklight is an unknown file again');
    return 0;
  }

  for (const f of plan.files) {
    mkdirSync(path.dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.text);
    if (f.mode) chmodSync(f.path, f.mode);
    console.log(`wrote ${f.path}`);
  }
  for (const c of plan.commands) {
    if (!refresh(c)) { console.error(`failed: ${c.join(' ')}`); return 1; }
    console.log(`ran   ${c.join(' ')}`);
  }

  if (plan.os === 'linux') {
    const mime = refresh(['update-mime-database', path.join(homedir(), '.local/share/mime')]);
    const desk = refresh(['update-desktop-database', path.join(homedir(), '.local/share/applications')]);
    // Said plainly rather than swallowed: the files are correct either way, but
    // without the refresh the desktop will not notice them until it is
    // restarted, and a silent no-op here reads as a broken feature.
    if (!mime || !desk) {
      console.log('note: update-mime-database/update-desktop-database not found — the files are in place, '
        + 'but your desktop may not pick them up until it restarts');
    }
  }
  if (plan.os === 'darwin') {
    refresh(['/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      '-f', path.join(homedir(), 'Applications/Decklight.app')]);
  }

  console.log(`double-clicking a ${DECK_EXT} now opens: decklight present`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = await associateMain();
