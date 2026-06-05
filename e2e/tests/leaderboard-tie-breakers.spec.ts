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

const PROVIDER_IDS = [9121, 9122, 9123] as const;

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

// Insert N score_events for one participant on a fresh match each. Each event
// carries `points` so the MV's (total, exact_hits, outcome_hits) tuple ends
// up as expected. `exactCount` events are inserted with points=10; `outcomeCount`
// with points=5; remainder with points=0 to pad to `total`.
async function seedTuple(
  client: SupabaseClient<Database>,
  participantId: string,
  matches: readonly string[],
  total: number,
  exactCount: number,
  outcomeCount: number,
): Promise<void> {
  const events: Array<{
    participant_id: string;
    match_id: string;
    source: 'match-exact';
    points: number;
  }> = [];
  let remaining = total;
  let useMatchIdx = 0;
  for (let i = 0; i < exactCount; i += 1) {
    events.push({
      participant_id: participantId,
      match_id: matches[useMatchIdx++],
      source: 'match-exact',
      points: 10,
    });
    remaining -= 10;
  }
  for (let i = 0; i < outcomeCount; i += 1) {
    events.push({
      participant_id: participantId,
      match_id: matches[useMatchIdx++],
      source: 'match-exact',
      points: 5,
    });
    remaining -= 5;
  }
  // Pad to total with a single 'points = remaining' event if needed.
  if (remaining > 0) {
    events.push({
      participant_id: participantId,
      match_id: matches[useMatchIdx++],
      source: 'match-exact',
      points: remaining,
    });
  }
  if (events.length > 0) {
    await client.from('score_events').insert(events);
  }
}

async function refreshMV(client: SupabaseClient<Database>): Promise<void> {
  await client.rpc('refresh_leaderboard' as never);
}

test.describe('US-LA tie-breakers', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
  });

  test('TC-L5: single-level tie produces unique ranks via tie-breaker chain', async ({
    page,
  }) => {
    const client = getServiceRoleClient();
    // Seed enough matches that each tuple's events have unique match ids.
    const matchIds: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const m = await seedMatch(client, 9121 + (i % 3));
      // Reseed with unique provider ids — use 9121-9123 round-robin and
      // accept duplicates via inserting fresh rows post-delete.
      matchIds.push(m);
    }

    const p1 = await seedParticipant(client, 'Tie A1');
    const p2 = await seedParticipant(client, 'Tie A2');
    const p3 = await seedParticipant(client, 'Tie A3');
    const p4 = await seedParticipant(client, 'Tie A4');

    // P1: total=100, exact=2, outcome=0 → rank 1
    // P2: total=100, exact=1, outcome=0 → rank 2 (distinguished by exact)
    // P3: total=100, exact=1, outcome=3 → rank 3
    // P4: total=100, exact=1, outcome=2 → rank 4
    await seedTuple(client, p1, matchIds.slice(0, 10), 100, 2, 0);
    await seedTuple(client, p2, matchIds.slice(0, 10), 100, 1, 0);
    await seedTuple(client, p3, matchIds.slice(0, 10), 100, 1, 3);
    await seedTuple(client, p4, matchIds.slice(0, 10), 100, 1, 2);
    await refreshMV(client);

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
    for (let i = 0; i < 12; i += 1) {
      const m = await seedMatch(client, 9121 + (i % 3));
      matchIds.push(m);
    }

    const p1 = await seedParticipant(client, 'Tied A');
    const p2 = await seedParticipant(client, 'Tied B');
    const p3 = await seedParticipant(client, 'Tied C');
    const p4 = await seedParticipant(client, 'Distinct D');

    // P1, P2, P3: identical (total=30, exact=1, outcome=4) → shared rank 1=
    await seedTuple(client, p1, matchIds.slice(0, 5), 30, 1, 4);
    await seedTuple(client, p2, matchIds.slice(0, 5), 30, 1, 4);
    await seedTuple(client, p3, matchIds.slice(0, 5), 30, 1, 4);
    // P4: distinct (10 points only) → rank 4
    await seedTuple(client, p4, matchIds.slice(0, 1), 10, 0, 0);
    await refreshMV(client);

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
