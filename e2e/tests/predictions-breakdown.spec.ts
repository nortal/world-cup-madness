/**
 * Playwright E2E — US-PD breakdown read path (TC-P27 positive path) for
 * feature 003, task T067.
 *
 * Seeds a participant with predictions across 3 matches (one exact=10, one
 * outcome=5, one wrong=0), finishes the matches (firing the scoring trigger),
 * then loads /predictions/breakdown and asserts: 3 match rows visible, the
 * correct per-row points, and total = 15.
 *
 * Owned range: matches provider_id 7491-7493.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_IDS = [7491, 7492, 7493] as const;

async function provisionFromAuthenticatedPage(page: Page): Promise<void> {
  await page.goto('/dashboard');
  const provision = await page.evaluate(
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
  expect(provision.ok, 'provision RPC must succeed').toBe(true);
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
    id, provider_id: providerId, home_team_id: eng.id, away_team_id: fra.id,
    stage: 'group', group_label: 'A',
    kickoff_utc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), status: 'scheduled',
  });
  return id;
}

test.describe('US-PD / TC-P27 — personal score breakdown', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) await client.from('matches').delete().eq('provider_id', pid);
  });
  test.afterAll(async () => {
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) await client.from('matches').delete().eq('provider_id', pid);
  });

  test('TC-P27: breakdown shows per-match points and a correct total', async ({ page }) => {
    const client = getServiceRoleClient();

    // Sign in + provision so the participant row exists.
    const { oid } = await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);
    const { data: participant } = await client.from('participants').select('id').eq('oid', oid).maybeSingle();
    const participantId = participant!.id;

    // Three matches; predict for each, then finish so the trigger scores them.
    const mExact = await seedMatch(client, 7491);   // predict 2-1, official 2-1 → 10
    const mOutcome = await seedMatch(client, 7492);  // predict 3-0, official 2-1 → 5
    const mWrong = await seedMatch(client, 7493);    // predict 0-2, official 2-1 → 0

    await client.from('predictions').insert([
      { participant_id: participantId, match_id: mExact, predicted_home_score: 2, predicted_away_score: 1 },
      { participant_id: participantId, match_id: mOutcome, predicted_home_score: 3, predicted_away_score: 0 },
      { participant_id: participantId, match_id: mWrong, predicted_home_score: 0, predicted_away_score: 2 },
    ]);

    for (const m of [mExact, mOutcome, mWrong]) {
      await client.from('matches').update({ status: 'finished', score_home: 2, score_away: 1 }).eq('id', m);
    }

    // Load the breakdown page.
    const resp = await page.goto('/predictions/breakdown');
    expect(resp?.status()).toBe(200);

    // Three match rows in the table body (one per finished match).
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(3);

    // The total (in the <output>) is 10 + 5 + 0 = 15.
    await expect(page.locator('output')).toHaveText('15');

    // The exact-score row's points cell shows 10 somewhere in the table.
    await expect(page.getByText('Exact score')).toBeVisible();
    await expect(page.getByText('Correct outcome')).toBeVisible();
    await expect(page.getByText('Wrong outcome')).toBeVisible();
  });

  test('TC-P27 empty: breakdown shows empty-state when no score events exist', async ({ page }) => {
    await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);
    const resp = await page.goto('/predictions/breakdown');
    expect(resp?.status()).toBe(200);

    // No table; empty-state message instead.
    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.getByText(/no points yet/i)).toBeVisible();
  });
});
