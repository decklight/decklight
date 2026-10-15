// Evidence for issue #840: the bundle card asks what goes in — the whole deck
// or one chapter, each with its slides — and opens on the chapter of the slide
// on screen. Driven against test/engine.html's mocked edit server:
//
//   node tools/shot.mjs test/engine.html -o .shots/bundle-module-picker.png \
//     --query "mode=exportmodule&shot=1" --wait 3000 --drive shots/bundle-module-picker.mjs
await sleep(400); // /deck/ping: write mode
__deck.goto(4, 0);
await sleep(200);
press('/');
for (const c of 'bundle into one file') press(c);
await sleep(200);
press('Enter');
await sleep(400);
