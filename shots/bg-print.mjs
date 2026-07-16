// The same deck under ?print (shot.mjs --query print): the background-video
// slide must show its POSTER as a still, with no <video> element anywhere in
// the page. Print stacks every slide top-down and headless Chrome shoots the
// first viewport (scrolling paints blank under virtual time), so drop the
// preceding pages to bring this one to the top — a shot-only DOM edit.
const sec = document.querySelector('section[data-background-video]');
for (const s of [...document.querySelectorAll('.decklight-stage > section')]) {
  if (s === sec) break;
  s.remove();
}
console.log('videos in print:', document.querySelectorAll('video').length);
await sleep(400);
