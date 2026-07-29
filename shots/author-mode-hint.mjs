// Evidence for #175 in the player: on a file:// deck with no edit server,
// a persisted-edit key (L) toasts the author-mode hint — the folder to run
// from and `npx decklight author <deck>`, the renamed command.
press('l');
await sleep(400);
