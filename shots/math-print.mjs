// ?print lays every slide out in a column, all builds complete — but headless
// Chrome screenshots only composite the unscrolled viewport, so bring the
// data-math slide to the top by dropping its predecessors AFTER the print
// layout ran (the slide's own print rendering is untouched by that).
// Pair with: --query print
const sec = document.querySelector('section[data-math]');
for (const s of document.querySelectorAll('.decklight-stage > section')) {
  if (s === sec) break;
  s.remove();
}
await sleep(300);
