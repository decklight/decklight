// Evidence for Check deck… as the one problems panel (SPEC PRESENTING_EDITING,
// #889): docked beside the slide, the deck-wide findings first (a design
// system the deck is behind, a theme off the brand, an unaccounted script),
// then each slide's — the file's and the page's own — each row carrying the
// fix it offers in the words of what it will do, or saying it has none.
// Driven against test/engine.html's mocked edit server:
//
//   node tools/shot.mjs test/engine.html -o .shots/check-deck-problems.png \
//     --query "mode=deckcheck&shot=1" --wait 3000 --drive shots/check-deck-problems.mjs
await sleep(500); // /deck/ping: write mode, and the behind toast that points at the panel
press('/');
for (const c of 'check deck') press(c);
await sleep(200);
press('Enter');
await sleep(600); // GET /deck/edit/check: the file's half joins the page's
for (let i = 0; i < 3; i++) press('ArrowDown'); // the off-role row, with its fix and its fix-all
await sleep(300);
