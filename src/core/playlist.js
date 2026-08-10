// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

// Module navigation — a deck that is one chapter of something longer.
//
// TWO SHAPES, ONE VOCABULARY. A course can be a set of FILES chained by
// `config.playlist` (advancing past the last slide loads the next module), or
// ONE file that `bundle --all` merged, where chapters are marked by
// `data-module` on a section. The second is not a lesser version of the first:
// when markers exist they take precedence, and module navigation becomes a
// `goto()` with no page load at all.
//
// The distinction leaks into everything that names a module — the finder, the
// slide-number chrome, the palette — so it lives in one place with one set of
// names rather than as `hasMarkersDOM ? … : …` at each call site.
//
// An embedded instance (a preview inside the finder, `?embedded`) never
// chains: following a link out of a preview would replace the deck the
// presenter is standing in front of.

/**
 * Wire module navigation for a deck.
 *
 * `sectionsOf()`/`slideOf()` read the live deck rather than closing over a
 * snapshot, because markers are found in the DOM the engine has already
 * restructured, and the current slide moves under us.
 */
export function createPlaylist({ config, root, embedded, sectionsOf, slideOf, navigate }) {
  const playlist = (!embedded && config.playlist?.modules?.length) ? config.playlist : null;
  const index = playlist ? (playlist.index ?? 0) : 0;

  // Markers are read once: `bundle --all` writes them, and nothing at run time
  // adds a chapter to a merged deck.
  const hasMarkers = !!root.querySelector('section[data-module]');

  /** The merged deck's chapters, as `{ title, slide }` in deck order. */
  function markers() {
    const out = [];
    (sectionsOf() || []).forEach((s, i) => {
      if (s.hasAttribute('data-module')) out.push({ title: s.getAttribute('data-module'), slide: i + 1 });
    });
    return out;
  }

  /** Which chapter the current slide is in — the last marker at or before it. */
  function currentMarkerIndex(list = markers()) {
    let idx = -1;
    list.forEach((m, i) => { if (m.slide <= slideOf()) idx = i; });
    return idx;
  }

  return {
    /** Null when this deck is not part of a playlist of files. */
    get playlist() { return playlist; },
    /** This deck's position in that playlist. */
    get index() { return index; },
    /** True when the deck carries its own in-file chapter markers. */
    get hasMarkers() { return hasMarkers; },
    /** True when either shape of module navigation applies. */
    get any() { return hasMarkers || !!playlist; },
    markers,
    currentMarkerIndex,

    /**
     * Chain to the module `delta` away, if there is one. Returns false when
     * there is not — which is what makes advancing past the end of the last
     * module a no-op rather than an error.
     *
     * The hash carries where to land: the next module opens at its first
     * slide, the previous one at its last (`#/999/999` clamps).
     */
    gotoModule(delta) {
      if (!playlist) return false;
      const mod = playlist.modules[index + delta];
      if (!mod) return false;
      navigate(mod.href + (delta > 0 ? '#/1/0' : '#/999/999'));
      return true;
    },

    /** Open module `i` of the playlist at its first slide. */
    navigateToModule(i) {
      const mod = playlist?.modules[i];
      if (mod) navigate(mod.href + '#/1/0');
    },

    /** The chapter title to show beside the slide number, or ''. */
    title() {
      if (hasMarkers) {
        const list = markers();
        return list[currentMarkerIndex(list)]?.title || '';
      }
      return playlist?.modules[index]?.title || '';
    },
  };
}
