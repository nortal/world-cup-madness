// Playwright E2E test for TC-7: Per-request tenant eligibility enforcement.
//
// Spec reference: `specs/001-authentication-and-participant/spec.md` (TC-7,
// line 80; FR-A1, line 112).
//
// What this test proves
// ---------------------
// The `is_eligible_nortal_user()` RLS predicate
// (see `supabase/migrations/0008_rls_policies.sql`) evaluates `auth.jwt() ->> 'tid'`
// on EVERY authenticated request — not just at sign-in. A participant whose
// tenant membership has been revoked mid-session loses data access on the very
// next request without waiting for session expiry.
//
// Why re-sign-in vs in-place JWT mutation
// ---------------------------------------
// `signInAs` (see `e2e/fixtures/auth.ts`) signs in via the Supabase JS client's
// `signInWithIdToken`. The browser-side Supabase client owns the session and
// does not expose a "rewrite this claim" handle. The cleanest way to simulate
// "the user's JWT now carries a different `tid`" is to call `signInAs` a second
// time for the same `oid` but with `tenant: 'ineligible'`. Supabase Auth issues
// a fresh session JWT carrying the ineligible `tid`; subsequent authenticated
// requests therefore reach RLS with the new claim. This matches what would
// happen in production: a token-refresh round-trip after the user is removed
// from the Nortal Entra tenant.
//
// Note on scope
// -------------
// This spec focuses ONLY on the RLS predicate's per-request evaluation. The
// DB-level audit behaviour on tenant-departure sign-in (`participant.deactivated`,
// `auth.rejected`) is covered separately by the TC-6 spec (T048).

import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import { getParticipantByOid, resetSupabaseState } from '../fixtures/db';

/** Shape returned by the in-page authenticated SELECT against `participants`. */
type PageQueryResult =
  | { ok: true; rowCount: number; errorMessage: null }
  | { ok: false; rowCount: 0; errorMessage: string };

/**
 * Run an authenticated SELECT against `participants` from inside the browser
 * context, using the session cookies stored by `signInAs`. We deliberately
 * filter by the freshly-provisioned participant's `oid` so the result is
 * deterministic: with an eligible JWT the row is visible; with an ineligible
 * JWT RLS returns zero rows silently.
 *
 * Done as a fresh `createClient` inside `page.evaluate` (rather than reusing
 * the one that `signInAs` constructed) because the previous closure is gone
 * by the time the next test step runs. The CDN ESM bundle is the same one the
 * fixture uses, keeping versions consistent.
 */
async function selectOwnParticipantByOid(
  page: import('@playwright/test').Page,
  oid: string,
): Promise<PageQueryResult> {
  return page.evaluate(
    async ({ targetOid, supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context (mirrors fixtures/auth.ts).
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      // Force the new client to hydrate the persisted session from
      // cookies before issuing the SELECT. Without this the request may
      // race ahead unauthenticated; the SELECT would then return zero rows
      // for a different reason than the RLS predicate we are testing.
      await client.auth.getSession();
      const { data, error } = await client
        .from('participants')
        .select('id, oid, status')
        .eq('oid', targetOid);

      if (error) {
        return {
          ok: false as const,
          rowCount: 0 as const,
          errorMessage: error.message,
        };
      }
      return {
        ok: true as const,
        rowCount: (data ?? []).length,
        errorMessage: null,
      };
    },
    {
      targetOid: oid,
      supabaseUrl:
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );
}

/**
 * Trigger `provision_participant_from_jwt()` in the page context so that the
 * authenticated user has a participant row to read in the control check.
 * Uses the in-browser session (set by `signInAs`) — this is the same path the
 * real `/auth/callback` route uses.
 */
async function provisionParticipantInPage(
  page: import('@playwright/test').Page,
): Promise<{ ok: boolean; errorMessage: string | null; rawOutcome: unknown }> {
  return page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context (mirrors fixtures/auth.ts).
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      // Force the new client to hydrate the persisted session from
      // cookies before issuing the RPC. Without this the rpc call may race
      // ahead unauthenticated, since `createBrowserClient` returns
      // synchronously but the auth state hydrates asynchronously.
      await client.auth.getSession();
      const { data, error } = await client.rpc('provision_participant_from_jwt');
      if (error) {
        return {
          ok: false,
          errorMessage: error.message as string,
          rawOutcome: null,
        };
      }
      return { ok: true, errorMessage: null, rawOutcome: data };
    },
    {
      supabaseUrl:
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );
}

test.describe('TC-7: per-request eligibility enforcement via RLS', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
  });

  test('participant rows become invisible immediately after the session JWT carries a non-Nortal `tid`', async ({
    page,
  }) => {
    // Use a known `oid` so we can re-sign-in as the "same" user with a
    // different tenant claim (the "removed from the Nortal Entra tenant"
    // scenario). The `oid` is stable in Microsoft Entra across tenant
    // changes — it's the user's directory object id.
    const stableOid = randomUUID();

    // ----- 1. Eligible sign-in -----
    await page.goto('/');
    const eligibleSession = await signInAs(page, {
      tenant: 'eligible',
      oid: stableOid,
    });
    expect(eligibleSession.oid).toBe(stableOid);

    // ----- 2. Provision participant row (mirrors the real /auth/callback path) -----
    const provision = await provisionParticipantInPage(page);
    expect(provision.ok, provision.errorMessage ?? undefined).toBe(true);

    // Service-role sanity check: the row exists in the database.
    const provisioned = await getParticipantByOid(stableOid);
    expect(provisioned).not.toBeNull();
    expect(provisioned?.status).toBe('active');

    // ----- 3. Control check: with eligible JWT the user can SELECT their own row -----
    const eligibleRead = await selectOwnParticipantByOid(page, stableOid);
    expect(
      eligibleRead.ok,
      eligibleRead.ok ? undefined : eligibleRead.errorMessage,
    ).toBe(true);
    expect(eligibleRead.rowCount).toBe(1);

    // ----- 4. Mutate tenant claim by re-signing-in with the SAME `oid`
    //         but `tenant: 'ineligible'` -----
    // This simulates "Nortal Entra membership revoked mid-session": the next
    // Supabase session JWT now carries a non-Nortal `tid`. No service-role
    // workaround is used — the user's own (now-ineligible) JWT performs the
    // next query, which is the whole point of the test (RLS as the boundary).
    const ineligibleSession = await signInAs(page, {
      tenant: 'ineligible',
      oid: stableOid,
    });
    expect(ineligibleSession.oid).toBe(stableOid);
    expect(ineligibleSession.tid).not.toBe(eligibleSession.tid);

    // ----- 5. Assert: per-request RLS now denies the same SELECT (zero rows, no error) -----
    // The `is_eligible_nortal_user()` predicate returns false because
    // `auth.jwt() ->> 'tid'` no longer matches `tournament_config.nortal_tenant_id`.
    // Both `participants` SELECT policies (`_select_own`, `_select_active_for_leaderboard`)
    // require this predicate, so RLS filters every row — PostgREST returns a
    // successful response with an empty array (silent deny), NOT an explicit
    // 4xx error. This is the documented Postgres RLS contract.
    const ineligibleRead = await selectOwnParticipantByOid(page, stableOid);
    expect(
      ineligibleRead.ok,
      ineligibleRead.ok ? undefined : ineligibleRead.errorMessage,
    ).toBe(true);
    expect(ineligibleRead.rowCount).toBe(0);

    // ----- 6. The participant row is preserved at the data layer -----
    // RLS denies the read; it does NOT delete the row. (Status flip on
    // tenant departure is covered by TC-6 / T048 — not this test.)
    const preserved = await getParticipantByOid(stableOid);
    expect(preserved).not.toBeNull();
  });
});
