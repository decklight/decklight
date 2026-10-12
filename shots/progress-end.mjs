// The ticket's demo: the progress bar on (J at the time), then End jumps
// to the last slide — the hairline along the bottom edge reads as full,
// with the slide number (top-right) untouched.
window.__deck.toggleProgress(); await sleep(200);   // the palette's Progress bar row (J went)
press('End');
await sleep(800); // let the 200ms width transition land before the shutter
