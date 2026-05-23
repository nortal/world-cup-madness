/**
 * Playwright E2E test — TC-8 (admin audit search for auth failures) for US2.
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` (TC-8, line 81)
 *   > Audit search for auth failures — Given multiple `auth.rejected` entries
 *   > in the audit log, when an admin searches the audit log by action type,
 *   > then the rejected attempts appear with `oid`, `email`, and
 *   > `attempted_tid` available for investigation.
 *
 * Spec source: FR-002 (line 110) — admins must be able to investigate
 * `auth.rejected` events; the audit_log SELECT policy is admin-gated:
 *
 *   CREATE POLICY audit_log_admin_select ON audit_log
 *       FOR SELECT TO authenticated
 *       USING (is_eligible_nortal_user() AND is_admin_user());
 *
 * (see `supabase/migrations/0008_rls_policies.sql` +
 * `supabase/migrations/0010_fix_jwt_claim_reads.sql`).
 *
 * Why this test exists
 * --------------------
 * The point is to verify that an *admin's own* JWT (session cookies set by
 * `signInAs`) can read `audit_log` through PostgREST. Service-role reads would
 * bypass RLS entirely and prove nothing about the policy — the whole purpose
 * of this scenario is to exercise `is_eligible_nortal_user() AND is_admin_user()`
 * in the policy USING clause, end-to-end.
 *
 * Test strategy:
 *   1. `resetSupabaseState()` to clear audit_log + participants between runs.
 *   2. Seed an `auth.rejected` row by signing in an *ineligible* user (random
 *      `oid`, non-Nortal `tid`) and invoking `provision_participant_from_jwt()`
 *      from the page. The RPC's tenant-mismatch branch writes the audit row
 *      via `record_auth_failure(...)` — same production code path TC-5 (T047)
 *      covers. We do NOT shortcut this with a service-role INSERT into
 *      `audit_log`: keeping the row source-of-truth identical to production
 *      ensures the columns we later assert on (`actor_oid`, `actor_email`,
 *      `attempted_tid`, `reason`, `occurred_at`) are populated exactly the way
 *      production will populate them.
 *   3. Switch sessions in the SAME `page` to an admin user (separate `oid`,
 *      eligible tenant, `role: 'admin'`). `signInAs` with `role: 'admin'`
 *      calls `seedAdmin(adminOid)` first so `tournament_config.admin_oids`
 *      contains the admin's oid BEFORE provisioning — without that, the
 *      provisioning RPC would write the row with `role='participant'` and
 *      `is_admin_user()` would return false.
 *   4. Provision the admin's participant row from the page (production
 *      `/auth/callback` does this automatically; JWT injection skips it).
 *   5. Service-role sanity check: confirm the admin's `participants` row
 *      really has `role='admin'`. This guards against silently regressing the
 *      admin-promotion path inside `provision_participant_from_jwt`.
 *   6. From the admin's authenticated browser session, query
 *      `audit_log` via PostgREST with the explicit column list TC-8 calls
 *      out (`id,occurred_at,action,actor_oid,actor_email,attempted_tid,reason`)
 *      filtered by `action='auth.rejected'`. RLS evaluates the SELECT through
 *      `is_eligible_nortal_user() AND is_admin_user()` — both must hold for
 *      rows to be returned.
 *   7. Assertions:
 *        - At least one row returned.
 *        - Every returned row has `action === 'auth.rejected'`.
 *        - At least one row has the seeded `attempted_tid` (the
 *          INELIGIBLE_TENANT_ID), with `actor_oid` + `actor_email` matching
 *          the ineligible user from step 2.
 *   8. Control check: re-run the same SELECT for a DIFFERENT action
 *      (`participant.created`, written by the audit trigger when the admin's
 *      own row was inserted in step 4). Admin must be able to read those rows
 *      too — proves the policy is not accidentally action-scoped and that the
 *      admin really has broad audit-read access via the policy as written.
 *
 * Order of operations rationale (ineligible-first, then admin):
 *   The admin's session is the one we want active *at the moment of the
 *   audit_log SELECT*, so it must come last. Re-signing-in after the audit
 *   read would invalidate the test. The same `page` is reused across both
 *   sign-ins; `signInAs`'s second call replaces session cookies in place
 *   (see `e2e/fixtures/auth.ts` re-sign-in semantics, and the per-request
 *   RLS test which uses the same pattern).
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { INELIGIBLE_TENANT_ID, signInAs } from '../fixtures/auth';
import {
  getParticipantByOid,
  getServiceRoleClient,
  resetSupabaseState,
} from '../fixtures/db';

/**
 * Invoke `provision_participant_from_jwt()` from the authenticated browser
 * context. Mirrors the helpers in `auth-eligible-new-user.spec.ts` and
 * `auth-per-request-rls.spec.ts` — kept inline rather than imported because
 * each spec stays self-contained per project convention (promote to
 * `e2e/fixtures/rpc.ts` once a fourth spec needs it).
 */
async function provisionParticipantInPage(
  page: Page,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  return page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      // Hydrate persisted session from cookies before issuing the RPC.
      // `createBrowserClient` returns synchronously, but session hydration is
      // async — without this await the RPC may race ahead unauthenticated.
      await client.auth.getSession();
      const { data, error } = await client.rpc('provision_participant_from_jwt');
      if (error !== null && error !== undefined) {
        return { ok: false as const, error: error.message };
      }
      return { ok: true as const, data };
    },
    {
      supabaseUrl:
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );
}

/** Shape returned by the admin-authenticated SELECT against `audit_log`. */
type AuditLogRow = {
  id: number;
  occurred_at: string;
  action: string;
  actor_oid: string | null;
  actor_email: string | null;
  attempted_tid: string | null;
  reason: string | null;
};

type AuditQueryResult =
  | { ok: true; rows: AuditLogRow[]; errorMessage: null }
  | { ok: false; rows: never[]; errorMessage: string };

/**
 * Run an authenticated SELECT against `audit_log` from the page's browser
 * context, using the session cookies installed by `signInAs`. The column list
 * is exactly the TC-8 triage projection: id + occurred_at + action +
 * actor_oid + actor_email + attempted_tid + reason.
 *
 * The query is filtered by `action` so the test can target the seeded
 * `auth.rejected` row, and a control assertion can target
 * `participant.created` rows in the same shape.
 */
async function selectAuditLogAsAdmin(
  page: Page,
  filterAction: string,
): Promise<AuditQueryResult> {
  return page.evaluate(
    async ({ action, supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      // Hydrate the admin's session before issuing the query — otherwise
      // PostgREST sees an anon JWT and RLS denies (or short-circuits) the
      // SELECT for a different reason than the policy under test.
      await client.auth.getSession();
      const { data, error } = await client
        .from('audit_log')
        .select('id,occurred_at,action,actor_oid,actor_email,attempted_tid,reason')
        .eq('action', action);

      if (error) {
        return {
          ok: false as const,
          rows: [] as never[],
          errorMessage: error.message,
        };
      }
      return {
        ok: true as const,
        rows: (data ?? []) as Array<{
          id: number;
          occurred_at: string;
          action: string;
          actor_oid: string | null;
          actor_email: string | null;
          attempted_tid: string | null;
          reason: string | null;
        }>,
        errorMessage: null,
      };
    },
    {
      action: filterAction,
      supabaseUrl:
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );
}

test.describe('TC-8: admin audit search for auth failures', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
  });

  test("admin can SELECT auth.rejected rows from audit_log via their own JWT and see the triage columns", async ({
    page,
  }) => {
    // ----- 1. Seed an `auth.rejected` row via the production code path. -----
    // The ineligible user is a separate identity from the admin (different
    // `oid`, different email, ineligible tenant). Signing them in first lets
    // us reuse the same `page` for the admin afterwards — `signInAs`'s second
    // call replaces session cookies in place.
    const ineligibleOid = randomUUID();
    await page.goto('/');
    const ineligibleSession = await signInAs(page, {
      tenant: 'ineligible',
      oid: ineligibleOid,
    });
    expect(ineligibleSession.oid).toBe(ineligibleOid);
    expect(ineligibleSession.tid).toBe(INELIGIBLE_TENANT_ID);

    // Trigger the tenant-mismatch branch of provision_participant_from_jwt —
    // this writes `audit_log` row with action='auth.rejected', actor_oid,
    // actor_email, attempted_tid, reason='tenant.mismatch'. The RPC itself
    // returns an outcome rather than throwing, so `ok: true` here is the
    // expected result; the rejection is reflected in the JSON payload.
    const ineligibleProvision = await provisionParticipantInPage(page);
    expect(
      ineligibleProvision.ok,
      ineligibleProvision.ok ? undefined : ineligibleProvision.error,
    ).toBe(true);

    // Service-role sanity check: no participant row exists for the ineligible
    // user (FC-2 invariant — no row on rejection).
    const ineligibleParticipant = await getParticipantByOid(ineligibleOid);
    expect(
      ineligibleParticipant,
      `ineligible user (oid=${ineligibleOid}) must NOT have a participants row`,
    ).toBeNull();

    // ----- 2. Switch the page to an admin session. -----
    // `role: 'admin'` triggers `seedAdmin(adminOid)` inside `signInAs`, so
    // `tournament_config.admin_oids` contains this oid BEFORE the admin's
    // first provisioning call below. Without that ordering the provisioning
    // RPC would mint the row with role='participant' and the audit_log
    // policy's `is_admin_user()` check would deny.
    const adminOid = randomUUID();
    const adminSession = await signInAs(page, {
      tenant: 'eligible',
      oid: adminOid,
      role: 'admin',
    });
    expect(adminSession.oid).toBe(adminOid);

    // Provision the admin's participant row via the production RPC path.
    // The audit_log trigger fires here and writes a `participant.created`
    // row — used by the control check at the end of the test.
    const adminProvision = await provisionParticipantInPage(page);
    expect(
      adminProvision.ok,
      adminProvision.ok ? undefined : adminProvision.error,
    ).toBe(true);

    // ----- 3. Service-role sanity check the admin row has role='admin'. -----
    // The whole test hinges on RLS allowing this user past
    // `is_admin_user()`; that helper checks
    // `participants.role='admin' AND status='active'` for the current
    // auth.uid. If provisioning silently regressed to role='participant'
    // the audit SELECT would return zero rows and we'd be debugging the
    // wrong thing. Service-role bypasses RLS, so this read is reliable.
    const adminParticipant = await getParticipantByOid(adminOid);
    expect(
      adminParticipant,
      `admin participant row for oid=${adminOid} must exist`,
    ).not.toBeNull();
    const adminRow = adminParticipant as NonNullable<typeof adminParticipant>;
    expect(adminRow.role).toBe('admin');
    expect(adminRow.status).toBe('active');

    // ----- 4. Admin SELECTs audit_log filtered by action='auth.rejected'. -----
    // This is the actual TC-8 assertion path: admin's *own* JWT, NOT
    // service-role. RLS evaluates `is_eligible_nortal_user() AND
    // is_admin_user()` on this very request — both must hold.
    const rejectedQuery = await selectAuditLogAsAdmin(page, 'auth.rejected');
    expect(
      rejectedQuery.ok,
      rejectedQuery.ok
        ? undefined
        : `admin SELECT on audit_log failed: ${rejectedQuery.errorMessage}`,
    ).toBe(true);
    // Narrow union: the falsy branch never reaches the assertions below.
    if (!rejectedQuery.ok) return;

    const rejectedRows = rejectedQuery.rows;
    expect(
      rejectedRows.length,
      'admin must see at least one auth.rejected row in audit_log',
    ).toBeGreaterThan(0);

    // Every returned row's action must be the one we filtered on — guards
    // against accidental wildcards in the projection or `.eq()` not being
    // applied.
    for (const row of rejectedRows) {
      expect(row.action).toBe('auth.rejected');
    }

    // At least one row must correspond to the ineligible user we seeded in
    // step 1: same `attempted_tid`, same `actor_oid`, and a matching email.
    // We do not require an exact length of 1 because earlier test workers
    // could in principle leave residual rows; `resetSupabaseState()` is per
    // worker, but the assertion is robust either way.
    const seededRow = rejectedRows.find(
      (r) =>
        r.actor_oid === ineligibleOid &&
        r.attempted_tid === INELIGIBLE_TENANT_ID,
    );
    expect(
      seededRow,
      `expected an auth.rejected row with actor_oid=${ineligibleOid} ` +
        `and attempted_tid=${INELIGIBLE_TENANT_ID}`,
    ).toBeDefined();
    // Refine type after expect().toBeDefined() — TS does not narrow on jest-style matchers.
    const triageRow = seededRow as AuditLogRow;
    expect(triageRow.actor_email).not.toBeNull();
    expect((triageRow.actor_email ?? '').toLowerCase()).toBe(
      ineligibleSession.email.toLowerCase(),
    );
    expect(triageRow.occurred_at).not.toBeNull();
    // `record_auth_failure` writes reason='tenant.mismatch' for this branch
    // (see provision_participant_from_jwt). Asserting it lets us catch a
    // future change where the reason category silently drifts.
    expect(triageRow.reason).toBe('tenant.mismatch');

    // ----- 5. Control check: admin can read OTHER action types too. -----
    // The audit trigger on `participants` fires on the admin's own row
    // INSERT (step 2) and writes a `participant.created` audit row.
    // Re-running the same query for `participant.created` proves the policy
    // is not accidentally action-scoped (`audit_log_admin_select` does not
    // filter by action — only by `is_eligible_nortal_user() AND
    // is_admin_user()`).
    const createdQuery = await selectAuditLogAsAdmin(page, 'participant.created');
    expect(
      createdQuery.ok,
      createdQuery.ok
        ? undefined
        : `admin SELECT for participant.created failed: ${createdQuery.errorMessage}`,
    ).toBe(true);
    if (!createdQuery.ok) return;
    expect(
      createdQuery.rows.length,
      'admin must also see participant.created audit rows (policy is not action-scoped)',
    ).toBeGreaterThan(0);
    for (const row of createdQuery.rows) {
      expect(row.action).toBe('participant.created');
    }
  });
});
