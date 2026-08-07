// Evidence for issue #240: the tone step appears for an ElevenLabs voice once
// the model is eleven_v3 — decided by /ping's stylable, exactly as it already
// works for gemini. Driven against test/narration.html's own mocked bridge
// (?mode=elevenlabsv3&shot=1), so no key, no account, no network:
//
//   node tools/shot.mjs test/narration.html -o .shots/elevenlabs-v3-tone-step.png \
//     --query "mode=elevenlabsv3&shot=1" --wait 3000 --drive shots/elevenlabs-v3-tone-step.mjs
await sleep(1200); // let the deck's own boot settle before the first keypress
press('n');
await sleep(600); // /ping answers, voices view repaints
document.querySelector('.decklight-narr .narr-row')?.click(); // commit the top ("yours") voice
await sleep(600); // tones view repaints
