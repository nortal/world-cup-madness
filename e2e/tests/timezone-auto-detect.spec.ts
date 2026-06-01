/**
 * Playwright E2E test — TC-M7 (timezone auto-detect on first dashboard mount)
 * for US-MB / feature 002 match-catalog.
 *
 * Spec source (paraphrasing TC-M7 from the task brief):
 *   > Given a participant who has just been provisioned (timezone column at the
 *   > default 'UTC'), when their dashboard mounts for the first time, then a
 *   > Client Component (<TimezoneAutoDetect/>) detects the browser timezone via
 *   > `Intl.DateTimeFormat().resolvedOptions().timeZone` and calls the
 *   > `set_timezone` RPC; the participants row's `timezone` column reflects the
 *   > detected value (or the timezone supplied by Playwright's
 *   > `browser.newContext({ locale, timezoneId })` option). A second mount is a
 *   > no-op (the RPC's `WHERE timezone='UTC'` guard short-circuits).
 *
 * Requirement chain:
 *   - FR-M14 (timezone capture): the dashboard must capture the participant's
 *     browser-resolved IANA timezone on first mount and persist it server-side
 *     so subsequent kickoff renders can localize without re-querying the
 *     browser. The persistence path is `set_timezone(text)` (migration 0015) —
 *     a one-shot RPC whose `UPDATE ... WHERE timezone = 'UTC'` filter makes the
 *     write idempotent: the second call from the same participant matches zero
 *     rows and the trigger does not fire.
 *   - FR-M16 (audit trail for participant mutations): timezone changes are
 *     captured by the generic `audit_participants_changes` trigger introduced
 *     in feature 001 migration 0005 — we explicitly do NOT add a per-column
 *     audit emission inside `set_timezone()` because the trigger already
 *     observes the UPDATE and writes a `participant.updated` row with
 *     `old_value.timezone` and `new_value.timezone` populated automatically.
 *     The test verifies BOTH that the audit row appears after the first mount
 *     AND that the second mount adds no further audit rows (proof the
 *     short-circuit is firing at the RPC layer, not just at the application
 *     layer).
 *
 * Why `browser.newContext({ locale, timezoneId })`:
 *   Playwright's `timezoneId` option overrides `process.timezone` for the
 *   spawned Chromium process AND patches the renderer's `Intl` so that
 *   `Intl.DateTimeFormat().resolvedOptions().timeZone` returns the chosen IANA
 *   tag. Without it, the test would resolve whatever the CI host's TZ happens
 *   to be (typically `UTC` in GitHub Actions, which would defeat the test
 *   entirely — `set_timezone('UTC')` is short-circuited by the same WHERE
 *   filter we are exercising). Pinning to `'Europe/Tallinn'` gives us a
 *   deterministic non-UTC value across every environment (local, CI, container)
 *   without relying on host configuration. The same pattern is used by
 *   `i18n-locale-detection.spec.ts` for `Accept-Language` determinism.
 *
 * Reference patterns reused from:
 *   - `e2e/tests/auth-eligible-new-user.spec.ts` — sign-in + JWT-injection
 *     provisioning via CDN `@supabase/ssr@0.10.3`.
 *   - `e2e/tests/welcome-modal-cross-device.spec.ts` — `provisionParticipantFromPage`
 *     helper (copied inline here; promote to `e2e/fixtures/rpc.ts` if a sixth
 *     spec adopts it).
 *   - `e2e/tests/i18n-locale-detection.spec.ts` — per-test
 *     `browser.newContext({ locale, ... })` plus context.close() in `finally`.
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

/**
 * Invoke `provision_participant_from_jwt()` from the authenticated browser
 * context using `@supabase/ssr`'s cookie-aware client (the same SDK the app
 * uses in Server Components). Hydrates the session from cookies before the
 * RPC fires so we don't race ahead unauthenticated.
 *
 * Duplicated from `auth-eligible-new-user.spec.ts` /
 * `welcome-modal-cross-device.spec.ts` for self-containedness — promote to
 * `e2e/fixtures/rpc.ts` if a sixth spec adopts it.
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

test.describe('US-MB / TC-M7 — TimezoneAutoDetect fires set_timezone on first dashboard mount', () => {
  test.beforeEach(async () => {
    // Clear participants + audit_log so the synthetic oid we mint below is
    // unambiguously the only actor in the audit trail. Teams / matches are
    // preserved by `resetSupabaseState` (it only touches mutation tables) —
    // the dashboard rendering match data is incidental to TC-M7 and we don't
    // need to assert on it.
    await resetSupabaseState();
  });

  test('TC-M7: first dashboard mount auto-detects browser timezone and persists via set_timezone RPC', async ({
    browser,
  }) => {
    // -------------------------------------------------------------------------
    // Step 1: open a fresh browser context with a deterministic, non-UTC
    // timezone so `Intl.DateTimeFormat().resolvedOptions().timeZone` returns
    // 'Europe/Tallinn' inside the renderer regardless of host environment.
    // -------------------------------------------------------------------------
    const context = await browser.newContext({
      locale: 'en-US',
      timezoneId: 'Europe/Tallinn',
    });
    const page = await context.newPage();

    try {
      // -----------------------------------------------------------------------
      // Step 2: sign in as a brand-new eligible user and provision the
      // participant row via the production RPC. After this call the row
      // exists with `timezone = 'UTC'` (column default) — that default is
      // what arms the one-shot `WHERE timezone = 'UTC'` guard inside
      // `set_timezone()`.
      // -----------------------------------------------------------------------
      const { oid } = await signInAs(page, { tenant: 'eligible' });

      const provisionResult = await provisionParticipantFromPage(page);
      expect(
        provisionResult.ok,
        provisionResult.ok ? undefined : provisionResult.error,
      ).toBe(true);

      // -----------------------------------------------------------------------
      // Step 3: confirm the stored timezone is still the default 'UTC'.
      // If the column already held a non-UTC value (e.g. a regression in the
      // provisioning RPC that copied something from the JWT), the
      // TimezoneAutoDetect component would not mount on the dashboard and
      // the rest of the test would pass for the wrong reason.
      // -----------------------------------------------------------------------
      const serviceClient = getServiceRoleClient();
      const seededRead = await serviceClient
        .from('participants')
        .select('timezone')
        .eq('oid', oid)
        .single();
      expect(
        seededRead.error,
        seededRead.error ? seededRead.error.message : undefined,
      ).toBeNull();
      expect(
        seededRead.data?.timezone,
        "freshly-provisioned participant must have timezone = 'UTC' (column default; arms the set_timezone one-shot guard)",
      ).toBe('UTC');

      // -----------------------------------------------------------------------
      // Step 4: navigate to the dashboard — the Server Component sees
      // `participant.timezone === 'UTC'` and mounts <TimezoneAutoDetect/>,
      // whose lone useEffect resolves the browser TZ and fires set_timezone.
      // -----------------------------------------------------------------------
      const navResponse = await page.goto('/dashboard');
      // A 200 (no redirect to '/') confirms the participant is authenticated
      // and the dashboard route accepted the request — otherwise the
      // auto-detect would never mount and the poll below would time out for
      // an unrelated reason.
      expect(navResponse?.status(), 'GET /dashboard must respond 200 (no redirect)').toBe(200);
      await expect(page).toHaveURL(/\/dashboard$/);

      // Poll the DB for the persisted timezone instead of waiting on a UI
      // selector — TimezoneAutoDetect is a renderless Client Component, so
      // there's no DOM signal that the RPC completed; the only observable
      // effect is the column flipping from 'UTC' to the detected IANA tag.
      // 3 seconds is generous: the RPC is a single UPDATE against a one-row
      // filter; in practice it returns in well under 100ms on the local
      // Supabase stack.
      await expect
        .poll(
          async () => {
            const { data } = await serviceClient
              .from('participants')
              .select('timezone')
              .eq('oid', oid)
              .single();
            return data?.timezone;
          },
          {
            timeout: 3000,
            message:
              "participants.timezone must flip from 'UTC' to 'Europe/Tallinn' once TimezoneAutoDetect's useEffect fires set_timezone",
          },
        )
        .toBe('Europe/Tallinn');

      // -----------------------------------------------------------------------
      // Step 5: verify the audit trail. The
      // `audit_participants_changes` trigger from feature 001 migration 0005
      // observes every UPDATE on participants and emits a `participant.updated`
      // row with the old/new snapshots — we explicitly reuse that mechanism
      // instead of emitting from inside set_timezone() (FR-M16).
      // -----------------------------------------------------------------------
      const auditAfterFirst = await serviceClient
        .from('audit_log')
        .select('action, old_value, new_value')
        .eq('actor_oid', oid)
        .eq('action', 'participant.updated');
      expect(
        auditAfterFirst.error,
        auditAfterFirst.error ? auditAfterFirst.error.message : undefined,
      ).toBeNull();

      const updateRows = auditAfterFirst.data ?? [];
      // PostgREST serializes jsonb as a plain object; narrow to a typed
      // accessor so the property reads below are strict-mode safe.
      const tzTransitionRows = updateRows.filter((row) => {
        const oldVal = row.old_value as Record<string, unknown> | null;
        const newVal = row.new_value as Record<string, unknown> | null;
        return oldVal?.timezone === 'UTC' && newVal?.timezone === 'Europe/Tallinn';
      });
      expect(
        tzTransitionRows.length,
        "audit_log must contain at least one participant.updated row whose snapshot reflects the UTC -> Europe/Tallinn timezone transition (trigger from migration 0005)",
      ).toBeGreaterThanOrEqual(1);

      // Capture the row count so the second-mount assertion below can prove
      // the count is UNCHANGED, not merely "still > 0".
      const updateRowCountAfterFirstMount = updateRows.length;

      // -----------------------------------------------------------------------
      // Step 6: second mount must be a no-op. The set_timezone RPC's
      // `UPDATE ... WHERE timezone = 'UTC'` filter matches zero rows on the
      // second invocation (the column now holds 'Europe/Tallinn'), so the
      // trigger from migration 0005 does not fire and no new audit row is
      // appended. We assert on the audit-row count because it's the only
      // server-observable side effect — the RPC's `{outcome: 'no-op'}` return
      // payload is consumed entirely inside the Client Component.
      // -----------------------------------------------------------------------
      await page.reload();
      await expect(page).toHaveURL(/\/dashboard$/);
      // Give the (suppressed) RPC a chance to round-trip before we read the
      // audit log — a positive assertion that "no new row appeared" is racy
      // without a small settling window. 500ms is comfortably longer than
      // the local-stack RPC latency observed in Step 4.
      await page.waitForTimeout(500);

      const auditAfterSecond = await serviceClient
        .from('audit_log')
        .select('action, old_value, new_value')
        .eq('actor_oid', oid)
        .eq('action', 'participant.updated');
      expect(
        auditAfterSecond.error,
        auditAfterSecond.error ? auditAfterSecond.error.message : undefined,
      ).toBeNull();
      expect(
        (auditAfterSecond.data ?? []).length,
        "second dashboard mount must not append a new participant.updated audit row — proves set_timezone short-circuits via WHERE timezone='UTC' and the trigger never fires",
      ).toBe(updateRowCountAfterFirstMount);

      // Belt-and-braces: confirm the column itself did not regress. A
      // regression that re-issued the UPDATE without the WHERE filter would
      // re-write the same value, leaving the column unchanged AND adding an
      // audit row (which Step 6's count assertion would also catch) — this
      // assertion guards against the inverse: a regression that flips the
      // column back to 'UTC' between mounts.
      const finalRead = await serviceClient
        .from('participants')
        .select('timezone')
        .eq('oid', oid)
        .single();
      expect(finalRead.data?.timezone, 'participants.timezone must remain Europe/Tallinn after second mount').toBe(
        'Europe/Tallinn',
      );
    } finally {
      // Always release the context — leaking contexts compounds browser
      // process pressure across the serially-run suite even though
      // `playwright.config.ts` sets `workers: 1`.
      await context.close();
    }
  });
});
