/**
 * Playwright E2E — feature 005 US-DC, task T034.
 *
 * Covers TC-D10 — the weekly-digest widget aggregates the signed-in
 * participant's `score_events` for the current ISO week (Mon-Sun UTC)
 * into total / count / best / worst stats, and excludes
 * final-prediction events (`match_id IS NULL`).
 *
 * Seed:
 *   - 4 match-scoring events spread across the current week, with
 *     `awarded_at` overrides hitting Monday, Wednesday, Friday and
 *     Saturday. Points 10, 5, 0, 10 — all within the 0..20 CHECK.
 *   - 1 final-prediction event (`match_id=null`, `source='final-champion'`,
 *     `points=20`). The widget MUST exclude this — total stays 25, count 4.
 *
 * Owned provider_id range: 9721-9725.
 *
 * `test.setTimeout(90_000)` per describe — same justification as feature
 * 004's leaderboard suite.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';
import { startOfCurrentWeekUTC } from '../../lib/dashboard/weekly-digest';

const PROVIDER_IDS = [9721, 9722, 9723, 9724, 9725] as const;

async function provisionFromAuthenticatedPage(page: Page): Promise<void> {
  await page.goto('/dashboard');
  const result = await page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic CDN import inside the page context
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      await client.auth.getSession();
      const { error } = await client.rpc('provision_participant_from_jwt');
      return error ? { ok: false as const, error: error.message } : { ok: true as const };
    },
    {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );
  expect(result.ok, 'provision RPC must succeed').toBe(true);
}

async function seedMatch(
  client: SupabaseClient<Database>,
  providerId: number,
): Promise<string> {
  await client.from('matches').delete().eq('provider_id', providerId);
  const { data: teams, error: teamsErr } = await client
    .from('teams')
    .select('id, tla')
    .in('tla', ['ENG', 'FRA']);
  if (teamsErr) throw new Error(`seedMatch teams lookup failed: ${teamsErr.message}`);
  const eng = teams!.find((t) => t.tla === 'ENG')!;
  const fra = teams!.find((t) => t.tla === 'FRA')!;
  const id = randomUUID();
  // status='scheduled' so the AFTER INSERT scoring trigger on `matches`
  // does NOT fire — see dashboard-neighborhood.spec.ts seedMatch() comment.
  const { error: insErr } = await client.from('matches').insert({
    id,
    provider_id: providerId,
    home_team_id: eng.id,
    away_team_id: fra.id,
    stage: 'group',
    group_label: 'A',
    kickoff_utc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    status: 'scheduled',
    score_home: null,
    score_away: null,
  });
  if (insErr) throw new Error(`seedMatch insert failed: ${insErr.message}`);
  return id;
}

/**
 * Returns an ISO timestamp `dayOffsetDays` days after the Monday-00:00 UTC
 * anchor of the current week, with an extra `hoursIntoDay` hour offset
 * to keep the timestamp inside the day rather than exactly on midnight
 * (helps distinguish day-of-week in debug logs).
 *
 * The current week is computed via the same helper the widget uses
 * (`startOfCurrentWeekUTC`), so the spec's week anchor matches the
 * widget's read predicate exactly — no clock drift between test setup
 * and assertion.
 */
function dayOffsetISO(weekStart: Date, dayOffsetDays: number, hoursIntoDay: number): string {
  const d = new Date(weekStart.getTime());
  d.setUTCDate(d.getUTCDate() + dayOffsetDays);
  d.setUTCHours(hoursIntoDay, 0, 0, 0);
  return d.toISOString();
}

test.describe('US-DC — dashboard weekly digest widget', () => {
  test.setTimeout(90_000);
  // Pin to mobile viewport — see dashboard-neighborhood.spec.ts for why.
  test.use({ viewport: { width: 360, height: 800 } });

  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
  });

  test('TC-D10: weekly digest aggregates correctly + excludes final-prediction event', async ({
    page,
  }) => {
    const client = getServiceRoleClient();

    // 4 distinct matches so the partial unique index on
    // (participant_id, match_id) doesn't reject the 4 score_events. Plus
    // ONE final-prediction event with match_id=null on `final-champion`
    // (covered by the second partial unique index on (participant_id,
    // source) WHERE match_id IS NULL).
    const m1 = await seedMatch(client, 9721);
    const m2 = await seedMatch(client, 9722);
    const m3 = await seedMatch(client, 9723);
    const m4 = await seedMatch(client, 9724);

    await signInAs(page, { tenant: 'eligible', name: 'Digest Self' });
    await provisionFromAuthenticatedPage(page);

    // Look up the observer's participant id via the service-role client.
    const { data: selfRow, error: selfErr } = await client
      .from('participants')
      .select('id')
      .eq('display_name', 'Digest Self')
      .single();
    if (selfErr || !selfRow) throw new Error(`Self lookup failed: ${selfErr?.message}`);

    // Use the SAME helper the widget uses so the week boundary is bit-for-
    // bit identical between seed and assertion. The widget calls this with
    // a fresh `new Date()` at request time, so we re-call it here at test
    // time — within seconds of the page render, so the anchor is stable.
    const weekStart = startOfCurrentWeekUTC();

    // 4 match-scoring events spread Mon (+1h) / Wed / Fri / Sat. Points
    // 10, 5, 0, 10 — all within the 0..20 CHECK. Total = 25, count = 4,
    // best = 10, worst = 0.
    const matchInserts = [
      {
        participant_id: selfRow.id,
        match_id: m1,
        source: 'match-exact' as const,
        points: 10,
        awarded_at: dayOffsetISO(weekStart, 0, 1), // Monday + 1h
      },
      {
        participant_id: selfRow.id,
        match_id: m2,
        source: 'match-outcome' as const,
        points: 5,
        awarded_at: dayOffsetISO(weekStart, 2, 12), // Wednesday + 12h
      },
      {
        participant_id: selfRow.id,
        match_id: m3,
        source: 'match-wrong' as const,
        points: 0,
        awarded_at: dayOffsetISO(weekStart, 4, 9), // Friday + 9h
      },
      {
        participant_id: selfRow.id,
        match_id: m4,
        source: 'match-exact' as const,
        points: 10,
        awarded_at: dayOffsetISO(weekStart, 5, 15), // Saturday + 15h
      },
    ];
    const { error: matchErr } = await client.from('score_events').insert(matchInserts);
    if (matchErr) throw new Error(`Digest match score_events insert failed: ${matchErr.message}`);

    // ONE final-prediction event. The score_events CHECK constraint pairs
    // `source` with `match_id` presence — final sources MUST have match_id
    // NULL. The digest helper (`computeDigestSummary`) filters this out
    // via `match_id !== null` so total stays 25, count stays 4.
    const finalInsert = {
      participant_id: selfRow.id,
      match_id: null,
      source: 'final-champion' as const,
      points: 20,
      awarded_at: dayOffsetISO(weekStart, 1, 6), // Tuesday + 6h (still this week)
    };
    const { error: finalErr } = await client.from('score_events').insert([finalInsert]);
    if (finalErr) throw new Error(`Final score_event insert failed: ${finalErr.message}`);

    await page.goto('/dashboard?tab=pool');

    const digest = page.locator('#pool-panel section[aria-labelledby="digest-heading"]');
    await expect(digest).toBeVisible();

    // The widget renders a 2x2 <dl> grid; each stat is a (<dt>, <dd>) pair.
    // Total points = 25 (10 + 5 + 0 + 10) — final-champion EXCLUDED.
    const totalDt = digest.locator('dt', { hasText: /total points/i });
    const totalDd = totalDt.locator('xpath=following-sibling::dd[1]');
    await expect(totalDd).toHaveText('25');

    // Matches scored = 4 — final-champion excluded.
    const countDt = digest.locator('dt', { hasText: /matches scored/i });
    const countDd = countDt.locator('xpath=following-sibling::dd[1]');
    await expect(countDd).toHaveText('4');

    // Best single score = 10.
    const bestDt = digest.locator('dt', { hasText: /best single score/i });
    const bestDd = bestDt.locator('xpath=following-sibling::dd[1]');
    await expect(bestDd).toHaveText('10');

    // Worst single score = 0.
    const worstDt = digest.locator('dt', { hasText: /worst single score/i });
    const worstDd = worstDt.locator('xpath=following-sibling::dd[1]');
    await expect(worstDd).toHaveText('0');
  });
});
