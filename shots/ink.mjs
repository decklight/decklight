// The ticket's demo: press W, then draw a visible squiggle across the slide.
// The strokes come from synthetic pointer events on the annotation canvas —
// the exact drag a presenter's mouse makes — and land in the theme's --accent.
location.hash = '#/3/9'; // the diagram slide, every build shown
await sleep(300);
press('w');
await sleep(120);
const ink = document.querySelector('.decklight-annotate');
// design coordinates → client, through the stage rect (headless viewport
// size varies while driving; the strokes must land where the slide is)
const r = document.querySelector('.decklight-stage').getBoundingClientRect();
const s = r.width / 1280;
const at = (type, x, y) => ink.dispatchEvent(new PointerEvent(type, {
  clientX: r.left + x * s, clientY: r.top + y * s,
  pointerId: 1, bubbles: true, cancelable: true,
}));
// a squiggle across the lower half of the slide…
at('pointerdown', 140, 620);
for (let i = 1; i <= 64; i++) at('pointermove', 140 + i * 15, 620 + Math.sin(i / 3) * 45);
at('pointerup', 1100, 620);
// …and a ring around the middle of the diagram, the way a presenter circles
// the thing they are talking about
at('pointerdown', 780, 350);
for (let a = 1; a <= 40; a++) {
  at('pointermove', 640 + 140 * Math.cos((a / 20) * Math.PI), 350 + 90 * Math.sin((a / 20) * Math.PI));
}
at('pointerup', 780, 350);
await sleep(200);
