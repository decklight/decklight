// The N picker offers whatever the bridge says it can speak — and an
// ElevenLabs bridge's roster is named by strangers (shared/community voices).
// This drive answers the bridge's /ping with a voice literally named
// '<img src=x onerror=…>' and opens the picker: the row must show that
// markup as TEXT, not parse it. Before the ticket/228 fix this screenshot
// would show a broken-image icon instead of the name, and the onerror
// handler would have run in the deck's origin.
const realFetch = window.fetch.bind(window);
window.fetch = async (url, opts) => {
  if (String(url).endsWith('/ping')) {
    return new Response(JSON.stringify({
      ok: true,
      engine: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      stylable: false,
      voices: [
        ['<img src=x onerror="document.title=\'pwned\'">', '<b>hostile flavor</b>'],
        ['Rachel', 'calm'],
        ['My Voice', 'cloned'],
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};
press('n'); // no recorded tracks on the showcase — opens straight on voices
await sleep(1000); // /ping answers and the view repaints with the bridge roster
