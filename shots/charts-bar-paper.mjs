// The same charts slide (4) after a live theme switch to paper (light) —
// the pair with charts-bar.mjs proves the token repaint: identical markup,
// two very different palettes, labels readable in both.
const deck = document.querySelector('.decklight').__decklight;
deck.theme('paper');
deck.goto(4, 0);
await sleep(1200);
