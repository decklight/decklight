// tools/veo.mjs — the Veo client, with fetch and the token stubbed, so the
// suite never touches Vertex and never spends a cent. What matters here is the
// contract that keeps it cheap and honest: audio OFF, one call per portrait,
// and a refusal reported as a refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVeo, VEO_MODELS, VEO_SECONDS } from '../tools/veo.mjs';

const MP4 = Buffer.from('fake mp4 bytes');

/** a Vertex that answers: start → operation, poll → done, with one video */
function stubVertex({ video = MP4, response } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const json = url.endsWith(':predictLongRunning')
      ? { name: 'operations/1' }
      : { done: true, response: response ?? { videos: [{ bytesBase64Encoded: video.toString('base64') }] } };
    return { json: async () => json };
  };
  return { fetch, calls };
}

// the crop/scale pass, without ffmpeg: the suite must run on a bare machine
const stubFfmpeg = async (_bin, args) => {
  const i = args.indexOf('-i');
  copyFileSync(args[i + 1], args[args.length - 1]);
  return { stdout: '', stderr: '' };
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'veo-test-'));
  const portrait = join(dir, 'face.jpg');
  writeFileSync(portrait, 'JPEGDATA');
  return { dir, portrait, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('asks Vertex for video with NO audio — the deck owns the voice, and it is cheaper', async () => {
  const { dir, portrait, cleanup } = fixture();
  const { fetch, calls } = stubVertex();
  try {
    const veo = createVeo({ project: 'p', cacheDir: dir, token: () => 't', fetch, exec: stubFfmpeg, pollMs: 1 });
    await veo.motionFor(portrait);
    const params = calls[0].body.parameters;
    assert.equal(params.generateAudio, false);
    assert.equal(params.durationSeconds, 8);
    assert.equal(params.personGeneration, 'allow_adult');
    assert.ok(calls[0].url.includes(VEO_MODELS[0]), 'defaults to the cheapest model');
    assert.ok(calls[0].body.instances[0].image.bytesBase64Encoded, 'image-to-video, not text-to-video');
  } finally { cleanup(); }
});

test('one portrait costs ONE call, however many sentences ask for it', async () => {
  const { dir, portrait, cleanup } = fixture();
  const { fetch, calls } = stubVertex();
  try {
    const veo = createVeo({ project: 'p', cacheDir: dir, token: () => 't', fetch, exec: stubFfmpeg, pollMs: 1 });
    // a burst, as the 10-sentence lookahead would issue it, then a later miss
    const [a, b, c] = await Promise.all([veo.motionFor(portrait), veo.motionFor(portrait), veo.motionFor(portrait)]);
    const d = await veo.motionFor(portrait);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(c, d);
    const starts = calls.filter((k) => k.url.endsWith(':predictLongRunning'));
    assert.equal(starts.length, 1, 'concurrent asks dedup, and the clip is then cached on disk');
  } finally { cleanup(); }
});

test('a cached clip survives a new client — a restart must not re-buy the motion', async () => {
  const { dir, portrait, cleanup } = fixture();
  try {
    const first = stubVertex();
    const out = await createVeo({ project: 'p', cacheDir: dir, token: () => 't', fetch: first.fetch, exec: stubFfmpeg, pollMs: 1 })
      .motionFor(portrait);
    const second = stubVertex();
    const again = await createVeo({ project: 'p', cacheDir: dir, token: () => 't', fetch: second.fetch, exec: stubFfmpeg, pollMs: 1 })
      .motionFor(portrait);
    assert.equal(again, out);
    assert.equal(second.calls.length, 0, 'the second bridge spent nothing');
  } finally { cleanup(); }
});

test('a safety refusal comes back as done-with-no-video — say so, do not write an empty file', async () => {
  const { dir, portrait, cleanup } = fixture();
  const { fetch } = stubVertex({ response: { videos: [], raiMediaFilteredReasons: ['Person/Face generation'] } });
  try {
    const veo = createVeo({ project: 'p', cacheDir: dir, token: () => 't', fetch, exec: stubFfmpeg, pollMs: 1 });
    await assert.rejects(() => veo.motionFor(portrait), /refused this portrait/);
  } finally { cleanup(); }
});

test('rejects a duration the API does not offer, at config time', () => {
  assert.throws(() => createVeo({ project: 'p', seconds: 5 }), /4, 6, 8/);
  assert.deepEqual(VEO_SECONDS, [4, 6, 8]);
});

test('needs a project — an unbilled call is not a call', () => {
  assert.throws(() => createVeo({ project: '' }), /needs a GCP project/);
});
