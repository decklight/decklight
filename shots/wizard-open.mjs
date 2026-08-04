// Evidence for #233, half two: committing the palette row mounts the wizard —
// core rendering the server-vetted ElevenLabs schema. The key is typed in so
// the shot shows the secret field masking it (input[type=password]).
await sleep(300);                     // let the stub /edit/ping wire author mode up
press('/');
for (const c of 'configure') press(c);
await sleep(150);
press('Enter');                       // Configure ElevenLabs… (dev)
await sleep(500);                     // schema fetch → the form mounts
const key = document.querySelector('.decklight-editor input[type="password"]');
if (key) { key.value = 'sk-live-0123456789abcdef'; key.focus(); }
