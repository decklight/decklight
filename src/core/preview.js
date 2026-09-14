// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

/**
 * The iframe preview handshake — one copy of it.
 *
 * Four panels show a slide in an embedded deck: the slide finder, the theme
 * picker, the template browser and the history dialog. Each one used to carry
 * its own pair of module-scoped flags (`ready`, `pending`) and its own copy of
 * the same dance: load the document once, queue the request that arrives while
 * it is still loading, replay that request on `load`, and after that steer the
 * embedded deck by postMessage instead of reloading it. Four copies drifted:
 * one forgot to drop the queued request when the document changed underneath
 * it, one had no same-document short-circuit at all and reloaded on every row.
 *
 * `show(frame, target)` is the whole API. A target is whatever the caller
 * browses by (a finder row, a theme name, `{doc, slide}`); three functions say
 * what it means:
 *
 *   docOf(target)      the document the frame must be showing — a change here
 *                      is a reload, anything else is a message
 *   srcFor(target)     the URL to load when it is a reload
 *   messageFor(target) the postMessage payload when it is not
 *
 * State lives per frame element, so a panel that rebuilds its iframe on every
 * open starts clean, and a `load` from a document that was superseded before it
 * finished is ignored rather than replaying a request about the wrong deck.
 */
export function createPreview({ docOf, srcFor, messageFor }) {
  const states = new WeakMap();
  const stateOf = (frame) => {
    let st = states.get(frame);
    if (!st) { st = { doc: undefined, ready: false, pending: null }; states.set(frame, st); }
    return st;
  };

  function show(frame, target) {
    if (!frame || target == null) return;
    const st = stateOf(frame);
    const doc = docOf(target);
    if (st.doc !== doc) {
      st.doc = doc;
      st.ready = false;
      // A request queued while the PREVIOUS document was loading is about that
      // document. Left in place, it fired when this one loaded and swapped the
      // frame straight back to the module the cursor had already left.
      st.pending = null;
      frame.addEventListener('load', () => {
        if (st.doc !== doc) return; // superseded before it loaded
        st.ready = true;
        if (st.pending != null && frame.isConnected) {
          const p = st.pending;
          st.pending = null;
          show(frame, p);
        }
      }, { once: true });
      frame.src = srcFor(target);
      return;
    }
    if (!st.ready) { st.pending = target; return; }
    frame.contentWindow?.postMessage(messageFor(target), '*');
  }

  return { show };
}
