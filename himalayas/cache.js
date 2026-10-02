// On-disk cache for company details so repeat runs don't re-fetch the same
// companies. Himalayas refreshes data daily, so 7 days is plenty for company
// profiles (website, LinkedIn, CEO rarely change).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class CompanyCache {
  constructor(file) {
    this.file = file;
    this.entries = {};
  }

  async load() {
    try {
      this.entries = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      this.entries = {}; // missing or corrupt cache → start fresh
    }
    return this;
  }

  /** Returns { hit: true, value } (value may be null = "no profile") or { hit: false }. */
  get(slug) {
    const e = this.entries[slug];
    if (!e || Date.now() - e.fetchedAt > TTL_MS) return { hit: false };
    return { hit: true, value: e.value };
  }

  set(slug, value) {
    this.entries[slug] = { fetchedAt: Date.now(), value };
  }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.entries));
  }
}
