// Evidence for #232: the mounted wizard card carries the provenance line —
// who is asking (the registry's qualified name, `elevenlabs@voices`) and where
// the answer goes (its bridge path on this machine, then the 0600 credentials
// file) — ABOVE the fields, before anything is typed. The title and every
// label are the plugin's own words; that line is core's. A key is typed in so
// the shot also shows the secret staying masked next to it.
await sleep(300);                     // let the stub /edit/ping wire author mode up
press('/');
for (const c of 'configure') press(c);
await sleep(150);
press('Enter');                       // Configure ElevenLabs… (dev)
await sleep(500);                     // schema fetch → the form mounts, provenance first
const key = document.querySelector('.decklight-editor input[type="password"]');
if (key) { key.value = 'sk-live-0123456789abcdef'; key.focus(); }
