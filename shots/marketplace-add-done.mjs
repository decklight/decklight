// Evidence for issue #838: after the second ⏎ the marketplace is registered,
// the toast counts what it offers, and Design systems… comes back listing it,
// with no reload. Driven against test/engine.html's mocked edit server:
//
//   node tools/shot.mjs test/engine.html -o .shots/marketplace-add-done.png \
//     --query "mode=marketplaceadd&shot=1" --wait 3000 --drive shots/marketplace-add-done.mjs
await sleep(400); // /deck/ping: write mode
press('/');
for (const c of 'design systems') press(c);
await sleep(200);
press('Enter');
await sleep(400);
press('Enter'); // the empty list's one row: Add a marketplace…
await sleep(300);
const box = document.querySelector('.decklight-marketplace-add .mk-spec');
box.value = './northwind';
box.dispatchEvent(new Event('input', { bubbles: true }));
box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await sleep(400);
press('Enter'); // the second ⏎: register it
await sleep(700);
