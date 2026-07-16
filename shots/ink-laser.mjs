// ⇧W laser: sweep the pointer across the diagram — the glowing accent dot
// follows the pointer (the ~300 ms trail has faded by the shutter; the dot
// resting at the sweep's end is the tool's steady state).
location.hash = '#/3/9';
await sleep(300);
press('W', { shiftKey: true });
await sleep(2400);
const ink = document.querySelector('.decklight-annotate');
const r = document.querySelector('.decklight-stage').getBoundingClientRect();
const s = r.width / 1280;
const at = (x, y) => ink.dispatchEvent(new PointerEvent('pointermove', {
  clientX: r.left + x * s, clientY: r.top + y * s, pointerId: 1, bubbles: true,
}));
for (let i = 0; i <= 40; i++) at(320 + i * 16, 500 - i * 3);
