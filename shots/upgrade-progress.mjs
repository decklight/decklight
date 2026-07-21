// The ticket's demo, verbatim: a deck scaffolded on Decklight 0.1.1 (built
// from the v0.1.1 tag in a git worktree), run through `decklight upgrade`,
// then opened headless — H turns on the progress bar, a feature new in
// 0.2.0 that the deck's era could not do. A couple of advances give the
// hairline along the bottom edge some width to show.
press('h'); await sleep(200);
press('ArrowRight'); await sleep(150);
press('ArrowRight'); await sleep(150);
press('ArrowRight'); await sleep(800); // let the width transition land
