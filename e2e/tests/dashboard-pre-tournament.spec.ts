/**
 * Playwright E2E — feature 005 US-DE, task T043.
 *
 * Covers TC-D11 — when `is_pre_tournament()` returns true the Pool tab
 * shows three `<PreTournamentPlaceholder/>` cards (one per replaced
 * widget); the Today tab continues to render its usual widget set with
 * their own pre-tournament branches.
 *
 * Setup contract:
 *   `is_pre_tournament()` is true iff no rows exist in `score_events`.
 *   The defensive wholesale-clear used here (feature 003 fix pattern)
 *   keeps the test resilient to seed drift.
 *
 * Owned provider_id range: 9731-9735.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_IDS = [9731, 9732, 9733, 9734, 9735] as const;

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

async function seedUpcomingMatch(
  client: SupabaseClient<Database>,
  providerId: number,
): Promise<string> {
  await client.from('matches').delete().eq('provider_id', providerId);
  const { data: teams, error: teamsErr } = await client
    .from('teams')
    .select('id, tla')
    .in('tla', ['ENG', 'FRA']);
  if (teamsErr) throw new Error(`seedUpcomingMatch teams lookup failed: ${teamsErr.message}`);
  const eng = teams!.find((t) => t.tla === 'ENG')!;
  const fra = teams!.find((t) => t.tla === 'FRA')!;
  const id = randomUUID();
  // status='scheduled' + 3 h future kickoff. Triggers RankWidget's
  // pre-tournament branch + UpcomingMatchesWidget's upcoming row.
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
  if (insErr) throw new Error(`seedUpcomingMatch insert failed: ${insErr.message}`);
  return id;
}

function truncateScoreEvents(): void {
  // Wholesale clear via TRUNCATE so any seed/admin/sync rows are gone.
  // Cascade in case another table references score_events via FK (none
  // do today, but RESTART IDENTITY keeps id sequences clean for the
  // next test run).
  execSync(
    'docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "TRUNCATE TABLE score_events RESTART IDENTITY CASCADE; REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;"',
    { stdio: 'pipe' },
  );
}

test.describe('US-DE — dashboard pre-tournament placeholder', () => {
  test.setTimeout(90_000);
  // Pin to mobile viewport for strict-mode safety — see
  // dashboard-neighborhood.spec.ts comment.
  test.use({ viewport: { width: 360, height: 800 } });

  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
    truncateScoreEvents();
  });

  test('TC-D11: Pool tab renders 3 PreTournamentPlaceholder cards; Today tab unchanged', async ({
    page,
  }) => {
    const client = getServiceRoleClient();
    await seedUpcomingMatch(client, 9731);

    await signInAs(page, { tenant: 'eligible', name: 'PreT Self' });
    await provisionFromAuthenticatedPage(page);

    // Today tab — UpcomingMatchesWidget should render the seeded
    // upcoming match. We don't deeply assert the Rank countdown text
    // (it's covered in feature 004's TC-L3) but we sanity-check the
    // tab loads without error.
    await page.goto('/dashboard?tab=today');
    await expect(
      page.locator('section[aria-labelledby="upcoming-matches-heading"]').first(),
    ).toBeVisible();

    // Switch to Pool tab. The three placeholders are scoped to
    // `#pool-panel` to dodge Playwright's strict-mode (Pool widgets
    // render in both `#pool-panel` and the desktop grid).
    await page.goto('/dashboard?tab=pool');

    const panel = page.locator('#pool-panel');
    await expect(panel.getByText(/Awaiting the first match/i)).toHaveCount(3);

    // Each placeholder preserves the original widget's `aria-labelledby`
    // id so SR bookmarks / locators keep resolving.
    await expect(panel.locator('section[aria-labelledby="neighborhood-heading"]')).toBeVisible();
    await expect(panel.locator('section[aria-labelledby="movers-heading"]')).toBeVisible();
    await expect(panel.locator('section[aria-labelledby="digest-heading"]')).toBeVisible();
  });
});
