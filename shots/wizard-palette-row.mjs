// Evidence for #233, half one: the `/` palette now HAS a way in. Typing
// "configure" filters to the contextual row the author server's ping put
// there — Configure ElevenLabs… (dev) — exactly as a presenter would find it.
await sleep(300);                     // let the stub /edit/ping wire author mode up
press('/');
for (const c of 'configure') press(c);
await sleep(200);
