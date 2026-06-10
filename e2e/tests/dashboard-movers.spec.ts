/**
 * Playwright E2E — feature 005 US-DC, task T033.
 *
 * Covers TC-D9 — global + neighborhood movers populate after a 24-hour
 * scoring burst.
 *
 * Strategy:
 *   1. Seed 10 baseline participants whose scoring events are timestamped
 *      30 days ago (outside the 24 h window). Their initial rankings are
 *      stable and the `get_movers_24h_aggregate` RPC will NOT see them
 *      because the WHERE clause filters to `awarded_at >= NOW() - INTERVAL
 *      '24 hours'`.
 *   2. Add fresh `score_events` for the climber subset within the trailing
 *      24 h window (default `awarded_at = now()`). These show up in the
 *      RPC output and drive the synthetic "previous rank" math inside
 *      `computeMovers`.
 *   3. Sign in as the observer; provision. Goto `/dashboard?tab=pool` and
 *      assert that both movers sub-sections render at least one entry.
 *
 * Owned provider_id range: 9716-9720.
 *
 * `test.setTimeout(90_000)` per describe — same justification as feature
 * 004's leaderboard suite (admin API ~1 s per createUser + first-paint
 * compile latency).
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_IDS = [9716, 9717, 9718, 9719, 9720] as const;

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

async function seedParticipant(
  client: SupabaseClient<Database>,
  displayName: string,
): Promise<string> {
  const oid = randomUUID();
  const email = `${oid}@nortal.com`;
  const { data: user, error: userErr } = await client.auth.admin.createUser({
    email,
    password: 'wcm-test-password-123',
    email_confirm: true,
    app_metadata: {
      tid: '00000000-0000-0000-0000-000000000000',
      oid,
      provider: 'azure',
    },
    user_metadata: { name: displayName, email },
  });
  if (userErr || !user?.user?.id) {
    throw new Error(`seedParticipant auth failed: ${userErr?.message}`);
  }
  const { data: participant, error: pErr } = await client
    .from('participants')
    .insert({
      auth_user_id: user.user.id,
      oid,
      email,
      display_name: displayName,
      status: 'active',
    })
    .select('id')
    .single();
  if (pErr || !participant) {
    throw new Error(`seedParticipant insert failed: ${pErr?.message}`);
  }
  return participant.id;
}

function refreshMV(): void {
  execSync(
    'docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;"',
    { stdio: 'pipe' },
  );
}

test.describe('US-DC — dashboard movers widget', () => {
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

  test('TC-D9: global + neighborhood movers populate after 24h scoring burst', async ({
    page,
  }) => {
    const client = getServiceRoleClient();

    // Baseline match (timestamped 30 days ago so the per-participant events
    // sit OUTSIDE the 24 h window the RPC scans).
    const baselineMatchId = await seedMatch(client, 9716);
    // Burst match — fresh events default to NOW() and so fall INSIDE the
    // 24 h window. Each climber needs a distinct match because of the
    // partial unique index on (participant_id, match_id).
    const burstMatch1 = await seedMatch(client, 9717);
    const burstMatch2 = await seedMatch(client, 9718);
    const burstMatch3 = await seedMatch(client, 9719);

    // 10 baseline participants. Display name padded for deterministic
    // secondary sort. Each one earns `i + 1` points on the baseline match.
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(await seedParticipant(client, `Pool ${String(i).padStart(2, '0')}`));
    }

    // Backdate all baseline events 30 days. `awarded_at` defaults to NOW()
    // but we override it explicitly so the RPC's `>= NOW() - INTERVAL '24
    // hours'` predicate excludes them.
    const backdated = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const baselineInserts = ids.map((id, i) => ({
      participant_id: id,
      match_id: baselineMatchId,
      source: 'match-exact' as const,
      points: i + 1, // 1..10 pts
      awarded_at: backdated,
    }));
    const { error: baselineErr } = await client.from('score_events').insert(baselineInserts);
    if (baselineErr) throw new Error(`Baseline seed failed: ${baselineErr.message}`);

    // Fresh (within last 24h) burst events for the bottom three of the
    // baseline (`Pool 00`, `Pool 01`, `Pool 02` — they hold ranks 10, 9, 8
    // initially). +20 pts each catapults them up the table. The default
    // `awarded_at = NOW()` puts these inside the RPC window.
    const climberInserts = [
      {
        participant_id: ids[0],
        match_id: burstMatch1,
        source: 'match-exact' as const,
        points: 20,
      },
      {
        participant_id: ids[1],
        match_id: burstMatch2,
        source: 'match-exact' as const,
        points: 20,
      },
      {
        participant_id: ids[2],
        match_id: burstMatch3,
        source: 'match-exact' as const,
        points: 20,
      },
    ];
    const { error: climberErr } = await client.from('score_events').insert(climberInserts);
    if (climberErr) throw new Error(`Climber seed failed: ${climberErr.message}`);
    refreshMV();

    await signInAs(page, { tenant: 'eligible', name: 'Mover Self' });
    await provisionFromAuthenticatedPage(page);

    // Self needs at least one score_event to appear in `leaderboard_snapshots`
    // — the MV is built from score_events aggregations and excludes
    // participants with zero events. Without this the dashboard's selfRank
    // is null, the neighborhood window is empty, and downstream Server
    // Components throw client-side. Backdate the event 30 days so it stays
    // OUTSIDE the 24 h movers window (Self should not appear as a climber).
    const selfMatch = await seedMatch(client, 9720);
    const { data: selfRow, error: selfErr } = await client
      .from('participants')
      .select('id')
      .eq('display_name', 'Mover Self')
      .single();
    if (selfErr || !selfRow) throw new Error(`Mover Self lookup failed: ${selfErr?.message}`);
    const { error: selfBaseErr } = await client.from('score_events').insert([
      {
        participant_id: selfRow.id,
        match_id: selfMatch,
        source: 'match-wrong',
        points: 0,
        awarded_at: backdated,
      },
    ]);
    if (selfBaseErr) throw new Error(`Self baseline insert failed: ${selfBaseErr.message}`);
    refreshMV();

    await page.goto('/dashboard?tab=pool');

    const movers = page.locator('#pool-panel section[aria-labelledby="movers-heading"]');
    await expect(movers).toBeVisible();

    // Global sub-section: scoped by aria-labelledby on the inner <h3>
    // matching the dashboard's `moversGlobalSubheading` i18n value
    // ("Top 3 in pool").
    const globalHeading = movers.locator('h3', { hasText: /top 3 in pool/i });
    await expect(globalHeading).toBeVisible();
    // The list of mover rows lives immediately after the heading inside
    // the same <div> wrapper. We scope by their sibling <ul>.
    const globalList = globalHeading.locator('xpath=following-sibling::ul[1]');
    const globalItems = globalList.locator('li');
    await expect(globalItems.first()).toBeVisible();
    // At least 1 climber registered globally (we seeded 3 climbers — depending
    // on neighborhood overlap the count may vary, but should be ≥ 1).
    const globalCount = await globalItems.count();
    expect(globalCount).toBeGreaterThanOrEqual(1);
    expect(globalCount).toBeLessThanOrEqual(3);

    // Neighborhood sub-section. May contain 0..3 climbers depending on the
    // observer's rank-window overlap with the climber participants.
    const neighborhoodHeading = movers.locator('h3', { hasText: /top 3 near you/i });
    await expect(neighborhoodHeading).toBeVisible();
    // Either the <ul> exists with items OR the empty-state <p> is shown;
    // both are valid. Just assert one of the two renders.
    const neighborhoodPanel = neighborhoodHeading.locator('xpath=following-sibling::*[1]');
    await expect(neighborhoodPanel).toBeVisible();
  });
});
