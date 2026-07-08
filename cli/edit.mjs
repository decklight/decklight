#!/usr/bin/env node
// decklight edit — the live-editing dev server (SPEC §8 edit mode).
//
//   decklight edit <deck.html> [--port 8788]
//
// Serves the current working directory over localhost (so decks that
// reference ../dist and ../themes just work), watches the deck file, and:
//
//   GET  /edit/ping    → { ok, deck }              (player probes availability)
//   GET  /edit/events  → SSE; a `reload` event fires when the deck changes
//   POST /edit/notes   → { slide, text }           rewrite that slide's notes
//
// The player's E editor posts ⟨CLICK⟩-separated plain text; the server
// rebuilds the <aside class="notes"> (one <p> per segment, escaped) and
// writes the file — the watcher then tells every connected browser to
// reload, and the #/slide/step hash restores the position.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, watch, existsSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** ⟨CLICK⟩-separated plain text → the aside's inner HTML (one <p> per segment). */
export function notesTextToAside(text) {
  const segs = text.split(/\s*⟨CLICK⟩\s*/).map((s) => s.replace(/\s+/g, ' ').trim());
  const ps = [];
  segs.forEach((seg, i) => {
    if (i > 0) ps.push('<p>⟨CLICK⟩</p>');
    if (seg) ps.push(`<p>${escapeHtml(seg)}</p>`);
  });
  return ps.join('\n        ');
}

/** Replace (or insert) slide N's <aside class="notes"> in the deck html. */
export function setSlideNotes(html, slide, asideInner) {
  // top-level sections can't nest, so splitting on the open tag is exact
  const parts = html.split(/(<section\b)/);
  const idx = 2 * slide; // parts[0] preamble, then [tag, content] pairs
  if (!parts[idx]) throw new Error(`no slide ${slide} (deck has ${(parts.length - 1) / 2})`);
  const aside = `<aside class="notes">\n        ${asideInner}\n      </aside>`;
  const seg = parts[idx];
  parts[idx] = /<aside class="notes">[\s\S]*?<\/aside>/.test(seg)
    ? seg.replace(/<aside class="notes">[\s\S]*?<\/aside>/, aside)
    : seg.replace(/<\/section>/, `  ${aside}\n    </section>`);
  return parts.join('');
}

export async function editMain(args) {
  if (args.includes('--help') || args.includes('-h') || !args.filter((a) => !a.startsWith('-')).length) {
    console.log('usage: decklight edit <deck.html> [--port 8788]\n  serves the cwd, live-reloads the deck on change, and accepts notes edits from the player (E)');
    return;
  }
  const opt = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : dflt; };
  const port = Number(opt('--port', 8788));
  const root = process.cwd();
  const deckPath = resolve(root, args.find((a) => !a.startsWith('-')));
  if (!existsSync(deckPath)) { console.error(`deck not found: ${deckPath}`); process.exitCode = 1; return; }
  if (!deckPath.startsWith(root + sep)) { console.error('deck must live under the current directory'); process.exitCode = 1; return; }
  const deckUrl = '/' + deckPath.slice(root.length + 1).split(sep).join('/');

  // ── live reload: watch the deck, broadcast SSE (debounced — editors fire
  // multiple fs events per save) ─────────────────────────────────────────
  const clients = new Set();
  let pending = null;
  watch(deckPath, () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      for (const res of clients) res.write('data: reload\n\n');
      console.log(`  changed → reload × ${clients.size}`);
    }, 150);
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/edit/ping') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, deck: deckUrl }));
      }
      if (req.method === 'GET' && url.pathname === '/edit/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/edit/notes') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 1e6) throw new Error('too large'); }
        const { slide, text } = JSON.parse(body);
        if (!Number.isInteger(slide) || slide < 1 || typeof text !== 'string') throw new Error('bad payload');
        const html = readFileSync(deckPath, 'utf8');
        writeFileSync(deckPath, setSlideNotes(html, slide, notesTextToAside(text)));
        console.log(`  notes saved: slide ${slide} (${text.length} chars)`);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      // ── static files from the cwd ────────────────────────────────────
      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? deckUrl : decodeURIComponent(url.pathname);
        const file = resolve(root, '.' + rel);
        if (!file.startsWith(root + sep) && file !== root) { res.writeHead(403); return res.end('forbidden'); }
        if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        return res.end(readFileSync(file));
      }
      res.writeHead(405);
      res.end();
    } catch (e) {
      console.error(`  edit error: ${String(e).slice(0, 120)}`);
      if (!res.headersSent) res.writeHead(400);
      res.end(String(e.message || e));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`decklight edit on http://127.0.0.1:${port}${deckUrl} — E edits notes, saves reload the deck. Ctrl-C stops`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) editMain(process.argv.slice(2));
