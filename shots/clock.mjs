// The ticket's demo, verbatim: advance a couple of times, then K — the
// presenter clock appears under the slide number, wall time (HH:MM) plus an
// elapsed counter that started at the FIRST advance and is visibly running
// (~+00:02 by the shutter, thanks to the virtual-time sleeps).
press('ArrowRight'); await sleep(300);
press('ArrowRight'); await sleep(300);
press('k');
await sleep(2400);
