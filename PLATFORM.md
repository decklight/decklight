# Decklight: Platform contract

The half of the contract that is not about writing a deck: how a marketplace
is registered and read, and how the units your library installs from one
(skills, import adapters, build-time transforms, speech engines, agents,
voices) are pinned, checked and run. [`SPEC.md`](SPEC.md) is the authoring
contract, and the one an agent writing slides reads; this file was split out
of it because it was 640 lines, longer than every authoring section combined,
read by agents that only ever write slides.

**Sections are named, not numbered**, as in `SPEC.md`: cite them by mnemonic.

| Mnemonic | Section |
|---|---|
| `MARKETPLACE_REGISTRY` · `UNIT_VERSIONS` | catalogs: registered, not fetched; what you installed, and what the catalog has newer |
| `UNIT_COMPAT` · `UNIT_PINNING` | compat for code-carrying units, and the digest pin they install against |
| `EXTENSIONS_TRANSFORMS` · `EXTENSIONS_CHECK` · `EXTENSIONS_ADAPTERS` | the transform calling convention, its admission gate, and import adapters |
| `ENGINE_UNITS` · `ENGINE_PREREQUISITES` | the speech-engine factory contract, and what an engine needs before a key is worth asking for |
| `AGENT_UNITS` · `VOICE_UNITS` | agents as descriptors, voices as references |

Themes, design systems and fonts also come from a marketplace, but a deck
references them, so their contracts stay in `SPEC.md` (`THEME_DISTRIBUTION`,
`DESIGN_SYSTEMS`, `FONTS`).

---

## MARKETPLACE_REGISTRY · Marketplaces: registered, not fetched

A marketplace is a git repo (or a local directory) with
`.decklight/marketplace.json` at its root, decentralized, no central registry,
mirroring Claude Code's layout deliberately (MARKETPLACE.md MARKETPLACES). The
manifest names the catalog and its entries:

**Which ref.** `add` and `update` take `--branch <ref>`, and it accepts a **tag**
as readily as a branch: a tag is how a catalog gets pinned to a version known
to work. Without it the shallow clone follows the remote's own `HEAD`, so
nothing here has ever assumed `main` or `master` and a repo whose default is
`trunk` always worked; what was missing was any way to ask for a ref that is not
the default. The ref is **remembered in the registry**, so `update` re-clones the
same one, a pin that a refresh silently abandoned would be decoration, and
`update --branch` is how the pin is deliberately moved. `list` shows it as
`#ref` beside the `@commit`, because the two answer different questions: the ref
is what you asked for and what the next update will fetch, the commit is where
that ref happened to point. A ref is validated against an allowlist before it
reaches the command line, since a value beginning with `-` is an option rather
than a ref; a full commit SHA is refused with its own message, because
`--branch` takes a ref and a bare object name is not one: fetching a commit
means a second round trip and a checkout, which is a different shape from the
single shallow clone. `--branch` against a **local** directory is an error, not
a no-op: a directory has no refs to choose between, and accepting the flag
while ignoring it would look exactly like success.

```json
{
  "name": "nord-pack",
  "description": "cool blues",
  "entries": [
    { "name": "nord-deep", "type": "theme", "source": "./themes/nord-deep.css", "description": "deep blues" }
  ]
}
```

`name` and each entry's `name`/`type`/`source` are required (`description`
optional; versions and compat ranges arrive with code-carrying extensions:
versions for code, none for data, see `UNIT_COMPAT`). The one exception is a reference-only kind,
which carries no `source` because it carries nothing at all, see `VOICE_UNITS`. A malformed manifest is refused **naming the
line and the field** (`line 7: entries[1].type — missing`), never with a stack
trace: a typo in somebody's catalog is not an internal error.

**A kind may declare extra required fields, and an unknown kind is accepted
rather than refused.** An `importer` entry must carry `extensions`: the file
extensions its adapter reads, because that is what lets `decklight import
talk.marp` name the adapter **from the cache, offline**; an adapter whose
extensions were only discoverable by installing it could never be offered at
the moment it is needed. A `type` this decklight does not know is *not* an
error: a catalog is a file someone else wrote, quite possibly against a newer
version, and refusing the whole manifest over one unrecognised kind would make
every catalog un-addable the day it grows an entry. `marketplace list` groups
entries by kind and prints the install command for each, so an unknown kind
reads as "not yet" rather than as a typo; the two must never look alike.

`decklight marketplace add <owner/repo | git url | path>` reads the manifest at
the source's root and registers the catalog; `list`, `update <name>` and
`remove <name>` complete the roster. State lives under `~/.decklight/`
(`DECKLIGHT_HOME` overrides): one registry file, `marketplaces.json`, plus a
`marketplaces/` directory holding, per marketplace, its cached manifest
(`<name>.json`) and the checkout that manifest came with (`<name>/`), the
config home the engine wizard (MARKETPLACE.md ENGINES) shares.

**A remote marketplace is read by cloning it** (MARKETPLACE.md
`MARKETPLACES#CLONE`), never by fetching one file at a time off a raw-content
host, and `owner/repo` is shorthand for that clone rather than for a URL. Three
things follow, and each was a bug before it did. A clone uses **the caller's own
git credentials**, so a marketplace in a private repo works exactly as `git
clone` does in that terminal: a credential helper for HTTPS (`gh auth
setup-git`, the macOS Keychain), or the SSH form of the URL; an anonymous fetch
had none, so a private catalog could register and then 404 on every install.
The manifest and every entry's bytes come from **one commit**, recorded in the
registry and printed by `list`, where fetching each artifact separately at
`HEAD` could produce an install matching no single commit of the marketplace.
And because the clone is kept (`~/.decklight/marketplaces/<name>/`, its `.git`
dropped, replaced wholesale by the next `update` and removed by `remove`),
**installing an entry reads the disk**, not the network. A local-path
marketplace keeps no checkout: its own directory already is one. An entry whose
`source` is an absolute `https://` URL (a gist, a release asset) is still
fetched as written.

**The invariant everything above serves: registering is not fetching.** The
network is touched only by an explicit `add`, `update` or `outdated` of a
remote source (and `outdated` only asks where a ref points; it fetches no
file): never at registration, never when a deck loads, never while presenting. The
first-party marketplace is registered on first CLI run as a pure filesystem
write; its first fetch happens at the first browse or `update`, so first run
offline is silent and instant, and a deck on conference wifi, on a plane, or
air-gapped behaves identically to one at a desk. Nothing on the deck-load or
presenting path imports the marketplace module at all (pinned by
`test/marketplace.test.mjs`). Offline is a first-class state, not an error
state: `list` reads only the cache, and a fetch failure is fast and names the
marketplace and the reason, no spinner, no hang.

**The in-deck door.** In write mode, `/` → **Marketplaces…** lists every
registered catalog, says which are behind their source, updates them and says
what's new, and registers a new one without leaving the deck (SPEC
`MARKETPLACES_SCREEN` has the flow). Checking, updating and adding each run the
`decklight marketplace` command (`outdated`, `update`, `add`) as a child
process. Checking is the one network act that fetches nothing: `outdated` asks
each remote where its ref points (`git ls-remote`) and compares a local
directory's manifest with the cached copy, and it runs only when asked. Adding takes the
same three forms, and the edit server runs **`decklight marketplace add`
itself**, as a child process: the same command, the caller's git credentials on
this machine, the same refusals, so `marketplace list` cannot tell which door a
marketplace came in by, and a failed add leaves nothing registered from either.
It is still an explicit act, and still the only fetch: the row says what it is
about to clone (or which directory it would read in place) and asks for a
second ⏎ before it does, as publish does, since a clone is network access as
the person. A relative path is the **deck's** folder's, registered as an
absolute one, because the registry keeps a source as given and a relative path
would mean something else to the next `update`. Nothing is fetched on a later
open. A deck opened `--no-trust` has neither the row nor the routes
(`GET /deck/edit/marketplaces`, `POST /deck/edit/marketplace/check`,
`/update` and `/add`), which sit behind the server's mode gate with every
other write.

**The unit library** (`UNITS#REST`) is where the installable kinds land:
`~/.decklight/skills/`, `.../importers/`, `.../voices/`,
beside the `plugins/` that `NO_TRUST#PLUGINS` writes. One seam installs all of
them (`decklight library add <kind>`: `skill`, `importer`, `voice`, …), and
each is used by the command that needs it. A deck template, a whole deck installed to scaffold from or take slides out of, was a kind here until 0.9.0 and is gone: a design system's slide templates (`DESIGN_SYSTEMS`) are what a slide borrows now, by reference, never by copy.

A marketplace skill installs
into the library and therefore sits **alongside** the authoring skill
`decklight skills` writes into a project, never replacing it. An import adapter
is **offered at the point of failure**: `decklight import talk.marp` names the
adapter that reads `.marp` and how to get it, which is the ENGINES pattern
(offer at the moment of need) rather than a setup step nobody performs in
advance. Installing an adapter does not yet make it *run*: executing a
marketplace module is `EXTENSIONS#TRANSFORMS`, and until that lands `import`
says so plainly instead of failing in a way that reads like a bug.

### UNIT_VERSIONS · What you installed, and what the catalog has newer

Every marketplace entry (a theme, a template, a skill, a plugin, any kind, with code or without) may carry its own **semver `version`** (`"1.1.0"`; SemVer 2.0.0 exactly, prerelease and build metadata allowed, no leading `v`). It is **optional**: a catalog without versions validates as it always did. One that is not semver is refused with the field named: `line 7: entries[1].version — "v1.1" — a semver version, major.minor.patch (e.g. "1.1.0"), no leading v`, because "is this newer than what I have" needs real precedence, not a guess (`cli/marketplace.mjs` `SEMVER_RE`, `semverCompare`: numbers numerically, a prerelease before its release, build metadata ignored). This is Claude Code's model, where a plugin that is only skills still has releases.

Three versions, three questions, never confused: an entry's **`version`** is a catalog/install fact: what an install took and whether the catalog now offers newer; **`apiVersion`** (`UNIT_COMPAT`) is the calling convention a code entry needs, checked for compatibility; **decklight's package version** is decklight's, and says nothing about any entry.

**Every kind's `add` records what it took** in `~/.decklight/installed.json`: one record per `type:name@marketplace` with the entry's `version` (null when it carries none), the marketplace **commit** its files came from, and when. `theme add` records too: it marks a theme in a deck, and the ledger is what remembers the version it marked. `remove` of an installed unit or plugin forgets the record. **Re-running the kind's `add` takes the newer version and records it**: the ledger is overwritten, nothing else is learned.

**`decklight marketplace list`** shows each entry's version, and for one you installed, what you have against what is offered: `nord@acme  1.0.0 installed`, `confluent-devrel@decklight-confluent  1.0.0 → 1.1.0`. **`decklight marketplace update <name>`**, after refreshing the catalog, names every entry you installed from it that is now newer and the one command that takes it (`nord@acme  1.0.0 → 1.1.0  —  decklight theme add nord@acme <deck>`) and **installs nothing itself**: an update refreshes the catalog; taking a new version stays your call. An install recorded before its entry carried a version reads `unversioned → 1.1.0`.

**Decks are never touched by any of this.** A deck holds a *mark* (`markedThemes`), never a version; a theme already inline in a deck and every bundled deck stay byte-for-byte what they were: bundles are frozen on purpose (`THEME_DISTRIBUTION`). The update path is the installed unit, not the deck. Nothing here reaches the network either: `list` reads the ledger and the cache, and `update` fetches only what it always fetched.

### UNIT_COMPAT · Compat for code-carrying units: an API version, not an engine version

A build-time transform (and, later, an executed import adapter) is Node code,
so its catalog entry declares a version, unlike a theme or a voice, which
carry none. What that version is checked *against* is deliberately **not**
decklight's own package version:

```json
{ "name": "grammar-check", "type": "transform", "source": "./grammar.mjs", "apiVersion": 1 }
```

**Why not decklight's version.** `src/core/engine.js` has been split apart
repeatedly (four feature modules pulled out in one PR alone) without any of
those reorganisations ever being a promise to anyone outside the repo. Pinning
a transform's compatibility to decklight's package version would tie it to
that same internal churn: a patch release could break every installed
transform for a reason the transform never touched.

**The alternative:** `apiVersion` names a version of the transform *invocation
contract* alone: the narrow "HTML in, HTML out" calling convention
`EXTENSIONS#TRANSFORMS` declares, and that number moves the way
`CAST_FORMAT`'s `decklightCast` does: **additive only**, bumped only when the
calling convention itself would break an existing transform, never for an
internal reorganisation elsewhere in the codebase. A transform declares the
lowest contract version it needs; decklight is compatible with anything at or
below its own `TRANSFORM_API_VERSION` (`cli/marketplace.mjs`), because nothing
additive-only ever removes what an older transform relied on.

**Validated for shape, not for currency.** `apiVersion` must be a positive
integer: that is checked the moment a catalog is registered (`marketplace
add`/`update`), by the same `ENTRY_SHAPES` mechanism that requires an
`importer`'s `extensions`. It is never refused merely for naming a version
ahead of what this decklight currently implements: a catalog is a file someone
else wrote, quite possibly against a newer decklight, and the same reasoning
that leaves an unrecognised `type` accepted rather than refused applies here
too. Whether a *particular* transform can actually run on *this* decklight is
answered by the loader (`EXTENSIONS#LOADER`, `cli/loader.mjs`): this section
only settled what it checks against; running an installed import adapter
(`EXTENSIONS#ADAPTEREXEC`) still owes the same question on that surface.

### UNIT_PINNING · Code-carrying units install pinned, or not at all

A `transform` or `importer` entry carries the SHA-256 of its module file's
bytes, lowercase hex, exactly as `sha256sum` prints it:

```json
{ "name": "grammar-check", "type": "transform", "source": "./grammar.mjs",
  "apiVersion": 1, "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" }
```

**Why the pin exists.** An entry's relative `source` resolves against the
marketplace's checkout, cloned at whatever the default branch pointed to when
`add`/`update` ran (`resolveSource`; no branch name is guessed at), so the
bytes an install writes are whatever the file said at that moment, not
whatever it said when the marketplace admitted the entry (`EXTENSIONS_CHECK`).
Cloning closed the narrower gap of manifest and artifact disagreeing with each
other; it cannot close this one, which is between the admission and the
install. For a theme that gap is closed by the THEMING contract itself,
run when a theme is marked and again wherever a marked theme is served or
bundled (THEME_DISTRIBUTION); for Node code the loader runs
unsandboxed at author privilege (`EXTENSIONS_TRANSFORMS`,
`EXTENSIONS_ADAPTERS`) there is no equivalent re-check: the digest is what
makes the code that installs the code that was screened.

**A content digest, not a commit SHA.** A commit pin only reaches sources a
host can serve by commit, and verifying it means trusting that host; a digest
of the bytes holds identically for a raw URL, a git URL and a local
directory, and holds against the math rather than the server. `decklight
extension check` prints the digest on a pass, so the gate that admits a
submission also emits the pin its catalog entry carries; `sha256sum
<file>` produces the same value.

**Enforced at install, with two named refusals** (`cli/units.mjs`).
`decklight library add transform` / `importer add` refuse a pinned kind's entry that
carries no `sha256` (*before* anything is fetched, since without a pin there
is no fact to hold the fetched bytes to) and refuse a fetched module whose
digest does not match, *before* anything is written, naming both digests. A
mismatch means the file changed since the catalog was cached: possibly a
legitimate re-pin (`marketplace update <name>` and try again), possibly the
exact substitution the pin exists to stop; either way nothing lands in the
library, the same fetch-first-write-second rule every other refusal there
keeps.

**Validated for shape when present, required only at install.** The same
split `apiVersion` already made (`UNIT_COMPAT`): a *malformed* `sha256` fails
`marketplace add` naming the line and the field, but an *absent* one does not
invalidate the manifest: refusing a whole catalog over one unpinned
transform would cost its theme entries too, the blast-radius reasoning that
already leaves an unknown `type` accepted. The refusal lands at the one
moment the risk does: installing the executable entry.

**What is deliberately not pinned.** Data kinds (themes, skills)
install unpinned: nothing in them executes, and a theme re-passes its whole
contract at install. A unit placed in the library by hand still runs
(`EXTENSIONS#LOADER`'s decision, unchanged): the pin governs what an
*install* may write into the library, and the trust model for *running* what
is there stays `EXTENSIONS_TRANSFORMS`'s: the installer is the risk-bearer.

### EXTENSIONS_TRANSFORMS · Build-time transforms: the v1 contract

A transform is a single file, `transform.mjs`, exporting one function:

```js
export default async function transform(html, opts) {
  return html; // HTML in, HTML out (MARKETPLACE.md EXTENSIONS) — nothing else crosses
}
```

- **`html` is the deck's own source**: the file as the author wrote it,
  *before* `bundle` inlines themes, images, casts or narration. A transform
  compiling `<pre class="mermaid">…</pre>` into inline SVG needs the markup
  the author wrote, not decklight's own runtime already spliced in; running
  before that inlining also keeps a transform's test fixture small (a
  two-line HTML snippet, not a full bundled deck) and keeps decklight's own
  inlining regexes untouched by whatever a transform's output contains.
- **`opts` is reserved and empty in v1.** Nothing populates it yet. A later
  version MAY add a field (deck title, target theme, …), and doing so is an
  *additive* change under `UNIT_COMPAT`: it does not bump
  `TRANSFORM_API_VERSION`, because an existing transform that ignores an
  unrecognised field keeps working exactly as it did before. Only a change
  that would break an existing transform's assumptions bumps the version.
- **Loaded by dynamic `import()`, in the same process as `bundle`/`import`:
  no subprocess, no VM sandbox.** This is not a gap: `MARKETPLACE.md
  EXTENSIONS` already decided the trust model for build-time code (the
  installer is the risk-bearer, the same defensible model Claude's own plugin
  marketplace uses) so isolating a transform from the process that invoked
  it would defend against a threat this design already accepted. Contrast
  `NO_TRUST#PLUGINS`, which sandboxes because *that* code runs on a
  presenter's machine at a stranger's request, a different actor, a
  different risk.
- **The return value must be a string**, or a thrown/rejected value the
  *loader* reports by naming the transform: a transform has no other
  contract obligation. Turning a throw into a clean refusal rather than a raw
  stack trace is the loader's job (`EXTENSIONS#LOADER`, `cli/loader.mjs`,
  called from `bundle --transform <name>`), the same UX every other
  unit-installing surface in this codebase already gives.

This is the contract `apiVersion` (`UNIT_COMPAT`) names a version *of*.
Freezing it here, ahead of the loader that will call it, is deliberate: the
loader is comparatively mechanical once this is fixed, and fixing it after
the loader existed would mean the first version number was never actually
pinned to anything.

### EXTENSIONS_CHECK · The marketplace admission gate for build-time code

`decklight library gate transform <file> [--type transform]` (`--type transform` is
both the default and, in v1, the only kind implemented) validates ONE
transform source file and reports 0 or 1, the same shape `theme gate`
already gives. It is not part of `bundle`, `import` or `publish`: those run
an already-*installed*, catalog-backed unit (`EXTENSIONS#LOADER`) and never
re-check it. `library gate transform` instead runs against a bare FILE, because its
job is admitting an entry to a marketplace catalog in the first place: a
marketplace repo's own CI runs it on every PR that adds or updates a
`transform` entry, and a failing check blocks that PR, which is what
"failure blocks publish" means (MARKETPLACE.md `EXTENSIONS#CHECK`):
publishing the *extension*, not `decklight publish`ing a deck.

Three phases, checking three different things:

- **Lint the source text: advisory, not a boundary.** Refused if the file
  contains `fetch(`, `eval(`, `XMLHttpRequest`, or a dynamic `import(`,
  anywhere: a shallow source-text scan, the same kind `NO_TRUST#PLUGINS`
  already runs on a presenter plugin's source. It catches the honest mistake
  and states the bar in a sentence, and that is ALL it does: a static
  `import { execSync } from 'node:child_process'`, a `new Function('return
  fetch')()`, a `globalThis['fet' + 'ch']` all pass a regex unmatched, and
  no source-text scan closes that class. What constrains the submission
  during the check is the process boundary below; what constrains it after
  admission is nothing: an installed transform runs as trusted, unsandboxed
  Node (`EXTENSIONS_TRANSFORMS`), because the trust model for build-time
  code is that the installer bears the risk (MARKETPLACE.md `EXTENSIONS`).
  Admission screens; it does not absolve.
- **The submission only ever executes behind a process boundary.** The
  checker itself never `import()`s the checked file: a marketplace's CI
  would be executing a stranger's code at its own privilege *before*
  deciding whether to admit it. The transform runs in a SEPARATE Node
  process under the permission model (`--permission`, or
  `--experimental-permission` back to the `engines` floor of Node 20;
  a Node with neither is a named refusal, never a silent unsandboxed run):
  filesystem reads limited to decklight's own package and the submitted
  file's directory, no filesystem writes, no child processes, no workers, no
  native addons; a REPLACED environment (the fixture is the only variable
  that crosses, so a CI runner's secrets never enter the child); a temp
  working directory; and its own 15s wall-clock kill, because a transform
  that never returns must become a refusal, not a hang. Stated plainly,
  what the boundary does NOT cover: Node's permission model does not
  restrict the network, so a hostile submission can still phone home during
  the check: the boundary protects the checking machine's files, processes
  and environment, not its network egress.
- **A headless load of the OUTPUT, not the source.** The transform is run
  against ONE small fixture this command owns (RANDOMISED per check, a
  fresh nonce in its title, heading and body, so a submission cannot
  recognise the fixture and behave only while being checked), never the
  submitter's own deck: proving the CONTRACT, not "does it handle some
  particular author's markup" (the same "a small fixture beats a full
  bundled deck" reasoning `EXTENSIONS_TRANSFORMS` already uses to justify
  testing against the pre-`bundle` source). The output is then rendered
  headlessly and refused if it contains a `<script>` block OR an inline
  event handler (an `on…=` attribute): the second is exactly as executable
  as the first, just waiting for a click, and a `<script>`-only grep missed
  it entirely. Both refuse for the same reason: "build-time transforms
  produce output, not code; nothing executable travels" (MARKETPLACE.md
  `EXTENSIONS`, SUPERSEDED) is the one invariant this phase can actually
  prove a given transform honors, rather than merely being asked to.
  `apiVersion` currency plays no part here: that is `EXTENSIONS#LOADER`'s
  question at USE time, on an installed unit, not this command's question at
  ADMISSION time, on a bare file.

What this gate is, honestly: a screen, not a proof. Code that behaves during
one check can behave differently once installed, and no admission-time
analysis of Turing-complete code closes that gap: the randomised fixture
and the scrubbed, temp-cwd child merely remove the cheap tells a submission
could key on. The load-bearing decisions remain the catalog's digest pin
(`UNIT_PINNING`) and the trust model (`EXTENSIONS`: the installer
bears the risk); this command exists so that the obvious failures never
reach either.

Needs a real browser to run the last phase (the same Chrome dependency
`npm run verify`'s render harnesses already carry) and answers the same way
they already do when Chrome is absent: a named refusal, never a silent pass.

**Both executions carry a hard wall-clock kill: 15s for the transform's own
run, and a separate one for the headless load, which defaults to the same and
is raised by `DECKLIGHT_CHECK_LOAD_MS` on a slow machine.** They are separate
numbers because they measure different things: the transform's clock has only
the submission on it, while the headless load's also pays for starting a
browser, which the submission had no part in. A shared CI runner slow enough to
make a cold Chrome start eat the budget will otherwise refuse a clean
submission for "blocking the page": an admission gate accusing honest work of
hanging is a worse failure than taking a minute to reject hostile work. The
headless kill stays load-bearing either way, and is separate from
`--virtual-time-budget`. That flag bounds Chrome's
own clock, not the real one: a synchronous `alert()`/`confirm()`/`prompt()`
in the OUTPUT opens a native dialog that blocks the render loop outside
virtual time entirely, and an infinite loop blocks it the same way,
measured directly, not a theoretical concern. Every other transform failure
this section refuses is a *string* found in an *output*; a hang is the one
shape that would otherwise have no output to refuse, and this command's
whole premise is running code nobody has vetted yet, so a submission that
never returns, in its own run or in its output's load, has to become a
refusal too, not an unbounded hang in whatever is running the check (a
marketplace's own CI).

### EXTENSIONS_ADAPTERS · Import adapters: the v1 contract, and running one

An import adapter is a single file, `importer.mjs`, exporting one function:
the same shape `EXTENSIONS_TRANSFORMS` gives a build-time transform, with the
one difference its different input forces:

```js
export default async function importAdapter(bytes, opts) {
  return html; // bytes in, HTML out — the deck's <section> markup, nothing else crosses
}
```

- **`bytes` is the source file's raw contents** (a `Buffer`, read by `cli/
  import.mjs` before the adapter ever runs), never a path, so an adapter's
  contract needs no filesystem access of its own and stays as pure as a
  transform's `html in, html out`. What the built-in importer calls "a
  CONTENT importer, not a pixel renderer" (`DECK_IMPORT`) applies here too:
  the adapter owns turning its format into markup, and decklight themes it
  same as anything else.
- **The return value is the deck's section markup, one HTML string**, not
  the `{ sections, report }` pair `cli/import.mjs`'s own PowerPoint path uses
  internally. Requiring a third-party adapter to reproduce that pair would
  leak an implementation detail of one specific importer into a contract
  every future adapter has to match; a single string is the same minimal
  surface `EXTENSIONS_TRANSFORMS` chose for the same reason. Per-slide drop
  reporting (`DECK_IMPORT`'s "every drop is reported with its slide number")
  is therefore not part of the v1 adapter contract: an adapter that wants it
  is free to `console.error` its own, since it runs at the same trust level
  as anything else in `EXTENSIONS`.
- **`opts` is reserved and empty in v1**, for the identical reason
  `EXTENSIONS_TRANSFORMS`'s is: a later version may add a field, and doing so
  is *additive* under `UNIT_COMPAT` rather than a version bump, because an
  adapter that ignores an unrecognised field keeps working exactly as before.
- **Loaded by dynamic `import()`, in the same process as `decklight import`:
  no subprocess, no VM sandbox.** Identical reasoning to
  `EXTENSIONS_TRANSFORMS`: an import adapter is Node code at author
  privilege, the trust model `MARKETPLACE.md EXTENSIONS` already settled
  (the installer is the risk-bearer), and isolating it from the process that
  invoked it would defend against a threat this design already accepted.
- **An independent `apiVersion`, `IMPORTER_API_VERSION`, not
  `TRANSFORM_API_VERSION`.** The two are different calling conventions
  (`html, opts → html` versus `bytes, opts → html`) that will each change on
  their own schedule; sharing one counter would bump every installed
  transform's compatibility number the day the *importer* contract grew a
  field it never asked for. Both move the same way `UNIT_COMPAT` already
  established (additive-only, bumped only when that ONE contract would
  break an existing unit), they just count separately.
- **The return value must be a string**, or a thrown/rejected value the
  loader reports by naming the adapter: the same clean, never-a-raw-stack
  collapse `EXTENSIONS#LOADER` already gives a transform's failures
  (`cli/loader.mjs`'s `runImporterAt`, called from `cli/import.mjs` once
  `sourceKind` finds no built-in reader for the file but a cached catalog
  entry names an installed adapter for its extension).

`import` still says exactly what it always said when no adapter is known, or
when one is known but not installed (`decklight library add importer <name>`); only
an INSTALLED adapter's extension now actually runs, rather than reporting
that it does not yet (`EXTENSIONS#ADAPTEREXEC`, MARKETPLACE.md).

### ENGINE_UNITS · Speech engines: the v1 contract, and installing one

Six engines ship in core (`PRESENTING`: gemini, chirp, piper, elevenlabs, say,
sapi) and are **not units**: they need no marketplace, no library and no
catalog, so a machine with nothing registered reaches its own voice exactly as
it always did. A seventh is whatever you installed. An engine unit is a single
file, `engine.mjs`, exporting a **factory** rather than the `(input, opts) →
string` pass the other two code-carrying kinds export:

```js
export default function createEngine(opts) {
  return {
    name, voices,                       // the roster the V picker offers
    stylable,                           // may the tone step be shown for it?
    audioTags,                          // does it act on [whispers]-style tags?
    synth(text, { voice, style }) {},   // → { wav, usage }
  };
}
```

- **`decklight library add engine <name>` installs one**, into `~/.decklight/engines/`
  like any other unit; `decklight <deck> --tts-engine <name>` then speaks with it and
  the picker treats it exactly as it treats a built-in. An engine is Node code
  at author privilege, so it is **pinned** by `sha256` on the same terms as a
  transform or an adapter (`UNIT_PINNING`): refused before any fetch without
  one, refused before any write on a mismatch.
- **An independent `apiVersion`, `ENGINE_API_VERSION`**, a third counter
  beside `TRANSFORM_API_VERSION` and `IMPORTER_API_VERSION`, for the third
  reason they are separate (`UNIT_COMPAT`): this convention is not `input →
  string` at all, so the day either of the others grows a field, an engine's
  contract is untouched and must not be invalidated alongside them. Additive
  only, bumped only when the factory or `synth` convention itself would break
  an installed engine, never for a reorganisation of `tools/tts-engines.mjs`,
  whose six built-ins this number does not version.
- **`capability` says which affordance it answers for** (`tts` today).
  Validated for *shape* in the catalog and checked against what this decklight
  runs only at LOAD time: a catalog declaring an engine for a capability this
  version cannot run must stay addable, so the refusal names the one engine
  rather than invalidating the catalog it arrived in and taking its themes
  down with it. Same reasoning an unknown `type` already gets
  (`MARKETPLACE_REGISTRY`).
- **The returned object is checked once, at load, not at the first sentence.**
  A missing `synth`, a factory that is not a function, one that throws while
  starting, one whose roster is neither a `voices` array nor a `listVoices()`:
  each is a `LoaderError` naming the engine, never a raw stack, and never a
  crash mid-talk. `stylable` defaults to **false** when an engine does not say:
  a plugin with no delivery-instruction channel that forgets to declare one
  must not have the tone step offered for it, which is the same silent lie
  `PRESENTING` refuses when it skips that step for chirp and piper. So does
  `audioTags`: an engine that does not say it acts on audio tags is sent the
  notes with every tag taken out (DECK_ANATOMY), never one read aloud.
- **Loaded by dynamic `import()`, in the same process as the bridge**: no
  subprocess, no VM sandbox, identical reasoning to `EXTENSIONS_TRANSFORMS`.
- **Write mode only.** Installing and configuring both happen through the
  server in write mode; no-trust mode refuses every route that could reach either, and a
  credential still comes from the wizard (`ENGINES#WIZARD`) and is still
  stored restricted to the account that pasted it (the platform's own form of
  that, named in `ENGINES#WIZARD`), never into a deck.
### ENGINE_PREREQUISITES · What an engine needs before a key is worth asking for

TTS made two failure states look like enough ("could not reach it" and "that
key was refused") because a credential is the only thing a TTS provider ever
needs. Lipsync is the case that proves otherwise (`ENGINES#LIPSYNC`): rhubarb
is a **binary**, Wav2Lip is a **python checkout plus model weights**, and only
Veo is the paste-a-key shape. So a wizard schema may declare what it needs
from the machine, beside what it needs from the person:

```json
"requires": [
  { "kind": "binary", "name": "rhubarb", "hint": "brew install rhubarb-lip-sync" },
  { "kind": "file",   "name": "~/models/wav2lip.pth", "hint": "download the checkpoint" }
]
```

- **Two kinds, and deliberately no third.** `binary` (a command that must be
  on `PATH`) and `file` (a path that must exist: a checkout, a checkpoint, a
  model). Everything a talking-head engine needs is one of those two, and a
  vocabulary that grew past them would stop being a declaration and start
  being a build script. Closed for the same reason `FIELD_TYPES` is: a
  prerequisite core cannot check is refused **by name**, never rendered as a
  best guess.
- **`hint` is displayed, never executed.** It is the line a human would type,
  shown so it can be copied. Decklight does not run it, and that is the only
  reason it can be catalog-supplied at all. A plugin able to get a shell
  command run at author privilege merely by declaring a "prerequisite" would
  make the wizard a remote-code-execution primitive with a config file for a
  delivery mechanism, the exact inversion `MARKETPLACE.md WHY` exists to
  refuse. The piper offer-to-fetch (`PRESENTING`) looks similar and is not:
  that command is chosen by decklight's own code, against a package decklight
  names, and no catalog can put a string in it.
- **A third state, `prerequisite`, beside `unreachable` and `rejected`**:
  `412` on the wire, its own line in the player. Someone missing rhubarb must
  not be told to check their key, exactly as someone with a wrong key must not
  be told to check their network.
- **The gate runs first.** Before the answers are checked, before the network
  is touched, and before anything is written: an engine that cannot run here
  never has a credential collected for it, and a provider outage can never
  mask a missing binary.
- **Nothing is ever downloaded, and non-TTY runs never prompt**: unchanged
  from the offer-to-fetch precedents, because nothing here fetches at all.
- **`capability: "lipsync"`** is a runnable engine kind alongside `tts`
  (`ENGINE_UNITS`): the factory contract is identical, and what differs is
  exactly the prerequisites above.

### AGENT_UNITS · AI agents: a descriptor, and a remembered preference

`A` (PRESENTING) hands an installed coding agent one editing task. The roster
of agents decklight knows how to invoke ships in core, and a marketplace can
extend it, but an agent unit is a **descriptor, never code**:

```json
{ "name": "my-agent", "type": "agent",
  "bin": "my-agent", "args": ["-p", "{prompt}", "--yes"] }
```

- **`bin` is a command you already installed**, the way its own documentation
  says. `decklight library add agent <name>` fetches nothing and runs nothing of the
  catalog's: it only teaches decklight how to *call* something already on
  your `PATH`. That is why `agent` is `REFERENCE_ONLY` beside `voice`, carries
  no `sha256`, and is the second kind whose `add` works offline. The reason
  differs from a voice's: not consent, but blast radius; an open roster that
  required downloading a module would put every new agent in `UNIT_PINNING`'s
  risk class for no gain, when the thing being described is a binary the user
  chose and installed themselves.
- **The whole template vocabulary is `{prompt}` and `{deck}`**, each
  substituted into one argv element. The result is spawned as an **argv
  array, never a shell string**, so a deck path containing a space or a
  semicolon is an argument and can never become a command. A descriptor whose
  `args` never mentions `{prompt}` is refused: an agent handed no instruction
  is not a working entry. The three shapes the built-in roster already covers
  (`-p …`, `exec --full-auto …`, `run -t …`) are the evidence this vocabulary
  is closed enough to stay declarative.
- **A unit may not shadow a built-in.** An installed descriptor whose name
  collides with one of the core agents is dropped rather than replacing it:
  silently changing how `claude` is invoked is not something a catalog should
  be able to do to a machine. A malformed descriptor is skipped, not thrown
  on: one broken third-party entry must not take `A` down for the agents
  beside it.
- **The preferred agent is remembered** (`~/.decklight/agent.json`), so `A`
  opens on the agent you chose rather than on whichever was detected first.
  Precedence matches every other saved choice: `--agent` > the remembered
  preference > the first detected agent. Choosing one in the `A` dialog
  persists it (`POST /deck/edit/agent/prefer`); it is a fact about the machine, so
  it is written beside the unit library and **never into the deck**.
- **A remembered agent that is missing is named, never substituted.** Which
  agent edits your deck is not an interchangeable detail, so an unavailable
  preference does not quietly fall back to another one: the edit server says
  so once at startup, and `A` answers with a line naming what is missing, what
  is available, and how to get it back.
- **An agent is offered only if it can be RUN, and it is run as argv.** On
  Windows every agent that installs from npm lands as a `.cmd` batch shim, and
  Node refuses to spawn one without a shell. decklight does not turn one on:
  with a shell the arguments stop being arguments and become a command line for
  `cmd.exe` to re-split, and one of them is the user's prompt: `%VAR%` there
  is expanded before any escaping the caller could apply, so no quoting makes
  it safe. Instead the shim is resolved back to the script it runs and node is
  spawned on that, which keeps the guarantee above (argv is argv) identical on
  both platforms. A batch file that names no such script is **not offered at
  all**: detected-but-unrunnable is a worse answer than absent, and the
  refusal names the file rather than claiming the command is missing.

### VOICE_UNITS · Voices: a reference, never a payload

A marketplace distributes voices as **references**. A `voice` entry names an
engine and one of that engine's own voice identifiers (`{ "name":
"narrator-anna", "type": "voice", "engine": "elevenlabs", "voiceId": "…" }`)
and carries no `source`. There are no model weights, no sample audio, and
nothing else that could reproduce a person's voice on a machine that never
asked. `decklight library add voice` therefore fetches nothing at all: it writes the
pointer it already had in the catalog cache, which makes it the one install
that works offline, and speaking through it still needs that engine and the
installer's own credential.

**The rule is enforced by subtraction.** A `source` on a `voice` entry is
*refused*, not ignored, so the field through which bytes would arrive does not
exist: the same shape as the runtime having no plugin system rather than a
disabled one (NON_GOALS). An ignored field would still let a catalog carry a
model that merely never loads.

**There is deliberately no consent attestation.** A `consent: true` field would
be one boolean an uploader types and no one can verify, and printing it back
would manufacture exactly the confidence the ingredients label refuses to
manufacture (PRESENTING: an inventory, never a verdict). Distributing only
references puts the consent relationship where it can actually be held and
withdrawn: a cloned voice lives in a provider account under terms that governed
the cloning, it is useless to anyone the owner has not shared it with, and
unsharing it revokes every reference at once, which no file, once downloaded,
can be made to do.

**The limit, stated rather than papered over:** this does not stop a catalog
naming a voice after a person, or pointing at a provider voice that imitates
one. What it stops is decklight becoming the thing that *hands out the
likeness*. The rest is the provider's terms and the marketplace's own tier
(first-party vetted, community screened, third-party unreviewed): the same
place every other unreviewable claim about a catalog entry already lives.

Piper voice models are unaffected and stay what they were: downloads offered by
the engine when a model is missing, not marketplace units.

Entry names are qualified `name@marketplace`. A bare name resolves only while
it exists in exactly one registered marketplace; the same bare name in two is
reported as ambiguous with the qualified forms to use instead, never silently
resolved to either. The registry registers, caches and names; installing what
an entry points at is each install surface's own contract (a theme is marked
through `theme add`'s validator and referenced, never copied, THEME_DISTRIBUTION).
Nothing here executes in a deck: the marketplace distributes data and
authoring-side units, and the no-plugin-system line (NON_GOALS) stands.

**The personal marketplace.** A theme that arrives as a file or a URL has no
marketplace for a deck to refer to it in, so `theme add` copies it into one:
`~/.decklight/local/`, a local marketplace like any other (a
`.decklight/marketplace.json` and the files beside it), registered as `local`
the first time it is needed. It lives outside `~/.decklight/marketplaces/`,
where clones are kept, because `marketplace remove` deletes the clone of what
it removes: unregistering `local` must never delete somebody's themes. A
marketplace already registered as `local` from anywhere else is left alone,
and `theme add` says so rather than taking the name.
