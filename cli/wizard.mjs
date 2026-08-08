// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The engine wizard framework (MARKETPLACE.md `ENGINES#WIZARD`).
 *
 * TTS ships with no configuration and no bundled provider, but `V`/`N` and the
 * palette entries are always there. First use opens a wizard: pick a provider,
 * answer what it needs, and the answers land under the config home. There is
 * nothing to start if nothing is installed, which is what this replaces — eager
 * bridge startup, and any lazy-loading scheme that would have grown out of it.
 *
 * ## The rule this file exists to enforce
 *
 * **Core renders; a plugin only declares.** A plugin supplies a schema —
 * questions, field types, a validation endpoint — and never paints UI into the
 * deck. That is not a stylistic preference. "The wizard only appears in author
 * mode" has to be *enforceable*, and it stops being enforceable the moment a
 * plugin can put arbitrary markup on a slide: whatever rule core writes, the
 * plugin's own HTML is the thing that would have to honour it. So the field
 * vocabulary below is closed, and a schema asking for anything outside it is
 * refused by name rather than rendered as a best guess.
 *
 * ## Credentials
 *
 * Pasted in the player, posted to the author server, written `0600` under the
 * config home. Loopback-only by construction rather than by check: the author
 * server refuses every `/edit/*` mutation off-loopback unconditionally
 * (`allowRemote`), flag or no flag. Never logged, never written into the deck,
 * never picked up by `bundle` — a key that reached a deck would travel with it.
 *
 * A credential prompt in a deck you were *emailed* is a phishing primitive, so
 * `present` registers none of this and a bundled deck has nothing to post to.
 *
 * And the prompt itself names its asker and its destination (#232): every
 * string a schema puts on screen — the title, each field's label — was written
 * by the plugin, so `provenance` below derives the one line the plugin cannot
 * write, and the player refuses to render a schema that arrives without it.
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, statSync, existsSync } from 'node:fs';
import path, { delimiter } from 'node:path';
import { homedir } from 'node:os';
import { configHome } from './marketplace.mjs';

/** Where credentials live. Beside `marketplaces.json`, same config home. */
export const credentialsPath = (home = configHome()) => path.join(home, 'credentials.json');

/**
 * The closed field vocabulary. A plugin picks from these and nothing else.
 *
 * `secret` is the only one that is redacted and the only one that may be
 * written to the credentials file; the rest are ordinary configuration and are
 * safe to print back. Adding a type here is a deliberate act — it widens what
 * every plugin in every marketplace can ask a presenter for.
 */
export const FIELD_TYPES = Object.freeze(['secret', 'text', 'choice', 'path', 'boolean']);

/** Thrown for a schema core will not render. Distinct so callers can name it. */
export class SchemaError extends Error {}

const NAME_RE = /^[A-Za-z][\w-]{0,63}$/;

/**
 * Validate a plugin's declared wizard, returning a normalized copy.
 *
 * Deliberately strict, and deliberately explicit about *why* each rejection
 * happens: a plugin author reading the error should be able to fix the schema
 * without reading this file. Unknown keys are refused rather than ignored —
 * silently dropping a key a plugin thought was doing something is how a plugin
 * ends up shipping a wizard that asks for less than its author believed.
 */
export function validateSchema(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SchemaError('a wizard schema must be a JSON object');
  }
  const allowed = new Set(['engine', 'title', 'fields', 'validate', 'install', 'requires']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new SchemaError(`unknown key "${key}" — a schema may declare only: ${[...allowed].join(', ')}`);
    }
  }
  if (typeof raw.engine !== 'string' || !NAME_RE.test(raw.engine)) {
    throw new SchemaError('engine must be a name like "elevenlabs" (letters, digits, - and _)');
  }
  if (raw.title !== undefined && typeof raw.title !== 'string') {
    throw new SchemaError('title must be a string');
  }
  if (!Array.isArray(raw.fields) || !raw.fields.length) {
    throw new SchemaError('fields must be a non-empty array — a wizard with nothing to ask is not a wizard');
  }
  if (raw.fields.length > 12) {
    throw new SchemaError(`${raw.fields.length} fields is more than a first-run wizard should ask; 12 is the ceiling`);
  }

  const seen = new Set();
  const fields = raw.fields.map((f, i) => {
    const at = `fields[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new SchemaError(`${at} must be an object`);
    for (const key of Object.keys(f)) {
      if (!['name', 'label', 'type', 'required', 'options', 'default'].includes(key)) {
        throw new SchemaError(`${at}: unknown key "${key}"`);
      }
    }
    if (typeof f.name !== 'string' || !NAME_RE.test(f.name)) throw new SchemaError(`${at}.name must be a plain name`);
    if (seen.has(f.name)) throw new SchemaError(`${at}: duplicate field name "${f.name}"`);
    seen.add(f.name);
    if (!FIELD_TYPES.includes(f.type)) {
      // The refusal that carries the whole design: no `html`, no `script`, no
      // `markdown`, no `iframe`. Core renders a known set of inputs, so there
      // is no path by which a plugin's own markup reaches a slide.
      throw new SchemaError(`${at}.type "${f.type}" is not a field type core renders — pick one of: ${FIELD_TYPES.join(', ')}`);
    }
    if (f.label !== undefined && typeof f.label !== 'string') throw new SchemaError(`${at}.label must be a string`);
    if (f.type === 'choice') {
      if (!Array.isArray(f.options) || !f.options.length) {
        throw new SchemaError(`${at}: a choice field needs options`);
      }
      if (f.options.some((o) => typeof o !== 'string')) throw new SchemaError(`${at}.options must be strings`);
    } else if (f.options !== undefined) {
      throw new SchemaError(`${at}: options only mean something for a choice field`);
    }
    if (f.type === 'secret' && f.default !== undefined) {
      // A default secret is either a placeholder that will be pasted over or a
      // key baked into a catalog. The second is bad enough to refuse the first.
      throw new SchemaError(`${at}: a secret cannot carry a default`);
    }
    return {
      name: f.name,
      label: typeof f.label === 'string' ? f.label : f.name,
      type: f.type,
      required: f.required === true,
      ...(f.type === 'choice' ? { options: [...f.options] } : {}),
      ...(f.default !== undefined ? { default: f.default } : {}),
    };
  });

  const requires = validateRequires(raw);

  for (const key of ['validate', 'install']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || !raw[key].startsWith('/')) {
      throw new SchemaError(`${key} must be a path on the plugin's own bridge, like "/validate"`);
    }
  }

  return {
    engine: raw.engine,
    title: raw.title ?? raw.engine,
    fields,
    ...(raw.validate ? { validate: raw.validate } : {}),
    ...(raw.install ? { install: raw.install } : {}),
    ...(requires.length ? { requires } : {}),
  };
}

/** What a prerequisite may BE — closed, like `FIELD_TYPES` and for the same reason. */
export const REQUIRE_KINDS = Object.freeze(['binary', 'file']);

/**
 * Validate a schema's `requires` block — the NON-CREDENTIAL prerequisites an
 * engine needs before it can run at all (SPEC `ENGINE_PREREQUISITES`,
 * `ENGINES#LIPSYNC`). Lipsync is what forced this: rhubarb is a binary,
 * Wav2Lip is a python checkout plus model weights, and only Veo is the
 * paste-a-key shape TTS made look universal.
 *
 * Two kinds, and deliberately no third: `binary` (a command that must be on
 * PATH) and `file` (a path that must exist — a checkout, a checkpoint, a
 * model). Everything a talking-head engine needs is one of those two, and a
 * vocabulary that grew past them would stop being a declaration and start
 * being a build script.
 *
 * **`hint` is displayed, never executed.** It is the line a human would type,
 * shown so they can copy it. Decklight does not run it, and that is the whole
 * reason this can be catalog-supplied at all: a plugin able to get a shell
 * command run at author privilege merely by declaring a "prerequisite" would
 * make the wizard a remote-code-execution primitive with a config file for a
 * delivery mechanism — the exact inversion MARKETPLACE.md `WHY` exists to
 * refuse. The piper offer-to-fetch (#159) looks similar and is not: that
 * command is chosen by decklight's own code (`tools/tts-engines.mjs`), against
 * a package decklight names, and nobody else can put a string in it.
 */
function validateRequires(raw) {
  if (raw.requires === undefined) return [];
  if (!Array.isArray(raw.requires)) throw new SchemaError('requires must be an array');
  if (raw.requires.length > 8) {
    throw new SchemaError(`${raw.requires.length} prerequisites is more than a wizard should gate on; 8 is the ceiling`);
  }
  return raw.requires.map((r, i) => {
    const at = `requires[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new SchemaError(`${at} must be an object`);
    for (const key of Object.keys(r)) {
      if (!['kind', 'name', 'hint'].includes(key)) {
        throw new SchemaError(`${at}.${key} is not part of a prerequisite — only: kind, name, hint`);
      }
    }
    if (!REQUIRE_KINDS.includes(r.kind)) {
      throw new SchemaError(`${at}.kind "${r.kind}" is not a prerequisite core can check — pick one of: ${REQUIRE_KINDS.join(', ')}`);
    }
    if (typeof r.name !== 'string' || !r.name.trim()) {
      throw new SchemaError(`${at}.name must be the command or path to look for`);
    }
    // A hint is prose shown to a human. It is never run, so it is not
    // constrained to a command shape — but it IS length-capped, because a
    // catalog should not be able to paste a wall of text into the player.
    if (r.hint !== undefined && (typeof r.hint !== 'string' || r.hint.length > 200)) {
      throw new SchemaError(`${at}.hint must be a short string (≤200 chars) — the line a human would type`);
    }
    return { kind: r.kind, name: r.name.trim(), ...(r.hint ? { hint: r.hint } : {}) };
  });
}

/**
 * Which of a schema's prerequisites are NOT satisfied on this machine.
 *
 * Pure and probe-injected (the `needsDevMode`/`detectAgents` idiom), so the
 * whole gate is node-testable without a rhubarb on PATH. Returns the unmet
 * entries in declaration order; an empty array means the engine can run.
 */
export function unmetRequirements(schema, { hasBin = binOnPath, exists = existsSync } = {}) {
  return (schema?.requires ?? []).filter((r) => (r.kind === 'binary'
    ? !hasBin(r.name)
    : !exists(expandHome(r.name))));
}

/** `~/x` → `$HOME/x`; a model path is the one prerequisite people write that way. */
const expandHome = (p) => (p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p);

/** Is `bin` on $PATH? The wizard only ever probes bare command names. */
function binOnPath(bin, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return (env.PATH || '').split(delimiter)
    .some((dir) => dir && exts.some((ext) => existsSync(path.join(dir, bin + ext))));
}

/** One unmet prerequisite as a line for a human, naming the fix when declared. */
export const requirementLine = (r) => `${r.kind === 'binary' ? 'command' : 'file'} "${r.name}" is missing`
  + (r.hint ? ` — ${r.hint}` : '');

/**
 * Where a declared `validate`/`install` path actually resolves: the plugin's
 * own bridge on this machine. One constant, exported, so the code that POSTs
 * answers there (cli/edit.mjs) and the provenance the player shows can never
 * name two different places.
 */
export const BRIDGE_ADDR = '127.0.0.1:8787';

/**
 * The provenance a wizard prompt must carry before a single answer is typed
 * (#232). A field labelled "OpenAI API key" backed by an `install` endpoint is
 * a phishing form when the label is the only thing on screen — the same
 * untrusted party chose the question and the recipient. So the card also says
 * who is asking and where the answer goes, in words the plugin did not write:
 * `qualified` is the entry's registry name (`name@marketplace`, resolved by
 * the author server from the catalog, never read from the schema), and the
 * destination is derived from the *vetted* schema's endpoint declarations.
 * One function so the wording exists once; the player prints both strings
 * verbatim (as text, never markup) and refuses a schema that lacks them.
 */
export function provenance(schema, qualified) {
  if (typeof qualified !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(qualified)) {
    throw new SchemaError('provenance needs the entry\'s qualified registry name, like "elevenlabs@voices"');
  }
  const endpoints = [...new Set([schema.validate, schema.install].filter(Boolean))];
  return {
    askedBy: `asked by ${qualified}`,
    sentTo: endpoints.length
      ? `answers go to its own bridge on this machine (${endpoints.map((p) => BRIDGE_ADDR + p).join(' and ')}), then ~/.decklight/credentials.json (0600)`
      : 'answers stay on this machine: ~/.decklight/credentials.json (0600)',
  };
}

/** Which of a schema's fields are secrets — the only ones that get hidden. */
export const secretNames = (schema) =>
  new Set(schema.fields.filter((f) => f.type === 'secret').map((f) => f.name));

/**
 * Check answers against the schema before anything is stored.
 *
 * Returns `{ ok, errors }` rather than throwing: a presenter filling in a form
 * should see every field that needs attention at once, not the first one.
 */
export function checkAnswers(schema, answers) {
  const errors = [];
  const given = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {};
  for (const key of Object.keys(given)) {
    if (!schema.fields.some((f) => f.name === key)) errors.push(`${key}: not a field this engine asks for`);
  }
  for (const f of schema.fields) {
    const v = given[f.name];
    const missing = v === undefined || v === null || v === '';
    if (missing) {
      if (f.required) errors.push(`${f.label}: required`);
      continue;
    }
    if (f.type === 'boolean' ? typeof v !== 'boolean' : typeof v !== 'string') {
      errors.push(`${f.label}: expected ${f.type === 'boolean' ? 'true or false' : 'text'}`);
    } else if (f.type === 'choice' && !f.options.includes(v)) {
      errors.push(`${f.label}: not one of ${f.options.join(', ')}`);
    }
  }
  return { ok: !errors.length, errors };
}

/** Everything stored, or `{}` — a missing file is first run, not an error. */
export function loadCredentials(home = configHome()) {
  try { return JSON.parse(readFileSync(credentialsPath(home), 'utf8')); }
  catch { return {}; }
}

/**
 * Store one engine's answers, `0600`.
 *
 * The mode is set on every write, not only on create: a file that was
 * world-readable before this call must not stay world-readable after it, and
 * `writeFileSync`'s mode argument is ignored for a path that already exists.
 */
export function saveCredentials(engine, answers, home = configHome()) {
  const file = credentialsPath(home);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const all = loadCredentials(home);
  all[engine] = { ...answers };
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** Forget an engine's answers. Returns whether there was anything to forget. */
export function forgetCredentials(engine, home = configHome()) {
  if (!existsSync(credentialsPath(home))) return false;
  const all = loadCredentials(home);
  if (!(engine in all)) return false;
  delete all[engine];
  writeFileSync(credentialsPath(home), `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  chmodSync(credentialsPath(home), 0o600);
  return true;
}

/** The file's mode, for the test that this is actually `0600` on disk. */
export const credentialsMode = (home = configHome()) =>
  existsSync(credentialsPath(home)) ? statSync(credentialsPath(home)).mode & 0o777 : null;

/**
 * A stored answer set with every secret replaced by its shape, never its value.
 *
 * The one function anything that logs, prints, pings or reports must go
 * through. Redacting at each call site is how a key ends up in a debug panel
 * two features later, so there is exactly one place that decides.
 */
export function redactAnswers(schema, answers) {
  const secrets = secretNames(schema);
  const out = {};
  for (const [k, v] of Object.entries(answers ?? {})) {
    out[k] = secrets.has(k) ? (v ? `set (${String(v).length} chars)` : 'unset') : v;
  }
  return out;
}

/**
 * The two failures this flow is allowed to have, and they are not the same one.
 *
 * "Couldn't reach the marketplace" and "that key didn't authenticate" are
 * different problems with different fixes, and a wizard that prints one line for
 * both sends people to check their network when their key is wrong. `ENGINES#WIZARD`
 * names them separately on purpose, so the shape is a discriminated result
 * rather than a boolean.
 */
export const UNREACHABLE = 'unreachable';
export const REJECTED = 'rejected';
export const CONFIGURED = 'configured';
/**
 * The THIRD failure (ENGINES#LIPSYNC): the answers may be perfect and every
 * service reachable, and the engine still cannot run because something is not
 * on this machine. TTS made two states look like enough — "could not reach
 * it" and "that key was refused" — because a key is the only thing a TTS
 * provider ever needs. Lipsync has a binary, a python checkout and model
 * weights, and telling someone their rhubarb-shaped problem is a credential
 * problem sends them to fix the one thing that was already right.
 */
export const PREREQUISITE = 'prerequisite';

/**
 * Install-and-configure as one flow.
 *
 * `fetchSchema` and `validateAnswers` are injected: this module has no business
 * knowing how a catalog is read or how a provider checks a key, and the tests
 * have no business needing a network or a real key to exercise the branching.
 */
export async function configureEngine(engine, answers, {
  home = configHome(), fetchSchema, validateAnswers, save = saveCredentials, probes,
} = {}) {
  let schema;
  try {
    schema = validateSchema(await fetchSchema(engine));
  } catch (e) {
    if (e instanceof SchemaError) {
      // A malformed schema is the plugin's fault, not the network's, and must
      // not be reported as an outage the presenter could wait out.
      return { state: REJECTED, reason: `${engine} declares a wizard core cannot render: ${e.message}` };
    }
    return { state: UNREACHABLE, reason: `could not reach the marketplace for "${engine}": ${e.message}` };
  }

  // BEFORE the answers are checked, before the network is touched and before
  // anything is written: an engine that cannot run here must not have a
  // credential collected for it, and must not be told its key was the problem.
  const unmet = unmetRequirements(schema, probes);
  if (unmet.length) {
    return {
      state: PREREQUISITE,
      schema,
      unmet,
      reason: `${schema.title} needs something this machine does not have: ${unmet.map(requirementLine).join('; ')}`,
    };
  }

  const checked = checkAnswers(schema, answers);
  if (!checked.ok) return { state: REJECTED, schema, reason: checked.errors.join('; ') };

  if (schema.validate && validateAnswers) {
    let ok;
    try {
      ok = await validateAnswers(schema, answers);
    } catch (e) {
      return { state: UNREACHABLE, schema, reason: `could not reach ${schema.title} to check the answers: ${e.message}` };
    }
    if (!ok) return { state: REJECTED, schema, reason: `${schema.title} did not accept those answers` };
  }

  const file = save(engine, answers, home);
  return { state: CONFIGURED, schema, file, stored: redactAnswers(schema, answers) };
}
