// Evidence for issue #840: the chapter bundled, and the row says what
// `decklight bundle --module` prints — which slides went in, renumbered, and
// that the narration audio stays beside the deck unless --audio carries it.
//
//   node tools/shot.mjs test/engine.html -o .shots/bundle-module-done.png \
//     --query "mode=exportmodule&shot=1" --wait 3000 --drive shots/bundle-module-done.mjs
try { localStorage.setItem('decklight:bundle-audio', 'none'); } catch { /* fine */ }
await sleep(400); // /deck/ping: write mode
__deck.goto(4, 0);
await sleep(200);
press('/');
for (const c of 'bundle into one file') press(c);
await sleep(200);
press('Enter');
await sleep(400);
press('Enter'); // Operations, the chapter on screen
await sleep(500);
press('Enter'); // leave the audio beside the deck
await sleep(600);
