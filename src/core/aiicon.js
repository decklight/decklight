// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The four-point sparkle that marks an AI action, as inline SVG in
 * `currentColor` so it takes the ink of whatever pill it sits in.
 */
export function aiIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ai-icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M8 0.5 C8.6 4.6 11.4 7.4 15.5 8 C11.4 8.6 8.6 11.4 8 15.5 C7.4 11.4 4.6 8.6 0.5 8 C4.6 7.4 7.4 4.6 8 0.5 Z');
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}
