/**
 * Playwright E2E test — TC-M11 (US-MC: admin re-sync) for feature 002
 * (match-catalog-read), task T055.
 *
 * Spec source: `specs/002-match-catalog-read/spec.md` — User Story MC
 * acceptance, TC-M11 (verbatim from tasks.md T055):
 *
 *   > admin signs in, invokes the trigger RPC, waits for integration_runs
 *   > row with `action='manual-resync'`, asserts records_processed > 0
 *
 * Wires together:
 *   - `supabase/migrations/0015_match_rpcs.sql` — defines `trigger_match_sync()`.
 *     On Supabase Pro+ this RPC POSTs to the Edge Function via `pg_net`. On
 *     the local Supabase stack `pg_net` is NOT installed, so the RPC raises
 *     `feature_not_supported`. The contract documents the fallback path —
 *     invoke the Edge Function URL directly from a Next.js Route Handler
 *     using a service-role bearer (`contracts/rpc-trigger-match-sync.md`
 *     §"pg_net AVAILABILITY"). This test exercises that fallback path from
 *     the Node test context to keep the service-role key out of the browser
 *     bundle.
 *   - `supabase/functions/sync-matches/index.ts` — the Edge Function under
 *     test. Acquires an advisory lock, writes an in-flight row to
 *     `integration_runs`, fetches + UPSERTs matches (under SYNC_FIXTURE_MODE=1
 *     the provider call is replaced with a fixture envelope containing 15
 *     matches), then finalises the integration_runs row with status='success'.
 *     Response is `outcome:'success'` with the `integration_run_id`.
 *   - `supabase/migrations/0017_seed_teams.sql` — pre-seeded teams keyed by
 *     `provider_team_id`. The sync UPSERTs onto this seed; we do NOT clear
 *     `teams` per-test (matches the matches-browse.spec.ts pattern).
 *
 * Why bypass the RPC entirely on local:
 *   The migration's `trigger_match_sync()` body wraps the pg_net call in a
 *   `BEGIN/EXCEPTION WHEN undefined_function` block that re-raises with
 *   ERRCODE `feature_not_supported` and a HINT pointing at the Route Handler
 *   fallback. Driving that branch from a test would only assert "the RPC
 *   errors as documented", which is covered by the pgTAP suite. For TC-M11
 *   the value is in driving the SAME outcome path the production
 *   admin-console fallback drives — a direct service-role POST to the Edge
 *   Function — so we exercise that path end-to-end instead.
 *
 * Why fetch from Node, not page.evaluate:
 *   The service-role key MUST NEVER reach a browser context (constitution
 *   §VI.1 — "NEVER ship service_role to client bundles"). `page.evaluate`
 *   runs inside the browser, so any `process.env.SUPABASE_SERVICE_ROLE_KEY`
 *   reference inside the evaluate callback would either fail (no `process`
 *   in browser) or, worse, leak via a closure capture. The test issues the
 *   POST from Node — same context that owns the service-role client in
 *   db.ts — keeping the secret on the server side.
 *
 * Per-test cleanup:
 *   `resetSupabaseState()` clears participants + audit_log only — it does
 *   NOT touch matches / integration_runs / teams (see db.ts:70). For TC-M11
 *   we additionally clear `integration_runs` and `matches` per-test so the
 *   "records_processed > 0" assertion is measuring this run's UPSERT count,
 *   not a cumulative figure from a previous run. `teams` is intentionally
 *   preserved (the migration 0017 seed is what the sync UPSERTs against).
 *   This cleanup helper is inline rather than in db.ts for the same reason
 *   matches-browse keeps its seed inline: only this spec touches these tables,
 *   so generalising the reset would force every test to pay the cost.
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import { getParticipantByOid, getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

/**
 * Per-test cleanup of the tables the sync writes to. Kept local to this
 * spec on purpose (see file-level JSDoc).
 *
 * `integration_runs.id` is BIGSERIAL — using `.neq('id', -1)` is the
 * documented "match everything" escape hatch for PostgREST DELETE (see
 * db.ts:21 for the same pattern on `audit_log`). For `matches` the PK is
 * a UUID, so we use the all-zeros sentinel.
 */
async function clearSyncTables(): Promise<void> {
  const client = getServiceRoleClient();

  // Delete integration_runs FIRST. It has no FK to matches, but clearing it
  // before matches keeps the test trace clean (no stale "in-flight" rows
  // referencing a now-empty matches table).
  const integrationDelete = await client
    .from('integration_runs')
    .delete()
    .neq('id', -1);
  if (integrationDelete.error) {
    throw new Error(`clearSyncTables: integration_runs reset failed: ${integrationDelete.error.message}`);
  }

  const matchesDelete = await client
    .from('matches')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
  if (matchesDelete.error) {
    throw new Error(`clearSyncTables: matches reset failed: ${matchesDelete.error.message}`);
  }
}

test.describe('US-MC / TC-M11 — admin re-sync', () => {
  test.beforeEach(async () => {
    // Order matters: resetSupabaseState() first so the participants/audit_log
    // reset doesn't undo any per-test sync state we've set up. Then
    // clearSyncTables() to give the sync a clean integration_runs + matches
    // canvas to write into.
    await resetSupabaseState();
    await clearSyncTables();
  });

  // Other specs (matches-browse TC-M2 in particular) assert exact card counts
  // and assume the catalog is empty apart from their own seed rows. The 15
  // fixture matches this sync writes would leak in and inflate those counts;
  // wipe at file boundary so the leakage stops here.
  test.afterAll(async () => {
    await clearSyncTables();
  });

  test('TC-M11: admin invokes the sync and a successful integration_runs row is recorded with records_processed > 0', async ({
    page,
  }) => {
    // Step 1: sign in as a brand-new admin. Mirrors auth-admin-role.spec.ts —
    // passing `role: 'admin'` instructs the fixture to append this oid to
    // `tournament_config.admin_oids` BEFORE issuing the session so the
    // provisioning RPC promotes the row to `admin` on first insert (FR-A5).
    const { oid } = await signInAs(page, {
      tenant: 'eligible',
      role: 'admin',
    });

    // Step 2: invoke `provision_participant_from_jwt()` from the authenticated
    // browser context. Production calls this from `/auth/callback`; JWT
    // injection bypasses that handler, so we trigger it explicitly to mirror
    // the production code path (same pattern as auth-admin-role.spec.ts:60).
    const provisionResult = await page.evaluate(
      async ({ supabaseUrl, supabaseAnonKey }) => {
        const { createBrowserClient } = await import(
          // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
          'https://esm.sh/@supabase/ssr@0.10.3'
        );
        const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
        // Force hydration of the persisted session from cookies before the
        // RPC — see auth-admin-role.spec.ts:67 for the same race-avoidance
        // pattern.
        await client.auth.getSession();
        const { data, error } = await client.rpc('provision_participant_from_jwt');
        if (error !== null && error !== undefined) {
          return { ok: false as const, error: error.message };
        }
        return { ok: true as const, data };
      },
      {
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
        supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
      },
    );
    expect(provisionResult.ok, 'provision_participant_from_jwt RPC must succeed').toBe(true);

    // Step 3: sanity check the participant was provisioned with `role='admin'`.
    // This guards against silent regressions in the admin allow-list seeding
    // path — if this assertion ever fails the rest of the test's "admin
    // invokes sync" narrative is moot. Mirrors auth-admin-role.spec.ts:89.
    const participant = await getParticipantByOid(oid);
    expect(participant, `participant row for oid=${oid} must exist`).not.toBeNull();
    const adminRow = participant as NonNullable<typeof participant>;
    expect(adminRow.role).toBe('admin');
    expect(adminRow.status).toBe('active');

    // Step 4: POST directly to the local Edge Function URL with the
    // service-role bearer. This is the Route Handler fallback path
    // documented in `contracts/rpc-trigger-match-sync.md` §"pg_net
    // AVAILABILITY". We do it from Node — NOT from page.evaluate — so the
    // service-role key never enters a browser context.
    //
    // Local Supabase Edge Functions are served on the same host as the API
    // gateway at `/functions/v1/<name>`. The dev environment is expected to
    // have `npx supabase functions serve sync-matches` running with
    // SYNC_FIXTURE_MODE=1 set in .env.local (which loads a 15-match fixture
    // instead of calling football-data.org).
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(
      serviceRoleKey,
      'SUPABASE_SERVICE_ROLE_KEY must be set in .env.local (see db.ts:37 for the same requirement)',
    ).toBeTruthy();

    const supabaseUrl =
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
    const syncFunctionUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/sync-matches`;

    let response: Response;
    try {
      response = await fetch(syncFunctionUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'manual-resync' }),
      });
    } catch (err) {
      // The Edge Function is synchronous from the caller's POV — the response
      // only returns after sync completes — so a fetch-level failure here is
      // almost certainly "function not running". Fail with an actionable
      // message so the developer doesn't have to chase a generic ECONNREFUSED.
      throw new Error(
        [
          `Edge Function POST to ${syncFunctionUrl} failed: ${(err as Error).message}`,
          'Hints:',
          '  - Is the sync-matches Edge Function running? Start with:',
          '      npx supabase functions serve sync-matches --no-verify-jwt',
          '  - Is SYNC_FIXTURE_MODE=1 set in .env.local? (otherwise the function calls football-data.org)',
          '  - Is SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL pointing at the local stack?',
        ].join('\n'),
      );
    }

    // Edge Function contract: all DB / provider errors are returned as a 200
    // with `outcome:'error'`. A non-200 here means a hard auth / body /
    // method error from the function — surface the body for the operator.
    const responseText = await response.text();
    expect(
      response.status,
      `sync-matches must respond 200; got ${response.status} with body: ${responseText}`,
    ).toBe(200);

    // The Edge Function response is JSON per index.ts:517 (jsonResponse).
    type SyncResponseShape = {
      outcome: 'success' | 'skipped' | 'error';
      integration_run_id: number | null;
      records_processed?: number;
      records_unchanged?: number;
      duration_ms?: number;
      error_category?: string;
      error_message?: string;
      reason?: string;
    };
    const body = JSON.parse(responseText) as SyncResponseShape;

    // We expect a clean success — the fixture mode skips the network call
    // entirely so there's no provider-side failure mode to tolerate here.
    expect(
      body.outcome,
      `sync-matches outcome must be 'success'; got '${body.outcome}' with body: ${responseText}`,
    ).toBe('success');
    expect(body.integration_run_id, 'success response must carry an integration_run_id').not.toBeNull();
    const integrationRunId = body.integration_run_id as number;

    // Step 5: service-role read of the specific integration_runs row we just
    // produced. Querying by id rather than "latest" guards against a parallel
    // worker mutation contaminating the result (Playwright tests can run in
    // parallel even within a file under `fullyParallel`).
    const client = getServiceRoleClient();
    const { data: runRow, error: runErr } = await client
      .from('integration_runs')
      .select('id, provider, action, status, records_processed, records_unchanged, error_message')
      .eq('id', integrationRunId)
      .single();

    expect(runErr, `integration_runs read failed: ${runErr?.message ?? ''}`).toBeNull();
    expect(runRow, `integration_runs row id=${integrationRunId} must exist`).not.toBeNull();
    const run = runRow as NonNullable<typeof runRow>;

    // Assertions per the TC-M11 spec: action + status + records_processed.
    expect(run.action).toBe('manual-resync');
    expect(run.status).toBe('success');
    expect(run.error_message).toBeNull();
    // The TC-M11 acceptance text reads "records_processed > 0". With
    // SYNC_FIXTURE_MODE=1 the fixture envelope contains 15 matches, so this
    // assertion is generous on purpose — any future change to the fixture
    // size (more or fewer matches) doesn't break the test, only a
    // zero-matches regression does.
    expect(
      run.records_processed,
      `records_processed must be > 0; got ${run.records_processed}`,
    ).toBeGreaterThan(0);

    // Step 6: sanity-check the matches table actually populated. records_processed
    // counts the upsert payload size, but the only way to know rows actually
    // landed in `matches` is to read them back. A bug that double-counted
    // payload entries without writing them would pass the prior assertion
    // alone; this final read closes that gap.
    const { count: matchCount, error: countErr } = await client
      .from('matches')
      .select('id', { count: 'exact', head: true });
    expect(countErr, `matches count read failed: ${countErr?.message ?? ''}`).toBeNull();
    expect(matchCount, 'matches table must be populated after a successful sync').toBeGreaterThan(0);
  });
});
