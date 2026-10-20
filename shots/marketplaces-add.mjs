// Evidence for Marketplaces… (SPEC MARKETPLACES_SCREEN): A is the add view
// that replaced the Add a marketplace… card — the first ⏎ only says what it
// would read, and asks for a second. Driven against test/engine.html's mocked
// edit server:
//
//   node tools/shot.mjs test/engine.html -o .shots/marketplaces-add.png \
//     --query "mode=marketplaces&shot=1" --wait 2500 --drive shots/marketplaces-add.mjs
await sleep(400); // /deck/ping: write mode
press('/');
for (const c of 'marketplaces') press(c);
await sleep(200);
press('Enter');
await sleep(400);
press('a');
await sleep(300);
const box = document.querySelector('.decklight-marketplaces .mk-spec');
box.value = './northwind';
box.dispatchEvent(new Event('input', { bubbles: true }));
box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await sleep(400);
