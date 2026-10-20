// Evidence for Marketplaces… (SPEC MARKETPLACES_SCREEN): every registered
// catalog from the cache, then C asks each source where it is — acme is
// behind, the first-party one was never fetched. Driven against
// test/engine.html's mocked edit server:
//
//   node tools/shot.mjs test/engine.html -o .shots/marketplaces-check.png \
//     --query "mode=marketplaces&shot=1" --wait 2500 --drive shots/marketplaces-check.mjs
await sleep(400); // /deck/ping: write mode
press('/');
for (const c of 'marketplaces') press(c);
await sleep(200);
press('Enter');
await sleep(400);
press('c'); // check for updates: git ls-remote, nothing fetched
await sleep(500);
