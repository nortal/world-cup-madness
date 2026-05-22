/**
 * Playwright E2E test — TC-M13 (US-MC: idempotent match sync) for feature 002
 * (match-catalog-read), task T056.
 *
 * Spec source: `specs/002-match-catalog-read/spec.md` — User Story MC, TC-M13:
 *
 *   > run bootstrap twice in fixture mode, assert second run reports
 *   > `records_processed == records_unchanged`, assert match row count
 *   > unchanged, assert no duplicate provider_id rows
 *
 * Contract: `specs/002-match-catalog-read/contracts/edge-sync-matches.md`
 * (idempotency contract — after N consecutive invocations with unchanged
 * provider data, the `matches` row count is constant, no field values
 * change, and each `integration_runs` row reports
 * `records_processed === records_unchanged`).
 *
 * Implementation under test:
 *   - `supabase/functions/sync-matches/index.ts` — the Edge Function whose
 *     UPSERT + field-level diff logic must be idempotent on repeat runs.
 *   - `supabase/functions/sync-matches/__fixtures__/v4-sample.json` — the
 *     15-match fixture loaded when `SYNC_FIXTURE_MODE=1` is set in the
 *     served-function env. First run: `records_processed=15,
 *     records_unchanged=0`. Second run: `records_processed=15,
 *     records_unchanged=15` (every row matched the stored values).
 *
 * Why no auth helpers:
 *   The Edge Function is service-role-only (see contract — `Authorization:
 *   Bearer {SUPABASE_SERVICE_ROLE_KEY}`). There is no participant session
 *   in play here, so this spec does NOT call `signInAs`. The POSTs go
 *   directly from the Node test context with the service-role bearer.
 *
 * Why a local cleanup helper (not added to `e2e/fixtures/db.ts`):
 *   `resetSupabaseState()` deliberately does NOT touch `matches`,
 *   `integration_runs`, or `teams` (those are exercised by only a few
 *   specs; truncating them on every test would force unrelated specs to
 *   pay the cost). This spec owns the cleanup of its own data surface,
 *   matching the pattern in `matches-browse.spec.ts`.
 *
 * Prerequisite — the Edge Function MUST be running locally with fixture
 * mode enabled before this spec executes:
 *   SYNC_FIXTURE_MODE=1 npx supabase functions serve sync-matches \
 *     --env-file .env.local
 * The fetch in this spec catches ECONNREFUSED and rethrows with that hint.
 */

import { expect, test } from '@playwright/test';

import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

/**
 * Local URL for the locally-served Edge Function. The Supabase CLI exposes
 * functions at this path regardless of which function name was passed to
 * `supabase functions serve`. The 54321 port is the Supabase default and
 * is what `e2e/fixtures/db.ts` also assumes for the Postgres / REST stack.
 */
const SYNC_MATCHES_URL = 'http://127.0.0.1:54321/functions/v1/sync-matches';

/**
 * The fixture at `supabase/functions/sync-matches/__fixtures__/v4-sample.json`
 * contains 15 matches. Pinned here as a constant so a future fixture-size
 * change forces a deliberate update to this spec rather than a silent skew.
 */
const FIXTURE_MATCH_COUNT = 15;

/**
 * Expected response shape from the Edge Function on a successful run.
 * Mirrors `contracts/edge-sync-matches.md` "Successful run" example —
 * narrow enough for type-safe assertions, lenient on optional fields.
 */
interface SyncSuccessResponse {
  outcome: 'success' | 'skipped' | 'error';
  integration_run_id: number;
  records_processed?: number;
  records_unchanged?: number;
  duration_ms?: number;
  error_category?: string;
  error_message?: string;
  reason?: string;
}

/**
 * POST to the locally-served sync-matches Edge Function with the
 * service-role bearer. Wraps fetch so an ECONNREFUSED surfaces an
 * actionable hint to the developer rather than an opaque network error.
 */
async function invokeBootstrapSync(): Promise<SyncSuccessResponse> {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is required for the sync-matches Edge Function. ' +
        'Set it in .env.local — `npx supabase status -o env` prints the local value.',
    );
  }

  let response: Response;
  try {
    response = await fetch(SYNC_MATCHES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'bootstrap' }),
    });
  } catch (cause) {
    // Most common cause is ECONNREFUSED — the function isn't being served.
    // Rethrow with the exact command needed to fix it.
    throw new Error(
      'Failed to reach sync-matches Edge Function at ' +
        `${SYNC_MATCHES_URL}. Start it with:\n` +
        '  SYNC_FIXTURE_MODE=1 npx supabase functions serve sync-matches ' +
        '--env-file .env.local\n' +
        '(SYNC_FIXTURE_MODE=1 must be in .env.local so the function reads ' +
        'the bundled fixture instead of hitting football-data.org.)',
      { cause },
    );
  }

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `sync-matches returned HTTP ${response.status}: ${bodyText}. ` +
        'Per the contract a non-2xx means malformed request or bad auth — ' +
        'check that SUPABASE_SERVICE_ROLE_KEY matches the locally-served stack.',
    );
  }

  return (await response.json()) as SyncSuccessResponse;
}

/**
 * Clear the per-test data surface this spec writes to: `matches` and
 * `integration_runs`. Deliberately scoped to this file because
 * `resetSupabaseState()` does NOT touch these tables (see header comment).
 *
 * The `.neq('id', -1)` pattern is the same PostgREST "match everything"
 * escape hatch used by `resetSupabaseState` — PostgREST refuses an
 * unbounded DELETE, and `-1` never appears in either BIGSERIAL `id` column.
 */
async function clearSyncTables(): Promise<void> {
  const client = getServiceRoleClient();

  // Order matters only loosely: `integration_runs` has no FK to `matches`
  // (it's pure telemetry), so either order is safe. We delete telemetry
  // first so that a partial cleanup leaves the data table in the
  // already-empty state operators would expect to see.
  const runsDelete = await client.from('integration_runs').delete().neq('id', -1);
  if (runsDelete.error) {
    throw new Error(`clearSyncTables: integration_runs: ${runsDelete.error.message}`);
  }

  // `matches.id` is a UUID (see migration 0012); `.neq('id', '...0')` is
  // the UUID equivalent of the BIGSERIAL "-1" trick — the zero UUID never
  // appears in practice. Same sentinel as `e2e/fixtures/db.ts`.
  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
  const matchesDelete = await client.from('matches').delete().neq('id', ZERO_UUID);
  if (matchesDelete.error) {
    throw new Error(`clearSyncTables: matches: ${matchesDelete.error.message}`);
  }
}

test.describe('US-MC / TC-M13 — idempotent match sync', () => {
  test.beforeEach(async () => {
    // Reset participants + audit_log + tournament_config.admin_oids.
    // Does NOT touch matches / integration_runs / teams — those are this
    // spec's own data surface, cleared below.
    await resetSupabaseState();
    await clearSyncTables();
  });

  // Sync specs leave the fixture's 15 matches in the catalog. Other specs
  // (e.g. matches-browse TC-M2) seed their own match rows and expect the
  // catalog to be otherwise empty so their filter assertions match. Wipe
  // here so the file boundary is also the data boundary.
  test.afterAll(async () => {
    await clearSyncTables();
  });

  test('bootstrap is idempotent: second run reports records_processed === records_unchanged and writes no new rows', async () => {
    const client = getServiceRoleClient();

    // ── Run #1: cold start. Fixture has 15 matches and the catalog is
    // empty, so every row is a fresh INSERT — none counted as unchanged.
    const firstRun = await invokeBootstrapSync();
    expect(firstRun.outcome).toBe('success');
    expect(firstRun.records_processed).toBe(FIXTURE_MATCH_COUNT);
    expect(firstRun.records_unchanged).toBe(0);

    // Verify the catalog landed: exactly 15 rows, capture their primary
    // keys + provider ids so run #2 can prove the PKs are preserved
    // (i.e. UPSERT updated in place rather than DELETE+INSERT).
    const afterFirst = await client
      .from('matches')
      .select('id, provider_id')
      .order('provider_id', { ascending: true });
    if (afterFirst.error) {
      throw new Error(`matches read after run #1: ${afterFirst.error.message}`);
    }
    expect(afterFirst.data?.length).toBe(FIXTURE_MATCH_COUNT);
    const firstRunIdsByProvider = new Map(
      (afterFirst.data ?? []).map((row) => [row.provider_id, row.id]),
    );

    // ── Run #2: warm path. Same fixture, same upstream data — every row
    // should be an unchanged match per the field-level diff in step 7 of
    // the contract. records_processed stays at the full provider count
    // (15) and records_unchanged catches up to match it.
    const secondRun = await invokeBootstrapSync();
    expect(secondRun.outcome).toBe('success');
    expect(secondRun.records_processed).toBe(FIXTURE_MATCH_COUNT);
    expect(secondRun.records_unchanged).toBe(FIXTURE_MATCH_COUNT);
    // The "TC-M13 verbatim" assertion — second run must report
    // records_processed == records_unchanged.
    expect(secondRun.records_processed).toBe(secondRun.records_unchanged);

    // ── Catalog must not have grown: still exactly 15 rows.
    const afterSecond = await client
      .from('matches')
      .select('id, provider_id')
      .order('provider_id', { ascending: true });
    if (afterSecond.error) {
      throw new Error(`matches read after run #2: ${afterSecond.error.message}`);
    }
    expect(afterSecond.data?.length).toBe(FIXTURE_MATCH_COUNT);

    // ── Same primary keys: the UPSERT updated existing rows; it did NOT
    // delete+reinsert (which would have minted new UUIDs). This is the
    // strongest signal that ON CONFLICT (provider_id) DO UPDATE is wired
    // correctly — without it, idempotency holds at the row-count level
    // but FKs from `predictions` (Phase 1 onwards) would silently break.
    const secondRunIdsByProvider = new Map(
      (afterSecond.data ?? []).map((row) => [row.provider_id, row.id]),
    );
    expect(secondRunIdsByProvider.size).toBe(firstRunIdsByProvider.size);
    for (const [providerId, firstId] of firstRunIdsByProvider) {
      expect(secondRunIdsByProvider.get(providerId)).toBe(firstId);
    }

    // ── No duplicate provider_id rows: the UPSERT key is provider_id, so
    // a bug in conflict resolution would manifest as two rows sharing the
    // same provider_id. PostgREST has no native GROUP BY HAVING, but the
    // assertion reduces to "every provider_id occurs exactly once" — we
    // check that directly from the rows we already fetched.
    const providerIdCounts = new Map<number, number>();
    for (const row of afterSecond.data ?? []) {
      providerIdCounts.set(row.provider_id, (providerIdCounts.get(row.provider_id) ?? 0) + 1);
    }
    for (const [providerId, count] of providerIdCounts) {
      expect(count, `provider_id ${providerId} should appear exactly once`).toBe(1);
    }

    // ── Telemetry sanity: exactly two `integration_runs` rows since the
    // cleanup, both action='bootstrap', both status='success'. The
    // contract guarantees one row per invocation (step 3 INSERTs, step 8
    // UPDATEs the same row to status='success').
    const runs = await client
      .from('integration_runs')
      .select('action, status')
      .order('started_at', { ascending: true });
    if (runs.error) {
      throw new Error(`integration_runs read: ${runs.error.message}`);
    }
    expect(runs.data?.length).toBe(2);
    expect(runs.data?.map((r) => ({ action: r.action, status: r.status }))).toEqual([
      { action: 'bootstrap', status: 'success' },
      { action: 'bootstrap', status: 'success' },
    ]);
  });
});
