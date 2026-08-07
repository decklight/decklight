// Evidence for issue #112: E arms element edit mode, and right-clicking a
// slide element opens a menu anchored at the cursor — never a dimmed,
// centered card like every other overlay, since dimming would hide the very
// slide the menu is about. Driven against test/engine.html's own mocked
// bridge (?mode=contextmenu&shot=1), so no author server, no file, no
// network — the `shot=1` guard skips that page's own automated test so this
// driver has the overlay to itself:
//
//   node tools/shot.mjs test/engine.html -o .shots/element-edit-menu.png \
//     --query "mode=contextmenu&shot=1" --wait 2500 --drive shots/element-edit-menu.mjs
press('e'); // arm element edit mode — E only arms it, right-click does the rest
await sleep(300);

const h1 = document.querySelector('.decklight section h1');
const rect = h1.getBoundingClientRect();
h1.dispatchEvent(new MouseEvent('contextmenu', {
  bubbles: true, cancelable: true,
  clientX: rect.left + 36, clientY: rect.top + rect.height / 2,
}));
await sleep(300); // the menu mounts, cursor-anchored at the title

const addEffect = [...document.querySelectorAll('.decklight-ctxmenu .cm-row')]
  .find((row) => row.textContent === 'Add text effect ▸');
addEffect?.click();
await sleep(300); // drills into the effects submenu — same overlay, new rows

press('ArrowDown'); press('ArrowDown'); // walk down to fade-up (row 0 is ← back, row 1 is fade)
await sleep(300);
