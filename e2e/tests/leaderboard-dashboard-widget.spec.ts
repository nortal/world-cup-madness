/**
 * Playwright E2E — feature 004 US-LD, task T034.
 *
 * Covers TC-L10 (RankWidget on /dashboard shows participant rank + delta
 * arrow + updates via Realtime) and TC-L11 (pre-tournament widget renders
 * "Leaderboard opens at <time>" countdown text).
 *
 * Owned range: matches provider_id 9401-9410.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';
import { refreshLeaderboardMV } from '../fixtures/leaderboard';

const PROVIDER_IDS = [9401, 9402] as const;

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

async function seedFutureMatch(
  client: SupabaseClient<Database>,
  providerId: number,
  daysOut: number,
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
    kickoff_utc: new Date(Date.now() + daysOut * 24 * 60 * 60 * 1000).toISOString(),
    status: 'scheduled',
  });
  return id;
}

async function seedFinishedMatch(
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

test.describe('US-LD — dashboard rank widget', () => {
  // Pin to mobile viewport. Feature 005 US-DA (commit f281d3c) made
  // DashboardPage render the Today widgets twice — once inside
  // `#today-panel` (block md:hidden) and once inside the desktop grid
  // (hidden md:grid). At the default desktop viewport both copies live
  // in the DOM: `getByText(/Leaderboard opens at/i)` then resolves to 2
  // elements (strict-mode violation) and `.first()` lands on the hidden
  // mobile copy. The mobile viewport makes the mobile-panel copy the
  // only live one and keeps the assertion semantics intact.
  test.use({ viewport: { width: 360, height: 800 } });

  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
    // Clear all score_events so widget tests start from a known state.
    await client.from('score_events').delete().neq(
      'participant_id',
      '00000000-0000-0000-0000-000000000000',
    );
  });

  test('TC-L11: pre-tournament widget shows "Leaderboard opens at" countdown', async ({
    page,
  }) => {
    const client = getServiceRoleClient();
    await seedFutureMatch(client, 9401, 5);
    // score_events empty (cleared in beforeEach) → MV empty → widget shows
    // pre-tournament message.

    await signInAs(page, { tenant: 'eligible', name: 'Widget Pre' });
    await provisionFromAuthenticatedPage(page);
    await page.goto('/dashboard');

    // Scope to `#today-panel` so we hit only the mobile-panel copy. The
    // desktop-grid copy is `display:none` at this viewport but still
    // present in the DOM, which would trip Playwright's strict mode.
    await expect(
      page.locator('#today-panel').getByText(/Leaderboard opens at/i),
    ).toBeVisible();
  });

  test('TC-L10: rank widget renders rank + arrow indicator post-scoring', async ({
    page,
  }) => {
    const client = getServiceRoleClient();
    const matchId = await seedFinishedMatch(client, 9402);

    await signInAs(page, { tenant: 'eligible', name: 'Widget Live' });
    await provisionFromAuthenticatedPage(page);

    // Resolve the signed-in participant id by display name.
    const { data: participant } = await client
      .from('participants')
      .select('id')
      .eq('display_name', 'Widget Live')
      .maybeSingle();
    expect(participant).not.toBeNull();

    const { error: scoreErr } = await client.from('score_events').insert([
      { participant_id: participant!.id, match_id: matchId, source: 'match-exact', points: 20 },
    ]);
    if (scoreErr) throw new Error(`score_events seed failed: ${scoreErr.message}`);
    refreshLeaderboardMV();

    await page.goto('/dashboard');
    // Widget shows the rank label + a numeric value (rank 1 since only
    // one participant has score_events). Scoped to `#today-panel` so the
    // desktop-grid copy of the same JSX is excluded (see TC-L11 comment).
    const todayPanel = page.locator('#today-panel');
    await expect(todayPanel.getByText(/Your rank/i).first()).toBeVisible();
    await expect(todayPanel.getByText(/Your rank[\s:]+1\b/i).first()).toBeVisible();
  });
});
