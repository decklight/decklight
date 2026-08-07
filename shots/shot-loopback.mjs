// #229 — shot.mjs now serves the deck over http://127.0.0.1 under the present
// CSP instead of file:// + --allow-file-access-from-files. This change is not
// visible on the slide, so the screenshot's job is to prove the render path
// itself still works: a real deck, driven and captured over the loopback origin.
//
// Advance a couple of build steps so the shot shows a deck that actually booted
// and is taking key input through the served page — exactly the presenter flow,
// now confined to an http origin that cannot read arbitrary local files.
press('ArrowRight');
await sleep(250);
press('ArrowRight');
await sleep(400);
