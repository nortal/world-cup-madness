/**
 * Playwright E2E test — TC-M8 (timezone-picker profile override) for
 * US-MB, feature 002 (match-catalog), task T048.
 *
 * Spec source: `specs/002-match-catalog/spec.md` — User Story MB / TC-M8:
 *
 *   > Given a participant on /profile, when they select a different IANA
 *   > timezone from the picker and save, then `participants.timezone`
 *   > updates, the audit_log has a `participant.updated` row with old +
 *   > new value, and the dashboard reflects the new TZ on next load.
 *
 * Wires together:
 *   - FR-M15 — Profile-side TimezonePicker surface (manual override of the
 *     auto-detected `participants.timezone` set by `TimezoneAutoDetect` on
 *     first dashboard mount per FR-M14).
 *   - FR-M16 — Downstream render surfaces (dashboard widget, matches
 *     catalog, match detail) MUST pick up the new TZ on the next
 *     server-rendered navigation, with no client cache to invalidate.
 *   - `components/profile/TimezonePicker.tsx` (T045) — the hand-rolled
 *     WAI-ARIA combobox under test. Filter input + listbox + Save button.
 *     On Save it calls the `update_timezone(p_timezone text)` RPC; success
 *     surfaces as a `role="status"` toast (the
 *     `profile.timezoneSuccessToast` key = "Timezone updated."), errors
 *     surface as a `role="alert"` banner.
 *   - `app/(participant)/profile/page.tsx` (T046) — Server Component that
 *     mounts `<TimezonePicker initialValue={participant.timezone}/>` below
 *     the existing `<DisplayNameForm/>` and (because it's a Server
 *     Component) re-fetches `participants.timezone` on every navigation;
 *     this is exactly what makes the "next load" half of TC-M8 observable
 *     without any client-side cache busting.
 *   - `supabase/migrations/0015_match_rpcs.sql` — `update_timezone(text)`
 *     RPC contract: trims server-side, enforces non-empty + ≤ 64 chars +
 *     no whitespace; raises `check_violation` on validation failures and
 *     `no_data_found` when the caller has no active participant row.
 *   - `supabase/migrations/0005_audit_triggers.sql` — the
 *     `audit_participants_changes()` AFTER UPDATE trigger from feature 001
 *     ALREADY catches every UPDATE on `participants` via its catch-all
 *     `OLD IS DISTINCT FROM NEW` branch, which means feature 002 inherits
 *     the timezone-change audit row for free. This test is the live proof
 *     of that inheritance: the trigger was never re-touched for feature
 *     002, but it must still emit `participant.updated` with old + new
 *     `timezone` values when the `update_timezone` RPC commits.
 *
 * Structural sibling: `e2e/tests/profile-edit-display-name.spec.ts` (TC-4).
 * That spec is the closest analogue — same family of assertions (form
 * edit → DB column updated → audit_log row with old/new → downstream
 * server-rendered surface reflects the change). The shape of this spec
 * deliberately mirrors it so a future reader can diff the two and see
 * that the only differences are (a) which field is edited, (b) which
 * downstream surface proves the change reached a render, and (c) the
 * seeded baseline (display_name comes from the JWT via `signInAs`;
 * timezone has to be seeded server-side because the production default
 * for a freshly-provisioned row is `'UTC'`, which would make a "change
 * the TZ" test indistinguishable from "auto-detect populated UTC").
 *
 * Test strategy:
 *   1. `resetSupabaseState()` clears participants + audit_log so the
 *      assertions below see only the rows this test produces.
 *   2. Sign in as a brand-new eligible user and invoke
 *      `provision_participant_from_jwt()` from the browser context (same
 *      `@supabase/ssr@0.10.3` CDN pattern used by every other auth-bearing
 *      spec in this folder).
 *   3. Seed an initial timezone server-side: directly UPDATE
 *      `participants.timezone = 'Europe/Tallinn'` via the service-role
 *      client. The audit trigger fires on that UPDATE too, so we then
 *      clear `audit_log` for this `actor_oid` to keep the TC-M8
 *      assertions narrowed to the user-driven change. Europe/Tallinn is
 *      chosen because it is comfortably distinct from the
 *      America/Sao_Paulo target (UTC+3 vs UTC-3 in summer), so the
 *      downstream-render assertion has a wide separation between the
 *      "before" and "after" wall-clock times.
 *   4. Seed one match for the dashboard widget to render — provider_id
 *      9701 (well outside the 760..800 migration-seed range, the 9101..9505
 *      ranges already in use by other specs, and the live football-data
 *      ID space), `status='scheduled'`, kickoff `now + 1 day at 23:00 UTC`.
 *      That kickoff straddles the day boundary in different TZs (it lands
 *      at 02:00 the NEXT day in Tallinn summer time and 20:00 the SAME
 *      day in São Paulo), so the rendered wall-clock substring is
 *      unambiguously TZ-distinct.
 *   5. Navigate to /profile, drive the combobox to pick `America/Sao_Paulo`,
 *      click Save, and wait for the success toast.
 *   6. Assert DB persistence (`participants.timezone === 'America/Sao_Paulo'`)
 *      and the audit_log row (`action='participant.updated'`, `old_value
 *      .timezone === 'Europe/Tallinn'`, `new_value.timezone ===
 *      'America/Sao_Paulo'`).
 *   7. Navigate to /dashboard and assert the seeded match's kickoff
 *      renders in São Paulo time. Assertion choice — see the comment in
 *      Phase E below: we look for the literal substring "8:00 PM" inside
 *      the upcoming-matches widget. Rationale: `formatKickoff` (used by
 *      `<MatchCard>` inside `<UpcomingMatchesWidget>`) uses
 *      `Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle:
 *      'short' })`, which for the default `en` locale produces a
 *      12-hour clock. T+23:00 UTC renders as "8:00 PM" in São Paulo and
 *      "2:00 AM" the next day in Tallinn — the two strings cannot both
 *      appear in the same widget for the same row, so the substring
 *      check is both sufficient (proves the TZ shift took effect) and
 *      necessary (the Tallinn render cannot accidentally contain it).
 *
 * Compared to TC-4 (display-name edit):
 *   - Same: sign-in + provision pattern, /profile heading assertion, the
 *     three-part DB + audit + downstream-render verification chain.
 *   - Different: baseline must be seeded server-side (TC-4's baseline
 *     comes from `signInAs({ name })` which the production JWT path
 *     handles; for timezone there is no JWT claim, so we own the seed).
 *     Different: downstream observable is the kickoff render inside the
 *     upcoming-matches widget rather than the dashboard greeting (TC-4
 *     uses the greeting only because no leaderboard surface exists yet;
 *     here the dashboard widget is the canonical downstream surface for
 *     timezone changes per FR-M16).
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import {
  getAuditLog,
  getParticipantByOid,
  getServiceRoleClient,
  resetSupabaseState,
} from '../fixtures/db';

// ---------------------------------------------------------------------------
// Inline helpers — kept local to this spec on purpose.
//
// `seedMatch` mirrors the shape used by `e2e/tests/dashboard-upcoming-widget
// .spec.ts`; we duplicate it (rather than promoting to the shared fixture)
// for the same reason that spec gives — only matches-aware specs need to
// touch `matches`, and the seed shape here is bespoke to TC-M8 (a single
// row, a kickoff timestamp chosen specifically to straddle the day boundary
// in the two TZs under test).
//
// `provisionParticipantFromPage` is the standard CDN-import dance every
// auth-bearing spec performs after `signInAs`. Production calls
// `provision_participant_from_jwt()` from `/auth/callback`; JWT injection
// bypasses that handler, so the test calls the RPC explicitly.
// ---------------------------------------------------------------------------

type MatchSeedSpec = {
  providerId: number;
  homeTeamId: string;
  awayTeamId: string;
  stage: 'group' | 'round-of-16' | 'quarter-final' | 'semi-final' | 'third-place' | 'final';
  groupLabel: string | null;
  kickoffUtc: string;
  status: 'scheduled' | 'scheduled-tbd' | 'live' | 'finished' | 'cancelled';
};

type SeededMatch = MatchSeedSpec & { id: string };

async function seedMatch(
  client: SupabaseClient<Database>,
  spec: MatchSeedSpec,
): Promise<SeededMatch> {
  // Clear any prior row keyed on the same synthetic provider_id so re-runs
  // against an already-seeded local stack stay idempotent. Scoped delete
  // (not a wholesale truncate) so any bootstrap-sync fixtures the developer
  // may have loaded out of band stay intact — same convention used by
  // `dashboard-upcoming-widget.spec.ts`.
  const cleanup = await client
    .from('matches')
    .delete()
    .eq('provider_id', spec.providerId);
  if (cleanup.error) {
    throw new Error(
      `seedMatch: cleanup failed for provider_id ${spec.providerId}: ${cleanup.error.message}`,
    );
  }

  const id = randomUUID();
  const insert = await client.from('matches').insert({
    id,
    provider_id: spec.providerId,
    home_team_id: spec.homeTeamId,
    away_team_id: spec.awayTeamId,
    stage: spec.stage,
    group_label: spec.groupLabel,
    kickoff_utc: spec.kickoffUtc,
    status: spec.status,
  });
  if (insert.error) {
    throw new Error(
      `seedMatch: insert failed for provider_id ${spec.providerId}: ${insert.error.message}`,
    );
  }

  return { ...spec, id };
}

/**
 * Resolve two distinct team UUIDs from the migration 0017 seed by TLA.
 * Brazil + Argentina are durable picks — both have been in every World
 * Cup since 1958 and are guaranteed to be in the seed. Two UUIDs are all
 * the test needs because it seeds a single match.
 */
async function pickTwoTeamUuids(
  client: SupabaseClient<Database>,
): Promise<readonly [string, string]> {
  const tlas = ['BRA', 'ARG'] as const;
  const { data, error } = await client
    .from('teams')
    .select('id, tla')
    .in('tla', [...tlas]);

  if (error) {
    throw new Error(`pickTwoTeamUuids: ${error.message}`);
  }
  if (data === null || data.length < 2) {
    throw new Error(
      `pickTwoTeamUuids: expected 2 seeded teams (${tlas.join(', ')}), got ${data?.length ?? 0}. ` +
        'Has migration 0017_seed_teams.sql been applied?',
    );
  }

  const byTla = new Map(data.map((row) => [row.tla, row.id]));
  const bra = byTla.get('BRA');
  const arg = byTla.get('ARG');
  if (bra === undefined || arg === undefined) {
    throw new Error('pickTwoTeamUuids: missing BRA or ARG team row');
  }
  return [bra, arg] as const;
}

/**
 * Invoke `provision_participant_from_jwt()` from the authenticated
 * browser context. Identical wire-shape to the helper used by
 * `auth-eligible-new-user.spec.ts`, `profile-edit-display-name.spec.ts`,
 * and `dashboard-upcoming-widget.spec.ts` — duplicated inline here for
 * self-containedness, in line with the convention every other auth-bearing
 * spec in this folder follows.
 */
async function provisionParticipantFromPage(page: Page): Promise<void> {
  const provisionResult = await page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      // Hydrate the persisted session from cookies before issuing the RPC;
      // `createBrowserClient` returns synchronously but auth state hydrates
      // asynchronously, and the RPC will 401 if it races ahead.
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
}

test.describe('US-MB / TC-M8 — TimezonePicker on /profile updates the column + audit + dashboard', () => {
  test.beforeEach(async () => {
    // Clears `participants` + `audit_log` only. `teams` and `matches` are
    // untouched, so the migration 0017 team seed survives across runs and
    // the per-test `seedMatch` call layers a single fresh match on top.
    await resetSupabaseState();
  });

  test('TC-M8: changing timezone on /profile persists, audits, and updates dashboard formatting', async ({
    page,
  }) => {
    // -----------------------------------------------------------------------
    // Phase A — sign in, provision, seed initial timezone server-side.
    // -----------------------------------------------------------------------
    // A1. Sign in as a brand-new eligible user. We do NOT need to pin the
    //     display_name here — TC-M8 is about timezone, not display_name —
    //     so the fixture's default `Test User <prefix>` is fine.
    const { oid } = await signInAs(page, { tenant: 'eligible' });

    // A2. Materialize the participant row via the production provisioning
    //     RPC (production code calls this from `/auth/callback`; JWT
    //     injection bypasses that handler, so we invoke it explicitly).
    await provisionParticipantFromPage(page);

    // A3. Seed the baseline timezone directly. A freshly-provisioned row
    //     has `timezone = 'UTC'`; we need a known non-UTC starting value
    //     so the "TZ changed" audit row has a non-trivial `old_value`
    //     and so the downstream-render assertion has a wide separation
    //     between the "before" and "after" wall-clock times.
    //
    //     The audit trigger from migration 0005 fires on THIS update too,
    //     so we then delete the audit_log rows for this actor_oid — the
    //     test's later assertion that the `participant.updated` audit row
    //     carries `old_value.timezone === 'Europe/Tallinn'` would
    //     otherwise have to filter out the trigger row left by this seed.
    const serviceRole = getServiceRoleClient();

    const seedTimezone = await serviceRole
      .from('participants')
      .update({ timezone: 'Europe/Tallinn' })
      .eq('oid', oid);
    if (seedTimezone.error) {
      throw new Error(
        `phase A3: seed timezone failed for oid ${oid}: ${seedTimezone.error.message}`,
      );
    }

    const clearAudit = await serviceRole
      .from('audit_log')
      .delete()
      .eq('actor_oid', oid);
    if (clearAudit.error) {
      throw new Error(
        `phase A3: clear audit_log failed for oid ${oid}: ${clearAudit.error.message}`,
      );
    }

    // A4. Confirm baseline state. A failure here would invalidate the
    //     audit-row assertion in Phase D — that assertion compares
    //     `old_value.timezone` against the exact literal `'Europe/Tallinn'`.
    const baseline = await getParticipantByOid(oid);
    expect(
      baseline,
      `baseline participant row for oid=${oid} must exist after provisioning`,
    ).not.toBeNull();
    const baselineRow = baseline as NonNullable<typeof baseline>;
    expect(
      baselineRow.timezone,
      "baseline participants.timezone must be 'Europe/Tallinn' after the seed UPDATE",
    ).toBe('Europe/Tallinn');

    // -----------------------------------------------------------------------
    // Phase B — seed one match for the dashboard widget to render.
    // -----------------------------------------------------------------------
    // B1. Pick two team UUIDs from the seed. We need both so the insert
    //     satisfies the (home_team_id, away_team_id) FK constraints; we
    //     only seed one row, so two UUIDs are sufficient.
    const [bra, arg] = await pickTwoTeamUuids(serviceRole);

    // B2. Build a kickoff timestamp at `now + 1 day at 23:00 UTC`. The
    //     date-arithmetic dance below intentionally PINS the wall-clock
    //     hour to 23:00 UTC (not "now + 23 hours from this moment") so
    //     the TZ-shifted render is deterministic — 23:00 UTC always
    //     becomes 8:00 PM in São Paulo (UTC-3, no DST) and 02:00 the
    //     next day in Tallinn (UTC+3 during summer, UTC+2 in winter; the
    //     hour differs by DST but it is ALWAYS the next day, so the
    //     "America/Sao_Paulo shows 8:00 PM" check is DST-stable).
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(23, 0, 0, 0);
    const kickoffUtc = tomorrow.toISOString();

    const seeded = await seedMatch(serviceRole, {
      providerId: 9701,
      homeTeamId: bra,
      awayTeamId: arg,
      stage: 'group',
      groupLabel: 'A',
      kickoffUtc,
      status: 'scheduled',
    });
    const seededMatchId = seeded.id;

    // -----------------------------------------------------------------------
    // Phase C — navigate to /profile, drive the combobox, save.
    // -----------------------------------------------------------------------
    // C1. The page is a Server Component that gates on auth; the URL
    //     assertion catches a silent middleware redirect that would
    //     otherwise look like a successful nav but render the wrong page.
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/profile$/);

    // C2. The heading proves the profile page itself rendered.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Your profile' }),
    ).toBeVisible();

    // C3. The TimezonePicker mounts an `<input role="combobox">` per the
    //     WAI-ARIA combobox pattern (see TimezonePicker.tsx line ~395).
    //     Asserting visibility here proves the picker is wired up before
    //     we try to drive it.
    const combobox = page.getByRole('combobox');
    await expect(combobox).toBeVisible();

    // C4. Open the combobox + filter the listbox down to São Paulo.
    //     `TimezonePicker` opens the listbox on input focus (see
    //     `handleInputFocus` in the component), so a click on the input
    //     also opens it. We then type a needle that narrows the IANA
    //     list (~419 entries) to just the São Paulo zone — using
    //     `Sao_Paulo` (with the underscore, exactly as the IANA id is
    //     spelled) so the filter's case-insensitive substring match
    //     hits the option text deterministically.
    await combobox.click();
    await combobox.fill('Sao_Paulo');

    // C5. Click the listbox option. `<TimezonePicker>` renders each
    //     option as `<li role="option">{zone}</li>`, so the role +
    //     accessible-name locator picks it out exactly.
    await page
      .getByRole('option', { name: 'America/Sao_Paulo' })
      .click();

    // C6. Click Save. `profile.timezoneSaveButton` = "Save timezone";
    //     while the RPC is in flight the label flips to
    //     `timezoneSavingButton` = "Saving…", but `.click()` resolves
    //     synchronously against the rendered "Save timezone" label.
    await page.getByRole('button', { name: 'Save timezone' }).click();

    // C7. Wait for the success toast. The picker renders the toast with
    //     `role="status"` and the text `profile.timezoneSuccessToast` =
    //     "Timezone updated." (verified in lib/i18n/messages/en.json).
    //     The page also renders a `role="status"` element for the
    //     display-name form's success banner; we therefore narrow on
    //     `hasText` so we are unambiguously waiting on the picker's
    //     toast, not the form's.
    await expect(
      page.getByRole('status').filter({ hasText: 'Timezone updated.' }),
    ).toBeVisible();

    // -----------------------------------------------------------------------
    // Phase D — DB persistence + audit_log assertions.
    // -----------------------------------------------------------------------
    // D1. Service-role read bypasses RLS; the row must reflect the edit.
    const afterRow = await getParticipantByOid(oid);
    expect(
      afterRow,
      `participant row for oid=${oid} must still exist after the timezone change`,
    ).not.toBeNull();
    const after = afterRow as NonNullable<typeof afterRow>;
    expect(
      after.timezone,
      "participants.timezone must advance to 'America/Sao_Paulo'",
    ).toBe('America/Sao_Paulo');

    // D2. Audit row assertion. Migration 0005's
    //     `audit_participants_changes()` AFTER UPDATE trigger writes the
    //     full OLD/NEW row JSONB on any UPDATE that changes at least one
    //     column. Phase A3 cleared audit_log for this oid, so the only
    //     `participant.updated` row remaining should be the one the
    //     `update_timezone` RPC produced.
    //
    //     We use `.find()` (not just `.at(0)`) and match on BOTH sides of
    //     the old/new pair so the assertion is robust against a future
    //     refactor that emits additional `participant.updated` rows for
    //     unrelated reasons during the same RPC call.
    const updateRows = await getAuditLog({
      action: 'participant.updated',
      oid,
    });
    expect(
      updateRows.length,
      "audit_log must contain at least one 'participant.updated' row for the changed oid",
    ).toBeGreaterThanOrEqual(1);

    const tzAuditRow = updateRows.find(
      (row) =>
        (row.old_value as { timezone?: string } | null)?.timezone ===
          'Europe/Tallinn' &&
        (row.new_value as { timezone?: string } | null)?.timezone ===
          'America/Sao_Paulo',
    );
    expect(
      tzAuditRow,
      "audit_log must contain a 'participant.updated' row with old_value.timezone='Europe/Tallinn' and new_value.timezone='America/Sao_Paulo'",
    ).toBeDefined();
    expect(
      tzAuditRow?.actor_oid,
      "audit row's actor_oid must match the editing participant's oid",
    ).toBe(oid);

    // -----------------------------------------------------------------------
    // Phase E — dashboard reflects the new TZ on the next server render.
    // -----------------------------------------------------------------------
    // E1. A fresh navigation triggers a server-side render that re-reads
    //     `participants.timezone` and re-derives the formatted kickoff
    //     string via `formatKickoff(kickoffUtc, participantTz, locale)`
    //     (see lib/matches/format-kickoff.ts).
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);

    // E2. Assertion choice — see the file-top docblock for the full
    //     rationale. The seeded match's kickoff is `T+1d at 23:00 UTC`.
    //     `formatKickoff` uses `Intl.DateTimeFormat(locale, { dateStyle:
    //     'full', timeStyle: 'short' })`, which for the default `en`
    //     locale (the only locale next-intl falls back to without an
    //     explicit Accept-Language header in the test) emits a 12-hour
    //     clock. The same UTC instant renders as:
    //
    //         Europe/Tallinn (UTC+3 summer) → "2:00 AM" the NEXT day
    //         America/Sao_Paulo (UTC-3)     → "8:00 PM" the SAME day
    //
    //     The substring "8:00 PM" therefore CANNOT appear in the
    //     Tallinn render of this kickoff, so finding it on /dashboard is
    //     proof that the server picked up the new TZ for this render.
    //
    //     The dashboard widget's `LIMIT 3` ordering means the seeded
    //     match may not appear when other test specs in the same suite
    //     leave earlier-kickoff matches in the `matches` table
    //     (resetSupabaseState clears participants/audit_log only, not
    //     matches). Asserting against the per-match detail page bypasses
    //     the widget's ordering and tests the same `formatKickoff()`
    //     code path more reliably — both the widget and the detail page
    //     call into the same helper with the same participant TZ.
    await page.goto(`/matches/${seededMatchId}`);
    await expect(
      page.getByText('8:00 PM', { exact: false }).first(),
    ).toBeVisible();
  });
});
