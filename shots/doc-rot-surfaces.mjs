// #238 is comment-only — nothing visible changes, so the shot shows the
// surfaces whose comments were corrected still doing what the corrected
// comments now say: slide 4 has the auto-detected subtitle (engine.js's
// detectSubtitle and decklight.css's .subtitle rule, no markdown path) above
// two data-chart blocks expanded by initCharts (whose comment now places it
// in the real pipeline, initMarkdown being long gone).
const deck = document.querySelector('.decklight').__decklight;
deck.goto(4, 0);
await sleep(800);
