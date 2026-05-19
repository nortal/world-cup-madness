/**
 * Playwright E2E test — TC-12 (welcome-dismissed persists cross-device) for
 * US1 / FR-A3 / NFR-A4.
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` (TC-12)
 *   > Welcome dismissed persists cross-device — Given a participant who
 *   > dismissed the welcome modal on device A (setting `welcome_dismissed_at`),
 *   > when the same participant signs in on device B, then the welcome modal
 *   > does NOT reappear on device B's dashboard. Clearing browser cookies or
 *   > using incognito does NOT cause the modal to re-trigger.
 *
 * Scope (per T060): assert that welcome-modal dismissal is a server-side,
 * per-participant fact (persisted via `participants.welcome_dismissed_at`)
 * rather than a per-browser fact (cookie / localStorage). The implementation
 * under test:
 *   - `components/auth/WelcomeModal.tsx` — Client Component rendered with
 *     role="dialog", aria-modal="true", aria-labelledby="welcome-modal-title".
 *     Its "Got it" button invokes `supabase.rpc('dismiss_welcome')`, which
 *     UPDATEs `participants.welcome_dismissed_at = now()`.
 *   - `components/auth/DashboardClient.tsx` — receives `isFirstLogin: boolean`
 *     and conditionally mounts `<WelcomeModal />`.
 *   - `app/(participant)/dashboard/page.tsx` — passes
 *     `participant.welcome_dismissed_at === null` as `isFirstLogin`, so a
 *     non-null timestamp on the participant row deterministically suppresses
 *     the modal on every subsequent dashboard render, regardless of browser
 *     context (FR-A3, NFR-A4).
 *
 * Out of scope here:
 *   - Modal accessibility / focus-trap behaviour — covered by T061
 *     (`welcome-modal.a11y.spec.ts`).
 *   - First-time provisioning side-effects unrelated to the welcome modal
 *     (display_name, role, etc.) — covered by TC-1 / T042.
 *
 * Test strategy (mirrors the two-phase pattern from
 * `auth-role-downgrade.spec.ts`: sign in once, mutate state, observe from a
 * fresh session whether the mutation persists):
 *   1. `resetSupabaseState()` so no participant row exists for the synthetic
 *      `oid` we are about to inject.
 *   2. Phase A (device A):
 *      a. Sign in as a fresh eligible user; capture `oid`, `email`, `displayName`.
 *      b. Invoke `provision_participant_from_jwt()` from the page (CDN
 *         `@supabase/ssr@0.10.3` pattern shared with TC-1 / TC-9).
 *      c. Sanity-check `welcome_dismissed_at IS NULL` on the freshly-provisioned
 *         row — otherwise the modal would not render and the rest of the test
 *         would pass for the wrong reason.
 *      d. Navigate to `/dashboard` and assert the welcome modal is visible.
 *         Use `getByRole('dialog', { name: 'Welcome to World Cup Madness' })`
 *         — Playwright resolves the dialog's accessible name from
 *         `aria-labelledby` (the h2 carrying `welcome.title` from
 *         `lib/i18n/messages/en.json`).
 *      e. Click "Got it" — the literal English value of `welcome.gotIt`. The
 *         button handler fires `dismiss_welcome()` which writes the timestamp.
 *      f. Wait for the dialog to disappear, then verify the DB write via
 *         `getParticipantByOid(oid)` — `welcome_dismissed_at` must now be a
 *         non-null ISO timestamp string (PostgREST serializes
 *         `timestamptz` as an ISO-8601 string).
 *   3. Phase B (device B — fresh browser context):
 *      a. Open a brand-new `BrowserContext` so cookies / storage / cache are
 *         pristine — this models "signing in on a different device" (or
 *         equivalently, incognito on the same device, which TC-12 explicitly
 *         calls out as not allowed to re-trigger the modal).
 *      b. Re-sign-in as the same user (same `oid` / `email` / `name`) so the
 *         existing participant row is matched on `oid`.
 *      c. Invoke `provision_participant_from_jwt()` again — it is idempotent
 *         and returns success without re-inserting (migration 0006). It
 *         crucially does NOT clear `welcome_dismissed_at`.
 *      d. Navigate device B to `/dashboard` and assert NO dialog renders. A
 *         supporting assertion on the greeting heading confirms the dashboard
 *         fully loaded (so an absent dialog is the intended state, not a
 *         render failure that incidentally has no dialog).
 *      e. Close the device-B context to release the browser resources.
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import { getParticipantByOid, resetSupabaseState } from '../fixtures/db';

/**
 * Invoke `provision_participant_from_jwt()` from the authenticated browser
 * context using `@supabase/ssr`'s cookie-aware client (the same SDK the app
 * uses in Server Components). Hydrates the session from cookies before the
 * RPC fires so we don't race ahead unauthenticated.
 *
 * Duplicated from `auth-eligible-new-user.spec.ts` /
 * `auth-role-downgrade.spec.ts` for self-containedness — promote to
 * `e2e/fixtures/rpc.ts` if a fifth spec adopts it.
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

test('TC-12: welcome modal dismissal persists across a fresh browser context', async ({
  page,
  browser,
}) => {
  // ---------------------------------------------------------------------------
  // Phase A — device A: first sign-in, dismiss the modal, verify DB write.
  // ---------------------------------------------------------------------------
  // A1. Sign in as a brand-new eligible user. `signInAs` returns the synthetic
  //     identity claims we'll re-use on device B so both phases anchor to the
  //     same `oid` (participant rows are keyed by oid; matching by oid is
  //     what makes this a same-user-across-devices scenario rather than two
  //     unrelated users).
  const { oid, email, displayName } = await signInAs(page, { tenant: 'eligible' });

  // A2. Materialize the participant row via the production RPC. After this
  //     call the row exists with `welcome_dismissed_at = NULL` (the column
  //     default), which is what makes the welcome modal render below.
  const seedProvision = await provisionParticipantFromPage(page);
  expect(
    seedProvision.ok,
    seedProvision.ok ? undefined : seedProvision.error,
  ).toBe(true);

  // A3. Sanity-check the precondition. If `welcome_dismissed_at` were already
  //     populated, the dashboard would suppress the modal and the subsequent
  //     "click Got it" step would have nothing to click — the test would fail
  //     with a misleading selector-timeout instead of a clear precondition
  //     violation.
  const seededRow = await getParticipantByOid(oid);
  expect(
    seededRow,
    `participant row for oid=${oid} must exist after first provisioning`,
  ).not.toBeNull();
  const baseline = seededRow as NonNullable<typeof seededRow>;
  expect(
    baseline.welcome_dismissed_at,
    'welcome_dismissed_at must be NULL on a freshly-provisioned participant (precondition for modal render)',
  ).toBeNull();

  // A4. Land on the dashboard and observe the modal. Using `getByRole('dialog',
  //     { name: ... })` selects on the accessible name resolved from the
  //     dialog's `aria-labelledby` -> #welcome-modal-title, which in turn
  //     renders the i18n value of `welcome.title` from
  //     `lib/i18n/messages/en.json` ("Welcome to World Cup Madness"). This is
  //     the most stable selector for the assertion — it survives className
  //     and DOM-structure refactors of WelcomeModal.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole('dialog', { name: 'Welcome to World Cup Madness' }),
    'welcome modal must be visible for a first-login participant (welcome_dismissed_at IS NULL)',
  ).toBeVisible();

  // A5. Click "Got it". The button text is the i18n value of `welcome.gotIt`
  //     ("Got it"). The click handler invokes `supabase.rpc('dismiss_welcome')`,
  //     which UPDATEs `participants.welcome_dismissed_at = now()` server-side
  //     — this is the durable state mutation under test.
  await page.getByRole('button', { name: 'Got it' }).click();

  // A6. Wait for the dialog to disappear so we don't race ahead to the DB
  //     read before the RPC has resolved. `toHaveCount(0)` is preferred over
  //     `not.toBeVisible()` here because the modal's dismissal removes it
  //     from the DOM entirely (DashboardClient gates the mount on a state
  //     flag) — `toHaveCount(0)` makes that expectation explicit and avoids
  //     ambiguity between "hidden" and "unmounted".
  await expect(
    page.getByRole('dialog'),
    'welcome modal must disappear after "Got it" click',
  ).toHaveCount(0);

  // A7. Verify the DB-side write. PostgREST serializes `timestamptz` as an
  //     ISO-8601 string; asserting non-null is enough here — the exact value
  //     ("close to now()") is an implementation detail of the RPC and not
  //     load-bearing for TC-12's cross-device claim.
  const dismissedRow = await getParticipantByOid(oid);
  expect(
    dismissedRow,
    `participant row for oid=${oid} must still exist after dismissal`,
  ).not.toBeNull();
  const dismissed = dismissedRow as NonNullable<typeof dismissedRow>;
  expect(
    dismissed.welcome_dismissed_at,
    'welcome_dismissed_at must be a non-null timestamp after the "Got it" click (dismiss_welcome RPC ran)',
  ).not.toBeNull();

  // ---------------------------------------------------------------------------
  // Phase B — device B: fresh browser context, same user, no modal.
  // ---------------------------------------------------------------------------
  // B1. A new `BrowserContext` has its own cookie jar, localStorage, and
  //     cache — i.e. it models a different device (or an incognito window on
  //     the same device, which TC-12 explicitly forbids from re-triggering
  //     the modal). Note: a `clearCookies()` on `page.context()` would NOT
  //     be equivalent here, because it would leave us testing the same
  //     browser context whose state we just mutated; a fresh context is the
  //     stricter and intended interpretation of "device B".
  const deviceB = await browser.newContext();
  const pageB = await deviceB.newPage();

  try {
    // B2. Re-sign-in as the SAME user. Passing the same `oid` / `email` /
    //     `name` is what makes device B see the existing participant row
    //     (matched on oid) rather than provisioning a brand-new one — which
    //     would, of course, have its own NULL `welcome_dismissed_at` and
    //     re-trigger the modal, defeating the test.
    const deviceBSession = await signInAs(pageB, {
      tenant: 'eligible',
      oid,
      email,
      name: displayName,
    });
    expect(deviceBSession.oid).toBe(oid);
    expect(deviceBSession.email).toBe(email);

    // B3. Invoke the provisioning RPC under the fresh session. It is
    //     idempotent (migration 0006): the existing-row branch updates
    //     `last_login_at` and identity columns but leaves
    //     `welcome_dismissed_at` untouched, so the persistence guarantee
    //     under test is preserved across this call.
    const deviceBProvision = await provisionParticipantFromPage(pageB);
    expect(
      deviceBProvision.ok,
      deviceBProvision.ok ? undefined : deviceBProvision.error,
    ).toBe(true);

    // B4. Navigate device B to the dashboard. The Server Component reads
    //     `participants.welcome_dismissed_at` and passes
    //     `isFirstLogin = (welcome_dismissed_at === null)` to DashboardClient
    //     — with a non-null timestamp from Phase A, the WelcomeModal is not
    //     mounted at all.
    await pageB.goto('/dashboard');
    await expect(pageB).toHaveURL(/\/dashboard$/);

    // B5. Key assertion: no dialog renders on device B. `toHaveCount(0)` is
    //     a strict zero-element assertion against the role selector — any
    //     leak (e.g., a regression that re-triggers the modal whenever
    //     cookies are absent) would surface here.
    await expect(
      pageB.getByRole('dialog'),
      'welcome modal must NOT render on a fresh browser context for a participant whose welcome_dismissed_at is already set',
    ).toHaveCount(0);

    // B6. Supporting assertion: the greeting still renders. Without this we
    //     could not distinguish "modal correctly suppressed" from "dashboard
    //     failed to render anything" — both states satisfy a naive
    //     `toHaveCount(0)` on `role=dialog`.
    await expect(
      pageB.getByRole('heading', { level: 1, name: `Welcome, ${displayName}` }),
      'dashboard greeting must render on device B (so the absence of the modal is meaningful)',
    ).toBeVisible();
  } finally {
    // B7. Release the device-B context regardless of assertion outcomes —
    //     leaking contexts across tests would compound into test-runner
    //     resource pressure under parallel execution.
    await deviceB.close();
  }
});
