// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * `decklight init --starter full`: the reference starter. One slide per thing
 * a slide can hold, each preceded by a comment that names what it shows and
 * the SPEC section to read, because an author working by hand copies from
 * what is in front of them, and the two-slide basic starter shows a build and
 * nothing else.
 *
 * Every slide here is held to what it teaches: `decklight check` finds
 * nothing on it (no warning, no hint), every build has its [click] beat in
 * the notes, nothing is crowded past SLIDE_DENSITY, every colour is a theme
 * token (so the contrast gates every theme passes are the ones it is judged
 * by), and nothing needs a file beside the deck, so the linked and the
 * self-contained scaffold are the same slides. test/init-starter.test.mjs
 * and test/starter-render.mjs hold it to that.
 *
 * No terminal slide: a terminal plays a recording `decklight cast` made in a
 * real shell, and a cast written here by hand would be the one untruthful
 * terminal in the deck.
 */

/** The starters `init --starter` takes, the default first. */
export const STARTERS = ['basic', 'full'];

/** How a comment names the section to read: by mnemonic, never by number. */
const SPEC = (mnemonic) => `SPEC: ${mnemonic}`;

// A picture that needs no file beside the deck: a small SVG as a data: URI.
// Its own colours, like any photo; the slide says to swap in a real file.
const PICTURE = `data:image/svg+xml,${[
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 480 300'>",
  "<rect width='480' height='300' fill='#9cc5e3'/>",
  "<circle cx='368' cy='84' r='40' fill='#ffd166'/>",
  "<path d='M0 236 L120 126 L208 198 L304 104 L480 244 V300 H0Z' fill='#4f7591'/>",
  "<path d='M0 262 Q150 206 300 252 T480 246 V300 H0Z' fill='#2f4858'/>",
  '</svg>',
].join('').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E')}`;

/** The slides after the title slide, at the deck's indentation. */
function featureSlides() {
  return `
    <!-- A module marker: data-module on a section starts a chapter, which lasts until the next marker. ${SPEC('DECK_ANATOMY')} -->
    <section data-module="Words">
      <h1>Words</h1>
      <p>This slide starts a chapter: its name shows by the slide number, and G lists the chapters</p>
      <aside class="notes">
        <p>A long deck reads better in chapters. One attribute on the slide that starts one is all it takes, and every slide after it belongs to that chapter until the next.</p>
        <p>This deck has three: words, pictures and data, and handing it over.</p>
      </aside>
    </section>

    <!-- Bullets that build: data-build on the list makes each item one click; its value is the entrance. ${SPEC('BUILD_AUTHORING')} -->
    <section>
      <h2>Points, one click at a time</h2>
      <ul data-build="fade-up">
        <li><code>data-build</code> goes on the list, nothing on the items</li>
        <li>Each item arrives on its own click, in order</li>
        <li><code>fade-up</code> is the entrance; <code>zoom</code> and <code>pop</code> are others</li>
      </ul>
      <aside class="notes">
        <p>A list that builds keeps the room with you: nobody reads ahead of what you are saying.</p>
        <p>[click]</p>
        <p>The attribute goes on the list, and every item in it becomes one step.</p>
        <p>[click]</p>
        <p>Each press of the arrow brings the next one, and the left arrow takes it back.</p>
        <p>[click]</p>
        <p>The value names the entrance. Leave it empty for a plain fade.</p>
      </aside>
    </section>

    <!-- Speaker notes: the notes aside, cut into beats by [click] lines, one per build step, with [pause] for a held beat. ${SPEC('DECK_ANATOMY')} -->
    <section>
      <h2>What you say goes in the notes</h2>
      <p>Press S for the speaker view: these notes, the next slide and a timer</p>
      <p data-build>A <code>[click]</code> line in the notes starts the beat for the next build step</p>
      <p data-build><code>[pause]</code> holds a moment where it stands; no voice ever says it</p>
      <aside class="notes">
        <p>The notes are for you, never for the audience. A voice can read them aloud too, so write them the way you would say them.</p>
        <p>[click]</p>
        <p>Each click marker starts the beat for the next build, so the words land with what appears.</p>
        <p>[click]</p>
        <p>And a pause marker holds a moment, [pause] like that, without a word said.</p>
      </aside>
    </section>

    <!-- A comparison slide: data-layout="split" makes the first two blocks columns and a third a footer under both. ${SPEC('COMPARISON_SLIDES')} -->
    <section data-layout="split">
      <h2>Linked or self-contained?</h2>
      <div>
        <h3>Linked</h3>
        <ul>
          <li>Slides and settings only</li>
          <li>Runs the installed decklight</li>
          <li>Small git diffs</li>
        </ul>
      </div>
      <div>
        <h3>Self-contained</h3>
        <ul>
          <li>Runtime and themes inside</li>
          <li>Opens from disk</li>
          <li>Pinned to its version</li>
        </ul>
      </div>
      <p><code>decklight bundle</code> makes a linked deck self-contained</p>
      <aside class="notes">
        <p>Two blocks become the two columns, and a third becomes a footer under both. Nothing else is needed: no flexbox of your own.</p>
        <p>A linked deck is the one you write: small, and it always runs the version you have installed. The self-contained one is the one you send.</p>
      </aside>
    </section>

    <!-- A table: a thead for the header row; data-build on the table brings its body rows in one click each. ${SPEC('BUILD_AUTHORING')} -->
    <section>
      <h2>Which attribute does what</h2>
      <table data-build>
        <thead>
          <tr><th>To get</th><th>Write</th></tr>
        </thead>
        <tbody>
          <tr><td>Points one at a time</td><td><code>data-build</code> on the list</td></tr>
          <tr><td>Two columns</td><td><code>data-layout="split"</code> on the section</td></tr>
          <tr><td>A new chapter</td><td><code>data-module="Name"</code> on the section</td></tr>
          <tr><td>Code that fits its slide</td><td><code>data-fit</code> on the code block</td></tr>
        </tbody>
      </table>
      <aside class="notes">
        <p>A table is plain HTML: a header row, then a row per line. With a build on it, the rows arrive one at a time.</p>
        <p>[click]</p>
        <p>Builds, on any list.</p>
        <p>[click]</p>
        <p>Columns, for a comparison.</p>
        <p>[click]</p>
        <p>Chapters, for a long deck.</p>
        <p>[click]</p>
        <p>And code that sizes itself to the room it has.</p>
      </aside>
    </section>

    <!-- A code block: a language class to highlight it, data-fit to size it, data-lines to step through its lines. ${SPEC('CODE_AND_MATH')} -->
    <section>
      <h2>Code, one part at a time</h2>
      <pre data-fit data-lines="2|3-6|7|all"><code class="language-html">&lt;section>
  &lt;h2>A slide&lt;/h2>
  &lt;ul data-build>
    &lt;li>One point&lt;/li>
    &lt;li>Another&lt;/li>
  &lt;/ul>
  &lt;aside class="notes">What you say&lt;/aside>
&lt;/section></code></pre>
      <p>Inside a code block, write <code>&amp;lt;</code> for every <code>&lt;</code></p>
      <aside class="notes">
        <p>This is a whole slide, written as code. Each click lights up the part being talked about.</p>
        <p>[click]</p>
        <p>A title.</p>
        <p>[click]</p>
        <p>A list that builds.</p>
        <p>[click]</p>
        <p>The notes: what you say, never shown to the room.</p>
        <p>[click]</p>
        <p>And all of it together is a slide. Copy any slide in this deck the same way.</p>
      </aside>
    </section>

    <!-- Math: data-math on the section, then LaTeX between $$ and $$, or between \\( and \\) inside a sentence. ${SPEC('CODE_AND_MATH')} -->
    <section data-math>
      <h2>Math, written as LaTeX</h2>
      <p>Between double dollar signs, on a slide marked for math</p>
      <p>$$L = \\lambda W$$</p>
      <p>Little's law: the queue \\(L\\) is the arrival rate \\(\\lambda\\) times the wait \\(W\\)</p>
      <aside class="notes">
        <p>Math is written as LaTeX and drawn by the browser, with nothing to fetch. Only a slide that asks for it is read for math, so a dollar sign anywhere else stays a dollar sign.</p>
      </aside>
    </section>

    <!-- A picture: an img element with alt text; split sets it beside its words. This slide also starts the next chapter. ${SPEC('DECK_ANATOMY')} -->
    <section data-module="Pictures and data" data-layout="split">
      <h2>A picture</h2>
      <ul>
        <li>Drop one onto a slide in the browser, or keep the file beside the deck</li>
        <li><code>alt</code> says what it shows</li>
        <li><code>data-background-image</code> fills the whole slide</li>
      </ul>
      <img src="${PICTURE}" alt="Two blue hills under a yellow sun">
      <aside class="notes">
        <p>A picture is an image element with a file beside the deck, and its alt text says what it shows for anyone who cannot see it.</p>
        <p>This one is written into the deck itself, so the starter needs no file. Swap in your own.</p>
      </aside>
    </section>

    <!-- A chart: JSON in, a theme-coloured SVG out; data-build="draw" draws one series per click. ${SPEC('CHARTS')} -->
    <section>
      <h2>A chart, from numbers</h2>
      <p>The numbers are JSON inside the chart; its colours are the theme's</p>
      <div class="chart" data-chart="bar" data-title="Minutes per rehearsal" data-aspect="5:2" data-build="draw">
        <script type="application/json">
        { "labels": ["First run", "Second run", "Third run"],
          "series": [ { "name": "Talk", "data": [34, 27, 22] },
                      { "name": "Questions", "data": [6, 8, 10] } ] }
        </script>
      </div>
      <aside class="notes">
        <p>A chart is data, not a picture of data: change a number and the chart follows, in every theme.</p>
        <p>[click]</p>
        <p>The talk got shorter with each rehearsal.</p>
        <p>[click]</p>
        <p>And the time left for questions grew.</p>
      </aside>
    </section>

    <!-- A diagram: boxes named with data-node, wires that join them by name (data-from, data-to) and follow them when they move, drawn one group per click. ${SPEC('SVG_DIAGRAMS')} -->
    <section>
      <h2>A diagram that builds</h2>
      <p>Each box names itself; each wire names the two boxes it joins</p>
      <svg viewBox="0 0 800 250" width="800" data-build="draw" role="img" aria-label="deck.html is served by decklight to a browser">
        <defs><marker id="starter-arrow" markerWidth="6" markerHeight="4" refX="5" refY="2" orient="auto"><polygon points="0 0, 6 2, 0 4" style="fill: var(--d-stroke)"/></marker></defs>
        <g data-node="deck">
          <rect x="20" y="20" width="200" height="80" rx="10" style="fill: var(--d-fill-1); stroke: var(--d-stroke)" stroke-width="2"/>
          <text x="120" y="68" text-anchor="middle" font-size="22" style="font-family: var(--font-body); fill: var(--d-text)">deck.html</text>
        </g>
        <g>
          <line data-from="deck" data-to="server" x1="224" y1="60" x2="296" y2="60" stroke-width="2" style="stroke: var(--d-stroke)" marker-end="url(#starter-arrow)"/>
          <g data-node="server">
            <rect x="300" y="20" width="200" height="80" rx="10" style="fill: var(--d-fill-2); stroke: var(--d-stroke)" stroke-width="2"/>
            <text x="400" y="68" text-anchor="middle" font-size="22" style="font-family: var(--font-body); fill: var(--d-text)">decklight</text>
          </g>
        </g>
        <g>
          <path data-from="server" data-to="browser" data-route="elbow" d="M 400 104 V 190 H 576" fill="none" stroke-width="2" style="stroke: var(--d-stroke)" marker-end="url(#starter-arrow)"/>
          <g data-node="browser">
            <rect x="580" y="150" width="200" height="80" rx="10" style="fill: var(--d-fill-3); stroke: var(--d-stroke)" stroke-width="2"/>
            <text x="680" y="198" text-anchor="middle" font-size="22" style="font-family: var(--font-body); fill: var(--d-text)">Browser</text>
          </g>
        </g>
      </svg>
      <aside class="notes">
        <p>A diagram is SVG on the slide, coloured with the theme's diagram colours, so it changes with the theme.</p>
        <p>[click]</p>
        <p>You write the deck.</p>
        <p>[click]</p>
        <p>decklight serves it. The arrow is a connector: it names the two boxes it joins, so moving a box never leaves the arrow behind.</p>
        <p>[click]</p>
        <p>And the browser presents it. This wire bends at a right angle, because it says elbow.</p>
      </aside>
    </section>

    <!-- Sources: where a slide's facts come from, a list of named facts and links, hidden on the slide and read with I. ${SPEC('DECK_ANATOMY')} -->
    <section data-module="Handing it over">
      <h2>Where this slide got its facts</h2>
      <p>Press I to read them: hidden on the slide, they travel with the deck</p>
      <p>Notes are for the person talking; sources are for the person listening</p>
      <aside class="sources">
        <dl><dt>owner</dt><dd>whoever presents this deck</dd></dl>
        <ul>
          <li><a href="https://github.com/decklight/decklight/blob/main/SPEC.md">Decklight's SPEC.md</a>: every section a comment in this deck names</li>
        </ul>
      </aside>
      <aside class="notes">
        <p>Notes are for the person talking. Sources are for the person listening: where to read more, and what a claim stands on.</p>
        <p>They stay in the file when you hand the deck over, so a reader can check a number long after the talk.</p>
      </aside>
    </section>

    <!-- A closing slide: plain bullets with no build; about four points is the most a slide should carry. ${SPEC('SLIDE_DENSITY')} -->
    <section>
      <h2>Make it yours</h2>
      <ul>
        <li>Delete the slides you do not need, copy the ones you do</li>
        <li>One idea per slide, and about four points at most</li>
        <li>Run <code>decklight check deck.html</code> before you present</li>
      </ul>
      <aside class="notes">
        <p>Every slide in this deck is one you can copy: the comment above each one in the file says which part of the spec to read for more.</p>
        <p>Keep slides short. If a title needs an "and", it is two slides. And let the check tell you what a browser would otherwise show you too late.</p>
      </aside>
    </section>
`;
}

/**
 * The full starter's slides. `open` is the title section's opening (today's
 * h1, or a design system's title template, `starterSlides` decides), already
 * indented; the title slide's subtitle and notes follow it here.
 */
export function fullStarterSlides(open, { templated = false } = {}) {
  const subtitle = templated ? '' : '\n      <p>A tour of what a slide can hold, each slide the markup to copy</p>';
  const what = templated
    ? `The title slide, on the design system's title template: its slots hold the words. ${SPEC('DESIGN_SYSTEMS')}`
    : `The title slide: an h1, and the line under it becomes its subtitle. ${SPEC('DECK_ANATOMY')}`;
  return `
    <!-- ${what} -->
    ${open}${subtitle}
      <aside class="notes">
        <p>Welcome. Every slide after this one shows one thing a Decklight slide can do, and in the file each is the markup that does it, under a comment naming the part of the spec to read.</p>
        <p>Press the right arrow to advance, and the question mark for every key. Keep the slides you need and delete the rest.</p>
      </aside>
    </section>
${featureSlides()}`;
}
