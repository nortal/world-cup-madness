/**
 * Playwright E2E test — TC-5 (ineligible user rejected with audit trail) for US2.
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` (TC-5, line 78)
 *   > Ineligible user rejected — Given a Microsoft account NOT in the Nortal
 *   > Entra tenant, when the user completes OAuth, then no participant row is
 *   > created, an audit entry with `action='auth.rejected'` is written
 *   > containing `oid + email + attempted_tid`, and the user is redirected to
 *   > `/access-denied`.
 *
 * Requirement: FR-002. See also FC-2 (no participant row for ineligible users,
 * ever) and Q8 (audit row shape: `actor_oid`, `actor_email`, `attempted_tid`,
 * timestamp; `participant_id` nullable for `auth.rejected`).
 *
 * Scope (per T047): assert the DATA outcome of an ineligible-tenant sign-in:
 *   1. The provisioning RPC returns `{outcome: 'rejected', reason: 'tenant.mismatch'}`.
 *   2. No `participants` row exists for the rejected `oid`.
 *   3. Exactly one `audit_log` row with `action='auth.rejected'` is written,
 *      carrying the attempted oid, email, and tid plus `reason='tenant.mismatch'`.
 *
 * NOT in scope: full visual verification of `/access-denied` (TC-11 / T072
 * covers reachability and link affordances). A single English-baseline heading
 * assertion is included as a smoke check that the route renders, but the
 * authoritative acceptance criteria for TC-5 are on the DB side because:
 *   - the JWT-injection fixture bypasses the real `/auth/callback` route handler
 *     (no `code` query param is exchanged), so the redirect step that
 *     production performs is not exercised by this fixture path; and
 *   - the redirect logic in `app/auth/callback/route.ts` is independently
 *     verified by integration tests against the callback handler.
 *
 * Test strategy:
 *   1. Reset DB state via `resetSupabaseState()` so no prior `audit_log` rows
 *      or `participants` exist that could mask or duplicate this run's data.
 *   2. Navigate to `/` first so `signInAs`'s page-side localStorage / cookie
 *      writes land on the app origin (same pattern as TC-1).
 *   3. Drive the JWT-injection path with `signInAs({ tenant: 'ineligible' })`.
 *      This sets `app_metadata.tid = INELIGIBLE_TENANT_ID` and uses an
 *      `example.com` email, so the provisioning RPC takes the
 *      tenant-mismatch branch in `supabase/migrations/0006_provision_function.sql`.
 *   4. Invoke `provision_participant_from_jwt()` from the authenticated browser
 *      context (same `createBrowserClient` + `getSession` + `rpc` pattern as
 *      TC-1). The RPC itself calls `record_auth_failure(...)` internally on the
 *      tenant-mismatch branch, so the audit row is written by the same
 *      transaction the test invokes — no separate fixture write needed.
 *   5. Assert the RPC's returned JSON outcome.
 *   6. Service-role read: confirm no participant row exists for the `oid`.
 *   7. Service-role read: confirm exactly one matching `audit_log` row, with
 *      `actor_oid`, `actor_email`, `attempted_tid`, and `reason` populated
 *      correctly.
 *   8. Smoke check: `page.goto('/access-denied')` renders the English heading.
 */

import { expect, test } from '@playwright/test';

import { INELIGIBLE_TENANT_ID, signInAs } from '../fixtures/auth';
import {
  getAuditLog,
  getParticipantByOid,
  resetSupabaseState,
} from '../fixtures/db';

/**
 * Shape of the `provision_participant_from_jwt()` RPC return value on the
 * rejected-tenant branch (see migration 0006). The RPC always returns a
 * `jsonb` object, but Supabase types it as `Json` so we narrow defensively
 * with a type guard instead of casting.
 */
type RejectedOutcome = {
  outcome: 'rejected';
  reason: 'tenant.mismatch';
};

function isRejectedOutcome(value: unknown): value is RejectedOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    'outcome' in value &&
    'reason' in value &&
    (value as { outcome: unknown }).outcome === 'rejected' &&
    (value as { reason: unknown }).reason === 'tenant.mismatch'
  );
}

test.beforeEach(async () => {
  await resetSupabaseState();
});

test('TC-5: ineligible-tenant sign-in is rejected with audit trail and no participant row', async ({
  page,
}) => {
  // Step 1: land on the app origin so the page-side Supabase client writes
  // cookies to the correct origin (mirrors TC-1's beforeEach pattern).
  await page.goto('/');

  // Step 2: sign in as an ineligible user. `signInAs` sets
  // `app_metadata.tid = INELIGIBLE_TENANT_ID` and uses an example.com email,
  // which makes `provision_participant_from_jwt()` take the tenant-mismatch
  // branch in migration 0006.
  const { oid, email, tid } = await signInAs(page, { tenant: 'ineligible' });
  expect(tid, 'fixture must use the ineligible tenant id').toBe(INELIGIBLE_TENANT_ID);

  // Step 3: invoke the provisioning RPC from the authenticated browser
  // context. Production code calls this from `/auth/callback`; JWT injection
  // bypasses that handler, so we trigger the RPC explicitly to exercise the
  // tenant-mismatch branch (FR-002).
  const provisionResult = await page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      // Force the client to hydrate the persisted session from cookies before
      // issuing the RPC. Without this the rpc call may race ahead
      // unauthenticated, since `createBrowserClient` returns synchronously but
      // the auth state hydrates asynchronously.
      await client.auth.getSession();
      const { data, error } = await client.rpc('provision_participant_from_jwt');
      if (error !== null && error !== undefined) {
        return { ok: false as const, error: error.message };
      }
      return { ok: true as const, data: data as unknown };
    },
    {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );

  expect(provisionResult.ok, 'provision_participant_from_jwt RPC must succeed').toBe(true);

  // Narrow the union so subsequent property accesses are type-safe.
  if (!provisionResult.ok) {
    throw new Error(`unreachable: ${provisionResult.error}`);
  }

  // Step 4: assert the RPC returned the rejected outcome with the expected
  // reason. The RPC returns `jsonb`, typed as `Json` by the generated client;
  // narrow with a runtime type guard rather than casting through `any`.
  expect(
    isRejectedOutcome(provisionResult.data),
    `RPC must return {outcome: 'rejected', reason: 'tenant.mismatch'}; got ${JSON.stringify(
      provisionResult.data,
    )}`,
  ).toBe(true);

  // Step 5: confirm no participant row was created. FC-2: "Under no
  // circumstances should an ineligible user's sign-in attempt create a
  // participant row."
  const participant = await getParticipantByOid(oid);
  expect(participant, `no participant row must exist for ineligible oid=${oid}`).toBeNull();

  // Step 6: confirm exactly one `auth.rejected` audit row was written for this
  // oid, with the attempted oid/email/tid and the tenant.mismatch reason.
  // `getAuditLog` filters server-side via `.eq('actor_oid', oid)` — note the
  // filter takes raw `oid`, not the participant id (handy ergonomics here
  // since `participant_id` is null for `auth.rejected` events).
  const auditRows = await getAuditLog({ action: 'auth.rejected', oid });
  expect(
    auditRows,
    `exactly one auth.rejected audit row must exist for oid=${oid}`,
  ).toHaveLength(1);

  const auditRow = auditRows[0];
  expect(auditRow.action).toBe('auth.rejected');
  expect(auditRow.actor_oid).toBe(oid);
  // `actor_email` is CITEXT in Postgres; the fixture's `email` is already
  // lowercase, so direct equality is sufficient. Defensive `.toLowerCase()`
  // would be redundant here but mirrors how the production callback compares.
  expect(auditRow.actor_email?.toLowerCase()).toBe(email.toLowerCase());
  expect(auditRow.attempted_tid).toBe(INELIGIBLE_TENANT_ID);
  expect(auditRow.reason).toBe('tenant.mismatch');
  // `participant_id` is nullable for `auth.rejected` per spec Q8.
  expect(auditRow.participant_id).toBeNull();

  // Step 7: smoke check the /access-denied route renders. TC-11 (T072) owns
  // the full coverage of reachability and link affordances on this page; here
  // we only assert the English-baseline heading so a future refactor that
  // accidentally renames the i18n key surfaces in this spec too.
  await page.goto('/access-denied');
  await expect(
    page.getByRole('heading', { level: 1, name: 'This pool is for Nortal collaborators' }),
  ).toBeVisible();
});
