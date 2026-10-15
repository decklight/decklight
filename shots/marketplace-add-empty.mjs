// Evidence for issue #838: with no marketplace registered, / → Design
// systems… offers Add a marketplace… instead of only naming the CLI command.
// Driven against test/engine.html's own mocked edit server
// (?mode=marketplaceadd&shot=1), so no edit server, no file, no network:
//
//   node tools/shot.mjs test/engine.html -o .shots/marketplace-add-empty.png \
//     --query "mode=marketplaceadd&shot=1" --wait 2500 --drive shots/marketplace-add-empty.mjs
await sleep(400); // /deck/ping: write mode
press('/');
for (const c of 'design systems') press(c);
await sleep(200);
press('Enter');
await sleep(500); // the empty list, its one row selected
