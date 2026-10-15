// Evidence for issue #838: Add a marketplace… says what it is about to do
// before it does it, and waits for a second ⏎. Here ./northwind, read from
// the deck's folder, which is registered in place, nothing fetched.
// Driven against test/engine.html's mocked edit server:
//
//   node tools/shot.mjs test/engine.html -o .shots/marketplace-add-confirm.png \
//     --query "mode=marketplaceadd&shot=1" --wait 2500 --drive shots/marketplace-add-confirm.mjs
await sleep(400); // /deck/ping: write mode
press('/');
for (const c of 'add a marketplace') press(c);
await sleep(200);
press('Enter');
await sleep(300);
const box = document.querySelector('.decklight-marketplace-add .mk-spec');
box.value = './northwind';
box.dispatchEvent(new Event('input', { bubbles: true }));
box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await sleep(500); // the plan, and the second ⏎ it asks for
