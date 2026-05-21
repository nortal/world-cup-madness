/**
 * Playwright E2E test — TC-M5 (lock-state badge 60-minute boundary) for US-MA.
 *
 * Spec source: `specs/002-match-catalog/spec.md` (TC-M5):
 *   > Given a participant has signed in and three matches exist with kickoffs
 *   > at `now + 61 minutes`, `now + 60 minutes`, and `now + 59 minutes`, when
 *   > they navigate to `/matches`, then the +61min match shows `UPCOMING`, the
 *   > +60min match shows `LOCKED`, and the +59min match shows `LOCKED`.
 *
 * Boundary semantics per BR-LOCK-003 (inverted): a prediction MUST be rejected
 * when `remaining_minutes ≤ 60`, so the read-side lock-badge projection is
 * inclusive on the LOCKED side — kickoff exactly 60 minutes in the future
 * already renders as `LOCKED`. The derivation logic lives in
 * `lib/matches/lock-badge.ts` (`lockBadgeState(kickoffUtc, status, nowUtc)`)
 * and uses `remainingMs <= LOCK_WINDOW_MS` (the `<=`, not `<`, is the entire
 * point of this test). Its 15-case Jest suite at
 * `lib/matches/__tests__/lock-badge.test.ts` pins the same boundary triplet
 * (+61min / +60min / +59min) plus terminal/`live`/NULL-kickoff branches at the
 * pure-function layer; this E2E spec is the complementary check that the
 * server-rendered output of `<LockBadge />` (composed inside `<MatchCard />`)
 * actually surfaces those badge states on the `/matches` catalog page.
 *
 * What this test deliberately does NOT do:
 *   - It does NOT mock time. The page renders against `new Date()` and we
 *     seed kickoffs as offsets from real `Date.now()`. The whole flow runs in
 *     well under a minute, so the +60min kickoff is still ≈60min away (give or
 *     take a few hundred ms) by the time the server renders — comfortably on
 *     the LOCKED side of the inclusive boundary regardless of test latency.
 *   - It does NOT exercise the client-side `LockCountdownTicker` (T032) —
 *     that's covered separately. This spec asserts only the server-rendered
 *     badge text on initial page load.
 *
 * Locating each card: the seeded matches each get a known UUID returned by the
 * service-role INSERT; `<MatchCard />` wraps every row in
 * `<Link href="/matches/${match.id}">`, so `a[href*="/matches/${match.id}"]`
 * pinpoints the card without matching on team names (which are reused across
 * the three matches).
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

/**
 * Inline match-seeding helper.
 *
 * Inserts a single `matches` row via the service-role client (bypassing RLS —
 * production sync writes use the same role from the Edge Function). Returns
 * the generated UUID so tests can locate the resulting `<MatchCard />` via
 * its `/matches/${id}` link href.
 *
 * Kept inline (rather than added to `e2e/fixtures/db.ts`) because TC-M5 is
 * currently the only match-catalog spec that needs ad-hoc seeded matches;
 * promote to a shared fixture once a second consumer appears.
 */
async function seedMatch(input: {
  providerId: number;
  homeTeamId: string;
  awayTeamId: string;
  kickoffUtc: Date;
  status: 'scheduled' | 'scheduled-tbd' | 'live' | 'finished' | 'cancelled';
  groupLabel: string | null;
  stage: 'group' | 'round-of-16' | 'quarter-final' | 'semi-final' | 'third-place' | 'final';
}): Promise<string> {
  const client = getServiceRoleClient();

  // Idempotency: drop any prior row carrying this provider_id so re-runs
  // against a partially-seeded local stack stay clean. resetSupabaseState()
  // does NOT truncate `matches` (it owns participants/audit_log only).
  const cleanup = await client
    .from('matches')
    .delete()
    .eq('provider_id', input.providerId);
  if (cleanup.error !== null) {
    throw new Error(
      `seedMatch: cleanup failed for provider_id=${input.providerId}: ${cleanup.error.message}`,
    );
  }

  const { data, error } = await client
    .from('matches')
    .insert({
      provider_id: input.providerId,
      home_team_id: input.homeTeamId,
      away_team_id: input.awayTeamId,
      kickoff_utc: input.kickoffUtc.toISOString(),
      status: input.status,
      group_label: input.groupLabel,
      stage: input.stage,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(
      `seedMatch: insert failed for provider_id=${input.providerId}: ${error?.message ?? 'no row returned'}`,
    );
  }
  return data.id;
}

test.describe('US-MA / TC-M5 — lock-state badge at the 60-minute boundary', () => {
  /**
   * Match UUIDs returned from the per-test seed. Captured at the
   * `beforeEach` scope so the test body can build link-href selectors
   * without re-querying the DB.
   */
  let boundaryAboveId: string;
  let boundaryExactId: string;
  let boundaryBelowId: string;

  test.beforeEach(async () => {
    await resetSupabaseState();

    // Pick two stable team UUIDs by TLA from the seeded WC 2026 catalog (see
    // supabase/migrations/0017_seed_teams.sql). Reusing the same pair across
    // the three matches keeps the test focused on badge state — selectors
    // target the per-match link href, not team names.
    const client = getServiceRoleClient();
    const { data: teams, error: teamsError } = await client
      .from('teams')
      .select('id, tla')
      .in('tla', ['ENG', 'FRA']);

    if (teamsError || !teams || teams.length < 2) {
      throw new Error(
        `TC-M5 setup: failed to fetch ENG/FRA team UUIDs from seeded catalog: ${teamsError?.message ?? `only ${teams?.length ?? 0} rows returned`}`,
      );
    }

    const homeTeam = teams.find((t) => t.tla === 'ENG');
    const awayTeam = teams.find((t) => t.tla === 'FRA');
    if (!homeTeam || !awayTeam) {
      throw new Error('TC-M5 setup: expected both ENG and FRA in seeded teams.');
    }

    // Real-time offsets from `Date.now()` — no time mocking. The window
    // between seed and server render is short enough that the +60min kickoff
    // remains ≈60min in the future when the page renders, comfortably on the
    // LOCKED side of the BR-LOCK-003 inclusive boundary (`remaining <= 60min`).
    const now = Date.now();
    const MINUTE_MS = 60 * 1000;

    boundaryAboveId = await seedMatch({
      providerId: 9301,
      homeTeamId: homeTeam.id,
      awayTeamId: awayTeam.id,
      kickoffUtc: new Date(now + 61 * MINUTE_MS),
      status: 'scheduled',
      groupLabel: 'A',
      stage: 'group',
    });

    boundaryExactId = await seedMatch({
      providerId: 9302,
      homeTeamId: homeTeam.id,
      awayTeamId: awayTeam.id,
      kickoffUtc: new Date(now + 60 * MINUTE_MS),
      status: 'scheduled',
      groupLabel: 'A',
      stage: 'group',
    });

    boundaryBelowId = await seedMatch({
      providerId: 9303,
      homeTeamId: homeTeam.id,
      awayTeamId: awayTeam.id,
      kickoffUtc: new Date(now + 59 * MINUTE_MS),
      status: 'scheduled',
      groupLabel: 'A',
      stage: 'group',
    });
  });

  test('TC-M5: 60-minute lock boundary is inclusive — +61min is UPCOMING, +60min and +59min are LOCKED', async ({
    page,
  }) => {
    // Sign in as an eligible participant — `/matches` is gated behind the
    // `is_eligible_nortal_user()` RLS SELECT policy added in migration 0016,
    // so anonymous requests would get an empty page.
    const { oid } = await signInAs(page, { tenant: 'eligible' });

    // Provision the participants row by calling the production RPC from
    // the authenticated browser context. `signInAs` only installs the auth
    // session; without this step the page's participant lookup returns
    // null and the auth gate redirects to '/'.
    const provision = await page.evaluate(
      async ({ supabaseUrl, supabaseAnonKey }) => {
        const { createBrowserClient } = await import(
          // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
          'https://esm.sh/@supabase/ssr@0.10.3'
        );
        const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
        await client.auth.getSession();
        const { error } = await client.rpc('provision_participant_from_jwt');
        if (error !== null && error !== undefined) {
          return { ok: false as const, error: error.message };
        }
        return { ok: true as const };
      },
      {
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
        supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
      },
    );
    expect(provision.ok, provision.ok ? undefined : provision.error).toBe(true);

    // Pin the participant's timezone to a fixed IANA zone so the catalog
    // page's kickoff formatting is deterministic across CI environments. The
    // badge text itself is locale-agnostic, but tying the timezone here keeps
    // the rendered DOM stable in case a future regression captures snapshots.
    const client = getServiceRoleClient();
    const { error: tzError } = await client
      .from('participants')
      .update({ timezone: 'Europe/Tallinn' })
      .eq('oid', oid);
    if (tzError) {
      throw new Error(`TC-M5: failed to set participant timezone: ${tzError.message}`);
    }

    await page.goto('/matches');
    await expect(page).toHaveURL(/\/matches$/);

    // For each seeded match, locate its card by link href and assert the
    // badge text within. The `<LockBadge />` Server Component renders the
    // localised label inside a `<span role="status">`, which `getByText()`
    // matches via descendant lookup scoped to the card link.
    const aboveCard = page.locator(`a[href*="/matches/${boundaryAboveId}"]`).first();
    const exactCard = page.locator(`a[href*="/matches/${boundaryExactId}"]`).first();
    const belowCard = page.locator(`a[href*="/matches/${boundaryBelowId}"]`).first();

    await expect(aboveCard, '+61min card must render').toBeVisible();
    await expect(exactCard, '+60min card must render').toBeVisible();
    await expect(belowCard, '+59min card must render').toBeVisible();

    // +61min is OUTSIDE the inclusive window — still UPCOMING.
    await expect(
      aboveCard.getByText('UPCOMING', { exact: true }),
      '+61min match (outside 60-min window) must render UPCOMING',
    ).toBeVisible();

    // +60min is the BR-LOCK-003 inclusive boundary — already LOCKED. This is
    // the load-bearing assertion of TC-M5: the boundary is `<=`, not `<`.
    await expect(
      exactCard.getByText('LOCKED', { exact: true }),
      '+60min match (at inclusive boundary) must render LOCKED (BR-LOCK-003)',
    ).toBeVisible();

    // +59min is INSIDE the window — LOCKED.
    await expect(
      belowCard.getByText('LOCKED', { exact: true }),
      '+59min match (inside 60-min window) must render LOCKED',
    ).toBeVisible();
  });
});
