/**
 * Playwright E2E test — TC-2 (returning eligible user) for US1.
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` (TC-2, line 75)
 *   > Returning eligible user — Given an existing participant row for the
 *   > signing-in user, when sign-in succeeds, then no new row is created,
 *   > `last_login_at` is updated, and the user is redirected to the dashboard
 *   > without the welcome modal.
 *
 * Scope (per T043): assert single-row invariant + `last_login_at` advancement +
 * dashboard landing on a *returning* sign-in. The welcome-modal "does not
 * appear" assertion is intentionally OUT-OF-SCOPE for T043 — it is covered
 * separately by T060 (`welcome-modal-cross-device.spec.ts` / TC-12). We do,
 * however, seed `welcome_dismissed_at` on the pre-existing row so the
 * test fixture mirrors a realistic "returning user" precondition (FR-A3).
 *
 * Test strategy:
 *   1. Reset DB state so no participant row exists for the synthetic `oid`.
 *   2. Drive the JWT-injection path once with `signInAs({ tenant: 'eligible',
 *      oid })` to (a) create the underlying `auth.users` row and (b) install
 *      session cookies. The `auth.users` row is required by the
 *      `participants.auth_user_id` FK; we do NOT INSERT into `participants`
 *      via service role because that would require us to also seed an
 *      `auth.users` row by hand. Re-using the production code path
 *      (`provision_participant_from_jwt()`) to materialize the "pre-existing"
 *      row keeps the FK satisfied and exercises the same provisioning
 *      function the returning-user assertion will later target.
 *   3. Service-role UPDATE the pre-existing row: backdate `last_login_at` to a
 *      known timestamp (1 hour ago) and set `welcome_dismissed_at` so the
 *      precondition matches a returning user who has already onboarded.
 *   4. Capture the row's `id` and the backdated `last_login_at` as baselines.
 *   5. Re-invoke `provision_participant_from_jwt()` RPC with the SAME `oid`
 *      (same session cookies from step 2). Production calls this RPC from
 *      `/auth/callback` on every successful sign-in; JWT injection bypasses
 *      that handler, so the test invokes the RPC explicitly to exercise the
 *      returning-user branch.
 *   6. Navigate to `/dashboard` and assert URL.
 *   7. Service-role re-read: assert exactly ONE row for the `oid`, same `id`
 *      as baseline (no duplicate), and `last_login_at` strictly newer than
 *      the captured baseline (timestamp comparison via `Date.parse`).
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import {
  getParticipantByOid,
  getServiceRoleClient,
  resetSupabaseState,
} from '../fixtures/db';

/**
 * Re-invoke `provision_participant_from_jwt()` from the authenticated browser
 * context. Copied (rather than imported) from `auth-eligible-new-user.spec.ts`
 * so each spec stays self-contained — the helper is small and lifting it to a
 * shared module is not justified at two callsites. If a third spec needs the
 * same call, promote this to `e2e/fixtures/rpc.ts`.
 */
async function provisionParticipantFromPage(
  page: import('@playwright/test').Page,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  return page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      // Force the new client to hydrate the persisted session from
      // cookies before issuing the RPC. Without this the rpc call may race
      // ahead unauthenticated, since `createBrowserClient` returns
      // synchronously but the auth state hydrates asynchronously.
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
}

test.beforeEach(async () => {
  await resetSupabaseState();
});

test('TC-2: returning eligible user updates last_login_at without creating a duplicate row', async ({
  page,
}) => {
  // Step 1: sign in as an eligible user. This call creates the underlying
  // `auth.users` row that `participants.auth_user_id` references and installs
  // session cookies in the browser context.
  const { oid } = await signInAs(page, { tenant: 'eligible' });

  // Step 2: materialize the "pre-existing" participant row via the production
  // provisioning RPC. After this call, the row exists with a fresh
  // `last_login_at` and `welcome_dismissed_at = NULL`.
  const firstProvision = await provisionParticipantFromPage(page);
  expect(
    firstProvision.ok,
    'first provision_participant_from_jwt RPC (seed phase) must succeed',
  ).toBe(true);

  // Step 3: service-role UPDATE — backdate `last_login_at` and dismiss welcome
  // so the precondition mirrors a returning user who has already onboarded.
  // The backdated timestamp must be far enough in the past that the post-sign-in
  // `now()` UPDATE in `provision_participant_from_jwt` is strictly greater
  // even on machines with second-resolution clocks.
  const backdatedLastLogin = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const serviceClient = getServiceRoleClient();
  const { error: backdateError } = await serviceClient
    .from('participants')
    .update({
      last_login_at: backdatedLastLogin,
      welcome_dismissed_at: new Date().toISOString(),
    })
    .eq('oid', oid);
  expect(backdateError, 'backdating last_login_at via service role must succeed').toBeNull();

  // Step 4: capture baselines (id + last_login_at) BEFORE the returning
  // sign-in. We assert against these post-sign-in.
  const baselineRow = await getParticipantByOid(oid);
  expect(baselineRow, `seeded participant row for oid=${oid} must exist`).not.toBeNull();
  const baseline = baselineRow as NonNullable<typeof baselineRow>;
  const baselineId = baseline.id;
  const baselineLastLoginIso = baseline.last_login_at;
  expect(
    baselineLastLoginIso,
    'baseline last_login_at must be set after backdate UPDATE',
  ).not.toBeNull();
  // Narrow to non-null for the timestamp comparison below.
  const baselineLastLoginMs = Date.parse(baselineLastLoginIso ?? '');
  expect(
    Number.isFinite(baselineLastLoginMs),
    'baseline last_login_at must be a parseable ISO timestamp',
  ).toBe(true);

  // Step 5: re-invoke the provisioning RPC — this is the "returning sign-in"
  // under test. Same session cookies, same `oid`, same `tid`.
  const returningProvision = await provisionParticipantFromPage(page);
  expect(
    returningProvision.ok,
    'returning provision_participant_from_jwt RPC must succeed',
  ).toBe(true);

  // Step 6: navigate to the dashboard and assert URL. The greeting / welcome
  // modal absence are out-of-scope for T043 (see header comment).
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);

  // Step 7a: service-role read — confirm exactly ONE row exists for this `oid`
  // (no duplicate was created by the returning sign-in).
  const { data: allRowsForOid, error: countError } = await serviceClient
    .from('participants')
    .select('id, last_login_at')
    .eq('oid', oid);
  expect(countError, 'service-role select by oid must succeed').toBeNull();
  expect(allRowsForOid, 'service-role select must return a result array').not.toBeNull();
  const rows = allRowsForOid ?? [];
  expect(rows.length, `exactly one participant row must exist for oid=${oid}`).toBe(1);

  // Step 7b: confirm the row's `id` is unchanged (same row, not a replacement).
  const [returningRow] = rows;
  expect(returningRow.id, 'participant row id must be unchanged after returning sign-in').toBe(
    baselineId,
  );

  // Step 7c: confirm `last_login_at` strictly advanced. Use `Date.parse` to
  // compare numeric milliseconds — string comparison would be brittle across
  // ISO formats / timezone offsets.
  expect(
    returningRow.last_login_at,
    'last_login_at must be non-null after returning sign-in',
  ).not.toBeNull();
  const returningLastLoginMs = Date.parse(returningRow.last_login_at ?? '');
  expect(
    Number.isFinite(returningLastLoginMs),
    'post-sign-in last_login_at must be a parseable ISO timestamp',
  ).toBe(true);
  expect(
    returningLastLoginMs,
    `last_login_at must advance from ${baselineLastLoginIso} after returning sign-in`,
  ).toBeGreaterThan(baselineLastLoginMs);
});
