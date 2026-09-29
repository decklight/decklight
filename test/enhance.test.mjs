// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// `decklight enhance` (cli/enhance.mjs): ElevenLabs' own prompt, a read-only
// agent answering it, and a check that no word or beat moved before a slide
// is written.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ELEVENLABS_ENHANCE_PROMPT, ENHANCE_SOURCE, enhancePrompt, slideScript, enhanceProblem, unwrapAnswer,
  parseSlides, enhanceable, enhanceDeck, applyEnhanced, enhanceMain,
} from '../cli/enhance.mjs';

const deck = (...notes) => `<div class="decklight">\n${notes.map((n, i) => `    <section><h2>S${i + 1}</h2>${
  n == null ? '' : `\n      <aside class="notes">${n}</aside>`}\n    </section>`).join('\n')}\n</div>`;
const scriptOf = (html, n) => slideScript(/<aside class="notes">([\s\S]*?)<\/aside>/.exec(html.split('<section').slice(1)[n - 1])?.[1]);

test('the prompt is ElevenLabs\' own, word for word, then what decklight adds, then the script', () => {
  assert.match(ELEVENLABS_ENHANCE_PROMPT, /^# Instructions\n\n## 1\. Role and Goal\n\nYou are an AI assistant specializing in enhancing dialogue text for speech generation\./);
  assert.match(ELEVENLABS_ENHANCE_PROMPT, /3\. Reply ONLY with the enhanced text\.$/);
  assert.match(ENHANCE_SOURCE, /elevenlabs\.io\/docs\/.*best-practices#prompting-eleven-v4$/);
  const p = enhancePrompt('Hello. [pause] There.');
  assert.ok(p.startsWith(ELEVENLABS_ENHANCE_PROMPT));
  assert.match(p, /\[click\] — on a line of its own/, 'decklight says what its markers are');
  assert.ok(p.endsWith('# Script\n\nHello. [pause] There.'));
});

test('a slide\'s script is its notes as text, markers in brackets, [click] on its own line', () => {
  assert.equal(slideScript('<p>Hi &amp; welcome. <pause></pause> On.</p><p>[click]</p><p>Two.</p>'),
    'Hi & welcome. [pause] On.\n\n[click]\n\nTwo.');
  assert.equal(slideScript('<p>One.</p>\n<p>Two.</p><p>[click]</p><p>Three.</p>'), 'One.\n\nTwo.\n\n[click]\n\nThree.',
    'paragraphs stay a blank line apart, as the notes editor keeps them');
  assert.equal(slideScript('<p>[pause]</p>'), null, 'nothing to say, nothing to enhance');
  assert.equal(slideScript(''), null);
});

test('an answer is only an enhancement if the words, the beats and the pauses are all still there', () => {
  const s = 'Are you serious? [pause] I cannot believe it.\n\n[click]\n\nIt is just difficult.';
  assert.equal(enhanceProblem(s, '[appalled] Are you SERIOUS?! [pause] [sighs] I cannot believe it.\n\n[click]\n\nIt is just... [sighs] difficult.'), null,
    'tags, capitals, ! ? and … are what the prompt allows');
  assert.equal(enhanceProblem(s, '[appalled] Are you serious? [long pause] I cannot believe it.\n\n[click]\n\nIt is just difficult.'), null,
    'a longer hold is still a hold');
  assert.match(enhanceProblem(s, 'Are you serious? [pause] I cannot believe it. It is just difficult.'), /\[click\] beats \(2 → 1\)/);
  assert.match(enhanceProblem(s, 'Are you kidding? [pause] I cannot believe it.\n\n[click]\n\nIt is just difficult.'), /changed the words of beat 1/);
  assert.match(enhanceProblem(s, 'Are you serious? I cannot believe it.\n\n[click]\n\nIt is just difficult.'), /dropped a \[pause\]/);
  assert.match(enhanceProblem(s, '   '), /answered nothing/);
});

test('the agent\'s packaging comes off: a code fence, quotes around the whole answer', () => {
  assert.equal(unwrapAnswer('```\n[sighs] Fine.\n```'), '[sighs] Fine.');
  assert.equal(unwrapAnswer('```text\n[sighs] Fine.\n```'), '[sighs] Fine.');
  assert.equal(unwrapAnswer('"[sighs] Fine."'), '[sighs] Fine.');
  assert.equal(unwrapAnswer('He said "no". [sighs]'), 'He said "no". [sighs]', 'quotes inside are the script\'s own');
});

test('--slides reads a number, a range, or a list — and refuses slides the deck does not have', () => {
  assert.deepEqual(parseSlides('3', 5), [3]);
  assert.deepEqual(parseSlides('2-4', 5), [2, 3, 4]);
  assert.deepEqual(parseSlides('1, 4, 2–3', 5), [1, 2, 3, 4]);
  assert.throws(() => parseSlides('6', 5), /not slides of this deck \(1–5/);
  assert.throws(() => parseSlides('x', 5), /not slides/);
});

test('only visible slides with notes that say something are asked about', () => {
  const html = deck('<p>One.</p>', null, '<p>[pause]</p>', '<p>Four.</p>').replace('<section><h2>S4', '<section data-hidden><h2>S4');
  assert.deepEqual(enhanceable(html).map((e) => e.slide), [1]);
  assert.deepEqual(enhanceable(html, [3, 4]).map((e) => e.slide), []);
});

test('each slide is asked once, read-only; one that passes is written, one that rewords is left as it was', async () => {
  const html = deck('<p>Hello there.</p><p>[click]</p><p>Next beat.</p>', '<p>Keep my words.</p>', '<p>Third.</p>');
  const asked = [];
  const resolveAgent = (name, prompt) => ({ bin: 'fake', args: [prompt], name: 'claude', label: 'Claude Code', readOnly: true });
  const exec = async (cmd) => {
    const script = cmd.args[0].split('# Script\n\n')[1];
    asked.push(script);
    if (script.startsWith('Keep')) return 'Change my words.';
    if (script.startsWith('Third')) return '```\nThird.\n```';
    return script.replace('Hello there.', '[warm] Hello there!').replace('Next beat.', '[excited] Next beat.');
  };
  const seen = [];
  const { html: out, results } = await enhanceDeck(html, null, { resolveAgent, exec, onSlide: (r) => seen.push(r.done) });
  assert.equal(asked.length, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3], 'progress per slide');
  assert.deepEqual(results, [
    { slide: 1, ok: true, changed: true },
    { slide: 2, ok: false, changed: false, why: 'the agent changed the words — the prompt allows only tags and emphasis' },
    { slide: 3, ok: true, changed: false },
  ]);
  assert.equal(scriptOf(out, 1), '[warm] Hello there!\n\n[click]\n\n[excited] Next beat.');
  assert.equal(scriptOf(out, 2), 'Keep my words.', 'untouched');
  assert.match(out, /<p>\[warm\] Hello there!<\/p>\n\s*<p>\[click\]<\/p>/, 'written the way the notes editor writes');
});

test('an answer lands only on a slide still as it was asked about — an edit made meanwhile is kept', () => {
  const before = deck('<p>One.</p>', '<p>Two.</p>');
  const answers = [
    { slide: 1, ok: true, changed: true, before: 'One.', text: '[sighs] One.' },
    { slide: 2, ok: true, changed: true, before: 'Two.', text: '[laughs] Two.' },
  ];
  const now = before.replace('<p>Two.</p>', '<p>Two, edited.</p>');
  const { html, stale } = applyEnhanced(now, answers);
  assert.deepEqual(stale, [2]);
  assert.equal(scriptOf(html, 1), '[sighs] One.');
  assert.equal(scriptOf(html, 2), 'Two, edited.');
});

test('no agent at all is a refusal naming what is missing, before anything is asked', async () => {
  await assert.rejects(enhanceDeck(deck('<p>One.</p>'), null, { resolveAgent: () => null, env: { PATH: '' } }),
    /no agent CLI is detected|install one/);
});

test('the command wants a deck and a choice of slides', async (t) => {
  const errs = [];
  t.mock.method(console, 'error', (m) => errs.push(String(m)));
  t.mock.method(console, 'log', () => {});
  assert.equal(await enhanceMain([]), 1);
  assert.equal(await enhanceMain(['no-such-deck.html', '--all']), 1);
  assert.match(errs.at(-1), /no such deck/);
  assert.equal(await enhanceMain(['--help']), 0);
});
