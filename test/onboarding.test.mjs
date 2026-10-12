// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The onboarding rules that are decisions rather than DOM (SPEC PRESENTING):
// which of the two teaching surfaces a load spends itself on, and what the
// browser remembers afterwards. The card and the toast themselves are pinned
// headlessly in demo/smoke.html + test/render.mjs — this covers the part that
// is pure bookkeeping, where the failures are silent: a tip repeating, a
// "tips off" that forgets, a card over a talk already in progress.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOnboarding } from '../src/core/onboarding.js';

/** A localStorage that behaves, and one that throws like `file://` does. */
function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}
const hostileStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('SecurityError'); },
};

/**
 * The smallest environment the module actually touches: an element factory, a
 * root to append to, and the deck's event hookup. Everything it builds is a
 * plain object, so an assertion can look at what was mounted.
 */
function harness({ storage = memoryStorage(), search = '', print = false } = {}) {
  const mounted = [];
  const el = () => ({
    className: '', innerHTML: '', children: mounted,
    addEventListener() {}, remove() { mounted.splice(mounted.indexOf(this), 1); },
  });
  globalThis.localStorage = storage;
  globalThis.document = { createElement: el };
  const toasts = [];
  const events = [];
  const onboarding = createOnboarding({
    root: { appendChild: (n) => mounted.push(n) },
    printMode: print,
    params: new URLSearchParams(search),
    toast: (msg) => toasts.push(msg),
    debugLog: () => {},
    overlays: { register: () => {} },
    deck: () => ({ on: (type) => events.push(type) }),
  });
  return { onboarding, mounted, toasts, storage, events };
}

const FIRST_RUN = { slide: 1, step: 0 };
const isCard = (n) => n.className === 'decklight-welcome';

test('a first run spends itself on the welcome card, and nothing else', () => {
  const { onboarding, mounted, toasts } = harness();
  onboarding.start(FIRST_RUN);
  assert.equal(mounted.filter(isCard).length, 1);
  assert.deepEqual(toasts, [], 'the card is the whole of it');
});

test('once the card is dismissed it never auto-shows again — in any deck', () => {
  const storage = memoryStorage();
  const first = harness({ storage });
  first.onboarding.start(FIRST_RUN);
  first.onboarding.dismissWelcome();
  assert.equal(storage.getItem('decklight-onboarded'), '1');

  // a DIFFERENT deck, same browser: the flag is global, so no second welcome
  const second = harness({ storage });
  second.onboarding.start(FIRST_RUN);
  assert.equal(second.mounted.filter(isCard).length, 0);
});

test('after the welcome a load teaches nothing: the tip rotation is gone', () => {
  // Twelve one-line tips used to follow the welcome, one per load. The
  // palette answers "how do I…" for whoever types the word, and ? lists every
  // key; a tip a load taught what both already say.
  const storage = memoryStorage({ 'decklight-onboarded': '1' });
  for (let i = 0; i < 3; i++) {
    const { onboarding, toasts, mounted } = harness({ storage });
    onboarding.start(FIRST_RUN);
    assert.deepEqual(toasts, [], `load ${i + 1} taught something`);
    assert.equal(mounted.length, 0);
  }
  const { onboarding } = harness({ storage });
  for (const gone of ['showTip', 'setTips', 'resetTips', 'status']) assert.equal(onboarding[gone], undefined, `${gone} is back`);
});

test('nothing teaches over a talk: print, embedded, and a deep link past slide 1', () => {
  for (const [what, opts, target] of [
    ['print', { print: true }, FIRST_RUN],
    ['embedded', { search: '?embedded' }, FIRST_RUN],
    ['a deep link into the middle', {}, { slide: 12, step: 0 }],
    ['a deep link into a build', {}, { slide: 1, step: 2 }],
  ]) {
    const { onboarding, mounted, toasts } = harness(opts);
    onboarding.start(target);
    assert.equal(mounted.filter(isCard).length, 0, `${what}: welcome card shown`);
    assert.deepEqual(toasts, [], `${what}: something was taught`);
  }
});

test('the deck still plays where localStorage throws — it just forgets', () => {
  const { onboarding, mounted, toasts } = harness({ storage: hostileStorage });
  onboarding.start(FIRST_RUN);                 // reads throw → treated as unseen
  assert.equal(mounted.filter(isCard).length, 1);
  onboarding.dismissWelcome();                 // the write throws, and is swallowed
  assert.equal(mounted.filter(isCard).length, 0);
  assert.deepEqual(toasts, []);
});

test('the advance hooks are armed on every playing load, so no card outlives the first move', () => {
  const { onboarding, events } = harness();
  onboarding.start({ slide: 9, step: 0 });   // even when this load shows nothing
  assert.deepEqual(events, ['slide', 'build']);
});
