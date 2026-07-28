# Decklight Marketplace — design record and epic

Status: **draft for review**. Not filed as an issue yet.

This is the consolidated record of the marketplace design, including the two
late additions that absorbed most of its safety burden: `decklight present` and
the `.deck` container. Where a later decision supersedes an earlier one, the
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
- **A first-party vetted marketplace in the decklight org**, registered
  automatically on first run — **registered, not fetched**. The network is
  touched only when the browse UI is opened, so a deck on conference wifi, on a
  plane, or air-gapped behaves identically.
- "Vetted" means a written bar enforced by CI (`theme check`, `extension
  check`), not a folder with the project's logo on it.
- Third-party marketplaces are unreviewed, auto-update off by default; the
  community one screens submissions and pins to a commit SHA. This is Claude's
  tiering, adopted deliberately.

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
  artifact.
- **It reports an inventory, never a verdict.** "3 script blocks: runtime 0.3.0
  ✔, 2 unaccounted" — not a green checkmark. The scan is heuristic; a defeatable
  verdict manufactures confidence the mechanism cannot back.
- **Architectural bonus:** the phone remote and its QR currently live in the
  *edit* server (`cli/edit.mjs`, gated by `allowRemote`), so getting a clicker
  today means running an editing server with `/edit/*` write endpoints against
  your deck. `present` is the natural home for speaker view and the remote with
  **no edit surface registered at all**.

### DECK_FILE — `.deck`, a signed container, not a relabel

Renaming `.html` to `.deck` changes no bytes and is not a boundary; anyone can
rename it back. It is a **default-path change**, which is worth having, but it
earns its existence only as a container:

```
talk.deck  =  deck.html  +  signature (Sigstore keyless)  +  manifest
```

- `decklight present talk.deck` verifies **before** rendering.
- The manifest (runtime version, extensions, origin repo, commit SHA) sits
  *outside* the payload, where a tamperer cannot edit it in the same pass.
- A tampered `.deck` fails verification instead of failing a heuristic scan.
- OS file association makes double-click land in `present` — verified and
  CSP-locked — rather than in a raw browser.
- `cli/zip.mjs` (from `skills --pack`) already provides the container plumbing.

**Both artifacts, different jobs:**

| Form | For | Promise |
|---|---|---|
| `.html` (canonical, unchanged) | publishing, links, `publish` → gh-pages | opens in any browser, offline, no software — the identity stays intact |
| `.deck` (new, optional) | handing a file to a person | verified on open, provenance attached, lands in `present` |

This maps onto the sharing guidance: **share the link** (HTTPS and repo
ownership attest it) or **send a `.deck`** (a signature attests it). An
unattested emailed `.html` stops being the default way to hand someone a deck.

### COMMANDS — The roster: `author` / `present`

`dev` named the software's mode; `present` names the human's activity — and the
repo's own vocabulary (7× "authoring contract", 6× "authoring skill",
`cli/dev.mjs`'s own header: "one command for the whole authoring loop") had
already voted. Renamed while it is cheap: npm `latest` is still 0.2.0, so no
muscle memory exists yet.

```
decklight author  talk.html    # the whole authoring loop (was: dev)
decklight present talk.deck    # play it, verified, read-only
```

- `dev` stays as a **permanent hidden alias** — one dispatcher line, never
  documented, never punished.
- `open` is an alias landing in `present` — the verb the OS uses on
  double-click of a `.deck`. One implementation, two doors.
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
   written `0600` under `~/.decklight/`. Loopback-only by construction
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

### INTEGRITY — A deck in transit

A file cannot vouch for itself: an attacker editing the payload edits any
embedded checker in the same pass, and `file://` HTML gets no OS signature UI.
Verification therefore comes from outside the file.

1. **Sign at `bundle`/`publish`** with Sigstore keyless — already used for the
   npm release, so no new key management. Detached sidecar is the authority.
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
backstop. `present` protects those who opted into the tooling; `.deck` and file
association widen that population; share-the-link covers the rest.

### UNITS — What is distributed

**Marketplace:** import adapters (Marp, Slidev, Deckset, reveal.js, PDF),
TTS/lipsync engine adapters, deck templates (`init --from`), specialised agent
skills, layout packs (CSS), export targets, build-time transforms, novelty and
homage theme packs, voices and casts.

**Stays in core:** the graded house theme set, the full `reveal-*` compat set
(migration must work offline), charts and math (SPEC contracts — `data-chart`
must mean one thing in every install), the base authoring skill.

**On themes specifically.** All 62 are **284K against 1.7M of `dist/`**, and
`bundle` already inlines only the themes a deck actually carries. Moving them
out shrinks a distributed deck by exactly zero while costing the first-run `T`
picker, the `contrast` and `palette-rules` CI gates, and offline `?theme=`.
Split by purpose instead: novelty and homage packs move (which also reduces the
trademark surface of what ships under the project's own name), the graded and
compat sets stay.

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
disclosure at install · official curated + community screened with SHA pinning ·
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
- [ ] A pasted credential lands `0600` under `~/.decklight/`, is never logged,
      and never appears in the deck or a `bundle` of it
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
- [ ] `bundle`/`publish` sign the output with Sigstore keyless; `present`
      verifies before rendering and names the signer
- [ ] `.deck` is a container of deck + signature + manifest; a tampered `.deck`
      fails verification and does not render
- [ ] Double-clicking a `.deck` opens `present` on macOS, Windows and Linux
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
`.deck`, tamper with it, double-click: verification fails and it does not
render. Then pull the network cable and press `T`: all 62 shipped themes and
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
| `INTEGRITY#SIGNING` | sign on `bundle`/`publish` via Sigstore keyless; verify in `present` | `PRESENT#AUDIT` |
| `DECK_FILE#ASSOC` | `.deck` container + OS file association (macOS UTI, Windows registry, Linux desktop/MIME) | `INTEGRITY#SIGNING` |
| `MARKETPLACES#CORE` | manifest, `add/list/update/remove`, cache, first-party registered-not-fetched | — |
| `THEME_BROWSE#UI` | **Browse** in the picker, authoring-only, installing via `theme add` | `MARKETPLACES#CORE` |
| `EXTENSIONS#TRANSFORMS` | build-time transform API + `extension check` (lint, then load) | `MARKETPLACES#CORE` |
| `PRESENT#PLUGINS` | presenter-library plugins, chrome-only, enforced | `PRESENT_SERVER`, `MARKETPLACES#CORE` |
| `ENGINES#WIZARD` | wizard framework: declarative schema, `~/.decklight/` `0600` writes, author-mode-only | `MARKETPLACES#CORE` |
| `ENGINES#TTS` | TTS engines as marketplace plugins — the proving case for the wizard | `ENGINES#WIZARD` |
| `ENGINES#LIPSYNC` | proves the framework generalizes (binary + venv + key, all three shapes) | `ENGINES#WIZARD` |
| `ENGINES#AGENTS` | agent-ask roster via marketplace — closes #125 | `ENGINES#WIZARD` |
| `UNITS#REST` | templates (`init --from`), skills, importers, publish targets, voices | `MARKETPLACES#CORE` |
| `COMMANDS#RENAME` | `dev` → `author` (hidden alias), remove `edit` (refuse out loud), move its 33 tests | — |
| `PRESENT#REMOTE` | move speaker view + phone remote off the edit server onto `present` | `PRESENT_SERVER` |
| `THEME_BROWSE#SPLIT` | move novelty/homage packs out of core, decide where grading lives | `MARKETPLACES#CORE`, `THEME_BROWSE#UI` |

`PRESENT_SERVER` through `DECK_FILE#ASSOC` are a coherent first release with no
marketplace at all — they make playing someone else's deck safe, which is worth
shipping on its own. `COMMANDS#RENAME` is independent of everything and cheapest
before 0.3.0 ships to npm.

---

## OPEN — Still open

1. **`upgrade` semantics** once a theme can come from a marketplace — re-fetch,
   pin, or refuse on a stale compat range. Blocks `THEME_BROWSE#SPLIT`
   specifically.
2. **Compat range vs engine version** for the build-time transform API. The
   18-module engine split is the precedent for how fast a documented API drifts.
3. ~~Where the authoring-time library lives~~ — **resolved: `~/.decklight/`**
   (plugins and credentials both, ENGINES). How `author` and `present` resolve
   a bare reference is implementation detail of `ENGINES#WIZARD`.
4. **Which themes are core** — the graded set needs an actual list.
5. **Voice likeness and consent** — a marketplace distributing cloned voices
   distributes someone's likeness; no lint catches that. Needs a policy line
   even if the answer is "attestation required".
6. **Is signing on by default** for `bundle`, or opt-in.
7. **`.deck` name collision** — check it against existing tooling before
   committing; `.dck` is the safer-but-uglier fallback.
8. **What `present` does by default when verification fails** — refuse, warn and
   continue, or drop to `--strict` automatically.
9. **Does `publish` also emit a `.deck`** alongside the gh-pages HTML.
10. ~~Does the system-voice adapter (#156) stay in core~~ — **resolved: yes**
    (ENGINES). First-`V`-offline still speaks; the wizard upsells rather than
    gates.
