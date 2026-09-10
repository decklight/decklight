// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Somebody else's slide with somebody else's words taken out (`UNITS#REST`).
 *
 * A template slide is worth taking for its SHAPE — a three-card row, a split
 * with an eyebrow, a table that pins its header. Its words are the words of the
 * talk it was written for, and carrying them into your deck gives you a slide
 * that says nothing you mean while LOOKING finished, which is how somebody
 * else's pricing ends up on a slide behind you.
 *
 * So the markup lands and the prose does not. What replaces it is the same
 * NUMBER of words, because a template slide is a layout and a layout is only
 * honest at roughly the length it was drawn for: swap eleven words for two and
 * the card you were judging stops being the card you get.
 *
 * What is never touched:
 *
 * - `pre`, `code`, `script`, `style` — a code sample is structure, not prose.
 *   Loremising one produces a slide that teaches nothing and no longer parses,
 *   and templates about software are full of them.
 * - `CLICK` beats in the speaker notes — those are the build's clock
 *   (`NARRATION`), not sentences. Replacing them would silently unpace every
 *   build on the slide.
 * - entities, and anything with no letters in it: numbers, arrows, and
 *   punctuation that is doing typographic work.
 */

const WORDS = ('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
  + 'incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation '
  + 'ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit '
  + 'voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non '
  + 'proident sunt culpa qui officia deserunt mollit anim id est laborum').split(' ');

/** A placeholder shaped like the word it replaces: its case, its punctuation. */
function like(token, word) {
  const lead = /^[^\p{L}\p{N}]*/u.exec(token)[0];
  const tail = /[^\p{L}\p{N}]*$/u.exec(token)[0];
  const core = token.slice(lead.length, token.length - tail.length);
  if (!core) return token;
  const cased = core === core.toUpperCase() && core.length > 1 ? word.toUpperCase()
    : core[0] === core[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1)
      : word;
  return lead + cased + tail;
}

/** One run of visible text, word for word. Whitespace and layout are kept. */
export function loremRun(text, rnd = Math.random) {
  return String(text).replace(/\S+/g, (token) => {
    if (/[\u27E8\u27E9]/.test(token)) return token;        // a build beat
    if (/^&[#\w]+;$/.test(token)) return token;             // an entity
    if (!/\p{L}/u.test(token)) return token;                // numbers, arrows, punctuation
    return like(token, WORDS[Math.floor(rnd() * WORDS.length)]);
  });
}

/**
 * A section's prose replaced, its markup untouched.
 *
 * Protected elements are stashed whole before any text is looked at, so nothing
 * inside them can match the text-node pass — the trick `scannable` uses to keep
 * a slide that TEACHES markup from being read as markup.
 */
export function loremize(html, rnd = Math.random) {
  const stash = [];
  const mark = (i) => `\u0001${i}\u0001`;
  const stashed = String(html ?? '').replace(
    /<(pre|code|script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    (m) => mark(stash.push(m) - 1),
  );
  const swapped = stashed.replace(/>([^<]+)</g, (m, text) => `>${loremRun(text, rnd)}<`);
  return swapped.replace(/\u0001(\d+)\u0001/g, (m, i) => stash[Number(i)]);
}

/**
 * A random-enough sequence that is the SAME every time for the same slide.
 *
 * The preview and the insert are two separate runs of `loremize`, and with
 * `Math.random` they would disagree about every word — a preview that is right
 * about the layout and wrong about the text it is showing you. Seeding both
 * from the slide's identity makes the preview what you get, which is the whole
 * claim the preview makes. mulberry32: eight lines, no dependency, and nothing
 * here is cryptography.
 */
export function seeded(key) {
  let h = 2166136261;
  for (const ch of String(key)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
