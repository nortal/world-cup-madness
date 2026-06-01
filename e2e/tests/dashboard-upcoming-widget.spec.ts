/**
 * Playwright E2E test — TC-M10 (US-MA: dashboard upcoming-matches widget)
 * for feature 002 (match-catalog), task T041.
 *
 * Spec source: `specs/002-match-catalog/spec.md` — User Story MA acceptance:
 *
 *   > TC-M10: Given a participant has signed in and 5 matches exist with
 *   > kickoffs >60 minutes in the future (status='scheduled'), when they
 *   > land on `/dashboard`, then the "Upcoming matches" widget shows EXACTLY
 *   > the next 3 matches (closest kickoffs first) with their `UPCOMING`
 *   > lock-state badges, and the empty-state placeholder from feature 001
 *   > is NO LONGER visible.
 *
 * Wires together:
 *   - FR-M12 — "Upcoming matches" dashboard widget surface.
 *   - `components/matches/UpcomingMatchesWidget.tsx` (T035) — the widget
 *     under test. The query it issues is the contract this spec verifies:
 *       status = 'scheduled'
 *       AND kickoff_utc > now() + INTERVAL '60 minutes'
 *       ORDER BY kickoff_utc ASC
 *       LIMIT 3
 *     The widget filters out kickoffs inside the lock window at the DB
 *     layer (BR-LOCK-002), so seeding 5 rows all >60 min ahead means the
 *     LIMIT 3 — not the lock filter — is what trims rows 4 and 5.
 *   - `app/(participant)/dashboard/page.tsx` (T036) — the page that swapped
 *     the feature-001 empty-state placeholder for `<UpcomingMatchesWidget>`.
 *     The page passes the participant's stored `timezone` to the widget,
 *     so we pin TZ explicitly via the service-role client (same pattern as
 *     `matches-browse.spec.ts`) to keep the render deterministic across CI
 *     environments.
 *   - `supabase/migrations/0012_create_matches.sql` — the underlying table
 *     (status / kickoff_utc / scheduled-tbd invariants).
 *   - `supabase/migrations/0017_seed_teams.sql` — pre-seeded 32-team catalog
 *     this spec resolves to UUIDs by TLA; `resetSupabaseState()` does NOT
 *     touch `teams`, so the migration seed is the durable source.
 *   - `lib/i18n/messages/en.json` —
 *       `matches.dashboardWidget.heading`  = "Upcoming matches"
 *       `matches.dashboardWidget.emptyState` = (NOT this test's empty copy)
 *       `matches.viewAllMatches`           = "View all matches"
 *       `dashboard.emptyState`             = the feature-001 copy that the
 *                                            widget replaces and that MUST
 *                                            no longer appear on /dashboard.
 *
 * Distinguishing match-card links from the "View all matches" link:
 *   `<MatchCard>` renders `<Link href="/matches/{uuid}">`; the UUID always
 *   contains hyphens. The "View all matches" link is `<Link href="/matches">`
 *   — no UUID, no trailing hyphen. The CSS selector
 *   `a[href^="/matches/"][href*="-"]` therefore picks up ONLY card links
 *   (hrefs starting with `/matches/` AND containing a hyphen) and ignores
 *   the catalog link. This avoids brittle text-based locators.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

/**
 * Inline matches-seed helper. Kept local to this spec on purpose:
 *   - Other tests (auth / welcome modal / a11y) do not touch `matches`,
 *     so extending the shared `e2e/fixtures/db.ts` reset / seed surface
 *     would force every test to pay the cost of a matches reset.
 *   - The seed shape here is bespoke to TC-M10 (5 deterministic future
 *     scheduled rows in a single group), so generalising it would either
 *     over-parametrise the shared fixture or hide the test data in a
 *     helper module — both reduce readability for the next reader.
 *
 * `provider_id` values 9501..9505 sit well outside the seed-data range
 * (760..800 in migration 0017), the live football-data.org id space the
 * bootstrap sync would touch, and the 9101..9105 range used by
 * `matches-browse.spec.ts`. Re-running the test against a partially-
 * seeded local stack stays collision-free.
 */
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
  const id = randomUUID();
  const row = {
    id,
    provider_id: spec.providerId,
    home_team_id: spec.homeTeamId,
    away_team_id: spec.awayTeamId,
    stage: spec.stage,
    group_label: spec.groupLabel,
    kickoff_utc: spec.kickoffUtc,
    status: spec.status,
  };

  const insert = await client.from('matches').insert(row);
  if (insert.error) {
    throw new Error(`seedMatch: insert failed for provider_id ${spec.providerId}: ${insert.error.message}`);
  }

  return { ...spec, id };
}

async function seedMatches(
  client: SupabaseClient<Database>,
  specs: readonly MatchSeedSpec[],
): Promise<readonly SeededMatch[]> {
  // Clear any prior matches keyed by the same synthetic provider_ids so
  // re-runs against an already-seeded local stack stay idempotent. We
  // scope the delete to the provider_id range this helper owns rather
  // than truncating `matches` wholesale — that keeps any bootstrap-sync
  // fixtures the developer may have loaded out of band intact.
  const providerIds = specs.map((s) => s.providerId);
  const cleanup = await client.from('matches').delete().in('provider_id', providerIds);
  if (cleanup.error) {
    throw new Error(`seedMatches: cleanup failed: ${cleanup.error.message}`);
  }

  const seeded: SeededMatch[] = [];
  for (const spec of specs) {
    seeded.push(await seedMatch(client, spec));
  }
  return seeded;
}

/**
 * Resolve two distinct team UUIDs from the migration 0017 seed by TLA.
 * Picks two well-known qualifiers (Brazil and Argentina) guaranteed to be
 * in the seed; we alternate home/away across the 5 seeded matches so the
 * row inserts satisfy the (home_team_id, away_team_id) FK constraints
 * without needing more than two team UUIDs.
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
 * Set the signed-in participant's timezone server-side. Bypasses the
 * auto-detect Client Component so the `/dashboard` render is deterministic
 * across CI environments that may report different browser TZs.
 */
async function setParticipantTimezone(oid: string, timezone: string): Promise<void> {
  const client = getServiceRoleClient();
  const { error } = await client
    .from('participants')
    .update({ timezone })
    .eq('oid', oid);
  if (error) {
    throw new Error(`setParticipantTimezone(${oid}, ${timezone}): ${error.message}`);
  }
}

/**
 * Sign in + provision + pin TZ in a single helper. Returns the oid so
 * the test body can target the right participant row for follow-up state.
 */
async function signInAndPrepare(page: Page): Promise<string> {
  const { oid } = await signInAs(page, { tenant: 'eligible' });

  // Provision the participant row — `signInAs` only installs the auth
  // session; production code calls `provision_participant_from_jwt()` from
  // the OAuth callback. Mirror that here so a `participants` row exists
  // for the UPDATE below and for the page's `auth_user_id` lookup.
  const provision = await page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic CDN import inside the browser context.
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
  expect(provision.ok, 'provision_participant_from_jwt RPC must succeed').toBe(true);

  await setParticipantTimezone(oid, 'Europe/Tallinn');
  return oid;
}

test.describe('US-MA / TC-M10 — dashboard upcoming-matches widget', () => {
  // Hoisted so the test body can assert on the UUIDs of rows 4 + 5
  // (which the widget MUST NOT render).
  let seededMatches: readonly SeededMatch[] = [];

  test.beforeEach(async () => {
    // Resets `participants` + `audit_log` only; `teams` and `matches`
    // are untouched so we can re-use the migration seed for teams and
    // layer our own deterministic matches on top.
    await resetSupabaseState();

    const client = getServiceRoleClient();
    const [bra, arg] = await pickTwoTeamUuids(client);

    // Build kickoff timestamps relative to NOW so all rows sit well past
    // the widget's 60-minute future floor. The closest seeded match is
    // +3 hours, which is comfortably outside the 60-minute lock window
    // regardless of the few seconds the test takes to walk from
    // beforeEach into the assertion.
    const now = new Date();
    const inHours = (hoursFromNow: number): string => {
      const d = new Date(now.getTime() + hoursFromNow * 60 * 60 * 1000);
      return d.toISOString();
    };
    const inDays = (daysFromNow: number): string => inHours(daysFromNow * 24);

    // Alternate (home, away) across the 5 matches so each row picks a
    // distinct home/away pairing from the two-team pool.
    seededMatches = await seedMatches(client, [
      // Closest — should appear first in the widget.
      {
        providerId: 9501,
        homeTeamId: bra,
        awayTeamId: arg,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: inHours(3),
        status: 'scheduled',
      },
      {
        providerId: 9502,
        homeTeamId: arg,
        awayTeamId: bra,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: inDays(1),
        status: 'scheduled',
      },
      // The 3rd closest — last card the widget should render.
      {
        providerId: 9503,
        homeTeamId: bra,
        awayTeamId: arg,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: inDays(2),
        status: 'scheduled',
      },
      // Rows 4 and 5 — MUST NOT be rendered (LIMIT 3).
      {
        providerId: 9504,
        homeTeamId: arg,
        awayTeamId: bra,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: inDays(3),
        status: 'scheduled',
      },
      {
        providerId: 9505,
        homeTeamId: bra,
        awayTeamId: arg,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: inDays(4),
        status: 'scheduled',
      },
    ]);
  });

  test('TC-M10: dashboard widget renders next 3 upcoming matches with UPCOMING badges, replacing empty state', async ({
    page,
  }) => {
    await signInAndPrepare(page);

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);

    // -- Widget heading ----------------------------------------------------
    // `matches.dashboardWidget.heading` = "Upcoming matches". The h2 lives
    // inside `<UpcomingMatchesWidget>` (rendered by the page).
    await expect(
      page.getByRole('heading', { level: 2, name: 'Upcoming matches' }),
    ).toBeVisible();

    // -- Exactly 3 match-card links ---------------------------------------
    // `<MatchCard>` wraps the row in `<Link href="/matches/{uuid}">`; UUIDs
    // always contain hyphens. The "View all matches" link is
    // `<Link href="/matches">` — no UUID and no hyphen. The compound CSS
    // selector therefore matches ONLY card links and excludes the catalog
    // link without relying on visible text. See the file-top docblock for
    // the rationale.
    const matchCardLinks = page.locator('a[href^="/matches/"][href*="-"]');
    await expect(matchCardLinks.first()).toBeVisible();
    await expect(matchCardLinks).toHaveCount(3);

    // -- All 3 visible cards show the UPCOMING badge ----------------------
    // The widget's query filters to status='scheduled' AND kickoff > now+60min,
    // so `lockBadgeState()` derives 'UPCOMING' for every rendered row.
    // `LockBadge` renders the literal "UPCOMING" text from
    // `matches.badge.upcoming`. We assert one UPCOMING badge per rendered
    // card by counting the visible occurrences inside the widget section.
    const upcomingBadges = page.getByText('UPCOMING', { exact: true });
    await expect(upcomingBadges).toHaveCount(3);

    // -- Rows 4 and 5 are NOT rendered ------------------------------------
    // Look up the seeded UUIDs hoisted from beforeEach and assert that no
    // anchor on the page points at them. Using the seeded ID directly is
    // more deterministic than asserting on team names (which repeat across
    // rows in this seed).
    const fourthMatch = seededMatches[3];
    const fifthMatch = seededMatches[4];
    if (fourthMatch === undefined || fifthMatch === undefined) {
      throw new Error('beforeEach must seed 5 matches');
    }
    await expect(
      page.locator(`a[href*="/matches/${fourthMatch.id}"]`),
    ).toHaveCount(0);
    await expect(
      page.locator(`a[href*="/matches/${fifthMatch.id}"]`),
    ).toHaveCount(0);

    // -- Feature-001 empty-state copy is gone -----------------------------
    // The dashboard page (T036) replaced the feature-001 placeholder text
    // with `<UpcomingMatchesWidget>`. The widget's OWN empty-state copy
    // ("No upcoming matches scheduled yet.") would only appear when zero
    // upcoming rows match — irrelevant here. The original
    // `dashboard.emptyState` string MUST no longer be visible anywhere on
    // the page. We assert on the exact i18n value because if the page
    // regressed and re-included the placeholder we would want this test
    // to flag it, not a paraphrase.
    await expect(
      page.getByText(
        'No upcoming matches yet. The schedule will appear here once the tournament is finalized.',
      ),
    ).toHaveCount(0);

    // -- "View all matches" link is visible -------------------------------
    // `matches.viewAllMatches` = "View all matches". Linked to `/matches`
    // (no UUID), so it is the one anchor the card-link selector above
    // deliberately excludes.
    await expect(
      page.getByRole('link', { name: 'View all matches' }),
    ).toBeVisible();
  });
});
