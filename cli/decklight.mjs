#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * decklight — the Decklight command line.
 *
 *   decklight rec      record a terminal cast from a YAML script
 *   decklight refresh  re-run embedded scripts, rewrite drifted casts
 *   decklight export   convert a cast to asciicast v2
 *   decklight bundle   flatten a deck into one self-contained HTML file
 *   decklight tts      serve the live voice bridge (on-the-fly Gemini narration)
 *   decklight lipsync  serve the lip-sync bridge (character visemes + talking-head video)
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
  rec      record a truthful terminal cast by running a YAML command script in a real PTY
           EXAMPLE: decklight rec deck.term.yaml -o deck.cast.json
  refresh  re-execute the script embedded in each cast; rewrite the ones whose output drifted
           EXAMPLE: decklight refresh casts/
  export   flatten a cast to asciicast v2 (markers per step) for the asciinema ecosystem
           EXAMPLE: decklight export demo.cast.json && agg demo.cast demo.gif
  bundle   flatten a deck into ONE self-contained HTML file (runtime, themes, casts, images inlined)
           EXAMPLE: decklight bundle demo/showcase.html --themes midnight,graphite
           EXAMPLE: decklight bundle deck.html --all --title "My Course"   (merge the whole playlist into one file)
  tts      serve the live voice bridge — the player synthesizes narration on the fly through it
           EXAMPLE: decklight tts        (then pick "Live voice…" in the deck's / palette)
  lipsync  serve the lip-sync bridge — offline visemes (rhubarb) + talking-head video (local GPU)
           EXAMPLE: decklight lipsync    (then pick "Character…" in the deck's / palette)
  edit     serve the deck with live reload; E in the player edits speaker notes back into the file
           EXAMPLE: decklight edit demo/showcase.html   (then open the printed URL)
  dev      one command for the whole loop: edit + every bridge this machine can run, one Ctrl-C
           EXAMPLE: decklight dev demo/showcase.html   (bridges without prerequisites are skipped)
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
  case 'edit': {
    const { editMain } = await import('./edit.mjs');
    await editMain(rest);
    break;
  }
  case 'dev': {
    const { devMain } = await import('./dev.mjs');
    await devMain(rest);
    break;
  }
  default:
    process.stderr.write(`decklight: unknown command "${cmd}"\n\n`);
    globalHelp(1);
}
