#!/usr/bin/env node
// Interactive Himalayas remote-jobs crawler.
//   npm run himalayas
//
// Flow: keywords → regions → fields → max jobs → crawl search API →
//       enrich companies via MCP → write JSON to ./output

import { checkbox, confirm, input, number, Separator } from '@inquirer/prompts';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { EUROPE, EUROPE_ALL, NORTH_AMERICA, expandRegions } from './regions.js';
import { FIELDS, UNAVAILABLE } from './fields.js';
import { crawlJobs, enrichCompanies, buildCompanies } from './crawler.js';
import { McpClient } from './mcp.js';
import { CompanyCache } from './cache.js';
import { RateGate } from './http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const CACHE_FILE = path.join(ROOT, '.cache', 'himalayas-companies.json');
const RATE_LIMIT_LOG = path.join(ROOT, 'logs', 'rate-limit.ndjson');
const MAX_JOBS_LIMIT = 10_000;

const log = (msg = '') => console.log(msg);

async function askOptions() {
  log('\n🏔  Himalayas remote jobs crawler  (all Himalayas jobs are remote)\n');

  const typed = (await input({
    message: 'Search keywords, e.g. "react native" (leave empty for all jobs):',
    default: 'mobile engineer',
  })).trim();
  // Himalayas requires EVERY word to match, so "react native jobs in United
  // States" finds 0 jobs while "react native" finds 286. Strip filler words and
  // place names (location is chosen in the next question).
  const keywords = cleanKeywords(typed);
  if (keywords !== typed) log(`  → searching for "${keywords || '(all jobs)'}" (location and filler words removed)`);

  const regionSelection = await checkbox({
    message: 'Regions (space = toggle, a = all, enter = confirm):',
    pageSize: 15,
    required: true,
    choices: [
      ...NORTH_AMERICA.map((c) => ({ name: c.name, value: c.code, checked: true })),
      { name: `Europe — all ${EUROPE.length} countries`, value: EUROPE_ALL, checked: true },
      new Separator('── or pick individual European countries ──'),
      ...EUROPE.map((c) => ({ name: c.name, value: c.code })),
    ],
  });
  const countries = expandRegions(regionSelection);

  const includeWorldwide = await confirm({
    message: 'Also include jobs open worldwide (not tied to these countries)?',
    default: false,
  });

  const optional = FIELDS.filter((f) => !f.required);
  const pickedKeys = await checkbox({
    message: 'Fields to return (Company name + domain are always included):',
    pageSize: 20,
    choices: [
      new Separator('── Company (1 extra request per company) ──'),
      ...optional.filter((f) => f.source === 'company').map(toChoice),
      new Separator('── Job (no extra requests) ──'),
      ...optional.filter((f) => f.source === 'job').map(toChoice),
      new Separator('── Not available from Himalayas ──'),
      ...UNAVAILABLE.map((name) => ({ name, value: null, disabled: ' ' })),
    ],
  });
  const selectedKeys = [...FIELDS.filter((f) => f.required).map((f) => f.key), ...pickedKeys];

  const maxJobs = await number({
    message: `Max jobs to crawl (1–${MAX_JOBS_LIMIT}):`,
    default: 100,
    min: 1,
    max: MAX_JOBS_LIMIT,
    required: true,
  });

  return { keywords, regionSelection, countries, includeWorldwide, selectedKeys, maxJobs };
}

const FILLER_WORDS = /\b(remote|jobs?|positions?|roles?|openings?|vacanc(?:y|ies)|hiring|compan(?:y|ies)|work|from|in|for|at|near|the|an?)\b/gi;
const PLACE_NAMES = [...NORTH_AMERICA, ...EUROPE].map((c) => c.name)
  .concat(['North America', 'America', 'Europe', 'European Union', 'USA', 'UK', 'EU', 'anywhere', 'worldwide'])
  .sort((a, b) => b.length - a.length); // "United Kingdom" before "United"

function cleanKeywords(text) {
  let q = text;
  for (const name of PLACE_NAMES) q = q.replace(new RegExp(`\\b${name}\\b`, 'gi'), ' ');
  q = q.replace(/\bUS\b/g, ' '); // uppercase only, so a word like "us" in a query survives
  return q.replace(FILLER_WORDS, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

const toChoice = (f) => ({ name: f.label, value: f.key, checked: Boolean(f.checked) });

async function run(opts) {
  const { keywords, countries, includeWorldwide, selectedKeys, maxJobs } = opts;

  // First Ctrl+C stops gracefully and saves what was collected; second one quits.
  const controller = new AbortController();
  process.on('SIGINT', () => {
    if (controller.signal.aborted) process.exit(130);
    log('\n⏹  Stopping… saving partial results (Ctrl+C again to quit immediately)');
    controller.abort(new Error('Interrupted'));
  });
  const { signal } = controller;
  const onRetry = (msg) => log(`  ↻ ${msg}`);
  const started = Date.now();

  // One gate per API: a 429 pauses every worker on that API, and each hit is
  // logged (console + logs/rate-limit.ndjson) with the request rate at that moment.
  await mkdir(path.dirname(RATE_LIMIT_LOG), { recursive: true });
  const onRateLimit = (e) => {
    if (!e.alreadyPaused) {
      log(`  ⏸ 429 from ${e.api} API after ${e.requestsLastMinute} requests in the last 60s ` +
        `(${e.requestsTotal} total, ${e.secondsSinceStart}s in) — pausing all ${e.api} requests ${e.pauseSeconds}s`);
    }
    appendFile(RATE_LIMIT_LOG, JSON.stringify(e) + '\n').catch(() => {});
  };
  const searchGate = new RateGate('search', { onRateLimit });
  const mcpGate = new RateGate('mcp', { onRateLimit });

  log(`\n[1/3] Searching ${countries.length} ${countries.length === 1 ? 'country' : 'countries'}…`);
  const { jobs, perCountry, requests } = await crawlJobs({
    q: keywords, countries, excludeWorldwide: !includeWorldwide, maxJobs, signal, log, onRetry, gate: searchGate,
  });
  log(`  ✔ ${jobs.size} unique jobs (${requests} requests)`);
  if (!jobs.size && !signal.aborted) {
    log('  ⚠ No jobs matched. Himalayas needs every keyword to appear in the job,');
    log('    so try fewer or more common words (e.g. "react native" instead of "senior react native mobile dev").');
  }

  const slugs = [...new Set([...jobs.values()].map((j) => j.raw.companySlug))];
  let enrich = { details: new Map(), fetched: 0, failed: 0 };
  // Domain is required, so company details are always fetched.
  if (slugs.length && !signal.aborted) {
    log(`\n[2/3] Fetching details for ${slugs.length} companies…`);
    const cache = await new CompanyCache(CACHE_FILE).load();
    enrich = await enrichCompanies({ slugs, mcp: new McpClient({ signal, onRetry, gate: mcpGate }), cache, signal, log });
  }

  log('\n[3/3] Writing output…');
  const companies = buildCompanies({ jobs, details: enrich.details, selectedKeys });
  const result = {
    meta: {
      source: 'Himalayas (https://himalayas.app) — public Jobs API + MCP server',
      attribution: 'If you display this data publicly, link back to himalayas.app.',
      generatedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - started) / 1000),
      partial: signal.aborted,
      query: {
        keywords: keywords || null,
        countries: countries.map((c) => c.code),
        includeWorldwide,
        maxJobs,
        fields: selectedKeys,
      },
      totals: {
        jobs: jobs.size,
        companies: companies.length,
        companiesWithDomain: companies.filter((c) => c.companyDomain).length,
        companiesWithoutProfile: companies.filter((c) => c.note?.startsWith('No company')).length,
        companiesNotFetched: companies.filter((c) => c.note?.startsWith('Company details not')).length,
        companyLookupsFailed: enrich.failed,
        searchRequests: requests,
      },
      rateLimit: { search: searchGate.summary(), mcp: mcpGate.summary() },
      perCountry: Object.fromEntries(perCountry.map((s) => [s.code, {
        name: s.name,
        totalAvailable: s.totalAvailable,
        collected: s.contributed,
        ...(s.error && { error: s.error }),
      }])),
    },
    companies,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  const slug = (keywords || 'all-jobs').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(OUTPUT_DIR, `himalayas-${slug}-${stamp}.json`);
  await writeFile(file, JSON.stringify(result, null, 2));

  const t = result.meta.totals;
  log(`  ✔ ${t.jobs} jobs · ${t.companies} companies · ${t.companiesWithDomain} with domain`);
  const hits = result.meta.rateLimit.search.rateLimitHits + result.meta.rateLimit.mcp.rateLimitHits;
  if (hits) log(`  ⚠ Rate limited ${hits} time(s) — details in ${path.relative(process.cwd(), RATE_LIMIT_LOG)}`);
  log(`\n📄 ${path.relative(process.cwd(), file)}${result.meta.partial ? '  (partial — interrupted)' : ''}\n`);
}

try {
  const opts = await askOptions();
  await run(opts);
  process.exit(0);
} catch (err) {
  if (err?.name === 'ExitPromptError') {
    log('\nCancelled.');
    process.exit(0);
  }
  console.error(`\n✖ ${err?.message ?? err}`);
  process.exit(1);
}
