#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight — the Decklight command line.
 *
 *   decklight rec      record a terminal cast from a YAML script
 *   decklight refresh  re-run embedded scripts, rewrite drifted casts
 *   decklight export   convert a cast to asciicast v2
 *   decklight pdf      render a deck to a PDF — one slide per page, no print dialog
 *   decklight theme    validate a theme file, or install one into a deck
 *   decklight import   convert a PowerPoint/Keynote/Google Slides deck into a decklight deck
 *   decklight bundle   flatten a deck into one self-contained HTML file
 *   decklight upgrade  bring a self-contained deck's inlined runtime up to the installed version
 *   decklight publish  bundle a deck and push it to a gh-pages branch
 *   decklight marketplace  register catalogs of themes, templates, skills and engines
 *   decklight plugin   install your own presenter chrome (timer, teleprompter) — never enters a deck
 *   decklight template install deck templates for `init --from`
 *   decklight importer install import adapters for formats decklight cannot read itself
 *   decklight transform install build-time transforms, run via `bundle --transform <name>`
 *   decklight engine   install a speech engine beyond the six built in — the N picker then offers it
 *   decklight extension check a transform file — the marketplace admission gate, not a bundle step
 *   decklight voice    add a marketplace voice to the N picker — a reference, never a model
 *   decklight agent    teach A a coding agent beyond the built-in roster — a descriptor, never code
 *   decklight tts      serve the live voice bridge (on-the-fly Gemini narration)
 *   decklight lipsync  serve the lip-sync bridge (character visemes + talking-head video)
 *   decklight video    render a deck to a narrated mp4 (stills + voiceover audio)
 *
 * The subcommand implementations live in rec.mjs and
 * bundle.mjs (importable modules; direct execution still works but
 * this dispatcher is the documented entry point).
 */

import { readFileSync } from 'node:fs';

const GLOBAL_HELP = `decklight — author, record, and package Decklight presentations

Usage:
  decklight <command> [options]        (decklight <command> --help for full flags)

Commands:
  init     scaffold a starter deck, plus an agent skill (.claude/skills/decklight/, AGENTS.md)
           EXAMPLE: decklight init "My Deck"
  skills   install the Decklight authoring skill for AI agents (Claude, Codex, OpenCode, IBM Bob)
           EXAMPLE: decklight skills claude codex   (or --all, or omit to use detected agents)
           EXAMPLE: decklight skills --global        (install into each agent's config home, every project)
           EXAMPLE: decklight skills claude --pack   (zip it to upload in your claude.ai skill settings)
  rec      record a truthful terminal cast by running a YAML command script in a real PTY
           EXAMPLE: decklight rec deck.term.yaml -o deck.cast.json
  refresh  re-execute the script embedded in each cast; rewrite the ones whose output drifted
           EXAMPLE: decklight refresh casts/
  export   flatten a cast to asciicast v2 (markers per step) for the asciinema ecosystem
           EXAMPLE: decklight export demo.cast.json && agg demo.cast demo.gif
  bundle   flatten a deck into ONE self-contained HTML file (runtime, themes, casts, images inlined)
           EXAMPLE: decklight bundle demo/showcase.html --themes midnight,graphite
           EXAMPLE: decklight bundle deck.html --all --title "My Course"   (merge the whole playlist into one file)
  restore  list the commits that touched a deck, and put it back to any of them
           EXAMPLE: decklight restore deck.html          (list)
           EXAMPLE: decklight restore deck.html a1b2c3d  (restore, as a new commit on top)
  upgrade  bring a self-contained deck's inlined runtime + themes up to the installed version, in place
           EXAMPLE: decklight upgrade deck.html --dry-run   (see what would change; drop the flag to apply)
  pdf      render the deck to a PDF — one slide per page, at its own size, in its theme
           EXAMPLE: decklight pdf deck.html   (writes deck.pdf; --theme exports in another)
  import   convert an existing PowerPoint, Keynote or Google Slides deck into a decklight deck
           EXAMPLE: decklight import "Q3 Review.pptx"   (also .key on macOS, or a Slides URL)
  theme    validate a theme file against the token contract, or install one into a deck
           EXAMPLE: decklight theme check nord-deep.css
           EXAMPLE: decklight theme add https://gist.../nord-deep.css talk.html
  publish  bundle a deck and push it to GitHub Pages — deck to shareable URL in one command
           EXAMPLE: decklight publish deck.html   (prints https://owner.github.io/repo/)
  marketplace  register catalogs (git repos with .decklight/marketplace.json) — registered, not fetched
           EXAMPLE: decklight marketplace add owner/repo   (or a git URL, or a local path)
           EXAMPLE: decklight marketplace list              (offline-safe: reads only the cache)
  plugin   install presenter chrome into YOUR library — present loads it, bundle never does
           EXAMPLE: decklight plugin add timer      (then: decklight present talk.html)
           EXAMPLE: decklight plugin list           (says which ones read your speaker notes)
  template install deck templates from a marketplace — scaffold with: decklight init --from <name>
           EXAMPLE: decklight template add startup-pitch
  importer install an import adapter for a format decklight cannot read itself — decklight
           import runs it the moment it is installed for the extension in hand
           EXAMPLE: decklight importer add marp-import   (then: decklight import talk.marp)
  transform install a build-time transform — Node code that runs during bundle, never in the deck
           EXAMPLE: decklight transform add grammar-check
           EXAMPLE: decklight bundle deck.html --transform grammar-check   (runs it before signing)
  engine   install a speech engine the six built-in ones do not cover — Node code that runs
           at author time only, never in a deck; your own credential still comes from the wizard
           EXAMPLE: decklight engine add azure-tts   (then: decklight tts --engine azure-tts)
  extension  the marketplace admission gate for a transform file — lint, then a headless load
           of its OUTPUT; not run by bundle/import/publish, which never re-check an installed unit
           EXAMPLE: decklight extension check grammar-check.mjs
  voice    add a marketplace voice to the picker — a reference to one of an engine's
           voices, never a model, so nothing that reproduces a person is ever downloaded
           EXAMPLE: decklight voice add narrator-anna    (works offline; speaking needs your key)
  agent    teach A a coding agent the built-in roster does not cover — a descriptor of how to
           run it headlessly, never code, so this downloads nothing and works offline
           EXAMPLE: decklight agent add my-agent     (install the agent itself its own way)
  tts      serve the live voice bridge — the player synthesizes narration on the fly through it
           EXAMPLE: decklight tts        (then pick "Live voice…" in the deck's / palette)
  lipsync  serve the lip-sync bridge — offline visemes (rhubarb) + talking-head video (local GPU)
           EXAMPLE: decklight lipsync    (then pick "Character…" in the deck's / palette)
  video    render the deck to ONE narrated mp4 — a still per slide, held for its narration audio
           EXAMPLE: decklight video deck.html -o deck.mp4   (add --voiceover to synthesize first)
  author   one command for the whole authoring loop: live-reload editing + every bridge this
           machine can run, one Ctrl-C; E in the player edits speaker notes back into the file
           EXAMPLE: decklight author demo/showcase.html   (bridges without prerequisites are skipped)
  present  play a deck you did not author — read-only over localhost, under a CSP header;
           prints what the file will execute, and strips what it cannot account for
           EXAMPLE: decklight present talk.html   (no editing surface, nothing is written)
  associate  wire double-clicking a .decklight file to decklight present
           EXAMPLE: decklight associate   (per-user, no admin rights; --uninstall undoes it)
  report-bug  gather the version + environment facts a Decklight bug report needs, and the issue URL
           EXAMPLE: decklight report-bug   (prints and exits — nothing is sent anywhere)
  help     show this help, or a command's help: decklight help bundle
  version  print the installed version (also --version / -v)
`;

function globalHelp(exitCode = 0) {
  process.stdout.write(GLOBAL_HELP);
  process.exit(exitCode);
}

const argv = process.argv.slice(2);
let cmd = argv[0];
let rest = argv.slice(1);

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

if (!cmd || cmd === '--help' || cmd === '-h') globalHelp();
if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  process.stdout.write(`decklight ${version}\n`);
  process.exit(0);
}
if (cmd === 'help') {
  if (!rest[0]) globalHelp();
  cmd = rest[0];
  rest = ['--help'];
}

// every real command announces the version it runs as — on stderr, so piped
// output (export, bundle) stays clean
process.stderr.write(`decklight ${version}\n`);

// When a parent supervises us (author runs the deck server and the bridges), go when it
// goes — a SIGKILLed parent never gets to reap its children. No-op otherwise.
const { exitWhenOrphaned } = await import('./supervise.mjs');
exitWhenOrphaned();

// The first-party marketplace is REGISTERED on first run, never fetched
// (SPEC MARKETPLACE_REGISTRY): this writes two files under ~/.decklight/ and
// touches nothing else — offline first run is silent and instant. A config
// home that cannot be written must never cost a command.
try {
  const { ensureFirstPartyRegistered } = await import('./marketplace.mjs');
  ensureFirstPartyRegistered();
} catch { /* registration is a courtesy, not a dependency */ }

// ONE ERROR BOUNDARY FOR EVERY COMMAND. A command refuses by throwing a
// CommandError (cli/util.mjs) and it is printed here, once, in the shape
// commands have always printed: `decklight <cmd>: <message>`. Anything else
// reaching this point is a bug rather than a refusal, and prints as a message
// with the stack behind DECKLIGHT_DEBUG — never as the raw Node stack a user
// used to get (`decklight import` did exactly that on any install path with a
// space in it, #275).
try {
switch (cmd) {
  case 'init': {
    const { initMain } = await import('./init.mjs');
    await initMain(rest);
    break;
  }
  case 'skills': {
    const { skillsMain } = await import('./skills.mjs');
    await skillsMain(rest);
    break;
  }
  case 'rec': {
    const { recMain } = await import('./rec.mjs');
    await recMain(rest);
    break;
  }
  case 'refresh': {
    const { recMain } = await import('./rec.mjs');
    await recMain(rest.includes('--help') ? ['--help'] : ['refresh', ...rest]);
    break;
  }
  case 'export': {
    const { recMain } = await import('./rec.mjs');
    await recMain(rest.includes('--help') ? ['--help'] : ['export', ...rest]);
    break;
  }
  case 'bundle': {
    const { bundleMain } = await import('./bundle.mjs');
    await bundleMain(rest);
    break;
  }
  case 'upgrade': {
    const { upgradeMain } = await import('./upgrade.mjs');
    await upgradeMain(rest);
    break;
  }
  case 'pdf': {
    const { pdfMain } = await import('./pdf.mjs');
    process.exitCode = await pdfMain(rest);
    break;
  }
  case 'import': {
    const { importMain } = await import('./import.mjs');
    process.exitCode = await importMain(rest);
    break;
  }
  case 'theme': {
    const { themeMain } = await import('./theme.mjs');
    process.exitCode = await themeMain(rest);
    break;
  }
  case 'publish': {
    const { publishMain } = await import('./publish.mjs');
    await publishMain(rest);
    break;
  }
  case 'marketplace': {
    const { marketplaceMain } = await import('./marketplace.mjs');
    process.exitCode = await marketplaceMain(rest);
    break;
  }
  case 'plugin': {
    const { pluginMain } = await import('./plugin.mjs');
    process.exitCode = await pluginMain(rest);
    break;
  }
  // Four rows of the same table (UNITS#REST) — one implementation, in units.mjs.
  case 'template':
  case 'voice':
  case 'agent':
  case 'importer':
  case 'engine':
  case 'transform': {
    const { unitMain } = await import('./units.mjs');
    process.exitCode = await unitMain(cmd, rest);
    break;
  }
  case 'extension': {
    const { extensionMain } = await import('./extension.mjs');
    process.exitCode = await extensionMain(rest);
    break;
  }
  case 'tts': {
    const { ttsMain } = await import('../tools/voiceover-server.mjs');
    await ttsMain(rest);
    break;
  }
  case 'lipsync': {
    const { lipsyncMain } = await import('../tools/lipsync-server.mjs');
    await lipsyncMain(rest);
    break;
  }
  case 'video': {
    const { videoMain } = await import('../tools/video.mjs');
    await videoMain(rest);
    break;
  }
  case 'report-bug': {
    const { reportBugMain } = await import('./report-bug.mjs');
    process.exitCode = await reportBugMain(rest);
    break;
  }
  case 'restore': {
    const { restoreMain } = await import('./restore.mjs');
    process.exitCode = await restoreMain(rest);
    break;
  }
  case 'author':
  case 'dev': {  // permanent hidden alias — the pre-rename name; works forever, documented nowhere
    const { devMain } = await import('./dev.mjs');
    await devMain(rest);
    break;
  }
  case 'present': {
    const { presentMain } = await import('./present.mjs');
    process.exitCode = await presentMain(rest);
    break;
  }
  case 'associate': {
    const { associateMain } = await import('./associate.mjs');
    process.exitCode = await associateMain(rest);
    break;
  }
  case 'edit': {
    // Removed as a command (COMMANDS in MARKETPLACE.md) — but a removal must
    // refuse out loud, naming the way forward, not shrug "unknown command".
    // The server itself lives on in edit.mjs; `author` starts it.
    process.stderr.write('decklight edit was folded into the authoring loop — run `decklight author <deck.html>` instead\n');
    process.exit(1);
  }
  default:
    process.stderr.write(`decklight: unknown command "${cmd}"\n\n`);
    globalHelp(1);
}
} catch (e) {
  const { reportFailure } = await import('./util.mjs');
  reportFailure(e, cmd);
  process.exitCode = 1;
}
