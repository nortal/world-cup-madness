/**
 * Playwright E2E — feature 005 US-DC, task T032.
 *
 * Covers TC-D6 (top-clamp: self at low rank → ranks 1-11 visible), TC-D7
 * (centre: self mid-table → selfRank±5 visible), TC-D8 (bottom-clamp: self
 * at last rank → last 11 visible) and the small-pool edge (<11 participants
 * total → all rendered, no padding).
 *
 * Seeds participants + score_events directly via the service-role client,
 * then drives the page through `signInAs` + `provisionFromAuthenticatedPage`
 * exactly as feature 004's leaderboard specs do. The MV is refreshed via
 * a docker exec against the local Supabase Postgres container — the
 * service-role session can't reach the admin-gated `refresh_leaderboard()`
 * RPC (see `leaderboard-page.spec.ts` for the rationale).
 *
 * Owned provider_id range: 9711-9715 (5 distinct rows, one per test, plus
 * headroom). Matches outside this range are untouched.
 *
 * `test.setTimeout(90_000)` per describe: each test seeds 25+ participants
 * via the admin API (~1 s each) plus the page-side compile latency on the
 * first `/dashboard?tab=pool` hit. The default 30 s budget runs out.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

// Owned provider_id range — one seed match per test, plus headroom.
const PROVIDER_IDS = [9711, 9712, 9713, 9714, 9715] as const;

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
  // does NOT fire (it gates on cancelled OR (finished AND scores NOT NULL)).
  // The trigger would otherwise insert `no-prediction` 0-pt rows for every
  // active participant, colliding with the per-test score_event inserts on
  // the partial unique index `score_events_one_per_participant_match`.
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
  // The service-role client cannot reach `refresh_leaderboard()` — that RPC
  // gates on `is_admin_user(auth.uid())` and the service-role session has
  // no JWT. Refresh the MV directly against the local Postgres container.
  execSync(
    'docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;"',
    { stdio: 'pipe' },
  );
}

test.describe('US-DC — dashboard neighborhood widget', () => {
  test.setTimeout(90_000);
  // Pin to mobile viewport so only the mobile Pool panel renders. The
  // dashboard renders Pool widgets in both `#pool-panel` (block md:hidden)
  // and the desktop grid (hidden md:grid). At a desktop viewport BOTH copies
  // exist in the DOM, tripping Playwright's strict-mode check.
  test.use({ viewport: { width: 360, height: 800 } });

  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
  });

  test('TC-D6 top-clamp: self at rank 2 → ranks 1-11 visible', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedMatch(client, 9711);

    // Seed 25 "Ranked NN" participants. Naming pads to two digits so the MV's
    // secondary `display_name` sort is deterministic. Each one gets a single
    // match-exact event whose `points` is the inverse of their index — the
    // last-seeded participant earns 1 pt (rank 25), the first earns 19 pts.
    // Cap at 20 to respect the score_events.points CHECK (0..20). The signed-
    // in observer earns 19 pts via a SECOND event below, joining the cluster
    // of high earners.
    const rankedIds: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      rankedIds.push(await seedParticipant(client, `Ranked ${String(i).padStart(2, '0')}`));
    }
    const inserts = rankedIds.map((id, i) => ({
      participant_id: id,
      match_id: matchId,
      source: 'match-exact' as const,
      // points: 19, 18, …, 0 — but clamp to 0 so we don't violate the CHECK.
      points: Math.max(0, 19 - i),
    }));
    const { error: rankedErr } = await client.from('score_events').insert(inserts);
    if (rankedErr) throw new Error(`Ranked seed insert failed: ${rankedErr.message}`);
    refreshMV();

    await signInAs(page, { tenant: 'eligible', name: 'Self Top' });
    await provisionFromAuthenticatedPage(page);

    // Look up the observer's participant id so we can grant them a score.
    const { data: selfRow, error: selfErr } = await client
      .from('participants')
      .select('id')
      .eq('display_name', 'Self Top')
      .single();
    if (selfErr || !selfRow) throw new Error(`Self lookup failed: ${selfErr?.message}`);

    // Score the observer with 20 pts on a second seeded match (the partial
    // unique index on (participant_id, match_id) is per-match, so we need a
    // new match row). 20 pts beats every Ranked participant → rank 1.
    const matchId2 = await seedMatch(client, 9712);
    const { error: selfScoreErr } = await client.from('score_events').insert([
      { participant_id: selfRow.id, match_id: matchId2, source: 'match-exact', points: 20 },
    ]);
    if (selfScoreErr) throw new Error(`Self score insert failed: ${selfScoreErr.message}`);
    refreshMV();

    await page.goto('/dashboard?tab=pool');

    // 26 total participants. Self is rank 1 → top-clamp → ranks 1-11.
    const neighborhood = page.locator('#pool-panel section[aria-labelledby="neighborhood-heading"]');
    await expect(neighborhood).toBeVisible();
    const rows = neighborhood.locator('table tbody tr');
    await expect(rows).toHaveCount(11);

    const selfRowEl = neighborhood.locator('tr[data-self="true"]');
    await expect(selfRowEl).toHaveCount(1);
    await expect(selfRowEl).toContainText('Self Top');
  });

  test('TC-D7 centre: self mid-table → ranks selfRank±5 visible', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedMatch(client, 9713);

    // 24 "Ranked NN" participants with descending points (clamped to ≥0).
    // The observer is scored *between* clusters so they end up mid-table.
    const rankedIds: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      rankedIds.push(await seedParticipant(client, `Ranked ${String(i).padStart(2, '0')}`));
    }
    const inserts = rankedIds.map((id, i) => ({
      participant_id: id,
      match_id: matchId,
      source: 'match-exact' as const,
      points: Math.max(0, 20 - i),
    }));
    const { error: rankedErr } = await client.from('score_events').insert(inserts);
    if (rankedErr) throw new Error(`Ranked seed insert failed: ${rankedErr.message}`);
    refreshMV();

    await signInAs(page, { tenant: 'eligible', name: 'Self Centre' });
    await provisionFromAuthenticatedPage(page);

    const { data: selfRow, error: selfErr } = await client
      .from('participants')
      .select('id')
      .eq('display_name', 'Self Centre')
      .single();
    if (selfErr || !selfRow) throw new Error(`Self lookup failed: ${selfErr?.message}`);

    // Total participants after observer = 25. Centre-clamp requires
    // selfRank > 6 AND selfRank + 5 < total. We aim for selfRank ≈ 13.
    // Observer earns 8 pts → beats Ranked-13..23 (12..0 pts) but loses to
    // Ranked-00..11 (20..9 pts). 12 better + observer = rank 13.
    const matchId2 = await seedMatch(client, 9714);
    const { error: selfScoreErr } = await client.from('score_events').insert([
      { participant_id: selfRow.id, match_id: matchId2, source: 'match-exact', points: 8 },
    ]);
    if (selfScoreErr) throw new Error(`Self score insert failed: ${selfScoreErr.message}`);
    refreshMV();

    await page.goto('/dashboard?tab=pool');

    // 25 total. Self mid-table → centre-clamp → 11-row window.
    const neighborhood = page.locator('#pool-panel section[aria-labelledby="neighborhood-heading"]');
    const rows = neighborhood.locator('table tbody tr');
    await expect(rows).toHaveCount(11);

    const selfRowEl = neighborhood.locator('tr[data-self="true"]');
    await expect(selfRowEl).toHaveCount(1);
    await expect(selfRowEl).toContainText('Self Centre');
  });

  test('TC-D8 bottom-clamp: self at last rank → last 11 visible', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedMatch(client, 9715);

    // 24 high-scoring "Ranked NN" participants; observer scores 0 pts → last.
    const rankedIds: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      rankedIds.push(await seedParticipant(client, `Ranked ${String(i).padStart(2, '0')}`));
    }
    const inserts = rankedIds.map((id, i) => ({
      participant_id: id,
      match_id: matchId,
      source: 'match-exact' as const,
      // Spread 20..1 then clamp the remainder to 1 so every Ranked beats the
      // observer (who has zero score_events → MV total_points = 0).
      points: Math.max(1, 20 - i),
    }));
    const { error: rankedErr } = await client.from('score_events').insert(inserts);
    if (rankedErr) throw new Error(`Ranked seed insert failed: ${rankedErr.message}`);
    refreshMV();

    await signInAs(page, { tenant: 'eligible', name: 'Self Bottom' });
    await provisionFromAuthenticatedPage(page);

    // Self needs at least one score_event to appear in `leaderboard_snapshots`
    // — the MV is built from score_events aggregations and excludes
    // participants with zero events. Insert a 0-pt `match-wrong` event on a
    // dedicated match (the partial unique index is per (participant, match),
    // so we need a distinct match id from the Ranked NN cluster).
    const { data: selfRow, error: selfErr } = await client
      .from('participants')
      .select('id')
      .eq('display_name', 'Self Bottom')
      .single();
    if (selfErr || !selfRow) throw new Error(`Self lookup failed: ${selfErr?.message}`);
    const matchSelfId = await seedMatch(client, 9714);
    const { error: selfScoreErr } = await client.from('score_events').insert([
      { participant_id: selfRow.id, match_id: matchSelfId, source: 'match-wrong', points: 0 },
    ]);
    if (selfScoreErr) throw new Error(`Self score insert failed: ${selfScoreErr.message}`);
    refreshMV();

    await page.goto('/dashboard?tab=pool');

    // 25 total. Self at rank 25 (last) → bottom-clamp → ranks 15-25.
    const neighborhood = page.locator('#pool-panel section[aria-labelledby="neighborhood-heading"]');
    const rows = neighborhood.locator('table tbody tr');
    await expect(rows).toHaveCount(11);

    const selfRowEl = neighborhood.locator('tr[data-self="true"]');
    await expect(selfRowEl).toHaveCount(1);
    await expect(selfRowEl).toContainText('Self Bottom');

    // Self row sits at the bottom of the slice when bottom-clamped.
    const lastRow = rows.last();
    await expect(lastRow).toHaveAttribute('data-self', 'true');
  });

  test('small pool: 8 participants total → all 8 rendered, no padding', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedMatch(client, 9711);

    // 7 "Small NN" participants — observer makes 8.
    const smallIds: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      smallIds.push(await seedParticipant(client, `Small ${String(i).padStart(2, '0')}`));
    }
    const inserts = smallIds.map((id, i) => ({
      participant_id: id,
      match_id: matchId,
      source: 'match-exact' as const,
      points: Math.max(0, 14 - i * 2),
    }));
    const { error: smallErr } = await client.from('score_events').insert(inserts);
    if (smallErr) throw new Error(`Small seed insert failed: ${smallErr.message}`);
    refreshMV();

    await signInAs(page, { tenant: 'eligible', name: 'Self Small' });
    await provisionFromAuthenticatedPage(page);

    const { data: selfRow, error: selfErr } = await client
      .from('participants')
      .select('id')
      .eq('display_name', 'Self Small')
      .single();
    if (selfErr || !selfRow) throw new Error(`Self lookup failed: ${selfErr?.message}`);

    const matchId2 = await seedMatch(client, 9712);
    const { error: selfScoreErr } = await client.from('score_events').insert([
      { participant_id: selfRow.id, match_id: matchId2, source: 'match-exact', points: 7 },
    ]);
    if (selfScoreErr) throw new Error(`Self score insert failed: ${selfScoreErr.message}`);
    refreshMV();

    await page.goto('/dashboard?tab=pool');

    // 8 total < 11 → small-pool clamp → entire pool rendered, no padding.
    const neighborhood = page.locator('#pool-panel section[aria-labelledby="neighborhood-heading"]');
    const rows = neighborhood.locator('table tbody tr');
    await expect(rows).toHaveCount(8);

    const selfRowEl = neighborhood.locator('tr[data-self="true"]');
    await expect(selfRowEl).toHaveCount(1);
    await expect(selfRowEl).toContainText('Self Small');
  });
});
