// ?print=notes (shot.mjs --query "print=notes"): one page per slide, that
// slide's speaker notes underneath. Show page 2 — the "Builds" slide, whose
// notes carry several ⟨CLICK⟩ segments — so the shot proves real notes
// content lands under the slide, not just the title card. (A negative body
// margin, not scrollTo: headless Chrome under --virtual-time-budget doesn't
// repaint after a scroll, so a scrolled screenshot comes out blank.)
const page = document.querySelectorAll('.print-page')[1];
document.body.style.marginTop = (-page.offsetTop + 8) + 'px';
await sleep(300);
