/**
 * Playwright E2E — feature 005 US-DA T012.
 *
 * Covers:
 *   - TC-D1 (Mobile tab navigation, spec.md §3): at 360 px, Today is the
 *     default active tab; tapping Pool flips `aria-selected` and updates
 *     the URL to `?tab=pool`.
 *   - TC-D2 (Desktop responsive grid, spec.md §3): at 1024 px the tab
 *     strip is CSS-hidden via the `md:hidden` Tailwind utility (the
 *     component's outer `div[role="tablist"]` is in the DOM but reports
 *     `not.toBeVisible()` because `display: none` is applied at the md
 *     breakpoint — see `DashboardTabStrip.tsx`).
 *   - TC-D1 fresh-nav default: `/dashboard` without `?tab=` always lands
 *     on Today (FR-D02 — no localStorage / sessionStorage persistence).
 *   - TC-D2 reload: `/dashboard?tab=pool` survives a hard reload (Pool
 *     stays `aria-selected="true"`).
 *
 * `provisionFromAuthenticatedPage` mirrors the helper used by feature
 * 004's leaderboard-page.spec.ts: navigate to the dashboard with the
 * authenticated session in cookies, then call
 * `provision_participant_from_jwt()` from a browser-context Supabase
 * client so the participant row is RLS-visible to the route.
 *
 * `test.setTimeout(90_000)` per describe matches feature 004's
 * leaderboard-page suite — protects against dev-server compile latency
 * on the first `/dashboard` hit.
 */

import { expect, test, type Page } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import { resetSupabaseState } from '../fixtures/db';

async function provisionFromAuthenticatedPage(page: Page): Promise<void> {
  await page.goto('/dashboard');
  const result = await page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic CDN import
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      await client.auth.getSession();
      const { error } = await client.rpc('provision_participant_from_jwt');
      if (error) return { ok: false as const, error: error.message };
      // Dismiss the first-login welcome modal so it does not intercept
      // tab navigation clicks. See dashboard-inline-edit.spec.ts for
      // the rationale.
      const { error: dismissError } = await client.rpc('dismiss_welcome');
      return dismissError
        ? { ok: false as const, error: dismissError.message }
        : { ok: true as const };
    },
    {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );
  expect(result.ok, 'provision + dismiss_welcome must succeed').toBe(true);
}

test.describe('US-DA — dashboard mobile tabs + responsive grid', () => {
  test.setTimeout(90_000);

  test.beforeEach(async () => {
    await resetSupabaseState();
  });

  test('TC-D1: mobile tab navigation flips aria-selected + URL', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await signInAs(page, { tenant: 'eligible', name: 'Mobile Tabby' });
    await provisionFromAuthenticatedPage(page);

    await page.goto('/dashboard');

    const todayTab = page.getByRole('tab', { name: /today/i });
    const poolTab = page.getByRole('tab', { name: /pool/i });

    await expect(todayTab).toHaveAttribute('aria-selected', 'true');
    await expect(poolTab).toHaveAttribute('aria-selected', 'false');

    await poolTab.click();
    await page.waitForURL(/[?&]tab=pool\b/);

    // After router.push() resolves, the Server Component re-renders with
    // the new activeTab so aria-selected swaps.
    await expect(poolTab).toHaveAttribute('aria-selected', 'true');
    await expect(todayTab).toHaveAttribute('aria-selected', 'false');
  });

  test('TC-D2: desktop viewport CSS-hides the tab strip', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await signInAs(page, { tenant: 'eligible', name: 'Desktop Donald' });
    await provisionFromAuthenticatedPage(page);

    await page.goto('/dashboard');

    // The tablist element is in the DOM (Server Component renders both
    // mobile + desktop variants per research §R-3) but `md:hidden` on
    // its outer wrapper resolves to `display: none` at 1024 px, so
    // Playwright's `toBeVisible()` reports false.
    const tabList = page.locator('[role="tablist"]').first();
    await expect(tabList).not.toBeVisible();
  });

  test('TC-D1 fresh nav defaults to today without ?tab=', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await signInAs(page, { tenant: 'eligible', name: 'Default Daria' });
    await provisionFromAuthenticatedPage(page);

    await page.goto('/dashboard');

    const todayTab = page.getByRole('tab', { name: /today/i });
    const poolTab = page.getByRole('tab', { name: /pool/i });
    await expect(todayTab).toHaveAttribute('aria-selected', 'true');
    await expect(poolTab).toHaveAttribute('aria-selected', 'false');
  });

  test('TC-D2 reload preserves ?tab=pool', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await signInAs(page, { tenant: 'eligible', name: 'Reload Rita' });
    await provisionFromAuthenticatedPage(page);

    await page.goto('/dashboard?tab=pool');

    const poolTab = page.getByRole('tab', { name: /pool/i });
    await expect(poolTab).toHaveAttribute('aria-selected', 'true');

    await page.reload();
    await expect(poolTab).toHaveAttribute('aria-selected', 'true');
  });
});
