// The COMPARISON_SLIDES trap (#86), live: a section that hand-rolls its own
// Pros/Cons flex row AND still carries data-layout="split" — two layout
// systems arguing. The engine must mark it data-split-conflict and warn once.
//
// The badge in the shot is painted FROM the live attribute and the captured
// console warning — the driver throws (and no screenshot exists) if the lint
// did not actually fire. The slide behind it shows what the lint catches:
// the hand-rolled shell squeezed into split's left column, the footer taken
// for the right one.
const deck = window.__deck;
const warns = [];
const orig = console.warn;
console.warn = (...a) => { warns.push(a.join(' ')); orig(...a); };

const sec = document.createElement('section');
sec.setAttribute('data-layout', 'split');
sec.innerHTML = `
  <h2>git</h2>
  <p>Distributed version control — the substrate everything else sits on.</p>
  <div style="display:flex; gap:28px">
    <div><h3>Pros</h3><ul><li>Fast, offline, ubiquitous</li><li>Scriptable end to end</li></ul></div>
    <div><h3>Cons</h3><ul><li>Sharp edges around rebase</li><li>Submodules</li></ul></div>
  </div>
  <p><strong>Alternatives:</strong> Mercurial; Jujutsu</p>`;
document.querySelector('.decklight-stage').appendChild(sec);
deck.sync();
console.warn = orig;
deck.goto(deck.state.totalSlides, 0);
await sleep(400);

const warned = warns.find((w) => /column flexbox/.test(w));
if (!sec.hasAttribute('data-split-conflict') || !warned) {
  throw new Error('split-conflict lint did not fire — nothing to screenshot');
}
const badge = document.createElement('div');
badge.style.cssText = 'position:fixed; left:24px; right:24px; bottom:24px; z-index:999;'
  + 'background:#7f1d1d; color:#fecaca; font:14px/1.6 ui-monospace,Menlo,monospace;'
  + 'padding:12px 18px; border-radius:10px; box-shadow:0 10px 34px rgba(0,0,0,.5); white-space:pre-wrap;';
badge.textContent = '⚑ section is marked [data-split-conflict]\nconsole: ' + warned;
document.body.appendChild(badge);
await sleep(200);
