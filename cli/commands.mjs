// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The command roster — the one table `decklight <command>` dispatches from.
 *
 * It used to be a 200-line switch in decklight.mjs, one `case` per command,
 * each repeating the same dynamic import and differing only in whether it
 * assigned the return value to `process.exitCode`. Adding a command meant a
 * new case, a new help paragraph, and remembering which of the two return
 * conventions the new main followed. Now it is one row here and one paragraph
 * in GLOBAL_HELP below, and test/commands.test.mjs holds the two in step: a
 * command in the table that the help does not list fails the suite, and so
 * does a paragraph for a command that does not exist.
 *
 * A row is `{ module, main }` — the module (relative to this directory) and
 * the exported async main to call. The main receives the remaining argv and
 * may return an exit code; a main that returns nothing exits 0 unless it
 * throws (a CommandError prints as a refusal, anything else as a bug — see
 * cli/util.mjs). Two optional fields cover the exceptions:
 *
 *   args(rest, cmd)  the argument list to call the main with, when it is not
 *                    simply `[rest]` — `refresh`/`export` prepend a subcommand,
 *                    the unit commands pass their own name
 *   alias            this name is another command, spelled differently; the
 *                    row it names is dispatched and the alias stays out of help
 *   spawn            a script to run in a child process instead of importing
 *                    (tools/voiceover.mjs parses argv and exits at load)
 */
export const COMMANDS = {
  init: { module: './init.mjs', main: 'initMain' },
  skills: { module: './skills.mjs', main: 'skillsMain' },
  cast: { module: './cast.mjs', main: 'castMain' },
  refresh: { module: './cast.mjs', main: 'castMain', args: castSubcommand('refresh') },
  export: { module: './cast.mjs', main: 'castMain', args: castSubcommand('export') },
  bundle: { module: './bundle.mjs', main: 'bundleMain' },
  restore: { module: './restore.mjs', main: 'restoreMain' },
  history: { module: './history.mjs', main: 'historyMain' },
  upgrade: { module: './upgrade.mjs', main: 'upgradeMain' },
  pdf: { module: './pdf.mjs', main: 'pdfMain' },
  pptx: { module: './pptx-export.mjs', main: 'pptxMain' },
  import: { module: './import.mjs', main: 'importMain' },
  theme: { module: './theme.mjs', main: 'themeMain' },
  publish: { module: './publish.mjs', main: 'publishMain' },
  marketplace: { module: './marketplace.mjs', main: 'marketplaceMain' },
  plugin: { module: './plugin.mjs', main: 'pluginMain' },
  // Six rows of the same table (MARKETPLACE.md UNITS#REST): one implementation,
  // told which kind of unit it is handling.
  template: { module: './units.mjs', main: 'unitMain', args: (rest, cmd) => [cmd, rest] },
  importer: { module: './units.mjs', main: 'unitMain', args: (rest, cmd) => [cmd, rest] },
  transform: { module: './units.mjs', main: 'unitMain', args: (rest, cmd) => [cmd, rest] },
  engine: { module: './units.mjs', main: 'unitMain', args: (rest, cmd) => [cmd, rest] },
  voice: { module: './units.mjs', main: 'unitMain', args: (rest, cmd) => [cmd, rest] },
  agent: { module: './units.mjs', main: 'unitMain', args: (rest, cmd) => [cmd, rest] },
  extension: { module: './extension.mjs', main: 'extensionMain' },
  tts: { module: '../tools/voiceover-server.mjs', main: 'ttsMain' },
  lipsync: { module: '../tools/lipsync-server.mjs', main: 'lipsyncMain' },
  video: { module: '../tools/video.mjs', main: 'videoMain' },
  author: { module: './dev.mjs', main: 'devMain' },
  // The pre-rename name. A permanent hidden alias: works forever, documented nowhere.
  dev: { alias: 'author' },
  record: { module: './record.mjs', main: 'recordMain' },
  // tools/voiceover.mjs arg-parses and exits at LOAD (it cannot be imported —
  // deck-html.mjs's note), so it is spawned, exactly as `video --voiceover`
  // already spawns it. stdio inherited: its per-slide progress and cost lines
  // are the whole point of running it in a terminal.
  voiceover: { spawn: '../tools/voiceover.mjs' },
  review: { module: './review.mjs', main: 'reviewMain' },
  comments: { module: './comments.mjs', main: 'commentsMain' },
  present: { module: './present.mjs', main: 'presentMain' },
  associate: { module: './associate.mjs', main: 'associateMain' },
  'report-bug': { module: './report-bug.mjs', main: 'reportBugMain' },
  doctor: { module: './doctor.mjs', main: 'doctorMain' },
  check: { module: './check.mjs', main: 'checkMain' },
};

/** `refresh` and `export` are castMain subcommands; `--help` must still reach it bare. */
function castSubcommand(name) {
  return (rest) => [rest.includes('--help') ? ['--help'] : [name, ...rest]];
}

/** The row a command name dispatches to, aliases followed, or null. */
export function resolveCommand(name) {
  const row = COMMANDS[name];
  if (!row) return null;
  return row.alias ? COMMANDS[row.alias] ?? null : row;
}

/** The commands `decklight help` lists, in help order — aliases excluded. */
export const listedCommands = () => [...GLOBAL_HELP.slice(GLOBAL_HELP.indexOf('Commands:\n'))
  .matchAll(/^  ([a-z-]+) +\S/gm)].map((m) => m[1]);

/** The one-line description GLOBAL_HELP opens a command's paragraph with. */
export function commandSummary(name) {
  const m = new RegExp(`^  ${name} +(\\S.*)$`, 'm').exec(GLOBAL_HELP.slice(GLOBAL_HELP.indexOf('Commands:\n')));
  return m ? m[1].trim() : '';
}

/**
 * The journey, in order: make a deck, work on it, show it, bring one in, hand
 * it over. What a bare `decklight` and an unknown command print, because a
 * newcomer who typed the wrong thing does not need the other thirty commands
 * on screen to find the right one — they need these six and a way to the rest.
 */
export const START_COMMANDS = ['init', 'author', 'check', 'present', 'import', 'bundle', 'publish', 'doctor'];

/** One line each, written to fit a terminal — GLOBAL_HELP's paragraphs wrap. */
const SHORT = {
  init: 'start a deck here, plus the skill that teaches an AI agent to write it',
  author: 'work on a deck: live reload, edits from the browser, an AI agent on A',
  check: 'lint one deck headlessly: what is clipped, missing or out of step, one exit code',
  present: 'play a deck you did not write: read-only, under a CSP, what runs is listed',
  import: 'bring a PowerPoint, Keynote or Google Slides deck across',
  bundle: 'one self-contained HTML file to hand over',
  publish: 'bundle and push to GitHub Pages, Netlify, Vercel or a folder',
  doctor: 'what this machine can do, and the install line for what it cannot',
};

export function shortHelp() {
  const width = Math.max(...START_COMMANDS.map((c) => c.length)) + 2;
  const rows = START_COMMANDS.map((c) => `  ${c.padEnd(width)}${SHORT[c] ?? commandSummary(c)}`);
  const more = listedCommands().filter((c) => !START_COMMANDS.includes(c) && c !== 'help' && c !== 'version').length;
  return `decklight — author, record, and package Decklight presentations

Usage:
  decklight <deck.html>          open a deck in author mode: live reload, edits from the browser
  decklight <talk.pptx>          bring a PowerPoint, Keynote or Google Slides deck across
  decklight                      in a directory: start a deck here, or pick one to open
  decklight <command> [options]  (decklight <command> --help for its flags)

Commands:
${rows.join('\n')}

  decklight help                 every command (${more} more), one paragraph each
`;
}

/**
 * What a FILE means as the first argument — the verb the argument implies.
 *
 * `decklight talk.html` was "unknown command", which is the least useful
 * answer to the most natural thing to type. A deck opens in author mode, a
 * `.decklight` container is somebody else's deck and plays read-only, an
 * Office file or a Slides URL is something to import, a YAML script is a
 * terminal cast to record. Unknown kinds return null and stay unknown
 * commands; a file that does not exist still routes, so the refusal names the
 * file ("no such deck: talk.html") instead of the word.
 */
export function routeForPath(arg) {
  const a = String(arg ?? '');
  if (/^https?:\/\/docs\.google\.com\/presentation\//i.test(a)) return 'import';
  if (a.startsWith('-')) return null;
  const ext = /\.([a-z0-9]+)$/i.exec(a)?.[1]?.toLowerCase();
  if (!ext) return null;
  if (ext === 'html' || ext === 'htm') return 'author';
  if (ext === 'decklight') return 'present';
  if (ext === 'pptx' || ext === 'key' || ext === 'keynote') return 'import';
  if (ext === 'yaml' || ext === 'yml') return 'cast';
  return null;
}

/**
 * The word people reach for that is not the command's name. Every entry here
 * is a guess somebody would plausibly type; the values are the roster's names.
 */
export const SYNONYMS = {
  edit: 'author', serve: 'author', start: 'author', run: 'author', watch: 'author', write: 'author',
  new: 'init', create: 'init', scaffold: 'init', make: 'init',
  preview: 'present', play: 'present', show: 'present', view: 'present', open: 'present',
  build: 'bundle', pack: 'bundle', flatten: 'bundle',
  deploy: 'publish', ship: 'publish', pages: 'publish',
  convert: 'import', pptx2html: 'import',
  env: 'doctor', diagnose: 'doctor', lint: 'check', verify: 'check', validate: 'check',
  update: 'upgrade', undo: 'restore', log: 'history',
  themes: 'theme', plugins: 'plugin', templates: 'template', voices: 'voice', engines: 'engine',
};

/** Levenshtein distance, for the typo half of did-you-mean. */
function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/**
 * The command somebody who typed `name` most likely meant, or null.
 *
 * Synonyms first — `edit` is not a typo of `author`, it is the word for it —
 * then a unique prefix (`pub` → publish), then a name within two edits. Two,
 * not three: `cast` and `past` are one apart, `cast` and `pdf` are four, and
 * the useful distance is the one that catches a slipped finger and never an
 * unrelated word.
 */
export function suggestCommand(name) {
  const n = String(name ?? '').toLowerCase();
  if (!n || COMMANDS[n]) return null;
  if (SYNONYMS[n]) return SYNONYMS[n];
  const names = Object.keys(COMMANDS).filter((c) => !COMMANDS[c].alias);
  const prefixed = names.filter((c) => c.startsWith(n));
  if (n.length >= 2 && prefixed.length === 1) return prefixed[0];
  // How many slips a word can absorb depends on how long it is: two in
  // `bundel`, one in `pdff`, none in `p` — which is within two of `pdf` and
  // meant nothing of the kind.
  const budget = n.length >= 5 ? 2 : n.length >= 3 ? 1 : 0;
  let best = null, bestD = budget + 1;
  for (const c of names) {
    const d = editDistance(n, c);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best;
}

export const GLOBAL_HELP = `decklight — author, record, and package Decklight presentations

Usage:
  decklight <command> [options]        (decklight <command> --help for full flags)

Commands:
  init     scaffold a starter deck — slides plus a configuration block, no runtime in the
           file — plus an agent skill (.claude/skills/decklight/, AGENTS.md); --inline embeds it
           EXAMPLE: decklight init "My Deck"
  skills   install the Decklight authoring skill for AI agents (Claude, Codex, OpenCode, IBM Bob)
           EXAMPLE: decklight skills claude codex   (or --all, or omit to use detected agents)
           EXAMPLE: decklight skills --global        (install into each agent's config home, every project)
           EXAMPLE: decklight skills claude --pack   (zip it to upload in your claude.ai skill settings)
  cast     record a truthful terminal cast by running a YAML command script in a real PTY
           (this records a TERMINAL — decklight record records your VOICE)
           EXAMPLE: decklight cast deck.term.yaml -o deck.cast.json
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
  history  what decklight committed, and which commits are only on this machine
           EXAMPLE: decklight history deck.html
  upgrade  bring a self-contained deck's embedded runtime + themes up to the installed version, in place;
           --link turns the embed back into slides plus a configuration block (the reverse of bundle)
           EXAMPLE: decklight upgrade deck.html --dry-run   (see what would change; drop the flag to apply)
  pdf      render the deck to a PDF — one slide per page, at its own size, in its theme
           EXAMPLE: decklight pdf deck.html   (writes deck.pdf; --theme exports in another)
           EXAMPLE: decklight pdf deck.html --handout   (three a page, ruled; --notes is your copy)
  pptx     write a PowerPoint file — every slide as a picture, its notes as notes (lossy on purpose)
           EXAMPLE: decklight pptx deck.html   (for the people around you who still ask for the file)
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
           EXAMPLE: decklight video deck.html --slides 5-9 --voiceover   (just those slides, voiced)
           EXAMPLE: decklight video deck.html --format webm --quality high --subtitles file
  author   one command for the whole authoring loop: live-reload editing + every bridge this
           machine can run, one Ctrl-C; E in the player edits speaker notes back into the file
           EXAMPLE: decklight author demo/showcase.html   (bridges without prerequisites are skipped)
           EXAMPLE: decklight author https://github.com/you/talk   (clones it, opens the deck inside)
  record   capture the deck's narration in YOUR voice — the deck reads you its notes
           one ⟨CLICK⟩ beat at a time, and → ends a beat AND reveals the next build
           (this records YOU — decklight cast records a terminal)
           EXAMPLE: decklight record talk.html   (serves it: a microphone needs 127.0.0.1)
  voiceover batch-synthesize the deck's narration into a folder with a live engine
           (piper/chirp/gemini/elevenlabs) — the headless counterpart of the deck's V → Record this deck…
           EXAMPLE: decklight voiceover talk.html -o voices/chirp --engine chirp --voice Achernar
  review   leave comments on somebody's deck, anchored to slides and carried by git
           (writes <deck>.review.jsonl beside it; never touches the deck itself)
           EXAMPLE: decklight review talk.html   (then M in the deck)
           \`review submit\` pushes them to a review/<you>-<date> branch (--pr opens one)
  comments what reviewers said, resolved against the deck as it is now — a comment
           whose slide moved is found anyway, and one whose slide is gone is still shown
           EXAMPLE: decklight comments talk.html   (--import to take in a reviewer's file,
           --incoming to see what reviews are waiting on the remote)
  present  play a deck you did not author — read-only over localhost, under a CSP header;
           prints what the file will execute, and strips what it cannot account for
           EXAMPLE: decklight present talk.html   (no editing surface, nothing is written)
  associate  wire double-clicking a .decklight file to decklight present
           EXAMPLE: decklight associate   (per-user, no admin rights; --uninstall undoes it)
  report-bug  gather the version + environment facts a Decklight bug report needs, and the issue URL
           EXAMPLE: decklight report-bug   (prints and exits — nothing is sent anywhere)
  doctor   what this machine can do — Chrome, ffmpeg, git, the optional deps, the agents on PATH —
           and, for each thing missing, which commands it unlocks and the line that installs it
           EXAMPLE: decklight doctor
  check    lint ONE deck headlessly and say, per slide, what you would otherwise only find by
           looking — clipped content, an asset that is not on disk, ⟨CLICK⟩ beats that do not
           line up with the builds; exit 1 on an error (an agent after every edit, you before a talk)
           EXAMPLE: decklight check deck.html   (--json for an agent, --no-render without Chrome)
  help     show this help, or a command's help: decklight help bundle
  version  print the installed version (also --version / -v)
`;
