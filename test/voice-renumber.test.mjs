// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A voice folder follows its slides (#916): tools/voice-renumber.mjs, and the
// slide routes that carry it out, called as functions on a temp deck.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  slideOpRenumber, voiceFolders, planFolder, applyPlans, planMoves,
  realignMoves, realignSaid, movesRenumber,
} from '../tools/voice-renumber.mjs';
import { slideBeats, slideTexts, trackDrift } from '../tools/narration-manifest.mjs';
import { registerSlideRoutes } from '../cli/edit-slides.mjs';
import { createHistory } from '../cli/edit.mjs';
import { tmp } from './helpers.mjs';

/** A deck of slides whose notes are `words[i]`. */
const deckOf = (words) => `<!doctype html>
<html><body>
  <div class="decklight">
${words.map((w, i) => `    <section>
      <h2>S${i + 1}</h2>
      <aside class="notes">${w}</aside>
    </section>`).join('\n')}
  </div>
</body></html>
`;
const WORDS = Array.from({ length: 6 }, (_, i) => `Slide ${i + 1} says this.`);

/**
 * `voices/me` recorded for every slide of `html` in your own voice: a wav, a
 * beat, a script and a manifest entry with the beats as read.
 */
function recordAll(dir, html) {
  const me = path.join(dir, 'voices', 'me');
  mkdirSync(me, { recursive: true });
  const beats = slideBeats(html);
  const slides = beats.map((b, i) => {
    const nn = String(i + 1).padStart(2, '0');
    writeFileSync(path.join(me, `slide-${nn}.wav`), `take ${i + 1}`);
    writeFileSync(path.join(me, `slide-${nn}-01.wav`), `beat ${i + 1}`);
    writeFileSync(path.join(me, `slide-${nn}.txt`), b.join(' '));
    return { file: `slide-${nn}.wav`, segments: [{ file: `slide-${nn}-01.wav` }], beats: b };
  });
  writeFileSync(path.join(me, 'manifest.json'), JSON.stringify({ engine: null, model: null, voice: null, style: null, recorder: 'mic', slides }, null, 2) + '\n');
  return me;
}
const take = (me, n) => readFileSync(path.join(me, `slide-${String(n).padStart(2, '0')}.wav`), 'utf8');
const manifestOf = (me) => JSON.parse(readFileSync(path.join(me, 'manifest.json'), 'utf8'));

test('slideOpRenumber: where every slide goes, for each op', () => {
  const at = (f, n = 8) => Array.from({ length: n }, (_, i) => f(i + 1));
  assert.deepEqual(at(slideOpRenumber('new', 3)), [1, 2, 3, 5, 6, 7, 8, 9]);
  assert.deepEqual(at(slideOpRenumber('duplicate', 3)), [1, 2, 3, 5, 6, 7, 8, 9], 'the copy has no take; the original keeps its own');
  assert.deepEqual(at(slideOpRenumber('insert', 3)), [1, 2, 3, 5, 6, 7, 8, 9]);
  assert.deepEqual(at(slideOpRenumber('delete', 3)), [1, 2, null, 3, 4, 5, 6, 7]);
  assert.deepEqual(at(slideOpRenumber('up', 3)), [1, 3, 2, 4, 5, 6, 7, 8]);
  assert.deepEqual(at(slideOpRenumber('down', 3)), [1, 2, 4, 3, 5, 6, 7, 8]);
  assert.deepEqual(at(slideOpRenumber('move', 6, to(3))), [1, 2, 4, 5, 6, 3, 7, 8]);
  assert.deepEqual(at(slideOpRenumber('move', 2, to(5))), [1, 5, 2, 3, 4, 6, 7, 8]);
  function to(n) { return n; }
});

/** Plan and carry out one step on `voices/me`, and hand back its inverse. */
const run = (dir, step, opts) => {
  const plan = planFolder(dir, { dir: 'voices/me', ...step });
  assert.deepEqual(plan.conflicts, []);
  applyPlans(dir, [plan], opts);
  return plan.inverse;
};

test('an insert moves every later file and entry up one, in two phases, and its inverse step puts them back', (t) => {
  const dir = tmp('voice-renumber', t);
  const html = deckOf(WORDS);
  const me = recordAll(dir, html);
  const before = readFileSync(path.join(me, 'manifest.json'), 'utf8');
  const undo = run(dir, { op: 'new', slide: 3 });
  assert.equal(take(me, 3), 'take 3', 'before the insert, untouched');
  assert.equal(take(me, 5), 'take 4', 'slide-04 is slide-05 now — and slide-05 was not overwritten on the way');
  assert.equal(take(me, 7), 'take 6');
  assert.equal(existsSync(path.join(me, 'slide-04.wav')), false, 'the new slide has nothing recorded');
  assert.equal(readFileSync(path.join(me, 'slide-07-01.wav'), 'utf8'), 'beat 6', 'beats follow');
  assert.equal(readFileSync(path.join(me, 'slide-07.txt'), 'utf8'), 'Slide 6 says this.', 'the script follows');
  const m = manifestOf(me);
  assert.equal(m.slides.length, 7);
  assert.equal(m.slides[3], null, 'the new slide is null in the manifest');
  assert.equal(m.slides[4].file, 'slide-05.wav');
  assert.deepEqual(m.slides[4].segments, [{ file: 'slide-05-01.wav' }]);
  assert.deepEqual(m.slides[4].beats, ['Slide 4 says this.'], 'the words recorded stay with their take');
  assert.equal(m.recorder, 'mic', 'the header is kept');
  assert.equal(readdirSync(me).some((n) => n.startsWith('.renumber')), false, 'no temporary name is left behind');
  const after = deckOf([...WORDS.slice(0, 3), 'A new slide.', ...WORDS.slice(3)]);
  assert.deepEqual(trackDrift(m, after).drift, []);
  // undo, then redo
  const redo = run(dir, undo, { aside: true });
  assert.equal(take(me, 4), 'take 4');
  assert.equal(take(me, 6), 'take 6');
  assert.equal(existsSync(path.join(me, 'slide-07.wav')), false);
  assert.equal(readFileSync(path.join(me, 'manifest.json'), 'utf8'), before, 'the manifest exactly as it was');
  run(dir, redo, { aside: true });
  assert.equal(take(me, 5), 'take 4');
  assert.equal(manifestOf(me).slides[3], null);
});

test('a deleted slide\'s files go to the folder\'s .trash/ and its entry rides in the inverse; undo brings both back', (t) => {
  const dir = tmp('voice-renumber', t);
  const me = recordAll(dir, deckOf(WORDS));
  const was = readFileSync(path.join(me, 'manifest.json'), 'utf8');
  const undo = run(dir, { op: 'delete', slide: 2 });
  assert.equal(take(me, 2), 'take 3');
  const trash = readdirSync(path.join(me, '.trash'));
  assert.equal(trash.length, 1);
  assert.equal(readFileSync(path.join(me, '.trash', trash[0], 'slide-02.wav'), 'utf8'), 'take 2', 'kept, not deleted');
  assert.equal(manifestOf(me).slides.length, 5);
  const redo = run(dir, undo, { aside: true });
  assert.equal(take(me, 2), 'take 2');
  assert.equal(take(me, 3), 'take 3');
  assert.equal(readFileSync(path.join(me, 'manifest.json'), 'utf8'), was);
  assert.equal(existsSync(path.join(me, '.trash')), false, 'the emptied trash folder goes');
  run(dir, redo);
  assert.equal(take(me, 2), 'take 3', 'and redo deletes it again');
});

test('a take recorded between an op and its undo keeps its manifest entry, and redo brings it back (review of #916)', (t) => {
  const dir = tmp('voice-renumber', t);
  const me = recordAll(dir, deckOf(WORDS));
  const undo = run(dir, { op: 'new', slide: 1 });
  // the new slide 2 is recorded, and slide 1 is re-recorded
  writeFileSync(path.join(me, 'slide-02.wav'), 'fresh 2');
  writeFileSync(path.join(me, 'slide-01.wav'), 'retake 1');
  const m = manifestOf(me);
  m.slides[1] = { file: 'slide-02.wav', beats: ['Fresh.'] };
  m.slides[0] = { ...m.slides[0], beats: ['Retaken.'] };
  writeFileSync(path.join(me, 'manifest.json'), JSON.stringify(m));
  const redo = run(dir, undo, { aside: true });
  assert.equal(take(me, 1), 'retake 1');
  assert.deepEqual(manifestOf(me).slides[0].beats, ['Retaken.'], 'the retake\'s words, not the snapshot\'s');
  assert.equal(take(me, 2), 'take 2');
  run(dir, redo, { aside: true });
  assert.equal(take(me, 2), 'fresh 2', 'the take recorded on the inserted slide is back');
  assert.deepEqual(manifestOf(me).slides[1], { file: 'slide-02.wav', beats: ['Fresh.'] });
  assert.equal(take(me, 3), 'take 2');
});

test('a rename onto a file outside the plan is a conflict; set aside only when asked; a failed rename is rolled back', (t) => {
  const dir = tmp('voice-renumber', t);
  const me = recordAll(dir, deckOf(WORDS));
  writeFileSync(path.join(me, 'slide-003.wav'), 'odd');
  const plan = planFolder(dir, { dir: 'voices/me', op: 'new', slide: 2 });
  assert.ok(plan.conflicts.some((c) => /slide-04\.wav/.test(c)), plan.conflicts.join('; '));
  assert.throws(() => applyPlans(dir, [plan], { aside: true }), /two files would both become/);
  assert.equal(take(me, 3), 'take 3', 'a refused apply moves nothing');
  // a file that appeared at a target after planning: refused, or set aside when asked
  writeFileSync(path.join(me, 'slide-99.wav'), 'unrelated');
  const plan2 = planFolder(dir, { dir: 'voices/me', op: 'new', slide: 98 });
  assert.deepEqual(plan2.moves, [['slide-99.wav', 'slide-100.wav']]);
  writeFileSync(path.join(me, 'slide-100.wav'), 'new take');
  assert.throws(() => applyPlans(dir, [plan2]), /in the way/);
  const { setAside } = applyPlans(dir, [plan2], { aside: true });
  assert.equal(setAside.length, 1);
  assert.equal(readFileSync(path.join(dir, setAside[0]), 'utf8'), 'new take', 'kept, not overwritten');
  assert.equal(readFileSync(path.join(me, 'slide-100.wav'), 'utf8'), 'unrelated');
  // a rename that fails partway: a move whose target folder cannot be made
  const dir2 = tmp('voice-renumber', t);
  const me2 = recordAll(dir2, deckOf(WORDS));
  writeFileSync(path.join(me2, 'blocker'), 'a file, not a folder');
  const bad = { dir: 'voices/me', moves: [['slide-01.wav', 'slide-09.wav'], ['slide-02.wav', 'blocker/slide-02.wav']], before: null, after: null };
  assert.throws(() => applyPlans(dir2, [bad]));
  assert.equal(take(me2, 1), 'take 1', 'rolled back');
  assert.equal(take(me2, 2), 'take 2');
  assert.equal(readdirSync(me2).some((n) => n.startsWith('.renumber')), false);
});

test('voiceFolders: configured and discovered folders, and only the configured ones when another deck shares the folder', (t) => {
  const dir = tmp('voice-renumber', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, deckOf(WORDS));
  recordAll(dir, deckOf(WORDS));
  mkdirSync(path.join(dir, 'voices', 'empty'), { recursive: true });
  mkdirSync(path.join(dir, 'narr'), { recursive: true });
  writeFileSync(path.join(dir, 'narr', 'slide-01.mp3'), 'x');
  // not tracks: screenshots named by slide, and another deck's own folder
  mkdirSync(path.join(dir, 'img'), { recursive: true });
  writeFileSync(path.join(dir, 'img', 'slide-03.png'), 'png');
  mkdirSync(path.join(dir, 'archive', 'narration'), { recursive: true });
  writeFileSync(path.join(dir, 'archive', 'old.html'), '<div class="decklight"></div>');
  writeFileSync(path.join(dir, 'archive', 'narration', 'slide-01.wav'), 'x');
  writeFileSync(path.join(dir, 'archive', 'slide-01.wav'), 'x');
  assert.deepEqual(voiceFolders(deck), ['narr', 'voices/me']);
  assert.deepEqual(voiceFolders(deck, ['../elsewhere']), ['narr', 'voices/me'], 'nothing outside the deck\'s folder');
  writeFileSync(path.join(dir, 'other.html'), '<div class="decklight"></div>');
  assert.deepEqual(voiceFolders(deck), []);
  assert.deepEqual(voiceFolders(deck, ['voices/me/']), ['voices/me']);
});

test('realignMoves: a slide inserted by hand reads as the later recordings shifted by one, and a real edit stays flagged', () => {
  const html = deckOf(WORDS);
  const beats = slideBeats(html);
  const manifest = { recorder: 'mic', slides: beats.map((b, i) => ({ file: `slide-0${i + 1}.wav`, beats: b })) };
  // slide 2's words edited, then a slide pasted in at 4, by an editor
  const words = [...WORDS];
  words[1] = 'Slide 2 says something else now.';
  words[4] = 'Slide 5 was rewritten too.';
  const now = deckOf([...words.slice(0, 3), 'Pasted in.', ...words.slice(3)]);
  const { moves, said } = realignMoves(manifest, now);
  assert.deepEqual(moves, [[4, 5], [5, 6], [6, 7]], 'slide 5\'s take follows its neighbours though its words changed');
  assert.equal(said, '3 recordings look shifted by one from slide 4');
  // applied, only the two real edits are out of step
  const shifted = { ...manifest, slides: [] };
  manifest.slides.forEach((e, i) => { shifted.slides[movesRenumber(moves)(i + 1) - 1] = e; });
  shifted.slides = Array.from(shifted.slides, (e) => e ?? null);
  assert.deepEqual(trackDrift(shifted, now).drift.map((d) => d.slide), [2, 6]);
  // in step already: nothing to offer
  assert.deepEqual(realignMoves(manifest, html).moves, []);
});

test('realignMoves: a slide deleted by hand sets its take aside and moves the rest down; an edited last slide still follows (review of #916)', () => {
  const html = deckOf(WORDS);
  const manifest = { recorder: 'mic', slides: slideBeats(html).map((b, i) => ({ file: `slide-0${i + 1}.wav`, beats: b })) };
  const gone = deckOf([...WORDS.slice(0, 2), ...WORDS.slice(3)]);
  const del = realignMoves(manifest, gone);
  assert.deepEqual(del.moves, [[3, null], [4, 3], [5, 4], [6, 5]]);
  assert.equal(del.said, '3 recordings look shifted by one from slide 4 (slide 3\'s set aside: its slide is gone)');
  const words = [...WORDS];
  words[5] = 'The last one, rewritten.';
  const ins = realignMoves(manifest, deckOf([...words.slice(0, 2), 'Pasted.', ...words.slice(2)]));
  assert.deepEqual(ins.moves, [[3, 4], [4, 5], [5, 6], [6, 7]]);
});

test('realign carried out: the set-aside take goes to .trash/ and its inverse brings it back', (t) => {
  const dir = tmp('voice-renumber', t);
  const html = deckOf(WORDS);
  const me = recordAll(dir, html);
  const was = readFileSync(path.join(me, 'manifest.json'), 'utf8');
  const { moves } = realignMoves(manifestOf(me), deckOf([...WORDS.slice(0, 2), ...WORDS.slice(3)]));
  const undo = run(dir, { pairs: moves });
  assert.equal(take(me, 3), 'take 4');
  assert.equal(existsSync(path.join(me, 'slide-06.wav')), false);
  assert.deepEqual(trackDrift(manifestOf(me), deckOf([...WORDS.slice(0, 2), ...WORDS.slice(3)])).drift, []);
  run(dir, undo, { aside: true });
  assert.equal(take(me, 3), 'take 3');
  assert.equal(readFileSync(path.join(me, 'manifest.json'), 'utf8'), was);
});

test('realignMoves: a hashed track is placed by its hash, a swap is found, and an entry with no record never moves', async () => {
  const { manifestHash } = await import('../tools/narration-manifest.mjs');
  const header = { engine: 'say', model: 'Samantha', voice: 'Samantha', style: '' };
  const texts = slideTexts(deckOf(WORDS));
  const manifest = { ...header, slides: texts.map((x, i) => ({ file: `slide-0${i + 1}.wav`, hash: manifestHash(header, x) })) };
  manifest.slides[5] = { file: 'slide-06.wav' };   // recorded by hand: unknown
  const swapped = [...WORDS];
  [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
  assert.deepEqual(realignMoves(manifest, deckOf(swapped)).moves, [[2, 3], [3, 2]]);
  assert.equal(realignSaid([[2, 3], [3, 2]]), '2 recordings look out of place, from slide 2');
});

// ── the slide routes carry it out ───────────────────────────────────────────

function harness(t, html) {
  const dir = tmp('voice-renumber', t);
  const deck = path.join(dir, 'talk.html');
  writeFileSync(deck, html);
  const history = createHistory();
  const readDeck = () => readFileSync(deck, 'utf8');
  const applyEdit = (change, before = readDeck(), also = null) => {
    const next = typeof change === 'function' ? change(before) : change;
    if (next === before) return false;
    history.record(also ? { deck: before, ...also } : before);
    writeFileSync(deck, next);
    return true;
  };
  const routes = new Map();
  registerSlideRoutes(routes, { readDeck, applyEdit, history, deckPath: deck });
  /** Z, the way the server takes it: the steps planned against the folders now, then the deck. */
  const undo = () => {
    let plans = null;
    const entry = history.undo((e) => {
      if (typeof e === 'string') return readDeck();
      plans = e.voices.map((s) => planFolder(dir, s));
      return { deck: readDeck(), voices: plans.map((p) => p.inverse) };
    });
    if (plans) applyPlans(dir, plans.filter(planMoves), { aside: true });
    writeFileSync(deck, typeof entry === 'string' ? entry : entry.deck);
  };
  return { routes, history, readDeck, deck, dir, undo };
}
async function slideOp(routes, body) {
  const sent = {};
  await routes.get('POST /deck/edit/slide')({ body: JSON.stringify(body), json: (code, obj) => { sent.code = code; sent.body = obj; } });
  return sent;
}

test('POST /deck/edit/slide: new, delete and move carry the recordings with their slides, and one Z puts deck and folder back', async (t) => {
  const html = deckOf(WORDS);
  const { routes, readDeck, dir, undo, history } = harness(t, html);
  const me = recordAll(dir, html);
  const was = readFileSync(path.join(me, 'manifest.json'), 'utf8');

  let r = await slideOp(routes, { op: 'new', slide: 3 });
  assert.equal(r.code, 200);
  assert.equal(history.counts().undo, 1, 'deck and folder are one undo entry');
  assert.equal(take(me, 5), 'take 4');
  assert.deepEqual(trackDrift(manifestOf(me), readDeck()).drift, [], 'nothing reads as out of step');
  undo();
  assert.equal(readDeck(), html);
  assert.equal(take(me, 4), 'take 4');
  assert.equal(readFileSync(path.join(me, 'manifest.json'), 'utf8'), was);

  r = await slideOp(routes, { op: 'move', slide: 6, to: 2 });
  assert.equal(r.code, 200);
  assert.equal(take(me, 2), 'take 6');
  assert.equal(take(me, 3), 'take 2');
  assert.deepEqual(trackDrift(manifestOf(me), readDeck()).drift, []);
  undo();

  r = await slideOp(routes, { op: 'delete', slide: 1 });
  assert.equal(r.code, 200);
  assert.equal(take(me, 1), 'take 2');
  assert.deepEqual(trackDrift(manifestOf(me), readDeck()).drift, []);
  undo();
  assert.equal(take(me, 1), 'take 1');
  assert.equal(readFileSync(path.join(me, 'manifest.json'), 'utf8'), was);

  r = await slideOp(routes, { op: 'duplicate', slide: 2 });
  assert.equal(take(me, 2), 'take 2', 'the original keeps its take');
  assert.equal(existsSync(path.join(me, 'slide-03.wav')), false, 'the copy has none of its own');
  assert.equal(manifestOf(me).slides[2], null);
});

test('POST /deck/edit/slide refuses, and changes nothing, when a recording cannot follow', async (t) => {
  const html = deckOf(WORDS);
  const { routes, readDeck, dir } = harness(t, html);
  const me = recordAll(dir, html);
  writeFileSync(path.join(me, 'slide-003.wav'), 'odd');
  const r = await slideOp(routes, { op: 'new', slide: 2 });
  assert.equal(r.code, 409);
  assert.match(r.body.error, /voices\/me\/.*nothing was changed/);
  assert.equal(readDeck(), html);
  assert.equal(take(me, 3), 'take 3');
});
