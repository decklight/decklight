// Ticket #237's exact scenario, driven live: a panel mounts AFTER the
// overflow watch armed (the deck is already sitting on the slide), fits when
// the MutationObserver measures its arrival — and only then does an image
// inside it load and blow past the panel's fixed box. No further mutation
// fires, nothing armed at goto time resizes; before the fix the slide
// settled into clipping with `data-overflow` absent.
//
// `data-overflow` deliberately has no styling (it is for probes and consoles),
// so the shot paints the verdict: the attribute's state before and after the
// late growth, green only if the growth was caught.
location.hash = '#/3/0';
await sleep(400);
const sec = document.querySelectorAll('.decklight-stage > section')[2];

const late = document.createElement('ul');
late.style.cssText = 'height:150px;overflow-y:auto;margin:0;outline:2px dashed currentColor';
const item = document.createElement('li');
item.textContent = 'panel mounted after the slide settled — fits for now';
const holder = document.createElement('li');
const img = document.createElement('img');
holder.appendChild(img);
late.append(item, holder);
sec.appendChild(late);
await sleep(300); // the arrival has been observed and measured: still clean
const before = sec.hasAttribute('data-overflow');

// the late growth: bytes landing is an attribute change + a load event,
// not a childList mutation — the silent-pass shape the guardrail must catch
img.src = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="700">'
  + '<rect width="360" height="700" fill="#7c5cff" opacity="0.55"/>'
  + '<text x="180" y="80" font-size="26" text-anchor="middle" fill="#fff">image decoded late</text>'
  + '<text x="180" y="120" font-size="26" text-anchor="middle" fill="#fff">700px tall</text>'
  + '</svg>');
await sleep(400);
const after = sec.hasAttribute('data-overflow');

const caught = !before && after;
const banner = document.createElement('div');
banner.style.cssText = 'position:fixed;left:24px;bottom:24px;z-index:9999;'
  + 'font:600 20px/1.5 ui-monospace,monospace;padding:16px 22px;border-radius:10px;'
  + `color:#fff;background:${caught ? '#166534' : '#991b1b'};box-shadow:0 4px 24px rgba(0,0,0,.4)`;
banner.textContent = `data-overflow — before late growth: ${before} · after: ${after}`
  + (caught ? '  ✓ caught' : '  ✗ MISSED');
document.body.appendChild(banner);
await sleep(100);
