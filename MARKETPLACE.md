# Decklight Marketplace — design record and epic

Status: **draft for review**. Not filed as an issue yet.

This is the consolidated record of the marketplace design, including the two
late additions that absorbed most of its safety burden: `decklight present` and
the `.decklight` container. Where a later decision supersedes an earlier one, the
earlier one is marked rather than deleted — the reasoning matters.

Sections are cited by **mnemonic, never by number** (the SPEC.md convention
from #166): `CAPITALS_WITH_UNDERSCORES`, and `MNEMO#SUB_TOPIC` for a sub-topic
of the same decision — e.g. `ENGINES#WIZARD`. Numbered references rot on every
insertion; a mnemonic survives reordering, and a broken one is greppable.

---

## WHY — The problem the design keeps circling

Claude Code's plugin marketplace is safe enough because **the installer is the
person at risk**: a developer chooses a plugin, it runs on their machine, at
their privilege. Its own docs are blunt that nothing else protects them —
plugins "execute arbitrary code on your machine with your user privileges", and
Anthropic "can't verify that they work as intended".

A decklight deck breaks that symmetry. A deck travels — emailed, published,
presented — so code inlined into it runs in front of an audience that installed
nothing and consented to nothing. Every decision below follows from refusing
that inversion.

---

## DECISIONS

### MARKETPLACES — Shape and tiers

- **Decentralized git-repo marketplaces**, mirroring Claude's layout:
  `.decklight/marketplace.json` at the repo root, added with
  `decklight marketplace add owner/repo`. No central registry to host or
  moderate.
- **A first-party vetted marketplace in the decklight org**
  (`decklight/decklight-plugins-official`), registered automatically on first
  run — **registered, not fetched**. The network is touched only when the
  browse UI is opened, so a deck on conference wifi, on a plane, or air-gapped
  behaves identically.
- "Vetted" means a written bar enforced by CI (`theme check`, `extension
  check`), not a folder with the project's logo on it.
- Third-party marketplaces are unreviewed, auto-update off by default; the
  community one screens submissions and pins what it screened. This is
  Claude's tiering, adopted deliberately. For a code-carrying entry the pin
  is not a courtesy the tier extends but a fact decklight itself enforces: a
  `transform`/`importer` entry carries the module file's `sha256`, and `add`
  refuses to install without it or past a mismatch (`EXTENSIONS#PIN`, SPEC
  `UNIT_PINNING`).

**`MARKETPLACES#CLONE` — a marketplace is cloned, and `owner/repo` is
shorthand for the clone.** The layout above mirrors Claude Code's; this is the
fork where the implementation had quietly stopped mirroring it, and #286 is
what that cost. `owner/repo` used to mean an unauthenticated fetch of
`raw.githubusercontent.com` — one URL for the manifest, another per entry —
while only a non-GitHub git URL or the SSH form reached `git clone`. Three
things were wrong with that, and one change fixes all three:

- **A private marketplace could not work.** An anonymous fetch has no
  credentials to offer, so a private repo answered 404 — indistinguishable
  from a public repo with no manifest, which is what the message asserted
  (#287). Worse, the two halves disagreed: a catalog registered through the
  SSH form (which *does* clone) then failed at every install, because the
  artifact path had no credentialed branch at all. A team publishing an
  internal catalog to their own org — the case the decentralised design
  invites — had no working route but a hand-managed local clone.
- **An install could match no commit.** The manifest was read at `HEAD` and
  each artifact fetched at `HEAD` separately, so a push between the two
  produced an install matching no single state of the marketplace.
- **The URL was GitHub-shaped anyway.** `resolveSource` built
  `<url>/raw/HEAD/<rel>` for any https marketplace, which is not how GitLab
  serves raw files — a bug independent of auth.

So `add`/`update` shallow-clone the source into
`~/.decklight/marketplaces/<name>/`, drop its `.git` (what is kept is a
checkout, not a repository — nothing pulls into it, `update` re-clones), record
the commit in the registry, and every entry resolves into that checkout. The
credentials are the caller's own, exactly as `git clone` in their terminal;
installing reads the disk; manifest and artifact provably share a commit.
A local-path marketplace keeps no checkout — its directory already is one, and
copying somebody's working tree would hand them a stale second copy of files
they are editing.

**The failure teaches setup only when setup is what is missing.** A clone that
fails asks git whether it actually has a credential for that host — `git
credential fill`, prompts disabled, the credential discarded unread — and says
one of two different things: how to configure a helper (`gh auth setup-git`),
or that a credential exists and therefore the name or the access is the
problem. Reading `credential.helper` out of the config would answer a different
question and get it wrong exactly where it matters, since macOS ships a global
`osxkeychain` helper: "configured" is true on a machine that has never stored a
GitHub credential in its life, which is the precise state that fails. Advice
that is wrong half the time is what teaches people to skim past the last line
of an error. An SSH URL is answered with the key (`ssh -T git@github.com`),
never with helper setup, because a helper is not in that path at all.

**What this does NOT change is the invariant** (SPEC `MARKETPLACE_REGISTRY`):
`add` and `update` were already the only two moments that touch the network,
and they still are — the clone replaces a fetch at the same moment rather than
adding one, and it takes network *off* the install path. The trap Claude Code
documents around this — a background auto-update whose `git pull` disables
credential helpers, so private HTTPS marketplaces fail to refresh — cannot
arise here, and not by luck: registered-not-fetched means there is no
background refresh to authenticate.

Two costs, taken deliberately. A clone is bigger than one JSON file (the
first-party catalog: 92K at `--depth 1`), and a catalog already cached by an
older decklight has no checkout until its next `update` — which the install
error names rather than silently falling back to a fetch that would only work
for a public repo. Sparse checkout is available if a monorepo catalog ever
makes the size real: a manifest names every entry's `source` up front, so the
paths are computable from the catalog with no new field.

### EXTENSIONS — Build-time by default

The decision that resolves the safety problem.

| | Runs where | Trust model | Travels? |
|---|---|---|---|
| **Build-time transform** (default) | Node, on the author's machine, during `bundle` | Installer is the risk-bearer — Claude's model, defensible for the same reason | **No** — only its output does |
| **Presenter-library plugin** | The presenter's own machine, via `decklight present` | Installer is the risk-bearer | **No** — lives with the presenter, not the deck |
| **In-deck runtime** (deferred) | The audience's browser | Recipient consented to nothing | Yes — which is the problem |

A transform takes the deck's HTML and returns HTML. That covers nearly
everything that *looks* like it needs in-deck code: new chart types, mermaid or
PlantUML diagrams, alternative renderers — all compile to SVG at bundle time and
the audience's browser executes nothing new. New layouts, transitions and build
entrances are CSS. Importers and TTS/lipsync engines already run CLI-side.

**The first cut ships no in-deck execution surface at all.** If a live case
later justifies it (a poll, an audience timer, live data), it arrives declared
and contained: Worker isolation, a CSP whose `connect-src` allowlist is the
extension's declared origins, consent at first open by the recipient, full-DOM
access refused at the `bundle` boundary, and no execution in `?embedded`,
`?print`, `pdf` or `video`.

**`EXTENSIONS#CONVENTION` — the v1 calling convention (full contract text: SPEC
`EXTENSIONS_TRANSFORMS`).** A transform is one file, `transform.mjs`, a single
default export `async function transform(html, opts)` returning HTML. `html`
is the deck's OWN source, before `bundle` inlines anything — a transform
compiling `<pre class="mermaid">` needs the markup the author wrote, not
decklight's runtime already spliced in, and a small fixture beats needing a
full bundled deck to test against. `opts` is reserved and empty in v1; adding
a field to it later is additive under `UNIT_COMPAT` and does not bump
`TRANSFORM_API_VERSION` — only a change that would break an existing
transform's assumptions does. Loaded by dynamic `import()`, **in the same
process as `bundle`** — no subprocess, no VM sandbox — because the trust model
for build-time code is already decided above (installer is the risk-bearer);
isolating a transform from the process that invoked it would defend against a
threat this design already accepted. Contrast `PRESENT#PLUGINS`, sandboxed
because that code runs on a presenter's machine at a stranger's request — a
different actor, a different risk.

**`EXTENSIONS#LOADER` — the pipeline stage (`cli/loader.mjs`).** A transform
installs through the same seam as every other unit (`decklight transform
add/list/remove`, `cli/units.mjs`), and `bundle --transform <name>` (repeatable,
applied in the order given) runs it against the deck's own source before
anything else is inlined — ahead of theme/image/script inlining and therefore
ahead of signing, since the whole bundle pipeline runs top to bottom. Two
things the loader alone decides, both left open by `EXTENSIONS#CONVENTION`:

- **`apiVersion` currency**, not merely shape. `marketplace add`/`update`
  already validated the field is a positive integer; the loader is where a
  transform declaring more than `TRANSFORM_API_VERSION` actually gets refused,
  by name, before it runs. That number is not persisted onto the installed
  `.mjs` — there is nowhere on a single file to put it — so the loader
  re-reads it from the catalog cache, the same way `adapterFor` re-reads an
  importer's `extensions` rather than duplicating it into the library. A
  transform with no matching cached entry (its marketplace was since removed,
  or it was placed in the library by hand) still runs — refusing an
  explicitly-named, already-installed transform over metadata that merely
  went missing is not what this design's trust model asks for.
- **Every failure shape collapses to one clean, transform-naming error** — no
  default export, an export that is not a function, a thrown/rejected value,
  a non-string return — never a raw stack trace, the same UX every other
  unit-installing surface already gives.

**`EXTENSIONS#CHECK` — landed (full contract text: SPEC `EXTENSIONS_CHECK`;
`cli/extension.mjs`, `tools/extension-check.mjs`).** `decklight extension
check <file>` is the marketplace admission gate the WHY section already
promised ("a written bar enforced by CI"), for the same reason `theme check`
is one: it operates on a source FILE,
not an installed, catalog-backed unit — a marketplace repo's own CI runs it
against a submitted `transform.mjs` before merging the PR that adds the
catalog entry, which is what "failure blocks publish" means here — *publishing
the extension to a catalog*, not `decklight publish`ing a deck. `bundle` and
`publish` stay exactly as `EXTENSIONS#LOADER` left them: an installed
transform a deck actually uses is never re-checked on that path, the same way
an installed theme is never re-run through `theme check` on `bundle` — the
gate sits at the marketplace's door, once, not on every local iteration.

Named `extension`, not `transform`, on purpose: `decklight plugin check`
already exists for presenter-library plugins (a different risk — a
stranger's code on the presenter's machine, SPEC `PRESENT#PLUGINS`); this is
the gate for **build-time** code units specifically, and `EXTENSIONS#ADAPTEREXEC`
will need the identical two-phase shape for import adapters once *their*
calling convention is frozen. `--type transform` (default, and the only kind
this command implements yet) leaves that room without a rename later.

Three phases, and they are not the same kind of check:

- **Lint the source text — advisory.** Refuses `fetch(`, `eval(`,
  `XMLHttpRequest`, or a dynamic `import(` appearing anywhere in the file, by
  the same shallow source-text scan `PRESENT#PLUGINS` already uses for its
  own lint. It states the bar and catches the honest mistake; it does not
  constrain a determined one — a static `import { execSync } from
  'node:child_process'`, a `new Function('return fetch')()`, a
  `globalThis['fet' + 'ch']` all pass a regex unmatched, and no source scan
  closes that class. Unlike a presenter plugin's lint there is no sandbox at
  USE time standing behind it (`EXTENSIONS#LOADER` runs an installed
  transform as trusted, unsandboxed Node — the installer bears that risk, by
  this document's own decision above); what stands behind it *during the
  check* is the process boundary below. Admission screens; it does not
  absolve.
- **The submission executes only behind a process boundary.** The checker
  never `import()`s the checked file into its own process — that would mean
  a marketplace's CI running a stranger's code at CI privilege *before*
  deciding whether to admit it. It is run in a separate Node process under
  the permission model (`--permission` / `--experimental-permission`; a Node
  with neither is a named refusal, never a silent unsandboxed run): reads
  limited to decklight's package and the submission's own directory, no
  writes, no child processes, no workers, a replaced environment so the CI
  runner's secrets never enter the child, a temp working directory, and a
  15s wall-clock kill of its own. Stated honestly, the boundary does not
  cover the network — Node's permission model restricts files, processes and
  addons, not `fetch` — so it protects the checking machine, not the
  network it sits on.
- **A headless load of the transform's OUTPUT, not its source.** The checked
  file is run against ONE small fixture this command owns — **randomised per
  check** (a fresh nonce in title, heading and body), so a submission cannot
  recognise the fixture and behave only for the checker — the same "a small
  fixture beats needing a full bundled deck" reasoning
  `EXTENSIONS#CONVENTION` already used for testing the contract itself: this
  proves the CONTRACT, not "does it handle any particular author's deck."
  What the headless render (`--headless --dump-dom`, same technique
  `test/harness.mjs` already gives the render suite) refuses is **any
  `<script>` block and any inline event handler (`on…=` attribute)** —
  the handler is exactly as executable as the script, just waiting for a
  click, and a `<script>`-only grep missed it — because "build-time
  transforms produce output, not code; nothing executable travels" (this
  document's SUPERSEDED list) is an already-decided invariant, and this is
  the one automatable place that actually proves a given transform honors it
  rather than merely being asked to. (The acceptance checklist's older phrase
  — "a script not declared in the manifest" — predates that invariant and is
  superseded by it: there is no such declaration, and no exception.)
  `apiVersion` currency plays no part here — that is `EXTENSIONS#LOADER`'s
  question at USE time, not this command's question at ADMISSION time.

What the gate is, honestly: a screen, not a proof. Code that behaves during
one check can behave differently once installed — no admission-time analysis
of Turing-complete code closes that — so the load-bearing decisions remain
the digest pin (`EXTENSIONS#PIN`) and the trust model above; the check
exists so the obvious
failures never reach either.

Right-sized as ONE ticket, unlike `EXTENSIONS#TRANSFORMS`: that one fanned
into four because it bundled a design freeze with three separate execution
surfaces (the contract, the loader, running it from `import`). Here the
design is what this paragraph just settled, and the remaining surface —
lint, fixture run, headless dump, `decklight extension` command — is
comparable in size to `theme add`/`check` landing together (#206). It needs
Chrome the same way `npm run verify`'s render harnesses do, and answers the
same way they already do when Chrome is absent: a named refusal, never a
silent pass. Both executions carry a hard 15s wall-clock kill — the
transform's own run in its child process, and the headless load, whose kill
is separate from `--virtual-time-budget`: that flag bounds Chrome's own
clock, not the real one, and a synchronous `alert()`/`confirm()`/`prompt()`
or an infinite loop in the OUTPUT blocks the render loop outside it entirely
(measured, not theoretical) — this command's whole premise is running code
nobody has vetted yet, so a submission that never returns has to become a
refusal too, not an unbounded hang in whatever is running the check.

**`EXTENSIONS#PIN` — landed (full contract text: SPEC `UNIT_PINNING`).** The
pin the tiering above reasons about, made real where the risk lands rather
than left as a property a good marketplace merely has. What `extension
check` admits and what `transform add`/`importer add` later install were two
reads of a moving ref (a relative `source` resolves against the marketplace's
default branch — no branch name guessed at, then or now that the resolution
lands in a clone, `MARKETPLACES#CLONE`), with nothing holding them equal: a repo edited after admission would install and then run, unsandboxed,
in the installer's own Node process. Now a code-carrying entry carries the
module file's `sha256` — a content digest, not a commit SHA, so it holds for
raw URLs, git URLs and local directories alike, against the math rather than
the host — and installing is held to it twice: no pin, no fetch; a fetched
module off the pin, no write, both refusals named. `extension check` prints
the digest on a pass, so the admission gate emits the very pin the catalog
entry carries. Data kinds stay unpinned (a theme re-passes its whole contract
at `theme add`; templates and skills execute nothing), and a hand-placed unit
still runs — the pin governs what an *install* writes, `EXTENSIONS`' trust
model still governs running it.

### PRESENT — `decklight present`, the trusted local viewer

`decklight present <deck>` serves a deck read-only over localhost and is the
safe way to play a deck you did not author.

- **The audit runs because it is the only way in.** A standalone `verify` is a
  step people skip; folding it into the command used to present means it runs
  every time at no extra effort.
- **A real CSP.** Serving over localhost sets `Content-Security-Policy` as an
  **HTTP header**, which the document cannot override — unlike a `<meta>` CSP
  inside a file an attacker may have edited.
- **`--strict` neutralizes rather than merely warns.** Because a well-formed
  deck carries no third-party JS, strict mode strips every script block that is
  not the known-good runtime and still presents the deck faithfully: content is
  HTML, themes and layouts are CSS, charts are JSON interpreted by the trusted
  runtime, casts are JSON interpreted by the trusted player.
- **Presenter-library plugins** are injected at serve time from the presenter's
  own library — so the deck is unchanged and the plugin is theirs. Scope is
  **chrome only** (timer, teleprompter, ink extras, confidence monitor); a
  plugin may not transform slide content, or a deck stops being a deterministic
  artifact. **Shipped as `PRESENT#PLUGINS`, and the enforcement is structural
  rather than a rule**: a plugin's code runs in `<iframe sandbox="allow-scripts"
  srcdoc=…>` with no `allow-same-origin`, so it holds an opaque origin and
  `parent.document` throws. The closed manifest vocabulary and the source lint
  sit in front of that and are worth having, but neither is load-bearing —
  they only ever meet a plugin whose author declared what they were doing, and
  the test that matters smuggles a hostile one past both. Notes reach a plugin
  only when it declared `needs: ["notes"]`, because a teleprompter is in-scope
  chrome and a teleprompter without the deck's notes is a text box; reading is
  not transforming, and the declaration is what keeps a timer from quietly
  receiving the talk.
- **It reports an inventory, never a verdict.** "3 script blocks: runtime 0.3.0
  ✔, 2 unaccounted" — not a green checkmark. The scan is heuristic; a defeatable
  verdict manufactures confidence the mechanism cannot back.
- **On verification failure it degrades to `--strict` and says so** — in the
  terminal, never on the audience-facing page. Ten minutes before a talk is the
  worst moment for a refusal, and a `--force` escape hatch teaches the wrong
  reflex; this way the show goes on with every unaccounted script stripped, and
  nothing unverified ever executes.
- **Architectural bonus:** the phone remote and its QR currently live in the
  *edit* server (`cli/edit.mjs`, gated by `allowRemote`), so getting a clicker
  today means running an editing server with `/edit/*` write endpoints against
  your deck. `present` is the natural home for speaker view and the remote with
  **no edit surface registered at all**.

### DECK_FILE — `.decklight`, a signed container, not a relabel

Renaming the file changes no bytes and is not a boundary; anyone can rename it
back. It is a **default-path change**, which is worth having, but it earns its
existence only as a container:

```
talk.decklight  =  deck.html  +  signature (Sigstore keyless)  +  manifest
```

**Why `.decklight` and not `.deck`:** `.deck` is Decker's native format — an
active, cross-platform HyperCard revival whose files are ALSO interactive
decks, exported as single HTML documents, in front of an overlapping audience
(press-covered as recently as July 2026). Fighting a liked tool for the OS
association hands the loser's users a confusing double-click. `.dck` is
Forge/XMage Magic decks. `.decklight` is verbose, collision-proof and
self-describing — the verbosity is the feature.

- `decklight present talk.decklight` verifies **before** rendering.
- The manifest (runtime version, extensions, origin repo, commit SHA) sits
  *outside* the payload, where a tamperer cannot edit it in the same pass —
  which also puts it outside the signature: the sidecar attests to the payload
  alone, so the manifest stays a claim. `present` therefore never prints the
  manifest's origin — provenance the signature does not cover is
  attacker-controlled even on a verified deck, and a claim nobody vouches for
  adds nothing beside a verified identity. It stays in the manifest for
  tooling to read.
- A tampered `.decklight` fails verification instead of failing a heuristic scan.
- OS file association makes double-click land in `present` — verified and
  CSP-locked — rather than in a raw browser.
- `cli/zip.mjs` (from `skills --pack`) already provides the container plumbing.

**Both artifacts, different jobs:**

| Form | For | Promise |
|---|---|---|
| `.html` (canonical, unchanged) | publishing, links, `publish` → gh-pages | opens in any browser, offline, no software — the identity stays intact |
| `.decklight` (new, optional) | handing a file to a person | verified on open, provenance attached, lands in `present` |

This maps onto the sharing guidance: **share the link** (HTTPS and repo
ownership attest it) or **send a `.decklight`** (a signature attests it). An
unattested emailed `.html` stops being the default way to hand someone a deck.

### COMMANDS — The roster: `author` / `present`

`dev` named the software's mode; `present` names the human's activity — and the
repo's own vocabulary (7× "authoring contract", 6× "authoring skill",
`cli/dev.mjs`'s own header: "one command for the whole authoring loop") had
already voted. Renamed while it is cheap: npm `latest` is still 0.2.0, so no
muscle memory exists yet.

```
decklight author  talk.html    # the whole authoring loop (was: dev)
decklight present talk.decklight    # play it, verified, read-only
```

- `dev` stays as a **permanent hidden alias** — one dispatcher line, never
  documented, never punished.
- `open` is an alias landing in `present` — the verb the OS uses on
  double-click of a `.decklight`. One implementation, two doors.
- **`edit` is removed.** It existed only because `dev` cost something to start;
  with engines resolved on demand (ENGINES) `author` has zero startup cost by
  construction. Per the #165 precedent it refuses out loud (`renamed: use
  decklight author`), not `unknown command`. **The `/edit/*` endpoints are the
  contract and are unchanged** — only the way the server starts changes.
  `test/edit.test.mjs`'s 33 server tests move onto `author`.

### ENGINES — On demand: core owns the affordance, the marketplace owns the engine

TTS ships with **no configuration and no bundled provider**, but `V`/`N` and
the palette entries are always there. First use triggers a wizard: pick a
provider (fetched from the default marketplace), paste the key, saved under
`~/.decklight/`. This replaces both eager bridge startup and any lazy-loading
scheme — there is nothing to start if nothing is installed.

**The rule deciding what else is handled this way:** anything on the
*presenting* path stays core; anything on the *authoring* path that needs a
credential, a binary, a model download, or a network service becomes a
marketplace engine behind a core affordance. A deck must render identically
everywhere; how it got made can depend on what you've installed.

| Capability | Core affordance | Marketplace engines | Wizard asks |
|---|---|---|---|
| TTS | `V`/`N`, palette | ElevenLabs, Gemini, Azure, Piper | provider → key |
| Lipsync / talking head | character overlay, `lipsync` | rhubarb (binary), Wav2Lip (python venv), Veo (key + billing) | engine → paths or key → test render |
| Agent ask | `A`, palette | roster beyond claude/codex/bob | preferred agent; install hint when absent (closes #125) |
| Import adapters | `decklight import` | Marp, Slidev, Deckset, PDF… | none — on demand: "no adapter for `.marp` — install `marp-import`?" |
| Publish targets | `decklight publish` | gh-pages stays core (git auth, no credential); Netlify, Vercel, S3 | target → token |
| Narration buckets | signed-manifest *playback* stays core | GCS/S3 signing adapters | provider → credentials |
| Video/GIF encoding | `decklight video` | ffmpeg is a check-and-offer (#159 precedent), not a plugin | locate or install ffmpeg |
| Build-time transforms | `bundle` pipeline | grammar check, translation, diagram compilers | per-transform |

Called explicitly: **`rec`/node-pty** keeps its existing install-hint failure
(native module, not engine choice). **Theme generation (`⌃T`)** is procedural,
zero network — stays core untouched; an LLM-backed generator would be a
marketplace engine. **Piper voice models** reuse #159's offer-to-fetch, they are
downloads, not plugins. **Decided:** the system-voice adapter (#156) stays in
core, so first-`V`-offline still speaks — the wizard means "you can do better
than this", never "you can't do anything yet".

**ENGINES#WIZARD — wizard rules (all engines, no exceptions):**

1. **The wizard framework is core; a plugin supplies only a declarative
   schema** — questions, field types, a validation endpoint. Plugins never
   paint arbitrary UI into the deck; core owns the rendering, so "wizard only
   in author mode" stays enforceable.
2. **Credentials:** pasted in the player → posted to the author server →
   stored under `~/.decklight/` restricted to the account that pasted them
   (`0600` on POSIX, an explicit ACL on Windows — decklight prints which, read
   back off the file). Loopback-only by construction
   (`allowRemote` refuses `/edit/*` off-loopback unconditionally). Never
   logged, never written into the deck, never picked up by `bundle`.
3. **Never outside author mode.** In `present` or a bundled deck, `V` with no
   engine says so and stops. A credential prompt in a deck you were emailed is
   a phishing primitive.
4. **Install and configure are one flow with two named failures** — "couldn't
   reach the marketplace" and "that key didn't authenticate" are different
   problems.
5. **Recorded narration needs none of this** — a deck with a voice track plays
   from files with no engine; the wizard is for live synthesis only.
6. **The prompt names its asker and its destination, in words the plugin did
   not write** (#232). Every string a schema puts on screen — the title, each
   field's label — was chosen by the plugin, so a field labelled "OpenAI API
   key" backed by a `validate`/`install` endpoint is a phishing form when the
   label is the only thing visible: the same untrusted party wrote the
   question and receives the answer. Before the first input renders, the card
   therefore shows the entry's **qualified registry name** (`name@marketplace`,
   resolved by the author server from the catalog, never read from the schema)
   and **where the answers go** (the declared bridge path(s) on this machine,
   then the credentials file, named with the protection this platform
   actually has). The wording is derived once, in
   `cli/wizard.mjs` (`provenance`), from the same constant the server actually
   posts to; a schema that arrives without provenance is refused by the
   player, not rendered bare.

### INTEGRITY — A deck in transit

A file cannot vouch for itself: an attacker editing the payload edits any
embedded checker in the same pass, and `file://` HTML gets no OS signature UI.
Verification therefore comes from outside the file.

1. **`publish` signs by default; `bundle` signs with `--sign`.** Sigstore
   keyless — already used for the npm release, so no new key management — needs
   the network (Fulcio/Rekor), and `publish` is already a network action, so
   signing there adds no failure mode. `bundle` stays offline-clean and never
   auto-skips signing: a security default that degrades silently is worse than
   an explicit one. Detached sidecar is the authority. `publish --deck`
   additionally emits the signed `.decklight` container beside the gh-pages
   HTML — opt-in until the container proves itself.
2. **Canonical-shape audit, no crypto required.** A bundled deck has a
   predictable shape, so the auditor can hash the embedded runtime against
   known-good `dist/` per published version, enumerate every `<script>` that is
   not runtime / cast / declared extension, and print the ingredients label.
   Catches the realistic "append a script tag before forwarding" attack; exits
   non-zero for CI.
3. **The channel is the attestation** — documented as *share the link, not the
   file*.

Named honestly: none of this reaches a recipient who double-clicks an
emailed `.html` and runs nothing. That is why build-time-by-default remains the
backstop. `present` protects those who opted into the tooling; `.decklight` and file
association widen that population; share-the-link covers the rest.

### UNITS — What is distributed

**Marketplace:** import adapters (Marp, Slidev, Deckset, reveal.js, PDF),
TTS/lipsync engine adapters, deck templates (`init --from`), specialised agent
skills, layout packs (CSS), export targets, build-time transforms, novelty and
homage theme packs, voices. ("Casts" dropped from this line — `OPEN` 13.)

**Stays in core:** the graded house theme set, the full `reveal-*` compat set
(migration must work offline), charts and math (SPEC contracts — `data-chart`
must mean one thing in every install), the base authoring skill.

**Shipped as `UNITS#REST`:** deck templates, agent skills and import adapters,
over one install seam (`cli/units.mjs`) with a per-kind row rather than three
commands that each grew their own resolve-fetch-validate-write. A kind may
declare extra required manifest fields — `importer` must declare `extensions`,
because naming the adapter for a `.marp` at the point of failure has to work
from the cache — while an *unknown* kind is accepted rather than refused, since
a catalog written against a newer decklight must not become un-addable.

Of that list, one is still deliberately out:

- ~~Voices wait on `OPEN` 5~~ — **resolved: reference-only** (SPEC
  `VOICE_UNITS`, `OPEN` 5). A voice entry names an engine and one of its
  voices; no `source`, so no model weight or sample audio can travel — refused
  at `marketplace add`, not merely undocumented.
- ~~Publish targets are an `ENGINES#WIZARD` consumer~~ — **landed: Netlify and
  Vercel**, `decklight publish --target <name>`. The token comes from that
  provider's own CLI env var (`NETLIFY_AUTH_TOKEN`, `VERCEL_TOKEN`), never a
  terminal prompt or the browser wizard — `publish` is a one-shot, often-
  headless command with no author server to post a pasted key to, so it
  follows the ElevenLabs-key precedent (env, never written to disk) rather
  than `/edit/wizard`'s. The schema is still a real `ENGINES#WIZARD` schema,
  validated by the same `validateSchema`/`checkAnswers` every engine goes
  through. **S3 is deliberately not here yet** — the one target needing
  request signing (SigV4) rather than a bearer token, and a hand-rolled signer
  nobody can exercise against a real bucket in CI is a correctness claim not
  worth shipping unverified; Netlify and Vercel prove the shape generalizes.
- ~~Running an installed import adapter is missing~~ — **resolved: landed**
  (`EXTENSIONS#ADAPTEREXEC`, SPEC `EXTENSIONS_ADAPTERS`). An adapter is Node
  code at author privilege, the same capability as a build-time transform —
  including the compat question (`OPEN` 2: an independent `apiVersion`, SPEC
  `UNIT_COMPAT` — an adapter counts its own `IMPORTER_API_VERSION`, never
  `TRANSFORM_API_VERSION`) — and it shares `EXTENSIONS#LOADER`'s loader rather
  than duplicating it: same dynamic `import()`, same one-clean-error collapse,
  a different calling convention (`bytes, opts → html`, not `html, opts →
  html`). An adapter installs, `importer list` shows it, and `import` now
  actually runs it the moment it is installed for the extension in hand.

**On themes specifically — landed (`THEME_BROWSE#SPLIT`).** All 62 were
**284K against 1.7M of `dist/`**, and `bundle` already inlines only the themes
a deck actually carries — moving them out shrank a distributed deck by exactly
zero, so the split was purely about which 16 belong under decklight's own name
and which 46 stay. Split by purpose: novelty and homage packs
(`packs.json`'s `oldmachines`/`tvseries`/`movies`) moved to
`decklight/decklight-plugins-official` — the first-party marketplace
(`FIRST_PARTY`, `cli/marketplace.mjs`), registered by every install and
already carrying them the moment `marketplace update decklight` is run — which
also reduces the trademark surface of what ships under the project's own name;
the graded and compat sets (`default`/`classics`, 46 themes) stay (`OPEN` 4).

### THEME_BROWSE — The theme picker

`src/core/themes.js:158` already defines the group anatomy:

```js
const DYNAMIC_LABELS = { added: 'Added', custom: 'Custom', generated: 'Generated' };
```

**Browse** is a fourth affordance beside three that exist. Anything installed
through it lands in **Added** — the group `decklight theme add` already
populates with `<style data-theme="…" data-theme-added>` — so installed
marketplace themes inherit `,`/`.` cycling, `?theme=`, and `bundle` carriage for
free.

- **Invariant for SPEC:** *a presented deck never touches the network for a
  theme.* Shipped themes are compiled in, bundled ones are inline, and the only
  network call in the subsystem is the explicit Browse action. Headlessly
  testable.
- **Browse fails instantly offline** — no spinner, no hang. A cached catalog
  lets it *list* offline and fail only at fetch time.
- **Browse is authoring-only** (present under `dev`, absent otherwise):
  persistence needs the edit server's write path, a deck should not reach the
  network mid-talk, and a presented deck then behaves identically for everyone
  who opens it. The palette already supports contextual commands, so this is the
  established pattern.

### SETTLED — Unchanged from the interview

Player-first surface · `.decklight/marketplace.json` mirroring Claude's layout ·
versions for code, none for data · `extension check` = lint, then headless load ·
disclosure at install · official curated + community screened with pinning
(landed as an artifact digest, not a commit SHA — `EXTENSIONS#PIN`) ·
third-party unreviewed with auto-update off.

### SUPERSEDED — Earlier decisions, replaced

- ~~Extensions inline into the deck on bundle~~ → build-time transforms produce
  output, not code; nothing executable travels.
- ~~Enforcement is a publish-time label only~~ → for anything that travels,
  Worker + CSP; full DOM never leaves the machine.
- ~~The author chooses runtime scope per extension~~ → full DOM is
  authoring-only; presenter plugins are chrome-only.
- ~~All five units at once~~ → all five *data* units at once; the in-deck code
  surface is deferred until a live case justifies it.
- ~~`decklight verify` as a standalone command~~ → a mode of `present`, where it
  actually runs.
- ~~Eagerly-started TTS/lipsync bridges (and a lazy-start scheme to fix them)~~
  → engines are marketplace plugins resolved on first use (ENGINES); there is
  nothing to start if nothing is installed.
- ~~`decklight edit` as a separate command~~ → removed (COMMANDS); it only existed
  because `dev` cost something to start.

---

## EPIC — The ticket

### What should be true when this is done?

A decklight user can discover, install and use third-party themes, templates,
skills, voices, importers and engines from marketplaces that anyone can host —
without any third-party code ever executing in front of an audience. A deck
handed to another person can be verified before it is played, and the safe way
to play someone else's deck is a single command.

### Acceptance criteria

**Marketplace**

- [ ] `decklight marketplace add|list|update|remove` works with `owner/repo`, a
      git URL, and a local path
- [ ] `.decklight/marketplace.json` is the manifest; a malformed one fails with
      the line and field named, not a stack trace
- [ ] The first-party marketplace is **registered** on first run and **not
      fetched** until a browse action; with no network, first run is silent and
      instant
- [ ] Catalogs cache locally; `list` works offline, fetch fails fast and says so
- [ ] Entry names are qualified (`name@marketplace`); a collision between two
      marketplaces is reported, never silently resolved

**Themes**

- [ ] `T` shows Shipped / Added / Custom / Generated exactly as today, plus a
      **Browse** entry present only under `dev`
- [ ] Browse previews a marketplace theme live and installs on Enter through the
      existing `theme add` path, landing in **Added**
- [ ] An installed theme behaves like a shipped one: `,`/`.`, `?theme=`, and
      carried by `bundle`
- [ ] A presented deck makes **no network request** for a theme, ever —
      asserted headlessly

**Engines and the wizard**

- [ ] A fresh install has `V`/`N`/`A` in the palette with no engine configured;
      first use opens the wizard, never a stack trace or a silent no-op
- [ ] The wizard renders from a plugin's declarative schema — a plugin cannot
      inject its own UI into the deck
- [ ] A pasted credential lands under `~/.decklight/` restricted to the
      account that pasted it — `0600` on POSIX, an explicit ACL on Windows —
      is never logged, and never appears in the deck or a `bundle` of it
- [ ] The wizard never triggers in `present` or in a deck opened from `file://`
      — `V` with no engine says so and stops
- [ ] `decklight author` starts instantly with no engines installed — no bridge
      processes, no network
- [ ] `decklight edit` refuses out loud with the new command named; the
      `/edit/*` endpoint contract is byte-for-byte unchanged

**Safety and integrity**

- [ ] `decklight present <deck>` serves read-only over localhost with **no
      `/edit/*` routes registered**, and sets a `Content-Security-Policy` HTTP
      header
- [ ] `present` prints an ingredients label (runtime version and hash, script
      blocks accounted and unaccounted) and never prints a safety verdict
- [ ] `present --strict` strips every script block that is not the verified
      runtime; the deck still presents faithfully — content, themes, layouts,
      charts and casts all work
- [ ] `publish` signs by default; `bundle` signs with `--sign` and is never
      silently unsigned offline; `present` verifies before rendering and names
      the signer
- [ ] On verification failure `present` degrades to `--strict` and reports what
      it stripped in the terminal — it neither refuses outright nor runs the
      unaccounted script
- [ ] `.decklight` is a container of deck + signature + manifest; a tampered `.decklight`
      fails verification and does not render
- [ ] Double-clicking a `.decklight` opens `present` on macOS, Windows and Linux
- [ ] Presenter-library plugins load only under `present`, may add chrome, and
      **cannot modify slide content** — enforced, not documented
- [ ] Build-time transforms run only during `bundle`; a transform cannot emit a
      `<script>` that is not declared in the manifest
- [ ] `extension check` lints (no `fetch`/`eval`/`XMLHttpRequest`/dynamic
      import) then loads headlessly; failure blocks publish

### How would you demo it?

Add a marketplace, press `T` under `dev`, Browse, preview a theme live, Enter to
install — it appears under Added and survives a reload. Bundle the deck; the
output is signed. Append a `<script>alert(1)</script>` to the bundled file and
run `decklight present` — it names one unaccounted script block; `--strict`
plays the deck with that block stripped and everything else intact. Wrap it as
`.decklight`, tamper with it, double-click: verification fails and it does not
render. Then pull the network cable and press `T`: all 46 shipped themes and
every bundled one are still there, instantly.

### Anything the agent should know

- The picker's group anatomy is `src/core/themes.js:158`; the install path
  already exists as `themeStyleBlock`/`theme add` in `cli/theme.mjs`, which
  writes `<style data-theme="…" data-theme-added>` and already escapes a
  `</style>` hiding in somebody else's CSS.
- `cli/bundle.mjs` inlines runtime, themes, casts and media today and is the
  correct chokepoint for signing and for refusing undeclared script.
- `cli/edit.mjs` holds `allowRemote` and the remote/QR; `present` should reuse
  the server plumbing with `/edit/*` **absent**, not merely refused.
- `cli/zip.mjs` is the container plumbing from `skills --pack`.
- `src/core/print.js` restructures once and never runs again — the `?print` and
  `pdf` paths are already static, so strict mode has a precedent for "no JS
  after layout".
- The `?embedded` guard and `allowRemote`'s unconditional off-loopback refusal
  are the two existing precedents for "a surface that never executes".
- SPEC sections are named (`THEME_DISTRIBUTION`, `PRESENTING`, `JS_API`,
  `NON_GOALS`); this needs new contract text in at least those four.
- `npm run verify` runs 11 harnesses including `contrast` and `palette-rules`,
  which grade every shipped theme. Any theme that moves out of core takes its
  grading with it — decide where that gate then lives.

---

## TICKETS — Decomposition

One ready-to-dev ticket cannot land this. Suggested order — each row is
independently valuable and shippable:

Each ticket carries the mnemonic of the DECISIONS section it implements; the
Depends column cites tickets by mnemonic, never by position.

| Ticket | Scope | Depends on |
|---|---|---|
| `PRESENT_SERVER` | `decklight present` — read-only server, CSP header, no `/edit/*` | — |
| `PRESENT#AUDIT` | runtime hashing, ingredients label, unaccounted-script detection | `PRESENT_SERVER` |
| `PRESENT#STRICT` | strip unverified script, prove the deck still plays | `PRESENT#AUDIT` |
| `INTEGRITY#SIGNING` | sign via Sigstore keyless (`publish` by default, `bundle --sign`); verify in `present` | `PRESENT#AUDIT` |
| `DECK_FILE#ASSOC` | `.decklight` container + OS file association (macOS UTI, Windows registry, Linux desktop/MIME) | `INTEGRITY#SIGNING` |
| `MARKETPLACES#CORE` | manifest, `add/list/update/remove`, cache, first-party registered-not-fetched | — |
| `THEME_BROWSE#UI` | **Browse** in the picker, authoring-only, installing via `theme add` | `MARKETPLACES#CORE` |
| `EXTENSIONS#CONVENTION` | freeze the transform calling convention `apiVersion` names a version of | `OPEN` 2 (resolved) |
| `EXTENSIONS#LOADER` | the pipeline stage: install a transform, run it from `bundle --transform <name>` before signing | `EXTENSIONS#CONVENTION` |
| `EXTENSIONS#CHECK` | `extension check` — lint (no `fetch`/`eval`/`XMLHttpRequest`/dynamic import), then a headless load of the transform's OUTPUT; failure blocks publish | `EXTENSIONS#LOADER` |
| `EXTENSIONS#ADAPTEREXEC` | wire the same loader into `cli/import.mjs` — an installed import adapter finally runs | `EXTENSIONS#LOADER` |
| `PRESENT#PLUGINS` | presenter-library plugins, chrome-only, enforced | `PRESENT_SERVER`, `MARKETPLACES#CORE` |
| `ENGINES#WIZARD` | wizard framework: declarative schema, `~/.decklight/` writes restricted to your account, author-mode-only | `MARKETPLACES#CORE` |
| `ENGINES#TTS` | TTS engines as marketplace plugins — the proving case for the wizard | `ENGINES#WIZARD` |
| `ENGINES#LIPSYNC` | proves the framework generalizes (binary + venv + key, all three shapes) | `ENGINES#WIZARD` |
| `ENGINES#AGENTS` | agent-ask roster via marketplace — closes #125 | `ENGINES#WIZARD` |
| `UNITS#REST` | templates (`init --from`), skills, importers, publish targets, voices | `MARKETPLACES#CORE` |
| `COMMANDS#RENAME` | `dev` → `author` (hidden alias), remove `edit` (refuse out loud), move its 33 tests | — |
| `PRESENT#REMOTE` | move speaker view + phone remote off the edit server onto `present` | `PRESENT_SERVER` |
| `THEME_BROWSE#SPLIT` | **landed** — `packs.json`'s `oldmachines`/`tvseries`/`movies` (16 themes) moved to `decklight/decklight-plugins-official`; `palette-rules` no longer grades them, `theme check` still does | `MARKETPLACES#CORE`, `THEME_BROWSE#UI` |
| `EXTENSIONS#PIN` | **landed** — `sha256` on transform/importer entries; `add` refuses unpinned or mismatched, `extension check` prints the digest | `EXTENSIONS#CHECK`, `UNITS#REST` |

`PRESENT_SERVER` through `DECK_FILE#ASSOC` are a coherent first release with no
marketplace at all — they make playing someone else's deck safe, which is worth
shipping on its own. `COMMANDS#RENAME` is independent of everything and cheapest
before 0.3.0 ships to npm.

---

## OPEN — Still open

1. ~~`upgrade` semantics~~ once a theme can come from a marketplace — **resolved:
   neither re-fetch nor pin; kept as-is, and the warning says which of two
   things this is** (full text: SPEC `PRESENTING`'s runtime-upgrade bullet). Both
   re-fetching and pinning need something this design deliberately does not
   keep: a theme carries no version (THEMING — compatibility with a runtime
   *is* passing `theme check`, there is no compat range to be stale against),
   and once a theme is inline in a deck nothing records which marketplace it
   came from, so there is nowhere to re-fetch FROM even if `upgrade` fetched
   at all — which it does not, the same registered-not-fetched posture
   `MARKETPLACE_REGISTRY` already holds for everything else on a deck-serving
   path. What `upgrade` already did for any theme not in `themes/` (kept
   as-is, warned) was actually two different situations wearing one message:
   `data-theme-added` (`theme add`/Browse's own marker) distinguishes "never
   decklight's to begin with" from "decklight's own shipped set dropped
   this" — the fix was naming which, not changing the behavior. No longer
   blocks `THEME_BROWSE#SPLIT`.
2. ~~Compat range vs engine version~~ — **resolved: an independent, additive-
   only `apiVersion`, never decklight's own package version** (SPEC
   `UNIT_COMPAT`). `src/core/engine.js` has been split apart repeatedly (four
   modules pulled out in #147 alone) without that ever being a promise to
   anyone outside the repo; checking a transform against decklight's package
   version would tie every installed extension to that same churn. Instead the
   invocation contract itself — `EXTENSIONS#TRANSFORMS`'s "HTML in, HTML out"
   — gets its own small integer, moved the way `CAST_FORMAT`'s `decklightCast`
   does: bumped only when the calling convention would break an existing
   transform, never for an internal reorg. A `transform` catalog entry
   declares the version it needs (`apiVersion`, validated in
   `cli/marketplace.mjs`'s `ENTRY_SHAPES`, for shape only — never refused for
   naming a version ahead of what this decklight implements, the same
   reasoning an unknown `type` already gets); this decklight is compatible
   with anything at or below its own `TRANSFORM_API_VERSION`. This settles the
   design question for both `EXTENSIONS#TRANSFORMS` and running an installed
   import adapter. The loader itself now exists for the `bundle --transform`
   surface (`EXTENSIONS#LOADER`, `cli/loader.mjs`); wiring the same loader
   into `cli/import.mjs` so an installed import adapter runs is
   `EXTENSIONS#ADAPTEREXEC` — **resolved: landed** (full contract text: SPEC
   `EXTENSIONS_ADAPTERS`). An adapter counts compatibility on its own
   `IMPORTER_API_VERSION`, independent of `TRANSFORM_API_VERSION`, since the
   two calling conventions (`html, opts → html` vs `bytes, opts → html`) move
   on their own schedules.
3. ~~Where the authoring-time library lives~~ — **resolved: `~/.decklight/`**
   (plugins and credentials both, ENGINES). How `author` and `present` resolve
   a bare reference is implementation detail of `ENGINES#WIZARD`.
4. ~~Which themes are core~~ — **resolved: `themes/packs.json`'s existing
   `default` + `classics` groups (46 themes) are the graded/compat set that
   stays; `oldmachines` + `tvseries` + `movies` (16: `apple2`, `c64`,
   `gameboy`, `snes`, `genesis`, `ibm-oldschool`, `miami-vice`, `friends`,
   `severance`, `stranger-things`, `aliens`, `blade-runner`, `star-wars`,
   `terminator`, `godfather`, `pulp-fiction`) are the novelty/homage packs
   `THEME_BROWSE#SPLIT` moves out (**landed**, at
   `decklight/decklight-plugins-official`).** No new list to invent: `packs.json`
   already grouped all 62 by exactly this judgment (baked into the runtime at
   build time for the `T` picker's own pack view, `src/core/themes.js`) — an
   aesthetic tied to a specific franchise or console (movies, TV, retro
   hardware) is homage; an aesthetic that is not (`synthwave`, a genre, not a
   trademark) stays in `default` alongside the rest of the graded set.
   `classics` folds the full `reveal-*` migration set in with two originals
   (`metropolis`, `seriph`) that share its professional register, matching
   "the graded house theme set, the full `reveal-*` compat set" above.
   Mechanical, as expected: `test/contrast.mjs`/`test/palette-rules.mjs` already
   scan `themes/` by `readdirSync`, not a hardcoded list, so the CI gates
   shrank to match on their own; `packs.json` lost its three moved packs'
   entries, and the 16 files landed in `decklight/decklight-plugins-official`'s
   own `.decklight/marketplace.json` as `theme` entries, installable the same
   way any third-party theme is (`decklight theme add star-wars@decklight`).
   This also answers the ticket's "decide where grading lives": the two gates are not
   one bar wearing two names. `theme check` (`tools/theme-check.mjs` — SPEC
   `THEME_DISTRIBUTION`) is the token contract + WCAG gates, and it travels
   with a theme wherever it lives, because it is about whether the theme
   RENDERS correctly against a runtime — the same reason it already ships
   under `tools/`, reachable from outside this repo. `palette-rules` (R1–R8)
   is a CURATION bar for decklight's own graded collection's house look — a
   shipped homage theme already carries waived exceptions against it
   (`star-wars.css`, `synthwave.css`), because looking like a specific
   franchise and looking like decklight's own palette rules are different
   goals. A moved-out pack stops being graded by it because it stops being
   part of that collection, not because the gate follows it somewhere new.
5. ~~Voice likeness and consent~~ — **resolved: reference-only** (SPEC
   `VOICE_UNITS`). A voice entry names an engine and one of its voices and
   carries no `source` — refused, not merely undocumented, so no model weight
   or sample audio can travel. No consent attestation either: a `consent: true`
   field is one boolean nobody can verify, the same defeatable green mark the
   ingredients label already refuses to print. The wording above says "voice"
   but `character.js` also carries custom art and a talking-head video mode —
   item 12 below is that scope question asked on its own rather than folded
   into this line, and resolves to: neither is ever a marketplace unit today,
   so there is nothing to widen this rule onto.
6. ~~Is signing on by default~~ — **resolved: `publish` signs by default**
   (already a network action, and Sigstore keyless needs one); **`bundle` opts
   in with `--sign`** and stays offline-clean, never silently unsigned
   (INTEGRITY).
7. ~~The container extension~~ — **resolved: `.decklight`**. The obvious
   `.deck` is Decker's native format — active, cross-platform, semantically
   adjacent (its decks also export as single HTML documents); `.dck` is
   Forge/XMage Magic decks. Zero-collision verbosity wins (DECK_FILE).
8. ~~What `present` does when verification fails~~ — **resolved: degrade to
   `--strict` and say so** in the terminal, never on the audience-facing page.
   Neither a refusal (a `--force` habit teaches the wrong reflex) nor a
   warn-and-run (PRESENT).
9. ~~Does `publish` also emit the container~~ — **resolved: behind `--deck`** —
   opt-in until the container proves itself; the flag names the concept, the
   file carries the full `.decklight` extension (INTEGRITY).
10. ~~Does the system-voice adapter (#156) stay in core~~ — **resolved: yes**
    (ENGINES). First-`V`-offline still speaks; the wizard upsells rather than
    gates.
11. ~~What a presenter plugin is MADE of~~ — **resolved: a declarative
    `plugin.json` plus a `plugin.js` that runs in a sandboxed `srcdoc` frame**
    (PRESENT#PLUGINS). The wizard's answer — core renders, a plugin only
    declares — does not stretch this far: a teleprompter has real logic, and a
    vocabulary rich enough to express one would be a rendering language with a
    plugin API hidden in it. So a plugin gets real code and is put somewhere it
    cannot do harm, rather than being denied code and trusted. The frame's
    opaque origin is the boundary; the manifest vocabulary stays closed on top
    of it, because "chrome only" also has to mean "not covering the slides",
    and that part IS expressible as a declaration.
12. ~~Does "likeness" stop at voice~~ — **resolved: yes, and there is nothing to
    widen `VOICE_UNITS` onto.** `VOICE_UNITS`'s reference-only rule is a shape
    decision about a MARKETPLACE CATALOG ENTRY — refusing `source` on a
    `voice` entry closes the one door through which a third party could hand
    an installer a cloned voice they never independently obtained. Custom
    character art (`config.narration.character.svg`/`sprites`) and the
    talking-head video mode's portrait have no such door, because neither is
    ever a catalog entry in the first place:
    - **`svg`/`sprites`** are deck config the deck's own AUTHOR points at
      their own asset — inline markup, a same-document `#id`, or a URL
      (`src/core/character.js` fetches it exactly once, at present time). That
      is the identical authorship-level trust decklight already extends to a
      background `<img src>` or video; nothing about it is character-specific,
      and no marketplace ever names or installs one.
    - **`portrait`** (video mode) is a bare local file path the PRESENTER
      supplies to their OWN `decklight lipsync` process (`--portrait
      name=face.png`, `tools/lipsync-server.mjs`) — never installed, never
      named in any catalog, never travels with the deck. That is
      `PRESENT#PLUGINS`'s own trust model exactly (presenter-owned, the
      installer is the risk-bearer), not a gap `VOICE_UNITS` left open.

    Widening a reference-only rule presupposes a marketplace unit to widen it
    onto; none exists for character art or portraits, and no ticket in this
    document proposes one. If a future ticket ever DOES propose distributing
    either as a marketplace unit — a curated cast of ready-made narrators,
    say — that ticket inherits this answer by default: reference-only, no
    consent attestation, item 5's reasoning verbatim. Until one exists, this
    item resolves as *not applicable*, not as a quiet repeat of item 5.
13. ~~Do `voices` in `UNITS` mean terminal casts too~~ — **resolved: no, "casts"
    meant `CAST_FORMAT`'s terminal recordings, an unrelated data type filed
    next to `voices` by name collision alone** — a `.cast.json` is keystrokes
    and timed output, nobody's likeness, and carries none of item 5's consent
    question. Confirmed unbuilt, not silently dropped: `cli/units.mjs`'s
    `UNIT_TYPES` has no `cast` entry, and `UNITS#REST` — the ticket that
    actually shipped `templates`/`skills`/`importers`/`publish targets`/
    `voices` — never listed `casts` either, so nothing scoped ever depended on
    it. It was carried only in the `UNITS` section's own original "Marketplace:"
    line above, now corrected to drop it. Distributing a terminal cast (a
    shared demo recording, say) is a real future unit if a case ever asks for
    it — same shape as `voice`, a reference-only or single-file kind added to
    `UNIT_TYPES` — but it owes its own ticket, not a rider on this one.
