// The data-math showcase slide, found by attribute so the shot keeps working
// if slides are added before it. (The instance rides the root element.)
const deck = document.querySelector('.decklight').__decklight;
const sec = document.querySelector('section[data-math]');
deck.goto(Number(sec.getAttribute('data-slide-index')), 0);
await sleep(600); // let the slide transition settle before the shutter
