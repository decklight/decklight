#!/usr/bin/env node
/**
 * decklight — the Decklight command line.
 *
 *   decklight rec      record a terminal cast from a YAML script
 *   decklight refresh  re-run embedded scripts, rewrite drifted casts
 *   decklight export   convert a cast to asciicast v2
 *   decklight bundle   flatten a deck into one self-contained HTML file
 *   decklight tts      serve the live voice bridge (on-the-fly Gemini narration)
 *
 * The subcommand implementations live in rec.mjs and
 * bundle.mjs (importable modules; direct execution still works but
 * this dispatcher is the documented entry point).
 */

const GLOBAL_HELP = `decklight — author, record, and package Decklight presentations

Usage:
  decklight <command> [options]        (decklight <command> --help for full flags)

Commands:
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
  help     show this help, or a command's help: decklight help bundle
`;

function globalHelp(exitCode = 0) {
  process.stdout.write(GLOBAL_HELP);
  process.exit(exitCode);
}

const argv = process.argv.slice(2);
let cmd = argv[0];
let rest = argv.slice(1);

if (!cmd || cmd === '--help' || cmd === '-h') globalHelp();
if (cmd === 'help') {
  if (!rest[0]) globalHelp();
  cmd = rest[0];
  rest = ['--help'];
}

switch (cmd) {
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
  default:
    process.stderr.write(`decklight: unknown command "${cmd}"\n\n`);
    globalHelp(1);
}
