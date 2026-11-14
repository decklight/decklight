---
name: decklight-voiceover
description: Write, review or rewrite the spoken script of a Decklight deck (the speaker notes that become its narration) so it sounds like a person talking to one viewer, adds to the slide instead of reading it, tells a story, answers the viewer's questions, and is spoken well by a synthetic voice or a live presenter. Use when asked for narration, a voiceover, speaker notes or "what do I say on this slide", when a script sounds flat, robotic or like a lecture, or to review or improve an existing script. English and French. What goes on the slides belongs to the decklight-slide-writing skill.
---

This skill is about the words that are spoken: the `<aside class="notes">` of
each slide, which Decklight narrates, captions and exports. The `decklight`
skill beside it is the contract for the markup; the `decklight-slide-writing`
skill decides what is on screen. When a task covers both, plan once with the
outline below and use both skills.

## The rule everything else follows from

**The slide shows, the voice explains.** The viewer can read the slide faster
than any voice can say it. So the voice never reads it. It says what the
screen cannot:

- **the link** from the previous slide ("That's the good news. Here's the
  catch.")
- **the reason** behind the claim on screen
- **the example** that makes it concrete
- **the caveat** an honest person would add
- **the answer** to what the viewer is wondering right now

A slide shows "Cache hit rate: 94%". Reading it: "Our cache hit rate is
ninety-four percent." Explaining it: "Nineteen requests in twenty never touch
the database. That's why the bill went down."

**The test:** cover the notes and look at the slide, then cover the slide and
read the notes. If either alone tells the whole story, one of them is a copy.

The default voice is **a knowledgeable friend talking to one person**: warm,
direct, plain, a little dry. Not a lecturer, not a presenter working a room,
not an advert.

## Pick the mode

| The user wants | Mode |
|---|---|
| A new deck, or "what should this deck say" | **Plan**, then **Write** |
| A script for slides that exist | **Write** |
| An opinion on an existing script | **Review**: report, change nothing |
| An existing script improved | **Rewrite**: change in place |

Starting from nothing, always plan first, and show the plan before writing
unless the user asked for everything in one go. Asked to "improve" a script
with no further detail, review first, say what you found in a few lines, then
rewrite.

## Plan: the story before the script

Settle these before writing a line. They are the same in the
`decklight-slide-writing` skill, so slide and voice are designed together.

1. **The viewer.** Who they are, what they already know, what they want from
   this.
2. **The throughline.** The deck's one idea in 15 words or fewer.
3. **The deck type**, which sets the story's shape (see the table below).
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

Then, for the voice:

- **Open a gap in the first thirty seconds.** A problem, a question or a
  surprising fact, before any agenda or introduction. Promise the answer.
  Write these first sentences with the most care.
- **Do the empathy pass, slide by slide.** What does the viewer know on
  arrival? What is the one new thing here? What would they object to or ask?
  Which word appears for the first time? You know the material; the viewer
  does not, and the steps that feel too obvious to say are the ones they
  need.
- **Alternate "how it is" with "how it could be".** A stretch that is all
  facts needs one line of what they make possible. That is where the stakes
  come from.
- **Choose the two or three moments that deserve a pause**, and the one or
  two that could carry a light remark. Most slides get neither.

## Write

### Beats: the voice and the builds move together

The notes are cut into beats by a bare `[click]`. Beat zero is spoken when
the slide arrives, and each `[click]` reveals the next build and speaks the
next beat. This timing matters more than any wording: words must arrive with
the thing they describe.

- **One beat per build.** Count them. `npx decklight@latest check deck.html`
  reports a mismatch as `clicks-vs-builds`.
- **Beat zero frames the slide** before anything builds: the link from the
  last slide and the question this one answers.
- **Each beat is one complete thought, one to three sentences**, about 10 to
  35 words. Its first words point at what just appeared.
- **Ask, then reveal.** A question before `[click]`, the build as the answer,
  is the strongest pattern there is: "So did the agent stay on brand?
  `[click]` Check says no."
- **Do not split a sentence across a `[click]`** unless you want the half
  second of silence in the middle of it.

```html
<aside class="notes">
  That's the good news. Here's the catch: every one of those requests still
  starts in the same place.
  [click]
  The load balancer. One machine, and everything goes through it.
  [click]
  So what happens when it has a bad day? [pause] All of this goes dark at
  once.
</aside>
```

### Write for the ear

A listener cannot re-read. Every rule here follows from that.

- **One idea per sentence.** "My dad, who spent forty years teaching physics, is
  a smart guy" becomes "My dad taught physics for forty years. He's a smart
  guy."
- **Keep the subject next to its verb.** No clause in between.
- **About 20 words at most, 25 as a ceiling.** Short sentences look choppy on
  the page and sound right aloud.
- **Vary the length on purpose.** Three sentences of the same length in a row
  sound mechanical in any voice. Follow a long one with a short one. Give the
  key point a short sentence of its own.
- **Words people say.** "Use", not "utilise". "Before", not "prior to".
  "To", not "in order to". Contractions: "it's", "you'll", "don't".
- **"You" and "we".** Not "users", not "one", not the passive. "Look at the
  spike", not "it can be seen that".
- **Repeat the noun.** "The cache", again, not "it" or "the latter". The
  listener cannot look back to see what "it" was.
- **One number per sentence, rounded, as a relationship.** "About a third
  less", while the slide shows the exact figure.
- **Explain a new word in the sentence that uses it.** "A write-ahead log,
  which is just a diary the database keeps before it changes anything."
- **Give every abstraction a concrete case** within two sentences.
- **Say it aloud.** If you would not say it that way to a colleague, do not
  write it that way.

### Answer the question in the viewer's head

At each slide a thinking viewer has a question or a doubt. Say it for them,
then answer it: "You might be wondering why we don't just add a second one."
"Fair question: doesn't that cost more?" Answer on this slide or the next.
An objection left hanging is a viewer who has stopped listening.

A rhetorical question is the conversational form of the same thing. About one
a slide, and always answered.

### Connect the slides

The first sentence of a slide links from the one before, in words, because a
listener cannot see a section break. "So that's the write path. Reading is
where it gets interesting." Never "In this slide we will look at", and never
"Moving on".

### Pauses

Decklight already breathes: a quarter second between sentences, half a second
at each `[click]`, a second before the slide turns. So a full stop is a small
pause and a `[click]` a larger one. `[pause]` adds a full second and
`[long pause]` two.

Use `[pause]` at the few moments that earn it: after a number that should
land, before a reveal, after a hard idea. Two or three in a deck of ten
slides is plenty. A pause after everything is a pause after nothing.

### Humour

Light and occasional: a wry aside or an unexpected plain comparison every few
minutes, never a set-piece joke. Rules:

- **It is about the material**, and it comes right after a point, as a
  release.
- **It is literally true.** A synthetic voice says sarcasm and irony
  straight, and so does a listener in their second language. Prefer the
  understated observation: "This took three weeks. Two of them were arguing
  about the name."
- **The test: if nobody laughs, is it still a true and useful sentence?** If
  not, cut it.
- **Never** at anyone's expense, and never on a slide carrying a decision, a
  risk or bad news. No puns, no pop-culture references.
- A script with no jokes is fine. A script with a forced one is not.

### How much to say

Plan at about **150 words a minute**. A slide normally carries 60 to 150
words. One static slide with more than about a minute of talk needs more
builds, or to be two slides. Dense material gets fewer words per slide, not a
faster voice, and easy material is not padded.

A rough length for a slide, in seconds: words divided by 2.5, plus a second
for each `[pause]` and for the slide turn, plus half a second per `[click]`.

### The ending

The last slide says what the viewer can now do, decide or believe, in one
sentence they could repeat, and names one next step. Not "In conclusion, we
covered A, B and C", and not "Thank you, any questions?".

## One script, every performer

The same notes are spoken by an ElevenLabs voice, by any other engine or the
browser's own voice, and by a person reading them live or into a microphone.
They are also the captions and the transcript. So:

**The script must work delivered flat.** No line may need a tone of voice, a
gesture or a look to make sense.

- Put the important word at the end of the sentence, or in its own short
  sentence. That is the only emphasis every performer gives you.
- Start a question with a question word, so it sounds like one.
- Give a punchline its own sentence, after a full stop.
- No parentheses. An aside is its own sentence.
- Rephrase around words with two readings ("read", "live", "lead", "close").

### How Decklight speaks, and what it means for the writing

Every sentence is synthesised as its own clip, with no knowledge of the
sentences around it. This shapes the writing more than anything else:

- **Each sentence is a complete thought.** Intonation does not carry across a
  full stop.
- **A period anywhere ends the clip.** "Version 2.5" is spoken as "Version
  two" and then "five", with a breath between. So no periods inside a
  sentence: write "two point five", "for example" instead of "e.g.", "the
  index file" instead of "index.html", "Mister" instead of "Mr.".
- **Very short clips are fragile.** A short sentence for emphasis is good. A
  chain of fragments ("Fast. Cheap. Reliable.") is three tiny clips: make it
  one sentence.
- **Keep sentences under about 25 words.** Some browser voices cut off a long
  one.

**Write everything the way it is said.** The exact written form stays on the
slide; the spoken form goes in the notes.

| On the slide | In the notes |
|---|---|
| 12 regions | twelve regions |
| $42.50 | forty-two dollars fifty |
| 94% | ninety-four percent, or "nineteen in twenty" |
| ⌘Z, Ctrl+T | Command Z, Control T |
| v2.5 | version two point five |
| p99 < 200 ms | ninety-nine in a hundred requests come back in under a fifth of a second |
| `npm run build` | "the build command", unless the viewer must type it |
| API, URL | fine as they are; an acronym the voice might read as a word gets spelled out or rephrased |

Never read code or a URL aloud. Say what it does and let the slide show it.

There is no markup for pronunciation or emphasis. If a voice says a name
badly, reword. Do not respell it, because the notes are also the captions.

### Audio tags

Bracketed words other than `[click]` and the pauses, such as `[curious]`,
`[whispers]` or `[laughs]`, are directions for ElevenLabs' newest voices.
Every other voice, every caption and every human reader skips them.

- **The script must read well with every tag removed.** Write it without
  tags first.
- One or two a slide at most, right before the words they direct, and only
  where a person would actually change their delivery.
- Never on a very short sentence: that is the shape that makes a take
  stutter.
- No capitals for emphasis, no `<break>` tags, no ellipses for effect. They
  show in captions and are read differently by every voice.

To add tags to a finished script without touching its words, `decklight
enhance deck.html --slides 3` does it and checks that every word, `[click]`
and `[pause]` survived.

## Review: read it as the viewer

Three passes. First read the script straight through with the slides, at
speaking pace, as someone who has never seen the material. Then read it
without the slides. Then run the list. Name each slide by its title, quote
the offending sentence, and give the rewrite, never a general remark.

1. Does the deck's one idea fit in 15 words, and does every slide serve it?
2. Do the first thirty seconds open a problem, a question or a gap, before
   any agenda?
3. Does each slide's narration say something the slide does not? Does any
   sentence repeat the slide word for word?
4. Does each beat talk about what is on screen at that moment? Do the
   `[click]` counts match the builds?
5. Does the first sentence of each slide link from the previous one?
6. One new concept per slide, one number per sentence, no term left
   unexplained?
7. Is the sceptical viewer's question answered here or on the next slide?
8. Any sentence over about 25 words, with two ideas, or with a clause between
   subject and verb? Any word nobody says?
9. Any run of three sentences of the same length? Does the key point have
   room after it?
10. Does every abstraction get a concrete case within two sentences?
11. Is it addressed to one person, as "you" and "we", with no filler
    enthusiasm?
12. Is each light line about the material, literally true, and still useful
    if nobody laughs?
13. Does any single static slide carry more than about a minute of talk?
14. Does the last slide say what the viewer can now do or decide, in one
    repeatable sentence?
15. Does any line need a tone, a look or a gesture to work?
16. For the voice: numbers, symbols, keys and abbreviations written as said;
    no period inside a sentence; no sentence split across a `[click]` by
    accident; no chain of fragments; no tag on a very short sentence; reads
    well with the tags removed.

The faults to expect, and the move that fixes each:

| Fault | Sounds like | Fix |
|---|---|---|
| Reads the slide | "There are three key benefits: speed, reliability and cost." | Pick the one that matters and give its reason |
| Announces | "In this slide, we will look at the architecture." | Start with the content: "So where does a request actually go?" |
| Lecture voice | "It is important to note that latency is a critical factor." | "Slow pages lose people. You've closed a tab for less." |
| Flat rhythm | Every sentence 18 to 22 words | Break one in two, give the key point its own short sentence |
| Vague and hedged | "can potentially offer significant improvements in various scenarios" | One number and one case, hedges removed |
| Starts cold | Each slide begins as if nothing came before | Open with the link from the last slide |
| Assumes too much | Acronyms and names used as if the viewer had read the source | Explain at first use, in the same sentence |
| Says everything | Every fact from the source kept | Keep what serves the throughline |
| Sells | "powerful", "seamless", "game-changing" | Cut the adjective, give one concrete result |
| Recap ending | "In conclusion, we covered A, B and C." | One repeatable sentence and one next step |
| Forced joke | A pun or a reference | Cut it, or a dry true observation |

End the review with the three changes that would help most, in order.

## Rewrite: change in place

- **Keep every `[click]` and `[pause]`, and the number of beats.** The builds
  depend on them. If a slide truly needs a different number of beats, its
  builds must change too: say so, and use the `decklight-slide-writing`
  skill.
- **Keep the facts, the numbers and the terms** the slide uses.
- **Change freely:** the register, the order within a beat, the rhythm, the
  links between slides.
- **You may add what is missing**: the reason, the example, the transition,
  the answer to the obvious question. This is what the deck's own tools will
  not do. But anything that is a new claim, a new number or a joke is the
  author's to approve. List what you added, slide by slide, when you finish.
- **Keep the rehearse aside in step.** A slide may carry an `<aside
  class="rehearse">`, the presenter's short cue card, cut by the same
  `[click]` beats. When the notes change meaning, update it.
- **Recorded voices.** If the deck already has recorded narration, rewritten
  notes no longer match it. Say which slides need recording again.

For light-touch edits the deck's own tools do the mechanical part, each with
the same checks on beats and pauses: `decklight enhance deck.html --spoken
--slides 3` turns terse notes into speech, and `--match-slide` brings notes
back in line with a slide whose wording changed. Neither adds anything.

## What changes with the deck type

| | Technical talk | Course or lesson | Demo or pitch | Internal update or decision |
|---|---|---|---|---|
| Story shape | Problem, idea, one example, where the detail lives | Question, concept, example, recap, per segment | The viewer's pain, then "today" against "with this", ending on the reward | Situation, complication, the answer, then reasons and risks |
| The voice carries | Intuition and motivation. The detail is elsewhere | The teaching. A prediction question before each reveal | Stakes and contrast. What a feature lets you do, and honest limits | The answer first. Numbers rounded in speech, exact on the slide |
| Register | Dry, lighter on "you" for experts | Fullest "you" and "we", slower on the dense parts | Warm and concrete, no superlatives | Plain and brief |
| Humour | Sparse and dry | Only to illustrate what was just taught | Light, never about a competitor | Least |
| Ending | What to try, where to read more | What you can now do | One specific next step | The decision wanted, by when |

In a demo, the voice says what is happening while the product does it, one
capability at a time.

## French

**Write the French script from the outline, never from the English script.**
Use the other language only to check that no beat was dropped. Set `<html
lang="fr">` and choose a French voice: the text decides the language, the
voice decides the accent.

- **Address.** « Vous » for the viewer, « on » for the shared "we" and for
  people in general, « nous » only for the company or team. « Tu » is a
  deliberate choice for the author to make, not a default.
- **Sounding spoken.** French has no contractions, so the spoken feel comes
  from « on », « ça », questions with « est-ce que », the futur proche (« on
  va voir »), the present and the passé composé, and « c'est… qui/que » for
  emphasis. Keep the « ne ». No passé simple. No stacked subordinate clauses:
  subject, verb, complement, one idea per sentence.
- **Structure.** Keep the opening hook, then say the question and a short
  road map aloud (« On va voir trois choses. »). French viewers expect to
  know where the argument is going. Raise the objection yourself (« Vous
  allez me dire… »). Close with a one-line synthesis, then the next step.
- **Enthusiasm.** Superlatives sound like a sales pitch. State the concrete
  benefit.
- **Humour.** Never translate a joke: write a new one in French or drop it.
  Irony and « second degré » are said straight by a synthetic voice, so
  prefer understatement (« Ce n'est pas exactement rapide. »).
- **English terms.** Keep the English noun the viewer will see in the tool
  (pull request, commit). Use the French word where it is in real use
  (déployer, mise à jour, bibliothèque). Do not conjugate English verbs
  (« on merge »). One or two English terms per sentence at most, and never a
  sentence that is only an English name, which a French voice may mangle.
- **Numbers in letters** where the reading matters: « quatre-vingt-dix »,
  « un virgule cinq ». No abbreviations with periods (« M. », « p. ex. »):
  the period ends the clip, as in English.
- **Length.** The same content takes more words and a little more time in
  French. To hold a time slot, cut content. Do not speed the voice up.
- **Calques to avoid.** « Ça se tient » or « c'est logique », not « ça fait
  du sens ». « Allez, on y va », not « plongeons ». « J'ai hâte de vous
  montrer », not « je suis excité de ». « Ce qu'il faut retenir, c'est… »
  for "the takeaway is". « Prenons un peu de recul » for "let's take a step
  back". « Sans rien configurer » for "out of the box".

## Before you call it done

- Every slide has notes, and `npx decklight@latest check deck.html` shows no
  `clicks-vs-builds`.
- No sentence contains a period, a symbol or a digit that should be a word.
- Read with every bracketed tag removed, it still sounds like a person.
- Read without the slides, it follows. Read against the slides, it never
  repeats them.
- If you can, listen to it. If you could not, say so.
