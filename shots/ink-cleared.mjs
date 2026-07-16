// The second half of the ticket's demo: draw the same squiggle, then navigate
// one slide — annotations are ephemeral, so the next slide arrives clean.
location.hash = '#/3/9';
await sleep(300);
press('w');
await sleep(120);
const ink = document.querySelector('.decklight-annotate');
const r = document.querySelector('.decklight-stage').getBoundingClientRect();
const s = r.width / 1280;
const at = (type, x, y) => ink.dispatchEvent(new PointerEvent(type, {
  clientX: r.left + x * s, clientY: r.top + y * s,
  pointerId: 1, bubbles: true, cancelable: true,
}));
at('pointerdown', 140, 620);
for (let i = 1; i <= 64; i++) at('pointermove', 140 + i * 15, 620 + Math.sin(i / 3) * 45);
at('pointerup', 1100, 620);
await sleep(150);
location.hash = '#/4/0'; // slide change clears the ink
await sleep(400);
