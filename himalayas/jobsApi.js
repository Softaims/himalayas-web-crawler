// Client for the public search API: https://himalayas.app/jobs/api/search
// No auth. Max 20 jobs per page, rate limited (429), data refreshed every 24h.
// Docs: https://himalayas.app/docs/remote-jobs-api

import { fetchWithRetry } from './http.js';

const SEARCH_URL = 'https://himalayas.app/jobs/api/search';

/**
 * @param {object} p
 * @param {string} [p.q]                   free-text keywords
 * @param {string} p.country               ISO alpha-2 code
 * @param {boolean} [p.excludeWorldwide]   only jobs specifically tied to the country
 * @param {number} [p.page]                1-based
 */
export async function searchJobs({ q, country, excludeWorldwide, page = 1 }, opts) {
  const url = new URL(SEARCH_URL);
  if (q) url.searchParams.set('q', q);
  url.searchParams.set('country', country);
  if (excludeWorldwide) url.searchParams.set('exclude_worldwide', 'true');
  url.searchParams.set('page', String(page));

  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } }, opts);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok === false) {
    throw new Error(`Search failed for ${country} page ${page}: ${body?.errors ?? `HTTP ${res.status}`}`);
  }
  return { totalCount: body.totalCount ?? 0, jobs: body.jobs ?? [] };
}
