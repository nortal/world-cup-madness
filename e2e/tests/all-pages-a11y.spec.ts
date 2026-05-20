/**
 * Playwright accessibility sweep — T075 (broad WCAG 2.1 AA audit).
 *
 * Task source: `specs/001-authentication-and-participant/tasks.md` T075
 *   > Run accessibility audit Playwright project against all pages:
 *   > `npx playwright test --project=accessibility` and resolve any axe-core
 *   > violations.
 *
 * Scope — every other surface in the feature that has NOT already been audited:
 *   1. `/`             (public landing)                — `app/(public)/page.tsx`
 *   2. `/access-denied`(public, post-OAuth deny)      — `app/(public)/access-denied/page.tsx`
 *   3. `/auth-error`   (public, OAuth/callback error) — `app/(public)/auth-error/page.tsx`
 *   4. `/privacy`      (public, privacy notice)       — `app/(public)/privacy/page.tsx`
 *   5. `/dashboard`    (authenticated, RETURNING user — welcome modal NOT mounted)
 *   6. `/profile`      (authenticated)                — `app/(participant)/profile/page.tsx`
 *
 * Intentionally NOT covered here:
 *   - `/dashboard` WITH the welcome modal open — already audited by
 *     `welcome-modal-a11y.spec.ts` (T061). Duplicating that surface would dilute
 *     the value of this sweep without adding signal. This file specifically
 *     adds the "returning user" dashboard state (welcome_dismissed_at populated,
 *     no dialog rendered) which is otherwise unaudited.
 *
 * Filename convention — why `-a11y.spec.ts`:
 *   `playwright.config.ts` defines an `accessibility` project with
 *   `testMatch: /.*a11y\.spec\.ts/`. CI runs `--project=accessibility` to
 *   produce a focused WCAG report; the default `chromium` project also
 *   executes this file. Naming must match the regex case-sensitively.
 *
 * Test strategy per surface:
 *   - Navigate to the page (sign-in + provision first for authenticated routes).
 *   - Assert a stable rendered marker (the h1) so the audit doesn't run against
 *     a blank / pre-hydration DOM and silently report zero violations on
 *     nothing.
 *   - Run `@axe-core/playwright` scoped to WCAG 2.0 + 2.1 A and AA tags. The
 *     2.0 tags catch the shared foundation rules (contrast, name-role-value);
 *     the 2.1 tags add the AA additions targeted by WCM's accessibility goal.
 *   - Assert zero violations, serialising the violation list into the message
 *     so a CI failure prints the actual rule IDs + node selectors.
 */

import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

/**
 * Invoke `provision_participant_from_jwt()` from the authenticated browser
 * context using `@supabase/ssr`'s cookie-aware client (the same SDK the app
 * uses in Server Components). Hydrates the session from cookies before the
 * RPC fires so we don't race ahead unauthenticated.
 *
 * Hoisted to a file-level helper because two tests below (dashboard +
 * profile) both need the same provisioning step; inlining would duplicate
 * the verbatim `@ts-expect-error` CDN import twice within this single file.
 * Pattern copied from `auth-eligible-new-user.spec.ts` lines 59–81.
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

test.describe('all pages — WCAG 2.1 AA axe-core sweep', () => {
  // Reset before EVERY test, including public-only ones. Public pages don't
  // touch DB state, but the authenticated tests do; running the reset
  // unconditionally keeps the suite order-independent (Playwright workers can
  // shuffle tests within a file).
  test.beforeEach(async () => {
    await resetSupabaseState();
  });

  // ---------------------------------------------------------------------------
  // Public surfaces — no auth, no DB seeding required.
  // ---------------------------------------------------------------------------

  test('/ landing has no a11y violations', async ({ page }) => {
    await page.goto('/');
    // Heading text comes from `lib/i18n/messages/en.json` -> `landing.headline`.
    // Asserting on the h1 (rather than `waitForLoadState`) guarantees the
    // React tree has actually rendered before axe runs — otherwise the audit
    // would scan an empty document and report a misleading clean result.
    await expect(
      page.getByRole('heading', { level: 1, name: 'World Cup Madness' }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('/access-denied has no a11y violations', async ({ page }) => {
    await page.goto('/access-denied');
    // `accessDenied.heading` from en.json.
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'This pool is for Nortal collaborators',
      }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('/auth-error has no a11y violations', async ({ page }) => {
    await page.goto('/auth-error');
    // `authError.heading` from en.json.
    await expect(
      page.getByRole('heading', { level: 1, name: "Sign-in didn't complete" }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('/privacy has no a11y violations', async ({ page }) => {
    await page.goto('/privacy');
    // `privacy.heading` from en.json.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Privacy notice' }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Authenticated surfaces — sign in + provision, then audit.
  // ---------------------------------------------------------------------------

  test('/dashboard (returning user, no welcome modal) has no a11y violations', async ({
    page,
  }) => {
    // Step 1: sign in as a fresh eligible user. We'll immediately pre-mark
    // the resulting participant row as "welcome already dismissed" so the
    // dashboard renders WITHOUT the modal — the dashboard-with-modal-open
    // surface is already covered by `welcome-modal-a11y.spec.ts` and is
    // intentionally not duplicated here.
    const { oid, displayName } = await signInAs(page, { tenant: 'eligible' });

    const provisionResult = await provisionParticipantFromPage(page);
    expect(provisionResult.ok, 'provision_participant_from_jwt RPC must succeed').toBe(true);

    // Step 2: pre-mark welcome as dismissed via the service-role client (RLS
    // bypass — participants cannot UPDATE this column directly, only via the
    // `dismiss_welcome` RPC; for test fixturing the service role is the
    // intended escape hatch). `.select()` forces PostgREST to return the
    // updated row so we can assert the write succeeded before navigating.
    const dismissedAt = new Date().toISOString();
    const serviceRole = getServiceRoleClient();
    const { data: updated, error: updateError } = await serviceRole
      .from('participants')
      .update({ welcome_dismissed_at: dismissedAt })
      .eq('oid', oid)
      .select('oid, welcome_dismissed_at');
    expect(updateError, updateError?.message).toBeNull();
    expect(
      updated,
      `welcome_dismissed_at pre-mark must update exactly one participant row (oid=${oid})`,
    ).toHaveLength(1);

    // Step 3: navigate and assert the returning-user state.
    await page.goto('/dashboard');
    await expect(
      page.getByRole('heading', { level: 1, name: `Welcome, ${displayName}` }),
    ).toBeVisible();
    // Sanity: confirm we are auditing the modal-free dashboard. Without this
    // a regression that re-mounts the modal would silently shift this test's
    // coverage onto the surface T061 already covers.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('/profile has no a11y violations', async ({ page }) => {
    // Same provisioning flow as the dashboard test. The welcome-dismissal
    // pre-mark is intentionally skipped: only the dashboard renders the
    // welcome modal (gated by `DashboardClient`), so the profile page is
    // unaffected by `welcome_dismissed_at` and the extra DB write would be
    // dead weight on this test.
    await signInAs(page, { tenant: 'eligible' });

    const provisionResult = await provisionParticipantFromPage(page);
    expect(provisionResult.ok, 'provision_participant_from_jwt RPC must succeed').toBe(true);

    await page.goto('/profile');
    // `profile.heading` from en.json.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Your profile' }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});
