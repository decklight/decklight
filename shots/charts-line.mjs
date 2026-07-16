// The line-chart slide (5) fully built: both series drawn in. Two advances,
// exactly as a presenter would step through the ⟨CLICK⟩s.
const deck = document.querySelector('.decklight').__decklight;
deck.goto(5, 0);
await sleep(300);
press('ArrowRight');
await sleep(1000);
press('ArrowRight');
await sleep(1400);
