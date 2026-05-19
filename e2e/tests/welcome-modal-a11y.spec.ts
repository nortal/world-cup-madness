/**
 * Playwright accessibility E2E test — T061 (NFR-A4) for US1 welcome modal.
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` NFR-A4
 *   > The welcome modal MUST be keyboard-dismissible (Esc), trap focus while
 *   > open, and announce its content to screen readers (WCAG 2.1 AA).
 *
 * Task source: `specs/001-authentication-and-participant/tasks.md` T061
 *   > @axe-core/playwright audit on dashboard with welcome modal open + assert
 *   > keyboard navigation (Tab traps focus inside modal, Esc dismisses).
 *
 * Filename convention — why `.a11y.spec.ts`:
 *   `playwright.config.ts` defines an `accessibility` project with
 *   `testMatch: /.*a11y\.spec\.ts/` (lines 56–60). The default `chromium`
 *   project still runs every spec under `e2e/tests/**`, so this file is
 *   executed by BOTH projects. The naming convention exists so CI can run
 *   `--project=accessibility` to produce a focused WCAG report without
 *   re-running every functional spec (see `playwright.config.ts` header
 *   comment).
 *
 * Test strategy:
 *   1. Reset DB state in `beforeEach` so every test sees a brand-new
 *      participant with `welcome_dismissed_at = null` (which is what causes
 *      the dashboard's `DashboardClient` wrapper to mount `<WelcomeModal />`).
 *   2. Sign in as an eligible user, then call `provision_participant_from_jwt`
 *      from the authenticated browser context — same pattern as
 *      `auth-eligible-new-user.spec.ts` (lines 59–81), required because JWT
 *      injection bypasses the `/auth/callback` Route Handler that normally
 *      invokes the RPC.
 *   3. Navigate to `/dashboard` and assert the dialog is rendered (role +
 *      accessible name from `welcome.title`).
 *   4. Test 1 — run @axe-core/playwright with WCAG 2.1 AA tag set and assert
 *      zero violations. The violation list is serialised into the assertion
 *      message so a failure dump shows the actual rule + node selectors
 *      rather than a bare empty-array diff.
 *   5. Test 2 — keyboard contract:
 *        a. Got it button starts focused (focus-on-mount per WelcomeModal
 *           component).
 *        b. Tab keeps focus on Got it — the dialog currently has only one
 *           focusable descendant, and the document-level keydown trap in
 *           `components/auth/WelcomeModal.tsx` cycles to the first focusable
 *           when the last one is reached.
 *        c. Shift+Tab likewise keeps focus on Got it (backward cycle).
 *        d. Esc dismisses the modal AND persists the dismissal via
 *           `supabase.rpc('dismiss_welcome')`, so `welcome_dismissed_at` must
 *           be non-null on the server side after the keystroke (FR-A3).
 */

import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import { signInAs } from '../fixtures/auth';
import { getParticipantByOid, resetSupabaseState } from '../fixtures/db';

test.beforeEach(async () => {
  await resetSupabaseState();
});

test.describe('welcome modal — NFR-A4 accessibility', () => {
  test('dashboard with welcome modal open passes WCAG 2.1 AA axe-core audit', async ({
    page,
  }) => {
    // Step 1: provision a fresh eligible participant. JWT injection skips the
    // `/auth/callback` Route Handler that production code uses to invoke
    // `provision_participant_from_jwt`, so the test invokes the RPC directly
    // — exact pattern reused from `auth-eligible-new-user.spec.ts`.
    await signInAs(page, { tenant: 'eligible' });

    const provisionResult = await page.evaluate(
      async ({ supabaseUrl, supabaseAnonKey }) => {
        const { createBrowserClient } = await import(
          // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
          'https://esm.sh/@supabase/ssr@0.10.3'
        );
        const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
        // Force the new client to hydrate the persisted session from cookies
        // before issuing the RPC — `createBrowserClient` returns synchronously
        // but auth state hydrates asynchronously, and an un-hydrated RPC call
        // is anonymous and would fail RLS.
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

    // Step 2: land on the dashboard with the welcome modal mounted — a new
    // participant has `welcome_dismissed_at = null`, which is the condition
    // the `DashboardClient` wrapper uses to render `<WelcomeModal />`.
    await page.goto('/dashboard');
    await expect(
      page.getByRole('dialog', { name: 'Welcome to World Cup Madness' }),
    ).toBeVisible();

    // Step 3: scan the page (including the open dialog) against WCAG 2.1 AA.
    // The four tags cover both WCAG 2.0 and 2.1 success criteria at A and AA;
    // NFR-A4 explicitly targets WCAG 2.1 AA but including 2.0 catches the
    // shared foundation rules (contrast, name-role-value, etc).
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    // Serialise the violation list into the assertion message so a failed
    // CI run prints the actual rule IDs and offending node selectors rather
    // than an opaque `[] !== [...]` diff that hides which rule fired.
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('welcome modal traps focus on Got it and Esc dismisses + persists', async ({ page }) => {
    // Same provisioning flow as the audit test — keeping it inline (rather
    // than hoisted into a fixture) preserves the 1:1 mapping with
    // `auth-eligible-new-user.spec.ts` and keeps each spec readable on its
    // own without jumping through fixture chains.
    const { oid } = await signInAs(page, { tenant: 'eligible' });

    const provisionResult = await page.evaluate(
      async ({ supabaseUrl, supabaseAnonKey }) => {
        const { createBrowserClient } = await import(
          // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
          'https://esm.sh/@supabase/ssr@0.10.3'
        );
        const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
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

    await page.goto('/dashboard');
    const dialog = page.getByRole('dialog', { name: 'Welcome to World Cup Madness' });
    await expect(dialog).toBeVisible();

    const gotIt = page.getByRole('button', { name: 'Got it' });

    // Focus-on-mount: WelcomeModal calls `.focus()` on the Got it button in
    // its mount effect. This is the entry condition for the focus trap —
    // if mount-time focus is lost, screen readers won't land inside the
    // dialog when it opens (NFR-A4 announce-on-open contract).
    await expect(gotIt).toBeFocused();

    // Forward Tab cycle: the dialog currently has exactly one focusable
    // descendant (the Got it button). The document-level keydown listener
    // in `WelcomeModal.tsx` queries focusable descendants and re-targets
    // focus to the first one when reaching the end — so a forward Tab on
    // the only focusable element must leave focus on that same element
    // (NOT escape to the URL bar or the page body behind the dialog).
    await page.keyboard.press('Tab');
    await expect(gotIt).toBeFocused();

    // Backward Shift+Tab cycle: symmetric to the forward case — must stay
    // on Got it rather than escaping the dialog backwards.
    await page.keyboard.press('Shift+Tab');
    await expect(gotIt).toBeFocused();

    // Esc dismisses: the WelcomeModal keydown listener handles Esc by
    // calling `supabase.rpc('dismiss_welcome')` AND closing locally. We
    // assert both halves of that contract — the visual dismissal and the
    // server-side persistence (FR-A3: dismissal must persist cross-device).
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Welcome to World Cup Madness' })).toHaveCount(
      0,
    );

    // Re-read the participant row via the service role (bypasses RLS) and
    // assert the RPC actually wrote `welcome_dismissed_at`. Without this
    // check the test would pass even if the keydown handler only updated
    // local component state — which would silently break cross-device
    // dismissal persistence.
    const participant = await getParticipantByOid(oid);
    expect(participant, `participant row for oid=${oid} must exist`).not.toBeNull();
    const row = participant as NonNullable<typeof participant>;
    expect(
      row.welcome_dismissed_at,
      'Esc keystroke must persist welcome_dismissed_at via dismiss_welcome RPC',
    ).not.toBeNull();
  });
});
