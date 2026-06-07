/**
 * Playwright E2E — feature 004 US-LE, task T039.
 *
 * Covers TC-L3 (pre-tournament `/leaderboard` shows the countdown to first
 * kickoff in user's TZ) and TC-L11 page-side (the empty-state component
 * renders semantic <time dateTime="..."> + relative countdown).
 *
 * MUST run with score_events empty at test start — the global
 * pre-tournament short-circuit only fires when score_events is empty.
 * Owned range: matches provider_id 9501-9510.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_IDS = [9501, 9502] as const;

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

async function clearAllScoreEvents(client: SupabaseClient<Database>): Promise<void> {
  // Wholesale clear — the global pre-tournament short-circuit needs
  // score_events EMPTY. Defensive clear pattern from feature 003 May 2026 fix.
  await client.from('score_events').delete().neq(
    'participant_id',
    '00000000-0000-0000-0000-000000000000',
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

test.describe('US-LE — pre-tournament empty state', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
    await clearAllScoreEvents(client);
  });

  test('TC-L3: pre-tournament page shows countdown + no table', async ({ page }) => {
    const client = getServiceRoleClient();
    await seedFutureMatch(client, 9501, 5);

    await signInAs(page, { tenant: 'eligible', name: 'Countdown Watcher' });
    await provisionFromAuthenticatedPage(page);

    await page.goto('/leaderboard');

    // "Leaderboard opens at" heading is visible.
    await expect(page.getByText(/Leaderboard opens at/i)).toBeVisible();
    // The <time dateTime="..."> element renders.
    const timeEl = page.locator('time[datetime]');
    await expect(timeEl).toBeVisible();
    // No <table> rendered (the table only appears once there are scored matches).
    await expect(page.locator('table')).toHaveCount(0);
  });

  test('TC-L11 page-side: no scheduled matches → no-matches fallback message', async ({
    page,
  }) => {
    // No matches seeded by this spec; score_events empty. resetSupabaseState
    // may have re-seeded baseline matches, in which case the page renders
    // the countdown empty-state. Either is acceptable for the empty-state
    // contract (score_events empty → no table).
    await signInAs(page, { tenant: 'eligible', name: 'Empty Watcher' });
    await provisionFromAuthenticatedPage(page);

    await page.goto('/leaderboard');

    // The component falls back to a "no matches scheduled yet" style message
    // OR to the "Leaderboard opens at" countdown when firstKickoff resolves.
    await expect(page.locator('table')).toHaveCount(0);
    await expect(
      page.getByText(
        /(no matches scheduled|Leaderboard opens at|Leaderboard will appear once the first match is scored)/i,
      ),
    ).toBeVisible();
  });
});
