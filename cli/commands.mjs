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
 *                    simply `[rest]` — the unit commands pass their own name
 *   alias            this name is another command, spelled differently; the
 *                    row it names is dispatched and the alias stays out of help
 *   spawn            a script to run in a child process instead of importing
 *                    (tools/voiceover.mjs parses argv and exits at load)
 */
export const COMMANDS = {
  init: { module: './init.mjs', main: 'initMain' },
  skills: { module: './skills.mjs', main: 'skillsMain' },
  cast: { module: './cast.mjs', main: 'castMain' },
  // `cast refresh` and `cast export` are castMain's own subcommands. They
  // used to be top-level `refresh` and `export` too, and a top-level `export`
  // meaning asciicast sat beside the deck's Export & share meaning PDF and
  // video (ROADMAP section 4).
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
  // Everything installed into YOUR library, one grammar (cli/library.mjs):
  // it replaced seven commands, one per kind (ROADMAP section 4).
  library: { module: './library.mjs', main: 'libraryMain' },
  'design-system': { module: './design-system.mjs', main: 'designSystemMain' },
  font: { module: './font.mjs', main: 'fontMain' },
  tts: { module: '../tools/voiceover-server.mjs', main: 'ttsMain' },
  lipsync: { module: '../tools/lipsync-server.mjs', main: 'lipsyncMain' },
  video: { module: '../tools/video.mjs', main: 'videoMain' },
  // THE command: `decklight <deck.html | url> [--no-trust]`. Reached through
  // routeForPath, never typed as a word, and listed nowhere (`hidden`): the
  // deck is the command.
  open: { module: './open.mjs', main: 'openMain', hidden: true },
  // the deck's narration into a folder, by an engine or by you (--mic): one
  // command for what `voiceover` and `record` did (cli/narrate.mjs)
  narrate: { module: './narrate.mjs', main: 'narrateMain' },
  enhance: { module: './enhance.mjs', main: 'enhanceMain' },
  comments: { module: './comments.mjs', main: 'commentsMain' },
  associate: { module: './associate.mjs', main: 'associateMain' },
  'report-bug': { module: './report-bug.mjs', main: 'reportBugMain' },
  doctor: { module: './doctor.mjs', main: 'doctorMain' },
  trust: { module: './trust.mjs', main: 'trustMain' },
  check: { module: './check.mjs', main: 'checkMain' },
};

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
export const START_COMMANDS = ['init', 'check', 'import', 'bundle', 'publish', 'doctor'];

/** One line each, written to fit a terminal — GLOBAL_HELP's paragraphs wrap. */
const SHORT = {
  init: 'start a deck here, plus the skill that teaches an AI agent to write it',
  check: 'lint one deck headlessly: what is clipped, crowded, missing or out of step, one exit code',
  import: 'bring a PowerPoint, Keynote or Google Slides deck across',
  bundle: 'one self-contained HTML file to hand over',
  publish: 'bundle and push to GitHub Pages, Netlify, Vercel or a folder',
  doctor: 'what this machine can do, and the install line for what it cannot',
  trust: 'the decks whose script you said you trust: list them, or forget one so it asks again',
};

export function shortHelp() {
  const width = Math.max(...START_COMMANDS.map((c) => c.length)) + 2;
  const rows = START_COMMANDS.map((c) => `  ${c.padEnd(width)}${SHORT[c] ?? commandSummary(c)}`);
  const more = listedCommands().filter((c) => !START_COMMANDS.includes(c) && c !== 'help' && c !== 'version').length;
  return `decklight — author, record, and package Decklight presentations

Usage:
  decklight <deck.html | url>    open a deck: live reload, edits from the browser, an AI agent on A
  decklight <deck> --no-trust   open it in no-trust mode: the safe way in for a deck you did not write
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
 * answer to the most natural thing to type. A deck opens in write mode, a
 * `.decklight` container is somebody else's deck and plays without trust, an
 * Office file or a Slides URL is something to import, a YAML script is a
 * terminal cast to record. A REPOSITORY is a deck to open too: `open`
 * clones it and opens the deck inside (#514), so `decklight <repo url>` is the
 * whole command. Unknown kinds return null and stay unknown commands; a file
 * that does not exist still routes, so the refusal names the file ("no such
 * deck: talk.html") instead of the word.
 */
/**
 * Does this name a git repository? Only the shapes that cannot be anything
 * else: the git transports (`git@host:…`, `ssh://`, `git://`), a URL ending in
 * `.git`, and a repository — or a branch or file in one — on the three hosts
 * whose URLs say so (`github.com/owner/repo`, `…/tree/<branch>`,
 * `…/blob/<branch>/<path>`). A web page is not a repository, so an arbitrary
 * https URL stays an unknown command rather than a clone attempt.
 */
export function isRepoUrl(arg) {
  const a = String(arg ?? '').replace(/#.*$/, '');
  if (/^(git@[\w.-]+:|ssh:\/\/|git:\/\/)/i.test(a)) return true;
  if (/^(https?|file):\/\/.+\.git\/?$/i.test(a)) return true;
  return /^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+(\/(tree|blob|-\/tree|-\/blob|src)\/.*)?\/?$/i.test(a);
}

export function routeForPath(arg) {
  const a = String(arg ?? '');
  if (/^https?:\/\/docs\.google\.com\/presentation\//i.test(a)) return 'import';
  if (isRepoUrl(a)) return 'open';
  if (a.startsWith('-')) return null;
  const ext = /\.([a-z0-9]+)$/i.exec(a)?.[1]?.toLowerCase();
  if (!ext) return null;
  if (ext === 'html' || ext === 'htm') return 'open';
  if (ext === 'decklight') return 'open';   // a container is without trust by nature: open.mjs says so
  if (ext === 'pptx' || ext === 'key' || ext === 'keynote') return 'import';
  if (ext === 'yaml' || ext === 'yml') return 'cast';
  return null;
}

/**
 * The word people reach for that is not the command's name. Every entry here
 * is a guess somebody would plausibly type; the values are the roster's names.
 */
export const SYNONYMS = {
  edit: 'open', serve: 'open', run: 'open', watch: 'open', write: 'open', dev: 'open',
  preview: 'open', play: 'open', show: 'open', view: 'open', open: 'open',
  new: 'init', create: 'init', scaffold: 'init', make: 'init',
  build: 'bundle', pack: 'bundle', flatten: 'bundle',
  deploy: 'publish', ship: 'publish', pages: 'publish',
  convert: 'import', pptx2html: 'import',
  env: 'doctor', diagnose: 'doctor', lint: 'check', verify: 'check', validate: 'check',
  update: 'upgrade', undo: 'restore', log: 'history',
  themes: 'theme', plugins: 'library', voices: 'library', engines: 'library',
  plugin: 'library', importer: 'library', transform: 'library', engine: 'library',
  voice: 'library', agent: 'library', extension: 'library', install: 'library',
  record: 'narrate', voiceover: 'narrate', narration: 'narrate', mic: 'narrate',
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
 * Synonyms first — `edit` is not a typo of `open`, it is the word for it —
 * then a unique prefix (`pub` → publish), then a name within two edits. Two,
 * not three: `cast` and `past` are one apart, `cast` and `pdf` are four, and
 * the useful distance is the one that catches a slipped finger and never an
 * unrelated word.
 */
export function suggestCommand(name) {
  const n = String(name ?? '').toLowerCase();
  if (!n || COMMANDS[n]) return null;
  if (SYNONYMS[n]) return SYNONYMS[n];
  const names = Object.keys(COMMANDS).filter((c) => !COMMANDS[c].alias && !COMMANDS[c].hidden);
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
  decklight <deck.html | repository url> [--no-trust] [--port 8788] [--git | --no-git] [--agent <name>] …
           open a deck. Write mode by default: live reload, every edit from the browser written
           to the file, the bridges this machine can run, an AI agent on A, one Ctrl-C.
           --no-trust is the same server in no-trust mode: every edit route refuses, the deck is
           served from its own directory under a CSP header, and what the file will execute is
           listed before it runs — the way in for a deck you did not write, and where --strict and
           --check live. The phone remote (--remote) and comments (M) work in either mode.
           A repository URL is cloned (in full) and the deck inside opened. A .decklight
           container is without trust by nature. (decklight <deck> --help for every flag)
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
           (this records a TERMINAL — decklight narrate --mic records your VOICE)
           EXAMPLE: decklight cast deck.term.yaml -o deck.cast.json
           EXAMPLE: decklight cast refresh casts/   (re-run each cast's script; rewrite the ones that drifted)
           EXAMPLE: decklight cast export demo.cast.json && agg demo.cast demo.gif   (asciicast v2)
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
  theme    validate a theme file against the token contract, or mark one for a deck to carry
           EXAMPLE: decklight theme check nord-deep.css
           EXAMPLE: decklight theme add nord-deep@acme-themes talk.html
  publish  bundle a deck and push it to GitHub Pages — deck to shareable URL in one command
           EXAMPLE: decklight publish deck.html   (prints https://owner.github.io/repo/)
  marketplace  register catalogs (git repos with .decklight/marketplace.json) — registered, not fetched
           EXAMPLE: decklight marketplace add owner/repo   (or a git URL, or a local path)
           EXAMPLE: decklight marketplace list              (offline-safe: reads only the cache)
  library  what this machine installs from a marketplace for its own use — plugins, skills,
           import adapters, build-time transforms, speech engines, voices, agents — one grammar:
           add, remove, list, and check (the gate a marketplace's CI runs); nothing travels in a deck
           EXAMPLE: decklight library add plugin timer      (then: decklight talk.html --no-trust)
           EXAMPLE: decklight library add engine azure-tts  (then: decklight tts --engine azure-tts)
           EXAMPLE: decklight library list                  (every kind, or name one)
           EXAMPLE: decklight library check transform grammar-check.mjs
  design-system  a company's tokens, art and slide layouts, referenced by a deck and served from
           the marketplace on this machine — add/remove/list/layouts, and check, the admission gate
           EXAMPLE: decklight design-system add acme@acme-mkt talk.html
           EXAMPLE: decklight design-system templates acme@acme-mkt   (the slots a slide fills)
           EXAMPLE: decklight design-system check systems/acme   (a catalog's CI gate)
  font     a typeface's files and licence, referenced by a deck so its faces travel with it —
           served from the marketplace on this machine, carried by bundle; add/remove/list, check
           EXAMPLE: decklight font add inter@type-mkt talk.html --use   (and open in it)
           EXAMPLE: decklight font check fonts/inter   (a catalog's CI gate)
  tts      serve the live voice bridge — the player synthesizes narration on the fly through it
           EXAMPLE: decklight tts        (then pick "Live voice…" in the deck's / palette)
  lipsync  serve the lip-sync bridge — offline visemes (rhubarb) + talking-head video (local GPU)
           EXAMPLE: decklight lipsync    (then pick "Character…" in the deck's / palette)
  video    render the deck to ONE narrated mp4 — a still per slide, held for its narration audio
           EXAMPLE: decklight video deck.html -o deck.mp4   (add --voiceover to synthesize first)
           EXAMPLE: decklight video deck.html --slides 5-9 --voiceover   (just those slides, voiced)
           EXAMPLE: decklight video deck.html --format webm --quality high --subtitles file
  narrate  the deck's narration into a folder beside it, one file per slide and per [click]
           beat: an engine reads the notes, or you do into the microphone (--mic), and
           → ends a beat AND reveals the next build (decklight cast records a terminal)
           EXAMPLE: decklight narrate talk.html --engine chirp --voice Achernar
           EXAMPLE: decklight narrate talk.html --mic   (serves it: a microphone needs 127.0.0.1)
           EXAMPLE: decklight narrate talk.html --slides 7   (just that slide, either way)
  enhance  add ElevenLabs v4 audio tags ([thoughtful], [sighs]) to the voiceover script, with the
           prompt ElevenLabs publishes for it — your agent drafts, decklight checks no word changed
           EXAMPLE: decklight enhance talk.html --slides 3   (or --all; --dry-run to only look)
  comments what reviewers said, resolved against the deck as it is now — a comment
           whose slide moved is found anyway, and one whose slide is gone is still shown;
           a reviewer leaves them with M in a deck opened either way (--no-trust for one
           they were sent), and \`comments submit\` pushes them to a review/<you>-<date> branch
           EXAMPLE: decklight comments talk.html   (--import to take in a reviewer's file,
           --incoming to see what reviews are waiting on the remote)
           EXAMPLE: decklight comments submit talk.html   (--pr opens a pull request)
  associate  wire double-clicking a .decklight file to decklight <file> (without trust by nature)
  trust    list the decks whose script you said you trust, or forget one so decklight <deck> asks again
           EXAMPLE: decklight associate   (per-user, no admin rights; --uninstall undoes it)
  report-bug  gather the version + environment facts a Decklight bug report needs, and the issue URL
           EXAMPLE: decklight report-bug   (prints and exits — nothing is sent anywhere)
  doctor   what this machine can do — Chrome, ffmpeg, git, the optional deps, the agents on PATH —
           and, for each thing missing, which commands it unlocks and the line that installs it
           EXAMPLE: decklight doctor
  check    lint ONE deck headlessly and say, per slide, what you would otherwise only find by
           looking — clipped content, a crowded slide, an asset that is not on disk, [click] beats
           that do not line up with the builds; exit 1 on an error (an agent after every edit,
           you before a talk); in the deck, the palette's Check deck… lists the same
           EXAMPLE: decklight check deck.html   (--json for an agent, --no-render without Chrome)
  help     show this help, or a command's help: decklight help bundle
  version  print the installed version (also --version / -v)
`;
