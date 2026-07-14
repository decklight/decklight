// The clock answers to its name like every other command: K toggles it on,
// then / opens the palette and typing "clock" filters to the entry (shown as
// "Clock off" since it is already running behind the overlay).
press('ArrowRight'); await sleep(200);
press('k'); await sleep(200);
press('/'); await sleep(200);
for (const c of 'clock') { press(c); await sleep(80); }
await sleep(600);
