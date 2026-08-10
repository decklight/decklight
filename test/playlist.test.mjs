// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Module navigation: chained files (config.playlist) and one merged file's
// data-module chapters — the two shapes a course comes in, and the precedence
// between them.
//
// Extracted from init()'s closure, so this is the first time any of it can be
// asserted without a browser. The chaining rules in particular are the kind
// that only show up at the seams of a talk: what happens when you advance past
// the last slide of module 3, or reverse off the front of module 2.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPlaylist } from '../src/core/playlist.js';

const section = (module) => ({
  hasAttribute: (a) => a === 'data-module' && module !== undefined,
  getAttribute: (a) => (a === 'data-module' ? module : null),
});

/** A playlist wired to fakes, plus the navigations it attempted. */
function make({ config = {}, sections = [], slide = 1, embedded = false } = {}) {
  const went = [];
  const nav = createPlaylist({
    config, embedded,
    root: { querySelector: () => (sections.some((s) => s.hasAttribute('data-module')) ? sections[0] : null) },
    sectionsOf: () => sections,
    slideOf: () => slide,
    navigate: (href) => went.push(href),
  });
  return { nav, went };
}

const threeModules = {
  playlist: {
    index: 1,
    modules: [
      { title: 'Intro', href: 'intro.html' },
      { title: 'Middle', href: 'middle.html' },
      { title: 'End', href: 'end.html' },
    ],
  },
};

test('advancing past the end chains forward, reversing chains back to the last slide', () => {
  const { nav, went } = make({ config: threeModules });
  assert.equal(nav.gotoModule(1), true);
  assert.equal(nav.gotoModule(-1), true);
  assert.deepEqual(went, ['end.html#/1/0', 'intro.html#/999/999'],
    'forward opens at slide 1; backward lands on the previous deck\'s LAST slide');
});

test('the ends of a course are no-ops, not errors', () => {
  const first = make({ config: { playlist: { ...threeModules.playlist, index: 0 } } });
  assert.equal(first.nav.gotoModule(-1), false, 'nothing before the first module');
  const last = make({ config: { playlist: { ...threeModules.playlist, index: 2 } } });
  assert.equal(last.nav.gotoModule(1), false, 'nor after the last');
  assert.deepEqual([...first.went, ...last.went], [], 'and neither navigates anywhere');
});

test('an embedded instance never chains — a preview must not replace the deck', () => {
  const { nav, went } = make({ config: threeModules, embedded: true });
  assert.equal(nav.playlist, null);
  assert.equal(nav.any, false);
  assert.equal(nav.gotoModule(1), false);
  assert.deepEqual(went, []);
});

test('a deck with no playlist and no markers reports no module navigation at all', () => {
  const { nav } = make({ sections: [section(), section()] });
  assert.equal(nav.any, false);
  assert.equal(nav.title(), '');
  assert.deepEqual(nav.markers(), []);
});

test('in-file markers are chapters, found in deck order', () => {
  const sections = [section('One'), section(), section('Two'), section()];
  const { nav } = make({ sections });
  assert.equal(nav.hasMarkers, true);
  assert.deepEqual(nav.markers(), [{ title: 'One', slide: 1 }, { title: 'Two', slide: 3 }]);
});

test('the current chapter is the last marker at or before the slide', () => {
  const sections = [section('One'), section(), section('Two'), section()];
  for (const [slide, title] of [[1, 'One'], [2, 'One'], [3, 'Two'], [4, 'Two']]) {
    const { nav } = make({ sections, slide });
    assert.equal(nav.title(), title, `slide ${slide} is in ${title}`);
  }
});

test('a merged deck takes precedence over a playlist, and stays in the file', () => {
  // bundle --all writes markers into one file. If that file ALSO carries a
  // playlist config, following the config would load a page for a chapter
  // that is already right here.
  const sections = [section('One'), section('Two')];
  const { nav, went } = make({ config: threeModules, sections, slide: 2 });
  assert.equal(nav.hasMarkers, true);
  assert.equal(nav.title(), 'Two', 'the chapter comes from the markers, not the playlist');
  assert.deepEqual(went, []);
});

test('without markers the title is the playlist entry for this deck', () => {
  const { nav } = make({ config: threeModules });
  assert.equal(nav.title(), 'Middle');
  assert.equal(nav.index, 1);
});

test('navigateToModule opens a module at its first slide', () => {
  const { nav, went } = make({ config: threeModules });
  nav.navigateToModule(0);
  nav.navigateToModule(99);       // out of range: nothing happens
  assert.deepEqual(went, ['intro.html#/1/0']);
});
