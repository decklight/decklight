// ?print=handout (shot.mjs --query "print=handout"): the deck renders as
// 3-up handout pages — three scaled slides a page, each beside a column of
// ruled note-taking lines. Snap the first page to the viewport top so the
// shot shows one full page exactly as it prints. (A negative body margin,
// not scrollTo: headless Chrome under --virtual-time-budget doesn't repaint
// after a scroll, so a scrolled screenshot comes out blank.)
const page = document.querySelectorAll('.print-page')[0];
document.body.style.marginTop = (-page.offsetTop + 8) + 'px';
await sleep(300);
