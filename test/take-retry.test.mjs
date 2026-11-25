// The synthesized recorder's retry, time limit and done-card wording (#1253).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withTimeout, retrying, retryableTts, failureReason, slidesPhrase, notSavedLine, TTS_TIMEOUT_MS,
} from '../src/core/take-retry.js';

const httpError = (status, msg = String(status)) => Object.assign(new Error(msg), { status });
const noSleep = () => Promise.resolve();

test('a sentence that fails once is asked for again, and the take gets its clip', async () => {
  let asks = 0;
  const waits = [];
  const clip = await retrying(async () => {
    asks++;
    if (asks === 1) throw httpError(429, 'Quota exceeded');
    return 'clip';
  }, { sleep: async (ms) => { waits.push(ms); } });
  assert.equal(clip, 'clip');
  assert.equal(asks, 2);
  assert.deepEqual(waits, [1000], 'a short back-off before the second ask');
});

test('a sentence that fails every time is given up on after three tries, and says so', async () => {
  let asks = 0;
  await assert.rejects(
    retrying(async () => { asks++; throw httpError(503, 'busy'); }, { sleep: noSleep }),
    (e) => e.status === 503 && e.tries === 3,
  );
  assert.equal(asks, 3);
});

test('a request the engine refuses outright is not repeated', async () => {
  let asks = 0;
  await assert.rejects(
    retrying(async () => { asks++; throw httpError(400, 'unknown voice'); }, { sleep: noSleep }),
    (e) => e.tries === 1,
  );
  assert.equal(asks, 1);
});

test('a cancelled take stops retrying', async () => {
  let asks = 0;
  let cancelled = false;
  await assert.rejects(retrying(async () => { asks++; cancelled = true; throw httpError(500); },
    { sleep: noSleep, cancelled: () => cancelled }));
  assert.equal(asks, 1);
});

test('what is worth retrying: timeouts, dropped connections, 408, 429 and 5xx', () => {
  assert.ok(retryableTts(Object.assign(new Error('x'), { timedOut: true })));
  assert.ok(retryableTts(new TypeError('Failed to fetch')));
  for (const s of [408, 429, 500, 502, 503]) assert.ok(retryableTts(httpError(s)), String(s));
  for (const s of [400, 401, 403, 404, 422]) assert.ok(!retryableTts(httpError(s)), String(s));
});

test('a request that never answers fails after the time limit, and aborts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let aborted = false;
  const p = withTimeout(new Promise(() => {}), TTS_TIMEOUT_MS, () => { aborted = true; });
  t.mock.timers.tick(TTS_TIMEOUT_MS);
  await assert.rejects(p, (e) => e.timedOut === true && /60s/.test(e.message));
  assert.ok(aborted);
  assert.equal(TTS_TIMEOUT_MS, 60_000);
});

test('an answer in time passes straight through', async () => {
  assert.equal(await withTimeout(Promise.resolve('clip'), 1000), 'clip');
});

test('the reason names the engine and what went wrong', () => {
  assert.equal(failureReason(Object.assign(new Error('no answer in 60s'), { timedOut: true, tries: 3 }), 'ElevenLabs'),
    'ElevenLabs did not answer in 60s, after 3 tries');
  assert.equal(failureReason(Object.assign(httpError(429, 'Quota exceeded'), { tries: 3 }), 'ElevenLabs'),
    'ElevenLabs answered 429: Quota exceeded, after 3 tries');
  assert.equal(failureReason(httpError(500), 'mock'), 'mock answered 500');
  assert.equal(failureReason(Object.assign(new TypeError('Failed to fetch'), { tts: true, tries: 1 }), 'mock'),
    'the voice bridge could not be reached (Failed to fetch)');
  assert.equal(failureReason(new Error('the manifest could not be saved')), 'the manifest could not be saved');
});

test('the done card names the slides it did not save, with the first reason', () => {
  assert.equal(slidesPhrase([3]), 'slide 3');
  assert.equal(slidesPhrase([34, 33]), 'slides 33 and 34');
  assert.equal(slidesPhrase([1, 3, 4]), 'slides 1, 3 and 4');
  assert.equal(notSavedLine([]), '');
  assert.equal(notSavedLine([
    { slide: 33, reason: 'ElevenLabs did not answer in 60s' },
    { slide: 34, reason: 'ElevenLabs answered 500' },
  ]), 'slides 33 and 34 not saved: ElevenLabs did not answer in 60s');
});
