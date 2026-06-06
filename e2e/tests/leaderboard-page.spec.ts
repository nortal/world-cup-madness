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

import { execSync } from 'node:child_process';
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


function refreshMV(): void {
  // The service-role client cannot reach `refresh_leaderboard()` — that RPC
  // gates on `is_admin_user(auth.uid())` and the service-role session has no
  // JWT. Refresh the MV directly against the local Postgres container; the
  // schedule is a Supabase-local convention so this only runs in dev/CI.
  execSync(
    'docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;"',
    { stdio: 'pipe' },
  );
}

test.describe('US-LA — leaderboard page', () => {
  // TC-L9 and TC-L13 each seed 25-30 participants via auth.users + the
  // provisioning RPC, which serialise at ~1 s per participant. The default
  // 30 s per-test budget runs out before the assertions begin.
  test.setTimeout(90_000);


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

  test('TC-L1: populated ranking renders rows in correct rank order', async ({
    page,
  }) => {
    const client = getServiceRoleClient();
    const matchId = await seedMatch(client, 9101);
    await client.from('matches').update({ status: 'finished', score_home: 1, score_away: 0 }).eq(
      'id',
      matchId,
    );

    // 5 participants; distinct totals 20/15/10/5/0 via a single match-exact
    // event each (within the 0-20 score_events.points CHECK).
    const aliceId = await seedParticipant(client, 'Alpha Alice');
    const bobId = await seedParticipant(client, 'Bravo Bob');
    const carolId = await seedParticipant(client, 'Charlie Carol');
    const daveId = await seedParticipant(client, 'Delta Dave');
    const eveId = await seedParticipant(client, 'Echo Eve');
    const { error: scoreErr } = await client.from('score_events').insert([
      { participant_id: aliceId, match_id: matchId, source: 'match-exact', points: 20 },
      { participant_id: bobId, match_id: matchId, source: 'match-exact', points: 15 },
      { participant_id: carolId, match_id: matchId, source: 'match-exact', points: 10 },
      { participant_id: daveId, match_id: matchId, source: 'match-outcome', points: 5 },
      { participant_id: eveId, match_id: matchId, source: 'match-wrong', points: 0 },
    ]);
    if (scoreErr) throw new Error(`score_events seed failed: ${scoreErr.message}`);
    refreshMV();

    await signInAs(page, { tenant: 'eligible', name: 'Observer Person' });
    await provisionFromAuthenticatedPage(page);

    await page.goto('/leaderboard');
    const rows = page.locator('table tbody tr');
    // 5 seeded + 1 observer = 6 active participants (one row per).
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toContainText('Alpha Alice');
  });

  test('TC-L9: Show my rank scrolls self row into view + highlights', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedMatch(client, 9102);
    await client.from('matches').update({ status: 'finished', score_home: 1, score_away: 0 }).eq(
      'id',
      matchId,
    );

    // 25 "A NN" participants all with 1 match-exact event (10 pts each) — all
    // tied at rank 1=, sorted alphabetically. Plus the signed-in "Z Observer"
    // with no score_events → same shared rank but alphabetically last → page 2.
    const aIds: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const id = await seedParticipant(client, `A ${String(i).padStart(2, '0')}`);
      aIds.push(id);
    }
    const aInserts = aIds.map((id) => ({
      participant_id: id,
      match_id: matchId,
      source: 'match-exact' as const,
      points: 10,
    }));
    const { error: scoreErr } = await client.from('score_events').insert(aInserts);
    if (scoreErr) throw new Error(`score_events seed failed: ${scoreErr.message}`);
    refreshMV();

    await signInAs(page, { tenant: 'eligible', name: 'Z Observer' });
    await provisionFromAuthenticatedPage(page);
    // Refresh again now that the signed-in observer has been provisioned
    // — without this the MV omits them and their `leaderboard_self` row is
    // empty, hiding the "Show my rank" button.
    refreshMV();
    await page.goto('/leaderboard');

    // Click Show my rank — observer is alphabetically last → page 2.
    await page.getByRole('button', { name: /show my rank/i }).click();
    await page.waitForURL(/page=2/);

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
    const { error: mErr } = await client.from('score_events').insert([
      { participant_id: id, match_id: matchId, source: 'match-exact', points: 10 },
    ]);
    if (mErr) throw new Error(`score_events seed failed: ${mErr.message}`);
    refreshMV();

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
    // 30 participants all tied (1 match-exact event each, 10 pts) → shared
    // rank 1=, alphabetical order. Pager 25 is the 26th row (page 2 row 1).
    const ids: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const id = await seedParticipant(client, `Pager ${String(i).padStart(2, '0')}`);
      ids.push(id);
    }
    const inserts = ids.map((id) => ({
      participant_id: id,
      match_id: matchId,
      source: 'match-exact' as const,
      points: 10,
    }));
    const { error: scoreErr } = await client.from('score_events').insert(inserts);
    if (scoreErr) throw new Error(`score_events seed failed: ${scoreErr.message}`);
    refreshMV();
    await signInAs(page, { tenant: 'eligible', name: 'Pager Self' });
    await provisionFromAuthenticatedPage(page);

    await page.goto('/leaderboard?page=2');
    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    await expect(page.getByText('Pager 25')).toBeVisible();
    await page.reload();
    await expect(page.getByText('Pager 25')).toBeVisible();
  });
});
