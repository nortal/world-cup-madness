/**
 * Playwright E2E test — TC-9 (role downgrade) for US4 / FR-A5.
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` (TC-9)
 *   > Role downgrade — Given a participant whose `oid` was previously in the
 *   > admin list but has since been removed, when they next sign in, then
 *   > their `role` is downgraded to `participant` and an audit entry
 *   > `action='participant.role-changed'` is written.
 *
 * Scope (per T056): assert end-to-end downgrade behaviour when an oid is
 * dropped from `tournament_config.admin_oids` between two sign-ins:
 *   1. `participants.role` flips from `'admin'` to `'participant'` on the
 *      second `provision_participant_from_jwt()` call (migration 0006).
 *   2. The `audit_participants_changes()` AFTER UPDATE trigger (migration
 *      0005) writes a `participant.role-changed` row with `old_value.role =
 *      'admin'` and `new_value.role = 'participant'`.
 *   3. The dashboard no longer renders the `AdminNavLink` ("Admin console"
 *      link from `dashboard.adminNavLabel` in `lib/i18n/messages/en.json`)
 *      because the freshly-issued JWT no longer carries an admin-derived
 *      claim. This is the UI-side observable that closes the loop on FR-A5.
 *
 * Out of scope here:
 *   - Promotion path (participant -> admin on re-sign-in) — covered by US4's
 *     promotion spec, not this one.
 *   - RLS-level admin policy denial after downgrade — covered by US4's
 *     per-request authorization spec.
 *
 * Test strategy (mirrors auth-tenant-departure.spec.ts's two-phase pattern —
 * seed an existing participant with the first sign-in, mutate DB state, then
 * re-sign-in as the trigger event under test):
 *   1. `resetSupabaseState()` clears participants, audit_log, and resets
 *      `tournament_config.admin_oids` to an empty array.
 *   2. First sign-in via `signInAs({ tenant: 'eligible', role: 'admin' })` —
 *      the fixture's admin branch calls `seedAdmin(oid)` BEFORE the page-side
 *      `signInWithPassword`, so when the provisioning RPC runs it sees the
 *      oid inside `admin_oids` and promotes the new row to `role='admin'`.
 *   3. Invoke `provision_participant_from_jwt()` from the page (same CDN
 *      `@supabase/ssr@0.10.3` pattern used by `auth-eligible-new-user.spec.ts`
 *      and `auth-tenant-departure.spec.ts`). Confirm admin promotion in DB.
 *   4. Demote in DB: service-role read of `tournament_config` followed by an
 *      UPDATE that sets `admin_oids` to `[]`. Read-then-update over a blind
 *      UPDATE so the test's intent (and the singleton's id) is explicit.
 *   5. Clear browser cookies before the second sign-in. The fixture re-uses
 *      the same `auth.users` row (matched by email) and `updateUserById`
 *      issues a fresh session, but clearing cookies first guarantees no
 *      stale admin JWT lingers in the page context. This is the
 *      less-brittle of the two suggested options (a `/auth/sign-out`
 *      navigation depends on a route handler whose behaviour is outside
 *      this test's contract).
 *   6. Second sign-in re-uses the SAME `oid`, `email`, and `displayName` so
 *      the existing participant row is matched on `oid` lookup. `role` is
 *      omitted intentionally — the fixture must NOT re-seed the admin list,
 *      because that would undo step 4.
 *   7. Invoke the provisioning RPC again. The migration-0006 branch
 *      `v_new_role := CASE WHEN v_oid = ANY(...) THEN 'admin' ELSE
 *      'participant' END` now evaluates to 'participant'; the resulting
 *      UPDATE on `participants.role` trips the audit trigger.
 *   8. Assert participant row role flipped and the role-changed audit row
 *      exists with the expected `old_value.role` / `new_value.role` payload
 *      (verified verbatim against `0005_audit_triggers.sql`).
 *   9. Navigate to `/dashboard`. The greeting MUST still render (the user
 *      is still an active eligible participant), but the "Admin console"
 *      link MUST NOT be present.
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import {
  getAuditLog,
  getParticipantByOid,
  getServiceRoleClient,
  resetSupabaseState,
} from '../fixtures/db';

/**
 * Invoke `provision_participant_from_jwt()` from the authenticated browser
 * context using `@supabase/ssr`'s cookie-aware client (the same SDK the app
 * uses in Server Components). Hydrates the session from cookies before the
 * RPC fires so we don't race ahead unauthenticated.
 *
 * Duplicated from `auth-eligible-new-user.spec.ts` /
 * `auth-tenant-departure.spec.ts` for self-containedness — promote to
 * `e2e/fixtures/rpc.ts` if a fourth spec adopts it.
 */
async function provisionParticipantFromPage(
  page: import('@playwright/test').Page,
): Promise<
  | { ok: true; data: unknown }
  | { ok: false; error: string }
> {
  return page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      // Force the new client to hydrate the persisted session from cookies
      // before issuing the RPC. Without this the rpc call may race ahead
      // unauthenticated, since `createBrowserClient` returns synchronously
      // but the auth state hydrates asynchronously.
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

test('TC-9: removing an oid from admin_oids downgrades role on next sign-in and writes role-changed audit row', async ({
  page,
}) => {
  // ---------------------------------------------------------------------------
  // Phase A — seed a previously-admin participant.
  // ---------------------------------------------------------------------------
  // A1. First sign-in as admin. The fixture's `role: 'admin'` branch seeds
  //     the caller's oid into `tournament_config.admin_oids` BEFORE issuing
  //     the page-side sign-in so the subsequent provisioning RPC promotes
  //     the new row to `role='admin'` on insert (migration 0006).
  const adminSession = await signInAs(page, { tenant: 'eligible', role: 'admin' });
  const { oid, email, displayName } = adminSession;

  // A2. Materialize the participant row via the production RPC. After this
  //     call the row exists with `role='admin'` and `status='active'`.
  const seedProvision = await provisionParticipantFromPage(page);
  expect(
    seedProvision.ok,
    seedProvision.ok ? undefined : seedProvision.error,
  ).toBe(true);

  const seededRow = await getParticipantByOid(oid);
  expect(
    seededRow,
    `seeded participant row for oid=${oid} must exist after admin sign-in`,
  ).not.toBeNull();
  const baseline = seededRow as NonNullable<typeof seededRow>;
  expect(baseline.role, 'baseline row must be promoted to admin via admin_oids seed').toBe(
    'admin',
  );
  expect(baseline.status).toBe('active');

  // ---------------------------------------------------------------------------
  // Phase B — demote: remove the oid from tournament_config.admin_oids.
  // ---------------------------------------------------------------------------
  // B1. Read-then-update via service role. Read-first makes the singleton's
  //     id explicit in the test rather than relying on a hard-coded literal,
  //     and asserts the singleton actually exists (it is created by
  //     migration 0009; absence here would indicate a migration regression).
  const serviceClient = getServiceRoleClient();
  const { data: configRow, error: configReadError } = await serviceClient
    .from('tournament_config')
    .select('id, admin_oids')
    .single();
  expect(
    configReadError,
    'reading tournament_config singleton via service role must succeed',
  ).toBeNull();
  expect(
    configRow,
    'tournament_config singleton row must exist (seeded by migration 0009)',
  ).not.toBeNull();
  const tournamentConfigId = (configRow as { id: number }).id;
  // Sanity check: the admin seed from Phase A1 must have landed before we
  // clear it — otherwise the subsequent re-sign-in would not be a downgrade,
  // it would be a no-op and the test would pass for the wrong reason.
  expect(
    (configRow as { admin_oids: string[] | null }).admin_oids ?? [],
    'admin_oids must contain the seeded oid before demotion',
  ).toContain(oid);

  const { error: demoteError } = await serviceClient
    .from('tournament_config')
    .update({ admin_oids: [] })
    .eq('id', tournamentConfigId);
  expect(
    demoteError,
    'clearing tournament_config.admin_oids via service role must succeed',
  ).toBeNull();

  // ---------------------------------------------------------------------------
  // Phase C — clean session boundary before the second sign-in.
  // ---------------------------------------------------------------------------
  // C1. Clear cookies so no stale admin-issued JWT influences the second
  //     sign-in. `signInAs` will call `updateUserById` (matching on email)
  //     and re-issue a fresh session, but clearing cookies first eliminates
  //     any window where the old session could be observed. Cookie-clearing
  //     is preferred over `/auth/sign-out` here because the route handler's
  //     side-effects are outside this test's contract (TC-9 owns the
  //     downgrade, not the sign-out flow).
  await page.context().clearCookies();

  // ---------------------------------------------------------------------------
  // Phase D — second sign-in (post-demotion).
  // ---------------------------------------------------------------------------
  // D1. Re-sign-in with the SAME oid/email/displayName but NO `role: 'admin'`.
  //     Re-using oid + email is critical: the participant row is keyed by oid,
  //     and the auth.users row is matched on email — both anchor the second
  //     RPC call to the same participant identity. Omitting `role` ensures
  //     the fixture does NOT re-seed `admin_oids`, which would undo Phase B.
  const downgradeSession = await signInAs(page, {
    tenant: 'eligible',
    oid,
    email,
    name: displayName,
  });
  expect(downgradeSession.oid).toBe(oid);
  expect(downgradeSession.email).toBe(email);

  // D2. Invoke the provisioning RPC under the fresh session. Per migration
  //     0006, `v_new_role` evaluates to 'participant' (oid is no longer in
  //     admin_oids), the UPDATE on `participants.role` runs, and the
  //     migration-0005 trigger writes a `participant.role-changed` row.
  const downgradeProvision = await provisionParticipantFromPage(page);
  expect(
    downgradeProvision.ok,
    downgradeProvision.ok ? undefined : downgradeProvision.error,
  ).toBe(true);

  // ---------------------------------------------------------------------------
  // Phase E — assertions.
  // ---------------------------------------------------------------------------
  // E1. Participant row role downgraded; identity columns preserved.
  const afterRow = await getParticipantByOid(oid);
  expect(
    afterRow,
    `participant row for oid=${oid} must still exist after downgrade`,
  ).not.toBeNull();
  const after = afterRow as NonNullable<typeof afterRow>;
  expect(after.role, 'role must be downgraded to participant on second sign-in').toBe(
    'participant',
  );
  expect(after.status).toBe('active');
  expect(after.oid).toBe(oid);
  expect(after.email).toBe(email);
  expect(after.display_name).toBe(displayName);

  // E2. Audit row presence + payload shape. The trigger in
  //     `0005_audit_triggers.sql` writes:
  //       old_value = jsonb_build_object('role', OLD.role)  -- 'admin'
  //       new_value = jsonb_build_object('role', NEW.role)  -- 'participant'
  //     `getAuditLog({ action, oid })` filters on `actor_oid` server-side,
  //     so `.some(...)` here would also work — `.find(...)` lets us assert
  //     on the payload of the matched row.
  const roleChangedRows = await getAuditLog({
    action: 'participant.role-changed',
    oid,
  });
  expect(
    roleChangedRows.length,
    "audit_log must contain at least one 'participant.role-changed' row for the downgraded oid",
  ).toBeGreaterThanOrEqual(1);

  const downgradeAuditRow = roleChangedRows.find(
    (row) =>
      (row.old_value as { role?: string } | null)?.role === 'admin' &&
      (row.new_value as { role?: string } | null)?.role === 'participant',
  );
  expect(
    downgradeAuditRow,
    "audit_log must contain a 'participant.role-changed' row with old_value.role='admin' and new_value.role='participant'",
  ).toBeDefined();
  expect(
    downgradeAuditRow?.actor_oid,
    "role-changed row's actor_oid must match the downgraded participant's oid",
  ).toBe(oid);

  // E3. Dashboard renders, but the admin-nav element is gone. The greeting
  //     confirms the user is still authenticated and active; the absent
  //     "Admin console" link confirms the role-derived UI claim has been
  //     revoked. `getByRole('link', { name: ... })` matches accessible-name
  //     equality, which is the most stable selector for this assertion
  //     (resilient to className/structure changes in AdminNavLink).
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole('heading', { level: 1, name: `Welcome, ${displayName}` }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Admin console' }),
    "Admin console nav link must NOT render after role downgrade to 'participant'",
  ).toHaveCount(0);
});
