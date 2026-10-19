// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// The agent review (cli/agent-review.mjs): what the agent is shown of each
// slide, the rules it is asked about, and the check every answer goes through
// before Check deck… lists a single finding.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_RULES, REVIEW_BATCH, reviewSlides, reviewPrompt, parseReview, reviewDeck, currentFindings, fixPrompt,
} from '../cli/agent-review.mjs';

const deck = (...sections) => `<div class="decklight">\n${sections.map((s) => `    <section>${s}</section>`).join('\n')}\n</div>`;
const fake = (prompt) => ({ bin: 'fake', args: [prompt], name: 'claude', label: 'Claude Code' });

test('each visible slide is shown with its title, its text, its notes and its sources; a hidden one is not', () => {
  const html = deck(
    '<h2>Revenue grew 40%</h2><ul><li>EMEA led</li></ul><aside class="notes"><p>Say why.</p></aside>'
      + '<aside class="sources"><dl><dt>owner</dt><dd>finance</dd></dl><ul><li><a href="report.pdf#page=12">Annual report</a> — pp. 12–14</li></ul></aside>',
    '<h2>Flow</h2><svg><rect/></svg>',
  ).replace('<section><h2>Flow', '<section data-hidden><h2>Flow');
  const [s, ...rest] = reviewSlides(html);
  assert.equal(rest.length, 0, 'the hidden slide is not reviewed');
  assert.equal(s.slide, 1);
  assert.equal(s.title, 'Revenue grew 40%');
  assert.match(s.text, /EMEA led/);
  assert.doesNotMatch(s.text, /Say why|finance/, 'asides are not what the slide shows');
  assert.equal(s.notes, 'Say why.');
  assert.deepEqual(s.sources, ['owner: finance', 'Annual report (report.pdf#page=12): pp. 12–14']);
  assert.match(s.fp, /^[0-9a-f]{8}$/);
});

test('the prompt names every rule, shows the deck\'s outline and only the batch\'s slides, and asks for JSON', () => {
  const slides = reviewSlides(deck('<h2>One</h2><p>a</p>', '<h2>Two</h2><p>b</p>', '<h2>Three</h2><p>c</p>'));
  const p = reviewPrompt(slides.slice(1, 2), slides);
  for (const r of REVIEW_RULES) assert.ok(p.includes(`\`${r.id}\`: ${r.ask}`), `${r.id} is asked about, word for word`);
  assert.match(p, /1\. One\n2\. Two\n3\. Three/, 'the whole deck, for context');
  assert.match(p, /### Slide 2: Two/);
  assert.doesNotMatch(p, /### Slide [13]/, 'only the batch is reviewed');
  assert.match(p, /do not open, edit or create any file/);
  assert.match(p, /If nothing\napplies, answer `\[\]`/);
});

test('an answer is checked: unknown rules, slides outside the batch, empty words and repeats are dropped', () => {
  const batch = reviewSlides(deck('<h2>Results</h2><p>x</p>', '<h2>Plan</h2><p>y</p>'));
  const answer = '```json\n' + JSON.stringify([
    { slide: 1, rule: 'topic-title', message: 'The title names a topic.', fix: 'Retitle it "Latency halved".' },
    { slide: 1, rule: 'topic-title', message: 'again', fix: 'again' },
    { slide: 2, rule: 'made-up', message: 'x', fix: 'y' },
    { slide: 9, rule: 'thin-voiceover', message: 'x', fix: 'y' },
    { slide: 2, rule: 'thin-voiceover', message: '', fix: 'y' },
    { slide: '2', rule: 'thin-voiceover', message: 'No notes.', fix: 'Write notes that explain the plan.' },
    'not an object',
  ]) + '\n```';
  const { findings } = parseReview(answer, batch);
  assert.deepEqual(findings.map((f) => `${f.slide} ${f.rule}`), ['1 topic-title', '2 thin-voiceover']);
  assert.equal(findings[0].title, 'Results');
  assert.equal(findings[0].fp, batch[0].fp, 'a finding remembers the slide it was about');
  assert.deepEqual(parseReview('Here you go:\n[]\nHope that helps.', batch), { findings: [] }, 'talk around the JSON is ignored');
  assert.match(parseReview('I think the deck is fine.', batch).why, /JSON/);
  assert.match(parseReview('{"slide": 1}', batch).why, /list/);
});

test('the deck is reviewed in batches, a failed batch is reported rather than thrown, and findings come back in slide order', async () => {
  const sections = Array.from({ length: REVIEW_BATCH + 2 }, (_, i) => `<h2>S${i + 1}</h2><p>text ${i + 1}</p>`);
  const html = deck(...sections);
  const asked = [];
  const exec = async (cmd) => {
    const p = cmd.args[0];
    asked.push(p);
    const first = Number(/### Slide (\d+)/.exec(p)[1]);
    if (first === 1) return JSON.stringify([{ slide: 3, rule: 'better-as-visual', message: 'A sequence in bullets.', fix: 'Draw it.' },
      { slide: 2, rule: 'topic-title', message: 'A topic.', fix: 'Say the point.' }]);
    return null; // the second batch times out
  };
  const progress = [];
  const r = await reviewDeck(html, { resolveAgent: (_a, prompt) => fake(prompt), exec, onBatch: (b) => progress.push(`${b.done}/${b.of}`) });
  assert.equal(asked.length, 2, 'one ask per batch');
  assert.deepEqual(r.findings.map((f) => f.slide), [2, 3]);
  assert.deepEqual(r.failed, [{ slides: [REVIEW_BATCH + 1, REVIEW_BATCH + 2], why: 'the agent did not answer in time' }]);
  assert.deepEqual(progress.sort(), ['1/2', '2/2']);
  await assert.rejects(reviewDeck(html, { resolveAgent: () => null, env: { PATH: '' } }), /agent/i, 'no agent at all is the one thing that throws');
});

test('a stopped review asks for no batch after the ones in flight', async () => {
  const html = deck(...Array.from({ length: REVIEW_BATCH * 3 }, (_, i) => `<h2>S${i + 1}</h2><p>text ${i + 1}</p>`));
  const stop = new AbortController();
  let asked = 0;
  const exec = async (_cmd, _cwd, _ms, signal) => { asked++; stop.abort(); assert.equal(signal, stop.signal); return null; };
  await reviewDeck(html, { resolveAgent: (_a, prompt) => fake(prompt), exec, concurrency: 1, signal: stop.signal });
  assert.equal(asked, 1);
});

test('a finding follows its slide when it moves, and goes when the slide is edited', () => {
  const html = deck('<h2>Intro</h2><p>a</p>', '<h2>Results</h2><p>b</p>');
  const [, results] = reviewSlides(html);
  const found = [{ slide: 2, title: 'Results', fp: results.fp, rule: 'topic-title', message: 'A topic.', fix: 'Say the point.' }];
  const moved = deck('<h2>New first</h2><p>z</p>', '<h2>Intro</h2><p>a</p>', '<h2>Results</h2><p>b</p>');
  assert.deepEqual(currentFindings(moved, found).map((f) => f.slide), [3], 'moved: the same finding, on the slide\'s new number');
  const fixed = deck('<h2>Intro</h2><p>a</p>', '<h2>Latency halved after the cache</h2><p>b</p>');
  assert.deepEqual(currentFindings(fixed, found), [], 'fixed: the finding is about text that no longer exists');
  const renoted = deck('<h2>Intro</h2><p>a</p>', '<h2>Results</h2><p>b</p><aside class="notes"><p>Now explained.</p></aside>');
  assert.deepEqual(currentFindings(renoted, found), [], 'new notes count as an edit: a thin voiceover is fixed in the notes');
});

test('the fix is one finding, on one slide, and a figure is never given an invented source', () => {
  const f = { slide: 4, title: 'Growth', rule: 'unsourced-figure', message: '40% has no source.', fix: 'Cite the report.' };
  const p = fixPrompt(f);
  assert.match(p, /^On slide 4 \("Growth"\), fix this one review finding and nothing else\./);
  assert.match(p, /40% has no source\. What to do: Cite the report\./);
  assert.match(p, /only if you can open and read it/);
  assert.doesNotMatch(fixPrompt({ ...f, rule: 'topic-title' }), /open and read/);
});
