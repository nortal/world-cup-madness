/**
 * Playwright E2E test — TC-3 (admin role detection) for US1.
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` (TC-3)
 *   > Admin role detection — Given a user whose `oid` is in the configured
 *   > admin list, when the user signs in, then their participant `role` is
 *   > set/refreshed to `admin` and admin navigation is visible on the
 *   > dashboard.
 *
 * Scope (per T055 / FR-A5): assert that a seeded admin oid is provisioned with
 * `role='admin'` and that the dashboard surfaces the `<AdminNavLink />`
 * element. The link target (`/admin`) is a future route — T054 ships the link
 * surface only — so this test asserts visibility + href, not navigation into
 * the admin console.
 *
 * Test strategy:
 *   1. Reset DB state via `resetSupabaseState()` so no participant row exists
 *      for the synthetic `oid` we are about to inject and the admin list is
 *      back to its seeded baseline.
 *   2. Drive sign-in with `signInAs({ tenant: 'eligible', role: 'admin' })`.
 *      The fixture seeds the caller's `oid` into `tournament_config.admin_oids`
 *      BEFORE issuing the session (see `e2e/fixtures/auth.ts` lines 97–102),
 *      so by the time `provision_participant_from_jwt()` runs the row is
 *      promoted to `admin` on first insert.
 *   3. Invoke `provision_participant_from_jwt()` RPC from the authenticated
 *      browser context — same code path as `/auth/callback`, exercised
 *      explicitly because JWT injection bypasses the OAuth handler.
 *   4. Verify the DB state with a service-role read of `participants`,
 *      asserting `role === 'admin'` (the TC-3 differentiator from TC-1).
 *   5. Navigate to `/dashboard`, assert the greeting renders, AND assert the
 *      `<AdminNavLink />` element is visible with `href="/admin"` — the
 *      "admin navigation is visible on the dashboard" half of TC-3.
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import { getParticipantByOid, resetSupabaseState } from '../fixtures/db';

test.beforeEach(async () => {
  await resetSupabaseState();
});

test('TC-3: admin oid is provisioned as admin and dashboard renders the admin nav link', async ({
  page,
}) => {
  // Step 1: sign in as a brand-new eligible user whose oid is on the admin
  // list. Passing `role: 'admin'` instructs the fixture to seed
  // `tournament_config.admin_oids` with this oid before signing in, so the
  // provisioning RPC promotes the row to `admin` on first insert (FR-A5).
  const { oid, email, displayName } = await signInAs(page, {
    tenant: 'eligible',
    role: 'admin',
  });

  // Step 2: invoke the provisioning RPC from the authenticated browser
  // context. Production code calls this from `/auth/callback`; JWT injection
  // skips that handler, so we trigger the same RPC here to exercise the
  // provisioning + role-promotion code path.
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

  // Step 3: assert the participant row was created with `role='admin'`. This
  // is the TC-3 differentiator from TC-1 — same provisioning path, but the
  // pre-seeded admin oid drives the role assignment.
  const participant = await getParticipantByOid(oid);
  expect(participant, `participant row for oid=${oid} must exist`).not.toBeNull();

  // Non-null assertion is safe here because we just asserted not-null above;
  // `getParticipantByOid` returns `Tables<'participants'> | null`.
  const row = participant as NonNullable<typeof participant>;
  expect(row.oid).toBe(oid);
  expect(row.email).toBe(email);
  expect(row.display_name).toBe(displayName);
  expect(row.role).toBe('admin');
  expect(row.status).toBe('active');
  expect(row.last_login_at).not.toBeNull();

  // Step 4: navigate to the dashboard and assert the greeting renders.
  // The greeting template in `lib/i18n/messages/en.json` is `"Welcome, {name}"`.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole('heading', { level: 1, name: `Welcome, ${displayName}` }),
  ).toBeVisible();

  // Step 5: assert the `<AdminNavLink />` surface is rendered for this admin
  // user. The dashboard page gates this component on `participant.role ===
  // 'admin'`, so its presence is the user-visible proof that role detection
  // wired through correctly. Visible text comes from `dashboard.adminNavLabel`
  // in `lib/i18n/messages/en.json` ("Admin console"); href is the stub `/admin`
  // route documented on `AdminNavLink.tsx`.
  const adminNavLink = page.getByRole('link', { name: 'Admin console' });
  await expect(adminNavLink).toBeVisible();
  await expect(adminNavLink).toHaveAttribute('href', '/admin');
});
