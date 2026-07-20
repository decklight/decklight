// The background-image slide (data-background-image + data-background-dim),
// fully built: the sunrise renders full-bleed behind the text, the dim wash
// keeps the bullets readable.
const secs = [...document.querySelectorAll('.decklight-stage > section')];
const n = secs.findIndex((s) => s.hasAttribute('data-background-image')) + 1;
window.__deck.goto(n, 99); // oversized step clamps to "all built"
await sleep(600);
