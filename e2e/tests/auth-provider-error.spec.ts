/**
 * Playwright E2E test — TC-10 (recoverable provider failure in OAuth callback)
 * for User Story 3 (T053).
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` (TC-10, line 83)
 *   > Recoverable provider failure — Given Microsoft Entra returns a 5xx
 *   > mid-OAuth (or the callback fails for non-eligibility reasons such as a
 *   > state-cookie mismatch or token-exchange error), when the user attempts
 *   > sign-in, then they are redirected to `/auth-error` (not `/access-denied`),
 *   > an audit entry `action='auth.provider-error'` is written with a `reason`
 *   > category and any known identifying info, and clicking **Retry** restarts
 *   > the OAuth flow without manual data re-entry.
 *
 * Requirement: FR-A9. See also clarification C2 (line 158) for the contract
 * separating `/auth-error` from `/access-denied`, and the `record_auth_failure`
 * RPC contract.
 *
 * Scope (per T053): exercise the two failure branches that
 * `app/auth/callback/route.ts` audits as `action='auth.provider-error'`:
 *
 *   1. `exchangeCodeForSession` failure — drive the route with a code that
 *      Supabase will refuse to exchange. The handler catches the error and
 *      audits with `reason='callback.exchange-failed'`. This is the canonical
 *      TC-10 path (token exchange / state-cookie / Entra 5xx) and the one
 *      tasks.md names directly.
 *   2. Missing `code` query param — drive the route with no `?code=` at all.
 *      The handler audits with `reason='callback.missing-code'`. Covered as a
 *      sibling test because both branches share the same audit + redirect
 *      surface in the route handler, so testing them together protects the
 *      same code path with minimal extra cost.
 *
 * The provisioning RPC and `provision_participant_from_jwt`'s own
 * `outcome: 'error'` (config.missing) branch are NOT exercised here — those are
 * audited inside the RPC itself and covered by other contract tests.
 *
 * Test strategy:
 *   1. `resetSupabaseState()` in `beforeEach` so the per-test audit_log starts
 *      empty (audit row counts can be asserted without contamination).
 *   2. Navigate directly to `/auth/callback[?code=...]`. The handler executes
 *      server-side and emits a `redirect('/auth-error')` response. Playwright
 *      follows the redirect automatically, so `page.goto` resolves with the
 *      final URL — no `waitForURL` needed on the initial navigation.
 *   3. Assert URL ends with `/auth-error` and the English heading renders
 *      (i18n smoke check on `authError.heading`).
 *   4. Service-role read of `audit_log` filtered by
 *      `action='auth.provider-error'`; assert at least one row with the
 *      branch-specific `reason`. We deliberately use the `reason` filter to
 *      keep each sibling test isolated even if some future change to
 *      `resetSupabaseState` left rows behind.
 *   5. Click the Retry CTA (English `authError.retryLabel = "Retry sign-in"`)
 *      and assert the URL settles on `/` (landing page). `waitForURL('/')`
 *      handles the client-side <Link> navigation reliably.
 *
 * Why no `signInAs`: the whole point of this test is to drive the
 * **no-session** OAuth callback path. The user has not completed OAuth, so
 * there is no JWT and no Supabase session — only the route handler's
 * service-role audit write fires.
 */

import { expect, test } from '@playwright/test';

import { getAuditLog, resetSupabaseState } from '../fixtures/db';

test.beforeEach(async () => {
  await resetSupabaseState();
});

test.describe('TC-10 / FR-A9: recoverable provider failure in OAuth callback', () => {
  test('exchange failure: invalid code → /auth-error + audit reason=callback.exchange-failed + Retry returns to /', async ({
    page,
  }) => {
    // Drive the exchange-failure branch. Supabase's PKCE exchange rejects any
    // code that was not issued by its own /authorize endpoint, so an arbitrary
    // string is sufficient to push the handler down the
    // `exchangeCodeForSession returned error` branch in
    // `app/auth/callback/route.ts`. `page.goto` follows the server-side
    // `redirect('/auth-error')` automatically, so a direct URL assertion
    // suffices once it resolves.
    await page.goto('/auth/callback?code=this-code-does-not-exist');

    // Step 1: confirm the route handler redirected to /auth-error and the
    // English-baseline heading is rendered.
    expect(page.url(), 'callback handler must redirect to /auth-error').toMatch(/\/auth-error$/);
    await expect(
      page.getByRole('heading', { level: 1, name: "Sign-in didn't complete" }),
    ).toBeVisible();

    // Step 2: assert the audit row was written via the service-role
    // record_auth_failure RPC. Filter by both action and reason so this
    // sibling test cannot accidentally pick up the missing-code row written by
    // the other test (resetSupabaseState should keep them isolated, but a
    // reason-specific filter is the cheapest defensive guard).
    const auditRows = await getAuditLog({ action: 'auth.provider-error' });
    const exchangeFailures = auditRows.filter((row) => row.reason === 'callback.exchange-failed');
    expect(
      exchangeFailures.length,
      'at least one audit_log row with reason=callback.exchange-failed must exist',
    ).toBeGreaterThanOrEqual(1);

    // Spot-check the row shape: actor_oid / actor_email / attempted_tid are
    // intentionally null because the OAuth exchange failed before we obtained
    // a JWT (FR-A9 / route handler `recordCallbackProviderError`).
    const exchangeRow = exchangeFailures[0];
    expect(exchangeRow.action).toBe('auth.provider-error');
    expect(exchangeRow.actor_oid).toBeNull();
    expect(exchangeRow.actor_email).toBeNull();
    expect(exchangeRow.attempted_tid).toBeNull();
    expect(exchangeRow.reason).toBe('callback.exchange-failed');

    // Step 3: click the Retry CTA and confirm it navigates to the landing
    // page. `getByRole('link', { name })` matches the i18n
    // `authError.retryLabel` ("Retry sign-in"); `waitForURL('/')` handles the
    // client-side <Link> navigation. The Retry CTA in
    // `app/(public)/auth-error/page.tsx` is a Next.js <Link href="/">.
    await page.getByRole('link', { name: 'Retry sign-in' }).click();
    await page.waitForURL('/');
    expect(page.url(), 'Retry CTA must return user to the landing page').toMatch(/\/$/);
  });

  test('missing code: no ?code= param → /auth-error + audit reason=callback.missing-code', async ({
    page,
  }) => {
    // Drive the missing-code branch. The route handler checks
    // `searchParams.get('code') === null` before touching Supabase, so this
    // path never invokes `exchangeCodeForSession`.
    await page.goto('/auth/callback');

    // Step 1: same redirect + heading assertions as the exchange-failure test.
    expect(page.url(), 'callback handler must redirect to /auth-error').toMatch(/\/auth-error$/);
    await expect(
      page.getByRole('heading', { level: 1, name: "Sign-in didn't complete" }),
    ).toBeVisible();

    // Step 2: assert the audit row with reason=callback.missing-code.
    // `.filter()` on `reason` keeps this test isolated from the
    // exchange-failure sibling.
    const auditRows = await getAuditLog({ action: 'auth.provider-error' });
    const missingCodeRows = auditRows.filter((row) => row.reason === 'callback.missing-code');
    expect(
      missingCodeRows.length,
      'at least one audit_log row with reason=callback.missing-code must exist',
    ).toBeGreaterThanOrEqual(1);

    const missingCodeRow = missingCodeRows[0];
    expect(missingCodeRow.action).toBe('auth.provider-error');
    expect(missingCodeRow.actor_oid).toBeNull();
    expect(missingCodeRow.actor_email).toBeNull();
    expect(missingCodeRow.attempted_tid).toBeNull();
    expect(missingCodeRow.reason).toBe('callback.missing-code');
  });
});
