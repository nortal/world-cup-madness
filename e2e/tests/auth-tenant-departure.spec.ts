/**
 * Playwright E2E test — TC-6 (tenant departure) for US2 / FR-002.
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` (TC-6, line 79)
 *   > Soft-deactivation on tenant departure — Given a previously-active
 *   > participant whose Entra tenant membership has been revoked, when they
 *   > attempt to sign in, then their `status` flips to `inactive`, an audit
 *   > entry `action='participant.deactivated'` is written with
 *   > reason='tenant.departure', and they are redirected to `/access-denied`.
 *   > Their predictions and historical leaderboard entries remain intact.
 *
 * Scope (per T048): assert the DB-level effects of a previously-active
 * participant signing in again from a different (non-Nortal) tenant:
 *   1. `participants.status` flips from `'active'` to `'inactive'`.
 *   2. Two audit rows are present for the participant's `oid`:
 *      - `participant.deactivated` with `reason='tenant.departure'` (written by
 *        the audit trigger in migration 0005 when status transitions to
 *        inactive).
 *      - `auth.rejected` with `reason='tenant.mismatch'` and `attempted_tid`
 *        equal to the non-Nortal `tid` (written by `record_auth_failure()`
 *        inside `provision_participant_from_jwt()` — migration 0006).
 *   3. The row is preserved at the data layer — `oid`, `email`,
 *      `display_name`, and `last_login_at` all continue to exist (status flip
 *      is a soft-deactivation, not a delete).
 *
 * Out of scope here:
 *   - Redirect to `/access-denied` — that is the route-handler concern (FR-002)
 *     and is covered by US2's UI-level test, not by this DB-focused spec.
 *   - Per-request RLS denial after status flip — covered separately by TC-7
 *     (`auth-per-request-rls.spec.ts` / T049).
 *
 * Test strategy (mirrors T043's FK-safe seed pattern):
 *   `participants.auth_user_id` has a NOT NULL FK to `auth.users(id)`, so we
 *   cannot directly INSERT a participant via service role without first
 *   minting the underlying auth user. Instead we drive the production
 *   provisioning RPC once with an ELIGIBLE JWT to materialize the prior-active
 *   row (this also writes the `auth.users` row, satisfying the FK). Then we
 *   re-sign-in as the SAME `oid` but with `tenant: 'ineligible'` — the second
 *   `provision_participant_from_jwt()` invocation is the call under test.
 *
 *   We backdate `last_login_at` between the two phases so that an optional
 *   assertion can verify the rejected sign-in did NOT update it (the RPC's
 *   `last_login_at = now()` branch only runs on the successful path).
 *
 *   Audit-row assertions use `.some(...)` against rows filtered by `oid` — not
 *   exact-count assertions — because the eligible-seed step writes its own
 *   `participant.created` row, and asserting on a total count would couple
 *   this test to unrelated audit volume.
 */

import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { INELIGIBLE_TENANT_ID, signInAs } from '../fixtures/auth';
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
 * Returned shape preserves the RPC's `outcome` / `reason` payload so the test
 * can assert on the rejection-shaped response from the second call.
 *
 * Duplicated from `auth-eligible-returning.spec.ts` for self-containedness —
 * promote to `e2e/fixtures/rpc.ts` if a third spec adopts it.
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

test('TC-6: previously-active participant signing in from a different tenant is soft-deactivated and the rejection is audited', async ({
  page,
}) => {
  // Stable `oid` so the second sign-in maps to the SAME participant identity
  // even though the email + tid + auth.users row change.
  const stableOid = randomUUID();

  // ---------------------------------------------------------------------------
  // Phase A — seed a previously-active eligible participant.
  // ---------------------------------------------------------------------------
  // A1. Eligible sign-in: creates the `auth.users` row that
  //     `participants.auth_user_id` references.
  const eligibleSession = await signInAs(page, {
    tenant: 'eligible',
    oid: stableOid,
  });
  expect(eligibleSession.oid).toBe(stableOid);

  // A2. Materialize the participant row via the production RPC. After this
  //     call, the row exists with `status='active'`, the seeded display_name,
  //     and a fresh `last_login_at`.
  const seedProvision = await provisionParticipantFromPage(page);
  expect(
    seedProvision.ok,
    seedProvision.ok ? undefined : seedProvision.error,
  ).toBe(true);

  // A3. Backdate `last_login_at` via the service role so a later assertion can
  //     verify it has NOT been overwritten by the rejected sign-in attempt
  //     (the RPC's UPDATE-last-login branch only runs on the successful path).
  const backdatedLastLogin = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const serviceClient = getServiceRoleClient();
  const { error: backdateError } = await serviceClient
    .from('participants')
    .update({ last_login_at: backdatedLastLogin })
    .eq('oid', stableOid);
  expect(
    backdateError,
    'backdating last_login_at via service role must succeed',
  ).toBeNull();

  // A4. Capture baselines so post-rejection assertions can compare against
  //     them (display_name preservation, last_login_at non-advancement).
  const seededRow = await getParticipantByOid(stableOid);
  expect(
    seededRow,
    `seeded participant row for oid=${stableOid} must exist`,
  ).not.toBeNull();
  const baseline = seededRow as NonNullable<typeof seededRow>;
  expect(baseline.status).toBe('active');
  const baselineDisplayName = baseline.display_name;
  const baselineLastLoginIso = baseline.last_login_at;
  expect(
    baselineLastLoginIso,
    'baseline last_login_at must be set after backdate UPDATE',
  ).not.toBeNull();
  const baselineLastLoginMs = Date.parse(baselineLastLoginIso ?? '');
  expect(
    Number.isFinite(baselineLastLoginMs),
    'baseline last_login_at must be a parseable ISO timestamp',
  ).toBe(true);

  // ---------------------------------------------------------------------------
  // Phase B — the "tenant departure" sign-in: same oid, non-Nortal tid.
  // ---------------------------------------------------------------------------
  // B1. Re-sign-in with the SAME `oid` but `tenant: 'ineligible'`. The fixture
  //     creates a fresh auth.users row carrying the non-Nortal tid claim;
  //     because the participant row is keyed by `oid` (not by auth_user_id),
  //     the provisioning RPC still recognizes the same participant identity.
  const ineligibleSession = await signInAs(page, {
    tenant: 'ineligible',
    oid: stableOid,
  });
  expect(ineligibleSession.oid).toBe(stableOid);
  expect(ineligibleSession.tid).toBe(INELIGIBLE_TENANT_ID);
  expect(ineligibleSession.tid).not.toBe(eligibleSession.tid);

  // B2. Invoke the provisioning RPC under the ineligible session. Per
  //     migration 0006, the tid-mismatch branch must:
  //       - mark the existing active participant row inactive (which trips
  //         the audit trigger in migration 0005 to write
  //         `participant.deactivated` with reason='tenant.departure'), AND
  //       - call `record_auth_failure('auth.rejected', ..., 'tenant.mismatch')`
  //         which writes the second audit row.
  //     The RPC itself returns `{ outcome: 'rejected', reason: 'tenant.mismatch' }`.
  const rejectProvision = await provisionParticipantFromPage(page);
  expect(
    rejectProvision.ok,
    rejectProvision.ok ? undefined : rejectProvision.error,
  ).toBe(true);
  // Narrow `data` for the outcome/reason check. The RPC returns a JSONB
  // payload; `unknown` here keeps the assertion explicit about shape.
  const rejectData = (rejectProvision as { ok: true; data: unknown }).data as {
    outcome?: string;
    reason?: string;
  } | null;
  expect(rejectData?.outcome).toBe('rejected');
  expect(rejectData?.reason).toBe('tenant.mismatch');

  // ---------------------------------------------------------------------------
  // Phase C — assertions.
  // ---------------------------------------------------------------------------
  // C1. Participant row is preserved (status flipped, history intact).
  const afterRow = await getParticipantByOid(stableOid);
  expect(
    afterRow,
    `participant row for oid=${stableOid} must still exist after rejection`,
  ).not.toBeNull();
  const after = afterRow as NonNullable<typeof afterRow>;
  expect(after.status).toBe('inactive');
  expect(after.oid).toBe(stableOid);
  expect(after.display_name).toBe(baselineDisplayName);
  expect(
    after.last_login_at,
    'last_login_at must be preserved (not deleted) after tenant-departure rejection',
  ).not.toBeNull();

  // C2. Optional last_login_at non-advancement check — the RPC's UPDATE-last-
  //     login branch only runs on the successful path, so a rejected attempt
  //     must leave the backdated value untouched.
  const afterLastLoginMs = Date.parse(after.last_login_at ?? '');
  expect(
    Number.isFinite(afterLastLoginMs),
    'post-rejection last_login_at must remain a parseable ISO timestamp',
  ).toBe(true);
  expect(
    afterLastLoginMs,
    'last_login_at must NOT advance on a rejected sign-in (RPC updates only on the success branch)',
  ).toBe(baselineLastLoginMs);

  // C3. Audit rows: filter by oid (so the eligible-seed step's
  //     `participant.created` row is included in the same set), then assert
  //     PRESENCE of the two required rows via `.some(...)`. We deliberately
  //     do NOT assert on the total count — this test owns the deactivation
  //     and rejection rows, not the volume of audit traffic produced by
  //     seeding.
  const auditRows = await getAuditLog({ oid: stableOid });

  const deactivatedRow = auditRows.find(
    (row) =>
      row.action === 'participant.deactivated' &&
      row.reason === 'tenant.departure',
  );
  expect(
    deactivatedRow,
    "audit_log must contain a 'participant.deactivated' row with reason='tenant.departure' for the soft-deactivated participant",
  ).toBeDefined();

  const rejectedRow = auditRows.find(
    (row) =>
      row.action === 'auth.rejected' &&
      row.reason === 'tenant.mismatch',
  );
  expect(
    rejectedRow,
    "audit_log must contain an 'auth.rejected' row with reason='tenant.mismatch' for the tenant-departure attempt",
  ).toBeDefined();
  expect(
    rejectedRow?.attempted_tid,
    "auth.rejected row's attempted_tid must be the non-Nortal tid that triggered the rejection",
  ).toBe(INELIGIBLE_TENANT_ID);
});
