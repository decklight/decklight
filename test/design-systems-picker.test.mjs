// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The design-system pickers (SPEC DESIGN_SYSTEMS) open whenever an author
// server answered — including the commonest case, a deck served BY that
// server, where the base is '' because every fetch is same-origin. Only a
// null base means "no server". A truthiness check read '' as "not authoring"
// and refused to open in exactly the session the pickers exist for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesignSystemsPicker, createSlideTemplatePicker, designSystemRow, designSystemAction } from '../src/core/design-systems.js';

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

// The row (#860): one in-use marker, never a ✓ beside it (that is the
// narration panel's .narr-cur); the version set apart from the description;
// the description in the tooltip too; and what Space would do, on the row.
const ds = { name: 'confluent-developer', qualified: 'confluent-developer@decklight-confluent', version: '5.0.0', description: 'Palette scales, "two" themes, seven templates.' };

test('a row in use carries one ● and is not .narr-cur, so it gets no trailing ✓', () => {
  const html = designSystemRow({ ...ds, used: true }, 0);
  assert.equal(html.match(/●/g).length, 1);
  assert.doesNotMatch(html, /○|narr-cur|✓/);
  assert.match(html, /class="narr-row ds-row ds-used"/);
});

test('the version is its own element, apart from the description, which is also the tooltip', () => {
  const html = designSystemRow({ ...ds, used: false }, 3);
  assert.match(html, /<span class="ds-version">5\.0\.0<\/span>/);
  assert.match(html, /<span class="ds-desc">Palette scales, &quot;two&quot; themes, seven templates\.<\/span>/);
  assert.match(html, /title="Palette scales, &quot;two&quot; themes, seven templates\."/);
  assert.match(html, /data-i="3"/);
});

test('the row names what Space does — the ⇧ hint only where adding', () => {
  assert.equal(designSystemAction({ ...ds, used: true }), 'Space: stop using');
  assert.equal(designSystemAction({ ...ds, used: true }, { slides: 1 }), 'Space: stop using — 1 slide uses its templates');
  assert.equal(designSystemAction({ ...ds, used: true }, { slides: 4 }), 'Space: stop using — 4 slides use its templates');
  assert.equal(designSystemAction({ ...ds, used: false }), 'Space: use, with its themes and fonts (⇧ alone)');
  assert.equal(designSystemAction({ ...ds, used: false, missing: 'not installed' }), null);
  assert.match(designSystemRow({ ...ds, used: true }, 0), /<span class="ds-act">Space: stop using<\/span>/);
  assert.doesNotMatch(designSystemRow({ ...ds, used: false, missing: 'x' }, 0), /ds-act/);
});
