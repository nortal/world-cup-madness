/**
 * Playwright E2E — feature 004 US-LB, task T023.
 *
 * Covers TC-L7 (stage tab strip switches the active filter; ranking
 * re-aggregates), TC-L8 (final-prediction points are excluded from
 * stage-specific tabs per FC-L4), TC-L13 (stage URL persistence — reload
 * preserves the active tab + aria-selected state).
 *
 * Owned range: matches provider_id 9201-9210.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_IDS = [9201, 9202, 9203] as const;

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

async function seedGroupMatch(
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
    kickoff_utc: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
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

async function refreshMV(client: SupabaseClient<Database>): Promise<void> {
  await client.rpc('refresh_leaderboard' as never);
}

test.describe('US-LB — stage filter', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
  });

  test('TC-L7 + TC-L8: switching tabs re-aggregates; final-prediction points excluded from stage-specific', async ({
    page,
  }) => {
    const client = getServiceRoleClient();
    const matchA = await seedGroupMatch(client, 9201);

    const p1 = await seedParticipant(client, 'Grp Only 15');
    const p2 = await seedParticipant(client, 'Mixed 10+20');
    const p3 = await seedParticipant(client, 'Final Only 20');

    // P1: 15 group-stage points only
    await client.from('score_events').insert([
      { participant_id: p1, match_id: matchA, source: 'match-exact', points: 15 },
    ]);
    // P2: 10 group-stage + 20 final-champion
    await client.from('score_events').insert([
      { participant_id: p2, match_id: matchA, source: 'match-exact', points: 10 },
      { participant_id: p2, match_id: null, source: 'final-champion', points: 20 },
    ]);
    // P3: 20 final-champion only
    await client.from('score_events').insert([
      { participant_id: p3, match_id: null, source: 'final-champion', points: 20 },
    ]);
    await refreshMV(client);

    await signInAs(page, { tenant: 'eligible', name: 'Tab Observer' });
    await provisionFromAuthenticatedPage(page);
    await page.goto('/leaderboard');

    // stage=all default — P2 should be top (total 30)
    let rows = page.locator('table tbody tr');
    await expect(rows.first()).toContainText('Mixed 10+20');

    // Click Group tab.
    await page.getByRole('tab', { name: /^Group$/i }).click();
    await page.waitForURL(/stage=group/);
    rows = page.locator('table tbody tr');
    // Group-only: P1 (15) above P2 (10); P3 should be 0 (still listed because
    // every active participant gets a row per stage post Phase-2 MV fix).
    await expect(rows.first()).toContainText('Grp Only 15');
    await expect(page.getByText('Final Only 20')).toBeVisible(); // P3 still in list at 0 pts
  });

  test('TC-L13 stage URL persistence: reload preserves active tab', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchA = await seedGroupMatch(client, 9202);
    const p1 = await seedParticipant(client, 'Pers Tab P1');
    await client.from('score_events').insert([
      { participant_id: p1, match_id: matchA, source: 'match-exact', points: 10 },
    ]);
    await refreshMV(client);

    await signInAs(page, { tenant: 'eligible', name: 'Pers Tab Observer' });
    await provisionFromAuthenticatedPage(page);

    await page.goto('/leaderboard?stage=group');
    // Active tab carries aria-selected="true"
    const groupTab = page.getByRole('tab', { name: /^Group$/i });
    await expect(groupTab).toHaveAttribute('aria-selected', 'true');

    await page.reload();
    await expect(groupTab).toHaveAttribute('aria-selected', 'true');
  });
});
