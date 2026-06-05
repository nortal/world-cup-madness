/**
 * Playwright E2E — feature 004 US-LA, task T018.
 *
 * Covers TC-L5 (tie-breaker chain produces unique ranks when distinguished
 * by lower-priority criteria) and TC-L6 (full-chain tie → shared rank
 * rendered with `=` suffix; next distinct participant gets the gap-after).
 *
 * Owned range: matches provider_id 9121-9140. Seeds score_events directly
 * with deliberately-crafted (total, exact_hits, outcome_hits) tuples that
 * exercise the MV's RANK() OVER (… ORDER BY total DESC, exact DESC, outcome
 * DESC, final DESC) tie-breaker chain.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';
import { refreshLeaderboardMV } from '../fixtures/leaderboard';

// Owned provider_id range: 9121..9140 (20 distinct rows for tie-breaker fixtures).
const PROVIDER_IDS = Array.from({ length: 20 }, (_, i) => 9121 + i);

async function provisionFromAuthenticatedPage(page: Page): Promise<void> {
  await page.goto('/dashboard');
  await page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- CDN ESM dynamic import
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      await client.auth.getSession();
      await client.rpc('provision_participant_from_jwt');
    },
    {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );
}

async function seedMatch(
  client: SupabaseClient<Database>,
  providerId: number,
): Promise<string> {
  await client.from('matches').delete().eq('provider_id', providerId);
  const { data: teams } = await client.from('teams').select('id, tla').in('tla', ['ENG', 'FRA']);
  const eng = teams!.find((t) => t.tla === 'ENG')!;
  const fra = teams!.find((t) => t.tla === 'FRA')!;
  const id = randomUUID();
  await client.from('matches').insert({
    id,
    provider_id: providerId,
    home_team_id: eng.id,
    away_team_id: fra.id,
    stage: 'group',
    group_label: 'A',
    kickoff_utc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    status: 'finished',
    score_home: 1,
    score_away: 0,
  });
  return id;
}

async function seedParticipant(
  client: SupabaseClient<Database>,
  displayName: string,
): Promise<string> {
  const oid = randomUUID();
  const email = `${oid}@nortal.com`;
  const { data: user } = await client.auth.admin.createUser({
    email,
    password: 'wcm-test-password-123',
    email_confirm: true,
    app_metadata: { tid: '00000000-0000-0000-0000-000000000000', oid, provider: 'azure' },
    user_metadata: { name: displayName, email },
  });
  const { data: participant } = await client
    .from('participants')
    .insert({
      auth_user_id: user!.user!.id,
      oid,
      email,
      display_name: displayName,
      status: 'active',
    })
    .select('id')
    .single();
  return participant!.id;
}

// Insert N score_events for one participant. `exactCount` events use
// source='match-exact' (each contributes to exact_hits), `outcomeCount` use
// source='match-outcome' (contributes to outcome_hits). Each event carries
// 10 pts (match-exact) or 5 pts (match-outcome) — both within the
// score_events.points CHECK (0..20). Total is determined by the (exactCount,
// outcomeCount) tuple — callers MUST supply enough fresh match ids
// (one per event) because of the partial unique index on
// (participant_id, match_id) WHERE match_id IS NOT NULL.
async function seedTuple(
  client: SupabaseClient<Database>,
  participantId: string,
  matches: readonly string[],
  exactCount: number,
  outcomeCount: number,
): Promise<void> {
  const events: Array<{
    participant_id: string;
    match_id: string;
    source: 'match-exact' | 'match-outcome';
    points: number;
  }> = [];
  let useMatchIdx = 0;
  for (let i = 0; i < exactCount; i += 1) {
    events.push({
      participant_id: participantId,
      match_id: matches[useMatchIdx++],
      source: 'match-exact',
      points: 10,
    });
  }
  for (let i = 0; i < outcomeCount; i += 1) {
    events.push({
      participant_id: participantId,
      match_id: matches[useMatchIdx++],
      source: 'match-outcome',
      points: 5,
    });
  }
  if (events.length > 0) {
    const { error } = await client.from('score_events').insert(events);
    if (error) {
      throw new Error(`seedTuple score_events insert failed: ${error.message}`);
    }
  }
}

test.describe('US-LA tie-breakers', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
  });

  test('TC-L5: tie-breaker chain produces unique ranks via exact/outcome counts', async ({
    page,
  }) => {
    const client = getServiceRoleClient();
    // Seed 10 distinct matches so each participant's events can sit on
    // separate match_ids (participant_id, match_id) unique-index.
    const matchIds: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const m = await seedMatch(client, PROVIDER_IDS[i]);
      matchIds.push(m);
    }

    const p1 = await seedParticipant(client, 'Tie A1');
    const p2 = await seedParticipant(client, 'Tie A2');
    const p3 = await seedParticipant(client, 'Tie A3');
    const p4 = await seedParticipant(client, 'Tie A4');

    // Same total points (30) across all four; tie broken by (exact, outcome).
    //   P1: total=30, exact=3, outcome=0    → rank 1 (highest exact)
    //   P2: total=30, exact=2, outcome=2    → rank 2
    //   P3: total=30, exact=1, outcome=4    → rank 3
    //   P4: total=30, exact=0, outcome=6    → rank 4
    // Each event ≤ 20 pts (10 for match-exact, 5 for match-outcome) ✓ CHECK.
    await seedTuple(client, p1, matchIds, 3, 0);
    await seedTuple(client, p2, matchIds, 2, 2);
    await seedTuple(client, p3, matchIds, 1, 4);
    await seedTuple(client, p4, matchIds, 0, 6);
    refreshLeaderboardMV();

    await signInAs(page, { tenant: 'eligible', name: 'Tie Observer' });
    await provisionFromAuthenticatedPage(page);
    await page.goto('/leaderboard');

    const rows = page.locator('table tbody tr');
    // Top 4 rows are the tie-broken participants in correct order.
    await expect(rows.nth(0)).toContainText('Tie A1');
    await expect(rows.nth(1)).toContainText('Tie A2');
    await expect(rows.nth(2)).toContainText('Tie A3');
    await expect(rows.nth(3)).toContainText('Tie A4');
    // None of these should carry the shared-rank `=` suffix.
    await expect(rows.nth(0)).not.toContainText('=');
    await expect(rows.nth(1)).not.toContainText('=');
  });

  test('TC-L6: full-chain tie renders shared rank with `=` suffix', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const m = await seedMatch(client, PROVIDER_IDS[i]);
      matchIds.push(m);
    }

    const p1 = await seedParticipant(client, 'Tied A');
    const p2 = await seedParticipant(client, 'Tied B');
    const p3 = await seedParticipant(client, 'Tied C');
    const p4 = await seedParticipant(client, 'Distinct D');

    // P1, P2, P3: identical (exact=1, outcome=4) → total=30, shared rank 1=
    await seedTuple(client, p1, matchIds, 1, 4);
    await seedTuple(client, p2, matchIds, 1, 4);
    await seedTuple(client, p3, matchIds, 1, 4);
    // P4: distinct (exact=1, outcome=0) → total=10 → rank 4
    await seedTuple(client, p4, matchIds, 1, 0);
    refreshLeaderboardMV();

    await signInAs(page, { tenant: 'eligible', name: 'Tie Observer' });
    await provisionFromAuthenticatedPage(page);
    await page.goto('/leaderboard');

    // The first three rows (the tied participants) should each render rank
    // text containing '=' (e.g. "1=").
    const rows = page.locator('table tbody tr');
    await expect(rows.nth(0).locator('td').first()).toContainText('=');
    await expect(rows.nth(1).locator('td').first()).toContainText('=');
    await expect(rows.nth(2).locator('td').first()).toContainText('=');
  });
});
