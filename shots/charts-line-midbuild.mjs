// The line-chart slide (5) MID-build: one advance, so the p99 series has
// drawn itself in (dash-offset machinery) while p50 is still pending — the
// shot that shows series stepping in rather than a finished picture.
const deck = document.querySelector('.decklight').__decklight;
deck.goto(5, 0);
await sleep(300);
press('ArrowRight');
await sleep(1400);
