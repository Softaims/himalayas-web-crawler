// Shared fetch wrapper: timeout, retries, abort support (Ctrl+C), and a
// per-API RateGate so a 429 pauses *every* worker hitting that API, not just
// the one that got it.

export const USER_AGENT = 'himalayas-cli/1.0 (personal job research script)';

// The OpenAPI spec says: 429 → "Rate limit exceeded. Wait 60 seconds before retrying."
// Overridable for testing against a mock server.
export const RATE_LIMIT_WAIT_MS = Number(process.env.HIMALAYAS_429_WAIT_MS) || 60_000;

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

/**
 * One gate per API (search, mcp). Tracks requests sent in the last 60s and,
 * after a 429, holds all callers until the pause is over.
 */
export class RateGate {
  #sent = []; // timestamps within the last 60s
  #pausedUntil = 0;

  constructor(name, { onRateLimit } = {}) {
    this.name = name;
    this.onRateLimit = onRateLimit; // (event) => void — for logging
    this.startedAt = Date.now();
    this.total = 0;
    this.hits = [];
  }

  async ready(signal) {
    while (Date.now() < this.#pausedUntil) await sleep(this.#pausedUntil - Date.now(), signal);
  }

  record() {
    this.#sent.push(Date.now());
    this.total++;
  }

  lastMinute() {
    const cutoff = Date.now() - 60_000;
    while (this.#sent.length && this.#sent[0] < cutoff) this.#sent.shift();
    return this.#sent.length;
  }

  /** Called on a 429: pauses the whole gate and reports the moment for analysis. */
  rateLimited({ url, status, retryAfterHeader, waitMs }) {
    const already = Date.now() < this.#pausedUntil;
    this.#pausedUntil = Math.max(this.#pausedUntil, Date.now() + waitMs);
    const event = {
      at: new Date().toISOString(),
      api: this.name,
      status,
      url: String(url),
      requestsLastMinute: this.lastMinute(),
      requestsTotal: this.total,
      secondsSinceStart: Math.round((Date.now() - this.startedAt) / 1000),
      retryAfterHeader,
      pauseSeconds: Math.round(waitMs / 1000),
      alreadyPaused: already, // true = another worker hit it first; not a new data point
    };
    this.hits.push(event);
    this.onRateLimit?.(event);
  }

  summary() {
    return { requests: this.total, rateLimitHits: this.hits.filter((h) => !h.alreadyPaused).length, hits: this.hits };
  }
}

/**
 * @param {object} cfg
 * @param {number} [cfg.retries]           retries for 5xx / network errors (exponential backoff)
 * @param {number} [cfg.rateLimitRetries]  retries for 429 (each waits ≥60s)
 * @param {RateGate} [cfg.gate]
 */
export async function fetchWithRetry(url, options = {}, { retries = 4, rateLimitRetries = 3, timeoutMs = 30_000, signal, onRetry, gate } = {}) {
  let errorAttempts = 0;
  let rateLimitAttempts = 0;

  for (;;) {
    await gate?.ready(signal);
    gate?.record();

    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await fetch(url, { ...options, headers: { 'User-Agent': USER_AGENT, ...options.headers }, signal: combined });
    } catch (err) {
      if (signal?.aborted || errorAttempts >= retries) throw err;
      const wait = backoff(errorAttempts++);
      onRetry?.(`network error (${err.cause?.code ?? err.name}), retrying in ${wait / 1000}s`);
      await sleep(wait, signal);
      continue;
    }

    if (res.status === 429) {
      await res.body?.cancel();
      const retryAfterHeader = res.headers.get('retry-after');
      const waitMs = Math.max(parseRetryAfter(retryAfterHeader) ?? 0, RATE_LIMIT_WAIT_MS);
      gate?.rateLimited({ url, status: 429, retryAfterHeader, waitMs });
      if (rateLimitAttempts++ >= rateLimitRetries) throw new Error(`HTTP 429 (rate limited) from ${url} — gave up after ${rateLimitRetries} waits`);
      if (!gate) await sleep(waitMs, signal); // with a gate, ready() does the waiting
      continue;
    }

    if (res.status >= 500) {
      await res.body?.cancel();
      if (errorAttempts >= retries) throw new Error(`HTTP ${res.status} from ${url}`);
      const wait = backoff(errorAttempts++);
      onRetry?.(`HTTP ${res.status}, retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait, signal);
      continue;
    }
    return res;
  }
}

// Retry-After is either seconds ("120") or an HTTP date.
function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

// 2s, 4s, 8s, 16s … plus jitter so parallel workers don't retry in lockstep.
const backoff = (attempt) => 2000 * 2 ** attempt + Math.floor(Math.random() * 500);
