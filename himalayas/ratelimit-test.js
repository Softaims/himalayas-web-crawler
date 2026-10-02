#!/usr/bin/env node
// Finds the rate limit of a Himalayas API by slowly raising the request rate
// and stopping at the FIRST 429 (or any sign of blocking).
//
//   npm run ratelimit-test -- --api search
//   npm run ratelimit-test -- --api mcp --start 2 --max 8
//
// Options:
//   --api     search | mcp                         (required)
//   --start   requests/second for the first stage  (default 1)
//   --step    added requests/second per stage      (default 1)
//   --stage   seconds per stage                    (default 60)
//   --max     highest requests/second to try       (default 5, hard cap 20)
//   --mode    search only: unique | same           (default unique)
//             unique = new query each time → reaches Himalayas' server
//             same   = identical URL → mostly Cloudflare cache hits
//   --yes     skip the confirmation prompt

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm } from '@inquirer/prompts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARD_CAP_RPS = 20;
const MAX_IN_FLIGHT = 20;
const USER_AGENT = 'himalayas-cli/1.0 ratelimit-test';

const { values: args } = parseArgs({
  options: {
    api: { type: 'string' },
    start: { type: 'string', default: '1' },
    step: { type: 'string', default: '1' },
    stage: { type: 'string', default: '60' },
    max: { type: 'string', default: '5' },
    mode: { type: 'string', default: 'unique' },
    yes: { type: 'boolean', default: false },
  },
});

const api = args.api;
const start = Number(args.start);
const step = Number(args.step);
const stageSec = Number(args.stage);
const maxRps = Math.min(Number(args.max), HARD_CAP_RPS);
if (!['search', 'mcp'].includes(api) || !(start > 0) || !(step > 0) || !(stageSec >= 10) || !(maxRps >= start)
  || !['unique', 'same'].includes(args.mode)) {
  console.error('Usage: npm run ratelimit-test -- --api search|mcp [--start 1] [--step 1] [--stage 60] [--max 5] [--mode unique|same] [--yes]');
  process.exit(1);
}

const stages = [];
for (let r = start; r <= maxRps + 1e-9; r += step) stages.push(Number(r.toFixed(2)));
const worstCase = stages.reduce((sum, r) => sum + r * stageSec, 0);
const runId = Date.now().toString(36);

// ── request builders ────────────────────────────────────────────────────────
let n = 0;
async function buildRequest() {
  n++;
  if (api === 'search') {
    const url = new URL('https://himalayas.app/jobs/api/search');
    url.searchParams.set('country', 'US');
    // Cloudflare ignores unknown params in its cache key, so a cache-buster
    // doesn't work; a unique `q` does. The prefix makes these easy to spot in their logs.
    url.searchParams.set('q', args.mode === 'unique' ? `ratelimit-test-${runId}-${n}` : 'engineer');
    return { url, init: { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } } };
  }
  const slug = slugs[n % slugs.length];
  return {
    url: 'https://mcp.himalayas.app/mcp',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'get_company_details', arguments: { company_slug: slug } } }),
    },
  };
}

// Real company slugs from the crawler cache, so MCP calls are realistic.
let slugs = ['stripe', 'gitlab', 'dexcom', 'bjak', 'lemon-io'];
if (api === 'mcp') {
  try {
    const cached = Object.keys(JSON.parse(await readFile(path.join(ROOT, '.cache', 'himalayas-companies.json'), 'utf8')));
    if (cached.length >= 5) slugs = cached;
  } catch { /* no cache yet — use defaults */ }
}

// ── state ───────────────────────────────────────────────────────────────────
const sentTimes = []; // for the sliding 60s window
const results = []; // { stage, status, ms, cache }
let inFlight = 0;
let sentTotal = 0;
let peakWindow = 0; // most requests seen in any 60s window
let skipped = 0;
let stopReason = null;
let trigger = null;
const t0 = Date.now();

const lastMinute = () => {
  const cutoff = Date.now() - 60_000;
  while (sentTimes.length && sentTimes[0] < cutoff) sentTimes.shift();
  return sentTimes.length;
};

async function fire(stageRps) {
  if (inFlight >= MAX_IN_FLIGHT) { skipped++; return; } // server is slowing down; don't pile on
  const { url, init } = await buildRequest();
  inFlight++;
  sentTimes.push(Date.now());
  sentTotal++;
  peakWindow = Math.max(peakWindow, lastMinute());
  const begin = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    const body = await res.text();
    const ms = Date.now() - begin;
    const cache = res.headers.get('cf-cache-status');
    results.push({ stage: stageRps, status: res.status, ms, cache });

    const mcpLimited = api === 'mcp' && res.ok && /rate.?limit|too many requests/i.test(body);
    const blocked = res.status === 403 || res.status === 503 || /<title>Just a moment/i.test(body);
    if (!stopReason && (res.status === 429 || mcpLimited || blocked)) {
      stopReason = res.status === 429 || mcpLimited ? 'rate-limited' : 'blocked';
      trigger = {
        at: new Date().toISOString(),
        secondsSinceStart: Math.round((Date.now() - t0) / 1000),
        stageRps,
        requestsLastMinute: lastMinute(),
        requestsTotal: sentTotal,
        status: res.status,
        headers: Object.fromEntries([...res.headers].filter(([k]) => /rate|retry|limit|cf-|server/i.test(k))),
        bodySnippet: body.slice(0, 500),
      };
    }
  } catch (err) {
    results.push({ stage: stageRps, status: 0, ms: Date.now() - begin, error: err.cause?.code ?? err.name });
  } finally {
    inFlight--;
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
console.log(`\nRate-limit test — ${api} API${api === 'search' ? ` (mode: ${args.mode})` : ''}`);
console.log(`Stages: ${stages.join(', ')} req/s, ${stageSec}s each  →  up to ${Math.ceil(stages.length * stageSec / 60)} min, ${Math.round(worstCase)} requests`);
console.log('Stops at the first 429, 403 or Cloudflare challenge.\n');
if (!args.yes && !(await confirm({ message: 'Start?', default: false }))) process.exit(0);

process.on('SIGINT', () => { stopReason ??= 'interrupted'; });

for (const rps of stages) {
  if (stopReason) break;
  const interval = 1000 / rps;
  const stageEnd = Date.now() + stageSec * 1000;
  let next = Date.now();
  process.stdout.write(`▶ ${String(rps).padStart(5)} req/s `);
  while (Date.now() < stageEnd && !stopReason) {
    fire(rps);
    next += interval;
    await new Promise((r) => setTimeout(r, Math.max(0, next - Date.now())));
  }
  const s = results.filter((r) => r.stage === rps);
  const lat = s.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? 0;
  const statuses = countBy(s, (r) => r.status);
  const caches = countBy(s.filter((r) => r.cache), (r) => r.cache);
  console.log(`sent ${String(s.length).padStart(4)}  ${fmt(statuses)}  p50 ${pct(0.5)}ms p95 ${pct(0.95)}ms` +
    (Object.keys(caches).length ? `  cache ${fmt(caches)}` : '') + `  (${lastMinute()} in last 60s)`);
}

while (inFlight) await new Promise((r) => setTimeout(r, 100)); // let stragglers finish

// ── report ──────────────────────────────────────────────────────────────────
const report = {
  api,
  mode: api === 'search' ? args.mode : undefined,
  runId,
  startedAt: new Date(t0).toISOString(),
  durationSeconds: Math.round((Date.now() - t0) / 1000),
  settings: { start, step, stageSec, maxRps },
  outcome: stopReason ?? 'no-limit-found',
  trigger,
  totals: { requests: results.length, peakRequestsIn60s: peakWindow, skippedBecauseSlow: skipped, statuses: countBy(results, (r) => r.status) },
  results,
};
await mkdir(path.join(ROOT, 'logs'), { recursive: true });
const file = path.join(ROOT, 'logs', `ratelimit-test-${api}-${runId}.json`);
await writeFile(file, JSON.stringify(report, null, 2));

console.log('\n── Result ──');
if (stopReason === 'rate-limited') {
  console.log(`429 at ${trigger.stageRps} req/s after ${trigger.secondsSinceStart}s.`);
  console.log(`Requests in the 60s before it: ${trigger.requestsLastMinute}  ← best estimate of the per-minute limit`);
  console.log('Relevant headers:', trigger.headers);
} else if (stopReason === 'blocked') {
  console.log(`⚠ Blocked (HTTP ${trigger.status}) at ${trigger.stageRps} req/s — likely Cloudflare bot protection, not the API limit.`);
  console.log('  Stop testing for now; your IP may be challenged for a while.');
} else if (stopReason === 'interrupted') {
  console.log('Interrupted — no limit hit before stopping.');
} else {
  console.log(`No limit hit up to ${maxRps} req/s — peak ${peakWindow} requests in a 60s window.`);
  console.log('So the per-minute limit (if any) is above that. Re-run with a higher --start/--max to go further.');
}
if (skipped) console.log(`${skipped} requests skipped because ${MAX_IN_FLIGHT} were already in flight (server slowing down).`);
console.log(`\nFull report: ${path.relative(process.cwd(), file)}`);
console.log('Wait at least 60s before running the crawler or another test.\n');
process.exit(0);

function countBy(arr, key) {
  return arr.reduce((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), {});
}
function fmt(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}:${v}`).join(' ') || '-';
}
