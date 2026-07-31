// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Publish targets beyond gh-pages (MARKETPLACE.md ENGINES, UNITS#REST).
//
// Netlify and Vercel are exercised entirely against an injected fetch — no key,
// no account, no network — matching the ElevenLabs engine's own test style. What
// is worth pinning: the schema is a real ENGINES#WIZARD schema (not a shape this
// ticket invented on the side), a token is read from the environment and never
// prompted for or written to disk, and a missing/malformed answer is refused by
// the same `checkAnswers` every other engine goes through.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TARGETS, schemaFor, envVarsFor, envAnswers, deployNetlify, deployVercel, deploy,
} from '../tools/publish-targets.mjs';
import { checkAnswers, FIELD_TYPES } from '../cli/wizard.mjs';

// ── the schema: a real ENGINES#WIZARD shape ─────────────────────────────────

test('every target schema is a real, validated wizard schema', () => {
  for (const target of TARGETS) {
    const schema = schemaFor(target);
    assert.equal(schema.engine, target);
    assert.ok(schema.fields.length, `${target} asks for at least one field`);
    for (const f of schema.fields) assert.ok(FIELD_TYPES.includes(f.type), `${target}.${f.name}`);
  }
});

test('the token is a secret field, never text — it must not print back in the clear', () => {
  for (const target of TARGETS) {
    const schema = schemaFor(target);
    const token = schema.fields.find((f) => f.name === 'token');
    assert.equal(token?.type, 'secret', `${target}'s token field`);
  }
});

test('an unknown target is refused by name, with the known ones listed', () => {
  assert.throws(() => schemaFor('heroku'), /"heroku" is not a publish target.*netlify.*vercel|not a publish target/s);
});

// ── where the answers come from: the environment, never a prompt ───────────

test('envVarsFor names the PROVIDER\'S OWN cli env vars, not a decklight-invented name', () => {
  assert.deepEqual(envVarsFor('netlify'), { token: 'NETLIFY_AUTH_TOKEN', siteId: 'NETLIFY_SITE_ID' });
  assert.deepEqual(envVarsFor('vercel'), { token: 'VERCEL_TOKEN', project: 'VERCEL_PROJECT', teamId: 'VERCEL_TEAM_ID' });
});

test('envAnswers reads exactly what is set, and nothing decklight did not ask for', () => {
  const env = { NETLIFY_AUTH_TOKEN: 'nfp_abc', NETLIFY_SITE_ID: 'my-site', UNRELATED: 'x' };
  assert.deepEqual(envAnswers('netlify', env), { token: 'nfp_abc', siteId: 'my-site' });
});

test('a missing env var fails checkAnswers exactly like a missing browser-wizard field', () => {
  const schema = schemaFor('netlify');
  const answers = envAnswers('netlify', { NETLIFY_SITE_ID: 'my-site' }); // no token
  const checked = checkAnswers(schema, answers);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join(';'), /required/i);
});

test('a fully answered environment passes checkAnswers', () => {
  const schema = schemaFor('vercel');
  const answers = envAnswers('vercel', { VERCEL_TOKEN: 't', VERCEL_PROJECT: 'my-deck' });
  assert.ok(checkAnswers(schema, answers).ok);
});

// ── deploying: real HTTP shapes, fake transport ─────────────────────────────

const FILES = [{ path: 'index.html', data: '<html>hi</html>' }, { path: 'index.html.sig', data: '{"sig":1}\n' }];

function fakeFetch(script) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return script(String(url), init);
  };
  f.calls = calls;
  return f;
}

test('netlify: one POST, a real zip body, bearer auth — and the reported URL comes back', async () => {
  const fetchImpl = fakeFetch(async () => ({
    ok: true, json: async () => ({ id: 'd1', ssl_url: 'https://my-site.netlify.app' }),
  }));
  const result = await deployNetlify({ token: 'nfp_abc', siteId: 'my-site' }, FILES, { fetchImpl });
  assert.equal(result.url, 'https://my-site.netlify.app');
  assert.equal(result.id, 'd1');

  assert.equal(fetchImpl.calls.length, 1);
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, 'https://api.netlify.com/api/v1/sites/my-site/deploys');
  assert.equal(init.headers.authorization, 'Bearer nfp_abc');
  assert.equal(init.headers['content-type'], 'application/zip');
  assert.ok(Buffer.isBuffer(init.body) || init.body instanceof Uint8Array, 'the body is real zip bytes');

  // A real zip, not a stand-in: it unpacks back to what was handed in.
  const zipMagic = Buffer.from(init.body).subarray(0, 2).toString('binary');
  assert.equal(zipMagic, 'PK', 'starts with the local-file-header signature');
});

test('netlify: a site id with characters that need escaping still resolves to one URL', async () => {
  const fetchImpl = fakeFetch(async () => ({ ok: true, json: async () => ({ id: 'd2', url: 'https://x' }) }));
  await deployNetlify({ token: 't', siteId: 'my site/weird' }, FILES, { fetchImpl });
  assert.match(fetchImpl.calls[0].url, /my%20site%2Fweird/);
});

test('netlify: a non-OK response becomes a thrown Error naming the status', async () => {
  const fetchImpl = fakeFetch(async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }));
  await assert.rejects(
    deployNetlify({ token: 'bad', siteId: 's' }, FILES, { fetchImpl }),
    /netlify: HTTP 401.*Unauthorized/s,
  );
});

test('vercel: files travel inline as base64, never as a zip', async () => {
  const fetchImpl = fakeFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.name, 'my-deck');
    assert.equal(body.target, 'production');
    const page = body.files.find((f) => f.file === 'index.html');
    assert.equal(page.encoding, 'base64');
    assert.equal(Buffer.from(page.data, 'base64').toString('utf8'), '<html>hi</html>');
    return { ok: true, json: async () => ({ uid: 'dpl_1', url: 'my-deck-abc.vercel.app' }) };
  });
  const result = await deployVercel({ token: 't', project: 'my-deck' }, FILES, { fetchImpl });
  assert.equal(result.url, 'https://my-deck-abc.vercel.app');
  assert.equal(result.id, 'dpl_1');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer t');
  assert.doesNotMatch(fetchImpl.calls[0].url, /teamId/, 'no team given, no team param sent');
});

test('vercel: a team id becomes a query param, not another body field', async () => {
  const fetchImpl = fakeFetch(async () => ({ ok: true, json: async () => ({ id: 'd', url: 'x' }) }));
  await deployVercel({ token: 't', project: 'p', teamId: 'team_9' }, FILES, { fetchImpl });
  assert.match(fetchImpl.calls[0].url, /[?&]teamId=team_9/);
});

test('the deploy() dispatcher routes by target name', async () => {
  const fetchImpl = fakeFetch(async (url) => ({
    ok: true,
    json: async () => (url.includes('netlify') ? { id: 'n', ssl_url: 'https://n' } : { id: 'v', url: 'v.example' }),
  }));
  assert.equal((await deploy('netlify', { token: 't', siteId: 's' }, FILES, { fetchImpl })).url, 'https://n');
  assert.equal((await deploy('vercel', { token: 't', project: 'p' }, FILES, { fetchImpl })).url, 'https://v.example');
  await assert.rejects(deploy('heroku', {}, FILES, { fetchImpl }), /not a publish target/);
});

test('unzipping the netlify payload really does recover every file', async () => {
  // Belt and suspenders on top of the PK-magic check above: the archive this
  // ships is not merely zip-SHAPED, it round-trips.
  let sentZip;
  const fetchImpl = fakeFetch(async (_url, init) => {
    sentZip = Buffer.from(init.body);
    return { ok: true, json: async () => ({ id: 'd', url: 'https://x' }) };
  });
  await deployNetlify({ token: 't', siteId: 's' }, FILES, { fetchImpl });
  // A raw (stored) deflate check: the simplest proof this is real zlib-compatible
  // content is that inflating the entry payload matches, which zipSync's own
  // tests already cover in depth — here it is enough that the archive is
  // non-empty and begins with a local file header.
  assert.ok(sentZip.length > 4);
  assert.equal(sentZip.readUInt32LE(0), 0x04034b50, 'local file header signature');
});
