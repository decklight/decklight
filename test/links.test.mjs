// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// What a link typed into a slide may point at (src/core/links.js, SPEC
// PRESENTING_EDITING): accepted as typed, normalised, or refused with a
// reason. The box ⌘K opens asks this rule and nothing else, so a wrong answer
// here is a link in the file. The refusals are checked against the
// ingredients label's own scanner (cli/audit.mjs, NO_TRUST#AUDIT): what the
// editor writes, the auditor must never name, and what the auditor names,
// the editor must refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkTarget, resolvedScheme, slideSuggestions } from '../src/core/links.js';
import { executableAttributes } from '../cli/audit.mjs';

const ok = (raw, href, kind, opts) => {
  const t = linkTarget(raw, opts);
  assert.equal(t.ok, true, `${JSON.stringify(raw)} should be accepted: ${t.why}`);
  assert.equal(t.href, href, JSON.stringify(raw));
  if (kind) assert.equal(t.kind, kind, JSON.stringify(raw));
  return t;
};
const refused = (raw, re, opts) => {
  const t = linkTarget(raw, opts);
  assert.equal(t.ok, false, `${JSON.stringify(raw)} should be refused, got ${t.href}`);
  if (re) assert.match(t.why, re, JSON.stringify(raw));
  return t;
};

test('web and mail addresses are kept as typed, the scheme lowercased', () => {
  ok('https://example.com/a?b=1#c', 'https://example.com/a?b=1#c', 'web');
  ok('http://example.com', 'http://example.com', 'web');
  ok('HTTPS://Example.com/Path', 'https://Example.com/Path', 'web');
  ok('  https://example.com  ', 'https://example.com', 'web');
  ok('mailto:ana@example.com', 'mailto:ana@example.com', 'mail');
  ok('mailto:ana@example.com?subject=Hi', 'mailto:ana@example.com?subject=Hi', 'mail');
});

test('a bare domain becomes https, and so does a protocol-relative one', () => {
  ok('example.com', 'https://example.com', 'web');
  ok('www.example.com/docs?x=1', 'https://www.example.com/docs?x=1', 'web');
  ok('docs.example.co.uk/a', 'https://docs.example.co.uk/a', 'web');
  ok('example.com:8080/x', 'https://example.com:8080/x', 'web');
  ok('//cdn.example.com/a.pdf', 'https://cdn.example.com/a.pdf', 'web');
});

test('a slide of this deck is #/N, however it was typed', () => {
  assert.equal(ok('#/3', '#/3', 'slide', { slides: 5 }).slide, 3);
  ok('#3', '#/3', 'slide', { slides: 5 });
  ok('3', '#/3', 'slide', { slides: 5 });
  ok('#/03', '#/3', 'slide', { slides: 5 });
  ok('#/3/2', '#/3/2', 'slide', { slides: 5 });
  refused('#/9', /this deck has 5 slides/, { slides: 5 });
  refused('#/2', /this deck has 1 slide$/, { slides: 1 });
  refused('#/0', /from 1/, { slides: 5 });
  refused('#intro', /goes to a slide: #\/3/);
});

test('a file beside the deck is a relative path, spaces written %20', () => {
  ok('notes.pdf', 'notes.pdf', 'file');
  ok('./notes.pdf', './notes.pdf', 'file');
  ok('docs/guide.html', 'docs/guide.html', 'file');
  ok('../shared/diagram.png', '../shared/diagram.png', 'file');
  ok('./my notes.pdf', './my%20notes.pdf', 'file');
  ok('appendix', 'appendix', 'file');
  refused('/slides/notes.pdf', /site root/);
});

test('code-running and unknown schemes are refused with a reason', () => {
  refused('javascript:alert(1)', /javascript: links run code/);
  refused('JavaScript:alert(1)', /javascript:/);
  refused('vbscript:msgbox', /vbscript: links run code/);
  refused('data:text/html,<script>alert(1)</script>', /data: link carries a page/);
  refused('data:image/png;base64,AAAA', /data:/);
  refused('file:///etc/passwd', /file: is not a link a deck can carry/);
  refused('tel:+15551234', /tel:/);
  refused('ftp://example.com', /ftp:/);
});

test('the scheme is read as a browser reads it, spelled however', () => {
  // the spellings NO_TRUST#AUDIT resolves: character references, and the
  // whitespace and control characters a browser drops inside a scheme
  for (const v of ['jav&#x61;script:alert(1)', 'jav&#97;script:alert(1)', 'java\tscript:alert(1)', ' java\nscript:x', 'javascript&colon;alert(1)', '\u0001javascript:x']) {
    assert.equal(resolvedScheme(v), 'javascript', JSON.stringify(v));
    refused(v, /javascript:/);
  }
});

test('nothing empty, half-typed or spaced is written', () => {
  refused('', /type an address/);
  refused('   ', /type an address/);
  refused('https://', /needs a site/);
  refused('http:example.com', /needs a site/);
  refused('mailto:', /needs an address/);
  refused('mailto:nobody', /needs an address/);
  refused('https://example.com/a b', /no spaces/);
  refused('example.com/a b', /no spaces/);
  refused('foo.bar baz', /not a site or a file/);
});

test('the auditor never names what the editor writes, and the editor refuses what it names', () => {
  const accepted = ['https://example.com', 'example.com', 'mailto:a@b.co', '#/2', 'notes.pdf', './a b.pdf', '//x.example.com/a'];
  for (const raw of accepted) {
    const { href } = linkTarget(raw, { slides: 5 });
    const html = `<a href="${href.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">x</a>`;
    assert.deepEqual(executableAttributes(html), [], `${raw} → ${href} would be named by the ingredients label`);
  }
  const named = ['javascript:alert(1)', 'jav&#x61;script:alert(1)', 'java\tscript:x', 'data:text/html,hi'];
  for (const raw of named) {
    assert.equal(executableAttributes(`<a href="${raw}">x</a>`).length, 1, `the label names ${JSON.stringify(raw)}`);
    assert.equal(linkTarget(raw).ok, false, `the editor refuses ${JSON.stringify(raw)}`);
  }
});

test('slides are offered for # or a number, a few at a time', () => {
  const titles = Array.from({ length: 14 }, (_, i) => `Title ${i + 1}`);
  assert.deepEqual(slideSuggestions('#', titles).map((s) => s.slide), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(slideSuggestions('#/', titles, { max: 3 }).map((s) => s.slide), [1, 2, 3]);
  assert.deepEqual(slideSuggestions('1', titles).map((s) => s.slide), [1, 10, 11, 12, 13, 14]);
  assert.deepEqual(slideSuggestions('#/12', titles), [{ slide: 12, title: 'Title 12', href: '#/12' }]);
  assert.deepEqual(slideSuggestions('#9', titles).map((s) => s.href), ['#/9']);
  assert.deepEqual(slideSuggestions('#/99', titles), []);
  assert.deepEqual(slideSuggestions('https://', titles), []);
  assert.deepEqual(slideSuggestions('', titles), []);
});
