#!/bin/sh
# Copyright 2026 Gilles Philippart
# SPDX-License-Identifier: Apache-2.0
#
# How the `decklight video` evidence in .shots/ was produced. This feature is a
# CLI, not a page, so the driver is a shell script instead of a --drive snippet:
# fake 2s/3s narration takes stand in for a real voiceover run (the manifest
# shape is exactly what tools/voiceover.mjs writes), the deck renders to an
# mp4, and the screenshots are frames ffmpeg extracts from that mp4 — the
# evidence shows the VIDEO's pixels, not the browser's.
set -e

# narration stand-in: two tones with known durations + the voiceover manifest
mkdir -p /tmp/vo-demo
ffmpeg -y -v error -f lavfi -i "sine=frequency=440:duration=2" -c:a aac /tmp/vo-demo/slide-01.m4a
ffmpeg -y -v error -f lavfi -i "sine=frequency=660:duration=3" -c:a aac /tmp/vo-demo/slide-02.m4a
cat > /tmp/vo-demo/manifest.json <<'EOF'
{ "engine": "piper", "voice": "en_US-ryan-high", "slides": [
  { "file": "slide-01.m4a", "hash": "demo1" },
  { "file": "slide-02.m4a", "hash": "demo2" },
  null
]}
EOF

# slides 1-2 narrated (2s + 3s audio, +0.4s tail each), slide 3 silent (--hold 1)
# → 2.4 + 3.4 + 1.0 = 6.8s of mp4
node cli/decklight.mjs video demo/showcase.html -o /tmp/showcase.mp4 \
  --slides 1-3 --hold 1 --narration /tmp/vo-demo

ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 /tmp/showcase.mp4
ffprobe -v error -show_entries stream=codec_name,codec_type,width,height -of compact /tmp/showcase.mp4

mkdir -p .shots
ffmpeg -y -v error -ss 1   -i /tmp/showcase.mp4 -frames:v 1 .shots/video-slide-1.png
ffmpeg -y -v error -ss 3.5 -i /tmp/showcase.mp4 -frames:v 1 .shots/video-slide-2.png
