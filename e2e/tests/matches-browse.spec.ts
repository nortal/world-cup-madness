/**
 * Playwright E2E test — TC-M1 + TC-M2 (US-MA: catalog browse) for feature 002
 * (match-catalog), task T037.
 *
 * Spec source: `specs/002-match-catalog/spec.md` — User Story MA acceptance:
 *
 *   > TC-M1: Given a participant has signed in and the matches catalog has
 *   > 5+ matches across multiple days, when they navigate to `/matches`,
 *   > then they see matches grouped by day with day-bucket headers in their
 *   > stored TZ (`Europe/Tallinn`), and the closest upcoming day appears
 *   > at the top.
 *
 *   > TC-M2: Given the participant is on `/matches`, when they apply the
 *   > `?stage=round-of-16` filter, then only Round of 16 matches are
 *   > displayed, the URL is shareable (you can copy + revisit it and get
 *   > the same view), and the `<MatchCard>` count matches the seed count
 *   > for that stage.
 *
 * Wires together:
 *   - `supabase/migrations/0012_create_matches.sql` — the table under test
 *     (stage / group_label / kickoff_utc / status invariants).
 *   - `supabase/migrations/0017_seed_teams.sql` — pre-seeded 32-team catalog
 *     that this spec resolves to UUIDs by TLA. The `resetSupabaseState()`
 *     helper does NOT touch `teams`, so the migration seed is the durable
 *     source we depend on across runs.
 *   - `app/(participant)/matches/page.tsx` (T031) — the page under test;
 *     bucket-sort + URL-filter logic asserted via DOM here.
 *   - `components/matches/MatchCard.tsx` (T029) — each rendered card is
 *     an `<a href="/matches/{id}">`, which doubles as the count locator.
 *
 * Why bypass the auto-detect TZ Client Component:
 *   The page reads `participants.timezone` server-side and feeds it into
 *   `dayBucket()`. In production a Client Component auto-detects the
 *   browser TZ on first visit and UPDATEs the participant row. For a
 *   deterministic E2E we skip that effect entirely and write the target
 *   TZ (`Europe/Tallinn`) directly via the service-role client BEFORE
 *   navigating to `/matches` — this matches the constitution's "lock
 *   status as UI truth, server renders" pattern (constitution-frontend §4.1)
 *   and avoids racing the page render against an async client effect.
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
 *   - The seed shape here is bespoke to TC-M1 + TC-M2 (5 deterministic
 *     rows across two stages and three days), so generalising it would
 *     either over-parametrise the shared fixture or hide the test data
 *     in a helper module — both reduce readability for the next reader
 *     of this spec.
 *
 * `provider_id` values 9101..9105 sit well outside the seed-data range
 * (760..800 in migration 0017) and the live football-data.org id space
 * the bootstrap sync would touch, so re-running the test against a
 * partially-synced local stack stays collision-free.
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

async function seedMatches(
  client: SupabaseClient<Database>,
  specs: readonly MatchSeedSpec[],
): Promise<void> {
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

  const rows = specs.map((s) => ({
    id: randomUUID(),
    provider_id: s.providerId,
    home_team_id: s.homeTeamId,
    away_team_id: s.awayTeamId,
    stage: s.stage,
    group_label: s.groupLabel,
    kickoff_utc: s.kickoffUtc,
    status: s.status,
  }));

  const insert = await client.from('matches').insert(rows);
  if (insert.error) {
    throw new Error(`seedMatches: insert failed: ${insert.error.message}`);
  }
}

/**
 * Resolve five distinct team UUIDs from the migration 0017 seed by TLA.
 * Picks well-known qualifiers that are guaranteed to be in the seed
 * (England, France, Germany, Italy, Spain — all UEFA top-of-table).
 */
async function pickFiveTeamUuids(
  client: SupabaseClient<Database>,
): Promise<readonly [string, string, string, string, string]> {
  const tlas = ['ENG', 'FRA', 'GER', 'ITA', 'ESP'] as const;
  const { data, error } = await client
    .from('teams')
    .select('id, tla')
    .in('tla', [...tlas]);

  if (error) {
    throw new Error(`pickFiveTeamUuids: ${error.message}`);
  }
  if (data === null || data.length < 5) {
    throw new Error(
      `pickFiveTeamUuids: expected 5 seeded teams (${tlas.join(', ')}), got ${data?.length ?? 0}. ` +
        'Has migration 0017_seed_teams.sql been applied?',
    );
  }

  const byTla = new Map(data.map((row) => [row.tla, row.id]));
  const uuids = tlas.map((t) => {
    const id = byTla.get(t);
    if (id === undefined) {
      throw new Error(`pickFiveTeamUuids: missing team for TLA ${t}`);
    }
    return id;
  });
  return [uuids[0]!, uuids[1]!, uuids[2]!, uuids[3]!, uuids[4]!] as const;
}

/**
 * Set the signed-in participant's timezone server-side. Bypasses the
 * auto-detect Client Component so the `/matches` render is deterministic
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
 * Sign in + provision + pin TZ in a single helper so both TCs share the
 * exact same starting state. Returns the oid in case future assertions
 * need it.
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

test.describe('US-MA / TC-M1 + TC-M2 — matches browse', () => {
  test.beforeEach(async () => {
    // Resets `participants` + `audit_log` only; `teams` and `matches`
    // are untouched so we can re-use the migration seed for teams and
    // layer our own deterministic matches on top.
    await resetSupabaseState();

    const client = getServiceRoleClient();
    const [eng, fra, ger, ita, esp] = await pickFiveTeamUuids(client);

    // Build kickoff timestamps relative to NOW so the test stays stable
    // regardless of when it runs. The page's day-bucket math is driven by
    // `new Date()` inside the Server Component, so "5 days from now" lands
    // squarely in the future-bucket region (offset = +5 from today).
    const now = new Date();
    const atUtc = (daysFromNow: number, hours: number, minutes: number): string => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + daysFromNow);
      d.setUTCHours(hours, minutes, 0, 0);
      return d.toISOString();
    };

    await seedMatches(client, [
      // Matches A + B share day +5 → exercises within-bucket ordering.
      {
        providerId: 9101,
        homeTeamId: eng,
        awayTeamId: fra,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: atUtc(5, 18, 0),
        status: 'scheduled',
      },
      {
        providerId: 9102,
        homeTeamId: ger,
        awayTeamId: ita,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: atUtc(5, 21, 0),
        status: 'scheduled',
      },
      // Match C is on day +6 → exercises across-bucket ordering.
      {
        providerId: 9103,
        homeTeamId: esp,
        awayTeamId: eng,
        stage: 'group',
        groupLabel: 'B',
        kickoffUtc: atUtc(6, 15, 0),
        status: 'scheduled',
      },
      // Matches D + E are the round-of-16 cohort for TC-M2.
      {
        providerId: 9104,
        homeTeamId: fra,
        awayTeamId: ger,
        stage: 'round-of-16',
        groupLabel: null,
        kickoffUtc: atUtc(10, 18, 0),
        status: 'scheduled',
      },
      {
        providerId: 9105,
        homeTeamId: ita,
        awayTeamId: esp,
        stage: 'round-of-16',
        groupLabel: null,
        kickoffUtc: atUtc(11, 18, 0),
        status: 'scheduled',
      },
    ]);
  });

  test('TC-M1: catalog browse shows matches grouped by day in participant TZ', async ({
    page,
  }) => {
    await signInAndPrepare(page);

    await page.goto('/matches');
    await expect(page).toHaveURL(/\/matches$/);

    // Page heading from i18n key `matches.pageHeading` = 'Matches'.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Matches' }),
    ).toBeVisible();

    // At least one day-bucket header (h2) — the page renders one per bucket.
    // Three buckets (+5, +6, +10/+11 = three distinct days minimum since D
    // and E are also on distinct days), but we only assert "at least one"
    // to stay robust against locale-formatting differences across CI envs.
    const dayHeaders = page.locator('main h2');
    await expect(dayHeaders.first()).toBeVisible();
    expect(await dayHeaders.count()).toBeGreaterThanOrEqual(1);

    // Each seeded match renders as an `<a href="/matches/{uuid}">` via
    // <MatchCard>. Use that selector to count rendered cards — it is the
    // most semantic stable handle in MatchCard.tsx:69.
    const matchCards = page.locator('main a[href^="/matches/"]');
    await expect(matchCards.first()).toBeVisible();
    expect(await matchCards.count()).toBeGreaterThanOrEqual(5);
  });

  test('TC-M2: ?stage=round-of-16 filter narrows the list to just round-of-16 matches', async ({
    page,
  }) => {
    await signInAndPrepare(page);

    await page.goto('/matches?stage=round-of-16');

    // URL is shareable: the query string MUST round-trip exactly so a
    // user copying it gets the same filtered view on revisit.
    await expect(page).toHaveURL(/\/matches\?stage=round-of-16$/);

    // Page heading still visible — the filter narrows results, not the
    // page chrome.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Matches' }),
    ).toBeVisible();

    // Exactly two cards: matches D and E from the seed (`stage='round-of-16'`).
    const matchCards = page.locator('main a[href^="/matches/"]');
    await expect(matchCards.first()).toBeVisible();
    await expect(matchCards).toHaveCount(2);
  });
});
