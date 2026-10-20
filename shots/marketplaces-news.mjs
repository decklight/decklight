// Evidence for Marketplaces… (SPEC MARKETPLACES_SCREEN): ⏎ on the
// out-of-date catalog updates it and opens what's new — the entries added,
// dropped and moved to a new version, and the install it now has newer, with
// the command that takes it. Driven against test/engine.html's mocked edit
// server:
//
//   node tools/shot.mjs test/engine.html -o .shots/marketplaces-news.png \
//     --query "mode=marketplaces&shot=1" --wait 3000 --drive shots/marketplaces-news.mjs
await sleep(400); // /deck/ping: write mode
press('/');
for (const c of 'marketplaces') press(c);
await sleep(200);
press('Enter');
await sleep(400);
press('c');
await sleep(400);
press('Enter'); // acme, selected: update it
await sleep(700);
