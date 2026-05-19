/**
 * Playwright E2E test — TC-1 (new eligible user) for US1.
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` (TC-1, line 74)
 *   > New eligible user — Given a Microsoft account in the Nortal Entra tenant
 *   > with no prior participant row, when the user completes OAuth sign-in,
 *   > then a participant row is created with `display_name` and `email` from
 *   > the JWT, `role='participant'` (unless `oid` is in the admin list),
 *   > `status='active'`, and the user is redirected to the dashboard with the
 *   > welcome modal visible.
 *
 * Scope (per T042): assert participant provisioning + dashboard landing. The
 * welcome-modal assertion is intentionally OUT-OF-SCOPE for T042 — it is
 * covered separately by T060 (`welcome-modal-cross-device.spec.ts` / TC-12).
 *
 * Test strategy:
 *   1. Reset DB state via `resetSupabaseState()` so no participant row exists
 *      for the synthetic `oid` we are about to inject.
 *   2. Drive the JWT-injection path with `signInAs({ tenant: 'eligible' })`
 *      (see `e2e/fixtures/auth.ts` and research R-7). This installs the
 *      Supabase session cookies in the browser context — the same end state
 *      that a real Microsoft OAuth callback would produce.
 *   3. Invoke `provision_participant_from_jwt()` RPC from the authenticated
 *      browser context. Production code calls this RPC inside the
 *      `/auth/callback` Route Handler immediately after `exchangeCodeForSession`
 *      (see `app/auth/callback/route.ts`); JWT injection bypasses the code
 *      exchange, so the test invokes the RPC explicitly to exercise the same
 *      provisioning code path.
 *   4. Navigate to `/dashboard` and assert the greeting renders for the new
 *      participant — this confirms the post-sign-in landing surface works
 *      end-to-end (FR-003).
 *   5. Verify the DB state with a service-role read of `participants` — using
 *      the service role bypasses RLS, which is appropriate because the test
 *      is asserting on data the participant themselves would not be able to
 *      read in full (e.g., the `oid` and `email` columns are visible to admins
 *      only via the public view).
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import { getParticipantByOid, resetSupabaseState } from '../fixtures/db';

test.beforeEach(async () => {
  await resetSupabaseState();
});

test('TC-1: new eligible user is provisioned and lands on dashboard', async ({ page }) => {
  // Step 1: sign in as a brand-new eligible user. `signInAs` mints a synthetic
  // Microsoft-shaped ID token (random `oid`, `nortal.com` email) and calls
  // `supabase.auth.signInWithIdToken({ provider: 'azure' })` inside the page
  // context, leaving the browser with valid Supabase session cookies.
  const { oid, email, displayName } = await signInAs(page, { tenant: 'eligible' });

  // Step 2: invoke the provisioning RPC from the authenticated browser
  // context. Production code calls this from `/auth/callback`; JWT injection
  // skips that handler, so we trigger the same RPC here to exercise the
  // provisioning code path (FR-003).
  const provisionResult = await page.evaluate(
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

  expect(provisionResult.ok, 'provision_participant_from_jwt RPC must succeed').toBe(true);

  // Step 3: assert the participant row was created with the expected shape.
  // Using the service-role client (see `e2e/fixtures/db.ts`) bypasses RLS so
  // the test can verify columns that admin-only RLS policies otherwise hide.
  const participant = await getParticipantByOid(oid);
  expect(participant, `participant row for oid=${oid} must exist`).not.toBeNull();

  // Non-null assertion is safe here because we just asserted not-null above;
  // `getParticipantByOid` returns `Tables<'participants'> | null`.
  const row = participant as NonNullable<typeof participant>;
  expect(row.oid).toBe(oid);
  // Email is normalized to lowercase via citext + trim trigger; `signInAs`
  // already uses lowercase, so case-insensitive comparison is unnecessary
  // here. (TC-13 / T066 covers the case-folding behaviour explicitly.)
  expect(row.email).toBe(email);
  expect(row.display_name).toBe(displayName);
  expect(row.role).toBe('participant');
  expect(row.status).toBe('active');
  expect(row.last_login_at).not.toBeNull();

  // Step 4: navigate to the dashboard and assert the greeting renders.
  // The greeting template in `lib/i18n/messages/en.json` is `"Welcome, {name}"`.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole('heading', { level: 1, name: `Welcome, ${displayName}` }),
  ).toBeVisible();
});
