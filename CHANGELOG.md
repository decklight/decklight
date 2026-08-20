# Changelog

Compiled at release time from the merged PR titles — not updated per PR (see
`CLAUDE.md`). Sections cite SPEC and `MARKETPLACE.md` by mnemonic, never by
number. Each release also has a [GitHub release](https://github.com/decklight/decklight/releases)
carrying the same notes in prose.

## 0.6.0

28 commits since 0.5.0. The release where the deck's history stopped being
something git knew about and decklight did not. 0.5.0 went looking on other
people's machines; 0.6.0 looks at the record decklight has been keeping all
along — and makes it something you can read, walk, and undo from inside the
deck.

### The durable record (SPEC `PRESENTING`)

`decklight history` is the readout: what decklight committed, which commits
exist nowhere but this machine, and what to type about it. It is a **read**,
which is why it is not `restore` — that one is the write, and its listing is a
means rather than an answer.

`H` opens the same history in the deck. One overlay, one list, one preview:
`⏎` restores the selected version and `R` is the same door, because folding
restore in means there is one place a version is looked at and one place it is
chosen rather than two that had already begun to differ. Every row carries what
that version **was** and what it **changed** — a slide count, and `+added` /
`−removed` — because a hash and a subject cannot tell "tightened the wording"
apart from "cut four slides". The preview has its own transport, so a version
is judged by walking it rather than by its first slide. And `⏎` **asks** before
it writes: restoring is recoverable, but recoverable is not the same as
intended, and the premise of a history is that you opened it to look.

**decklight knows about other machines now.** A remote is offered at `init`,
named while authoring, and reported on exit; unpushed work is called out in the
four places it matters. A pull that would move more than the deck says so
before it moves anything — a fast-forward updates the whole working tree, and
that blast radius should be stated rather than discovered. In **present** mode a
deck cloned from a repo can see its upstream and offer to pull it, `H` being the
door there too: a presented deck has no history to preview, but it has the
question the author's deck does not — *has the author pushed since I cloned
this?*

**`--commit-messages`** ends the wall of `decklight: autosave deck.html`: an
agent reads each commit's diff and writes the subject. The commit lands first
and the subject arrives as an amend, so a slow or missing agent costs a
generically-worded commit rather than a lost one. Opt-in, because a diff of your
deck goes to whichever agent CLI is installed.

### Voice

The speech engine is a choice you can make **from inside the deck** — `N` → live
voice → engine lists every engine with its price note and, for the ones this
machine cannot use, what is missing and the terminal command that fixes it. One
readiness check answers for both the picker and `decklight author`, so a picker
cannot offer what `author` would refuse.

And the system voice you pick is the one that speaks. `createNative` ignored the
per-sentence voice entirely, so all 184 macOS voices played the first one — while
the log printed the name you asked for, which is why it survived so long. A name
this machine cannot say is now an error rather than a silent fallback to the
system default.

`data-narration="hold"` lets a slide hold a beat before the voice moves on, and
a slide with more ⟨CLICK⟩ segments than build steps speaks all of them instead
of dropping the surplus in silence.

### Elsewhere

An agent chip says a job is still running, for as long as it is. The content
editor shows indented, highlighted HTML. An installed theme records which
catalog it came from. `⇧V` records next to the deck rather than into Downloads.
A marketplace can be pinned with `--branch <ref>` — **and it takes a tag**, which
is how a catalog stays on a version known to work.

### Fixed

- **Safari lost the URL.** WebKit caps history writes at 100 per 10 seconds and
  counts `pushState` and `replaceState` against the same budget, so a held arrow
  key left the URL on an earlier slide **permanently** — only a further
  navigation would have resynced it, and at the end of a deck there are none.
  Writes coalesce to one per settled position now, and are verified. Found by
  the cross-engine harness, which is the first thing here ever to drive a deck
  outside Blink.
- **Ports were probed by connecting, not binding.** A Windows reservation has
  nothing listening on it, so the probe called it free and the bind failed
  `EACCES`.
- **A dump that hung took the whole harness with it.** `--virtual-time-budget`
  bounds Chrome's clock, not the wall clock; every dump carries a real timeout
  now, and a stall names the mode it happened in.
- **The soak was not hermetic** — a stray `decklight author` on the default port
  could hang it, because the deck it renders shares a basename with what that
  server was editing.

### Also fixed

- **`narration: { files: 'voiceover', ext: 'wav' }` now works.** The string form
  dropped `ext`, so the documented way to play back a recording — the exact line
  the `⇧V` done card prints — resolved `.m4a` and reported a missing file. The
  vanishingly-unlikely inverse holds too: a deck that wrote `ext: 'wav'` while
  `.m4a` files sit on disk played before this and stops now.
- The features deck and the site describe this release: a slide for the durable
  record, the engine picker on the voice slide, a matching site trait.

### For contributors

The release hook fires on a tag push rather than on the word "tag" anywhere in a
command. `npm run soak` leaves a receipt naming the commit it passed on, and the
pre-release checklist quotes it back — *"did you run the soak"* is a question
answered from memory, and a commit hash is an answer. `notesSegments` moved to
`tools/deck-html.mjs` so the runtime's segment-file mapper is tested against the
actual file-namer rather than a description of it.

## 0.5.0

15 commits since 0.4.0. The release that went looking on other people's
machines. 0.4.0 brought the tests to Windows and found the code ran there;
0.5.0 asked the next question — does it *look* right there, and does it work in
the browser the audience actually has — and the answers cost three real bugs,
two of which nothing in the repo could have caught from Linux and Chrome.

### Fixed

- **A slide transition lasted 350 SECONDS, not 350ms.** `--transition-duration`
  was read with `parseFloat(…) * 1000` and the shipped default is `350ms`, so
  every section kept its `entering`, `leaving`, `tr-<name>` and `active-out`
  classes for five minutes and fifty seconds instead of clearing at 410ms — the
  deck spent a whole talk believing it was mid-move. auto-animate had the
  identical bug, hit it, and fixed it in place; the transition path kept its
  copy, because the fix was made where the bug was seen rather than where the
  decision lived. Both now call one `cssDurationMs` (SPEC `MOTION`) (#330)
- **`A` could not run an npm-installed agent on Windows.** Every agent installs
  from npm and npm installs a JS CLI there as a `.cmd` shim, which Node has
  refused to spawn without a shell since CVE-2024-27980 — so the agent was
  detected, offered in the palette, and then did nothing. The fix is not a
  shell: with one the arguments stop being arguments and become a command line
  for `cmd.exe`, and one of them is your prompt, where `%VAR%` expands before
  any escaping could apply. decklight resolves the shim back to the script it
  runs and spawns node on that, so argv stays argv on both platforms. An agent
  that is found but cannot be run is no longer offered at all (SPEC
  `AGENT_UNITS`) (#318)
- **A stored API key was unprotected on Windows, and the CLI said otherwise.**
  `credentials.json` was written `0600` — a number with no meaning there, so the
  file carried whatever ACL the profile handed it while the wizard printed
  `(0600)` anyway. Windows now gets an explicit ACL, and every sentence decklight
  prints about it is read BACK off the file: the wizard's line, the author
  server's log, and a new `stored credentials:` line in `report-bug`. Setting
  that ACL is three `icacls` steps, not the two the usual recipe gives — an
  entry that is already explicit survives `/inheritance:r` untouched, which only
  a Windows CI run could have shown (SPEC `ENGINES#WIZARD`) (#319, #320)
- **The system voice was unreachable, twice over** — the local-voice probe and
  the native engine each had a defect that hid the other (#316)

### Added

- **⟨CLICK⟩ segments narrate the builds they were written for.** A narrated
  slide used to render as one fully-built still, so a deck whose notes were
  already segmented for its builds lost that in the mp4 — the words for the
  fourth bullet played over a slide that had shown all six from the first frame.
  The sync rule already shipped in the live player; this is the recorded render
  finally mirroring it. `tools/voiceover.mjs` synthesises each segment on its own
  and CONCATENATES them into the per-slide file, so it is the same characters and
  the same TTS bill, and every existing consumer of that file is untouched. A
  marker count that does not match the build count warns naming the slide and
  renders the old way — a wrong sync baked into an mp4 is worse than no sync
  (SPEC `PRESENTING`) (#317)
- **decklight tells you when a newer one exists.** `npx decklight` reuses
  whatever tree npm already unpacked and does not re-resolve `latest`, so the
  first version someone runs is the version they keep. The check is never on the
  critical path: a command prints from a cache file it already has, and the
  refresh happens in a detached child nobody waits for. Silent under `CI`,
  `NO_UPDATE_NOTIFIER`, or when stderr is not a terminal (#315)

### Verified elsewhere

- **`npm run verify` runs on Windows every PR**, and found `contrast` and
  `palette-rules` resolving `themes/` through `new URL(…).pathname` — the trap
  #273 swept out of `cli/` and `tools/`, wearing its Windows face
  (`D:\D:\a\decklight\themes`). Both had never run anywhere but Ubuntu. All
  fifteen *rendering* harnesses passed unchanged, which is the real headline:
  what renders, renders (#322)
- **macOS renders on every PR too**, through `chrome-headless-shell` — the only
  Chrome build a GitHub-hosted macOS runner can start, and four times faster than
  the full browser. Chrome and Chromium both die there with
  `bootstrap_look_up …MachPortRendezvousServer`, on all five flag combinations
  probed, because that runner's session does not permit the lookup. The
  self-hosted Mac runs the real browser on demand, all seventeen in ~155s
  (#324, #325, #326, #327)
- **The deck is checked in Gecko and WebKit** (`npm run cross-engine`, Firefox +
  WebKit through Playwright, every PR). Sixteen assertions per engine about the
  deck being USABLE rather than pixel-identical — three engines will never agree
  on antialiasing. It found a Safari bug on its first run: after fast navigation
  the URL sticks on an earlier slide permanently, because WebKit rate-limits
  history writes and counts `replaceState` against the same budget (#328, open)
  (#329)
- **The soak walks the library, the chrome boundary and the history it builds**
  — 50 steps now. All six unit kinds install, then `list` and `remove`; the
  admission gate's printed digest is asserted to BE the `sha256` a catalog pins;
  a presenter plugin proves `present` layers it on while `bundle` carries no byte
  of it; `restore` finally uses the six steps of history the author leg spends
  building (#321)
- **Motion has a test file**, which is how the transition bug above was found:
  15 unit tests over the decisions (a duration read from CSS, a FLIP from two
  rectangles) and 8 more assertions per engine in the smoke test (#330)

## 0.4.0

20 commits since 0.3.0. The release that stopped taking its own word for it.
0.3.0 shipped marketplaces anyone could host — and a private one could be
registered and then never installed from, because the catalog was read with your
git credentials and its contents were fetched with none. Fixing that turned into
the theme: a journey test that installs the published package and walks it, a
platform that had never run the tests at all, and a video export that had been
throwing away the builds it was asked to show.

### Breaking

- **A marketplace is CLONED, not fetched a file at a time** (`MARKETPLACES#CLONE`,
  SPEC `MARKETPLACE_REGISTRY`). `owner/repo` is shorthand for a clone rather than
  for `raw.githubusercontent.com`, so it uses **your** git credentials and a
  private marketplace works the way `git clone` does in your terminal. The clone
  is kept at `~/.decklight/marketplaces/<name>/` and entries install from it, so
  installing touches no network and the manifest and the artifacts provably share
  one commit — printed by `marketplace list` as `@d19d7e8`. **A catalog cached by
  0.3.0 has no checkout until its next `marketplace update`**, and an install
  before that is a named refusal naming that command, never a silent fetch that
  would only have worked for a public repo (#288, #289, #290)
- **A silent slide builds as it goes** when filmed. Every capture used to be
  `#/<n>/999` — the last build — so a deck's builds never appeared in its video
  at all; the slide arrived finished. Each build step is now its own frame, held
  for `--hold`, so a filmed deck gets longer the more it builds. `--build-hold
  <s>` paces the build-up frames alone (#299, #301)

### Added

- **`npm run soak`** — the release gate this project did not have. It runs `npm
  pack`, installs the tarball into an empty project **whose path contains a
  space**, and drives the installed `decklight` through one user journey: create,
  import, marketplace (clone, pin, install), author (slides added by writing the
  file the way an agent does, edited over the HTTP API, commits watched as they
  land), present, bundle, transform, pdf, publish, validate, record, film, open.
  42 steps, ~70s. Everything it cannot do on a given machine skips **by name**
  (#291, #293, #296, #297, #298, #302)
- **Windows is tested.** `npm test` runs there on every PR — 948 tests, 64
  seconds. `tools/chrome.mjs` can find a browser there at all, which `pdf`,
  `video` and `shot` all needed (#303, #304, #305)
- `--build-hold <s>` for `decklight video` (#301)
- A clone failure names what is actually missing: `git credential fill` decides
  whether this machine has a credential for the host, so the setup instructions
  print when they apply and stay quiet when they do not (#290)

### Fixed

- **`npm test` ran zero tests on Windows** — `node --test test/*.test.mjs` needs a
  shell to expand that glob, and npm runs scripts through `cmd`/`pwsh`. It exited
  1 before the suite started, for as long as the script has existed, so any claim
  that decklight had been tested there was wrong (#306)
- A private catalog's 404 no longer asserts the manifest is missing — the two
  cases are indistinguishable to an unauthenticated fetch, and it now says so
  (#288)
- `decklight video --help` printed to stderr and exited 1, alone among 26
  commands (#294)
- `decklight present`'s refusals did not name themselves — a bare `deck not
  found:` in a terminal running several tools cannot be traced to what printed it
  (#295)
- `themeNameFrom()` split a path on `/` alone, so `theme check C:\themes\aurora.css`
  reported the whole path as the theme's name — and `theme add` would then have
  refused a perfectly good file (#305)
- `linuxFiles()`/`darwinFiles()` built Linux and macOS paths with the host's
  separator, describing a `.app` bundle at `C:\Users\…`; `onPath()` sent a
  backslash path looking down `$PATH` (#305)
- `resolveSource`'s `<url>/raw/HEAD/<rel>` was GitHub-shaped and wrong for GitLab,
  independent of auth — gone with the fetch it belonged to (#289)

### Testing

- `test/video-e2e.mjs` had been filming a **403 error page** since the render
  moved onto the loopback server: its fixture lived in a dot-prefixed directory,
  which the serving core refuses. Every assertion it made — file exists, ~2s
  long, h264 and aac streams — was true of that page, because none looked at the
  picture. It looks now (#300)
- The suite is portable: `PATH` is spelled `Path` on Windows, a `#!/bin/sh` stub
  is not executable there, `os.homedir()` does not read `$HOME`, and a directory
  cannot be removed while a process holds it. A `.gitattributes` keeps text LF on
  every platform (#305)

## 0.3.0

197 commits since 0.2.0. The release where a deck stops being something you
have to trust blindly: you can play someone else's deck safely, verify who
signed it, and install themes, engines and extensions from marketplaces anyone
can host — without third-party code ever executing in front of an audience.

### Breaking

- `decklight dev` is now `decklight author`; `dev` survives as a permanent
  hidden alias. `decklight edit` is **removed** and refuses out loud with the
  new command named — the `/edit/*` endpoint contract is byte-for-byte
  unchanged (#182)
- `--remote` and `--host` are gone from the author server; the phone remote
  lives on `present` (#204)
- Markdown slides are removed (#165)
- 16 homage and novelty themes are no longer built in — they install from the
  official marketplace (#216)

### Playing a deck you did not author

- `decklight present` — a read-only server with no `/edit/*` routes registered
  and a `Content-Security-Policy` sent as an HTTP header, which the document
  cannot override (#185)
- The ingredients label — the runtime hashed against the known-good build, every
  script block and executable attribute itemised as accounted or unaccounted,
  and never a safety verdict (#186, #253)
- `--strict` strips every block that is not the verified runtime and still
  presents faithfully; verification failure degrades to it and says so in the
  terminal, never on the audience-facing page (#187)
- Sigstore signing — `publish` signs by default, `bundle --sign` opts in, the
  detached sidecar is authoritative, and `present` names the signer (#188). A
  verified signature that names nobody no longer gates as verified (#259)
- `.decklight` — deck, signature and manifest in one file, verified before it
  renders, double-click landing in `present` on macOS, Windows and Linux
  (#189). Renamed to `.html` it still plays: the archive lives inside an HTML
  comment closed by the ZIP's own comment field
- The manifest's origin is never printed, because the signature does not cover
  it (#249)

### The marketplace

- `decklight marketplace add|list|update|remove` with `owner/repo`, a git URL or
  a local path; `.decklight/marketplace.json` is the manifest, and the
  first-party marketplace is registered on first run and never fetched until you
  browse (#183)
- Browse in the theme picker (`T`) — preview a marketplace theme live, Enter
  installs it through `theme add` into **Added** (#202, #203). Author mode only:
  a presented deck never touches the network for a theme
- Build-time transforms — extensions run in Node during `bundle` and return
  HTML, so nothing executable travels (#210, #211), with installed import
  adapters running through the same loader (#214)
- `decklight extension check` — lint, then run the submission behind a process
  boundary rather than in the checker's own (#213, #252); installs pin to the
  digest the catalog admitted (#242). The boundary grants its reads on the real
  path, so a submission checked from a symlinked directory — macOS `/tmp`, or
  any temp dir — is no longer refused for the checker's own path handling (#273)
- Presenter-library plugins — chrome from your own library, contained by a
  sandboxed frame, unable to touch slide content (#205)
- Templates, agent skills, import adapters (#206), publish targets beside
  gh-pages (#208), and voices that distribute as references only, so no
  likeness travels (#207)

### Engines on demand

- The wizard framework — core renders, a plugin only declares a schema; the
  prompt names its asker and its destination in words the plugin cannot write
  (#200, #201, #257). Keys land `0600` under `~/.decklight/`, never in a deck
  and never in a bundle of it, and the wizard never triggers in `present` or
  from `file://`
- TTS engines from a marketplace (#270), lipsync engines across a binary, a
  python venv and an API key, and an extensible `A` agent roster with the
  preferred agent remembered (#271)
- An engine declares what it needs from the machine, not just from you (#272)

### Authoring

- Element edit mode (`E`) — a right-click menu to remove, edit or animate any
  element on a slide (#266)
- Deck history (`R`) with live preview and the way back to any of it (#134,
  #136), and one git commit per agent edit carrying the agent's own message
  (#135, #142, #143)
- `decklight upgrade` brings a self-contained deck's runtime up to the installed
  version (#29)
- `decklight import` (PowerPoint, Keynote, Google Slides) (#155), `decklight
  pdf` (#150), `decklight video` (#42), `decklight publish` to gh-pages
- Background image and video slides with full-bleed layouts (#45), runtime LaTeX
  via Temml → MathML Core (#46), theme-aware SVG charts from inline JSON, and
  the ink overlay — `W` pen, shift-`W` laser (#44)
- `split` gains a shared top edge and a footer region (#160); content can no
  longer overflow up onto the pinned title (#153); the overflow guardrail stays
  live (#184) and keeps watching nodes that arrive after it arms (#251)
- `decklight init` offers a git repo, colored next steps, `--open`, and asks
  where the agent skill should go (#120)

### First run

- **A welcome card the first time a browser ever opens a deck, and one tip on
  every load after** — never both in the same load, because a card that has
  just explained `/` should not be followed by a toast explaining `/` (#282,
  closing #149 and #124)

### Narration

- Your own ElevenLabs voices (#148), with eleven_v3 audio tags directing the
  delivery behind an opt-in (#265)
- The voice the machine already has — macOS `say`, Windows SAPI — used when
  nothing else is configured (#156)
- Piper offers the voice download instead of failing on the first sentence
  (#159), with a command that actually runs (#157)
- Recorded narration from a private bucket through signed, expiring manifests
  (#152); a voiced deck says so, once (#151)
- The phone remote moved to `present`, where there is nothing to edit (#199)

### Themes

The graded set and the full `reveal-*` compat set — 46 — stay compiled in, so
`T` works offline. The 16 homage and novelty themes moved to
`decklight/decklight-plugins-official` and install like any third-party theme
(#216):

```sh
decklight theme add star-wars@decklight
```

`theme check` travels with a theme wherever it lives; `palette-rules` is a
curation bar for this project's own collection and stops at its edge.

### Security

A hardening pass across the new surface: the served root scoped to the deck's
directory with dotfiles and non-deck types refused (#254), the CSP set at one
seam (#247), `/edit/*` gated on `Origin` (#243), zip inflation capped (#246),
bridge-supplied voice names rendered as text rather than markup (#245), the
audited bytes served instead of re-read from disk (#248), a hostile
`.decklight` filename kept out of the macOS launcher shell (#241), and
`shot`/`video` rendering over loopback under the present CSP instead of
`file://` (#258).

### Fixed in the pre-release review

The tree was reviewed before tagging; two of the findings were live bugs rather
than untidiness.

- **`decklight import` could not run at all from an install path containing a
  space** — a URL `.pathname` is percent-encoded, so it read its own `themes/`
  as `…/My%20Name/…` and died on a raw ENOENT. Every Windows profile with a
  space in it. Two more of the same shape in `tools/video.mjs`, one of which
  made `node tools/video.mjs` silently do nothing (#275)
- **An imported deck reported its own runtime as untrustworthy.** `decklight
  present` printed `runtime 0.3.0 — DIFFERS from this install's build of 0.3.0`
  on a deck decklight had just written, because `import` inlined the runtime
  through a private copy of the transform that escaped `</script` but not
  `<!--`. The auditor now calls the same function the producers call, rather
  than reproducing it (#276)
- One HTML escape per side, correct in element text and in a double-quoted
  attribute, replacing four that escaped three different character sets under
  two names. `decklight init` now writes `&quot;` in a title containing quotes
  (#277)
- A command that fails prints `decklight <cmd>: <message>`, never a raw Node
  stack; the stack moves behind `DECKLIGHT_DEBUG` with a line saying it is a
  bug worth reporting (#278)

### Project

- SPEC sections are named and cited by mnemonic, never by chapter number (#166)
- The 3,600-line engine split into feature modules (#147); `src/core/` is now 18
- Every deck stamps the version it actually ships, and the build refuses on
  drift (#192)
- The agent loops — triage routing, spec-refine, bug-repro, pr-fix, the PR
  babysitter, greenlight, groom and rebase — with a merge queue gating
  `merge_group` and DCO enforced on every commit
- `engine.js`'s `init()` — 1,618 lines in one function — gave up six clusters
  to modules that can be tested without a browser: the overflow watch, module
  navigation, the finder's index, the debug ring buffer, layout cycling and the
  palette's query handling. Both of the overflow guardrail's shipped bugs were
  about *when* a slide gets measured, and both had reached a release because
  the only way to reach that code was to drive Chrome (#280)
- One package root and one runtime-inlining transform (#276); one failure
  convention, so a command main can be called in-process instead of taking the
  test runner down with it (#278). The suite went 843 → 909 tests
- The docs, the site and the decks were checked against the code and brought
  back in sync (#283). The agent skill's indexed description — the string
  agents match on — had gone stale at "62 built-in themes" for the second time
  in two releases, the site's terminal cast still demonstrated the removed
  `decklight edit`, and a showcase quiz was grading its audience against "62
  themes in 5 packs". Two doc-rot tests now compare every theme and pack count
  in a shipped file against `themes/` and `packs.json`, and refuse any file
  that invokes a removed command

## 0.2.0 — 2026-07-14

105 commits since 0.1.0, and the release narration became the headline: live
voice synthesized from speaker notes as you present, three TTS engines behind
one bridge, the voice as the clock for auto-advance, closed captions, a
lip-synced character overlay, `decklight init` scaffolding the agent skill
alongside the deck, `decklight dev` as the whole authoring loop, 62 themes on
one token contract, and the relicense to Apache 2.0 with a DCO gate. Full notes:
[decklight 0.2.0 — the deck presents itself](https://github.com/decklight/decklight/releases/tag/v0.2.0).

## 0.1.0 — 2026-07-10

The first public release: a decklight deck as one self-contained HTML file,
themed, keyboard-driven, and openable in any browser with no software. (v0.1.1
was tagged but never reached npm — its release run failed on tests fixed later.)
