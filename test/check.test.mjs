// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight check`: the two halves that decide what a deck's problems ARE —
// the file half (pure, with `exists` injected) and the render half (pure over a
// dumped DOM string). Neither needs Chrome, which is the whole point of them
// being separate functions: the lint an agent runs after every edit is checked
// here in milliseconds, and only the Chrome invocation itself is left to the
// render harnesses.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClicks, buildSteps, checkMain, clickSegments, formatFindings, localAsset, parseTree,
  renderFindings, sectionRanges, staticFindings,
} from '../cli/check.mjs';

/** A minimal deck: `sections` is the markup between the head and the tail. */
const deck = (sections) => `<!doctype html>
<html><head><link rel="stylesheet" href="../dist/decklight.css"></head>
<body><div class="decklight">
${sections}
</div></body></html>`;

/** No filesystem in these tests: every path is present unless a test says otherwise. */
const everything = { dir: '/decks', exists: () => true };

const rules = (findings) => findings.map((f) => f.rule);
const only = (findings, rule) => findings.filter((f) => f.rule === rule);

// ── the file half ────────────────────────────────────────────────────────────

test('a <section> that never closes is an error, named on its own slide', () => {
  const html = deck(`  <section>
    <h2>Open forever</h2>
  <section><h2>Swallowed</h2></section>`);
  const found = only(staticFindings(html, everything), 'unclosed-section');
  assert.equal(found.length, 1, 'one unclosed section, one finding');
  assert.equal(found[0].slide, 1);
  assert.equal(found[0].level, 'error');
  assert.equal(found[0].title, 'Open forever', 'the finding carries the slide heading for the report');
  assert.match(found[0].message, /never closed/);
});

test('a local asset that is not on disk is an error; one that is, is silent', () => {
  const html = deck(`  <section data-background-image="bg/hero.jpg">
    <h2>Pictures</h2>
    <img src="assets/logo.png">
    <img src="assets/there%20is%20one.png">
    <img src="https://cdn.example/remote.png">
    <img src="#later">
    <video src="clips/demo.mp4"></video>
  </section>`);
  const probed = [];
  const exists = (p) => { probed.push(p); return !p.includes('logo.png'); };
  const found = only(staticFindings(html, { dir: '/decks', exists }), 'missing-asset');

  assert.equal(found.length, 1, 'only the missing one is reported');
  assert.equal(found[0].slide, 1);
  assert.match(found[0].message, /assets\/logo\.png/, 'the refusal names the path as the author wrote it');
  assert.match(found[0].message, /<img src>/);
  // %20 is how a browser spells a space in a filename; it opens the decoded one
  assert.ok(probed.some((p) => p.endsWith('there is one.png')), `%20 was decoded before the lookup: ${probed}`);
  assert.ok(probed.some((p) => p.endsWith('hero.jpg')), 'data-background-image is an asset too');
  assert.ok(probed.some((p) => p.endsWith('demo.mp4')));
  assert.ok(!probed.some((p) => p.includes('remote.png')), 'a URL with a scheme is nobody’s local file');
  assert.ok(!probed.some((p) => p.includes('later')), 'an in-page anchor is not a file');
});

test('what is local and what is somewhere else', () => {
  assert.equal(localAsset('assets/a.png'), 'assets/a.png');
  assert.equal(localAsset('assets/a.png?v=3#x'), 'assets/a.png', 'a cache-buster is not part of the name');
  assert.equal(localAsset('a%20b.png'), 'a b.png');
  assert.equal(localAsset('https://x/y.png'), null);
  assert.equal(localAsset('data:image/png;base64,AAA'), null);
  assert.equal(localAsset('blob:https://x/1'), null);
  assert.equal(localAsset('//cdn/y.png'), null, 'protocol-relative is still somebody else’s server');
  assert.equal(localAsset('#anchor'), null);
  assert.equal(localAsset(''), null);
});

test('⟨CLICK⟩ segments and build steps: agreement is silent, disagreement names both numbers', () => {
  // segments = clicks + 1 (src/core/narration.js notesSegsOf keeps every part),
  // so four segments narrate three build steps: two list items and a leaf.
  const agree = deck(`  <section>
    <h2>In step</h2>
    <ul data-build><li>one</li><li>two</li></ul>
    <p data-build="fade-up">a leaf build is one step</p>
    <aside class="notes"><p>a</p><p>⟨CLICK⟩</p><p>b</p><p>⟨CLICK⟩</p><p>c</p><p>⟨CLICK⟩</p><p>d</p></aside>
  </section>`);
  assert.deepEqual(only(staticFindings(agree, everything), 'clicks-vs-builds'), []);

  const drift = deck(`  <section>
    <h2>Out of step</h2>
    <ul data-build><li>one</li><li>two</li><li>three</li><li>four</li></ul>
    <aside class="notes"><p>a</p><p>⟨CLICK⟩</p><p>b</p><p>⟨CLICK⟩</p><p>c</p></aside>
  </section>`);
  const found = only(staticFindings(drift, everything), 'clicks-vs-builds');
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'warn', 'a count that disagrees is worth saying, not worth failing on');
  assert.match(found[0].message, /3 ⟨CLICK⟩ segments but 4 build clicks/);

  // notes without a single ⟨CLICK⟩ make no claim about the builds at all
  const quiet = deck(`  <section>
    <h2>No beats</h2>
    <ul data-build><li>one</li><li>two</li></ul>
    <aside class="notes"><p>just talking</p></aside>
  </section>`);
  assert.deepEqual(only(staticFindings(quiet, everything), 'clicks-vs-builds'), []);
});

test('build steps are counted the way src/core/builds.js counts them', () => {
  const steps = (html) => buildSteps(parseTree(html));
  assert.equal(steps('<ul data-build><li>a</li><li>b</li><li>c</li></ul>'), 3, 'a container steps by child');
  assert.equal(steps('<p data-build>one</p>'), 1, 'a leaf is one step');
  assert.equal(steps('<img data-build src="x.png">'), 1, 'a leaf with no children at all');
  assert.equal(steps('<ul data-build><li>a</li><li data-build-stay>chrome</li></ul>'), 1,
    'data-build-stay is exempt (SPEC BUILD_AUTHORING)');
  assert.equal(steps('<div data-build><p>only child</p></div>'), 1,
    'a div with one eligible child is a leaf, not a container');
  assert.equal(steps('<div data-build><p>a</p><p>b</p></div>'), 2);
  assert.equal(steps('<table data-build><tbody><tr><td>a</td></tr><tr><td>b</td></tr></tbody></table>'), 2,
    'a table steps by row, never by its tbody');
  assert.equal(steps('<ul data-build><li>a<li>b</ul>'), 2,
    'unclosed <li> is legal HTML and still two steps');
  assert.equal(steps('<ul><li>a</li></ul>'), 0, 'no data-build, no steps');
  // a widget whose steps only the runtime can count is excluded from the
  // comparison entirely, rather than guessed at
  const provider = deck(`  <section>
    <h2>Code</h2>
    <pre data-lines="1|2|3"><code>a</code></pre>
    <aside class="notes"><p>a</p><p>⟨CLICK⟩</p><p>b</p></aside>
  </section>`);
  assert.deepEqual(only(staticFindings(provider, everything), 'clicks-vs-builds'), [],
    'a build provider contributes steps no file reader can count');

  // a chart is the same shape without the provider API: initCharts moves the
  // authored data-build onto a generated <svg> whose series groups are the steps
  const chart = deck(`  <section>
    <h2>Chart</h2>
    <div class="chart" data-chart="line" data-build="draw">
      <script type="application/json">{ "series": [{ "data": [1] }, { "data": [2] }] }</script>
    </div>
    <aside class="notes">Charts. ⟨CLICK⟩ p50 draws. ⟨CLICK⟩ p99 draws.</aside>
  </section>`);
  assert.deepEqual(only(staticFindings(chart, everything), 'clicks-vs-builds'), [],
    'an empty chart div is not one build step — the series are, once the svg exists');
});

test('steps tied by data-build-order are one click — the count the presenter will make (#526)', () => {
  // A + A' advance together, then B: two clicks, three segments — exactly right
  const tied = (notes) => deck(`  <section>
    <h2>Tie count</h2>
    <ul>
      <li data-build data-build-order="1">A</li>
      <li data-build data-build-order="1">A'</li>
      <li data-build data-build-order="2">B</li>
    </ul>
    <aside class="notes">${notes}</aside>
  </section>`);
  assert.equal(buildSteps(parseTree(tied(''))), 3, 'three steps…');
  assert.equal(buildClicks(parseTree(tied(''))), 2, '…in two clicks');
  assert.deepEqual(only(staticFindings(tied('<p>Intro.</p><p>⟨CLICK⟩</p><p>A and A prime together.</p><p>⟨CLICK⟩</p><p>B.</p>'), everything), 'clicks-vs-builds'), []);
  // four segments still warn, and the number printed is the click count, with the tie explained
  const found = only(staticFindings(tied('<p>a</p><p>⟨CLICK⟩</p><p>b</p><p>⟨CLICK⟩</p><p>c</p><p>⟨CLICK⟩</p><p>d</p>'), everything), 'clicks-vs-builds');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /4 ⟨CLICK⟩ segments but 2 build clicks \(3 build steps, tied by data-build-order\)/);
  // auto steps never merge, even at equal keys (computeGroups' own rule)
  assert.equal(buildClicks(parseTree('<ul data-build><li>a</li><li>b</li></ul><p data-build>c</p>')), 3);
  // explicit keys reorder as well as tie: a container child and a leaf sharing one key are one click
  assert.equal(buildClicks(parseTree('<ul data-build><li data-build-order="2">a</li><li data-build-order="1">b</li></ul><p data-build data-build-order="1">c</p>')), 2);
});

test('a staged stroke counts one step per stop — its count is in the attribute, unlike a provider’s (#526)', () => {
  const svg = (line) => `<svg data-build="draw"><defs><marker id="a"></marker></defs>${line}<g><rect/><text>x</text></g></svg>`;
  const stops = '<line x1="0" y1="0" x2="700" y2="0" data-draw-stops="300 500 700" marker-end="url(#a)"/>';
  assert.equal(buildSteps(parseTree(svg(stops))), 4, 'three stops and one group');
  assert.equal(buildClicks(parseTree(svg(stops))), 4);
  assert.equal(buildClicks(parseTree('<line data-build="draw" data-draw-stops="25% 50% 100%"/>')), 3, 'a leaf stroke with stops');
  assert.equal(buildClicks(parseTree('<svg><line data-draw-stops="1 2"/></svg>')), 2, 'outside any build container it is still its own provider');
  assert.equal(buildClicks(parseTree('<line data-build="draw" data-draw-stops=""/>')), 1, 'no stops parsed: one draw step, as the runtime falls back to');
  const slide = deck(`  <section>
    <h2>Progress</h2>
    ${svg(stops)}
    <aside class="notes"><p>a</p><p>⟨CLICK⟩</p><p>b</p><p>⟨CLICK⟩</p><p>c</p><p>⟨CLICK⟩</p><p>d</p><p>⟨CLICK⟩</p><p>e</p></aside>
  </section>`);
  assert.deepEqual(only(staticFindings(slide, everything), 'clicks-vs-builds'), [], 'four clicks, five segments: in step');
});

test('clickSegments follows the runtime rule: every part kept, empties included', () => {
  assert.equal(clickSegments('<p>one</p>'), 1);
  assert.equal(clickSegments('<p>one</p>⟨CLICK⟩<p>two</p>'), 2);
  assert.equal(clickSegments('⟨CLICK⟩<p>one</p>'), 2, 'a leading ⟨CLICK⟩ is still a beat for the builds');
  assert.equal(clickSegments(''), 0, 'no notes is not a disagreement');
  assert.equal(clickSegments(null), 0);
});

test('a data-markdown slide is an error — the feature was removed and the slide comes up empty', () => {
  const html = deck(`  <section><h2>Fine</h2></section>
  <section data-markdown><script type="text/template"># Hello</script></section>`);
  const found = only(staticFindings(html, everything), 'markdown-slide');
  assert.equal(found.length, 1);
  assert.equal(found[0].slide, 2);
  assert.equal(found[0].level, 'error');
  assert.match(found[0].message, /markdown slides are not rendered/);
  assert.equal(found[0].title, 'slide 2',
    'a slide with no heading falls back to its number — never to the remnant of its own open tag');
  assert.match(found[0].message, /DECK_ANATOMY/, 'the SPEC pointer is a mnemonic, never a number');
});

test('the ingredients label rides along: a warning per item, with what strict would do', () => {
  const html = deck(`  <section>
    <h2>Homebrew</h2>
    <img src="a.png" onerror="alert(1)">
    <script>fetch('//evil')</script>
  </section>`);
  const found = staticFindings(html, everything);
  assert.equal(only(found, 'unaccounted-script').length, 1);
  assert.equal(only(found, 'executable-attribute').length, 1);
  for (const f of [...only(found, 'unaccounted-script'), ...only(found, 'executable-attribute')]) {
    assert.equal(f.level, 'warn', 'a deck may legitimately carry its own script — this is an inventory');
    assert.equal(f.slide, 1, 'attributed to the slide it sits on');
    assert.match(f.message, /present --strict would strip this/);
  }
});

test('a finding outside every section belongs to the head, not to the last slide', () => {
  const html = deck(`  <section><h2>Only slide</h2></section>`)
    .replace('</head>', '  <script src="analytics.js"></script>\n</head>');
  const found = only(staticFindings(html, { dir: '/decks', exists: () => false }), 'missing-asset');
  const head = found.find((f) => f.message.includes('analytics.js'));
  assert.ok(head, 'the head script is checked like any other local asset');
  assert.equal(head.slide, null);
  assert.equal(head.title, 'head');
});

test('slide ranges stop at the section’s own close, so the page tail is nobody’s slide', () => {
  const html = deck('  <section><h2>A</h2></section>\n  <section><h2>B</h2></section>');
  const ranges = sectionRanges(html);
  assert.equal(ranges.length, 2);
  assert.ok(ranges[0].end <= ranges[1].start, 'the ranges do not overlap');
  assert.ok(ranges[1].end < html.length, 'the last slide does not own </body>');
});

// ── the render half ──────────────────────────────────────────────────────────

test('a clipped slide in the dumped DOM is an error, by slide number', () => {
  const dom = '<section><h2>Fine</h2></section>'
    + '<section data-overflow="true"><h2>Too much</h2></section>'
    + '<section data-split-conflict><h2>Fighting</h2></section>';
  const found = renderFindings(dom, { slides: 3 });
  assert.deepEqual(rules(found), ['overflow', 'split-conflict']);
  assert.equal(found[0].slide, 2);
  assert.equal(found[0].level, 'error');
  assert.equal(found[0].title, 'Too much');
  assert.match(found[0].message, /clipped/);
  assert.equal(found[1].slide, 3);
  assert.equal(found[1].level, 'warn');
  assert.match(found[1].message, /COMPARISON_SLIDES/);
  // the boolean attribute the engine writes today, and the px figure a future
  // one might: neither is invented
  assert.match(renderFindings('<section data-overflow data-overflow-by="42"></section>')[0].message,
    /\(42 px over\)/);
  assert.deepEqual(renderFindings('<section><h2>Clean</h2></section>', { slides: 1 }), []);
});

test('fewer sections on the page than in the file means the runtime never mounted', () => {
  const found = renderFindings('<section><h2>A</h2></section>', { slides: 4 });
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, 'not-rendered');
  assert.equal(found[0].level, 'error');
  assert.equal(found[0].slide, null, 'a deck that did not render is not one slide’s fault');
  assert.match(found[0].message, /4 sections in the file, 1 on the page/);
});

// ── output ───────────────────────────────────────────────────────────────────

test('findings print grouped by slide, each line saying error or warn, with a count at the end', () => {
  const findings = [
    ...renderFindings('<section><h2>A</h2></section><section data-overflow><h2>B</h2></section>', { slides: 2 }),
    ...staticFindings(deck(`  <section>
      <h2>B</h2>
      <ul data-build><li>a</li><li>b</li><li>c</li></ul>
      <aside class="notes"><p>x</p><p>⟨CLICK⟩</p><p>y</p></aside>
    </section>`), everything),
  ];
  const lines = formatFindings(findings, { slides: 2 });
  assert.equal(lines[0], 'slide 1  "B"', 'the heading names the slide the way the finder does');
  assert.match(lines[1], /^ {2}warn {2} 2 ⟨CLICK⟩ segments/);
  assert.ok(lines.some((l) => l === 'slide 2  "B"'));
  assert.ok(lines.some((l) => /^ {2}error {2}content is clipped/.test(l)));
  assert.equal(lines.at(-1), '1 error, 1 warning');
  // nothing wrong is a sentence, not an empty page
  assert.deepEqual(formatFindings([], { slides: 12 }), ['no findings — 12 slides checked']);
  assert.deepEqual(formatFindings([], { slides: 1 }), ['no findings — 1 slide checked']);
  // colour is opt-in and never changes the words
  const plain = formatFindings(findings, { slides: 2 }).join('\n');
  const painted = formatFindings(findings, { color: true, slides: 2 }).join('\n');
  assert.ok(painted.includes('\x1b['), 'colour is applied when asked for');
  assert.equal(painted.replace(/\x1b\[[0-9;]*m/g, ''), plain);
});

test('every finding is the same JSON shape, for the agent that reads --json', () => {
  const findings = staticFindings(deck('  <section data-markdown><h2>Gone</h2></section>'), everything);
  const parsed = JSON.parse(JSON.stringify(findings));
  assert.ok(parsed.length);
  for (const f of parsed) {
    assert.deepEqual(Object.keys(f), ['level', 'rule', 'slide', 'title', 'message']);
    assert.ok(['error', 'warn'].includes(f.level));
    assert.equal(typeof f.rule, 'string');
    assert.equal(typeof f.message, 'string');
  }
});

// ── the command itself ───────────────────────────────────────────────────────

/** Run `checkMain` with stdout/stderr captured, so a refusal can be read here. */
async function run(args) {
  const out = [], err = [];
  const log = console.log, error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try { return { code: await checkMain(args), out: out.join('\n'), err: err.join('\n') }; }
  finally { console.log = log; console.error = error; }
}

test('--help says what it checks, who it is for, and exits 0', async () => {
  const { code, out } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(out, /usage: decklight check <deck\.html>/);
  assert.match(out, /agent/, 'who runs this after every edit');
  assert.match(out, /before a talk/, 'and who runs it before standing up');
  for (const flag of ['--no-render', '--json', '--wait']) assert.ok(out.includes(flag), `${flag} is documented`);
  assert.match(out, /exit 1 if anything is an error/);
});

test('a deck that is not there is a refusal naming the file, not a stack', async () => {
  const { code, err } = await run(['no-such-talk.html', '--no-render']);
  assert.equal(code, 1);
  assert.match(err, /decklight check: no such deck: no-such-talk\.html/);
});

test('no deck at all prints the usage rather than guessing', async () => {
  const { code, err } = await run(['--no-render']);
  assert.equal(code, 1);
  assert.match(err, /needs a deck/);
  assert.match(err, /usage: decklight check/);
});

test('a staged stroke with data-build-order ties its stops to the elements sharing those keys (#524)', () => {
  const svg = `<svg data-build="draw">
    <line data-draw-stops="327 522 747" data-build-order="1"/>
    <g data-build="fade-up" data-build-self data-build-order="1"><rect/></g>
    <g data-build="fade-up" data-build-self data-build-order="2"><rect/></g>
    <g data-build="fade-up" data-build-self data-build-order="3"><rect/></g>
  </svg>`;
  assert.equal(buildSteps(parseTree(svg)), 6, 'three stops and three boxes…');
  assert.equal(buildClicks(parseTree(svg)), 3, '…in three clicks');
  assert.equal(buildClicks(parseTree(svg.replace(' data-build-order="1"/>', '/>'))), 6, 'without the order the stops keep their own places');
});
