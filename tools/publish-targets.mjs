// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Publish targets beyond gh-pages (MARKETPLACE.md ENGINES, UNITS#REST).
 *
 * gh-pages stays core because it needs git auth and no credential — cli/publish.mjs
 * talks to it directly, as it always has. Netlify and Vercel need a token, so they
 * follow the ENGINES rule: *anything on the authoring path that needs a credential
 * becomes a marketplace engine behind a core affordance.* The affordance here is
 * `decklight publish --target <name>`; the schema each target declares is validated
 * by cli/wizard.mjs's `validateSchema` — the exact closed vocabulary ENGINES#WIZARD
 * built for TTS and lipsync — which is what proves the framework generalizes to a
 * third domain rather than one this ticket invented in parallel.
 *
 * WHERE THE TOKEN COMES FROM. Not a terminal prompt, and not the browser wizard.
 * `decklight publish` is a one-shot, often-headless command (CI has no browser to
 * paste a key into, and no /edit/wizard to post it to — that endpoint is served by
 * the AUTHOR server, which publish never starts). The existing precedent for
 * exactly this shape is ElevenLabs' own key (tools/elevenlabs-tts.mjs): read from
 * the environment, never written to disk, "not boring enough" for a config file.
 * Each target's env var NAMES its provider's own CLI convention on purpose
 * (NETLIFY_AUTH_TOKEN, VERCEL_TOKEN) — anyone who already deploys with that CLI in
 * CI has nothing new to configure. Values are still run through the schema's own
 * `checkAnswers` before anything is sent, so a missing token is refused by the same
 * validation the browser wizard would have applied, not a bespoke arg check.
 *
 * S3 is deliberately not here yet. It is the one target that needs request signing
 * (SigV4) rather than a bearer token, and a hand-rolled signer that nobody can
 * exercise against a real bucket in this environment is a correctness claim this
 * file is not in a position to back. Netlify and Vercel prove the shape generalizes
 * — S3 is a fast follow once someone can verify a signed request lands.
 */

import { zipSync } from '../cli/zip.mjs';
import { validateSchema } from '../cli/wizard.mjs';

export const TARGETS = ['netlify', 'vercel'];

// Raw schemas, in the ENGINES#WIZARD shape (cli/wizard.mjs FIELD_TYPES) — the same
// vocabulary a marketplace-declared engine is limited to, so a hand-authored schema
// here is provably no more expressive than one a plugin could have sent.
const RAW_SCHEMAS = {
  netlify: {
    engine: 'netlify',
    title: 'Netlify',
    fields: [
      { name: 'token', label: 'Personal access token', type: 'secret', required: true },
      { name: 'siteId', label: 'Site ID (Site settings → General → Site details)', type: 'text', required: true },
    ],
  },
  vercel: {
    engine: 'vercel',
    title: 'Vercel',
    fields: [
      { name: 'token', label: 'Access token', type: 'secret', required: true },
      { name: 'project', label: 'Project name', type: 'text', required: true },
      { name: 'teamId', label: 'Team ID', type: 'text' },
    ],
  },
};

/** Which environment variable answers each field — the provider's OWN CLI names. */
const ENV_VARS = {
  netlify: { token: 'NETLIFY_AUTH_TOKEN', siteId: 'NETLIFY_SITE_ID' },
  vercel: { token: 'VERCEL_TOKEN', project: 'VERCEL_PROJECT', teamId: 'VERCEL_TEAM_ID' },
};

const known = (target) => {
  if (!TARGETS.includes(target)) {
    throw new Error(`"${target}" is not a publish target this decklight knows — try: ${TARGETS.join(', ')} (or omit --target for gh-pages)`);
  }
};

/** The normalized wizard schema for a target — validated, same as any engine's. */
export function schemaFor(target) {
  known(target);
  return validateSchema(RAW_SCHEMAS[target]);
}

/** field name → the env var it reads, for error messages that name something real. */
export function envVarsFor(target) {
  known(target);
  return ENV_VARS[target];
}

/** Assemble a target's answers from the environment. Missing vars become `undefined` — checkAnswers names them. */
export function envAnswers(target, env = process.env) {
  const vars = envVarsFor(target);
  const out = {};
  for (const [field, name] of Object.entries(vars)) if (env[name]) out[field] = env[name];
  return out;
}

const safeText = async (r) => { try { return (await r.text()).slice(0, 300); } catch { return ''; } };

/**
 * Netlify: a single zip deploy. One POST, no digest/required-files dance — the
 * container plumbing already exists (cli/zip.mjs, from `skills --pack`), and a
 * deck's published output is small enough that a whole-zip deploy costs nothing
 * a partial one would have saved.
 */
export async function deployNetlify({ token, siteId }, files, { fetchImpl = fetch } = {}) {
  const zip = zipSync(files.map(({ path, data }) => ({ name: path, data })));
  const r = await fetchImpl(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(siteId)}/deploys`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip' },
    body: zip,
  });
  if (!r.ok) throw new Error(`netlify: HTTP ${r.status} — ${await safeText(r)}`);
  const j = await r.json();
  return { url: j.ssl_url ?? j.deploy_ssl_url ?? j.url ?? null, id: j.id ?? null };
}

/** Vercel: files inline as base64 in one JSON POST — no zip, per their own API shape. */
export async function deployVercel({ token, project, teamId }, files, { fetchImpl = fetch } = {}) {
  const body = {
    name: project,
    target: 'production',
    files: files.map(({ path, data }) => ({
      file: path,
      data: (Buffer.isBuffer(data) ? data : Buffer.from(String(data))).toString('base64'),
      encoding: 'base64',
    })),
  };
  const url = `https://api.vercel.com/v13/deployments${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''}`;
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`vercel: HTTP ${r.status} — ${await safeText(r)}`);
  const j = await r.json();
  return { url: j.url ? `https://${j.url}` : null, id: j.id ?? j.uid ?? null };
}

const DEPLOYERS = { netlify: deployNetlify, vercel: deployVercel };

/** `files` is `[{ path, data: Buffer|string }]` — the same set gh-pages commits. */
export async function deploy(target, answers, files, opts = {}) {
  known(target);
  return DEPLOYERS[target](answers, files, opts);
}
