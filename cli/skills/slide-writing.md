---
name: decklight-slide-writing
description: Write, review or rewrite what is ON the slides of a Decklight deck so each slide makes one point with a visual and few words. Plans a deck's story as headlines, turns bullet walls into diagrams, numbers, charts and comparisons, and critiques slides as the viewer would see them. Use when asked to draft slides from a topic or material, to make slides less wordy or more visual, to review or improve slide content, or to plan a deck. English and French. The spoken script belongs to the decklight-voiceover skill.
---

This skill is about what goes on a slide: the words, the picture, and what is
left for the voice. The `decklight` skill beside it is the contract for how a
deck is built (markup, builds, diagrams, themes); read that for syntax and use
this for judgement. The speaker notes are the `decklight-voiceover` skill's.
When a task covers both, plan once with the outline below and use both skills.

## The rule everything else follows from

**The slide shows, the voice explains.** A slide holds one claim, as a
sentence, and the evidence for it: a diagram, a number, a chart, a picture,
code. The voice carries what a screen cannot: the reason, the link from the
previous slide, the example, the answer to the viewer's doubt.

Two consequences, both easy to get wrong:

- A slide that holds the full explanation leaves the voice nothing to do but
  read it. That is the most common fault in a narrated deck.
- An empty slide is not the cure. A short headline and labels, worded
  differently from the narration, help the viewer. A transcript hurts, and so
  does nothing at all. The exact numbers, names and terms the viewer must
  keep belong on screen.

## Pick the mode

| The user wants | Mode |
|---|---|
| A new deck, or "what should this deck say" | **Plan**, then **Write** |
| Slides from an agreed outline or from material | **Write** |
| An opinion on existing slides | **Review**: report, change nothing |
| Existing slides improved | **Rewrite**: change in place |

Starting from nothing, always plan first, and show the plan before writing
slides unless the user asked for the deck in one go. Asked to "improve" a
deck with no further detail, review first, say what you found in a few lines,
then rewrite.

## Plan: the story before the slides

Settle these before any slide exists. They are the same in the
`decklight-voiceover` skill, so slide and voice are designed together.

1. **The viewer.** Who they are, what they already know, what they want from
   this.
2. **The throughline.** The deck's one idea in 15 words or fewer. If it will
   not fit, the deck is about two things.
3. **The deck type**, which sets where the answer sits (see the table below).
4. **The ending.** What the viewer can do, decide or believe afterwards, as
   one sentence they could repeat.
5. **Per slide**, one row:

   | Field | What goes in it |
   |---|---|
   | Idea | The slide's one point, as a full sentence |
   | Viewer's question | What a sceptical viewer is wondering at this moment |
   | The slide shows | The visual form, and the few words on it |
   | The voice adds | The reason, link, example or caveat |
   | Beats | What appears, in order, one build per beat |

Then test the plan:

- **Read the headlines in order, alone.** They should tell the whole story.
  A headline that only names a topic ("Architecture") is a gap in the story.
- **The first slide after the title opens a problem, a question or a
  surprising fact.** Not an agenda, not an introduction of the speaker.
- **Every slide serves the throughline** or is cut. Most material does not
  make it in. That is the plan working.
- **Each new term is introduced before the slide that depends on it.**

If the material is really a document (it needs 150 words a page to make
sense, or the reader must study a table), say so: a written page plus a short
narrated summary serves the viewer better than a deck of dense slides.

## Write: one claim, one piece of evidence

**The headline is a sentence that could be false.** "Caching cut the bill by
a third", not "Caching results". Two lines at most. A viewer who reads only
the headline should get the point. Sentence case, no full stop.

**The body is evidence, not a restatement.** Ask what the bullets really are,
and draw that instead:

| What the bullets really are | Put this on the slide | Decklight tool |
|---|---|---|
| Steps, a flow, cause and effect | A diagram that builds step by step, labels on the parts | SVG_DIAGRAMS, `draw` builds (BUILD_ENTRANCES) |
| Parts of a system | A labelled diagram, four or fewer new things per step | `data-build` with `highlight` |
| One fact that carries the slide | One large number and a short label | A centered statement slide |
| A claim resting on data | One chart, a takeaway title, one highlighted series | CHARTS |
| Two options, before and after | A side-by-side with identical layout | `data-layout="split"` (COMPARISON_SLIDES) |
| A memorable line or a voice of authority | A short quote | A quote or statement slide |
| A concrete thing, place or feeling | A relevant full-bleed picture | `data-background-image`, `data-background-dim` |
| How to do something in code | A trimmed snippet, one region highlighted at a time | `data-lines` (CODE_AND_MATH) |
| How to do something in a terminal | A real recording | `decklight cast` (TERMINAL_RECORDINGS) |
| Truly parallel items | A list of at most four, revealed one at a time | `data-build` on the list |

A list that is really several ideas is several slides.

**Budgets.** These are working defaults, not laws:

- About 20 words on a slide. Look hard at anything past 40.
- A list has at most four items, each one or two lines, built one at a time.
- At most four new things appear in one build step.
- If the title needs an "and", it is two slides (SLIDE_DENSITY).

**What earns more words on screen:** technical terms, symbols, code,
equations, numbers the viewer must keep, a second-language audience, and a
slide with no graphic at all. Code is evidence, not prose: cut every line not
needed for the point, keep the type large, highlight only the part being
talked about.

**Labels sit on the thing they name**, not in a legend the eye has to travel
to.

**Builds follow the voice.** Each thing appears when the voice reaches it, so
plan one build per beat of narration. If nothing new is being said, nothing
should move: viewers assume a change means something.

**The most important statement is the most prominent text.** Never a
sub-point under a reassuring title.

**Cut the decoration.** Anything that could be deleted without losing the
point should be: stock pictures that illustrate nothing, logos on every
slide, a second chart "for context".

**Never shrink type to make it fit.** Split the slide or move the sentence to
the notes.

A worked example. Before, a bullet wall:

```html
<section>
  <h2>Caching results</h2>
  <ul>
    <li>We added a cache in front of the database in March</li>
    <li>The cache hit rate is now 94%</li>
    <li>Database load dropped significantly as a result</li>
    <li>Monthly costs went down by about a third</li>
  </ul>
</section>
```

After, a claim and its evidence, with the story moved to the voice:

```html
<section>
  <h2>Nineteen requests in twenty never reach the database</h2>
  <p class="stat">94%</p>
  <p>cache hit rate since March</p>
  <aside class="notes">
    In March we put a cache in front of the database. Here's what it did.
    [pause] Almost everything is answered before the database is even asked.
    That's why the bill went down by a third.
  </aside>
</section>
```

(`stat` here stands for whatever large-number treatment the deck's theme or
design system offers; use the real one.)

## Review: watch it as the viewer would

Go through the deck slide by slide **with the notes hidden first**, as a
viewer on mute would, then with the notes. Report against this list. Name
each slide by its title, quote the offending words, and give the specific
fix, never a general remark.

1. Does the slide make one point, sayable in one sentence?
2. Would a first-time viewer get it in about three seconds?
3. Is the headline a full-sentence takeaway in two lines or fewer, not a
   topic?
4. Does the body show evidence for the headline, or does it restate what the
   voice says?
5. Does any on-screen sentence repeat a narration sentence word for word?
6. About 20 words, at most 40? Lists of at most four items, two lines each?
7. Could anything be deleted without losing the point?
8. Is the most important element the most salient, with one emphasis at a
   time?
9. Do labels sit on the things they name?
10. Does each element appear when the voice reaches it? Does anything move
    without meaning?
11. Was every term, symbol and acronym introduced already?
12. Are the numbers, names and exact terms the viewer must keep on screen?
13. Does a chart have a takeaway title, labelled axes and one highlight? Does
    code show only the needed lines, large, with one highlighted region?
14. Is the most consequential statement the most prominent text?
15. Do the headlines, read in order, tell the whole story?
16. Decklight: no `crowded` warning, no overflow, no type shrunk by hand
    anywhere on the slide, including inline styles on inner elements.

Run `npx decklight@latest check deck.html` for item 16 and for `[click]`
counts against builds. Items 2, 7, 8 and 14 need a rendered look: render the
deck (`npx decklight@latest pdf deck.html -o /tmp/check.pdf`) when you can,
and say so plainly when you could not.

End the review with the three changes that would help most, in order. A long
flat list of findings is itself a bullet wall.

## Rewrite: change in place, lose nothing

- **Keep the idea.** A rewrite changes how a point is shown, not what the
  author is claiming. A new claim, number or example is the author's to
  approve: flag it.
- **Move, do not delete.** A sentence that leaves the slide goes into the
  notes, where the voice can say it, unless it served nothing.
- **Name the relationship the bullets hide** (a sequence, a comparison, a
  cause) and draw it.
- **Split a slide whose title needs an "and".**
- **Keep the build count where you can.** The notes are cut into beats by
  `[click]`, one per build. If you add or remove builds, the notes must
  change with them: do it with the `decklight-voiceover` skill, or tell the
  user exactly which slides now need their beats redone. Run `check` and
  clear every `clicks-vs-builds` warning before you finish.
- **Keep the terms the notes use.** If the slide's wording changes, the notes
  should still call the thing by the same name.

For light-touch edits the deck's own writing tools do the mechanical part
(PRESENTING_WRITING in the reference): tightening a slide's text and bringing
it back in line with its script. They never add or restructure. This skill
does.

## What changes with the deck type

| | Technical talk | Course or lesson | Demo or pitch | Internal update or decision |
|---|---|---|---|---|
| Where the answer sits | After the problem. Aim for intuition, not coverage | After the question: name it, show it, use it | The viewer's current pain first, then "today" against "with this" | First. Then two or three reasons, the risks, the ask |
| Density | More text is earned by code, terms and equations | Strictest: one new concept per slide | Largest type, one number or picture per slide | Few words. Detail goes in a separate document |
| Typical evidence | Diagram, trimmed code, one benchmark | Worked example built step by step | The product doing the thing, one capability at a time | One chart, one table of options |
| Ending | Where the detail lives, what to try | What the learner can now do | One specific next step | The decision wanted, by when |

For lessons, short units work best: aim for under six minutes each.

## French

Write French slides from the idea, never from the English wording.

- **Length.** French runs 15 to 25 percent longer, and a short headline can
  double. Rewrite the headline until it fits. Do not shrink the type.
- **Titles in sentence case**: « Le cache divise la facture par trois », no
  capital on every word.
- **Spacing.** A non-breaking space (U+00A0) before a colon and inside
  « guillemets ». Before `;` `!` `?`, a narrow non-breaking space (U+202F) in
  France and none in Quebec. Without them a line wraps and starts with a
  lone « ? ». Ask which locale when it matters and the deck does not say.
- **Numbers.** Decimal comma, a space before the unit and the percent sign:
  « 1,5 s », « 20 % », « 12 € ».
- **Technical terms.** Keep the English noun the viewer will see in the tool
  (pull request, commit). Use the French word where it is truly in use
  (bibliothèque, mise à jour, déployer). Lean more French for Quebec.
- **Tone.** Superlatives read as salesmanship. State the concrete benefit.
- Set `<html lang="fr">` so the deck's voices follow.

## Before you call it done

- `npx decklight@latest check deck.html` is clean of `crowded` and
  `clicks-vs-builds`.
- Nothing overflows (the `decklight` skill says how to render and check).
- The headlines, read alone and in order, tell the story.
- No slide could be read aloud as its own narration.
