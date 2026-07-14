// The ticket's demo, verbatim: H turns the progress bar on, then End jumps
// to the last slide — the hairline along the bottom edge reads as full,
// with the slide number (top-right) untouched.
press('h'); await sleep(200);
press('End');
await sleep(800); // let the 200ms width transition land before the shutter
