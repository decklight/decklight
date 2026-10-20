// Evidence for Marketplaces… (SPEC MARKETPLACES_SCREEN): the add view shows
// one example of each form the field takes, a branch among them. Driven
// against test/engine.html's mocked edit server:
//
//   node tools/shot.mjs test/engine.html -o .shots/marketplaces-add-ask.png \
//     --query "mode=marketplaces&shot=1" --wait 2500 --drive shots/marketplaces-add-ask.mjs
await sleep(400); // /deck/ping: write mode
press('/');
for (const c of 'marketplaces') press(c);
await sleep(200);
press('Enter');
await sleep(400);
press('a');
await sleep(300);
