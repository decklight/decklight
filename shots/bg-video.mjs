// The background-video slide: the muted looping mp4 is playing behind the
// content (the engine started it from the slide event). The wait gives the
// clip time to decode a real frame before the shutter.
const secs = [...document.querySelectorAll('.decklight-stage > section')];
const n = secs.findIndex((s) => s.hasAttribute('data-background-video')) + 1;
window.__deck.goto(n, 99);
await sleep(1500);
const v = secs[n - 1].querySelector('.slide-bg > video');
console.log('bg video playing:', v && !v.paused);
