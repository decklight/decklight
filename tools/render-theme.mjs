// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * Which theme a render opens on — the query parameters `video`, `pptx` and
 * `pdf` put on the deck URL (#547).
 *
 * A render is a fresh browser with an empty profile, so a theme picked in the
 * presenter's has to be TOLD to it. Two forms, the two the runtime's resolver
 * already reads (src/core/themes.js `restoreSaved`):
 *
 *   --theme <name>  `?theme=` — one of the deck's own blocks, an added one,
 *                   or a themes/<name>.css file.
 *   --gen <b64url>  `?gen=` — a theme with no name the deck knows (a saved
 *                   custom theme, an unsaved ⌃T roll): its tokens as base64url
 *                   JSON `{ name, tokens }`, the form the picker's previews
 *                   load. The runtime vets every token before it becomes CSS.
 *
 * Checked here, because both arrive from argv — and from a page, through the
 * author server's export route, which checks them the same way.
 */
export const THEME_NAME = /^[\w-]{1,64}$/;
export const GEN_THEME = /^[\w-]{1,16384}$/;

/** `['theme=…']`, `['gen=…']` or `[]` — throws on a value that is neither. */
export function renderThemeParams({ theme = null, gen = null } = {}) {
  if (theme != null && !THEME_NAME.test(theme)) throw new Error(`--theme takes a theme name, not ${JSON.stringify(theme)}`);
  if (gen != null && !GEN_THEME.test(gen)) {
    throw new Error('--gen takes a generated theme as base64url JSON {name, tokens}, at most 16 KB');
  }
  if (theme != null && gen != null) throw new Error('--theme or --gen, not both — one theme per render');
  return [theme != null ? `theme=${encodeURIComponent(theme)}` : null, gen != null ? `gen=${gen}` : null].filter(Boolean);
}
