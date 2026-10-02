import { searchJobs } from './jobsApi.js';
import { sleep } from './http.js';
import { fieldsByKey } from './fields.js';

const SEARCH_DELAY_MS = 400; // pause between search requests (API is rate limited)
const ENRICH_CONCURRENCY = 3; // parallel MCP calls
const ENRICH_DELAY_MS = 250; // pause per worker between MCP calls

/**
 * Step 1 — collect up to `maxJobs` unique jobs across all countries.
 *
 * Fairness: each country first gets an equal share (ceil(max / countries)), so
 * the US doesn't eat the whole budget. Countries that run out leave their
 * unused share to the others in a second, uncapped round-robin pass.
 *
 * Dedupe: the same job often matches several countries (e.g. "US or Canada").
 * Jobs are keyed by `guid`; repeats only add the country to `regions`.
 */
export async function crawlJobs({ q, countries, excludeWorldwide, maxJobs, signal, log, onRetry, gate }) {
  const jobs = new Map(); // guid → { raw, regions: Set<code> }
  const state = countries.map((c) => ({
    ...c, page: 1, exhausted: false, buffer: [], totalAvailable: null, contributed: 0, error: null,
  }));
  const share = Math.ceil(maxJobs / countries.length);
  let requests = 0;

  for (const cap of [share, Infinity]) {
    let progressed = true;
    while (progressed && jobs.size < maxJobs && !signal.aborted) {
      progressed = false;
      for (const s of state) {
        if (s.contributed >= cap || jobs.size >= maxJobs || signal.aborted) continue;

        // Refill this country's buffer with its next page. Leftovers stay in
        // the buffer when the country hits its share mid-page, so phase 2
        // continues exactly where phase 1 stopped.
        let fetched = false;
        if (!s.buffer.length) {
          if (s.exhausted) continue;
          try {
            const res = await searchJobs({ q, country: s.code, excludeWorldwide, page: s.page }, { signal, onRetry, gate });
            requests++;
            s.totalAvailable ??= res.totalCount;
            s.buffer = res.jobs;
            s.page++;
            // Pages can come back with fewer than 20 jobs mid-way, so only an
            // empty page or passing totalCount means the country is finished.
            if (res.jobs.length === 0 || (s.page - 1) * 20 >= s.totalAvailable) s.exhausted = true;
          } catch (err) {
            if (signal.aborted) break;
            s.exhausted = true;
            s.error = err.message;
            log(`  ⚠ ${s.name}: ${err.message} — skipping this country`);
            continue;
          }
          progressed = fetched = true;
          await sleep(SEARCH_DELAY_MS, signal).catch(() => {});
        }

        while (s.buffer.length && s.contributed < cap && jobs.size < maxJobs) {
          const raw = s.buffer.shift();
          progressed = true;
          const existing = jobs.get(raw.guid);
          if (existing) existing.regions.add(s.code);
          else {
            jobs.set(raw.guid, { raw, regions: new Set([s.code]) });
            s.contributed++;
          }
        }
        if (fetched) log(`  ${s.name.padEnd(15)} page ${String(s.page - 1).padStart(3)}  ${String(jobs.size).padStart(5)}/${maxJobs} jobs`);
      }
    }
  }

  return { jobs, perCountry: state, requests };
}

/**
 * Step 2 — fetch company details (domain, LinkedIn, CEO…) through the MCP
 * server, once per unique company, using the cache where possible.
 */
export async function enrichCompanies({ slugs, mcp, cache, signal, log }) {
  const details = new Map();
  const todo = [];
  for (const slug of slugs) {
    const c = cache.get(slug);
    if (c.hit) details.set(slug, c.value);
    else todo.push(slug);
  }
  log(`  ${slugs.length - todo.length} companies from cache, ${todo.length} to fetch`);

  let done = 0;
  let failed = 0;
  const queue = [...todo];
  const worker = async () => {
    while (queue.length && !signal.aborted) {
      const slug = queue.shift();
      try {
        const value = await mcp.getCompanyDetails(slug);
        details.set(slug, value);
        cache.set(slug, value);
      } catch (err) {
        if (signal.aborted) return;
        failed++;
        log(`  ⚠ ${slug}: ${err.message}`);
      }
      done++;
      if (done % 10 === 0 || done === todo.length) log(`  ${done}/${todo.length} companies fetched`);
      await sleep(ENRICH_DELAY_MS, signal).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker));
  await cache.save();

  return { details, fetched: done - failed, failed };
}

/**
 * Step 3 — shape the output: one entry per company (what lead lists need),
 * with that company's matching jobs nested inside. Only selected fields are kept.
 */
export function buildCompanies({ jobs, details, selectedKeys }) {
  const companyFields = selectedKeys.map((k) => fieldsByKey.get(k)).filter((f) => f.source === 'company');
  const jobFields = selectedKeys.map((k) => fieldsByKey.get(k)).filter((f) => f.source === 'job' && f.key !== 'companyName');

  const companies = new Map();
  for (const { raw, regions } of jobs.values()) {
    const slug = raw.companySlug;
    if (!companies.has(slug)) {
      const d = details.get(slug);
      const entry = {
        companyName: d?.name ?? raw.companyName,
        companySlug: slug,
        himalayasUrl: `https://himalayas.app/companies/${slug}`,
      };
      for (const f of companyFields) entry[f.key] = d ? f.get(d) ?? null : null;
      if (!details.has(slug)) entry.note = 'Company details not fetched (lookup failed or run interrupted)';
      else if (d === null) entry.note = 'No company profile on Himalayas';
      entry.jobs = [];
      companies.set(slug, entry);
    }

    const job = { matchedRegions: [...regions] };
    for (const f of jobFields) job[f.key] = f.get(raw) ?? null;
    companies.get(slug).jobs.push(job);
  }

  return [...companies.values()]
    .map(({ jobs: list, ...c }) => ({ ...c, jobCount: list.length, jobs: list }))
    .sort((a, b) => b.jobCount - a.jobCount || a.companyName.localeCompare(b.companyName));
}
