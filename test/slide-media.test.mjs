// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// A slide's own videos and sounds (src/core/slide-media.js, SPEC DECK_ANATOMY):
// what the engine asks of each clip as slides come and go. The clips are duck
// typed; the engine harness's `videoslide` mode drives the same thing in Chrome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSlideMedia, slideMedia } from '../src/core/slide-media.js';

function clip(attrs = {}, { background = false } = {}) {
  const m = {
    attrs: { ...attrs }, paused: true, currentTime: 0, preload: 'metadata', plays: 0, sec: null,
    hasAttribute: (k) => k in m.attrs,
    removeAttribute: (k) => { delete m.attrs[k]; },
    matches: () => true,
    closest: (sel) => (sel === '.slide-bg' ? (background ? {} : null) : sel === 'section' ? m.sec : null),
    play() { m.paused = false; m.plays += 1; return Promise.resolve(); },
    pause() { m.paused = true; },
  };
  return m;
}
function slide(...clips) {
  const sec = { clips, querySelectorAll: () => clips, contains: (m) => clips.includes(m) };
  for (const c of clips) c.sec = sec;
  return sec;
}
function deck(sections, { live = true } = {}) {
  let at = 0;
  const listeners = [];
  const root = { addEventListener: (type, fn) => listeners.push([type, fn]) };
  const media = createSlideMedia({ root, sections: () => sections, current: () => sections[at], live });
  return {
    media,
    go(i) { at = i; media.sync(); },
    started(m) { m.paused = false; for (const [type, fn] of listeners) if (type === 'play') fn({ target: m }); },
  };
}

test('a background clip is not the slide’s own: the background layer drives it', () => {
  const own = clip();
  const bg = clip({}, { background: true });
  assert.deepEqual(slideMedia(slide(own, bg)), [own]);
});

test('autoplay is taken off at boot and becomes play-on-arrival: nothing plays from load off its slide', () => {
  const later = clip({ autoplay: '', muted: '' });
  const d = deck([slide(), slide(later)]);
  d.go(0);
  assert.equal(later.hasAttribute('autoplay'), false, 'the browser can no longer start it from load');
  assert.equal(d.media.playsOnArrival(later), true);
  d.started(later);                          // it had its data before boot, and started anyway
  assert.equal(later.paused, true, 'never playing while its slide is not on screen');
  d.go(1);
  assert.equal(later.paused, false, 'it plays when its slide arrives');
});

test('leaving a slide pauses its clips and returns them to the start; a clip without autoplay waits for its controls', () => {
  const talk = clip({ controls: '' });
  const d = deck([slide(talk), slide()]);
  d.go(0);
  assert.equal(talk.plays, 0, 'no autoplay, no play on arrival');
  talk.play(); talk.currentTime = 12;
  d.go(1);
  assert.equal(talk.paused, true);
  assert.equal(talk.currentTime, 0);
  d.go(0);
  assert.equal(talk.plays, 1, 'coming back does not start it either');
});

test('a page that only shows (print, capture, an embedded preview) plays nothing and loads the first frame', () => {
  const asked = clip({ autoplay: '' });
  const d = deck([slide(asked)], { live: false });
  d.go(0);
  assert.equal(asked.paused, true);
  assert.equal(asked.preload, 'auto');
  d.started(asked);
  assert.equal(asked.paused, true);
});
