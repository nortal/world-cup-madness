/**
 * fetchWithRetry — exponential-backoff retry helper for the sync-matches Edge Function.
 *
 * References:
 *   - NFR-M5 (rate-budget protection): the provider free tier permits 10 req/min,
 *     so we cap retries at 5 (6 total attempts) per logical call to avoid
 *     exhausting the budget on a single failing endpoint.
 *   - FR-M23 (resilient provider sync): transient provider failures must not
 *     fail the whole sync run; this helper turns 5xx/network/429 into retries
 *     and surfaces a categorised error for non-retryable cases.
 *   - specs/002-match-catalog-read/research.md §R-3 — design rationale:
 *       attempt 1 → if retryable: wait 1s on retry → attempt 2 → wait 2s + jitter → ...
 *       if 429 or 503 with Retry-After header → wait that many seconds (overrides backoff schedule)
 *       if 4xx other than 429 → throw immediately (not retryable; integration_runs.status='error')
 *       if 5xx other than 503 → retry per backoff schedule
 *       max 5 retries (so up to 6 total fetch attempts)
 *
 * Special case: 429 and 503 responses are inspected for a `Retry-After` header.
 * When present (either delta-seconds or HTTP-date), it overrides the next
 * backoff slot, capped at `maxBackoffMs` so a hostile/buggy provider cannot
 * stall the worker indefinitely.
 *
 * Error categorisation feeds `integration_runs.error_message`:
 *   - 'provider.4xx'        — non-retryable client error from the provider (thrown immediately)
 *   - 'provider.5xx'        — server error (after retry exhaustion)
 *   - 'provider.rate-limit' — 429 after retry exhaustion
 *   - 'network'             — fetch threw (DNS, abort, socket) after retry exhaustion
 *
 * Deno-targeted: uses only `fetch`, `Response`, `AbortSignal`, `setTimeout`,
 * `Math.random`. Zero npm/Node/Next imports.
 */

export type RetryOptions = {
  /** Max retry attempts AFTER the initial fetch. Default: 5 (so 6 total tries). */
  maxRetries?: number;
  /** Base backoff in milliseconds. Default: 1000. Doubles per attempt up to maxBackoffMs. */
  baseBackoffMs?: number;
  /** Max backoff cap in milliseconds. Default: 32000. */
  maxBackoffMs?: number;
  /** AbortSignal threaded into each fetch call. Optional. */
  signal?: AbortSignal;
};

export type RetryErrorCategory =
  | 'provider.5xx'
  | 'provider.4xx'
  | 'provider.rate-limit'
  | 'network';

export type RetryableError = {
  category: RetryErrorCategory;
  message: string;
  lastStatus?: number;
  /** Truncated to ~1KB to keep integration_runs.error_message bounded. */
  lastBody?: string;
  attempts: number;
};

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 32000;
const MAX_BODY_CHARS = 1024;

/**
 * Read at most MAX_BODY_CHARS from the response body, swallowing read errors.
 * Used solely to enrich the RetryableError for downstream logging — never
 * propagated to clients.
 */
async function readBodySafe(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return text.slice(0, MAX_BODY_CHARS);
  } catch {
    return undefined;
  }
}

/**
 * Parse a Retry-After header value. Accepts either delta-seconds (integer)
 * or an HTTP-date. Returns milliseconds to wait, or undefined if unparseable
 * or non-positive.
 */
function parseRetryAfter(headerValue: string | null): number | undefined {
  if (headerValue === null) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === '') return undefined;

  // Try delta-seconds first.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  // Fall back to HTTP-date.
  const date = new Date(trimmed);
  const ts = date.getTime();
  if (Number.isFinite(ts)) {
    const delta = ts - Date.now();
    if (delta > 0) return delta;
  }

  return undefined;
}

/**
 * Compute exponential backoff with ±12.5% positive jitter for a given
 * 1-indexed retry attempt number.
 */
function computeBackoff(
  attempt: number,
  baseBackoffMs: number,
  maxBackoffMs: number,
): number {
  const exp = baseBackoffMs * 2 ** (attempt - 1);
  const backoff = Math.min(maxBackoffMs, exp);
  const jitter = Math.random() * 0.25 * backoff;
  return backoff + jitter;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeError(err: RetryableError): Error & RetryableError {
  const e = new Error(err.message) as Error & RetryableError;
  e.category = err.category;
  e.lastStatus = err.lastStatus;
  e.lastBody = err.lastBody;
  e.attempts = err.attempts;
  return e;
}

/**
 * Fetch with exponential-backoff retry. Returns the final Response on success
 * (HTTP 2xx). Throws a `RetryableError`-shaped Error on retry exhaustion or
 * non-retryable failure.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseBackoffMs = options?.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = options?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const signal = options?.signal;

  // Combine caller init.signal (if any) with our options.signal so either can abort.
  const fetchInit: RequestInit = signal ? { ...init, signal } : init;

  let attempts = 0;
  let lastCategory: RetryErrorCategory = 'network';
  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let lastMessage = 'fetchWithRetry: no attempts completed';

  // Total iterations = maxRetries + 1 (initial attempt + up to maxRetries retries).
  for (let attemptIdx = 0; attemptIdx <= maxRetries; attemptIdx++) {
    attempts = attemptIdx + 1;

    let response: Response;
    try {
      response = await fetch(url, fetchInit);
    } catch (err) {
      // Network-class failure (DNS, socket, abort). Retry per backoff schedule.
      lastCategory = 'network';
      lastStatus = undefined;
      lastBody = undefined;
      lastMessage = err instanceof Error ? err.message : String(err);

      if (attemptIdx === maxRetries) break;
      const wait = computeBackoff(attemptIdx + 1, baseBackoffMs, maxBackoffMs);
      await sleep(wait, signal);
      continue;
    }

    // 2xx → success, return immediately.
    if (response.status >= 200 && response.status < 300) {
      return response;
    }

    lastStatus = response.status;

    // 4xx other than 429 → non-retryable, throw immediately.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      lastBody = await readBodySafe(response);
      throw makeError({
        category: 'provider.4xx',
        message: `Provider returned non-retryable ${response.status}`,
        lastStatus: response.status,
        lastBody,
        attempts,
      });
    }

    // 429 or 503 → Retry-After-aware.
    if (response.status === 429 || response.status === 503) {
      lastCategory = response.status === 429 ? 'provider.rate-limit' : 'provider.5xx';
      lastBody = await readBodySafe(response);
      lastMessage = `Provider returned ${response.status}`;

      if (attemptIdx === maxRetries) break;

      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
      const wait =
        retryAfterMs !== undefined
          ? Math.min(maxBackoffMs, retryAfterMs)
          : computeBackoff(attemptIdx + 1, baseBackoffMs, maxBackoffMs);
      await sleep(wait, signal);
      continue;
    }

    // Other 5xx → retry per backoff schedule.
    if (response.status >= 500) {
      lastCategory = 'provider.5xx';
      lastBody = await readBodySafe(response);
      lastMessage = `Provider returned ${response.status}`;

      if (attemptIdx === maxRetries) break;
      const wait = computeBackoff(attemptIdx + 1, baseBackoffMs, maxBackoffMs);
      await sleep(wait, signal);
      continue;
    }

    // Unexpected status (e.g. 1xx, 3xx that fetch didn't follow). Treat as non-retryable.
    lastBody = await readBodySafe(response);
    throw makeError({
      category: 'provider.4xx',
      message: `Provider returned unexpected status ${response.status}`,
      lastStatus: response.status,
      lastBody,
      attempts,
    });
  }

  throw makeError({
    category: lastCategory,
    message: `fetchWithRetry exhausted ${attempts} attempt(s): ${lastMessage}`,
    lastStatus,
    lastBody,
    attempts,
  });
}
