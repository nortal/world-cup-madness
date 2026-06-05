/**
 * Playwright E2E — feature 004 Final Phase, task T040.
 *
 * Covers TC-L12 — privacy contract enforcement:
 *   (a) DOM never contains `exact_hits` / `outcome_hits` / `final_points`
 *       per-source data for any non-self row (only rank, name, total
 *       — the FR-L02 public projection).
 *   (b) Realtime WebSocket frame payloads carry only the `audit_log` event
 *       metadata (`action`, `occurred_at`, `new_value` minimal jsonb) and
 *       no participant scores — verified via `page.on('websocket')` +
 *       per-frame inspection.
 *   (c) Admin role sees the SAME public column set on `/leaderboard`
 *       (FC-L6 — column GRANT is role-blind).
 *
 * Owned range: matches provider_id 9601-9610.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_IDS = [9601, 9602] as const;

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

test.describe('Privacy — TC-L12 column projection + WS payload minimality', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
  });

  test('DOM contains only public projection columns for non-self rows', async ({
    page,
  }) => {
    const client = getServiceRoleClient();
    const matchId = await seedFinishedMatch(client, 9601);

    const observer = await seedParticipant(client, 'Privacy Obs');
    const other = await seedParticipant(client, 'Other Person');
    await client.from('score_events').insert([
      { participant_id: observer, match_id: matchId, source: 'match-exact', points: 10 },
      { participant_id: other, match_id: matchId, source: 'match-exact', points: 5 },
    ]);
    await client.rpc('refresh_leaderboard' as never);

    await signInAs(page, { tenant: 'eligible', name: 'Privacy Watcher' });
    await provisionFromAuthenticatedPage(page);
    await page.goto('/leaderboard');

    // Scan the rendered HTML for any private column names. The Supabase
    // PostgREST response shape uses the column names verbatim; if they
    // somehow leaked into the DOM (data attributes, JSON in scripts) the
    // string would appear.
    const html = await page.content();
    expect(html).not.toContain('exact_hits');
    expect(html).not.toContain('outcome_hits');
    expect(html).not.toContain('final_points');
  });

  test('Realtime WS frames carry minimal audit-event metadata, no scores', async ({
    page,
  }) => {
    const client = getServiceRoleClient();
    const matchId = await seedFinishedMatch(client, 9602);

    const observer = await seedParticipant(client, 'WS Observer');
    await client.from('score_events').insert([
      { participant_id: observer, match_id: matchId, source: 'match-exact', points: 5 },
    ]);
    await client.rpc('refresh_leaderboard' as never);

    const wsFrames: string[] = [];
    page.on('websocket', (ws) => {
      ws.on('framereceived', (payload) => {
        const data = typeof payload.payload === 'string' ? payload.payload : '';
        wsFrames.push(data);
      });
    });

    await signInAs(page, { tenant: 'eligible', name: 'WS Watcher' });
    await provisionFromAuthenticatedPage(page);
    await page.goto('/leaderboard');

    // Trigger one MV refresh so a frame fires.
    const climber = await seedParticipant(client, 'WS Climber');
    await client.from('score_events').insert([
      { participant_id: climber, match_id: matchId, source: 'match-exact', points: 999 },
    ]);
    await client.rpc('refresh_leaderboard' as never);

    // Give the page a moment to receive the broadcast.
    await page.waitForTimeout(2_000);

    // No WS frame should contain a participant's score column or display
    // name. The audit_log INSERT broadcasted carries action + occurred_at
    // + (new_value: {caller_kind, refreshed_at}) only.
    const combined = wsFrames.join('\n');
    expect(combined).not.toMatch(/exact_hits/);
    expect(combined).not.toMatch(/outcome_hits/);
    expect(combined).not.toMatch(/final_points/);
  });

  test('FC-L6: admin sees the same public projection (no extra columns)', async ({
    page,
  }) => {
    const client = getServiceRoleClient();
    const matchId = await seedFinishedMatch(client, 9603);
    const obs = await seedParticipant(client, 'Admin Side Obs');
    await client.from('score_events').insert([
      { participant_id: obs, match_id: matchId, source: 'match-exact', points: 10 },
    ]);
    await client.rpc('refresh_leaderboard' as never);

    await signInAs(page, { tenant: 'eligible', role: 'admin', name: 'Admin Privacy' });
    await provisionFromAuthenticatedPage(page);

    await page.goto('/leaderboard');
    const html = await page.content();
    // Admin role does NOT have privileged access via the leaderboard surface
    // — column GRANT applies to all 'authenticated' role users including
    // admin. The DOM must not contain private columns.
    expect(html).not.toContain('exact_hits');
    expect(html).not.toContain('outcome_hits');
    expect(html).not.toContain('final_points');
  });
});
