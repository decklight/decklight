#!/usr/bin/env node
// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// decklight marketplace — register catalogs; never fetch unless asked to.
//
//   decklight marketplace add    <owner/repo | git url | path> [--name x]
//   decklight marketplace list
//   decklight marketplace update <name>
//   decklight marketplace remove <name>
//
// A marketplace is a git repo (or a local directory) with
// `.decklight/marketplace.json` at its root, mirroring Claude Code's layout
// (MARKETPLACE.md MARKETPLACES). Registration lives under `~/.decklight/`:
// one registry file (`marketplaces.json`) plus a `marketplaces/` directory
// holding, per marketplace, its cached manifest (`<name>.json`) and the
// CHECKOUT that manifest came with (`<name>/`) — the boring layout the engine
// wizard shares.
//
// A remote marketplace is read by CLONING it (MARKETPLACES#CLONE), never by
// fetching one file at a time off a raw-content host. That is what lets a
// private marketplace work at all — a clone uses the caller's own git
// credentials, an anonymous fetch has none — and it is also what makes an
// entry's files provably come from the same commit as the manifest that
// offered them.
//
// The invariant this module exists to keep (SPEC MARKETPLACE_REGISTRY): the
// network is touched ONLY by an explicit `add` or `update` of a remote
// source. Registering is a filesystem write; `list` reads only the cache;
// installing an entry reads the checkout; nothing on the deck-load or
// presenting path imports this module at all. A deck on conference wifi, on a
// plane, or air-gapped behaves identically to one at a desk, marketplace or
// no marketplace.

import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { argReader, isMain } from '../tools/args.mjs';
import { oneline } from './git.mjs';

export const MANIFEST_PATH = '.decklight/marketplace.json';
/** A group heading, not a description. */
const MAX_TITLE = 60;

export const NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Every kind of entry this decklight recognises, and how you install one.
 *
 * It lives here rather than in units.mjs because this module owns the manifest
 * vocabulary and units.mjs is the layer above it — the other direction would
 * be a cycle. A `null` hint means the kind is real but nothing installs it
 * here yet, which `marketplace list` prints as its own state: "not yet" and
 * "typo" must not look alike.
 */
export const INSTALL_HINT = {
  theme: 'decklight theme add <source> <deck>',
  plugin: 'decklight plugin add <name>',
  template: 'decklight template add <name>',
  skill: 'decklight skills add <name>',
  importer: 'decklight importer add <name>',
  engine: 'decklight engine add <name>',  // ENGINE_UNITS — the wizard then configures it
  agent: 'decklight agent add <name>',    // AGENT_UNITS — a descriptor, never code
  transform: 'decklight transform add <name>',  // EXTENSIONS#LOADER — installs; bundle --transform <name> runs it
  voice: 'decklight voice add <name>',
  'publish-target': null,
};

export const KNOWN_TYPES = Object.keys(INSTALL_HINT);

/** The catalog every install registers, and no install ever fetches. */
export const FIRST_PARTY = { name: 'decklight', source: 'decklight/decklight-plugins-official' };

/** A failure with a message for a human — the mains print it, never a stack. */
export class MarketplaceError extends Error {}

// ── where everything lives ─────────────────────────────────────────────────

/** The decklight config home (ENGINES decided `~/.decklight/`). */
export const configHome = (env = process.env) =>
  env.DECKLIGHT_HOME || join(homedir(), '.decklight');

const registryPath = (home) => join(home, 'marketplaces.json');
const cachePath = (home, name) => join(home, 'marketplaces', `${name}.json`);

/**
 * The CHECKOUT a remote marketplace keeps beside its cached manifest
 * (MARKETPLACES#CLONE): `~/.decklight/marketplaces/<name>/`, the working tree
 * of the shallow clone `add`/`update` made, with its `.git` removed.
 *
 * It exists because an entry's `source` is repo-relative, and the two ways to
 * turn that into bytes are not equivalent. A second unauthenticated fetch of
 * `raw.githubusercontent.com` cannot see a private repo at all, and reads a
 * ref that may have moved since the manifest was read; a file in the checkout
 * came from the same clone as the manifest, over the caller's own git
 * credentials. So the clone is what an install reads, and the network is not
 * on the install path at all.
 *
 * A LOCAL marketplace has none — its directory already is the checkout, and
 * copying somebody's working tree into the config home would give them a stale
 * second copy of files they are editing.
 */
export const checkoutPath = (home, name) => join(home, 'marketplaces', name);

export function loadRegistry(home = configHome()) {
  const p = registryPath(home);
  if (!existsSync(p)) return { version: 1, marketplaces: {} };
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return { version: 1, marketplaces: {}, ...data };
  } catch (e) {
    throw new MarketplaceError(`${p} is not valid JSON (${parseMsg(e)}) — fix or delete it`);
  }
}

export function saveRegistry(reg, home = configHome()) {
  mkdirSync(join(home, 'marketplaces'), { recursive: true });
  writeFileSync(registryPath(home), JSON.stringify(reg, null, 2) + '\n');
}

/**
 * Register the first-party marketplace on first run — REGISTERED, not
 * fetched: this writes two files and touches nothing else, so first run
 * offline is silent and instant. First run means "no registry file yet";
 * once one exists this never fires again, so removing the first-party
 * marketplace is respected rather than undone on the next command.
 */
export function ensureFirstPartyRegistered(home = configHome()) {
  if (existsSync(registryPath(home))) return false;
  saveRegistry({
    version: 1,
    marketplaces: { [FIRST_PARTY.name]: { source: FIRST_PARTY.source, firstParty: true } },
  }, home);
  return true;
}

// ── the manifest, validated with line numbers ──────────────────────────────

/** "Unexpected token } in JSON at position 47" minus the part we say better. */
const parseMsg = (e) => String(e.message)
  .replace(/ in JSON.*$/, '')
  .replace(/,\s*(?:\.\.\.)?"[\s\S]*"(?:\.\.\.)? is not valid JSON$/, '')
  .replace(/^JSON\.parse: /, '');

const lineAt = (raw, idx) => raw.slice(0, idx).split('\n').length;

// V8's snippet-style parse error ('Unexpected token X, ..."<context>"... is
// not valid JSON') carries no position — but the context starts a fixed 10
// characters before the error, so finding the snippet in the raw text
// recovers it. The other two message forms name the position outright.
const V8_SNIPPET_BEFORE = 10;

/** The line a JSON.parse SyntaxError points at, from any V8 message form. */
export function parseErrorLine(raw, e) {
  const lc = /line (\d+) column \d+/.exec(e.message);
  if (lc) return Number(lc[1]);
  const pos = /position (\d+)/.exec(e.message);
  if (pos) return lineAt(raw, Number(pos[1]));
  const snip = /^Unexpected token '(.*?)', (\.\.\.)?"([\s\S]*)"(?:\.\.\.)? is not valid JSON$/.exec(e.message);
  if (snip) {
    const [, token, clipped, escaped] = snip;
    const context = escaped.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    const start = raw.indexOf(context.slice(0, V8_SNIPPET_BEFORE + 2));
    if (start >= 0) {
      const offset = clipped ? V8_SNIPPET_BEFORE : Math.max(0, context.indexOf(token));
      return lineAt(raw, start + offset);
    }
  }
  return 1;
}

/**
 * Path → line for every key and array element in a VALID JSON text
 * (`entries[2].type` → the line that key sits on), so a field error can name
 * the line the way a parse error does. Only ever called after JSON.parse
 * succeeded, which is what keeps this walk simple.
 */
export function jsonLineMap(raw) {
  const lines = new Map();
  let i = 0;
  const ws = () => { while (i < raw.length && /\s/.test(raw[i])) i++; };
  const str = () => {
    const s = i; i++;
    while (raw[i] !== '"') i += raw[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(raw.slice(s, i));
  };
  const value = (path) => {
    ws();
    const c = raw[i];
    if (c === '{') {
      i++; ws();
      if (raw[i] === '}') { i++; return; }
      for (;;) {
        ws();
        const keyStart = i;
        const key = str();
        const p = path ? `${path}.${key}` : key;
        lines.set(p, lineAt(raw, keyStart));
        ws(); i++; // the ':'
        value(p);
        ws();
        if (raw[i] === ',') { i++; continue; }
        i++; return; // '}'
      }
    }
    if (c === '[') {
      i++; ws();
      if (raw[i] === ']') { i++; return; }
      for (let idx = 0; ; idx++) {
        ws();
        lines.set(`${path}[${idx}]`, lineAt(raw, i));
        value(`${path}[${idx}]`);
        ws();
        if (raw[i] === ',') { i++; continue; }
        i++; return; // ']'
      }
    }
    if (c === '"') { str(); return; }
    while (i < raw.length && !/[\s,\]}]/.test(raw[i])) i++; // number/true/false/null
  };
  try { value(''); } catch { /* a walk bug never outranks the real report */ }
  return lines;
}

/**
 * The extra fields a given kind of entry must carry (`UNITS`).
 *
 * A type NOT in this table is accepted rather than refused, and that is
 * deliberate: a catalog is a file someone else wrote, quite possibly against a
 * newer decklight than the one reading it, and rejecting a manifest wholesale
 * because one entry names a kind we have not shipped yet would make every
 * catalog un-addable the day it adds an entry. The unknown kind is surfaced by
 * `marketplace list` instead, where it is information rather than a wall.
 */
/**
 * The build-time transform invocation contract's own version (SPEC
 * `UNIT_COMPAT`, `OPEN` 2 in MARKETPLACE.md).
 *
 * Deliberately NOT decklight's package version: `src/core/engine.js` has been
 * split apart repeatedly (four modules pulled out in #147 alone) without that
 * ever being a promise to anyone outside the repo, so checking a transform's
 * compatibility against decklight's package.json would tie every installed
 * extension to churn it never touches. This number instead tracks only the
 * narrow "HTML in, HTML out" calling convention `EXTENSIONS#TRANSFORMS`
 * declares, and moves the way `CAST_FORMAT`'s `decklightCast` does: additive
 * only, bumped only when that calling convention itself would break an
 * existing transform, never for an internal reorganisation. A transform
 * declares the lowest version it needs; this decklight is compatible with
 * anything at or below `TRANSFORM_API_VERSION`.
 */
export const TRANSFORM_API_VERSION = 1;

/**
 * The import-adapter invocation contract's own version (SPEC
 * `EXTENSIONS_ADAPTERS`, `EXTENSIONS#ADAPTEREXEC`).
 *
 * A separate counter from `TRANSFORM_API_VERSION`, deliberately: the two are
 * different calling conventions (`html, opts → html` vs `bytes, opts →
 * html`) that will each grow a field on their own schedule, so sharing one
 * number would bump every installed transform's compatibility the day the
 * *importer* contract changed something a transform never touched — the same
 * churn-isolation argument `TRANSFORM_API_VERSION` itself makes against
 * decklight's own package version. Additive-only, the same way: bumped only
 * when the import-adapter calling convention itself would break an existing
 * adapter, never for an internal reorganisation.
 */
export const IMPORTER_API_VERSION = 1;

/**
 * The speech-engine invocation contract's own version (SPEC `ENGINE_UNITS`,
 * `ENGINES#TTS`).
 *
 * A third counter beside the two above, for the third reason they are
 * separate: an engine's convention is not `input → string` at all. It is a
 * FACTORY — `opts → {name, voices, stylable, synth}` — and `synth` returns
 * audio plus a usage record rather than text, so the day either of the other
 * two grows a field, an engine's contract is untouched and must not be
 * invalidated along with them. Additive-only on the same terms: bumped only
 * when the factory or `synth` convention itself would break an installed
 * engine, never for an internal reorganisation of `tools/tts-engines.mjs`
 * (whose six built-ins are not units and are not versioned by this at all).
 */
export const ENGINE_API_VERSION = 1;

/**
 * What an installed engine's `capability` may say, and this decklight runs.
 *
 * `lipsync` joined `tts` with ENGINES#LIPSYNC: the loader's contract is the
 * same factory either way, and what differs is the PREREQUISITES an engine
 * declares (SPEC ENGINE_PREREQUISITES) — a binary and a checkout rather than
 * only a pasted key.
 */
export const ENGINE_CAPABILITIES = ['tts', 'lipsync'];

/**
 * The pin a code-carrying entry installs against (SPEC `UNIT_PINNING`): the
 * SHA-256 of the module file's bytes, lowercase hex, as `sha256sum` prints it
 * and `decklight extension check` emits it on success.
 *
 * Validated for SHAPE when present, like everything else in `ENTRY_SHAPES` —
 * but its ABSENCE is refused at install time (`cli/units.mjs`), not here.
 * Requiring it at the manifest level would invalidate a whole catalog over
 * one unpinned transform, costing its theme entries too — the same
 * blast-radius reasoning that leaves an unknown `type` accepted. The refusal
 * instead lands at the one moment the risk does: installing the executable
 * entry.
 */
const sha256Shape = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
  ? null
  : 'must be 64 lowercase hex characters — the SHA-256 of the module file\'s bytes (SPEC UNIT_PINNING)');

/** Fields a kind MAY carry, checked only when present — see `sha256Shape`. */
const ENTRY_SHAPES_OPTIONAL = {
  importer: { sha256: sha256Shape },
  transform: { sha256: sha256Shape },
  // An engine entry wears one `type` for two jobs, and only one of them
  // carries code. `{name, type: 'engine', source, wizard}` DECLARES a wizard
  // for an engine decklight already ships (ENGINES#WIZARD) — it installs
  // nothing, so it has no contract version and no capability to name. An
  // engine UNIT (SPEC ENGINE_UNITS) is a module the loader runs, and needs
  // both. Requiring them here would invalidate every catalog of the first
  // kind, so they are shape-checked when present and their ABSENCE is
  // refused at install (`cli/units.mjs`) — exactly where `sha256`'s is, for
  // exactly the same blast-radius reason.
  engine: {
    sha256: sha256Shape,
    apiVersion: (v) => (Number.isInteger(v) && v >= 1
      ? null
      : 'must be a positive integer — the ENGINE_UNITS contract version this engine needs, not a decklight version'),
    capability: (v) => (typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v)
      ? null
      : 'must name the affordance this engine answers for, e.g. "tts"'),
  },
};

const ENTRY_SHAPES = {
  // `import` has to name the adapter for a `.marp` file from the CACHE, with
  // no network — so which extensions an adapter claims is a fact the catalog
  // must carry, not something discoverable by installing it and looking.
  // `apiVersion` is the same shape-only check `transform` gets below, against
  // its own contract (SPEC EXTENSIONS_ADAPTERS) — an adapter is Node code
  // running an installed unit, exactly like a transform is.
  importer: {
    extensions: (v) => (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && /^\.?[A-Za-z0-9]+$/.test(x))
      ? null
      : 'must be a non-empty array of file extensions the adapter reads, e.g. [".marp"]'),
    apiVersion: (v) => (Number.isInteger(v) && v >= 1
      ? null
      : 'must be a positive integer — the EXTENSIONS_ADAPTERS contract version this adapter needs, not a decklight version'),
  },
  // A transform is Node code, so it declares the invocation-contract version
  // it needs rather than pinning decklight's own package version (OPEN 2) —
  // see TRANSFORM_API_VERSION above. Any positive integer validates here
  // regardless of what THIS decklight currently implements: a catalog written
  // against a newer contract must stay addable, the same reasoning that
  // leaves an unknown `type` accepted rather than refused (below).
  transform: {
    apiVersion: (v) => (Number.isInteger(v) && v >= 1
      ? null
      : 'must be a positive integer — the EXTENSIONS#TRANSFORMS contract version this transform needs, not a decklight version'),
  },
  // An agent entry is a DESCRIPTOR (SPEC AGENT_UNITS): the binary you already
  // installed, and the argv of its headless mode. Deliberately not code — the
  // three shapes the built-in roster already covers (`-p …`, `exec
  // --full-auto …`, `run -t …`) are a small closed vocabulary a template
  // expresses completely, so teaching decklight a new agent never means
  // downloading and running someone's module (which is why `agent` is in
  // REFERENCE_ONLY below and carries no `sha256`).
  agent: {
    bin: (v) => (typeof v === 'string' && /^[A-Za-z0-9][\w.-]*$/.test(v)
      ? null
      : "must be the agent's executable name, e.g. \"claude\" — a bare command, never a path or a shell line"),
    args: (v) => (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')
      ? (v.some((x) => x.includes('{prompt}'))
        ? null
        : 'must include {prompt} in one of its arguments — otherwise the agent is handed no instruction')
      : 'must be the argv of the agent\'s headless mode, as an array of strings, e.g. ["-p", "{prompt}"]'),
  },
  // A voice entry is a POINTER (SPEC VOICE_UNITS): which engine, and which of
  // that engine's voices. Both are needed for the roster to be filtered to the
  // engine actually running — a reference to an ElevenLabs voice is not an
  // answer when the bridge is speaking piper.
  voice: {
    engine: (v) => (typeof v === 'string' && /^[a-z][a-z0-9-]*$/.test(v)
      ? null
      : 'must name the TTS engine the voice belongs to, e.g. "elevenlabs"'),
    voiceId: (v) => (typeof v === 'string' && v.trim()
      ? null
      : "must be the engine's own identifier for the voice"),
  },
};

/**
 * Kinds that NAME a thing rather than carrying it (SPEC VOICE_UNITS).
 *
 * A voice is distributed as a reference and never as a payload — no model
 * weights, no sample audio, nothing that reproduces a person offline. The
 * enforcement is this set, and it works by SUBTRACTION: an entry listed here
 * has no `source`, so the code path that fetches bytes is never entered and
 * there is no field through which a cloned voice could arrive.
 *
 * That is deliberately a shape, not an attestation. A `consent: true` field
 * would be one boolean an uploader types and nobody can check — the same
 * defeatable green mark the ingredients label refuses to print (SPEC
 * PRESENTING). Distributing only references puts the consent relationship
 * where it can actually be enforced and revoked: the provider account whose
 * terms governed the cloning, and which can unshare the voice.
 */
export const REFERENCE_ONLY = new Set(['voice', 'agent']);

function shapeErrors(entry, p, err) {
  // NOT an early return when a type declares no required fields: a kind can be
  // all-optional (`engine`, whose two fields are enforced at install instead —
  // ENTRY_SHAPES_OPTIONAL above), and bailing here would skip its shape checks
  // entirely, silently accepting `capability: 42`.
  for (const [field, check] of Object.entries(ENTRY_SHAPES[entry.type] ?? {})) {
    if (entry[field] === undefined) {
      err(`${p}.${field}`, `missing — ${entry.type} entries must declare it: ${check(undefined) ?? 'see UNITS'}`);
      continue;
    }
    const why = check(entry[field]);
    if (why) err(`${p}.${field}`, why);
  }
  for (const [field, check] of Object.entries(ENTRY_SHAPES_OPTIONAL[entry.type] ?? {})) {
    if (entry[field] === undefined) continue;
    const why = check(entry[field]);
    if (why) err(`${p}.${field}`, why);
  }
}

/**
 * Validate a manifest text. Returns `{ ok, manifest, errors }`; every error
 * carries the LINE and the FIELD it is about — a typo in somebody's catalog
 * is met with "line 7: entries[1].type — missing", never a stack trace.
 */
export function validateManifest(raw) {
  let data;
  try { data = JSON.parse(raw); } catch (e) {
    return { ok: false, manifest: null, errors: [{ line: parseErrorLine(raw, e), field: '(json)', msg: parseMsg(e) }] };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, manifest: null, errors: [{ line: 1, field: '(top level)', msg: 'must be a JSON object' }] };
  }
  const lines = jsonLineMap(raw);
  const errors = [];
  // a missing key has no line of its own; its container's line is the honest one
  const at = (path) => lines.get(path) ?? lines.get(path.replace(/\.[^.[\]]+$/, '')) ?? 1;
  const err = (path, msg) => errors.push({ line: at(path), field: path, msg });

  if (data.name === undefined) err('name', 'missing — the marketplace needs a name');
  else if (typeof data.name !== 'string' || !NAME_RE.test(data.name)) {
    err('name', `${JSON.stringify(data.name)} — letters, digits, - and _ only (it names every entry: entry@${typeof data.name === 'string' ? data.name : 'name'})`);
  }
  // `title` is the catalog's human name — what a theme picker draws as a group
  // heading, since `name` is kebab by construction and `decklight-confluent` is
  // an identifier rather than a word anyone says. Optional, and OLD DECKLIGHTS
  // IGNORE IT: unknown top-level keys already validate, so a catalog can add
  // one without waiting for anybody to upgrade.
  //
  // Loose on purpose — it is a display string, not an identifier — but not
  // unbounded: 60 characters is generous for a heading, and an empty one is a
  // refusal rather than a silently-empty attribute in somebody's deck.
  if (data.title !== undefined) {
    if (typeof data.title !== 'string' || !data.title.trim()) {
      err('title', 'must be the catalog\'s human name, e.g. "Confluent" — or left out entirely');
    } else if (data.title.trim().length > MAX_TITLE) {
      err('title', `${data.title.trim().length} characters — a group heading, not a description (max ${MAX_TITLE})`);
    }
  }
  if (data.entries === undefined) err('entries', 'missing — an array of { name, type, source, description? }');
  else if (!Array.isArray(data.entries)) err('entries', 'must be an array');
  else {
    const seen = new Map();
    data.entries.forEach((entry, idx) => {
      const p = `entries[${idx}]`;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) { err(p, 'must be an object'); return; }
      if (entry.name === undefined) err(`${p}.name`, 'missing — the name an install asks for');
      else if (typeof entry.name !== 'string' || !NAME_RE.test(entry.name)) {
        err(`${p}.name`, `${JSON.stringify(entry.name)} — letters, digits, - and _ only`);
      } else if (seen.has(entry.name)) {
        err(`${p}.name`, `"${entry.name}" already used by entries[${seen.get(entry.name)}] — entry names are unique within a marketplace`);
      } else seen.set(entry.name, idx);
      if (entry.type === undefined) err(`${p}.type`, 'missing — what kind of thing this is (theme, template, skill, importer, engine, transform, …)');
      else if (typeof entry.type !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.type)) {
        err(`${p}.type`, `${JSON.stringify(entry.type)} — a lowercase word (theme, template, skill, importer, engine, transform, …)`);
      } else shapeErrors(entry, p, err);
      if (REFERENCE_ONLY.has(entry.type)) {
        // Refused, not ignored. A `source` on a reference-only entry is the one
        // field through which a voice could arrive as bytes, and an ignored
        // field would let a catalog carry a model that merely never loads.
        if (entry.source !== undefined) {
          err(`${p}.source`, `a ${entry.type} entry names a ${entry.type}, it does not carry one`
            + ' — no source, no model, no sample (SPEC VOICE_UNITS)');
        }
      } else if (entry.source === undefined) {
        err(`${p}.source`, 'missing — the repo-relative path or URL the entry is fetched from');
      } else if (typeof entry.source !== 'string' || !entry.source) err(`${p}.source`, 'must be a non-empty string');
      if (entry.description !== undefined && typeof entry.description !== 'string') {
        err(`${p}.description`, 'must be a string');
      }
    });
  }
  return { ok: errors.length === 0, manifest: errors.length ? null : data, errors };
}

// ── sources: owner/repo, git URL, local path ───────────────────────────────

/**
 * What kind of source a spec names. A path that exists always wins.
 *
 * `github` is a shorthand for a CLONE, not for a raw-content host: it carries
 * the owner and repo so a message can name the SSH form, and `cloneUrl` below
 * is what it is actually read through.
 */
export function classifySource(spec, { exists = existsSync } = {}) {
  const gh = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(spec);
  if (gh) return { kind: 'github', owner: gh[1], repo: gh[2], spec };
  // `file://` is a git transport like any other (a bare mirror on a share, a
  // fixture in a test) — and unlike a bare path, writing it means "clone this",
  // not "read this directory in place".
  if (/^(git@|ssh:\/\/|git:\/\/|file:\/\/|https?:\/\/)/.test(spec)) return { kind: 'git', url: spec, spec };
  if (/^[\w.-]+\/[\w.-]+$/.test(spec) && !spec.startsWith('.') && !exists(spec)) {
    const [owner, repo] = spec.split('/');
    return { kind: 'github', owner, repo, spec };
  }
  return { kind: 'local', root: resolve(spec), spec };
}

/** The URL git is handed for a remote source. */
export const cloneUrl = (src) =>
  (src.kind === 'github' ? `https://github.com/${src.owner}/${src.repo}.git` : src.url);

/**
 * What to say when git could not clone a marketplace.
 *
 * The HTTPS form of a private repo fails here rather than 404ing somewhere
 * unauthenticated, which is already the improvement — but "Repository not
 * found" from a repo the user can see in their browser needs the missing half
 * spelled out: decklight clones with the CALLER's git credentials, so the
 * usual answer is that git has none for that host.
 *
 * Which it does not GUESS at. The setup instructions are printed when the
 * machine actually needs them and withheld when it does not (`hasGitCredential`
 * below), because advice that is wrong half the time is what teaches people to
 * skim past the last line of an error. When git does have a credential, saying
 * so is the more useful sentence: it means the name or the access is the
 * problem, not the setup.
 */
function cloneFailure(src, e, exec) {
  const why = `git clone ${cloneUrl(src)} failed — ${oneline(e)}`;
  // Offline is not an auth problem, and must not be answered as one: a plane
  // is a first-class place to run decklight, and the cache is still there.
  if (/could not resolve host|unable to access|connection (refused|timed out)|network is unreachable|SIGTERM/i.test(oneline(e))) {
    return `${why}\n  offline? the cached copy, if any, still serves \`marketplace list\``
      + ' — and an already-cloned marketplace still installs.';
  }
  // Named for GitHub only, because that is the only host whose SSH URL can be
  // derived rather than guessed at.
  const ssh = src.kind === 'github'
    ? `\n  Or add it by its SSH URL, which uses your keys instead of a helper:`
      + `\n    decklight marketplace add git@github.com:${src.owner}/${src.repo}.git`
    : '';
  const url = cloneUrl(src);
  if (!/^https?:\/\//i.test(url)) {
    // An SSH or git:// URL never consults a credential helper — the key is the
    // credential, so pointing at helper setup here would be a wrong turn.
    return `${why}\n  decklight clones with your own git credentials; for an SSH URL that means`
      + ' your key — `ssh -T git@github.com` says whether GitHub accepts it.';
  }
  const host = new URL(url).host;
  if (hasGitCredential(url, exec)) {
    return `${why}\n  git does have a credential for ${host}, so this is not a setup problem:`
      + '\n  check the spelling, and that the account that credential belongs to can see'
      + ` the repo.${ssh}`;
  }
  return `${why}\n  git has no credential for ${host}, so this clone was anonymous — and a`
    + '\n  private repo answers an anonymous clone exactly as a missing one does.'
    + '\n  Configure a credential helper, then try again:'
    + '\n    gh auth setup-git            (or the macOS Keychain, or git-credential-store)'
    + ssh;
}

/**
 * Does git already have a usable credential for this URL's host?
 *
 * `git credential fill` is the only honest way to ask. Reading
 * `credential.helper` out of the config answers a different question and gets
 * it wrong exactly where it matters: macOS ships a global `osxkeychain`
 * helper, so "a helper is configured" is true on a machine that has never
 * stored a GitHub credential in its life — the precise state that fails.
 *
 * Prompts are disabled on every axis (terminal, askpass), so this cannot hang
 * or pop a dialog, and it is bounded by its own timeout. The credential it
 * fills is DISCARDED unread: only the exit status is used, nothing is logged,
 * nothing is returned. This runs only after a clone has already failed.
 */
export function hasGitCredential(url, exec = execFileSync) {
  const { GIT_ASKPASS, SSH_ASKPASS, ...env } = process.env;
  try {
    const u = new URL(url);
    exec('git', ['credential', 'fill'], {
      input: `protocol=${u.protocol.replace(':', '')}\nhost=${u.host}\n\n`,
      stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000,
      env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone a remote marketplace into a fresh directory under `stagingIn` and read
 * its manifest. Returns the working tree for the caller to ADOPT (see
 * `adoptCheckout`) or discard — it is never left behind on a failure.
 *
 * `.git` is dropped once the commit is recorded: what decklight keeps is a
 * checkout, not a repository. Nothing ever pulls into it — `update` re-clones
 * — which is what keeps decklight out of the credential-helper trap a
 * background `git pull` walks into, and keeps `~/.decklight/` from filling up
 * with nested repositories.
 */
function cloneMarketplace(src, { exec, timeoutMs, stagingIn }) {
  mkdirSync(stagingIn, { recursive: true });
  const dir = mkdtempSync(join(stagingIn, '.staging-'));
  const opts = { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs * 4, encoding: 'utf8' };
  try {
    exec('git', ['clone', '--quiet', '--depth', '1', cloneUrl(src), dir], {
      ...opts,
      // never a password prompt: an unreachable private repo is an answer, not a hang
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new MarketplaceError(cloneFailure(src, e, exec));
  }
  try {
    const p = join(dir, MANIFEST_PATH);
    if (!existsSync(p)) throw new MarketplaceError(`${src.spec} has no ${MANIFEST_PATH} — is it a marketplace repo?`);
    const raw = readFileSync(p, 'utf8');
    let commit = null;
    try { commit = String(exec('git', ['rev-parse', 'HEAD'], { ...opts, cwd: dir })).trim(); } catch { /* not fatal */ }
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    return { raw, checkout: dir, commit };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * A source's manifest, and the files it came with — the only network in the
 * subsystem, reached only by an explicit `add` or `update`.
 *
 * Returns `{ raw, checkout, commit }`. `checkout` is a directory the caller
 * must adopt or remove, and is null for a local source (whose own directory
 * serves that role). It fails FAST and says why: git is told never to prompt,
 * the clone carries a timeout, and offline is an answer, not a hang (a plane
 * is a first-class place to run decklight).
 */
export async function fetchManifest(src, { exec = execFileSync, timeoutMs = 8000, stagingIn } = {}) {
  if (src.kind === 'local') {
    if (!existsSync(src.root)) throw new MarketplaceError(`no such directory: ${src.spec}`);
    const p = join(src.root, MANIFEST_PATH);
    if (!existsSync(p)) throw new MarketplaceError(`${src.spec} has no ${MANIFEST_PATH} — is it a marketplace repo?`);
    return { raw: readFileSync(p, 'utf8'), checkout: null, commit: null };
  }
  // staged beside the destination by default, so adopting it is a rename
  return cloneMarketplace(src, { exec, timeoutMs, stagingIn: stagingIn ?? join(configHome(), 'marketplaces') });
}

/**
 * Put a freshly cloned working tree in place as `name`'s checkout, replacing
 * whatever was there. A rename, not a copy, and the staging directory is a
 * sibling of the destination — so the swap is one filesystem operation on one
 * filesystem, and a half-written checkout is not a state that exists.
 */
export function adoptCheckout(home, name, checkout) {
  const dest = checkoutPath(home, name);
  mkdirSync(join(home, 'marketplaces'), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  if (checkout === null) return null;   // a local marketplace keeps none
  renameSync(checkout, dest);
  return dest;
}

// ── the cache, and names ───────────────────────────────────────────────────

/** The cached manifest for `name`: null when never fetched, else a validation. */
export function loadCatalog(name, home = configHome()) {
  const p = cachePath(home, name);
  if (!existsSync(p)) return null;
  return validateManifest(readFileSync(p, 'utf8'));
}

/**
 * Resolve an entry reference against every cached catalog. `name@marketplace`
 * is exact; a bare name resolves only when it exists in exactly ONE
 * registered marketplace — two is reported as ambiguous with the qualified
 * forms to say instead, never silently resolved to either. This is the seam
 * every install surface (theme browse, engine wizard, `init --from`) goes
 * through; nothing in THIS command installs anything.
 */
export function resolveEntry(ref, catalogs) {
  const q = /^(.+)@([^@]+)$/.exec(ref);
  if (q) {
    const [, entryName, market] = q;
    const cat = catalogs[market];
    if (!cat) throw new MarketplaceError(`no marketplace "${market}" is registered (decklight marketplace list)`);
    const entry = (cat.entries ?? []).find((e) => e.name === entryName);
    if (!entry) throw new MarketplaceError(`no "${entryName}" in ${market}`);
    return { entry, marketplace: market, qualified: `${entryName}@${market}` };
  }
  const hits = [];
  for (const [market, cat] of Object.entries(catalogs)) {
    for (const e of cat?.entries ?? []) {
      if (e.name === ref) hits.push({ entry: e, marketplace: market, qualified: `${ref}@${market}` });
    }
  }
  if (hits.length === 0) throw new MarketplaceError(`no "${ref}" in any registered marketplace`);
  if (hits.length > 1) {
    throw new MarketplaceError(`"${ref}" is ambiguous — it exists in ${hits.length} marketplaces:`
      + ` ${hits.map((h) => h.qualified).join(', ')} — say which`);
  }
  return hits[0];
}

// ── the command ────────────────────────────────────────────────────────────

const USAGE = `usage: decklight marketplace <add|list|update|remove> …

  decklight marketplace add <owner/repo | git url | path> [--name <name>]
    clone the source, read ${MANIFEST_PATH} at its root, and register
    the catalog under ~/.decklight/ — a local path never touches the network
    EXAMPLE: decklight marketplace add decklight/decklight-plugins-official
    EXAMPLE: decklight marketplace add ../my-marketplace

    the clone uses YOUR git credentials, so a private marketplace works the
    way git clone does in your terminal — and its entries install from that
    clone, at the commit the manifest came from

  decklight marketplace list
    every registered marketplace and its cached entries (as name@marketplace),
    read from the cache alone — list works on a plane

  decklight marketplace update <name>
    re-clone a marketplace, refreshing the cached manifest and the checkout
    its entries install from; for a registered-not-fetched marketplace this is
    the FIRST fetch it ever gets

  decklight marketplace remove <name>
    unregister a marketplace and drop its cached manifest and checkout

  registering is not fetching: the network is touched only by an explicit add
  or update, never when a deck loads or presents (SPEC MARKETPLACE_REGISTRY).
  DECKLIGHT_HOME overrides ~/.decklight/.`;

const printManifestErrors = (cmd, spec, errors) => {
  console.error(`decklight marketplace ${cmd}: ${spec} — ${MANIFEST_PATH} is not a valid marketplace manifest:`);
  for (const e of errors) console.error(`  line ${e.line}: ${e.field} — ${e.msg}`);
};

const entriesSummary = (name, entries) => {
  const shown = entries.slice(0, 6).map((e) => `${e.name}@${name}`);
  if (entries.length > shown.length) shown.push(`… ${entries.length - shown.length} more`);
  return `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${entries.length ? `: ${shown.join(', ')}` : ''}`;
};

async function addMain(args, home) {
  const { opt } = argReader(args);
  const [spec] = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--name');
  if (!spec) { console.error(`decklight marketplace add: needs an owner/repo, a git url, or a path\n\n${USAGE}`); return 1; }

  const src = classifySource(spec);
  let got;
  try { got = await fetchManifest(src, { stagingIn: join(home, 'marketplaces') }); } catch (e) {
    console.error(`decklight marketplace add: ${e.message}`);
    return 1;
  }
  // Everything below either adopts the clone or drops it — a staging directory
  // must not survive a refusal, so every early return passes through here.
  try {
    const v = validateManifest(got.raw);
    if (!v.ok) { printManifestErrors('add', spec, v.errors); return 1; }

    const name = opt('--name') ?? v.manifest.name;
    if (!NAME_RE.test(name)) { console.error(`decklight marketplace add: "${name}" is not a usable marketplace name`); return 1; }

    const reg = loadRegistry(home);
    const existing = reg.marketplaces[name];
    if (existing && existing.source !== spec) {
      console.error(`decklight marketplace add: "${name}" is already registered from ${existing.source}`);
      console.error(`  remove it first, or register this one under another name with --name`);
      return 1;
    }
    reg.marketplaces[name] = { ...(existing ?? {}), source: spec, commit: got.commit ?? undefined };
    writeCache(home, name, got.raw);
    const at = adoptCheckout(home, name, got.checkout);
    got.checkout = null;
    saveRegistry(reg, home);
    console.log(`${existing ? 'refreshed' : 'registered'} ${name} from ${spec} — ${entriesSummary(name, v.manifest.entries)}`);
    if (at) console.log(`  cloned to ${at}${got.commit ? ` (${got.commit.slice(0, 7)})` : ''} — installing an entry reads it, not the network`);
    return 0;
  } finally {
    if (got.checkout) rmSync(got.checkout, { recursive: true, force: true });
  }
}

function writeCache(home, name, raw) {
  mkdirSync(join(home, 'marketplaces'), { recursive: true });
  writeFileSync(cachePath(home, name), raw);
}

function listMain(home) {
  const reg = loadRegistry(home);
  const names = Object.keys(reg.marketplaces).sort();
  if (!names.length) {
    console.log('no marketplaces registered — decklight marketplace add <owner/repo | git url | path>');
    return 0;
  }
  for (const name of names) {
    const m = reg.marketplaces[name];
    // The commit is what the manifest AND every entry's files came from — one
    // clone, so there is a single answer to "which version of this catalog is
    // installed", and it is worth printing.
    const head = `${name}${m.firstParty ? ' (first-party)' : ''}  ${m.source}`
      + `${m.commit ? `  @${m.commit.slice(0, 7)}` : ''}`;
    const cached = loadCatalog(name, home);
    if (cached === null) {
      console.log(`${head} — registered, not fetched (decklight marketplace update ${name})`);
    } else if (!cached.ok) {
      console.log(`${head} — cached copy unreadable (decklight marketplace update ${name})`);
    } else {
      // Grouped by KIND rather than listed flat (UNITS): a catalog's entries
      // are not one undifferentiated bag of names — what you can do with an
      // entry depends entirely on what kind it is, and the install command
      // differs per kind. A kind this decklight does not know is shown as
      // exactly that, so a catalog written against a newer version reads as
      // "not yet" rather than as a typo.
      const entries = cached.manifest.entries;
      console.log(`${head} — ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`);
      const kinds = [...new Set(entries.map((e) => e.type))].sort();
      for (const kind of kinds) {
        const known = KNOWN_TYPES.includes(kind);
        const how = INSTALL_HINT[kind];
        console.log(`  ${kind}${known ? '' : ' (this decklight does not install this kind)'}`
          + `${how ? `  —  ${how}` : ''}`);
        for (const e of entries.filter((x) => x.type === kind)) {
          console.log(`    ${e.name}@${name}${e.description ? ` — ${e.description}` : ''}`);
        }
      }
    }
  }
  return 0;
}

async function updateMain(args, home) {
  const [name] = args.filter((a) => !a.startsWith('-'));
  if (!name) { console.error(`decklight marketplace update: which one?\n\n${USAGE}`); return 1; }
  const reg = loadRegistry(home);
  const m = reg.marketplaces[name];
  if (!m) { console.error(`decklight marketplace update: no marketplace "${name}" (decklight marketplace list)`); return 1; }

  const first = loadCatalog(name, home) === null;
  let got;
  try { got = await fetchManifest(classifySource(m.source), { stagingIn: join(home, 'marketplaces') }); } catch (e) {
    console.error(`decklight marketplace update: ${name}: ${e.message}`);
    // The clone lands in staging and is adopted only once it validates, so a
    // failed update leaves BOTH halves of what is on disk untouched — the
    // cached manifest and the checkout its entries install from.
    if (!first) console.error(`  the cached copy is untouched — list still works`);
    return 1;
  }
  try {
    const v = validateManifest(got.raw);
    if (!v.ok) { printManifestErrors('update', m.source, v.errors); return 1; }
    writeCache(home, name, got.raw);
    const at = adoptCheckout(home, name, got.checkout);
    got.checkout = null;
    const reg2 = loadRegistry(home);
    if (reg2.marketplaces[name]) {
      reg2.marketplaces[name] = { ...reg2.marketplaces[name], commit: got.commit ?? undefined };
      saveRegistry(reg2, home);
    }
    console.log(`${first ? 'fetched' : 'updated'} ${name} — ${entriesSummary(name, v.manifest.entries)}`);
    if (at) console.log(`  cloned to ${at}${got.commit ? ` (${got.commit.slice(0, 7)})` : ''}`);
    return 0;
  } finally {
    if (got.checkout) rmSync(got.checkout, { recursive: true, force: true });
  }
}

function removeMain(args, home) {
  const [name] = args.filter((a) => !a.startsWith('-'));
  if (!name) { console.error(`decklight marketplace remove: which one?\n\n${USAGE}`); return 1; }
  const reg = loadRegistry(home);
  const m = reg.marketplaces[name];
  if (!m) { console.error(`decklight marketplace remove: no marketplace "${name}" (decklight marketplace list)`); return 1; }
  delete reg.marketplaces[name];
  saveRegistry(reg, home);
  rmSync(cachePath(home, name), { force: true });
  rmSync(checkoutPath(home, name), { recursive: true, force: true });
  console.log(`removed ${name} — re-add any time with: decklight marketplace add ${m.source}`);
  return 0;
}

export async function marketplaceMain(args = []) {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') { console.log(USAGE); return sub ? 0 : 1; }
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) { console.log(USAGE); return 0; }
  const home = configHome();
  try {
    if (sub === 'add') return await addMain(rest, home);
    if (sub === 'list') return listMain(home);
    if (sub === 'update') return await updateMain(rest, home);
    if (sub === 'remove') return removeMain(rest, home);
  } catch (e) {
    if (e instanceof MarketplaceError) { console.error(`decklight marketplace ${sub}: ${e.message}`); return 1; }
    throw e;
  }
  console.error(`decklight marketplace: unknown subcommand "${sub}"\n\n${USAGE}`);
  return 1;
}

if (isMain(import.meta.url)) process.exit(await marketplaceMain(process.argv.slice(2)));
