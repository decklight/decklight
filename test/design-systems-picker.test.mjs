// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The design-system pickers (SPEC DESIGN_SYSTEMS) open whenever an author
// server answered — including the commonest case, a deck served BY that
// server, where the base is '' because every fetch is same-origin. Only a
// null base means "no server". A truthiness check read '' as "not authoring"
// and refused to open in exactly the session the pickers exist for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesignSystemsPicker, createSlideTemplatePicker } from '../src/core/design-systems.js';

/**
 * Open a picker against a base; report whether it refused or started building
 * its card — the first thing past the guard is `document.createElement`, which
 * here throws a sentinel (synchronously, or as the rejection of an async open).
 */
async function opens(create, base) {
  const said = [];
  const reached = new Error('reached the card');
  const saved = globalThis.document;
  globalThis.document = { createElement: () => { throw reached; } };
  try {
    const picker = create({ root: {}, toast: (m) => said.push(m), deck: () => null, base: () => base, debugLog: () => {} });
    await picker.open();
    return { opened: false, said };
  } catch (e) {
    if (e !== reached) throw e;
    return { opened: true, said };
  } finally { globalThis.document = saved; }
}

for (const [name, create] of [['Design systems…', createDesignSystemsPicker], ['Use slide template…', createSlideTemplatePicker]]) {
  test(`${name} opens on a same-origin edit server (base '') and refuses only with no server (null)`, async () => {
    const same = await opens(create, '');
    assert.equal(same.opened, true, `refused with: ${same.said.join(' · ')}`);
    assert.equal((await opens(create, 'http://127.0.0.1:8788')).opened, true);
    const none = await opens(create, null);
    assert.equal(none.opened, false);
    assert.match(none.said[0], /in write mode/);
  });
}
