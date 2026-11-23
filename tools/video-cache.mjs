// Copyright 2026 Gilles Philippart
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function videoDigest(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Retain the head, scripts, and everything between slides in the shared key.
// The slide's own markup is fingerprinted separately.
export function videoMarkup(html) {
  const slides = [];
  const shared = html.replace(/<section\b[\s\S]*?<\/section\s*>/gi, (slide) => {
    slides.push(slide);
    return '<section></section>';
  });
  return { shared, slides };
}

export function videoCache({ out, origin, deckUrl, signal }) {
  const root = join(dirname(out), '.' + basename(out) + '.decklight-cache');
  const assets = new Map();

  function asset(path) {
    if (!assets.has(path)) assets.set(path, (async () => {
      const url = new URL(path, origin);
      if (url.origin !== origin || url.pathname === new URL(deckUrl).pathname) return null;
      const response = await fetch(url, { signal, redirect: 'error' });
      const hash = createHash('sha256').update(String(response.status));
      for await (const chunk of response.body ?? []) hash.update(chunk);
      return hash.digest('hex');
    })().catch(() => null));
    return assets.get(path);
  }

  const metadataFor = (slide) => join(root, slide + '.json');
  function read(slide) {
    try { return JSON.parse(readFileSync(metadataFor(slide), 'utf8')); } catch { return null; }
  }

  async function load(slide, key, work) {
    try {
      const meta = read(slide);
      if (meta?.key !== key || !meta.files.length) return null;
      const dir = join(root, basename(meta.dir));
      for (const [path, digest] of meta.assets) {
        if (await asset(path) !== digest) return null;
      }
      return meta.files.map((file) => {
        const name = basename(file);
        const target = join(work, 'cached-' + name);
        copyFileSync(join(dir, name), target);
        return target;
      });
    } catch {
      return null;
    }
  }

  async function save(slide, key, files, resources) {
    const paths = new Set();
    for (const resource of resources) {
      const url = new URL(resource);
      if (url.protocol === 'data:' || url.protocol === 'blob:') continue;
      if (url.origin !== origin) return;
      if (url.pathname === new URL(deckUrl).pathname) continue;
      paths.add(url.pathname + url.search);
    }
    const checks = await Promise.all([...paths].map(async (path) => [path, await asset(path)]));
    if (checks.some(([, digest]) => digest === null)) return;
    mkdirSync(root, { recursive: true });
    const temp = mkdtempSync(join(root, 'slide-'));
    const previous = read(slide);
    try {
      const names = files.map((file) => basename(file));
      files.forEach((file, i) => copyFileSync(file, join(temp, names[i])));
      const metadata = join(temp, 'slide.json');
      writeFileSync(metadata, JSON.stringify({ key, dir: basename(temp), files: names, assets: checks }));
      renameSync(metadata, metadataFor(slide));
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      throw error;
    }
    if (/^slide-[\w-]+$/.test(previous?.dir)) {
      rmSync(join(root, previous.dir), { recursive: true, force: true });
    }
  }

  return { load, save };
}
