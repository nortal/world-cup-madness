/**
 * Playwright E2E test — TC-11 (privacy notice reachable) for US1 / FR-A10.
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` (TC-11, line ~84)
 *   > Privacy notice reachable — Given an unauthenticated visitor, when they
 *   > click the "Privacy notice" link on the landing page or the "Learn more"
 *   > link in the welcome modal, then they reach the public `/privacy` page
 *   > which describes data collected, purpose, audience, legal basis, and
 *   > retention period. The `/privacy` route MUST be accessible without
 *   > authentication.
 *
 * Scope (per T072): exercise both entry points into `/privacy` and confirm
 * the page surfaces the five content sections mandated by FR-A10. The
 * implementation under test:
 *   - `app/(public)/privacy/page.tsx` — public Server Component (no auth gate).
 *     Renders an `<h1>` plus five `<section>` blocks (each with its own `<h2>`
 *     wired through `aria-labelledby`) and a "Back to sign-in" link.
 *   - `components/auth/PrivacyLink.tsx` — Client Component with two variants:
 *     `footer` (default) renders `privacy.linkLabel` ("Privacy notice");
 *     `inline` renders `privacy.learnMore` ("Learn more").
 *   - `app/(public)/page.tsx` — landing page that mounts `<PrivacyLink />`
 *     (footer variant) in its footer slot.
 *   - `components/auth/WelcomeModal.tsx` — adds a privacy summary paragraph
 *     followed by `<PrivacyLink variant="inline" />` so first-login participants
 *     can reach `/privacy` straight from the modal.
 *
 * Out of scope here:
 *   - Privacy-page accessibility / focus-trap behaviour (no a11y suite is
 *     defined for this page in T072).
 *   - Localization of the privacy page in es / pt-BR — TC-11 anchors on the
 *     English translations only.
 *
 * Test strategy:
 *   1. `resetSupabaseState()` in `beforeEach` so each test starts from a clean
 *      participant table (consistent with every other US1 spec in this dir).
 *   2. Test 1 — unauthenticated landing path:
 *      a. Navigate to `/` with no sign-in.
 *      b. Confirm the landing page actually rendered before clicking, so a
 *         missing link can be distinguished from a missing page.
 *      c. Click the footer "Privacy notice" link via accessible-name lookup
 *         (`getByRole('link', { name: ... })`) so the test survives className
 *         and DOM-structure refactors of PrivacyLink.
 *      d. Assert the URL settles on `/privacy` and all five required section
 *         headings are visible — the exhaustive content check lives here so
 *         Test 2 can stay focused on reachability.
 *   3. Test 2 — authenticated first-login modal path:
 *      a. Sign in as a fresh eligible user and provision via
 *         `provision_participant_from_jwt()` (same CDN `@supabase/ssr` pattern
 *         shared with TC-1 / TC-9 / TC-12) so the dashboard renders with the
 *         welcome modal visible.
 *      b. Scope the "Learn more" link lookup to the dialog so a future
 *         "Learn more" affordance elsewhere on the dashboard would not silently
 *         mask a regression on the modal's link.
 *      c. Assert the URL settles on `/privacy` and at least one required
 *         section heading is visible — Test 1 already covers the full list,
 *         so this test focuses on the modal-to-page reachability claim of
 *         FR-A10.
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import { resetSupabaseState } from '../fixtures/db';

test.beforeEach(async () => {
  await resetSupabaseState();
});

test.describe('TC-11: privacy notice reachable', () => {
  test('unauthenticated visitor clicks Privacy notice on landing and lands on /privacy with all required sections', async ({
    page,
  }) => {
    // Step 1: hit the landing page anonymously. No `signInAs` call — TC-11's
    // headline guarantee is that `/privacy` is reachable WITHOUT an auth
    // session, so the entry point we exercise here must also be anonymous.
    await page.goto('/');

    // Step 2: confirm the landing page actually rendered before clicking on
    // anything. Without this, a misrouted "/" (e.g., a future redirect to a
    // sign-in surface) could surface as a confusing selector-timeout on the
    // privacy link instead of a clear landing-page regression. The h1 text
    // is the literal English value of `landing.headline` from
    // `lib/i18n/messages/en.json`.
    await expect(
      page.getByRole('heading', { level: 1, name: 'World Cup Madness' }),
    ).toBeVisible();

    // Step 3: click the footer privacy link by its accessible name. The
    // visible text is the i18n value of `privacy.linkLabel` ("Privacy notice").
    // Role-based selection is the most stable choice here — PrivacyLink is a
    // small Client Component that may pick up new className / wrapper changes
    // over time without affecting its accessible-name contract.
    await page.getByRole('link', { name: 'Privacy notice' }).click();

    // Step 4: confirm the navigation actually resolved to `/privacy`. The
    // regex anchors on a trailing `/privacy` so a future locale prefix (e.g.,
    // `/en/privacy`) would still pass — the spec calls out `/privacy` as the
    // logical route, not the precise URL grammar.
    await expect(page).toHaveURL(/\/privacy$/);

    // Step 5: assert the page h1 renders. The heading text is the i18n value
    // of `privacy.heading` ("Privacy notice") — identical to the link label,
    // but asserting on it confirms we are looking at the page surface and
    // not a leftover landing-page fragment.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Privacy notice' }),
    ).toBeVisible();

    // Step 6: exhaustively assert the five FR-A10 content sections. Each
    // `<section>` on the page wires `aria-labelledby` to its `<h2>`, so the
    // h2 text is the section's accessible name and the most stable selector.
    // Section texts come from `lib/i18n/messages/en.json` keys:
    //   - dataCollectedHeading -> "Data we collect"
    //   - purposeHeading -> "Why we collect it"
    //   - audienceHeading -> "Who can see your data"
    //   - legalBasisHeading -> "Legal basis"
    //   - retentionHeading -> "How long we keep your data"
    await expect(
      page.getByRole('heading', { level: 2, name: 'Data we collect' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Why we collect it' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Who can see your data' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Legal basis' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'How long we keep your data' }),
    ).toBeVisible();

    // Step 7: the page must offer a way back to sign-in (the only navigation
    // affordance on this anonymous surface). The link text is the i18n value
    // of `privacy.backLabel` ("Back to sign-in"). Absence of this link would
    // strand an unauthenticated visitor on `/privacy`, which is a UX
    // regression the page-level contract guards against.
    await expect(
      page.getByRole('link', { name: 'Back to sign-in' }),
    ).toBeVisible();
  });

  test('first-login participant clicks Learn more in welcome modal and lands on /privacy', async ({
    page,
  }) => {
    // Step 1: sign in as a brand-new eligible user. A first-login participant
    // is the only state under which the welcome modal renders (gated on
    // `participants.welcome_dismissed_at IS NULL`), which is the precondition
    // for the "Learn more" link being on screen at all.
    await signInAs(page, { tenant: 'eligible' });

    // Step 2: provision the participant via the production RPC. Production
    // calls this from `/auth/callback`; JWT injection bypasses that handler,
    // so the test invokes it explicitly to land the participant row with a
    // null `welcome_dismissed_at` (i.e., modal will render on /dashboard).
    // Pattern copied from `auth-eligible-new-user.spec.ts` for self-containedness.
    const provisionResult = await page.evaluate(
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
    expect(
      provisionResult.ok,
      'provision_participant_from_jwt RPC must succeed',
    ).toBe(true);

    // Step 3: navigate to the dashboard and confirm the modal renders. The
    // dialog's accessible name resolves from `aria-labelledby` -> the h2
    // carrying `welcome.title` ("Welcome to World Cup Madness"). Without this
    // visibility check we couldn't tell a "modal failed to render" regression
    // apart from a "Learn more link missing" regression on the click below.
    await page.goto('/dashboard');
    await expect(
      page.getByRole('dialog', { name: 'Welcome to World Cup Madness' }),
    ).toBeVisible();

    // Step 4: click "Learn more" — scoped to the dialog. Scoping defends
    // against future surfaces (e.g., a footer "Learn more about scoring"
    // link on the dashboard) silently masking a regression where the modal's
    // own link disappears. The visible text is the i18n value of
    // `privacy.learnMore`.
    await page.getByRole('dialog').getByRole('link', { name: 'Learn more' }).click();

    // Step 5: confirm the navigation resolved to `/privacy`. Same trailing
    // regex as Test 1 so a future locale prefix would still pass.
    await expect(page).toHaveURL(/\/privacy$/);

    // Step 6: spot-check one of the required section headings so the
    // assertion proves we landed on the real privacy page (and not, say, a
    // 404 surface that happens to share the URL). The exhaustive section
    // list lives in Test 1 — repeating it here would buy nothing for
    // FR-A10's modal-reachability claim.
    await expect(
      page.getByRole('heading', { level: 2, name: 'Data we collect' }),
    ).toBeVisible();
  });
});
