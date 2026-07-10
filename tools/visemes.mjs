// Shared viseme-timeline format (v1) — the contract between the lipsync
// bridge (tools/lipsync-server.mjs), the batch tool (tools/lipsync.mjs) and
// the player's character overlay:
//
//   { v: 1, kind: 'visemes', duration: 7.42, source: 'rhubarb',
//     cues: [ { t: 0.00, v: 'X' }, { t: 0.31, v: 'B' }, … ] }
//
// Cues carry START times only — each shape holds until the next cue, the
// last until `duration`. That is lossless versus Rhubarb's contiguous
// { start, end, value } runs and half the size on disk.

const r3 = (x) => Math.round(x * 1000) / 1000;

// Rhubarb `-f json` output → timeline v1. Collapses consecutive duplicate
// shapes (Rhubarb emits them across word boundaries).
export function normalizeRhubarb(rh) {
  const cues = [];
  let end = 0;
  for (const c of rh?.mouthCues ?? []) {
    const v = String(c.value ?? 'X').toUpperCase();
    end = Math.max(end, c.end ?? 0);
    if (cues.length && cues[cues.length - 1].v === v) continue;
    cues.push({ t: r3(c.start ?? 0), v });
  }
  return { v: 1, kind: 'visemes', duration: r3(rh?.metadata?.duration ?? end), source: 'rhubarb', cues };
}
