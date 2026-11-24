// node tools/shot.mjs test/narration.html --query 'mode=writeface&shot'
// Add &after to show the result of moving the character to the top left.
const find = (label) => [...document.querySelectorAll('.narr-row')]
  .find((row) => row.querySelector('.narr-row-label')?.textContent.trim() === label);
const waitFor = async (fn) => {
  for (let i = 0; i < 40; i++) {
    const el = fn();
    if (el) return el;
    await sleep(50);
  }
  throw new Error('The placement preview did not appear');
};
await waitFor(() => document.querySelector('.decklight-character-preview.show.pos-br'));
if (new URLSearchParams(location.search).has('after')) {
  window.__deck.narration.openPicker('character');
  (await waitFor(() => find('Face & character placement…'))).click();
  (await waitFor(() => document.querySelector('.narr-face-dot[aria-label="top left"]'))).click();
  (await waitFor(() => find('Save for slide 1'))).click();
  await waitFor(() => !document.querySelector('.narr-face-sketch'));
  press('v');
  await waitFor(() => !document.querySelector('.decklight-narr'));
  await waitFor(() => document.querySelector('.decklight-character-preview.show.pos-tl'));
  await sleep(3400); // let the save confirmation clear the slide
}
