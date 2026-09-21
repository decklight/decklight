// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `npm run verify` runs the two big render pages as GROUPS of modes, not as
// whole files (test/verify.mjs `NARRATION_GROUPS`, `ENGINE_GROUPS`) — each
// group a harness with its own budget, so a failure names a concern.
//
// The cost of that split is a list to keep: a mode added to the page and not
// to a group is a harness nobody runs. It happened — ⟨PAUSE⟩'s `pausemark`
// (#560) and `recordseg&pause` sat unrun for two releases, green because they
// were never asked. Nothing failed; the mode simply never ran, which is the
// one test outcome no suite reports. So the lists are compared here, where a
// drift is a red unit test the moment the mode is written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.join(here, f), 'utf8');
const quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]);
const block = (src, name) => quoted(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(src)[1]);
const modesOf = (src) => quoted(/const MODES = \[([\s\S]*?)\];/.exec(src)[1]);

for (const [page, groups] of [['narration', 'NARRATION_GROUPS'], ['engine', 'ENGINE_GROUPS']]) {
  test(`every ${page}-render mode runs in verify, and every mode verify names exists`, () => {
    const grouped = block(read('verify.mjs'), groups);
    const modes = modesOf(read(`${page}-render.mjs`));
    assert.deepEqual(modes.filter((m) => !grouped.includes(m)), [],
      `these modes are in ${page}-render.mjs and in no verify group — nothing runs them`);
    assert.deepEqual(grouped.filter((m) => !modes.includes(m)), [],
      `verify asks ${page}-render for modes it does not have — a rename left the group behind`);
    assert.deepEqual(grouped.filter((m, i) => grouped.indexOf(m) !== i), [],
      'a mode listed in two groups is run twice and owned by neither');
  });
}
