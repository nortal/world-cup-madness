/**
 * Playwright E2E test — TC-4 (display name editability) for US6 / FR-A6.
 *
 * Spec source: `specs/001-authentication-and-participant/spec.md` (TC-4)
 *   > Display name editability — Given an active participant, when they edit
 *   > their `display_name` from their profile page and save, then the change
 *   > is persisted, an audit entry is written (`action='participant.updated'`,
 *   > old + new values), and the new name appears on the leaderboard.
 *
 * Scope (per T065): assert the end-to-end edit flow — DB row updated, audit
 * row written with old/new value, and the next server-rendered surface picks
 * up the change.
 *
 * The "appears on the leaderboard" half of TC-4 is intentionally OUT-OF-SCOPE
 * for US6: the leaderboard is a future feature and no leaderboard surface
 * exists yet in this codebase. Per the T065 task narrowing, the leaderboard
 * assertion is substituted by an equivalent observable: the dashboard
 * greeting (`Welcome, {name}` from `lib/i18n/messages/en.json`) — rendered
 * by `app/(participant)/dashboard/page.tsx` from a fresh server-side read
 * of `participants.display_name` per request. If the greeting reflects the
 * edited name on the next navigation, both the DB persistence and the
 * server-rendered surface are proven in one assertion.
 *
 * Test strategy:
 *   1. `resetSupabaseState()` clears participants and audit_log so the
 *      synthetic oid we are about to inject starts with no prior rows
 *      (otherwise an old `participant.updated` row could falsely satisfy
 *      the audit assertion).
 *   2. Sign in as a new eligible participant via
 *      `signInAs({ tenant: 'eligible', name: 'Original Name' })`. The `name`
 *      option controls `displayName` (verified against
 *      `e2e/fixtures/auth.ts` line 95 — `options.name ?? \`Test User ...\``).
 *      Passing an explicit name lets the audit-row assertion compare against
 *      a known `old_value.display_name`.
 *   3. Invoke `provision_participant_from_jwt()` from the authenticated page
 *      context (same CDN `@supabase/ssr@0.10.3` pattern as
 *      `auth-eligible-new-user.spec.ts` lines 59–81). Production calls this
 *      from `/auth/callback`; the JWT-injection fixture skips that handler,
 *      so the test invokes the RPC explicitly to materialize the row.
 *   4. Verify the baseline `participants.display_name` via
 *      `getParticipantByOid(oid)`. Asserting baseline state explicitly
 *      protects against a confusing test failure mode where the row never
 *      had the original name to begin with.
 *   5. Navigate to `/profile`. Confirm the page rendered the heading,
 *      the form, and that the input is seeded with the baseline name —
 *      this is the contract `DisplayNameForm` declares via
 *      `initialValue={participant.display_name}`.
 *   6. Edit + submit. Playwright's `.fill()` clears + types in one call, so
 *      the input ends up holding exactly the new value with no stray
 *      whitespace. Wait for the `role="status"` success banner to appear —
 *      that's the form's contract that the RPC succeeded (see
 *      `components/profile/DisplayNameForm.tsx` line ~227).
 *   7. DB assertions: re-read participant and assert `display_name`
 *      advanced; read audit_log filtered to `action='participant.updated'`
 *      and `actor_oid=oid` and assert at least one row carries
 *      `old_value.display_name='Original Name'` /
 *      `new_value.display_name='Edited Name'`. The AFTER UPDATE trigger
 *      (migration 0005) writes the full OLD/NEW row JSONB, so the payload
 *      includes many fields — the test only asserts on the field under
 *      change, which is the load-bearing claim of TC-4.
 *   8. Dashboard greeting reflects the new name. Navigating to `/dashboard`
 *      triggers a fresh server render; the Server Component fetches the
 *      participant row on every request, so the greeting must show
 *      "Welcome, Edited Name". This proves the change persisted across the
 *      RPC + DB + server-render boundary (the substitute observable for
 *      the leaderboard claim in TC-4).
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import {
  getAuditLog,
  getParticipantByOid,
  resetSupabaseState,
} from '../fixtures/db';

test.beforeEach(async () => {
  await resetSupabaseState();
});

test('TC-4: editing display_name persists, writes an audit row, and updates the dashboard greeting', async ({
  page,
}) => {
  // ---------------------------------------------------------------------------
  // Phase A — seed an active participant with a known baseline display name.
  // ---------------------------------------------------------------------------
  // A1. Sign in as a brand-new eligible user. Passing `name: 'Original Name'`
  //     pins the baseline `display_name` so the later audit assertion can
  //     compare against an exact `old_value.display_name`. Without this
  //     option the fixture would assign `Test User <prefix>` (auth.ts:95),
  //     which would still work but would force the test to read the
  //     fixture's random value back out before asserting on it.
  const { oid } = await signInAs(page, {
    tenant: 'eligible',
    name: 'Original Name',
  });

  // A2. Materialize the participant row via the production provisioning RPC.
  //     Same CDN `@supabase/ssr` pattern as `auth-eligible-new-user.spec.ts`
  //     — duplicated here intentionally for self-containedness (the other
  //     specs do the same).
  const provisionResult = await page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      // Hydrate the persisted session from cookies before issuing the RPC;
      // otherwise the call can race ahead unauthenticated because
      // `createBrowserClient` returns synchronously but auth state hydrates
      // asynchronously.
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
    provisionResult.ok ? undefined : provisionResult.error,
  ).toBe(true);

  // A3. Confirm baseline state. A failure here would indicate the fixture's
  //     `name` option is not threading through to the JWT / RPC path, which
  //     would invalidate the audit-row assertion below.
  const baseline = await getParticipantByOid(oid);
  expect(
    baseline,
    `baseline participant row for oid=${oid} must exist after provisioning`,
  ).not.toBeNull();
  const baselineRow = baseline as NonNullable<typeof baseline>;
  expect(
    baselineRow.display_name,
    'baseline display_name must match the value passed to signInAs',
  ).toBe('Original Name');

  // ---------------------------------------------------------------------------
  // Phase B — navigate to /profile and confirm the form is wired up.
  // ---------------------------------------------------------------------------
  // B1. The page is a Server Component that gates on auth, so the navigation
  //     itself proves the session cookies survive a cross-origin nav. The
  //     URL assertion catches a silent middleware redirect (e.g. to a sign-in
  //     gate) that would otherwise look like a passing nav but render the
  //     wrong heading.
  await page.goto('/profile');
  await expect(page).toHaveURL(/\/profile$/);

  // B2. Heading + input baseline. The input is the contract surface for
  //     `DisplayNameForm` (`id="display-name"` + `htmlFor="display-name"`),
  //     so `getByLabel('Display name')` matches via the label's `for`
  //     attribute — the most stable selector for this assertion.
  await expect(
    page.getByRole('heading', { level: 1, name: 'Your profile' }),
  ).toBeVisible();
  await expect(page.getByLabel('Display name')).toHaveValue('Original Name');

  // ---------------------------------------------------------------------------
  // Phase C — edit and submit.
  // ---------------------------------------------------------------------------
  // C1. Replace the input value. `.fill()` clears + types in a single call,
  //     so the field ends up holding exactly 'Edited Name' with no leading
  //     whitespace — important because the RPC trims server-side and the
  //     audit `new_value` reflects the trimmed value.
  await page.getByLabel('Display name').fill('Edited Name');

  // C2. Click Save. The button label comes from `profile.saveButton` =
  //     "Save" (verified in `lib/i18n/messages/en.json`). While the RPC is
  //     in flight the label flips to `profile.savingButton`, but
  //     `.click()` resolves synchronously against the rendered "Save" label.
  await page.getByRole('button', { name: 'Save' }).click();

  // C3. Wait for the success banner. The form renders the banner with
  //     `role="status"` and the text from `profile.successToast` =
  //     "Display name updated." — see `DisplayNameForm.tsx` ~line 227.
  //     Asserting on `role="status"` + text is the stable contract; the
  //     CSS classes around the banner are decorative and may drift.
  await expect(page.getByRole('status')).toContainText('Display name updated.');

  // ---------------------------------------------------------------------------
  // Phase D — DB and audit-log assertions.
  // ---------------------------------------------------------------------------
  // D1. The participant row must reflect the edit. Reading via service role
  //     (`getParticipantByOid`) bypasses RLS so the assertion is independent
  //     of whatever the participant themselves can see.
  const afterRow = await getParticipantByOid(oid);
  expect(
    afterRow,
    `participant row for oid=${oid} must still exist after the edit`,
  ).not.toBeNull();
  const after = afterRow as NonNullable<typeof afterRow>;
  expect(after.display_name, 'display_name must be updated to the new value').toBe(
    'Edited Name',
  );

  // D2. The AFTER UPDATE audit trigger (migration 0005) writes the full
  //     OLD/NEW row JSONB on a display_name-only update. `getAuditLog`
  //     filters on `action` + `actor_oid` server-side, so the returned set
  //     is already narrowed to this participant's `participant.updated`
  //     rows. The test then `.find()`s the row whose old/new pair matches
  //     the exact transition under test — guarding against a co-incidental
  //     match from any unrelated update on the same row in a future
  //     iteration of this spec.
  const updateRows = await getAuditLog({
    action: 'participant.updated',
    oid,
  });
  expect(
    updateRows.length,
    "audit_log must contain at least one 'participant.updated' row for the edited oid",
  ).toBeGreaterThanOrEqual(1);

  const editAuditRow = updateRows.find(
    (row) =>
      (row.old_value as { display_name?: string } | null)?.display_name === 'Original Name' &&
      (row.new_value as { display_name?: string } | null)?.display_name === 'Edited Name',
  );
  expect(
    editAuditRow,
    "audit_log must contain a 'participant.updated' row with old_value.display_name='Original Name' and new_value.display_name='Edited Name'",
  ).toBeDefined();
  expect(
    editAuditRow?.actor_oid,
    "updated row's actor_oid must match the editing participant's oid",
  ).toBe(oid);

  // ---------------------------------------------------------------------------
  // Phase E — dashboard greeting reflects the new name (substitute for the
  // leaderboard half of TC-4 — see top-of-file docblock for rationale).
  // ---------------------------------------------------------------------------
  // E1. A fresh navigation to `/dashboard` triggers a server-side render
  //     that reads `participants.display_name` per request. If the greeting
  //     shows the new name, the full RPC -> DB -> server-render chain is
  //     proven on the surface a user actually sees.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Welcome, Edited Name' }),
  ).toBeVisible();
});
