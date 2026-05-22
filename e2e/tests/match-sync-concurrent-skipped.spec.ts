/**
 * Playwright E2E test — TC-M14 (US-MC: concurrent sync skipped via advisory
 * lock) for feature 002 (match-catalog-read), task T057.
 *
 * Spec source: `specs/002-match-catalog-read/spec.md` — US-MC acceptance:
 *
 *   > TC-M14: Concurrent sync skipped — Given a catalog sync is already in
 *   > flight (advisory lock held), when a second sync caller invokes the Edge
 *   > Function, then the second call returns immediately with
 *   > `outcome='skipped'`, writes an `integration_runs` row with
 *   > `status='skipped'` and `records_processed=0`, and does NOT contact the
 *   > football-data.org provider.
 *
 * Scope:
 *   - HTTP contract under test: POST /functions/v1/sync-matches
 *     (`specs/002-match-catalog-read/contracts/edge-sync-matches.md`).
 *   - Concurrency primitive under test: `pg_try_advisory_lock(hashtext(
 *     'match-catalog-sync'))` wired via the `acquire_match_sync_lock()` +
 *     `release_match_sync_lock()` RPCs from migration 0015.
 *   - Telemetry under test: `integration_runs` row write for both the
 *     winning (`status='success'`) and losing (`status='skipped'`) call.
 *
 * Test strategy — and the known race window:
 *   We fire BOTH manual-resync POSTs through `Promise.all([fetch, fetch])`
 *   so they leave Node on the same ECMAScript event-loop tick. The Edge
 *   Function then races the two invocations through `acquire_match_sync_lock()`:
 *   one wins, the other returns `false` and short-circuits with
 *   `outcome='skipped'`.
 *
 *   The work the winning invocation does (resolve provider fixture / API
 *   call, UPSERT 15 teams + matches, write the finished `integration_runs`
 *   row) takes on the order of 100-300ms under fixture mode, so the second
 *   request — arriving within microseconds via `Promise.all` — reaches
 *   `acquire_match_sync_lock()` well before the first invocation has hit
 *   its `finally { releaseLock() }`. That's the contract this test exercises.
 *
 *   If a future change to the Edge Function makes the critical section short
 *   enough that the second call sometimes acquires the lock cleanly (both
 *   succeed), this test will flake. **The correct response is to fix the
 *   race window in the Edge Function** (e.g. extend the lock hold to cover
 *   the entire `runSync` body, which it already does today via the
 *   `try/finally` around the work). **Do NOT** "fix" flakiness here by
 *   adding `setTimeout`s, retries, or staggered fetches — that would mask
 *   a real serialisation bug.
 *
 * Wires together:
 *   - `supabase/functions/sync-matches/index.ts` — function under test;
 *     read for the exact `outcome='skipped'` response shape (esp.
 *     `in_flight_run_started_at`).
 *   - `supabase/migrations/0015_match_rpcs.sql` — confirms
 *     `acquire_match_sync_lock()` + `release_match_sync_lock()` RPC seams.
 *   - `specs/002-match-catalog-read/research.md` §R-4 — advisory-lock design
 *     rationale (session-scoped, non-blocking, hashtext key).
 *
 * Preconditions:
 *   - Local Supabase stack running (`npx supabase start`).
 *   - `sync-matches` Edge Function served locally:
 *       `npx supabase functions serve sync-matches --env-file .env.local`
 *     If the function is unreachable at `http://127.0.0.1:54321/functions/v1/sync-matches`
 *     the test surfaces an actionable error rather than a cryptic fetch fail.
 *   - `SYNC_FIXTURE_MODE=1` in the Edge Function env so the function doesn't
 *     contact the real provider (15-match fixture under
 *     `supabase/functions/sync-matches/__fixtures__/v4-sample.json`).
 *
 * Auth model: no participant auth required — the function is service-role
 * only, so we POST directly with a service-role bearer from the Node test
 * context. We do NOT need Playwright's `page` fixture here.
 */

import { expect, test } from '@playwright/test';

import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Local Edge Function URL. We intentionally hardcode 127.0.0.1 rather than
 * deriving from `process.env.NEXT_PUBLIC_SUPABASE_URL` because Edge Functions
 * are served on the same Supabase Studio host in `supabase start` and the
 * env var may legitimately differ (e.g. `localhost` vs `127.0.0.1`) without
 * the functions runtime tracking that distinction. If this needs to run
 * against a deployed env, surface SUPABASE_FUNCTIONS_URL as an override.
 */
const SYNC_FUNCTION_URL =
  process.env.SUPABASE_FUNCTIONS_URL ??
  'http://127.0.0.1:54321/functions/v1/sync-matches';

/**
 * The fixture file (`supabase/functions/sync-matches/__fixtures__/v4-sample.json`)
 * contains exactly 15 matches. If the fixture file changes, update this
 * constant — the assertion about `records_processed=15` and the post-run
 * `matches` row count both depend on it.
 */
const EXPECTED_FIXTURE_MATCH_COUNT = 15;

// ---------------------------------------------------------------------------
// Response shape (mirrors the contract from edge-sync-matches.md)
// ---------------------------------------------------------------------------

type SyncResponse =
  | {
      outcome: 'success';
      integration_run_id: number;
      records_processed: number;
      records_unchanged: number;
      duration_ms: number;
    }
  | {
      outcome: 'skipped';
      integration_run_id: number;
      reason: string;
      in_flight_run_started_at: string | null;
    }
  | {
      outcome: 'error';
      integration_run_id: number | null;
      error_category: string;
      error_message: string;
    };

// ---------------------------------------------------------------------------
// Cleanup helper — kept inline on purpose
// ---------------------------------------------------------------------------

/**
 * Clear `integration_runs` and `matches` between tests. We do NOT add this
 * to `e2e/fixtures/db.ts` because every other test in the suite stays away
 * from these tables — folding it into `resetSupabaseState()` would force an
 * unrelated cost on every auth / welcome-modal / a11y spec.
 *
 * PostgREST refuses unbounded DELETEs; `.delete().neq('id', -1)` is the
 * documented row-less escape hatch (same pattern as the existing
 * `audit_log` reset in db.ts). `integration_runs.id` is BIGSERIAL and
 * `matches.id` is UUID — for matches we use `.neq('id', ZERO_UUID)`
 * instead since `-1` is not a valid UUID.
 */
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

async function resetSyncTables(): Promise<void> {
  const client = getServiceRoleClient();

  const runsDelete = await client
    .from('integration_runs')
    .delete()
    .neq('id', -1);
  if (runsDelete.error) {
    throw new Error(
      `resetSyncTables: integration_runs delete failed: ${runsDelete.error.message}`,
    );
  }

  // Delete matches first — they FK onto teams via home_team_id/away_team_id,
  // but we are NOT deleting teams here (seeded by migration 0017). Matches
  // can be deleted without violating any FK constraint pointing AT them
  // because predictions / score_events do not exist yet in this feature.
  const matchesDelete = await client
    .from('matches')
    .delete()
    .neq('id', ZERO_UUID);
  if (matchesDelete.error) {
    throw new Error(
      `resetSyncTables: matches delete failed: ${matchesDelete.error.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP helper — POST manual-resync with service-role bearer
// ---------------------------------------------------------------------------

/**
 * Fire a single manual-resync POST. Returns the parsed JSON body or throws
 * an actionable error if the Edge Function is unreachable (most common
 * failure mode for first-time setup).
 */
async function postManualResync(serviceRoleKey: string): Promise<SyncResponse> {
  let response: Response;
  try {
    response = await fetch(SYNC_FUNCTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'manual-resync' }),
    });
  } catch (err) {
    throw new Error(
      `Failed to reach sync-matches Edge Function at ${SYNC_FUNCTION_URL}: ${(err as Error).message}. ` +
        'Start it locally with: ' +
        '`npx supabase functions serve sync-matches --env-file .env.local`',
    );
  }

  // Defensive: surface non-2xx with the body so the test failure message
  // points straight at the function's error, not a generic "expected
  // success/skipped but got something else".
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `sync-matches returned HTTP ${response.status}: ${text}. ` +
        'Check the Edge Function logs (`supabase functions logs sync-matches`).',
    );
  }

  return (await response.json()) as SyncResponse;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('US-MC / TC-M14 — concurrent sync skipped via advisory lock', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    await resetSyncTables();
  });

  // Don't pollute subsequent specs (e.g. matches-browse TC-M2 counts cards
  // for a specific stage and expects the catalog to be otherwise empty).
  test.afterAll(async () => {
    await resetSyncTables();
  });

  test('TC-M14: two simultaneous manual-resyncs → one success, one skipped', async () => {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      throw new Error(
        'SUPABASE_SERVICE_ROLE_KEY env var is required for this test ' +
          '(see .env.example; copy from `npx supabase status` output).',
      );
    }

    // ----- Act ---------------------------------------------------------
    // Promise.all schedules both fetches on the same microtask tick so
    // they race into `acquire_match_sync_lock()`. Do NOT insert any
    // `await` between the two calls — that would serialise them and the
    // second would always see a released lock, defeating the test.
    const [responseA, responseB] = await Promise.all([
      postManualResync(serviceRoleKey),
      postManualResync(serviceRoleKey),
    ]);

    // ----- Assert: outcome distribution --------------------------------
    // The Promise.all return order is positional but the Edge Function
    // race outcome is NOT — either request can win the lock. Sort by
    // outcome string so we get a stable [skipped, success] pair regardless
    // of who got there first, then assert each.
    const responses: readonly SyncResponse[] = [responseA, responseB];
    const successes = responses.filter((r) => r.outcome === 'success');
    const skipped = responses.filter((r) => r.outcome === 'skipped');
    const errors = responses.filter((r) => r.outcome === 'error');

    expect(
      errors,
      `Neither response should be an error. Got: ${JSON.stringify(errors, null, 2)}`,
    ).toHaveLength(0);
    expect(
      successes,
      `Exactly one response should have outcome='success'. Got: ${JSON.stringify(responses, null, 2)}`,
    ).toHaveLength(1);
    expect(
      skipped,
      `Exactly one response should have outcome='skipped'. Got: ${JSON.stringify(responses, null, 2)}`,
    ).toHaveLength(1);

    const successResponse = successes[0]!;
    const skippedResponse = skipped[0]!;

    // Narrow with type-guards so TS knows which branch we're on.
    if (successResponse.outcome !== 'success') {
      throw new Error('unreachable: successResponse.outcome must be success');
    }
    if (skippedResponse.outcome !== 'skipped') {
      throw new Error('unreachable: skippedResponse.outcome must be skipped');
    }

    // ----- Assert: success-response shape ------------------------------
    expect(successResponse.records_processed).toBe(EXPECTED_FIXTURE_MATCH_COUNT);
    expect(successResponse.integration_run_id).toBeGreaterThan(0);
    expect(typeof successResponse.duration_ms).toBe('number');

    // ----- Assert: skipped-response shape ------------------------------
    expect(skippedResponse.reason).toBe('another sync is already in flight');
    expect(skippedResponse.integration_run_id).toBeGreaterThan(0);
    // Contract guarantees `in_flight_run_started_at` is an ISO timestamp
    // string (the started_at of the winning run). Operators triage which
    // run held the lock by reading this field.
    expect(
      skippedResponse.in_flight_run_started_at,
      'in_flight_run_started_at must be present on a skipped response',
    ).not.toBeNull();
    const inFlightTs = skippedResponse.in_flight_run_started_at!;
    expect(typeof inFlightTs).toBe('string');
    expect(
      Number.isNaN(new Date(inFlightTs).getTime()),
      `in_flight_run_started_at must parse as a Date; got: ${inFlightTs}`,
    ).toBe(false);

    // ----- Assert: integration_runs telemetry --------------------------
    // ORDER BY id ASC so the success row (inserted first by the winning
    // invocation in step 2 of runSync) lands at index 0 and the skipped
    // row (inserted by the losing invocation in step 1a) at index 1.
    const client = getServiceRoleClient();
    const { data: runs, error: runsError } = await client
      .from('integration_runs')
      .select(
        'id, provider, action, status, records_processed, records_unchanged, error_message, started_at, finished_at',
      )
      .eq('action', 'manual-resync')
      .order('id', { ascending: true });
    expect(runsError, `integration_runs query: ${runsError?.message ?? ''}`).toBeNull();
    expect(runs, 'integration_runs query returned no data').not.toBeNull();
    expect(runs!).toHaveLength(2);

    const successRow = runs!.find((r) => r.status === 'success');
    const skippedRow = runs!.find((r) => r.status === 'skipped');

    expect(
      successRow,
      `Expected one integration_runs row with status='success'. Rows: ${JSON.stringify(runs, null, 2)}`,
    ).toBeDefined();
    expect(
      skippedRow,
      `Expected one integration_runs row with status='skipped'. Rows: ${JSON.stringify(runs, null, 2)}`,
    ).toBeDefined();

    expect(successRow!.provider).toBe('football-data.org');
    expect(successRow!.records_processed).toBe(EXPECTED_FIXTURE_MATCH_COUNT);
    expect(successRow!.finished_at).not.toBeNull();

    expect(skippedRow!.provider).toBe('football-data.org');
    expect(skippedRow!.records_processed).toBe(0);
    expect(skippedRow!.records_unchanged).toBe(0);
    expect(skippedRow!.finished_at).not.toBeNull();

    // ----- Assert: skipped row's error_message points operators at the
    //              in-flight run via its started_at timestamp ------------
    // The Edge Function writes `blocked by run started at <ISO ts>` where
    // <ISO ts> is the in-flight run's started_at. That's how an operator
    // ties the skipped row to the success row in a post-incident query.
    expect(
      skippedRow!.error_message,
      'skipped row must record the in-flight run for triage',
    ).not.toBeNull();
    expect(skippedRow!.error_message).toContain(inFlightTs);

    // ----- Assert: only the winning run wrote data ---------------------
    // If the lock failed (both invocations ran) we'd see double-UPSERTs
    // or duplicate-key violations. The count == fixture size confirms
    // exactly one invocation reached step 7 (UPSERT matches).
    const { count: matchesCount, error: matchesCountError } = await client
      .from('matches')
      .select('*', { count: 'exact', head: true });
    expect(
      matchesCountError,
      `matches count: ${matchesCountError?.message ?? ''}`,
    ).toBeNull();
    expect(matchesCount).toBe(EXPECTED_FIXTURE_MATCH_COUNT);
  });
});
