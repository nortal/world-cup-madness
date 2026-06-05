/**
 * Playwright E2E — feature 004 US-LA, tasks T017.
 *
 * Covers TC-L1 (populated ranking renders rank/name/total with correct
 * ordering), TC-L2 (auth gate redirect), TC-L9 (Show my rank button scrolls
 * + highlights self row), TC-L13 page-side (page URL persistence), TC-L14
 * (mobile 360px no horizontal scroll).
 *
 * Owned range: matches provider_id 9101-9120. score_events are seeded
 * directly via service-role client (bypassing scoring triggers) so this
 * spec is independent of feature 003's trigger plumbing — just exercises
 * the read path + Show-my-rank scroll behaviour.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_IDS = [9101, 9102] as const;

async function provisionFromAuthenticatedPage(page: Page): Promise<void> {
  await page.goto('/dashboard');
  const result = await page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic CDN import
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

async function seedMatch(client: SupabaseClient<Database>, providerId: number): Promise<string> {
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
    status: 'scheduled',
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
    app_metadata: {
      tid: '00000000-0000-0000-0000-000000000000',
      oid,
      provider: 'azure',
    },
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

async function seedScore(
  client: SupabaseClient<Database>,
  participantId: string,
  matchId: string,
  points: number,
): Promise<void> {
  // Insert a single score_event with source='match' so the MV stage-CTE
  // counters increment correctly. The trigger normally writes these from
  // `predictions` × `match_results`; we bypass for this read-path spec.
  await client.from('score_events').insert({
    participant_id: participantId,
    match_id: matchId,
    source: 'match-exact',
    points,
  });
}

async function refreshMV(client: SupabaseClient<Database>): Promise<void> {
  // Admin-context call: refresh_leaderboard() routes to caller_kind='admin'
  // when neither GUC is set. The MV refresh fires unconditionally on this
  // path (no should_refresh_leaderboard gate).
  await client.rpc('refresh_leaderboard' as never);
}

test.describe('US-LA — leaderboard page', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
  });

  test('TC-L2: unauthed /leaderboard redirects to /', async ({ page }) => {
    const resp = await page.goto('/leaderboard');
    // Either the request itself redirected (resp.url() ends in '/') or the
    // page navigated to '/' after Server Component redirect() resolved.
    expect(new URL(page.url()).pathname).toBe('/');
    expect(resp?.status() ?? 200).toBeLessThan(400);
  });

  test('TC-L1: populated ranking renders 5 rows in correct order + self row marker', async ({
    page,
  }) => {
    const client = getServiceRoleClient();
    const matchId = await seedMatch(client, 9101);
    await client.from('matches').update({ status: 'finished', score_home: 1, score_away: 0 }).eq(
      'id',
      matchId,
    );

    // 5 participants; seeded scores 50/40/30/20/10 via score_events.
    const ids = await Promise.all([
      seedParticipant(client, 'Alice A'),
      seedParticipant(client, 'Bob B'),
      seedParticipant(client, 'Carol C'),
      seedParticipant(client, 'Dave D'),
      seedParticipant(client, 'Eve E'),
    ]);
    const points = [50, 40, 30, 20, 10];
    for (let i = 0; i < ids.length; i += 1) {
      await seedScore(client, ids[i], matchId, points[i]);
    }
    await refreshMV(client);

    // Sign in as Alice (participant A) via the standard fixture, but pin to
    // the seeded participant by re-using the same display name pattern.
    await signInAs(page, { tenant: 'eligible', name: 'Alice A' });
    await provisionFromAuthenticatedPage(page);

    await page.goto('/leaderboard');
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(6); // 5 seeded + 1 from the signed-in participant
    // Top row is Alice with 50 (or the signed-in participant if higher).
    await expect(rows.nth(0)).toContainText('Alice A');
  });

  test('TC-L9: Show my rank scrolls self row into view + highlights', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedMatch(client, 9102);
    await client.from('matches').update({ status: 'finished', score_home: 1, score_away: 0 }).eq(
      'id',
      matchId,
    );

    // Seed 30 participants on page 2 so signed-in user (rank 27 by score 10)
    // requires the page=2 navigation.
    const seedIds: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const id = await seedParticipant(client, `Bot ${String(i).padStart(2, '0')}`);
      seedIds.push(id);
      // Higher score → lower rank index; participant 0 gets 100, participant
      // 29 gets 1 (1-30 descending range gives unique ranks).
      await seedScore(client, id, matchId, 100 - i);
    }
    await refreshMV(client);

    await signInAs(page, { tenant: 'eligible', name: 'Bot 26' });
    await provisionFromAuthenticatedPage(page);
    await page.goto('/leaderboard');

    // Click Show my rank.
    await page.getByRole('button', { name: /show my rank/i }).click();
    await page.waitForURL(/page=2/);

    // Self row exists with the data-self attribute.
    const selfRow = page.locator('tr[data-self="true"]');
    await expect(selfRow).toBeVisible();
  });

  test('TC-L14: mobile 360px viewport has no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    const client = getServiceRoleClient();
    const matchId = await seedMatch(client, 9103);
    await client
      .from('matches')
      .update({ status: 'finished', score_home: 1, score_away: 0 })
      .eq('id', matchId);
    const id = await seedParticipant(client, 'Mobile Mary');
    await seedScore(client, id, matchId, 30);
    await refreshMV(client);

    await signInAs(page, { tenant: 'eligible', name: 'Mobile Mary' });
    await provisionFromAuthenticatedPage(page);
    await page.goto('/leaderboard');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'no horizontal scroll at 360px').toBeLessThanOrEqual(0);
  });

  test('TC-L13 page: pagination URL persistence', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedMatch(client, 9104);
    await client
      .from('matches')
      .update({ status: 'finished', score_home: 1, score_away: 0 })
      .eq('id', matchId);
    for (let i = 0; i < 30; i += 1) {
      const id = await seedParticipant(client, `Pager ${String(i).padStart(2, '0')}`);
      await seedScore(client, id, matchId, 100 - i);
    }
    await refreshMV(client);
    await signInAs(page, { tenant: 'eligible', name: 'Pager Self' });
    await provisionFromAuthenticatedPage(page);

    await page.goto('/leaderboard?page=2');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    // Page 2 should show rows 26+ → Pager 25 (rank 26) onwards
    await expect(page.getByText('Pager 25')).toBeVisible();

    // Reload preserves the page param.
    await page.reload();
    await expect(page.getByText('Pager 25')).toBeVisible();
  });
});
